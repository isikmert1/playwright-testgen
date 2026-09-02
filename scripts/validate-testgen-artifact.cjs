#!/usr/bin/env node

const { createHash } = require('node:crypto');
const { existsSync, readFileSync, realpathSync, statSync } = require('node:fs');
const path = require('node:path');
const { loadPolicy } = require('../hooks/validate-bash.cjs');

const RUN_ID = /^tg-[a-f0-9]{24}$/u;
const TYPES = new Set(['handoff', 'trace']);
const CLASSIFICATIONS = new Set([
  'selector-drift',
  'timing',
  'expectation-drift',
  'intent-wrong',
  'environment-or-auth',
  'product-behavior-wrong',
  'unresolved',
]);
const DISPOSITIONS = new Set([
  'fixed',
  'needs-author-revision',
  'needs-user-input',
  'product-behavior-wrong',
  'unresolved-after-healing',
]);
const TERMINAL_CLASSIFICATIONS = new Set([
  'intent-wrong',
  'environment-or-auth',
  'product-behavior-wrong',
  'unresolved',
]);
const REPAIRABLE_CLASSIFICATIONS = new Set([
  'selector-drift',
  'timing',
  'expectation-drift',
]);
const SCHEMA_HASHES = {
  handoff: '5cc69a16d0240e293c93393d6e9ae24603a072491da745f41ffdc7e1d7f52d60',
  trace: '7e96ee2d29342047991f6ee835f63cd2677f8d0630f11bc049d278b74b06763b',
};
const PROHIBITED_KEY =
  /(?:credential|password|passwd|secret|token|cookie|authorization|storage.?state|environment|snapshot|screenshot|video|trace|dom|(?:raw_)?log|request|response|ticket|scenario(?:_|-)?body|spec(?:_|-)?body)/iu;
const PROHIBITED_VALUE =
  /(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|authorization\s*:|(?:api[-_ ]?key|token|secret|password|passwd|cookie|set-cookie)\s*[:=]|\bsnapshot\s*:|\b(?:test|describe|expect)\s*\(|```|\bhttps?:\/\/[^\s/@]+@[^\s]+)/iu;
const ENVIRONMENT_VALUE = /(?:^|[^A-Za-z0-9_])[A-Za-z_][A-Za-z0-9_]*=[^\s]+/u;
const CSS_ATTRIBUTE_SELECTOR =
  /\[[A-Za-z_][A-Za-z0-9_.:-]*\s*(?:[~|^$*]?=)\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\]\s]+)\s*\]/gu;
const RAW_DOM_TAG = /<\/?[A-Za-z][A-Za-z0-9:-]*(?:\s[^<>]*?)?\/?>/u;

function loadSchema(type) {
  const filename =
    type === 'handoff'
      ? 'author-handoff.v1.schema.json'
      : 'healer-trace.v1.schema.json';
  const version = type === 'handoff' ? 'author-handoff.v1' : 'healer-trace.v1';
  try {
    const schema = JSON.parse(
      readFileSync(path.join(__dirname, '..', 'schemas', filename), 'utf8'),
    );
    const hash = createHash('sha256')
      .update(JSON.stringify(schema))
      .digest('hex');
    return isObject(schema) &&
      schema.$schema === 'https://json-schema.org/draft/2020-12/schema' &&
      schema.$id === `playwright-testgen/${version}` &&
      schema.type === 'object' &&
      schema.additionalProperties === false &&
      schema.properties?.schema_version?.const === version &&
      schema.properties?.run_id?.pattern === RUN_ID.source &&
      hash === SCHEMA_HASHES[type]
      ? schema
      : null;
  } catch {
    return null;
  }
}

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function portable(value) {
  return value.replaceAll('\\', '/');
}

function comparableRepoPath(value) {
  const normalized = portable(path.normalize(value));
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (relative !== '..' &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

function samePath(left, right) {
  return process.platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

function isText(value, maximum) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maximum &&
    !/[\r\n]/u.test(value)
  );
}

function isFile(value) {
  try {
    return statSync(value).isFile();
  } catch {
    return false;
  }
}

function isRepoPath(value) {
  return (
    isText(value, 240) &&
    !path.isAbsolute(value) &&
    !value.includes('\0') &&
    !portable(value).startsWith('../')
  );
}

function isAttributeName(value) {
  return (
    isText(value, 64) &&
    /^(?:none-found|[A-Za-z_][A-Za-z0-9_.:-]{0,63})$/u.test(value)
  );
}

function parseArgs(argv) {
  const options = {};
  const positionals = [];
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (['--repo', '--type', '--run-id'].includes(value)) {
      if (argv[index + 1] == null || Object.hasOwn(options, value)) {
        throw new Error('invalid-arguments');
      }
      options[value] = argv[index + 1];
      index += 1;
    } else if (value.startsWith('--')) {
      throw new Error('invalid-arguments');
    } else {
      positionals.push(value);
    }
  }
  if (
    !TYPES.has(options['--type']) ||
    !RUN_ID.test(options['--run-id'] ?? '') ||
    positionals.length !== 1
  ) {
    throw new Error('invalid-arguments');
  }
  return {
    artifact: positionals[0],
    repository: options['--repo'] ?? process.cwd(),
    runId: options['--run-id'],
    type: options['--type'],
  };
}

function report(valid, type, errors, metadata) {
  const output = valid
    ? { valid: true, type, ...metadata }
    : {
        valid: false,
        type: type ?? null,
        errors: [...new Set(errors)].slice(0, 12),
      };
  process[valid ? 'stdout' : 'stderr'].write(`${JSON.stringify(output)}\n`);
  if (!valid) process.exitCode = 1;
}

function rejectUnknown(value, allowed, errors, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) errors.push(`${label}-unknown-field`);
  }
}

function requireFields(value, fields, errors, label) {
  for (const field of fields) {
    if (!Object.hasOwn(value, field)) errors.push(`${label}-missing-field`);
  }
}

function containsProhibited(value, key = '') {
  if (PROHIBITED_KEY.test(key)) return true;
  if (typeof value === 'string') {
    const environmentInput =
      key === 'locator' ? value.replace(CSS_ATTRIBUTE_SELECTOR, '') : value;
    return (
      PROHIBITED_VALUE.test(value) ||
      ENVIRONMENT_VALUE.test(environmentInput) ||
      RAW_DOM_TAG.test(value)
    );
  }
  if (Array.isArray(value))
    return value.some((item) => containsProhibited(item));
  return (
    isObject(value) &&
    Object.entries(value).some(([name, item]) => containsProhibited(item, name))
  );
}

function validatePath(value, repository, errors, label) {
  if (!isRepoPath(value)) {
    errors.push(`${label}-invalid-path`);
    return;
  }
  if (!isInside(repository, path.resolve(repository, value))) {
    errors.push(`${label}-outside-repository`);
    return;
  }
  let canonical;
  try {
    canonical = realpathSync(path.resolve(repository, value));
  } catch {
    errors.push(`${label}-unavailable`);
    return;
  }
  if (!isInside(repository, canonical)) {
    errors.push(`${label}-outside-repository`);
  }
}

function validateStringArray(
  value,
  maximumItems,
  maximumText,
  errors,
  label,
  minimumItems = 0,
) {
  if (
    !Array.isArray(value) ||
    value.length < minimumItems ||
    value.length > maximumItems
  ) {
    errors.push(`${label}-invalid-array`);
    return;
  }
  if (value.some((item) => !isText(item, maximumText)))
    errors.push(`${label}-invalid-text`);
}

function validateHandoff(artifact, repository, errors) {
  const required = [
    'schema_version',
    'run_id',
    'scenario_ref',
    'spec_path',
    'criteria',
    'locators',
    'test_id_convention',
    'test_id_additions',
    'lint',
    'test_data_strategy',
    'touched_paths',
    'assumptions',
    'open_questions',
  ];
  const allowed = new Set(required);
  requireFields(artifact, required, errors, 'handoff');
  rejectUnknown(artifact, allowed, errors, 'handoff');
  if (artifact.schema_version !== 'author-handoff.v1')
    errors.push('handoff-schema-version');
  if (!isText(artifact.scenario_ref, 160))
    errors.push('handoff-invalid-scenario-ref');
  validatePath(artifact.spec_path, repository, errors, 'handoff-spec');
  if (
    isRepoPath(artifact.spec_path) &&
    !isFile(path.resolve(repository, artifact.spec_path))
  ) {
    errors.push('handoff-spec-unavailable');
  }
  if (
    !Array.isArray(artifact.criteria) ||
    artifact.criteria.length < 1 ||
    artifact.criteria.length > 20
  ) {
    errors.push('handoff-invalid-criteria');
  } else {
    const ids = new Set();
    for (const criterion of artifact.criteria) {
      if (!isObject(criterion)) {
        errors.push('handoff-invalid-criterion');
        continue;
      }
      requireFields(
        criterion,
        ['id', 'assertion_location', 'outcome'],
        errors,
        'criterion',
      );
      rejectUnknown(
        criterion,
        new Set(['id', 'assertion_location', 'outcome']),
        errors,
        'criterion',
      );
      if (!isText(criterion.id, 80) || ids.has(criterion.id))
        errors.push('handoff-invalid-criterion-id');
      ids.add(criterion.id);
      if (
        !isText(criterion.assertion_location, 240) ||
        !/^.+:[1-9]\d*$/u.test(criterion.assertion_location)
      ) {
        errors.push('handoff-invalid-assertion-location');
      } else {
        const locationPath = criterion.assertion_location.replace(
          /:[1-9]\d*$/u,
          '',
        );
        validatePath(
          locationPath,
          repository,
          errors,
          'handoff-assertion-location-path',
        );
        const declaredPaths = new Set(
          [
            artifact.spec_path,
            ...(Array.isArray(artifact.touched_paths)
              ? artifact.touched_paths
              : []),
          ]
            .filter((value) => typeof value === 'string')
            .map(comparableRepoPath),
        );
        if (!declaredPaths.has(comparableRepoPath(locationPath)))
          errors.push('handoff-assertion-location-path-not-declared');
      }
      if (!isText(criterion.outcome, 200))
        errors.push('handoff-invalid-outcome');
    }
  }
  if (!Array.isArray(artifact.locators) || artifact.locators.length > 40) {
    errors.push('handoff-invalid-locators');
  } else {
    for (const locator of artifact.locators) {
      if (!isObject(locator)) {
        errors.push('handoff-invalid-locator');
        continue;
      }
      requireFields(
        locator,
        ['purpose', 'locator', 'strategy', 'live_count', 'visible'],
        errors,
        'locator',
      );
      rejectUnknown(
        locator,
        new Set(['purpose', 'locator', 'strategy', 'live_count', 'visible']),
        errors,
        'locator',
      );
      if (!isText(locator.purpose, 160))
        errors.push('handoff-invalid-locator-purpose');
      if (!isText(locator.locator, 240))
        errors.push('handoff-invalid-locator-value');
      if (
        !['role', 'label', 'text', 'test-id', 'css', 'positional'].includes(
          locator.strategy,
        )
      )
        errors.push('handoff-invalid-locator-strategy');
      if (locator.live_count !== 1 || locator.visible !== true)
        errors.push('handoff-unverified-locator');
      if (
        locator.strategy === 'test-id' &&
        artifact.test_id_convention === 'none-found'
      )
        errors.push('handoff-test-id-locator-without-convention');
    }
  }
  if (!isAttributeName(artifact.test_id_convention))
    errors.push('handoff-invalid-test-id-convention');
  if (
    !Array.isArray(artifact.test_id_additions) ||
    artifact.test_id_additions.length > 10
  ) {
    errors.push('handoff-invalid-test-id-additions');
  } else {
    for (const addition of artifact.test_id_additions) {
      if (!isObject(addition)) {
        errors.push('handoff-invalid-test-id-addition');
        continue;
      }
      const fields = ['path', 'attribute', 'purpose'];
      requireFields(addition, fields, errors, 'test-id-addition');
      rejectUnknown(addition, new Set(fields), errors, 'test-id-addition');
      validatePath(
        addition.path,
        repository,
        errors,
        'handoff-test-id-addition',
      );
      if (
        !isAttributeName(addition.attribute) ||
        addition.attribute === 'none-found'
      )
        errors.push('handoff-invalid-test-id-attribute');
      if (addition.attribute !== artifact.test_id_convention)
        errors.push('handoff-test-id-convention-mismatch');
      if (
        typeof addition.path !== 'string' ||
        !Array.isArray(artifact.touched_paths) ||
        !artifact.touched_paths
          .filter((value) => typeof value === 'string')
          .map(comparableRepoPath)
          .includes(
            comparableRepoPath(
              typeof addition.path === 'string' ? addition.path : '',
            ),
          )
      )
        errors.push('handoff-test-id-addition-not-touched');
      if (!isText(addition.purpose, 160))
        errors.push('handoff-invalid-test-id-purpose');
    }
  }
  if (!isObject(artifact.lint)) {
    errors.push('handoff-invalid-lint');
  } else {
    requireFields(
      artifact.lint,
      ['command', 'status', 'diagnostics'],
      errors,
      'lint',
    );
    rejectUnknown(
      artifact.lint,
      new Set(['command', 'status', 'diagnostics']),
      errors,
      'lint',
    );
    if (!isText(artifact.lint.command, 160))
      errors.push('handoff-invalid-lint-command');
    if (
      !['pass', 'fixed', 'failed', 'command-failed'].includes(
        artifact.lint.status,
      )
    )
      errors.push('handoff-invalid-lint-status');
    validateStringArray(
      artifact.lint.diagnostics,
      10,
      200,
      errors,
      'handoff-lint-diagnostics',
    );
    if (
      ['failed', 'command-failed'].includes(artifact.lint.status) &&
      artifact.lint.diagnostics?.length === 0
    )
      errors.push('handoff-missing-lint-diagnostics');
  }
  if (!isText(artifact.test_data_strategy, 160))
    errors.push('handoff-invalid-test-data-strategy');
  validateStringArray(
    artifact.touched_paths,
    20,
    240,
    errors,
    'handoff-touched-paths',
    1,
  );
  if (Array.isArray(artifact.touched_paths))
    artifact.touched_paths.forEach((item) =>
      validatePath(item, repository, errors, 'handoff-touched'),
    );
  validateStringArray(
    artifact.assumptions,
    10,
    200,
    errors,
    'handoff-assumptions',
  );
  validateStringArray(
    artifact.open_questions,
    10,
    200,
    errors,
    'handoff-open-questions',
  );
}

function loadHandoffCriteria(repository, runPolicy, runId) {
  if (loadSchema('handoff') == null) return null;
  const handoffPath = path.join(runPolicy.runDirectory, 'handoff.json');
  try {
    const canonical = realpathSync(handoffPath);
    if (
      !samePath(
        canonical,
        path.join(runPolicy.canonicalRunDirectory, 'handoff.json'),
      ) ||
      !isFile(canonical) ||
      statSync(canonical).size > 64 * 1024
    )
      return null;
    const handoff = JSON.parse(readFileSync(canonical, 'utf8'));
    if (!isObject(handoff) || containsProhibited(handoff)) return null;
    const errors = [];
    if (handoff.run_id !== runId) errors.push('run-id-mismatch');
    if (
      typeof handoff.spec_path !== 'string' ||
      !samePath(
        path.resolve(repository, handoff.spec_path),
        runPolicy.approvedSpec,
      )
    )
      errors.push('policy-spec-mismatch');
    validateHandoff(handoff, repository, errors);
    if (!['pass', 'fixed'].includes(handoff.lint?.status))
      errors.push('handoff-lint-not-passed');
    return errors.length === 0
      ? new Map(
          handoff.criteria.map((criterion) => [
            criterion.id,
            criterion.outcome,
          ]),
        )
      : null;
  } catch {
    return null;
  }
}

function validateProductEvidence(value, handoffCriteria, errors) {
  if (!isObject(value)) {
    errors.push('trace-missing-product-behavior-evidence');
    return;
  }
  const fields = [
    'criterion_id',
    'required_outcome',
    'observed_behavior',
    'contradiction',
    'expectation_drift_rejected',
  ];
  requireFields(value, fields, errors, 'product-behavior-evidence');
  rejectUnknown(value, new Set(fields), errors, 'product-behavior-evidence');
  if (!isText(value.criterion_id, 80))
    errors.push('trace-invalid-product-criterion');
  else {
    const retainedOutcome = handoffCriteria?.get(value.criterion_id);
    if (retainedOutcome == null) errors.push('trace-unknown-product-criterion');
    else if (value.required_outcome !== retainedOutcome)
      errors.push('trace-product-outcome-mismatch');
  }
  for (const field of fields.slice(1)) {
    if (!isText(value[field], 240))
      errors.push('trace-invalid-product-behavior-evidence');
  }
}

function validateTrace(artifact, repository, handoffCriteria, errors) {
  const required = [
    'schema_version',
    'run_id',
    'spec_path',
    'handoff_read',
    'attempts',
    'repairs',
    'final_classification',
    'disposition',
    'next_owner',
    'escalation',
    'cleanup',
  ];
  requireFields(artifact, required, errors, 'trace');
  rejectUnknown(artifact, new Set(required), errors, 'trace');
  if (artifact.schema_version !== 'healer-trace.v1')
    errors.push('trace-schema-version');
  validatePath(artifact.spec_path, repository, errors, 'trace-spec');
  if (
    isRepoPath(artifact.spec_path) &&
    !isFile(path.resolve(repository, artifact.spec_path))
  ) {
    errors.push('trace-spec-unavailable');
  }
  if (artifact.handoff_read !== true) errors.push('trace-handoff-not-read');
  if (
    !Array.isArray(artifact.attempts) ||
    artifact.attempts.length < 1 ||
    artifact.attempts.length > 5
  ) {
    errors.push('trace-invalid-attempts');
  } else {
    for (const [index, attempt] of artifact.attempts.entries()) {
      if (!isObject(attempt)) {
        errors.push('trace-invalid-attempt');
        continue;
      }
      const fields = [
        'number',
        'kind',
        'hypothesis',
        'failure_signature',
        'evidence_summary',
        'classification',
        'action',
        'outcome',
      ];
      requireFields(attempt, fields, errors, 'attempt');
      rejectUnknown(
        attempt,
        new Set([...fields, 'product_behavior_evidence']),
        errors,
        'attempt',
      );
      if (attempt.number !== index + 1)
        errors.push('trace-nonsequential-attempt');
      if (!['debug-run', 'confirmation-run'].includes(attempt.kind))
        errors.push('trace-invalid-attempt-kind');
      if (
        !isText(attempt.hypothesis, 200) ||
        !isText(attempt.evidence_summary, 240)
      )
        errors.push('trace-invalid-attempt-summary');
      if (
        attempt.failure_signature !== null &&
        !isText(attempt.failure_signature, 160)
      )
        errors.push('trace-invalid-failure-signature');
      if (
        attempt.classification !== null &&
        !CLASSIFICATIONS.has(attempt.classification)
      )
        errors.push('trace-invalid-attempt-classification');
      if (!['pass', 'fail', 'blocked'].includes(attempt.outcome))
        errors.push('trace-invalid-attempt-outcome');
      if (attempt.action !== null && !isText(attempt.action, 200))
        errors.push('trace-invalid-action');
      if (
        attempt.outcome === 'pass' &&
        (attempt.failure_signature !== null || attempt.classification !== null)
      )
        errors.push('trace-passing-attempt-has-failure');
      if (
        ['fail', 'blocked'].includes(attempt.outcome) &&
        (attempt.classification == null || !isText(attempt.action, 200))
      )
        errors.push('trace-failed-attempt-missing-decision');
      if (attempt.classification === 'product-behavior-wrong') {
        validateProductEvidence(
          attempt.product_behavior_evidence,
          handoffCriteria,
          errors,
        );
      } else if (
        attempt.product_behavior_evidence !== null &&
        attempt.product_behavior_evidence !== undefined
      ) {
        errors.push('trace-unexpected-product-behavior-evidence');
      }
    }
    const terminalIndex = artifact.attempts.findIndex(
      (attempt) =>
        isObject(attempt) &&
        TERMINAL_CLASSIFICATIONS.has(attempt.classification),
    );
    if (terminalIndex >= 0 && terminalIndex !== artifact.attempts.length - 1)
      errors.push('trace-attempt-after-terminal-classification');
  }
  if (!Array.isArray(artifact.repairs) || artifact.repairs.length > 10) {
    errors.push('trace-invalid-repairs');
  } else {
    for (const repair of artifact.repairs) {
      if (!isObject(repair)) {
        errors.push('trace-invalid-repair');
        continue;
      }
      const fields = ['attempt_number', 'paths', 'reason'];
      requireFields(repair, fields, errors, 'repair');
      rejectUnknown(repair, new Set(fields), errors, 'repair');
      if (
        !Number.isInteger(repair.attempt_number) ||
        repair.attempt_number < 1 ||
        repair.attempt_number > 5
      )
        errors.push('trace-invalid-repair-attempt');
      const repairedAttempt = Array.isArray(artifact.attempts)
        ? artifact.attempts[repair.attempt_number - 1]
        : null;
      if (
        !isObject(repairedAttempt) ||
        repairedAttempt.number !== repair.attempt_number ||
        !REPAIRABLE_CLASSIFICATIONS.has(repairedAttempt.classification)
      )
        errors.push('trace-repair-for-unrepairable-attempt');
      validateStringArray(
        repair.paths,
        3,
        240,
        errors,
        'trace-repair-paths',
        1,
      );
      if (Array.isArray(repair.paths))
        repair.paths.forEach((item) =>
          validatePath(item, repository, errors, 'trace-repair'),
        );
      if (!isText(repair.reason, 200))
        errors.push('trace-invalid-repair-reason');
    }
  }
  if (
    artifact.final_classification !== null &&
    !CLASSIFICATIONS.has(artifact.final_classification)
  )
    errors.push('trace-invalid-final-classification');
  if (!DISPOSITIONS.has(artifact.disposition))
    errors.push('trace-invalid-disposition');
  if (!['human', 'author', 'product-owner'].includes(artifact.next_owner))
    errors.push('trace-invalid-next-owner');
  if (artifact.escalation !== null && !isText(artifact.escalation, 200))
    errors.push('trace-invalid-escalation');
  if (!isObject(artifact.cleanup)) {
    errors.push('trace-invalid-cleanup');
  } else {
    requireFields(
      artifact.cleanup,
      ['runner', 'browser_session', 'scratch'],
      errors,
      'cleanup',
    );
    rejectUnknown(
      artifact.cleanup,
      new Set(['runner', 'browser_session', 'scratch']),
      errors,
      'cleanup',
    );
    if (
      !['stopped', 'not-started', 'cleanup-failed'].includes(
        artifact.cleanup.runner,
      )
    )
      errors.push('trace-invalid-runner-cleanup');
    if (
      !['closed', 'detached', 'not-opened', 'cleanup-failed'].includes(
        artifact.cleanup.browser_session,
      )
    )
      errors.push('trace-invalid-session-cleanup');
    if (
      !['retained-pending-acceptance', 'removed', 'cleanup-failed'].includes(
        artifact.cleanup.scratch,
      )
    )
      errors.push('trace-invalid-scratch-cleanup');
  }
  const finalAttempt = Array.isArray(artifact.attempts)
    ? artifact.attempts.at(-1)
    : null;
  const lastFailure = Array.isArray(artifact.attempts)
    ? artifact.attempts
        .slice()
        .reverse()
        .find(
          (attempt) =>
            isObject(attempt) &&
            ['fail', 'blocked'].includes(attempt.outcome) &&
            CLASSIFICATIONS.has(attempt.classification),
        )
    : null;
  if (artifact.final_classification !== (lastFailure?.classification ?? null))
    errors.push('trace-final-classification-mismatch');
  if (
    artifact.disposition === 'fixed' &&
    (!isObject(finalAttempt) ||
      finalAttempt.kind !== 'confirmation-run' ||
      finalAttempt.outcome !== 'pass')
  )
    errors.push('fixed-requires-confirmation');
  if (
    artifact.disposition === 'fixed' &&
    (artifact.next_owner !== 'human' || artifact.escalation !== null)
  )
    errors.push('trace-invalid-fixed-disposition');
  if (
    artifact.disposition === 'fixed' &&
    TERMINAL_CLASSIFICATIONS.has(lastFailure?.classification)
  )
    errors.push('trace-fixed-after-terminal-classification');
  if (
    artifact.disposition === 'needs-author-revision' &&
    artifact.next_owner !== 'author'
  )
    errors.push('trace-invalid-author-disposition');
  if (
    artifact.disposition === 'product-behavior-wrong' &&
    !['human', 'product-owner'].includes(artifact.next_owner)
  )
    errors.push('trace-invalid-product-disposition');
  if (
    ['needs-user-input', 'unresolved-after-healing'].includes(
      artifact.disposition,
    ) &&
    artifact.next_owner !== 'human'
  )
    errors.push('trace-invalid-human-disposition');
  if (
    artifact.disposition !== 'fixed' &&
    isObject(finalAttempt) &&
    finalAttempt.outcome === 'pass'
  )
    errors.push('trace-passing-attempt-requires-fixed');
  if (artifact.disposition !== 'fixed' && !isText(artifact.escalation, 200))
    errors.push('trace-missing-escalation');
  const expectedClassification = {
    'needs-author-revision': 'intent-wrong',
    'needs-user-input': 'environment-or-auth',
    'product-behavior-wrong': 'product-behavior-wrong',
  };
  if (
    expectedClassification[artifact.disposition] != null &&
    artifact.final_classification !==
      expectedClassification[artifact.disposition]
  ) {
    errors.push('trace-disposition-classification-mismatch');
  }
  if (
    artifact.disposition === 'unresolved-after-healing' &&
    ['intent-wrong', 'environment-or-auth', 'product-behavior-wrong'].includes(
      artifact.final_classification,
    )
  )
    errors.push('trace-disposition-classification-mismatch');
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch {
    report(false, null, ['invalid-arguments']);
    return;
  }
  if (loadSchema(options.type) == null) {
    report(false, options.type, ['schema-unavailable']);
    return;
  }
  let repository;
  try {
    repository = realpathSync(options.repository);
  } catch {
    report(false, options.type, ['repository-unavailable']);
    return;
  }
  const runPolicy = loadPolicy(repository, options.runId);
  if (runPolicy == null) {
    report(false, options.type, ['run-policy-unavailable']);
    return;
  }
  const artifactPath = path.resolve(repository, options.artifact);
  if (!isInside(repository, artifactPath) || !existsSync(artifactPath)) {
    report(false, options.type, ['artifact-outside-repository']);
    return;
  }
  let realArtifact;
  try {
    realArtifact = realpathSync(artifactPath);
  } catch {
    report(false, options.type, ['artifact-unavailable']);
    return;
  }
  const filename =
    options.type === 'handoff' ? 'handoff.json' : 'healer-trace.json';
  const expectedPath = path.join(
    repository,
    '.playwright-cli',
    'testgen',
    options.runId,
    filename,
  );
  if (
    !isInside(repository, realArtifact) ||
    !isFile(realArtifact) ||
    portable(path.relative(repository, artifactPath)) !==
      portable(path.relative(repository, expectedPath)) ||
    portable(path.relative(repository, realArtifact)) !==
      portable(path.relative(repository, expectedPath))
  ) {
    report(false, options.type, ['artifact-not-run-owned']);
    return;
  }
  let artifactSize;
  try {
    artifactSize = statSync(realArtifact).size;
  } catch {
    report(false, options.type, ['artifact-unavailable']);
    return;
  }
  if (artifactSize > 64 * 1024) {
    report(false, options.type, ['artifact-too-large']);
    return;
  }
  let artifact;
  try {
    artifact = JSON.parse(readFileSync(realArtifact, 'utf8'));
  } catch {
    report(false, options.type, ['artifact-invalid-json']);
    return;
  }
  if (!isObject(artifact)) {
    report(false, options.type, ['artifact-not-object']);
    return;
  }
  if (containsProhibited(artifact)) {
    report(false, options.type, ['prohibited-content']);
    return;
  }
  const errors = [];
  if (!RUN_ID.test(artifact.run_id ?? ''))
    errors.push('artifact-invalid-run-id');
  if (artifact.run_id !== options.runId) errors.push('run-id-mismatch');
  if (
    typeof artifact.spec_path !== 'string' ||
    !samePath(
      path.resolve(repository, artifact.spec_path),
      runPolicy.approvedSpec,
    )
  )
    errors.push('policy-spec-mismatch');
  if (options.type === 'handoff') {
    validateHandoff(artifact, repository, errors);
  } else {
    const handoffCriteria = loadHandoffCriteria(
      repository,
      runPolicy,
      options.runId,
    );
    if (handoffCriteria == null) errors.push('trace-handoff-unavailable');
    validateTrace(artifact, repository, handoffCriteria, errors);
  }
  if (errors.length > 0) {
    report(false, options.type, errors);
    return;
  }
  report(true, options.type, [], {
    run_id: options.runId,
    artifact_path: portable(path.relative(repository, realArtifact)),
  });
}

main();

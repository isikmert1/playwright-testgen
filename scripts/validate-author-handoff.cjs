const { readFileSync, realpathSync, statSync } = require('node:fs');
const path = require('node:path');
const {
  comparableRepoPath,
  containsProhibited,
  isAttributeName,
  isFile,
  isIdentifier,
  isObject,
  isRepoPath,
  isText,
  loadSchema,
  rejectUnknown,
  requireFields,
  samePath,
  validatePath,
  validateStringArray,
} = require('./artifact-validation-common.cjs');

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
      if (!isIdentifier(criterion.id) || ids.has(criterion.id))
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
    const additions = new Set();
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
        isRepoPath(addition.path) &&
        !isFile(path.resolve(repository, addition.path))
      )
        errors.push('handoff-test-id-addition-not-file');
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
      const additionKey = JSON.stringify([
        typeof addition.path === 'string'
          ? comparableRepoPath(addition.path)
          : addition.path,
        addition.attribute,
        addition.purpose,
      ]);
      if (additions.has(additionKey))
        errors.push('handoff-duplicate-test-id-addition');
      additions.add(additionKey);
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
  if (Array.isArray(artifact.touched_paths)) {
    const paths = artifact.touched_paths.filter(
      (item) => typeof item === 'string',
    );
    const comparable = paths.map(comparableRepoPath);
    if (new Set(comparable).size !== paths.length)
      errors.push('handoff-duplicate-touched-path');
    if (
      typeof artifact.spec_path === 'string' &&
      !new Set(comparable).has(comparableRepoPath(artifact.spec_path))
    )
      errors.push('handoff-spec-not-touched');
    for (const item of paths) {
      validatePath(item, repository, errors, 'handoff-touched');
      if (isRepoPath(item) && !isFile(path.resolve(repository, item)))
        errors.push('handoff-touched-not-file');
    }
  }
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

module.exports = { loadHandoffCriteria, validateHandoff };

#!/usr/bin/env node

const { createHash } = require('node:crypto');
const { existsSync, readFileSync, readdirSync } = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const cases = [
  ['healthy-generation', 'generation'],
  ['selector-repair', 'selector-repair'],
  ['healer-product-defect-refusal', 'product-defect-refusal'],
];
const targetUnavailableReasons = new Set([
  'target-unavailable',
  'target-dependencies-unavailable',
  'target-git-unavailable',
  'target-server-unavailable',
  'runner-browser-unavailable',
  'playwright-unavailable',
]);
const criticalFailureReasons = new Set([
  'product-changed',
  'spec-changed',
  'repository-state-changed',
  'target-state-changed',
  'repair-scope-changed',
  'trace-invalid',
  'failure-unattributed',
  'hook-governance-unverified',
  'candidate-approval-mismatch',
  'execution-attribution-invalid',
]);

function readJson(filename) {
  return JSON.parse(readFileSync(filename, 'utf8'));
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function datasetDigest() {
  const files = [];
  function add(relative) {
    const absolute = path.join(root, relative);
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      const child = path.join(relative, entry.name);
      if (entry.isDirectory()) add(child);
      else if (entry.isFile()) files.push(child);
    }
  }
  for (const directory of [
    ...cases.map(([caseDirectory]) => `evals/cases/${caseDirectory}`),
    'evals/seeded-bugs',
    'evals/targets/semantic-only',
    'scripts/eval',
  ])
    add(directory);
  files.push(
    'scripts/run-healer-defect-refusal.cjs',
    'scripts/run-generation-eval.cjs',
    'scripts/run-generation-candidate.cjs',
    'scripts/run-selector-repair-eval.cjs',
    'scripts/score-healer-defect-refusal.cjs',
    'scripts/score-selector-repair.cjs',
    'scripts/score-outcomes.cjs',
    'scripts/windows-process-tree.cjs',
    'scripts/process.cjs',
  );
  const hash = createHash('sha256');
  for (const relative of files
    .map((file) => file.replaceAll('\\', '/'))
    .sort()) {
    hash.update(relative);
    hash.update('\0');
    hash.update(readFileSync(path.join(root, relative)));
    hash.update('\0');
  }
  return hash.digest('hex');
}

function definitions() {
  return cases.map(([directory, kind]) => {
    const definition = readJson(
      path.join(root, 'evals', 'cases', directory, 'case.json'),
    );
    const agentName = definition.agent.name.split(':').at(-1);
    const agent = readFileSync(
      path.join(root, 'agents', `${agentName}.md`),
      'utf8',
    );
    const toolGrants = /^tools: (.+)$/mu.exec(agent)?.[1];
    if (toolGrants == null) throw new Error('agent-tool-grants-unavailable');
    return { ...definition, kind, tool_grants: toolGrants };
  });
}

function profile(result) {
  const runtime = result.runtime ?? result;
  return {
    model: runtime.model_resolved ?? runtime.model ?? null,
    claude_code: runtime.claude_code ?? null,
    node: runtime.node ?? null,
    npm: runtime.npm ?? null,
    playwright: runtime.playwright ?? null,
    playwright_cli: runtime.playwright_cli ?? null,
    platform: runtime.platform ?? null,
    host: runtime.host ?? null,
    browsers: runtime.browsers ?? null,
    agent_limits: runtime.agent_limits ?? null,
  };
}

function readTrial(directory, caseDefinitions) {
  const result = readJson(path.join(directory, 'result.json'));
  const trialId = path.basename(directory);
  const refusal = typeof result.ok === 'boolean';
  const caseId = refusal
    ? caseDefinitions.find(
        (definition) => definition.kind === 'product-defect-refusal',
      ).case_id
    : result.case_id;
  const definition = caseDefinitions.find((item) => item.case_id === caseId);
  if (
    definition == null ||
    (result.case_id != null && result.case_id !== caseId) ||
    (result.trial_id != null && result.trial_id !== trialId)
  )
    throw new Error('trial-identity-invalid');
  const common = {
    case_id: caseId,
    trial_id: trialId,
    complete: false,
    passed: false,
    cost_usd: refusal
      ? ((result.result?.runtime ?? result.runtime)?.total_cost_usd ?? null)
      : (result.cost_usd ?? null),
    duration_ms: refusal
      ? ((result.result?.runtime ?? result.runtime)?.duration_ms ?? null)
      : (result.duration_ms ?? null),
    setup_duration_ms: refusal
      ? ((result.result?.runtime ?? result.runtime)?.setup_duration_ms ?? null)
      : (result.setup_duration_ms ?? null),
    elapsed_ms: result.elapsed_ms ?? null,
    usage: refusal
      ? ((result.result?.runtime ?? result.runtime)?.usage ?? null)
      : (result.usage ?? null),
    profile: profile(
      refusal ? (result.result?.runtime ?? result.runtime ?? {}) : result,
    ),
    testgen_revision: refusal
      ? ((result.result?.runtime ?? result.runtime)?.testgen_revision ?? null)
      : (result.testgen_revision ?? null),
    dataset_sha256: refusal
      ? ((result.result?.runtime ?? result.runtime)?.dataset_sha256 ?? null)
      : (result.dataset_sha256 ?? null),
    error: result.reason ?? result.error ?? result.cleanup?.reason ?? null,
    failure_reasons: [
      result.reason,
      result.error === 'prerequisite-unavailable' &&
      targetUnavailableReasons.has(result.reason)
        ? null
        : result.error,
      result.grade?.reason,
      ...(result.grade?.status === 'failed' ? ['grade-failed'] : []),
      result.cleanup?.reason,
      result.cleanup?.error,
      ...(result.cleanup?.status !== 'passed' ? ['cleanup-unverified'] : []),
    ].filter((reason) => reason != null),
    cleanup_error:
      result.cleanup?.status === 'failed'
        ? (result.cleanup.reason ?? result.cleanup.error ?? 'cleanup-failed')
        : null,
  };
  if (definition.kind === 'generation') {
    const executionPath = path.join(directory, 'execution.json');
    const reviewPath = path.join(directory, 'review.json');
    const execution = existsSync(executionPath)
      ? readJson(executionPath)
      : null;
    const executionDatasetValid =
      execution?.dataset_sha256 === result.dataset_sha256 &&
      result.dataset_sha256 != null;
    const review = existsSync(reviewPath) ? readJson(reviewPath) : null;
    const reviewValid =
      ['approved', 'rejected'].includes(review?.status) &&
      review.candidate_sha256 === result.candidate_sha256 &&
      review.criterion_id === definition.criteria[0].id &&
      typeof review.reason === 'string' &&
      review.reason.length > 0 &&
      review.reason.length <= 500 &&
      typeof review.locator_policy === 'boolean' &&
      typeof review.assertion_specificity === 'boolean';
    return {
      ...common,
      profile: { ...common.profile, execution: execution?.runtime ?? null },
      failure_reasons: [
        ...common.failure_reasons,
        execution?.error,
        execution?.cleanup?.reason,
        execution?.cleanup?.error,
        ...(execution != null && execution.cleanup?.status !== 'passed'
          ? ['execution-cleanup-unverified']
          : []),
        ...(execution != null &&
        (!executionDatasetValid ||
          execution.trial_id !== trialId ||
          execution.candidate_sha256 !== result.candidate_sha256)
          ? ['execution-attribution-invalid']
          : []),
        ...(review != null && !reviewValid ? ['review-invalid'] : []),
      ].filter((reason) => reason != null),
      error:
        common.error ??
        execution?.error ??
        execution?.cleanup?.reason ??
        (execution != null && !executionDatasetValid
          ? 'execution-dataset-mismatch'
          : null),
      cleanup_error:
        common.cleanup_error ??
        (execution?.cleanup?.status === 'failed'
          ? (execution.cleanup.reason ??
            execution.cleanup.error ??
            'cleanup-failed')
          : null),
      complete:
        executionDatasetValid &&
        result.status === 'checkpoint' &&
        result.cleanup?.status === 'passed' &&
        execution?.status === 'complete' &&
        execution.trial_id === trialId &&
        execution.candidate_sha256 === result.candidate_sha256 &&
        reviewValid,
      passed:
        execution?.first_try === 'pass' &&
        review?.status === 'approved' &&
        review.locator_policy &&
        review.assertion_specificity,
      first_try: execution?.first_try ?? null,
      execution_elapsed_ms: execution?.elapsed_ms ?? null,
      criterion_review: review?.status ?? null,
      locator_policy: review?.locator_policy ?? null,
      assertion_specificity: review?.assertion_specificity ?? null,
      mutation_eligibility: definition.expected.mutation,
      human_interventions: reviewValid ? 1 : null,
    };
  }
  if (definition.kind === 'selector-repair')
    return {
      ...common,
      complete:
        result.status === 'complete' &&
        result.cleanup?.status === 'passed' &&
        result.grade?.status != null,
      passed: result.grade?.status === 'passed',
      healer_attempts: result.grade?.healer_attempts ?? null,
      classification: result.grade?.classification ?? null,
      human_interventions: 1,
    };
  return {
    ...common,
    complete:
      (result.cleanup?.status === 'passed' ||
        (result.ok === false && result.cleanup == null)) &&
      (result.ok === true || result.reason === 'trace-verdict-mismatch'),
    passed:
      result.ok === true &&
      result.result?.score?.classification === 'product-behavior-wrong',
    classification: result.result?.score?.classification ?? null,
    human_interventions: 1,
  };
}

function metric(attempts, predicate, success) {
  const eligible = attempts.filter(
    (trial) => trial.complete && predicate(trial),
  );
  return {
    passed: eligible.filter(success).length,
    eligible: eligible.length,
  };
}

function totalMetric(attempts, key) {
  const known = attempts.filter((trial) => Number.isFinite(trial[key]));
  return {
    reported:
      Math.round(known.reduce((total, trial) => total + trial[key], 0) * 1e6) /
      1e6,
    unavailable: attempts.length - known.length,
  };
}

function costMetric(attempts) {
  const cost = totalMetric(attempts, 'cost_usd');
  return { ...cost, total: cost.unavailable === 0 ? cost.reported : null };
}

function replacementExclusions(attempts, replacements, digest) {
  if (!Array.isArray(replacements)) throw new Error('replacement-invalid');
  const trials = new Map(attempts.map((trial) => [trial.trial_id, trial]));
  const used = new Set();
  const excludedIds = new Set();
  const keys = [
    'excluded_trial_id',
    'replacement_trial_id',
    'reason',
    'approval_ref',
  ];
  for (const record of replacements) {
    if (
      record == null ||
      Object.keys(record).length !== keys.length ||
      !keys.every(
        (key) =>
          typeof record[key] === 'string' && record[key].trim().length > 0,
      )
    )
      throw new Error('replacement-invalid');
    const excluded = trials.get(record.excluded_trial_id);
    const replacementTrial = trials.get(record.replacement_trial_id);
    if (
      excluded == null ||
      replacementTrial == null ||
      excluded.trial_id === replacementTrial.trial_id ||
      used.has(excluded.trial_id) ||
      used.has(replacementTrial.trial_id) ||
      excluded.case_id !== replacementTrial.case_id ||
      excluded.dataset_sha256 !== digest ||
      replacementTrial.dataset_sha256 !== digest ||
      excluded.complete ||
      excluded.passed ||
      !targetUnavailableReasons.has(excluded.error) ||
      (excluded.failure_reasons ?? []).some(
        (reason) => !targetUnavailableReasons.has(reason),
      ) ||
      excluded.cleanup_error != null ||
      excluded.first_try === 'fail' ||
      excluded.classification != null ||
      excluded.criterion_review === 'rejected' ||
      excluded.locator_policy === false ||
      excluded.assertion_specificity === false
    )
      throw new Error('replacement-invalid');
    used.add(excluded.trial_id);
    used.add(replacementTrial.trial_id);
    excludedIds.add(excluded.trial_id);
  }
  return excludedIds;
}

function cohortRevision(attempts, currentRevision) {
  return attempts[0]?.testgen_revision ?? currentRevision;
}

function summarizeOutcomeTrials(
  caseDefinitions,
  rawAttempts,
  digest,
  revision,
  replacements = [],
) {
  const allAttempts = rawAttempts.map((trial) =>
    trial.dataset_sha256 === digest
      ? trial
      : {
          ...trial,
          complete: false,
          passed: false,
          error:
            trial.error ??
            (trial.dataset_sha256 == null
              ? 'dataset-unverified'
              : 'dataset-mismatch'),
        },
  );
  const repairCaseId = caseDefinitions.find(
    (item) => item.kind === 'selector-repair',
  ).case_id;
  const refusalCaseId = caseDefinitions.find(
    (item) => item.kind === 'product-defect-refusal',
  ).case_id;
  const identities = new Set();
  for (const trial of allAttempts) {
    if (
      !caseDefinitions.some(
        (definition) => definition.case_id === trial.case_id,
      ) ||
      typeof trial.trial_id !== 'string' ||
      trial.trial_id.length === 0 ||
      identities.has(trial.trial_id)
    )
      throw new Error('trial-identity-invalid');
    identities.add(trial.trial_id);
  }
  const excludedIds = replacementExclusions(allAttempts, replacements, digest);
  const attempts = allAttempts.filter(
    (trial) => !excludedIds.has(trial.trial_id),
  );
  const casesById = Object.fromEntries(
    caseDefinitions.map((definition) => [
      definition.case_id,
      { planned: definition.planned_trials, attempts: [] },
    ]),
  );
  for (const trial of attempts) {
    casesById[trial.case_id].attempts.push(trial);
  }
  for (const value of Object.values(casesById))
    value.attempts.sort((left, right) =>
      left.trial_id.localeCompare(right.trial_id),
    );
  const completedTrials = attempts.filter((trial) => trial.complete);
  const profiles = {};
  let profileCompatible = true;
  for (const [caseId, value] of Object.entries(casesById)) {
    const distinct = new Set(
      value.attempts.map((trial) => JSON.stringify(trial.profile)),
    );
    const recordedProfile = value.attempts[0]?.profile ?? null;
    const {
      agent_limits: limits = null,
      execution,
      ...runtime
    } = recordedProfile ?? {};
    const definition = caseDefinitions.find((item) => item.case_id === caseId);
    if (
      distinct.size !== 1 ||
      recordedProfile == null ||
      Object.values(runtime).some((item) => item == null) ||
      typeof runtime.host?.os_release !== 'string' ||
      runtime.host.os_release.length === 0 ||
      !['runner', 'exploration'].every((name) =>
        ['engine', 'version'].every(
          (key) =>
            typeof runtime.browsers?.[name]?.[key] === 'string' &&
            runtime.browsers[name][key].length > 0,
        ),
      ) ||
      typeof runtime.browsers.exploration.channel !== 'string' ||
      typeof limits?.name !== 'string' ||
      typeof limits?.model !== 'string' ||
      !['max_turns', 'timeout_ms', 'max_budget_usd'].every(
        (key) => Number.isFinite(limits?.[key]) && limits[key] > 0,
      ) ||
      (definition.kind === 'generation' &&
        (['node', 'npm', 'playwright', 'platform'].some(
          (key) =>
            typeof execution?.[key] !== 'string' || execution[key].length === 0,
        ) ||
          typeof execution.host?.os_release !== 'string' ||
          typeof execution.browser?.version !== 'string')) ||
      value.attempts.some((trial) => trial.testgen_revision !== revision)
    )
      profileCompatible = false;
    profiles[caseId] = {
      runtime,
      tool_grants: definition.tool_grants ?? null,
      permission_mode: 'dontAsk',
      permission_prompts: 'none',
      agent_limits: limits,
      ...(definition.kind === 'generation'
        ? { candidate_execution: execution ?? null }
        : {}),
      grading: 'outcome-suite.v1',
    };
  }
  const plannedTrials = caseDefinitions.reduce(
    (total, definition) => total + definition.planned_trials,
    0,
  );
  const casesComplete = Object.values(casesById).every(
    (value) =>
      value.attempts.length === value.planned &&
      value.attempts.every((trial) => trial.complete),
  );
  const mutationUnavailable = {};
  const unavailableReasons = {};
  for (const trial of attempts) {
    if (trial.error != null)
      unavailableReasons[trial.error] =
        (unavailableReasons[trial.error] ?? 0) + 1;
    if (trial.mutation_eligibility == null) continue;
    if (trial.mutation_eligibility !== 'eligible')
      mutationUnavailable[trial.mutation_eligibility] =
        (mutationUnavailable[trial.mutation_eligibility] ?? 0) + 1;
  }
  const refusalMetric = metric(
    attempts,
    (trial) => trial.case_id === refusalCaseId,
    (trial) => trial.passed,
  );
  const modeledHumanInterventions = totalMetric(
    attempts,
    'human_interventions',
  );
  const metrics = {
    usable_test: metric(
      attempts,
      (trial) => trial.first_try != null,
      (trial) => trial.passed,
    ),
    first_try_pass: metric(
      attempts,
      (trial) => trial.first_try != null,
      (trial) => trial.first_try === 'pass',
    ),
    selector_repair_success: metric(
      attempts,
      (trial) => trial.case_id === repairCaseId,
      (trial) => trial.passed,
    ),
    product_defect_refusal: refusalMetric,
    classification_correct: refusalMetric,
    locator_policy: metric(
      attempts,
      (trial) => trial.locator_policy != null,
      (trial) => trial.locator_policy,
    ),
    assertion_specificity: metric(
      attempts,
      (trial) => trial.assertion_specificity != null,
      (trial) => trial.assertion_specificity,
    ),
    behavior_mutation_coverage: { covered: 0, submitted: 0, rate: null },
    behavior_mutation_kill: { killed: 0, survived: 0, rate: null },
    assertion_sensitivity_kill: { killed: 0, survived: 0, rate: null },
    mutation_telemetry: { status: 'unavailable', reason: 'not-collected' },
    mutation_unavailable: mutationUnavailable,
    unavailable_reasons: unavailableReasons,
    target_unavailable: attempts.filter((trial) =>
      targetUnavailableReasons.has(trial.error),
    ).length,
    verification_errors: attempts.filter(
      (trial) =>
        !trial.complete &&
        trial.error != null &&
        !targetUnavailableReasons.has(trial.error),
    ).length,
    pending: attempts.filter((trial) => !trial.complete && trial.error == null)
      .length,
    healer_attempts: attempts
      .filter((trial) => trial.complete && trial.healer_attempts != null)
      .map((trial) => ({
        trial_id: trial.trial_id,
        count: trial.healer_attempts,
      })),
    healer_attempts_unavailable: attempts.filter(
      (trial) =>
        trial.complete &&
        trial.case_id === repairCaseId &&
        trial.healer_attempts == null,
    ).length,
    cost_usd: costMetric(attempts),
    duration_ms: totalMetric(attempts, 'duration_ms'),
    setup_duration_ms: totalMetric(attempts, 'setup_duration_ms'),
    elapsed_ms: totalMetric(attempts, 'elapsed_ms'),
    candidate_execution_ms: totalMetric(
      attempts.filter((trial) => trial.first_try != null),
      'execution_elapsed_ms',
    ),
    human_interventions: modeledHumanInterventions,
    modeled_human_interventions: modeledHumanInterventions,
    human_interventions_basis: 'modeled-workflow-checkpoints',
    tokens: Object.fromEntries(
      [
        'input_tokens',
        'output_tokens',
        'cache_creation_input_tokens',
        'cache_read_input_tokens',
      ].map((key) => [
        key,
        totalMetric(
          attempts.map((trial) => ({ [key]: trial.usage?.[key] ?? null })),
          key,
        ),
      ]),
    ),
  };
  return {
    schema_version: 'outcome-suite.v1',
    status: casesComplete && profileCompatible ? 'complete' : 'incomplete',
    testgen_revision: revision,
    dataset_sha256: digest,
    profile_sha256: sha256(JSON.stringify(profiles)),
    profiles,
    planned_trials: plannedTrials,
    completed_trials: completedTrials.length,
    critical_failures: allAttempts.flatMap((trial) => {
      const reasons = [
        ...new Set([trial.error, ...(trial.failure_reasons ?? [])]),
      ].filter((reason) => criticalFailureReasons.has(reason));
      return reasons.length === 0
        ? []
        : [{ case_id: trial.case_id, trial_id: trial.trial_id, reasons }];
    }),
    cases: casesById,
    metrics,
    all_attempts: {
      attempted_trials: allAttempts.length,
      completed_trials: allAttempts.filter((trial) => trial.complete).length,
      incomplete_trials: allAttempts.filter((trial) => !trial.complete).length,
      cost_usd: costMetric(allAttempts),
      cases: Object.fromEntries(
        caseDefinitions.map((definition) => [
          definition.case_id,
          {
            planned: definition.planned_trials,
            attempts: allAttempts.filter(
              (trial) => trial.case_id === definition.case_id,
            ),
          },
        ]),
      ),
      unavailable_reasons: allAttempts.reduce((reasons, trial) => {
        if (trial.error != null)
          reasons[trial.error] = (reasons[trial.error] ?? 0) + 1;
        return reasons;
      }, {}),
    },
    replacements: replacements.map((record) => ({
      ...record,
      excluded_attempt: allAttempts.find(
        (trial) => trial.trial_id === record.excluded_trial_id,
      ),
      replacement_attempt: allAttempts.find(
        (trial) => trial.trial_id === record.replacement_trial_id,
      ),
    })),
  };
}

function compareOutcomeSummaries(baseline, current) {
  if (baseline.status !== 'complete' || current.status !== 'complete')
    return { status: 'incomplete' };
  if (
    baseline.dataset_sha256 !== current.dataset_sha256 ||
    baseline.profile_sha256 !== current.profile_sha256 ||
    baseline.planned_trials !== current.planned_trials
  )
    return { status: 'incompatible' };
  if (current.critical_failures?.length > 0)
    return { status: 'regressed', regressions: ['critical-integrity'] };
  const thresholds = baseline.thresholds;
  if (
    thresholds == null ||
    ![
      'usable_test',
      'first_try_pass',
      'selector_repair_success',
      'product_defect_refusal',
      'classification_correct',
      'locator_policy',
      'assertion_specificity',
    ].every((name) => Object.hasOwn(thresholds, name))
  )
    return { status: 'incompatible' };
  const regressions = [];
  for (const [name, maximumDrop] of Object.entries(thresholds)) {
    const previous = baseline.metrics[name];
    const next = current.metrics[name];
    if (
      !Number.isInteger(maximumDrop) ||
      maximumDrop < 0 ||
      previous?.eligible !== next?.eligible
    )
      return { status: 'incompatible' };
    if (previous.passed - next.passed > maximumDrop) regressions.push(name);
  }
  for (const [caseId, previous] of Object.entries(baseline.cases)) {
    const currentCase = current.cases[caseId];
    if (currentCase == null || previous.planned !== currentCase.planned)
      return { status: 'incompatible' };
    if (
      previous.attempts.every((trial) => trial.passed) &&
      currentCase.attempts.some((trial) => !trial.passed)
    )
      regressions.push(`case:${caseId}`);
  }
  const unique = [...new Set(regressions)].sort();
  return unique.length === 0
    ? { status: 'passed', regressions: [] }
    : { status: 'regressed', regressions: unique };
}

function main() {
  const args = process.argv.slice(2);
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const option = args[index];
    if (
      !['--baseline', '--results-dir', '--replacements'].includes(option) ||
      options[option] != null ||
      !args[index + 1] ||
      args[index + 1].startsWith('--')
    )
      throw new Error(
        'usage: score-outcomes.cjs [--baseline <file>] [--results-dir <directory>] [--replacements <file>]',
      );
    options[option] = path.resolve(args[index + 1]);
  }
  const caseDefinitions = definitions();
  const results =
    options['--results-dir'] ?? path.join(root, 'evals', 'outcomes', 'results');
  const attempts = existsSync(results)
    ? readdirSync(results, { withFileTypes: true })
        .filter(
          (entry) => entry.isDirectory() && entry.name.startsWith('trial-'),
        )
        .map((entry) =>
          readTrial(path.join(results, entry.name), caseDefinitions),
        )
    : [];
  const revision = cohortRevision(
    attempts,
    require('node:child_process')
      .execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: root,
        encoding: 'utf8',
      })
      .trim(),
  );
  const summary = summarizeOutcomeTrials(
    caseDefinitions,
    attempts,
    datasetDigest(),
    revision,
    options['--replacements'] == null
      ? []
      : readJson(options['--replacements']),
  );
  const comparison =
    options['--baseline'] != null
      ? compareOutcomeSummaries(readJson(options['--baseline']), summary)
      : null;
  process.stdout.write(`${JSON.stringify({ summary, comparison }, null, 2)}\n`);
  if (
    summary.status !== 'complete' ||
    summary.critical_failures.length > 0 ||
    (comparison && comparison.status !== 'passed')
  )
    process.exitCode = 1;
}

if (require.main === module) main();

module.exports = {
  cohortRevision,
  compareOutcomeSummaries,
  datasetDigest,
  readTrial,
  summarizeOutcomeTrials,
};

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
    'evals/cases',
    'evals/seeded-bugs',
    'evals/targets/semantic-only',
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
  );
  const hash = createHash('sha256');
  for (const relative of files.sort()) {
    hash.update(relative.replaceAll('\\', '/'));
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
    error: result.reason ?? result.error ?? result.cleanup?.reason ?? null,
    cleanup_error:
      result.cleanup?.status === 'failed'
        ? (result.cleanup.reason ?? result.cleanup.error)
        : null,
  };
  if (definition.kind === 'generation') {
    const executionPath = path.join(directory, 'execution.json');
    const reviewPath = path.join(directory, 'review.json');
    const execution = existsSync(executionPath)
      ? readJson(executionPath)
      : null;
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
      error:
        common.error ?? execution?.error ?? execution?.cleanup?.reason ?? null,
      cleanup_error:
        common.cleanup_error ??
        (execution?.cleanup?.status === 'failed'
          ? (execution.cleanup.reason ?? execution.cleanup.error)
          : null),
      complete:
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
  const known = attempts.filter((trial) => typeof trial[key] === 'number');
  return {
    reported:
      Math.round(known.reduce((total, trial) => total + trial[key], 0) * 1e6) /
      1e6,
    unavailable: attempts.length - known.length,
  };
}

function cohortRevision(attempts, currentRevision) {
  return attempts[0]?.testgen_revision ?? currentRevision;
}

function summarizeOutcomeTrials(caseDefinitions, attempts, digest, revision) {
  const repairCaseId = caseDefinitions.find(
    (item) => item.kind === 'selector-repair',
  ).case_id;
  const refusalCaseId = caseDefinitions.find(
    (item) => item.kind === 'product-defect-refusal',
  ).case_id;
  const identities = new Set();
  const casesById = Object.fromEntries(
    caseDefinitions.map((definition) => [
      definition.case_id,
      { planned: definition.planned_trials, attempts: [] },
    ]),
  );
  for (const trial of attempts) {
    if (casesById[trial.case_id] == null || identities.has(trial.trial_id))
      throw new Error('trial-identity-invalid');
    identities.add(trial.trial_id);
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
    const runtime = value.attempts[0]?.profile ?? null;
    if (
      distinct.size !== 1 ||
      runtime == null ||
      Object.values(runtime).some((item) => item == null) ||
      value.attempts.some((trial) => trial.testgen_revision !== revision)
    )
      profileCompatible = false;
    const definition = caseDefinitions.find((item) => item.case_id === caseId);
    profiles[caseId] = {
      runtime,
      tool_grants: definition.tool_grants ?? null,
      permission_mode: 'dontAsk',
      permission_prompts: 'none',
      agent_limits: definition.agent ?? null,
      grading: 'outcome-suite.v1',
    };
  }
  const plannedTrials = caseDefinitions.reduce(
    (total, definition) => total + definition.planned_trials,
    0,
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
    product_defect_refusal: metric(
      attempts,
      (trial) => trial.case_id === refusalCaseId,
      (trial) => trial.passed,
    ),
    classification_correct: metric(
      attempts,
      (trial) => trial.case_id === refusalCaseId,
      (trial) => trial.passed,
    ),
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
    cost_usd: totalMetric(attempts, 'cost_usd'),
    duration_ms: totalMetric(attempts, 'duration_ms'),
    setup_duration_ms: totalMetric(attempts, 'setup_duration_ms'),
    elapsed_ms: totalMetric(attempts, 'elapsed_ms'),
    candidate_execution_ms: totalMetric(
      attempts.filter((trial) => trial.first_try != null),
      'execution_elapsed_ms',
    ),
    human_interventions: totalMetric(attempts, 'human_interventions'),
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
    status:
      completedTrials.length === plannedTrials &&
      attempts.length === plannedTrials &&
      profileCompatible
        ? 'complete'
        : 'incomplete',
    testgen_revision: revision,
    dataset_sha256: digest,
    profile_sha256: sha256(JSON.stringify(profiles)),
    profiles,
    planned_trials: plannedTrials,
    completed_trials: completedTrials.length,
    cases: casesById,
    metrics,
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
  if (args.length > 2 || (args.length === 2 && args[0] !== '--baseline'))
    throw new Error('usage: score-outcomes.cjs [--baseline <file>]');
  const caseDefinitions = definitions();
  const results = path.join(root, 'evals', 'outcomes', 'results');
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
  );
  const comparison =
    args.length === 2
      ? compareOutcomeSummaries(readJson(path.resolve(args[1])), summary)
      : null;
  process.stdout.write(`${JSON.stringify({ summary, comparison }, null, 2)}\n`);
  if (
    summary.status !== 'complete' ||
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

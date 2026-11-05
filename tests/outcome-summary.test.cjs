const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const {
  cpSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  combineResult,
  evaluationFailure,
} = require('../scripts/eval/agent-evidence.cjs');
const {
  cohortRevision,
  compareOutcomeSummaries,
  datasetDigest,
  readTrial,
  summarizeOutcomeTrials,
} = require('../scripts/score-outcomes.cjs');

const definitions = [
  { case_id: 'generation', kind: 'generation', planned_trials: 2 },
  { case_id: 'repair', kind: 'selector-repair', planned_trials: 2 },
  { case_id: 'refusal', kind: 'product-defect-refusal', planned_trials: 2 },
];

function trial(caseId, index) {
  const caseMetrics = {
    generation: {
      first_try: 'pass',
      criterion_review: 'approved',
      locator_policy: true,
      assertion_specificity: true,
      mutation_eligibility: 'adapter-absent',
    },
    repair: { healer_attempts: 2, classification: 'selector-drift' },
    refusal: { classification: 'product-behavior-wrong' },
  };
  return {
    case_id: caseId,
    trial_id: `trial-${caseId}-${index}`,
    complete: true,
    passed: true,
    cost_usd: 0.1,
    duration_ms: 1000,
    testgen_revision: 'revision',
    dataset_sha256: 'dataset',
    profile: {
      model: 'claude-sonnet-5',
      claude_code: '2.1.278',
      node: '24.13.0',
      npm: '11.0.0',
      playwright: '1.62.1',
      playwright_cli: '0.1.19',
      platform: 'win32',
    },
    ...caseMetrics[caseId],
  };
}

test('scores retained trials against their evaluated revision after a later commit', () => {
  const attempts = [trial('generation', 1), trial('generation', 2)];
  const revision = cohortRevision(attempts, 'later-revision');
  assert.equal(revision, 'revision');
  assert.equal(
    summarizeOutcomeTrials(definitions, attempts, 'dataset', revision)
      .testgen_revision,
    'revision',
  );
});

test('summarizes every declared attempt without turning unavailable metrics into zero', () => {
  const attempts = definitions.flatMap((definition) => [
    trial(definition.case_id, 1),
    trial(definition.case_id, 2),
  ]);
  const summary = summarizeOutcomeTrials(
    definitions,
    attempts,
    'dataset',
    'revision',
  );
  assert.equal(summary.status, 'complete');
  assert.equal(summary.planned_trials, 6);
  assert.equal(summary.completed_trials, 6);
  assert.deepEqual(summary.metrics.usable_test, { passed: 2, eligible: 2 });
  assert.deepEqual(summary.metrics.classification_correct, {
    passed: 2,
    eligible: 2,
  });
  assert.deepEqual(summary.metrics.behavior_mutation_coverage, {
    covered: 0,
    submitted: 0,
    rate: null,
  });
  assert.equal(summary.metrics.mutation_unavailable['adapter-absent'], 2);
  assert.equal(summary.metrics.cost_usd.reported, 0.6);
  assert.equal(summary.metrics.cost_usd.unavailable, 0);
  assert.equal(summary.cases.generation.attempts.length, 2);
});

test('requires the declared number of trials for every outcome case', () => {
  const attempts = [
    trial('generation', 1),
    trial('generation', 2),
    trial('generation', 3),
    trial('repair', 1),
    trial('repair', 2),
    trial('refusal', 1),
  ];
  const summary = summarizeOutcomeTrials(
    definitions,
    attempts,
    'dataset',
    'revision',
  );
  assert.equal(summary.completed_trials, 6);
  assert.equal(summary.status, 'incomplete');
});

const replacement = {
  excluded_trial_id: 'trial-repair-infra',
  replacement_trial_id: 'trial-repair-2',
  reason: 'Browser installation failed before the approved run.',
  approval_ref: 'review:cohort-browser-failure',
};

function replacementAttempts() {
  return [
    trial('generation', 1),
    trial('generation', 2),
    trial('repair', 1),
    {
      ...trial('repair', 'infra'),
      complete: false,
      passed: false,
      error: 'runner-browser-unavailable',
      classification: null,
      healer_attempts: null,
      cost_usd: 0.25,
    },
    trial('repair', 2),
    trial('refusal', 1),
    trial('refusal', 2),
  ];
}

test('counts surplus infrastructure attempts unless explicitly replaced', () => {
  const summary = summarizeOutcomeTrials(
    definitions,
    replacementAttempts(),
    'dataset',
    'revision',
  );
  assert.equal(summary.status, 'incomplete');
  assert.equal(summary.cases.repair.attempts.length, 3);
  assert.equal(summary.all_attempts?.attempted_trials, 7);
  assert.equal(summary.all_attempts.incomplete_trials, 1);
  assert.deepEqual(summary.all_attempts.cost_usd, {
    reported: 0.85,
    unavailable: 0,
    total: 0.85,
  });
  assert.deepEqual(summary.replacements, []);
});

test('selects reviewed infrastructure replacement while retaining its failure and cost', () => {
  const summary = summarizeOutcomeTrials(
    definitions,
    replacementAttempts(),
    'dataset',
    'revision',
    [replacement],
  );
  assert.equal(summary.schema_version, 'outcome-suite.v1');
  assert.equal(summary.status, 'complete');
  assert.equal(summary.completed_trials, 6);
  assert.equal(summary.cases.repair.attempts.length, 2);
  assert.deepEqual(summary.metrics.cost_usd, {
    reported: 0.6,
    unavailable: 0,
    total: 0.6,
  });
  assert.deepEqual(summary.all_attempts.cost_usd, {
    reported: 0.85,
    unavailable: 0,
    total: 0.85,
  });
  assert.equal(summary.all_attempts.completed_trials, 6);
  assert.equal(summary.all_attempts.cases.repair.attempts.length, 3);
  assert.deepEqual(summary.all_attempts.unavailable_reasons, {
    'runner-browser-unavailable': 1,
  });
  assert.equal(
    summary.replacements[0].approval_ref,
    'review:cohort-browser-failure',
  );
  assert.equal(
    summary.replacements[0].excluded_attempt.error,
    'runner-browser-unavailable',
  );
  assert.equal(summary.replacements[0].excluded_attempt.cost_usd, 0.25);
  assert.deepEqual(
    summary.metrics.classification_correct,
    summary.metrics.product_defect_refusal,
  );
});

test('rejects malformed, duplicate, cross-case, missing and stale replacement evidence', () => {
  const invalidRecords = [
    null,
    {},
    { ...replacement, reason: '' },
    { ...replacement, approval_ref: ' ' },
    { ...replacement, excluded_trial_id: 'missing' },
    { ...replacement, replacement_trial_id: 'missing' },
    { ...replacement, replacement_trial_id: 'trial-repair-infra' },
    { ...replacement, replacement_trial_id: 'trial-generation-1' },
    { ...replacement, extra: true },
  ];
  for (const record of invalidRecords)
    assert.throws(
      () =>
        summarizeOutcomeTrials(
          definitions,
          replacementAttempts(),
          'dataset',
          'revision',
          [record],
        ),
      /replacement-invalid/u,
    );
  for (const records of [{}, [replacement, replacement]])
    assert.throws(
      () =>
        summarizeOutcomeTrials(
          definitions,
          replacementAttempts(),
          'dataset',
          'revision',
          records,
        ),
      /replacement-invalid/u,
    );
  for (const trialId of ['trial-repair-infra', 'trial-repair-2'])
    assert.throws(
      () =>
        summarizeOutcomeTrials(
          definitions,
          replacementAttempts().map((attempt) =>
            attempt.trial_id === trialId
              ? { ...attempt, dataset_sha256: 'old-dataset' }
              : attempt,
          ),
          'dataset',
          'revision',
          [replacement],
        ),
      /replacement-invalid/u,
    );
});

test('refuses replacement of behavioral, approval, attribution and cleanup failures', () => {
  const failures = [
    { complete: true, passed: false },
    { error: 'trace-verdict-mismatch' },
    { error: 'candidate-approval-mismatch' },
    { error: 'failure-unattributed' },
    { cleanup_error: 'temporary-cleanup-failed' },
    { first_try: 'fail' },
    { classification: 'product-behavior-wrong' },
    { criterion_review: 'rejected' },
    { assertion_specificity: false },
    { failure_reasons: ['runner-browser-unavailable', 'failure-unattributed'] },
  ];
  for (const failure of failures)
    assert.throws(
      () =>
        summarizeOutcomeTrials(
          definitions,
          replacementAttempts().map((attempt) =>
            attempt.trial_id === 'trial-repair-infra'
              ? { ...attempt, ...failure }
              : attempt,
          ),
          'dataset',
          'revision',
          [replacement],
        ),
      /replacement-invalid/u,
    );
});

test('labels missing mutation telemetry and modeled human checkpoints explicitly', () => {
  const attempts = replacementAttempts()
    .filter((attempt) => attempt.complete)
    .map((attempt) => ({
      ...attempt,
      cost_usd: null,
      human_interventions: 1,
    }));
  const summary = summarizeOutcomeTrials(
    definitions,
    attempts,
    'dataset',
    'revision',
  );
  assert.deepEqual(summary.metrics.cost_usd, {
    reported: 0,
    unavailable: 6,
    total: null,
  });
  assert.deepEqual(summary.all_attempts?.cost_usd, {
    reported: 0,
    unavailable: 6,
    total: null,
  });
  assert.equal(summary.metrics.mutation_telemetry.status, 'unavailable');
  assert.equal(summary.metrics.mutation_telemetry.reason, 'not-collected');
  assert.deepEqual(summary.metrics.behavior_mutation_kill, {
    killed: 0,
    survived: 0,
    rate: null,
  });
  assert.deepEqual(summary.metrics.modeled_human_interventions, {
    reported: 6,
    unavailable: 0,
  });
  assert.equal(
    summary.metrics.human_interventions_basis,
    'modeled-workflow-checkpoints',
  );
});

test('keeps unknown excluded attempt cost unknown in the all-attempt total', () => {
  const summary = summarizeOutcomeTrials(
    definitions,
    replacementAttempts().map((attempt) =>
      attempt.trial_id === 'trial-repair-infra'
        ? { ...attempt, cost_usd: null }
        : attempt,
    ),
    'dataset',
    'revision',
    [replacement],
  );
  assert.deepEqual(summary.metrics.cost_usd, {
    reported: 0.6,
    unavailable: 0,
    total: 0.6,
  });
  assert.deepEqual(summary.all_attempts.cost_usd, {
    reported: 0.6,
    unavailable: 1,
    total: null,
  });
});

test('does not hide an unreasoned failed grade behind an infrastructure error', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'trial-repair-'));
  try {
    const trialId = path.basename(directory);
    writeFileSync(
      path.join(directory, 'result.json'),
      JSON.stringify({
        case_id: 'repair',
        trial_id: trialId,
        status: 'incomplete',
        error: 'runner-browser-unavailable',
        dataset_sha256: 'dataset',
        grade: { status: 'failed' },
        cleanup: { status: 'passed' },
      }),
    );
    const failed = readTrial(directory, definitions);
    assert.throws(
      () =>
        summarizeOutcomeTrials(
          definitions,
          [failed, trial('repair', 2)],
          'dataset',
          'revision',
          [{ ...replacement, excluded_trial_id: trialId }],
        ),
      /replacement-invalid/u,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('requires verified cleanup before excluding an infrastructure attempt', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'trial-repair-'));
  try {
    const trialId = path.basename(directory);
    writeFileSync(
      path.join(directory, 'result.json'),
      JSON.stringify({
        case_id: 'repair',
        trial_id: trialId,
        status: 'incomplete',
        error: 'runner-browser-unavailable',
        dataset_sha256: 'dataset',
      }),
    );
    assert.throws(
      () =>
        summarizeOutcomeTrials(
          definitions,
          [readTrial(directory, definitions), trial('repair', 2)],
          'dataset',
          'revision',
          [{ ...replacement, excluded_trial_id: trialId }],
        ),
      /replacement-invalid/u,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('replaces a Healer infrastructure failure produced with verified cleanup', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'trial-refusal-'));
  try {
    const trialId = path.basename(directory);
    const archived = combineResult(
      {
        ...evaluationFailure(new Error('runner-browser-unavailable')),
        runtime: {
          model: 'claude-sonnet-5',
          claude_code: '2.1.278',
          node: '24.13.0',
          npm: '11.0.0',
          playwright: '1.62.1',
          playwright_cli: '0.1.19',
          platform: 'win32',
          testgen_revision: 'revision',
          dataset_sha256: 'dataset',
          total_cost_usd: 0.25,
        },
      },
      { status: 'passed' },
    );
    assert.deepEqual(archived.cleanup, { status: 'passed' });
    writeFileSync(
      path.join(directory, 'result.json'),
      JSON.stringify(archived),
    );
    const failed = readTrial(directory, definitions);
    assert.equal(failed.complete, false);
    assert.deepEqual(failed.failure_reasons, ['runner-browser-unavailable']);
    const summary = summarizeOutcomeTrials(
      definitions,
      [...replacementAttempts().filter((attempt) => attempt.complete), failed],
      'dataset',
      'revision',
      [
        {
          ...replacement,
          excluded_trial_id: trialId,
          replacement_trial_id: 'trial-refusal-2',
        },
      ],
    );
    assert.equal(summary.status, 'complete');
    assert.equal(summary.all_attempts.attempted_trials, 7);
    assert.deepEqual(summary.all_attempts.cost_usd, {
      reported: 0.85,
      unavailable: 0,
      total: 0.85,
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('refuses ambiguous or mixed Healer prerequisite failures and historical missing cleanup', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'trial-refusal-'));
  try {
    const trialId = path.basename(directory);
    const fixtures = [
      { reason: 'prerequisite-unavailable' },
      { reason: 'failure-unattributed' },
      { reason: 'runner-browser-unavailable', error: 'grading-failed' },
      {
        reason: 'runner-browser-unavailable',
        cleanup: { status: 'failed', reason: 'temporary-cleanup-failed' },
      },
      { reason: 'runner-browser-unavailable', missing_cleanup: true },
    ];
    for (const fixture of fixtures) {
      const archived = combineResult(
        {
          ...evaluationFailure(new Error(fixture.reason)),
          ...(fixture.error == null ? {} : { error: fixture.error }),
          runtime: { testgen_revision: 'revision', dataset_sha256: 'dataset' },
        },
        fixture.cleanup ?? { status: 'passed' },
      );
      if (fixture.missing_cleanup) delete archived.cleanup;
      writeFileSync(
        path.join(directory, 'result.json'),
        JSON.stringify(archived),
      );
      const failed = readTrial(directory, definitions);
      assert.equal(
        summarizeOutcomeTrials(definitions, [failed], 'dataset', 'revision')
          .status,
        'incomplete',
      );
      assert.throws(
        () =>
          summarizeOutcomeTrials(
            definitions,
            [failed, trial('refusal', 2)],
            'dataset',
            'revision',
            [
              {
                ...replacement,
                excluded_trial_id: trialId,
                replacement_trial_id: 'trial-refusal-2',
              },
            ],
          ),
        /replacement-invalid/u,
      );
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('CLI selects only the requested cohort and retains incomplete attempts', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'testgen-cohort-'));
  try {
    const trialDirectory = path.join(directory, 'trial-isolated');
    mkdirSync(trialDirectory);
    writeFileSync(
      path.join(trialDirectory, 'result.json'),
      JSON.stringify({
        case_id: 'semantic-order-submit-selector-repair',
        trial_id: 'trial-isolated',
        status: 'incomplete',
        error: 'runner-browser-unavailable',
        dataset_sha256: datasetDigest(),
        cleanup: { status: 'passed' },
        cost_usd: null,
      }),
    );
    const scored = spawnSync(
      process.execPath,
      [
        path.resolve(__dirname, '../scripts/score-outcomes.cjs'),
        '--results-dir',
        directory,
      ],
      { encoding: 'utf8' },
    );
    assert.equal(scored.status, 1);
    assert.ok(scored.stdout.startsWith('{'), scored.stderr);
    const { summary } = JSON.parse(scored.stdout);
    assert.equal(summary.status, 'incomplete');
    assert.equal(summary.all_attempts.attempted_trials, 1);
    assert.equal(
      summary.cases['semantic-order-submit-selector-repair'].attempts[0]
        .trial_id,
      'trial-isolated',
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('changes dataset identity when Windows evaluation cleanup changes', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'testgen-dataset-'));
  const repository = path.resolve(__dirname, '..');
  try {
    for (const relative of [
      'evals/cases',
      'evals/seeded-bugs',
      'evals/targets/semantic-only',
      'scripts',
    ])
      cpSync(path.join(repository, relative), path.join(directory, relative), {
        recursive: true,
      });
    const copiedScorer = require(
      path.join(directory, 'scripts/score-outcomes.cjs'),
    );
    const before = copiedScorer.datasetDigest();
    assert.equal(before, datasetDigest());
    writeFileSync(
      path.join(directory, 'scripts/windows-process-tree.cjs'),
      'module.exports = { windowsProcessTree: () => null };\n',
    );
    assert.notEqual(copiedScorer.datasetDigest(), before);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('refuses incompatible comparisons and catches a green candidate with weak assertions', () => {
  const attempts = definitions.flatMap((definition) => [
    trial(definition.case_id, 1),
    trial(definition.case_id, 2),
  ]);
  const baseline = summarizeOutcomeTrials(
    definitions,
    attempts,
    'dataset',
    'revision',
  );
  baseline.thresholds = {
    usable_test: 0,
    first_try_pass: 0,
    selector_repair_success: 0,
    product_defect_refusal: 0,
    classification_correct: 0,
    locator_policy: 0,
    assertion_specificity: 0,
  };
  const degraded = summarizeOutcomeTrials(
    definitions,
    attempts.map((value) =>
      value.trial_id === 'trial-generation-2'
        ? {
            ...trial('generation', 2),
            testgen_revision: 'revision-b',
            passed: false,
            criterion_review: 'rejected',
            assertion_specificity: false,
          }
        : { ...value, testgen_revision: 'revision-b' },
    ),
    'dataset',
    'revision-b',
  );
  assert.deepEqual(degraded.metrics.first_try_pass, {
    passed: 2,
    eligible: 2,
  });
  assert.deepEqual(compareOutcomeSummaries(baseline, degraded), {
    status: 'regressed',
    regressions: ['assertion_specificity', 'case:generation', 'usable_test'],
  });
  assert.equal(
    compareOutcomeSummaries(baseline, {
      ...degraded,
      dataset_sha256: 'changed',
    }).status,
    'incompatible',
  );
  assert.equal(
    compareOutcomeSummaries(baseline, { ...degraded, status: 'incomplete' })
      .status,
    'incomplete',
  );
});

test('does not relabel historical trials with the current dataset', () => {
  const attempts = definitions.flatMap((definition) => [
    trial(definition.case_id, 1),
    trial(definition.case_id, 2),
  ]);
  const summary = summarizeOutcomeTrials(
    definitions,
    attempts,
    'changed-dataset',
    'revision',
  );
  assert.equal(summary.status, 'incomplete');
  assert.equal(summary.completed_trials, 0);
  assert.equal(summary.metrics.verification_errors, 6);
  assert.deepEqual(summary.metrics.first_try_pass, { passed: 0, eligible: 0 });
});

test('requires independent execution and criterion review for a generated candidate', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'trial-generation-'));
  try {
    const trialId = path.basename(directory);
    writeFileSync(
      path.join(directory, 'result.json'),
      JSON.stringify({
        case_id: 'generation',
        trial_id: trialId,
        status: 'checkpoint',
        dataset_sha256: 'dataset',
        candidate_sha256: 'abc',
        cleanup: { status: 'passed' },
      }),
    );
    const definition = [
      {
        ...definitions[0],
        criteria: [{ id: 'criterion' }],
        expected: { mutation: 'adapter-absent' },
      },
    ];
    assert.equal(readTrial(directory, definition).complete, false);
    writeFileSync(
      path.join(directory, 'execution.json'),
      JSON.stringify({
        trial_id: trialId,
        status: 'incomplete',
        dataset_sha256: 'dataset',
        candidate_sha256: 'abc',
        error: 'playwright-report-invalid',
        cleanup: { status: 'failed', reason: 'temporary-cleanup-failed' },
      }),
    );
    const failed = readTrial(directory, definition);
    assert.equal(failed.error, 'playwright-report-invalid');
    assert.equal(failed.cleanup_error, 'temporary-cleanup-failed');
    assert.equal(
      summarizeOutcomeTrials(definitions, [failed], 'dataset', 'revision')
        .metrics.verification_errors,
      1,
    );
    writeFileSync(
      path.join(directory, 'execution.json'),
      JSON.stringify({
        trial_id: trialId,
        status: 'complete',
        dataset_sha256: 'dataset',
        candidate_sha256: 'abc',
        first_try: 'pass',
      }),
    );
    writeFileSync(
      path.join(directory, 'review.json'),
      JSON.stringify({
        status: 'approved',
        candidate_sha256: 'wrong',
        criterion_id: 'criterion',
        reason: 'Checks the dialog contents.',
        locator_policy: true,
        assertion_specificity: true,
      }),
    );
    assert.equal(readTrial(directory, definition).complete, false);
    writeFileSync(
      path.join(directory, 'review.json'),
      JSON.stringify({
        status: 'approved',
        candidate_sha256: 'abc',
        criterion_id: 'criterion',
        reason: 'Checks the dialog contents.',
        locator_policy: true,
        assertion_specificity: true,
      }),
    );
    assert.equal(readTrial(directory, definition).complete, true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

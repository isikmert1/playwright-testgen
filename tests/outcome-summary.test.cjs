const assert = require('node:assert/strict');
const { mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  cohortRevision,
  compareOutcomeSummaries,
  readTrial,
  summarizeOutcomeTrials,
} = require('../scripts/score-outcomes.cjs');

const definitions = [
  { case_id: 'generation', kind: 'generation', planned_trials: 2 },
  { case_id: 'repair', kind: 'selector-repair', planned_trials: 2 },
  { case_id: 'refusal', kind: 'product-defect-refusal', planned_trials: 2 },
];

function trial(caseId, index, passed = true) {
  return {
    case_id: caseId,
    trial_id: `trial-${caseId}-${index}`,
    complete: true,
    passed,
    cost_usd: 0.1,
    duration_ms: 1000,
    testgen_revision: 'revision',
    profile: {
      model: 'claude-sonnet-5',
      claude_code: '2.1.278',
      node: '24.13.0',
      npm: '11.0.0',
      playwright: '1.62.1',
      playwright_cli: '0.1.19',
      platform: 'win32',
    },
    ...(caseId === 'generation'
      ? {
          first_try: passed ? 'pass' : 'fail',
          criterion_review: passed ? 'approved' : 'rejected',
          locator_policy: passed,
          assertion_specificity: passed,
          mutation_eligibility: 'adapter-absent',
        }
      : caseId === 'repair'
        ? {
            healer_attempts: 2,
            classification: passed ? 'selector-drift' : null,
          }
        : { classification: passed ? 'product-behavior-wrong' : null }),
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

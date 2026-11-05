const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { runInNewContext } = require('node:vm');
const {
  combineResult,
  evaluationFailure,
} = require('../scripts/eval/agent-evidence.cjs');
const {
  compareOutcomeSummaries,
  datasetDigest,
  readTrial,
  summarizeOutcomeTrials,
} = require('../scripts/score-outcomes.cjs');

const { scoreSelectorRepair } = require('../scripts/score-selector-repair.cjs');
const { selectorFailure } = require('../scripts/run-selector-repair-eval.cjs');

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
      host: { os_release: '10.0.26100', image: null, image_version: null },
      browsers: {
        runner: { engine: 'chromium', version: '155.0.1.0' },
        exploration: {
          engine: 'chromium',
          channel: 'chrome',
          version: '156.0.2.0',
        },
      },
      agent_limits: {
        name: 'test-agent',
        model: 'claude-sonnet-5',
        max_turns: 30,
        timeout_ms: 600000,
        max_budget_usd: 2,
      },
      ...(caseId === 'generation'
        ? {
            execution: {
              node: '24.13.0',
              npm: '11.0.0',
              playwright: '1.62.1',
              platform: 'win32',
              host: {
                os_release: '10.0.26100',
                image: null,
                image_version: null,
              },
              browser: { engine: 'chromium', version: '155.0.1.0' },
            },
          }
        : {}),
    },
    ...caseMetrics[caseId],
  };
}

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

test('public CI summary excludes private evidence and preserves runner and cleanup failures', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'testgen-ci-summary-'));
  const target = path.join(directory, 'trial-0123456789abcdef');
  mkdirSync(target);
  const revision = 'a'.repeat(40);
  const runtime = {
    ...trial('refusal', 1).profile,
    platform: 'linux',
    host: {
      os_release: '6.11.0-1018-azure',
      image: 'ubuntu24',
      image_version: '20261105.1.0',
    },
    testgen_revision: revision,
    dataset_sha256: 'b'.repeat(64),
    model_requested: 'claude-sonnet-5',
    model_resolved: 'claude-sonnet-5',
    total_cost_usd: 0.2,
    private_notes: 'PRIVATE-EVIDENCE',
  };
  const result = {
    ok: true,
    case_id: 'semantic-order-not-inserted',
    trial_id: path.basename(target),
    result: { status: 'passed', score: { status: 'passed' }, runtime },
    cleanup: { status: 'passed' },
    diagnostics: { transcript: 'PRIVATE-EVIDENCE' },
  };
  const summarize = (exitCode) => {
    writeFileSync(path.join(target, 'result.json'), JSON.stringify(result));
    return spawnSync(
      process.execPath,
      [
        path.resolve(__dirname, '../scripts/eval/public-summary.cjs'),
        directory,
        'healer-defect-refusal',
        String(exitCode),
      ],
      { encoding: 'utf8', env: { ...process.env, GITHUB_SHA: revision } },
    );
  };
  try {
    const passed = summarize(0);
    assert.equal(passed.status, 0, passed.stderr);
    const summary = JSON.parse(passed.stdout);
    assert.equal(summary.status, 'passed');
    assert.equal(summary.completed_trials, 1);
    assert.equal(summary.model_resolved, 'claude-sonnet-5');
    assert.equal(summary.browsers.exploration.version, '156.0.2.0');
    assert.doesNotMatch(
      passed.stdout,
      /PRIVATE-EVIDENCE|private_notes|diagnostics/u,
    );
    const recordedHost = runtime.host;
    const canary = 'sk-ant-api03-PRIVACY-CANARY-NOT-A-REAL-KEY';
    for (const field of Object.keys(recordedHost)) {
      runtime.host = { ...recordedHost, [field]: canary };
      const rejected = summarize(0);
      assert.ok(!rejected.stdout.includes(canary), field);
      assert.equal(rejected.status, 1, field);
      assert.equal(JSON.parse(rejected.stdout).host[field], null, field);
      assert.equal(rejected.stderr, '');
    }
    runtime.host = { ...recordedHost, image: null, image_version: null };
    assert.equal(summarize(0).status, 1);
    runtime.host = recordedHost;
    assert.equal(summarize(1).status, 1);
    result.cleanup.status = 'failed';
    const failed = summarize(0);
    assert.equal(failed.status, 1);
    assert.equal(JSON.parse(failed.stdout).status, 'failed');
    assert.equal(failed.stderr, '');
    result.cleanup.status = 'passed';
    runtime.claude_code = { private_notes: 'PRIVATE-EVIDENCE' };
    const malformed = summarize(0);
    assert.equal(malformed.status, 1);
    assert.equal(malformed.stderr, '');
    assert.equal(JSON.parse(malformed.stdout).status, 'failed');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
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
          agent_limits: {
            name: 'test-agent',
            model: 'claude-sonnet-5',
            max_turns: 30,
            timeout_ms: 600000,
            max_budget_usd: 1,
          },
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
    assert.equal(failed.profile.agent_limits?.max_budget_usd, 1);
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

test('scoring CLI fails critical integrity even for a complete cohort', () => {
  const directory = mkdtempSync(
    path.join(tmpdir(), 'testgen-critical-cohort-'),
  );
  try {
    for (const [folder, kind] of [
      ['healthy-generation', 'generation'],
      ['selector-repair', 'repair'],
      ['healer-product-defect-refusal', 'refusal'],
    ]) {
      const definition = require(`../evals/cases/${folder}/case.json`);
      for (const index of [1, 2]) {
        const attempt = trial(kind, index);
        const target = path.join(directory, attempt.trial_id);
        mkdirSync(target);
        const runtime = {
          ...attempt.profile,
          agent_limits: definition.agent,
          testgen_revision: 'a'.repeat(40),
          dataset_sha256: datasetDigest(),
        };
        const result =
          kind === 'refusal'
            ? combineResult(
                {
                  status: 'passed',
                  score: { classification: 'product-behavior-wrong' },
                  runtime,
                },
                { status: 'passed' },
              )
            : {
                ...runtime,
                case_id: definition.case_id,
                trial_id: attempt.trial_id,
                status: kind === 'generation' ? 'checkpoint' : 'complete',
                candidate_sha256: 'candidate',
                cleanup: { status: 'passed' },
                ...(kind === 'repair'
                  ? {
                      grade: {
                        status: index === 2 ? 'failed' : 'passed',
                        reason: index === 2 ? 'product-changed' : null,
                      },
                    }
                  : {}),
              };
        writeFileSync(path.join(target, 'result.json'), JSON.stringify(result));
        if (kind === 'generation') {
          writeFileSync(
            path.join(target, 'execution.json'),
            JSON.stringify({
              trial_id: attempt.trial_id,
              candidate_sha256: 'candidate',
              dataset_sha256: runtime.dataset_sha256,
              status: 'complete',
              first_try: 'pass',
              cleanup: { status: 'passed' },
              runtime: attempt.profile.execution,
            }),
          );
          writeFileSync(
            path.join(target, 'review.json'),
            JSON.stringify({
              status: 'approved',
              candidate_sha256: 'candidate',
              criterion_id: definition.criteria[0].id,
              reason: 'Checks the supplied dialog contents.',
              locator_policy: true,
              assertion_specificity: true,
            }),
          );
        }
      }
    }
    const scored = spawnSync(
      process.execPath,
      [
        path.resolve(__dirname, '../scripts/score-outcomes.cjs'),
        '--results-dir',
        directory,
      ],
      { encoding: 'utf8' },
    );
    const { summary } = JSON.parse(scored.stdout);
    assert.equal(summary.status, 'complete');
    assert.equal(summary.completed_trials, 6);
    assert.equal(scored.status, 1);
    assert.ok(
      summary.critical_failures.some((failure) =>
        failure.reasons.includes('product-changed'),
      ),
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('keeps dataset identity identical across path separator styles', () => {
  const filename = path.resolve(__dirname, '../scripts/score-outcomes.cjs');
  const source = readFileSync(filename, 'utf8');
  const digest = (style) => {
    const scorer = { exports: {} };
    const simulatedPath = {
      ...path,
      join(first, ...parts) {
        return path.isAbsolute(first)
          ? path.join(first, ...parts.map((part) => part.replaceAll('\\', '/')))
          : style.join(first, ...parts);
      },
    };
    runInNewContext(source, {
      __dirname: path.dirname(filename),
      require: (name) => (name === 'node:path' ? simulatedPath : require(name)),
      module: scorer,
    });
    return scorer.exports.datasetDigest();
  };
  assert.equal(digest(path.win32), digest(path.posix));
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
  assert.equal(baseline.profiles.refusal.agent_limits?.max_budget_usd, 2);
  const missingBrowser = attempts.map((value) => ({
    ...value,
    profile: { ...value.profile, browsers: {} },
  }));
  assert.equal(
    summarizeOutcomeTrials(definitions, missingBrowser, 'dataset', 'revision')
      .status,
    'incomplete',
  );
  const changedBrowser = attempts.map((value) => ({
    ...value,
    profile: {
      ...value.profile,
      browsers: {
        ...value.profile.browsers,
        exploration: {
          ...value.profile.browsers.exploration,
          version: '157.0.0.0',
        },
      },
    },
  }));
  assert.equal(
    compareOutcomeSummaries(
      baseline,
      summarizeOutcomeTrials(
        definitions,
        changedBrowser,
        'dataset',
        'revision',
      ),
    ).status,
    'incompatible',
  );
  const changedLimits = attempts.map((value) => ({
    ...value,
    profile: {
      ...value.profile,
      agent_limits: { ...value.profile.agent_limits, max_budget_usd: 1 },
    },
  }));
  assert.equal(
    compareOutcomeSummaries(
      baseline,
      summarizeOutcomeTrials(definitions, changedLimits, 'dataset', 'revision'),
    ).status,
    'incompatible',
  );
  const changedExecution = attempts.map((value) =>
    value.case_id === 'generation'
      ? {
          ...value,
          profile: {
            ...value.profile,
            execution: { ...value.profile.execution, node: '22.14.0' },
          },
        }
      : value,
  );
  assert.equal(
    compareOutcomeSummaries(
      baseline,
      summarizeOutcomeTrials(
        definitions,
        changedExecution,
        'dataset',
        'revision',
      ),
    ).status,
    'incompatible',
  );
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
      critical_failures: [
        { trial_id: 'trial-repair-1', reasons: ['product-changed'] },
      ],
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
        runtime: trial('generation', 1).profile,
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
    assert.deepEqual(
      readTrial(directory, definition).profile.browsers,
      trial('generation', 1).profile.browsers,
    );
    assert.deepEqual(
      readTrial(directory, definition).profile.host,
      trial('generation', 1).profile.host,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

function repairEvidence(overrides = {}) {
  return {
    baseline: 'pass',
    variant_precheck: 'fail',
    selector_failure: true,
    trace_valid: true,
    trace: {
      final_classification: 'selector-drift',
      disposition: 'fixed',
      attempts: [{}, {}],
      repairs: [{ paths: ['tests/order.spec.ts'] }],
    },
    spec_path: 'tests/order.spec.ts',
    before: {
      expected_spec: 'allowed-spec',
      product: 'variant-product',
      repository_state: 'public/index.html modified',
    },
    after: {
      spec: 'allowed-spec',
      product: 'variant-product',
      repository_state: 'public/index.html modified',
    },
    final_run: 'pass',
    tool_uses: [{ id: 'tool-1', name: 'Bash' }],
    tool_results: [
      {
        tool_use_id: 'tool-1',
        is_error: true,
        execution: 'playwright-one-test-failed',
      },
    ],
    hook_audit: [
      {
        schema_version: 'testgen-hook-audit.v1',
        agent_type: 'playwright-test-healer',
        hook_event: 'PreToolUse',
        tool_name: 'Bash',
        tool_use_id: 'tool-1',
        decision: 'allow',
        operation: 'approved-spec-run',
        hook_sha256: 'a'.repeat(64),
      },
    ],
    installed_hook_sha256: 'a'.repeat(64),
    ...overrides,
  };
}

test('accepts an independently verified selector repair', () => {
  assert.deepEqual(scoreSelectorRepair(repairEvidence()), {
    status: 'passed',
    classification: 'selector-drift',
    healer_attempts: 2,
    assertions_unchanged: true,
  });
});

test('rejects weakened assertions, product changes, and ungoverned failures', () => {
  for (const changed of [
    { after: { ...repairEvidence().after, spec: 'weakened-assertions' } },
    { after: { ...repairEvidence().after, product: 'changed-product' } },
    {
      after: {
        spec: 'allowed-spec',
        product: 'variant-product',
        repository_state: 'unexpected file added',
      },
    },
    { hook_audit: [] },
    { final_run: 'fail' },
  ]) {
    assert.throws(() => scoreSelectorRepair(repairEvidence(changed)));
  }
});

test('recognizes the exact controlled selector failure', () => {
  const report = {
    suites: [
      {
        specs: [
          {
            tests: [
              {
                results: [
                  {
                    error: {
                      message:
                        "locator.click: Timed out waiting for getByRole('button', { name: 'Add order' })",
                    },
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
  assert.equal(selectorFailure(report), true);
  assert.equal(selectorFailure({ suites: [{ suites: report.suites }] }), true);
  report.suites[0].specs[0].tests[0].results[0].error.message =
    'expect.toHaveCount failed in an unrelated row';
  assert.equal(selectorFailure(report), false);
});

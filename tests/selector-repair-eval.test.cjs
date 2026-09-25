const assert = require('node:assert/strict');
const test = require('node:test');
const { scoreSelectorRepair } = require('../scripts/score-selector-repair.cjs');
const {
  assertionBlock,
  selectorFailure,
} = require('../scripts/run-selector-repair-eval.cjs');

function evidence(overrides = {}) {
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
      assertions: 'assertions',
      product: 'variant-product',
      repository_state: 'public/index.html modified',
    },
    after: {
      assertions: 'assertions',
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
  assert.deepEqual(scoreSelectorRepair(evidence()), {
    status: 'passed',
    classification: 'selector-drift',
    healer_attempts: 2,
    assertions_unchanged: true,
  });
});

test('rejects weakened assertions, product changes, and ungoverned failures', () => {
  for (const changed of [
    { after: { assertions: 'weakened', product: 'variant-product' } },
    { after: { assertions: 'assertions', product: 'changed-product' } },
    {
      after: {
        assertions: 'assertions',
        product: 'variant-product',
        repository_state: 'unexpected file added',
      },
    },
    { hook_audit: [] },
    { final_run: 'fail' },
  ]) {
    assert.throws(() => scoreSelectorRepair(evidence(changed)));
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

test('isolates the intended assertion block from locator-only repairs', () => {
  const before =
    "getByRole('button', { name: 'Add order' });\nawait test.step('Submitted order appears once with its quantity and Pending status', async () => { await expect(row).toHaveCount(1); });";
  const after = before.replace('Add order', 'Create order');
  assert.equal(assertionBlock(before), assertionBlock(after));
});

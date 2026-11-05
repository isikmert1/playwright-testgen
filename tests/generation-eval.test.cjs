const assert = require('node:assert/strict');
const { existsSync, mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  authorExecutionAttempts,
  authorProfileAccessAttempts,
} = require('../scripts/run-generation-eval.cjs');
const {
  scorePlaywrightReport,
} = require('../scripts/run-generation-candidate.cjs');
const { cleanupEvaluation } = require('../scripts/eval/runtime.cjs');

test('generation evidence rejects spec execution but allows collection', () => {
  const stream = (command) =>
    JSON.stringify({
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', name: 'Bash', input: { command } }],
      },
    });

  assert.equal(
    authorExecutionAttempts(
      stream('npx --no playwright test tests/notebook-details.spec.ts --list'),
    ),
    0,
  );
  assert.equal(
    authorExecutionAttempts(
      stream('npx --no playwright test tests/notebook-details.spec.ts'),
    ),
    1,
  );
  assert.equal(authorExecutionAttempts(stream('npm run test:e2e')), 1);
  assert.equal(
    authorExecutionAttempts(
      stream('npx playwright test tests/notebook-details.spec.ts').replace(
        '"name":"Bash"',
        '"name":"PowerShell"',
      ),
    ),
    1,
  );
  assert.equal(
    authorProfileAccessAttempts(
      stream('cat .playwright-testgen/profile.v1.json'),
    ),
    1,
  );
});

test('generation cleanup removes only its owned temporary directory', async (t) => {
  const temporaryRoot = mkdtempSync(
    path.join(tmpdir(), 'testgen-generation-evaluation-'),
  );
  t.after(() => rmSync(temporaryRoot, { force: true, recursive: true }));
  const state = {
    marketplace_added: false,
    plugin_installed: false,
    repository: null,
    server: null,
    temporaryRoot,
    temporaryPrefix: 'testgen-generation-evaluation-',
  };
  const refused = await cleanupEvaluation({
    ...state,
    temporaryPrefix: 'another-evaluator-',
  });
  assert.equal(refused.status, 'failed');
  assert.equal(existsSync(temporaryRoot), true);
  const cleanup = await cleanupEvaluation(state);

  assert.equal(cleanup.status, 'passed');
  assert.equal(existsSync(temporaryRoot), false);
});

function report(status) {
  return {
    errors: [],
    stats: {
      expected: status === 'passed' ? 1 : 0,
      unexpected: status === 'failed' ? 1 : 0,
      skipped: 0,
      flaky: 0,
    },
    suites: [
      {
        specs: [
          {
            tests: [
              {
                status: status === 'passed' ? 'expected' : 'unexpected',
                results: [{ status }],
              },
            ],
          },
        ],
      },
    ],
  };
}

test('candidate grader distinguishes a passing spec from an assertion failure', () => {
  assert.equal(scorePlaywrightReport(report('passed')), 'pass');
  assert.equal(scorePlaywrightReport(report('failed')), 'fail');
  assert.equal(
    scorePlaywrightReport({ ...report('passed'), errors: [{}] }),
    'error',
  );
  assert.equal(
    scorePlaywrightReport({ ...report('passed'), stats: { expected: 2 } }),
    'error',
  );
});

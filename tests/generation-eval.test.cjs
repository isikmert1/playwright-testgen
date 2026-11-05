const assert = require('node:assert/strict');
const {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} = require('node:fs');
const { setTimeout: delay } = require('node:timers/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  authorExecutionAttempts,
  authorProfileAccessAttempts,
} = require('../scripts/eval/agent-evidence.cjs');
const {
  scorePlaywrightReport,
  verifyBrowserReadiness,
} = require('../scripts/eval/runtime.cjs');
const { cleanupEvaluation } = require('../scripts/eval/runtime.cjs');

test('generation evidence rejects spec execution but allows collection', () => {
  const stream = (command) =>
    JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            id: 'command-1',
            name: 'Bash',
            input: { command },
          },
        ],
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
  for (const command of [
    'node "node_modules/@playwright/test/cli.js" "test" tests/notebook-details.spec.ts',
    'node node_modules/@playwright/test/cli.js test --list\nnode node_modules/@playwright/test/cli.js test tests/notebook-details.spec.ts',
    'npx playwright test -- --list',
  ])
    assert.equal(authorExecutionAttempts(stream(command)), 1);
  assert.equal(
    authorExecutionAttempts(
      stream(
        'node "node_modules/@playwright/test/cli.js" test tests/notebook-details.spec.ts',
      ),
    ),
    1,
  );
  assert.equal(
    authorExecutionAttempts(
      stream(
        'node node_modules/playwright/cli.js test --list && node node_modules/playwright/cli.js test tests/notebook-details.spec.ts',
      ),
    ),
    1,
  );
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

test('cancelled browser preflight closes its partially opened session', async (t) => {
  const repository = mkdtempSync(path.join(tmpdir(), 'testgen-preflight-'));
  t.after(() => rmSync(repository, { recursive: true, force: true }));
  const browserModule = path.join(repository, 'node_modules', 'playwright');
  mkdirSync(browserModule, { recursive: true });
  writeFileSync(
    path.join(browserModule, 'index.js'),
    'exports.chromium = { launch: async () => ({ close: async () => {} }) };',
  );
  const cli = path.join(repository, 'cli.cjs');
  writeFileSync(
    cli,
    `
    const fs = require('node:fs');
    if (process.argv.includes('open')) {
      fs.writeFileSync('session-open', process.argv[2]);
      setInterval(() => {}, 1000);
    } else {
      if (fs.readFileSync('session-open', 'utf8') !== process.argv[2]) process.exit(1);
      fs.unlinkSync('session-open');
    }
  `,
  );
  const controller = new AbortController();
  t.after(() => controller.abort());
  const resource = path.join(repository, 'cli-preflight', 'session-open');
  const outcome = verifyBrowserReadiness(
    { playwright_cli: cli },
    repository,
    'http://localhost:4173',
    repository,
    controller.signal,
  );
  const rejected = assert.rejects(outcome, /cli-browser-unavailable/u);
  const deadline = Date.now() + 15_000;
  while (!existsSync(resource) && Date.now() < deadline) await delay(20);
  assert.equal(existsSync(resource), true);
  controller.abort();
  await rejected;
  assert.equal(existsSync(resource), false);
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

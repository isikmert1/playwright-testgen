const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} = require('node:fs');
const { setTimeout: delay } = require('node:timers/promises');
const { EventEmitter } = require('node:events');
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

function freshModule(t, filename) {
  const resolved = require.resolve(filename);
  const previous = require.cache[resolved];
  delete require.cache[resolved];
  t.after(() => {
    if (previous == null) delete require.cache[resolved];
    else require.cache[resolved] = previous;
  });
  return require(resolved);
}

test('cancelled startup rejects late readiness and handles late spawn errors', async (t) => {
  const child = new EventEmitter();
  const stopping = Promise.withResolvers();
  t.mock.method(require('node:child_process'), 'fork', () => child);
  t.mock.method(
    require('../scripts/process.cjs'),
    'stopProcessTree',
    () => stopping.promise,
  );
  const { startServer } = freshModule(t, '../scripts/eval/runtime.cjs');
  const origin = 'http://127.0.0.1:4173';
  const state = { repository: __dirname };
  const controller = new AbortController();
  const pending = startServer(state, origin, controller.signal);
  controller.abort();
  child.emit('message', { type: 'ready', origin });
  stopping.resolve(true);
  await assert.rejects(pending, { code: 'evaluation-cancelled' });
  assert.equal(state.server, null);
  assert.doesNotThrow(() =>
    child.emit('error', new Error('late-spawn-failure')),
  );
});

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

test('browser readiness records actual browser identities and closes both browsers', async (t) => {
  const repository = mkdtempSync(
    path.join(tmpdir(), 'testgen-browser-identity-'),
  );
  t.after(() => rmSync(repository, { recursive: true, force: true }));
  const browserModule = path.join(repository, 'node_modules', 'playwright');
  mkdirSync(browserModule, { recursive: true });
  writeFileSync(
    path.join(browserModule, 'index.js'),
    `exports.chromium = { launch: async () => ({
      browserType: () => ({ name: () => 'chromium' }),
      version: () => '155.0.1.0',
      close: async () => require('node:fs').writeFileSync('runner-closed', '')
    }) };`,
  );
  const cli = path.join(repository, 'cli.cjs');
  writeFileSync(
    cli,
    `const fs = require('node:fs');
    const session = process.argv[2].slice(3);
    if (process.argv.includes('open')) fs.writeFileSync('session-open', session);
    else if (process.argv.includes('run-code')) console.log(JSON.stringify({result: JSON.stringify({engine:'chromium',version:'156.0.2.0'})}));
    else if (process.argv.includes('list')) console.log(JSON.stringify({browsers:[{name:session,browserType:'chrome'}]}));
    else fs.unlinkSync('session-open');`,
  );
  const identities = await verifyBrowserReadiness(
    { playwright_cli: cli },
    repository,
    'http://localhost:4173',
    repository,
  );
  assert.deepEqual(identities, {
    runner: { engine: 'chromium', version: '155.0.1.0' },
    exploration: {
      engine: 'chromium',
      channel: 'chrome',
      version: '156.0.2.0',
    },
  });
  assert.equal(existsSync(path.join(repository, 'runner-closed')), true);
  assert.equal(
    existsSync(path.join(repository, 'cli-preflight', 'session-open')),
    false,
  );
});

test('cancelled browser preflight closes its partially opened session', async (t) => {
  const repository = mkdtempSync(path.join(tmpdir(), 'testgen-preflight-'));
  t.after(() => rmSync(repository, { recursive: true, force: true }));
  const browserModule = path.join(repository, 'node_modules', 'playwright');
  mkdirSync(browserModule, { recursive: true });
  writeFileSync(
    path.join(browserModule, 'index.js'),
    "exports.chromium = { launch: async () => ({ browserType: () => ({ name: () => 'chromium' }), version: () => '155.0.1.0', close: async () => {} }) };",
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
  const rejected = assert.rejects(outcome, (error) => {
    assert.match(
      error.message,
      /cli-browser-unavailable/u,
      JSON.stringify(error.details),
    );
    return true;
  });
  const deadline = Date.now() + 15_000;
  while (!existsSync(resource) && Date.now() < deadline) await delay(20);
  assert.equal(existsSync(resource), true);
  controller.abort();
  await rejected;
  assert.equal(existsSync(resource), false);
});

test('cleanup removes only owned scratch after resources are released', async (t) => {
  const temporaryRoot = mkdtempSync(
    path.join(tmpdir(), 'testgen-generation-evaluation-'),
  );
  t.after(() => rmSync(temporaryRoot, { force: true, recursive: true }));
  let stopped = false;
  let uninstalls = 0;
  t.mock.method(
    require('../scripts/process.cjs'),
    'executable',
    (name) => name,
  );
  t.mock.method(
    require('../scripts/process.cjs'),
    'stopProcessTree',
    async () => stopped,
  );
  t.mock.method(
    require('../scripts/process.cjs'),
    'command',
    async (_name, args) => {
      if (args[1] === 'uninstall') uninstalls += 1;
      else if (!stopped) throw new Error('marketplace-cleanup-failed');
      return '';
    },
  );
  const { cleanupEvaluation } = freshModule(t, '../scripts/eval/runtime.cjs');
  const state = {
    server: { pid: 12345 },
    repository: temporaryRoot,
    plugin_installed: true,
    plugin_id: 'fixture-plugin',
    marketplace_added: true,
    marketplace_name: 'fixture-marketplace',
    temporaryRoot,
    temporaryPrefix: 'testgen-generation-evaluation-',
  };
  const refused = await cleanupEvaluation({
    temporaryRoot,
    temporaryPrefix: 'another-evaluator-',
  });
  assert.equal(refused.status, 'failed');
  assert.equal(existsSync(temporaryRoot), true);
  const failed = await cleanupEvaluation(state);
  assert.equal(failed.status, 'failed');
  assert.equal(existsSync(temporaryRoot), true);
  assert.equal(failed.temporary_root, temporaryRoot);
  assert.equal(failed.server_pid, state.server.pid);
  stopped = true;
  assert.equal((await cleanupEvaluation(state)).status, 'passed');
  assert.equal(uninstalls, 1);
  assert.equal(existsSync(temporaryRoot), false);
});

function candidateFixture(t, command) {
  const resultsRoot = mkdtempSync(
    path.join(tmpdir(), 'testgen-candidate-test-'),
  );
  t.after(() => rmSync(resultsRoot, { recursive: true, force: true }));
  const definition = require('../evals/cases/healthy-generation/case.json');
  const trialId = 'trial-0123456789abcdef';
  const runId = 'tg-' + 'a'.repeat(24);
  const directory = path.join(resultsRoot, trialId);
  mkdirSync(directory);
  const spec = 'candidate bytes';
  const digest = createHash('sha256').update(spec).digest('hex');
  writeFileSync(
    path.join(directory, path.basename(definition.spec_path)),
    spec,
  );
  writeFileSync(
    path.join(directory, 'handoff.json'),
    JSON.stringify({ run_id: runId, spec_path: definition.spec_path }),
  );
  writeFileSync(
    path.join(directory, 'result.json'),
    JSON.stringify({
      case_id: definition.case_id,
      trial_id: trialId,
      status: 'checkpoint',
      cleanup: { status: 'passed' },
      dataset_sha256: 'dataset',
      candidate_executed: false,
      run_id: runId,
      candidate_sha256: digest,
    }),
  );
  t.mock.method(require('../scripts/process.cjs'), 'command', command);
  const previousNpm = process.env.npm_execpath;
  process.env.npm_execpath = __filename;
  t.after(() => {
    if (previousNpm == null) delete process.env.npm_execpath;
    else process.env.npm_execpath = previousNpm;
  });
  const { executeCandidate } = freshModule(
    t,
    '../scripts/run-generation-candidate.cjs',
  );
  const options = { resultsRoot, datasetDigest: () => 'dataset' };
  const approval = { trialId, digest };
  return {
    run: () => executeCandidate(approval, undefined, options),
    directory,
  };
}

test('candidate execution reserves one running record before any concurrent start', async (t) => {
  const gate = Promise.withResolvers();
  const { run, directory } = candidateFixture(t, async () => {
    await gate.promise;
    throw new Error('synthetic-stop');
  });
  const attempts = Promise.allSettled([run(), run()]);
  let results;
  try {
    const running = JSON.parse(
      readFileSync(path.join(directory, 'execution.json'), 'utf8'),
    );
    assert.equal(running.status, 'running');
  } finally {
    gate.resolve();
    results = await attempts;
  }
  assert.deepEqual(
    results.map((result) => result.status),
    ['fulfilled', 'rejected'],
  );
  assert.equal(results[1].reason.message, 'candidate-approval-mismatch');
});

test('failed execution finalization preserves its valid running reservation', async (t) => {
  const fs = require('node:fs');
  const originalWrite = fs.writeFileSync;
  let writes = 0;
  t.mock.method(fs, 'writeFileSync', (filename, content, options) => {
    if (
      path.basename(filename).startsWith('execution.json') &&
      ++writes === 2
    ) {
      originalWrite(filename, '{', options);
      throw new Error('simulated-disk-write-failure');
    }
    return originalWrite(filename, content, options);
  });
  const { run, directory } = candidateFixture(t, async () => {
    throw new Error('synthetic-stop');
  });
  await assert.rejects(run(), /simulated-disk-write-failure/u);
  const retained = JSON.parse(
    readFileSync(path.join(directory, 'execution.json'), 'utf8'),
  );
  assert.equal(retained.status, 'running');
});

test('unverified command cleanup retains its target and recovery PID', async (t) => {
  const { run } = candidateFixture(t, async () => {
    require('../scripts/process.cjs').assertProcessStopped({
      tree_cleanup_failed: true,
      tree_cleanup_reason: 'snapshot-unavailable',
      tree_cleanup_pid: 12345,
    });
  });
  const result = await run();
  const retained = result.cleanup.temporary_root;
  if (retained != null)
    t.after(() => {
      assert.equal(path.dirname(retained), path.resolve(tmpdir()));
      assert.ok(
        path.basename(retained).startsWith('testgen-candidate-evaluation-'),
      );
      rmSync(retained, { recursive: true, force: true });
    });
  assert.equal(result.error, 'process-tree-cleanup-failed');
  assert.equal(result.cleanup.status, 'failed');
  assert.equal(result.cleanup.process_pid, 12345);
  assert.equal(existsSync(retained), true);
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

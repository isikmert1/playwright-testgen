const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  classifyReport,
  withSeededDatabase,
} = require('../evals/targets/cypress-realworld-app/adapter/.testgen/mutation-runner.cjs');

const repositoryRoot = path.resolve(__dirname, '..');
const targetsRoot = path.join(repositoryRoot, 'evals', 'targets');

function readJson(filename) {
  return JSON.parse(readFileSync(filename, 'utf8'));
}

test('agent-visible target metadata does not reveal setup or seeded-bug answers', () => {
  const source = path.join(targetsRoot, 'semantic-only', 'repository');
  const visible = [
    readFileSync(path.join(source, 'README.md'), 'utf8'),
    readFileSync(path.join(source, 'package.json'), 'utf8'),
    readFileSync(path.join(source, 'package-lock.json'), 'utf8'),
  ].join('\n');
  assert.doesNotMatch(
    visible,
    /no existing tests|no test[- ]ids?|without test[- ]ids?|semantic.only.target|rename-order-submit|skip-order-insert|selector drift|product.behavior failure/iu,
  );
});

test('selector-drift variant renames a control without changing behavior', (t) => {
  const temporaryRoot = mkdtempSync(path.join(tmpdir(), 'testgen-variant-'));
  const targetRoot = path.join(temporaryRoot, 'target');
  cpSync(path.join(targetsRoot, 'semantic-only', 'repository'), targetRoot, {
    recursive: true,
  });
  t.after(() => rmSync(temporaryRoot, { force: true, recursive: true }));

  const pagePath = path.join(targetRoot, 'public', 'index.html');
  const original = readFileSync(pagePath, 'utf8');
  const patchPath = path.join(
    targetRoot,
    '.testgen',
    'variants',
    'rename-order-submit.patch',
  );
  const applied = spawnSync('git', ['apply', '--', patchPath], {
    cwd: targetRoot,
    encoding: 'utf8',
    windowsHide: true,
  });

  assert.equal(applied.status, 0, applied.stderr);
  const changed = readFileSync(pagePath, 'utf8');
  assert.match(changed, /<button type="submit">Create order<\/button>/u);
  assert.match(changed, /<form id="order-form">/u);
  assert.match(changed, /<script src="\/app\.js"><\/script>/u);

  const reverted = spawnSync('git', ['apply', '--reverse', '--', patchPath], {
    cwd: targetRoot,
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.equal(reverted.status, 0, reverted.stderr);
  assert.equal(
    readFileSync(pagePath, 'utf8').replaceAll('\r\n', '\n'),
    original.replaceAll('\r\n', '\n'),
  );
});

test('semantic-only adapter and seeded bug share one approved mutation definition', () => {
  const targetRoot = path.join(targetsRoot, 'semantic-only', 'repository');
  const adapterPath = path.join(
    targetRoot,
    '.testgen',
    'mutation-adapter.json',
  );
  const adapter = readJson(adapterPath);
  const mutation = adapter.mutations[0];
  const seededBug = readJson(
    path.join(
      repositoryRoot,
      'evals',
      'seeded-bugs',
      'semantic-only',
      'skip-order-insert.json',
    ),
  );
  const digest = spawnSync(
    process.execPath,
    [
      path.join(repositoryRoot, 'scripts', 'mutation-check.cjs'),
      'digest',
      '--repo',
      targetRoot,
      '--adapter',
      '.testgen/mutation-adapter.json',
      '--mutation-id',
      mutation.mutation_id,
    ],
    { encoding: 'utf8' },
  );

  assert.equal(digest.status, 0, digest.stderr);
  const { ok, operation, ...computed } = JSON.parse(digest.stdout);
  assert.equal(ok, true);
  assert.equal(operation, 'digest');
  assert.deepEqual(
    {
      adapter_id: adapter.adapter_id,
      mutation_id: mutation.mutation_id,
      criterion_id: mutation.criterion_id,
      definition_digest: mutation.definition_digest,
    },
    computed,
  );
  assert.equal(seededBug.target_id, 'semantic-only');
  assert.equal(seededBug.mutation_id, mutation.mutation_id);
  assert.equal(seededBug.criterion_id, mutation.criterion_id);
  assert.equal(seededBug.definition_digest, mutation.definition_digest);
  assert.equal(seededBug.expected_classification, 'product-behavior-wrong');
  assert.equal(
    realpathSync(path.join(repositoryRoot, seededBug.patch_path)),
    realpathSync(path.join(targetRoot, mutation.patch_path)),
  );
});

test('mutation runner translates isolated Playwright results and removes its link', (t) => {
  const temporaryRoot = mkdtempSync(
    path.join(tmpdir(), 'testgen-target-runner-'),
  );
  const targetRoot = path.join(temporaryRoot, 'target');
  const nodeModules = path.join(temporaryRoot, 'node_modules');
  const filterPath = path.join(temporaryRoot, 'filter.txt');
  cpSync(path.join(targetsRoot, 'semantic-only', 'repository'), targetRoot, {
    recursive: true,
  });
  mkdirSync(path.join(targetRoot, 'tests'));
  writeFileSync(
    path.join(targetRoot, 'tests', 'order.spec.js'),
    '// approved\n',
  );
  const testPackage = path.join(nodeModules, '@playwright', 'test');
  mkdirSync(testPackage, { recursive: true });
  writeFileSync(
    path.join(testPackage, 'package.json'),
    JSON.stringify({ bin: { playwright: 'cli.js' } }),
  );
  writeFileSync(
    path.join(testPackage, 'cli.js'),
    [
      "const {writeFileSync}=require('node:fs');",
      "const path=require('node:path');",
      'writeFileSync(process.env.TESTGEN_FILTER_PATH,process.argv[3]);',
      'fetch(`${process.env.TESTGEN_BASE_URL}/app.js`).then((response)=>response.text()).then((source)=>{',
      "const failed=!source.includes('orders.push(order);');",
      "const file='tests/order.spec.js';",
      'const location={file:path.resolve(file),line:108,column:1};',
      "const error={message:'assertion failed',stack:`Error: assertion failed\\n    at ${location.file}:108:1\\n    at approvedStep (${location.file}:106:1)`};",
      "const result=failed?{status:'failed',errors:[{...error,location}],steps:[{title:'verify the submitted order details',error}]}:{status:'passed',errors:[]};",
      "const report={errors:[],stats:{expected:failed?0:1,unexpected:failed?1:0},suites:[{title:file,file,specs:[{title:'order',file,line:1,column:1,tests:[{status:failed?'unexpected':'expected',results:[result]}]}]}]};",
      'writeFileSync(process.env.PLAYWRIGHT_JSON_OUTPUT_FILE,JSON.stringify(report));',
      'process.exitCode=failed?1:0;',
      '});',
      '',
    ].join('\n'),
  );
  t.after(() => rmSync(temporaryRoot, { force: true, recursive: true }));

  const run = (phase) =>
    spawnSync(
      process.execPath,
      [
        path.join(targetRoot, '.testgen', 'mutation-runner.cjs'),
        '--phase',
        phase,
        '--spec',
        'tests/order.spec.js',
        '--criterion-id',
        'order-appears-in-table',
        '--step-title',
        'verify the submitted order details',
      ],
      {
        cwd: targetRoot,
        encoding: 'utf8',
        env: {
          ...process.env,
          TESTGEN_FILTER_PATH: filterPath,
          TESTGEN_TARGET_NODE_MODULES: nodeModules,
        },
        timeout: 10_000,
        windowsHide: true,
      },
    );

  const baseline = run('baseline');
  assert.equal(baseline.status, 0, baseline.stderr);
  assert.deepEqual(JSON.parse(baseline.stdout), {
    protocol_version: 1,
    outcome: 'pass',
    criterion_id: null,
  });
  const escapedSpec = path
    .resolve(targetRoot, 'tests/order.spec.js')
    .replaceAll('\\', '/')
    .replace(/[\\^$.*+?()[\]{}|/]/gu, '\\$&');
  assert.equal(
    readFileSync(filterPath, 'utf8'),
    `/^${escapedSpec}$/${process.platform === 'win32' ? 'i' : ''}`,
  );
  assert.equal(existsSync(path.join(targetRoot, 'node_modules')), false);

  const appPath = path.join(targetRoot, 'public', 'app.js');
  writeFileSync(
    appPath,
    readFileSync(appPath, 'utf8').replace('  orders.push(order);\n', ''),
  );
  const mutant = run('mutant');
  assert.equal(mutant.status, 0, mutant.stderr);
  assert.deepEqual(JSON.parse(mutant.stdout), {
    protocol_version: 1,
    outcome: 'fail',
    criterion_id: 'order-appears-in-table',
  });
  assert.equal(existsSync(path.join(targetRoot, 'node_modules')), false);

  writeFileSync(
    path.join(testPackage, 'cli.js'),
    [
      "const {writeFileSync}=require('node:fs');",
      "const path=require('node:path');",
      "const file='tests/order.spec.js';",
      "const report={errors:[],stats:{expected:0,unexpected:1},suites:[{title:file,file,specs:[{title:'order',file,line:1,column:1,tests:[{status:'unexpected',results:[{status:'failed',errors:[{message:'assertion failed'}],steps:[{title:'verify another outcome',error:{message:'assertion failed'}}]}]}]}]}]};",
      'writeFileSync(process.env.PLAYWRIGHT_JSON_OUTPUT_FILE,JSON.stringify(report));',
      'process.exitCode=1;',
      '',
    ].join('\n'),
  );
  const unrelated = run('mutant');
  assert.equal(unrelated.status, 0, unrelated.stderr);
  assert.deepEqual(JSON.parse(unrelated.stdout), {
    protocol_version: 1,
    outcome: 'error',
    criterion_id: null,
    reason: 'failure-unattributed',
  });
});

test('mutation runner stops its server after an invalid startup handshake', (t) => {
  const temporaryRoot = mkdtempSync(
    path.join(tmpdir(), 'testgen-runner-stop-'),
  );
  const targetRoot = path.join(temporaryRoot, 'target');
  const nodeModules = path.join(temporaryRoot, 'node_modules');
  const pidFile = path.join(temporaryRoot, 'server.pid');
  cpSync(path.join(targetsRoot, 'semantic-only', 'repository'), targetRoot, {
    recursive: true,
  });
  mkdirSync(path.join(targetRoot, 'tests'));
  writeFileSync(
    path.join(targetRoot, 'tests', 'order.spec.js'),
    '// approved\n',
  );
  mkdirSync(nodeModules);
  writeFileSync(
    path.join(targetRoot, 'server.cjs'),
    [
      "const {writeFileSync}=require('node:fs');",
      'writeFileSync(process.env.TESTGEN_PID_FILE,String(process.pid));',
      "process.send({type:'invalid'});",
      'setInterval(()=>{},1000);',
      '',
    ].join('\n'),
  );
  t.after(() => {
    if (existsSync(pidFile)) {
      try {
        process.kill(Number(readFileSync(pidFile, 'utf8')));
      } catch {
        // The runner normally stops this process before the test returns.
      }
    }
    rmSync(temporaryRoot, { force: true, recursive: true });
  });

  const result = spawnSync(
    process.execPath,
    [
      path.join(targetRoot, '.testgen', 'mutation-runner.cjs'),
      '--phase',
      'baseline',
      '--spec',
      'tests/order.spec.js',
      '--criterion-id',
      'order-appears-in-table',
      '--step-title',
      'verify the submitted order details',
    ],
    {
      cwd: targetRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        TESTGEN_TARGET_NODE_MODULES: nodeModules,
        TESTGEN_PID_FILE: pidFile,
      },
      timeout: 2_000,
      windowsHide: true,
    },
  );

  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    protocol_version: 1,
    outcome: 'error',
    criterion_id: null,
    reason: 'server-unavailable',
  });
  assert.throws(() => process.kill(Number(readFileSync(pidFile, 'utf8')), 0));
});

const stepTitle =
  'Clearing Username shows its required error and disables Sign In';
const rwaRunner = path.resolve(
  __dirname,
  '../evals/targets/cypress-realworld-app/adapter/.testgen/mutation-runner.cjs',
);

function report(status, steps, errors = []) {
  return {
    stats: {
      expected: status === 'expected' ? 1 : 0,
      unexpected: status === 'unexpected' ? 1 : 0,
    },
    errors,
    suites: [
      {
        specs: [
          {
            tests: [
              {
                status,
                results: [
                  {
                    status: status === 'expected' ? 'passed' : 'failed',
                    steps,
                    errors: [],
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
}

test('attributes only terminal failures from the approved step', () => {
  // Extracted from Playwright 1.62.1 JSON reports; local paths were shortened.
  const assertion = 'Error: expect(received).toBe(expected)';
  const location = {
    file: 'tests/playwright/probe.spec.cjs',
    line: 7,
    column: 65,
  };
  const step = {
    title: stepTitle,
    error: {
      message: assertion,
      stack: `${assertion}\n    at ${location.file}:${location.line}:${location.column}\n    at ${location.file}:8:3`,
    },
  };
  const genuine = report('unexpected', [step]);
  genuine.suites[0].specs[0].tests[0].results[0].errors = [
    {
      location,
      message: `${assertion}\n\n> 7 | expect(1).toBe(2)\n    at ${location.file}:${location.line}:${location.column}\n    at ${location.file}:8:3`,
    },
  ];
  assert.deepEqual(classifyReport(genuine, stepTitle, 'criterion-1', 1), {
    protocol_version: 1,
    outcome: 'fail',
    criterion_id: 'criterion-1',
  });

  const unrelated = structuredClone(genuine);
  unrelated.suites[0].specs[0].tests[0].results[0].errors = [
    {
      location: { ...location, line: 5, column: 11 },
      message: 'Error: Unrelated failure',
    },
  ];
  assert.throws(
    () => classifyReport(unrelated, stepTitle, 'criterion-1', 1),
    /failure-unattributed/u,
  );
  const additional = structuredClone(genuine);
  additional.suites[0].specs[0].tests[0].results[0].errors.push(
    unrelated.suites[0].specs[0].tests[0].results[0].errors[0],
  );
  assert.throws(
    () => classifyReport(additional, stepTitle, 'criterion-1', 1),
    /failure-unattributed/u,
  );
});

test('rejects a later failure from the same helper outside the approved step', () => {
  const file = 'tests/playwright/probe.spec.ts';
  const assertion = 'Error: expect(received).toBe(expected)';
  const location = { file, line: 4, column: 13 };
  const repeated = report('unexpected', [
    {
      title: stepTitle,
      error: {
        message: assertion,
        stack: `${assertion}\n    at check (${file}:4:13)\n    at ${file}:9:45`,
      },
    },
  ]);
  repeated.suites[0].specs[0].tests[0].results[0].errors = [
    {
      location,
      message: `${assertion}\n\n> 4 | expect(1).toBe(2)\n    at check (${file}:4:13)\n    at ${file}:11:9`,
    },
  ];

  assert.throws(
    () => classifyReport(repeated, stepTitle, 'criterion-1', 1),
    /failure-unattributed/u,
  );
});

test('restores exact database bytes after both success and failure', async (t) => {
  const repository = mkdtempSync(path.join(tmpdir(), 'testgen-rwa-seed-'));
  t.after(() => rmSync(repository, { recursive: true, force: true }));
  const data = path.join(repository, 'data');
  mkdirSync(data);
  const database = path.join(data, 'database.json');
  writeFileSync(database, '{"original":true}\r\n');
  writeFileSync(path.join(data, 'database-seed.json'), '{"seed":true}\n');

  await withSeededDatabase(repository, async () => {
    assert.equal(readFileSync(database, 'utf8'), '{"seed":true}\n');
    writeFileSync(database, '{"changed":true}\n');
  });
  assert.equal(readFileSync(database, 'utf8'), '{"original":true}\r\n');

  await assert.rejects(
    withSeededDatabase(repository, async () => {
      writeFileSync(database, '{"changed-again":true}\n');
      throw new Error('test-failed');
    }),
    /test-failed/u,
  );
  assert.equal(readFileSync(database, 'utf8'), '{"original":true}\r\n');
});

test('failed backend startup restores the database and removes runner files', (t) => {
  const temporaryRoot = mkdtempSync(path.join(tmpdir(), 'testgen-rwa-runner-'));
  t.after(() => rmSync(temporaryRoot, { recursive: true, force: true }));
  const repository = path.join(temporaryRoot, 'repository');
  const dependencies = path.join(temporaryRoot, 'dependencies');
  mkdirSync(path.join(repository, 'data'), { recursive: true });
  mkdirSync(path.join(repository, 'scripts'));
  mkdirSync(path.join(repository, 'src'));
  mkdirSync(path.join(repository, 'tests', 'playwright'), { recursive: true });
  mkdirSync(path.join(dependencies, 'ts-node', 'dist'), {
    recursive: true,
  });
  writeFileSync(
    path.join(dependencies, 'ts-node', 'dist', 'bin.js'),
    'process.exit(1);\n',
  );
  writeFileSync(
    path.join(repository, 'data', 'database.json'),
    '{"original":true}\n',
  );
  writeFileSync(
    path.join(repository, 'data', 'database-seed.json'),
    '{"seed":true}\n',
  );
  writeFileSync(
    path.join(repository, 'scripts', 'mock-aws-exports.js'),
    'export default {};\n',
  );
  writeFileSync(
    path.join(repository, 'tests', 'playwright', 'signin.spec.ts'),
    '// spec\n',
  );

  const result = spawnSync(
    process.execPath,
    [
      rwaRunner,
      '--phase',
      'baseline',
      '--spec',
      'tests/playwright/signin.spec.ts',
      '--criterion-id',
      'criterion-1',
      '--step-title',
      stepTitle,
    ],
    {
      cwd: repository,
      env: { ...process.env, TESTGEN_TARGET_NODE_MODULES: dependencies },
      encoding: 'utf8',
      timeout: 10_000,
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    protocol_version: 1,
    outcome: 'error',
    criterion_id: null,
    reason: 'backend-unavailable',
  });
  assert.equal(
    readFileSync(path.join(repository, 'data', 'database.json'), 'utf8'),
    '{"original":true}\n',
  );
  assert.equal(existsSync(path.join(repository, 'node_modules')), false);
  assert.equal(
    existsSync(path.join(repository, 'src', 'aws-exports.js')),
    false,
  );
  assert.equal(
    readdirSync(repository).some((name) =>
      name.startsWith('.testgen-rwa-runner-'),
    ),
    false,
  );
});

test('runner reports nested startup and cleanup failures', (t) => {
  const repository = mkdtempSync(path.join(tmpdir(), 'testgen-rwa-errors-'));
  t.after(() => rmSync(repository, { recursive: true, force: true }));
  const dependencies = path.join(repository, 'dependencies');
  for (const directory of [
    'data',
    'scripts',
    'src',
    'tests/playwright',
    'dependencies/ts-node/dist',
  ])
    mkdirSync(path.join(repository, directory), { recursive: true });
  writeFileSync(path.join(repository, 'data', 'database.json'), '{}\n');
  writeFileSync(path.join(repository, 'data', 'database-seed.json'), '{}\n');
  writeFileSync(path.join(repository, 'scripts', 'mock-aws-exports.js'), '');
  writeFileSync(
    path.join(repository, 'tests/playwright', 'signin.spec.ts'),
    '',
  );
  writeFileSync(
    path.join(dependencies, 'ts-node', 'dist', 'bin.js'),
    "const fs = require('node:fs'); fs.renameSync('data', 'data-moved'); fs.renameSync('src/aws-exports.js', 'src/aws-exports-moved.js'); process.exit(1);\n",
  );

  const result = spawnSync(
    process.execPath,
    [
      rwaRunner,
      '--phase',
      'baseline',
      '--spec',
      'tests/playwright/signin.spec.ts',
      '--criterion-id',
      'criterion-1',
      '--step-title',
      stepTitle,
    ],
    {
      cwd: repository,
      env: { ...process.env, TESTGEN_TARGET_NODE_MODULES: dependencies },
      encoding: 'utf8',
      timeout: 10_000,
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    protocol_version: 1,
    outcome: 'error',
    criterion_id: null,
    reason: 'runner-cleanup-failed',
    primary_reason: 'backend-unavailable',
    cleanup_reasons: ['enoent', 'enoent'],
  });
});

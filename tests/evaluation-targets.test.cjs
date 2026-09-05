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

const repositoryRoot = path.resolve(__dirname, '..');
const targetsRoot = path.join(repositoryRoot, 'evals', 'targets');

function readJson(filename) {
  return JSON.parse(readFileSync(filename, 'utf8'));
}

test('active external target descriptors pin reproducible sources without vendoring them', () => {
  const targetIds = ['cypress-realworld-app'];
  const sourceUrls = new Set();

  assert.deepEqual(readdirSync(targetsRoot).sort(), [
    'cypress-realworld-app',
    'semantic-only',
  ]);

  for (const targetId of targetIds) {
    const targetDirectory = path.join(targetsRoot, targetId);
    const descriptor = readJson(path.join(targetDirectory, 'target.json'));

    assert.equal(descriptor.schema_version, 'evaluation-target.v1');
    assert.equal(descriptor.target_id, targetId);
    assert.equal(descriptor.source.kind, 'git');
    assert.match(descriptor.source.url, /^https:\/\/github\.com\//u);
    assert.match(descriptor.source.revision, /^[a-f0-9]{40}$/u);
    assert.equal(
      descriptor.locator_convention === null ||
        (typeof descriptor.locator_convention === 'string' &&
          descriptor.locator_convention.length > 0),
      true,
    );
    assert.equal(typeof descriptor.setup.command, 'string');
    assert.notEqual(descriptor.setup.command, '');
    assert.equal(typeof descriptor.start.command, 'string');
    assert.notEqual(descriptor.start.command, '');
    assert.match(descriptor.start.origin, /^http:\/\/127\.0\.0\.1:\d+$/u);
    assert.equal(typeof descriptor.reset.strategy, 'string');
    assert.notEqual(descriptor.reset.strategy, '');
    assert.deepEqual(readdirSync(targetDirectory), ['target.json']);
    sourceUrls.add(descriptor.source.url);
  }

  assert.equal(sourceUrls.size, targetIds.length);
});

test('owned semantic-only target serves controls without test IDs', async (t) => {
  const targetRoot = path.join(targetsRoot, 'semantic-only', 'repository');
  const { createServer } = require(path.join(targetRoot, 'server.cjs'));
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const { port } = server.address();
  const origin = `http://127.0.0.1:${port}`;
  const health = await fetch(`${origin}/health`);
  const page = await fetch(origin);
  const script = await fetch(`${origin}/app.js`);
  const html = await page.text();
  const javascript = await script.text();

  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: 'ok' });
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /^text\/html/iu);
  assert.match(html, /<form\b/iu);
  assert.match(html, /<label\s+for="item-name"/iu);
  assert.match(html, /<table\b/iu);
  assert.match(html, /<dialog\b/iu);
  assert.doesNotMatch(`${html}\n${javascript}`, /data-test(?:id|-id)?\s*=/iu);
});

test('owned target keeps only its Playwright test runner dependencies local', () => {
  const targetRoot = path.join(targetsRoot, 'semantic-only');
  const descriptor = readJson(path.join(targetRoot, 'target.json'));
  const packageJson = readJson(
    path.join(targetRoot, 'repository', 'package.json'),
  );

  assert.deepEqual(descriptor.source, { kind: 'owned', path: 'repository' });
  assert.equal(descriptor.setup.package_manager, 'npm');
  assert.equal(descriptor.setup.command, 'npm ci');
  assert.equal(
    existsSync(path.join(targetRoot, 'repository', 'package-lock.json')),
    true,
  );
  assert.equal('@playwright/cli' in packageJson.devDependencies, false);
  for (const dependency of ['@playwright/test', 'playwright']) {
    assert.match(packageJson.devDependencies[dependency], /^\d+\.\d+\.\d+$/u);
  }
});

test('owned target collects generated TypeScript without executing it', () => {
  const packageJson = readJson(
    path.join(targetsRoot, 'semantic-only', 'repository', 'package.json'),
  );

  assert.equal(packageJson.scripts['check:tests'], 'playwright test --list');
  assert.equal('lint' in packageJson.scripts, false);
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
      "const result=failed?{status:'failed',errorLocation:{file:path.resolve(file),line:108,column:1},steps:[{title:'verify the submitted order details',error:{message:'assertion failed'}}]}:{status:'passed'};",
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
      "const report={errors:[],stats:{expected:0,unexpected:1},suites:[{title:file,file,specs:[{title:'order',file,line:1,column:1,tests:[{status:'unexpected',results:[{status:'failed',steps:[{title:'verify another outcome',error:{message:'assertion failed'}}]}]}]}]}]};",
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

test('mutation runner rejects a spec path outside its target repository', () => {
  const targetRoot = path.join(targetsRoot, 'semantic-only', 'repository');
  const result = spawnSync(
    process.execPath,
    [
      path.join(targetRoot, '.testgen', 'mutation-runner.cjs'),
      '--phase',
      'baseline',
      '--spec',
      'tests/../../outside.spec.js',
      '--criterion-id',
      'order-appears-in-table',
      '--step-title',
      'verify the submitted order details',
    ],
    { cwd: targetRoot, encoding: 'utf8', windowsHide: true },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    protocol_version: 1,
    outcome: 'error',
    criterion_id: null,
    reason: 'invalid-arguments',
  });
});

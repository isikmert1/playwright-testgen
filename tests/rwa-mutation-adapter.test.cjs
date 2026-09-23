const assert = require('node:assert/strict');
const test = require('node:test');
const { spawnSync } = require('node:child_process');
const {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');

const {
  classifyReport,
  exactPlaywrightFilter,
  parseArguments,
  resolveSpec,
  withSeededDatabase,
} = require('../evals/targets/cypress-realworld-app/adapter/.testgen/mutation-runner.cjs');

const stepTitle =
  'Clearing Username shows its required error and disables Sign In';
const runner = path.resolve(
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

test('reports pass only for one passing Playwright test', () => {
  assert.deepEqual(
    classifyReport(report('expected', []), stepTitle, 'criterion-1', 0),
    {
      protocol_version: 1,
      outcome: 'pass',
      criterion_id: null,
    },
  );
});

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

test('rejects unrelated failures and a matching step without its own error', () => {
  const unrelated = {
    title: 'Open sign-in page',
    error: { message: 'navigation failed' },
  };
  assert.throws(
    () =>
      classifyReport(
        report('unexpected', [unrelated]),
        stepTitle,
        'criterion-1',
        1,
      ),
    /failure-unattributed/u,
  );
  assert.throws(
    () =>
      classifyReport(
        report('unexpected', [{ title: stepTitle, steps: [] }, unrelated]),
        stepTitle,
        'criterion-1',
        1,
      ),
    /failure-unattributed/u,
  );
  assert.throws(
    () =>
      classifyReport(
        report('unexpected', [{ title: stepTitle, error: {} }, unrelated]),
        stepTitle,
        'criterion-1',
        1,
      ),
    /failure-unattributed/u,
  );
});

test('rejects report errors, zero tests, and multiple tests', () => {
  assert.throws(
    () =>
      classifyReport(
        report(
          'unexpected',
          [{ title: stepTitle, error: {} }],
          [{ message: 'setup' }],
        ),
        stepTitle,
        'criterion-1',
        1,
      ),
    /playwright-run-failed/u,
  );
  const empty = {
    stats: { expected: 0, unexpected: 0 },
    errors: [],
    suites: [],
  };
  assert.throws(
    () => classifyReport(empty, stepTitle, 'criterion-1', 1),
    /no-tests-ran/u,
  );
  const multiple = report('expected', []);
  multiple.suites[0].specs[0].tests.push(multiple.suites[0].specs[0].tests[0]);
  assert.throws(
    () => classifyReport(multiple, stepTitle, 'criterion-1', 0),
    /failure-unattributed/u,
  );
});

test('rejects malformed Playwright reports', () => {
  assert.throws(
    () => classifyReport(null, stepTitle, 'criterion-1', 0),
    /playwright-report-invalid/u,
  );
  assert.throws(
    () =>
      classifyReport(
        { stats: {}, errors: [], suites: [] },
        stepTitle,
        'criterion-1',
        0,
      ),
    /playwright-report-invalid/u,
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

test('retains the primary failure when database restoration also fails', async (t) => {
  const repository = mkdtempSync(path.join(tmpdir(), 'testgen-rwa-restore-'));
  t.after(() => rmSync(repository, { recursive: true, force: true }));
  const data = path.join(repository, 'data');
  mkdirSync(data);
  writeFileSync(path.join(data, 'database.json'), '{"original":true}\n');
  writeFileSync(path.join(data, 'database-seed.json'), '{"seed":true}\n');

  await assert.rejects(
    withSeededDatabase(repository, async () => {
      renameSync(data, `${data}-moved`);
      throw new Error('test-failed');
    }),
    (error) =>
      error instanceof AggregateError &&
      error.errors[0].message === 'test-failed' &&
      error.errors[1].code === 'ENOENT',
  );
});

test('accepts only exact runner arguments and repository spec paths', (t) => {
  const args = [
    '--phase',
    'mutant',
    '--spec',
    'tests/playwright/signin.spec.ts',
    '--criterion-id',
    'criterion-1',
    '--step-title',
    stepTitle,
  ];
  assert.deepEqual(parseArguments(args), {
    phase: 'mutant',
    spec: 'tests/playwright/signin.spec.ts',
    criterionId: 'criterion-1',
    stepTitle,
  });
  assert.throws(
    () => parseArguments([...args, '--phase', 'baseline']),
    /invalid-arguments/u,
  );
  assert.throws(
    () =>
      parseArguments(
        args.map((value) => (value === args[3] ? '../outside.spec.ts' : value)),
      ),
    /invalid-arguments/u,
  );

  const repository = mkdtempSync(path.join(tmpdir(), 'testgen-rwa-spec-'));
  t.after(() => rmSync(repository, { recursive: true, force: true }));
  const tests = path.join(repository, 'tests', 'playwright');
  mkdirSync(tests, { recursive: true });
  const spec = path.join(tests, 'signin.spec.ts');
  writeFileSync(spec, '// approved\n');
  assert.equal(resolveSpec(repository, args[3]), spec);
  assert.throws(
    () => resolveSpec(repository, 'tests/playwright/missing.spec.ts'),
    /spec-unavailable/u,
  );
  const outside = path.join(repository, 'outside.spec.ts');
  writeFileSync(outside, '// outside\n');
  symlinkSync(outside, path.join(tests, 'linked.spec.ts'));
  assert.throws(
    () => resolveSpec(repository, 'tests/playwright/linked.spec.ts'),
    /spec-unavailable/u,
  );
});

test('Playwright filter matches only the exact approved spec', () => {
  const approved = path.resolve('tests/playwright/a+[1].spec.ts');
  const filter = exactPlaywrightFilter(approved);
  const pattern = new RegExp(
    filter.slice(1, filter.lastIndexOf('/')),
    filter.slice(filter.lastIndexOf('/') + 1),
  );
  assert.equal(pattern.test(approved.replaceAll('\\', '/')), true);
  assert.equal(
    pattern.test(
      path.resolve('tests/playwright/aaa1.spec.ts').replaceAll('\\', '/'),
    ),
    false,
  );
});

test('runner emits one bounded error for invalid arguments', () => {
  const result = spawnSync(process.execPath, [runner, '--phase', 'wrong'], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0);
  assert.deepEqual(JSON.parse(result.stdout), {
    protocol_version: 1,
    outcome: 'error',
    criterion_id: null,
    reason: 'invalid-arguments',
  });
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
      runner,
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
      runner,
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

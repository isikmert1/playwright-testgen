const assert = require('node:assert/strict');
const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { versionAtLeast } = require('../scripts/runtime-preflight.cjs');

const preflight = path.resolve(
  __dirname,
  '..',
  'scripts',
  'runtime-preflight.cjs',
);

function writeJson(filename, value) {
  mkdirSync(path.dirname(filename), { recursive: true });
  writeFileSync(filename, `${JSON.stringify(value, null, 2)}\n`);
}

function createRepository({
  cliVersion = '0.1.19',
  commit = true,
  playwrightVersion = '1.62.1',
  runnerTraceOption = playwrightVersion === '1.62.1' ? '--name' : '--phase',
} = {}) {
  const repository = mkdtempSync(path.join(tmpdir(), 'testgen-preflight-'));
  writeJson(path.join(repository, 'package.json'), { private: true });
  for (const packageName of ['playwright', '@playwright/test']) {
    writeJson(
      path.join(repository, 'node_modules', packageName, 'package.json'),
      {
        bin:
          packageName === 'playwright' ? { playwright: 'cli.cjs' } : undefined,
        name: packageName,
        version: playwrightVersion,
      },
    );
  }
  writeFileSync(
    path.join(repository, 'node_modules', 'playwright', 'cli.cjs'),
    [
      'const args = process.argv.slice(2);',
      "if (args[0] === 'trace' && args[1] === 'snapshot' && args[2] === '--help') {",
      `  console.log('${runnerTraceOption}');`,
      '} else {',
      "  console.log('--list --project --config --debug --retries --repeat-each --output');",
      '}',
    ].join('\n'),
  );
  const skill = path.join(
    repository,
    '.claude',
    'skills',
    'playwright-cli',
    'SKILL.md',
  );
  mkdirSync(path.dirname(skill), { recursive: true });
  writeFileSync(skill, '# Playwright CLI\n');

  spawnSync('git', ['init', '--quiet'], { cwd: repository });
  if (commit) {
    spawnSync('git', ['config', 'user.name', 'Test'], { cwd: repository });
    spawnSync('git', ['config', 'user.email', 'test@example.invalid'], {
      cwd: repository,
    });
    spawnSync('git', ['add', '--all'], { cwd: repository });
    spawnSync('git', ['commit', '--quiet', '-m', 'fixture'], {
      cwd: repository,
    });
  }

  const cliPackage = path.join(
    repository,
    'node_modules',
    '@playwright',
    'cli',
  );
  writeJson(path.join(cliPackage, 'package.json'), {
    bin: { 'playwright-cli': 'playwright-cli.cjs' },
    name: '@playwright/cli',
    version: cliVersion,
  });
  const bundledSkill = path.join(
    cliPackage,
    'skills',
    'playwright-cli',
    'SKILL.md',
  );
  mkdirSync(path.dirname(bundledSkill), { recursive: true });
  writeFileSync(bundledSkill, '# Playwright CLI\n');
  const cli = path.join(cliPackage, 'playwright-cli.cjs');
  writeFileSync(
    cli,
    [
      "if (process.env.PWTEST_CLI_GLOBAL_CONFIG !== '.') process.exit(9);",
      `if (process.argv.includes('--version')) console.log('${cliVersion}');`,
      "else console.log('attach find generate-locator requests');",
    ].join('\n'),
  );
  return { cli, repository };
}

function runPreflight(repository, cli) {
  const result = spawnSync(
    process.execPath,
    [preflight, '--repo', repository, '--playwright-cli', cli],
    { encoding: 'utf8' },
  );
  return {
    ...result,
    report: JSON.parse(result.stdout),
  };
}

function withRepository(options, callback) {
  const fixture = createRepository(options);
  try {
    callback(fixture);
  } finally {
    rmSync(fixture.repository, { force: true, recursive: true });
  }
}

for (const [version, option] of [
  ['1.62.1', '--name'],
  ['1.63.0', '--phase'],
]) {
  test(`selects ${option} for Playwright ${version}`, () => {
    withRepository({ playwrightVersion: version }, ({ cli, repository }) => {
      const result = runPreflight(repository, cli);

      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.report.ok, true);
      assert.equal(result.report.playwright.version, version);
      assert.equal(result.report.playwright_test.version, version);
      assert.equal(result.report.playwright_cli.version, '0.1.19');
      assert.equal(result.report.playwright_cli.skill_ready, true);
      assert.equal(result.report.hook_dependency_ready, true);
      assert.equal(result.report.trace_snapshot_option, option);
      assert.match(result.report.git_head, /^[a-f0-9]{40}$/u);
    });
  });
}

test('keeps optional trace inspection unavailable for an untested runtime', () => {
  withRepository({ playwrightVersion: '1.64.0' }, ({ cli, repository }) => {
    const { report, status } = runPreflight(repository, cli);

    assert.equal(status, 0);
    assert.equal(report.ok, true);
    assert.equal(report.trace_snapshot_option, null);
    assert.equal(
      report.trace_inspection_reason,
      'playwright-trace-compatibility-untested',
    );
  });
});

test('does not assume a newer CLI has tested trace compatibility', () => {
  withRepository({ cliVersion: '0.1.20' }, ({ cli, repository }) => {
    const { report, status } = runPreflight(repository, cli);

    assert.equal(status, 0);
    assert.equal(report.ok, true);
    assert.equal(report.trace_snapshot_option, null);
    assert.equal(
      report.trace_inspection_reason,
      'playwright-trace-compatibility-untested',
    );
  });
});

test('keeps trace inspection optional when a tested spelling is unavailable', () => {
  withRepository({ runnerTraceOption: '--phase' }, ({ cli, repository }) => {
    const { report, status } = runPreflight(repository, cli);

    assert.equal(status, 0);
    assert.equal(report.ok, true);
    assert.equal(report.trace_snapshot_option, null);
    assert.equal(
      report.trace_inspection_reason,
      'playwright-trace-contract-mismatch',
    );
  });
});

test('rejects an older CLI even when its help looks compatible', () => {
  withRepository({ cliVersion: '0.1.18' }, ({ cli, repository }) => {
    const { report, status } = runPreflight(repository, cli);

    assert.equal(status, 1);
    assert.deepEqual(report, {
      ok: false,
      error: 'playwright-cli-version-unsupported',
    });
  });
});

for (const [name, arrange, error] of [
  [
    'missing local Playwright',
    ({ repository }) =>
      rmSync(path.join(repository, 'node_modules', 'playwright'), {
        force: true,
        recursive: true,
      }),
    'playwright-unavailable',
  ],
  [
    'missing local Playwright Test',
    ({ repository }) =>
      rmSync(path.join(repository, 'node_modules', '@playwright', 'test'), {
        force: true,
        recursive: true,
      }),
    'playwright-test-unavailable',
  ],
  [
    'missing runner capability',
    ({ repository }) =>
      writeFileSync(
        path.join(repository, 'node_modules', 'playwright', 'cli.cjs'),
        "console.log('--list --config --debug --retries --repeat-each --output')\n",
      ),
    'playwright-runner-contract-mismatch',
  ],
  [
    'missing official skill',
    ({ repository }) =>
      rmSync(path.join(repository, '.claude'), {
        force: true,
        recursive: true,
      }),
    'playwright-cli-skill-unavailable',
  ],
  [
    'outdated official skill',
    ({ repository }) =>
      writeFileSync(
        path.join(
          repository,
          '.claude',
          'skills',
          'playwright-cli',
          'SKILL.md',
        ),
        '# stale\n',
      ),
    'playwright-cli-skill-outdated',
  ],
  [
    'missing CLI capability',
    ({ cli }) =>
      writeFileSync(
        cli,
        "console.log(process.argv.includes('--version') ? '0.1.19' : 'attach findings generate-locator-old requests')\n",
      ),
    'playwright-cli-contract-mismatch',
  ],
]) {
  test(`reports ${name} distinctly`, () => {
    withRepository({}, (fixture) => {
      arrange(fixture);
      const { report, status } = runPreflight(fixture.repository, fixture.cli);

      assert.equal(status, 1);
      assert.deepEqual(report, { ok: false, error });
    });
  });
}

test('enforces the documented Node floor', () => {
  assert.equal(versionAtLeast('22.12.0', '22.13.0'), false);
  assert.equal(versionAtLeast('22.13.0', '22.13.0'), true);
  assert.equal(versionAtLeast('24.0.0', '22.13.0'), true);
});

test('reports a missing Git HEAD without creating one', () => {
  withRepository({ commit: false }, ({ cli, repository }) => {
    const { report, status } = runPreflight(repository, cli);

    assert.equal(status, 1);
    assert.deepEqual(report, { ok: false, error: 'git-head-unavailable' });
    assert.notEqual(
      spawnSync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: repository })
        .status,
      0,
    );
  });
});

test('rejects mismatched local Playwright packages', () => {
  withRepository({}, ({ cli, repository }) => {
    const packagePath = path.join(
      repository,
      'node_modules',
      '@playwright',
      'test',
      'package.json',
    );
    writeJson(packagePath, { name: '@playwright/test', version: '1.63.0' });

    const { report, status } = runPreflight(repository, cli);
    assert.equal(status, 1);
    assert.deepEqual(report, {
      ok: false,
      error: 'playwright-version-mismatch',
    });
  });
});

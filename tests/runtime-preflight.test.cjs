const assert = require('node:assert/strict');
const {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const repositoryRoot = path.resolve(__dirname, '..');
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
  nested = false,
  playwrightVersion = '1.62.1',
} = {}) {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'testgen-preflight-'));
  const repository = nested
    ? path.join(fixtureRoot, 'repository')
    : fixtureRoot;
  if (nested) mkdirSync(repository);
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
      "  console.log('--name');",
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
      "else console.log('attach find generate-locator requests state-load state-save');",
    ].join('\n'),
  );
  return { cli, fixtureRoot, repository };
}

function runPreflight(repository, cli, selection = ['--configless']) {
  const result = spawnSync(
    process.execPath,
    [preflight, '--repo', repository, '--playwright-cli', cli, ...selection],
    { encoding: 'utf8' },
  );
  return {
    ...result,
    report: JSON.parse(result.stdout),
  };
}

test('binds a hoisted runtime to the selected package and config', () => {
  withRepository({}, ({ cli, repository }) => {
    const packageDirectory = path.join(repository, 'apps', 'web');
    mkdirSync(packageDirectory, { recursive: true });
    writeJson(path.join(packageDirectory, 'package.json'), { private: true });
    writeFileSync(
      path.join(packageDirectory, 'playwright.config.ts'),
      'export default {};\n',
    );

    const result = runPreflight(repository, cli, [
      '--package',
      'apps/web',
      '--config',
      'apps/web/playwright.config.ts',
    ]);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.report.trace_snapshot_option, '--name');
    assert.deepEqual(result.report.selection, {
      package: 'apps/web',
      package_directory: packageDirectory.replaceAll('\\', '/'),
      config_mode: 'config',
      config: 'apps/web/playwright.config.ts',
      runner_config: 'playwright.config.ts',
    });
  });
});

test('requires one selected config or explicit configless mode', () => {
  withRepository({}, ({ cli, repository }) => {
    const result = runPreflight(repository, cli, []);

    assert.equal(result.status, 1);
    assert.deepEqual(result.report, {
      ok: false,
      error: 'preflight-selection-required',
    });
  });
});

test('rejects configless preflight when the selected package has a default config', () => {
  withRepository({}, ({ cli, repository }) => {
    writeFileSync(
      path.join(repository, 'playwright.config.ts'),
      'export default {};\n',
    );
    const result = runPreflight(repository, cli);
    assert.equal(result.status, 1);
    assert.equal(result.report.error, 'config-selection-invalid');
  });
});

test('rejects a selected package config from a sibling package', () => {
  withRepository({}, ({ cli, repository }) => {
    mkdirSync(path.join(repository, 'apps', 'web'), { recursive: true });
    mkdirSync(path.join(repository, 'apps', 'other'), { recursive: true });
    writeJson(path.join(repository, 'apps', 'web', 'package.json'), {
      private: true,
    });
    writeFileSync(
      path.join(repository, 'apps', 'other', 'playwright.config.ts'),
      'export default {};\n',
    );
    const result = runPreflight(repository, cli, [
      '--package',
      'apps/web',
      '--config',
      'apps/other/playwright.config.ts',
    ]);

    assert.equal(result.status, 1);
    assert.equal(result.report.error, 'config-selection-invalid');
  });
});

function withRepository(options, callback) {
  const fixture = createRepository(options);
  try {
    callback(fixture);
  } finally {
    rmSync(fixture.fixtureRoot, { force: true, recursive: true });
  }
}

test('rejects a Playwright runtime resolved outside the repository', () => {
  withRepository({ nested: true }, ({ cli, repository }) => {
    const externalPackage = path.join(
      path.dirname(repository),
      'node_modules',
      'playwright',
    );
    mkdirSync(path.dirname(externalPackage), { recursive: true });
    renameSync(
      path.join(repository, 'node_modules', 'playwright'),
      externalPackage,
    );
    const { report, status } = runPreflight(repository, cli);
    assert.equal(status, 1);
    assert.deepEqual(report, { ok: false, error: 'playwright-unavailable' });
  });
});

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

test('session hook exports the installed plugin root for Bash commands', () => {
  const hooks = JSON.parse(
    readFileSync(path.join(repositoryRoot, 'hooks', 'hooks.json'), 'utf8'),
  );
  const sessionHook = hooks.hooks.SessionStart?.[0]?.hooks?.[0];
  const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'testgen-env-'));
  const environmentFile = path.join(temporaryDirectory, 'environment');

  try {
    assert.equal(sessionHook.command, 'node');
    assert.deepEqual(sessionHook.args, [
      '${CLAUDE_PLUGIN_ROOT}/hooks/export-plugin-root.cjs',
    ]);

    const result = spawnSync(
      process.execPath,
      [path.join(repositoryRoot, 'hooks', 'export-plugin-root.cjs')],
      {
        encoding: 'utf8',
        env: { ...process.env, CLAUDE_ENV_FILE: environmentFile },
      },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '');
    assert.equal(
      readFileSync(environmentFile, 'utf8'),
      `export PLAYWRIGHT_TESTGEN_ROOT='${repositoryRoot.replaceAll('\\', '/')}'\n`,
    );
  } finally {
    rmSync(temporaryDirectory, { force: true, recursive: true });
  }
});

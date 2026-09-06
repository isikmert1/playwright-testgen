const assert = require('node:assert/strict');
const { mkdtempSync, readFileSync, readdirSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const repositoryRoot = path.resolve(__dirname, '..');

function readJson(relativePath) {
  return JSON.parse(
    readFileSync(path.join(repositoryRoot, relativePath), 'utf8'),
  );
}

function markdownFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return markdownFiles(file);
    return entry.name.endsWith('.md') ? [file] : [];
  });
}

test('marketplace entry points to this plugin', () => {
  const marketplace = readJson('.claude-plugin/marketplace.json');
  const entry = marketplace.plugins[0];

  assert.match(entry.source, /^\.\//u);

  const plugin = readJson(
    path.relative(
      repositoryRoot,
      path.join(repositoryRoot, entry.source, '.claude-plugin/plugin.json'),
    ),
  );

  assert.equal(entry.name, plugin.name);
  assert.equal(entry.description, plugin.description);
});

test('tooling package does not install Playwright', () => {
  const packageJson = readJson('package.json');
  const packageLock = readJson('package-lock.json');
  const playwrightPackages = [
    'playwright',
    '@playwright/test',
    '@playwright/cli',
  ];

  for (const packageName of playwrightPackages) {
    for (const dependencyType of [
      'dependencies',
      'devDependencies',
      'peerDependencies',
    ]) {
      assert.equal(packageName in (packageJson[dependencyType] ?? {}), false);
    }

    assert.equal(`node_modules/${packageName}` in packageLock.packages, false);
  }
});

test('plugin commands use portable root substitution', () => {
  let executableReferences = 0;

  for (const directory of ['agents', 'skills']) {
    for (const file of markdownFiles(path.join(repositoryRoot, directory))) {
      const content = readFileSync(file, 'utf8');
      assert.doesNotMatch(
        content,
        /(?<!\{)\$CLAUDE_PLUGIN_ROOT/u,
        `${path.relative(repositoryRoot, file)} uses an unsubstituted plugin root`,
      );
      assert.doesNotMatch(
        content,
        /node\s+"\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\//u,
        `${path.relative(repositoryRoot, file)} relies on model-side plugin-root substitution for a Bash command`,
      );
      executableReferences += (
        content.match(/node\s+"\$PLAYWRIGHT_TESTGEN_ROOT\/scripts\//gu) ?? []
      ).length;
    }
  }

  assert.ok(executableReferences > 0);
});

test('session hook exports the installed plugin root for Bash commands', () => {
  const hooks = readJson('hooks/hooks.json');
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

test('workflow guidance removes avoidable pre-Author ambiguity', () => {
  const skill = readFileSync(
    path.join(repositoryRoot, 'skills', 'playwright-testgen', 'SKILL.md'),
    'utf8',
  );
  const pipeline = readFileSync(
    path.join(
      repositoryRoot,
      'skills',
      'playwright-testgen',
      'references',
      'pipeline.md',
    ),
    'utf8',
  );
  const mutationCheck = readFileSync(
    path.join(
      repositoryRoot,
      'skills',
      'playwright-testgen',
      'references',
      'mutation-check.md',
    ),
    'utf8',
  );
  const author = readFileSync(
    path.join(repositoryRoot, 'agents', 'playwright-test-author.md'),
    'utf8',
  );
  const healer = readFileSync(
    path.join(repositoryRoot, 'agents', 'playwright-test-healer.md'),
    'utf8',
  );

  assert.match(skill, /separate Bash call/iu);
  assert.match(skill, /Agent skill:/u);
  assert.match(skill, /does not match the tool version/iu);
  assert.match(pipeline, /actual derived\s+`scenario_ref`/iu);
  assert.match(pipeline, /application is already running/iu);
  assert.match(pipeline, /without a target `tsconfig`/iu);
  assert.match(pipeline, /runtime preflight: passed/iu);
  assert.match(pipeline, /approved spec filter argument/iu);
  assert.match(mutationCheck, /Run mutation check/iu);
  assert.match(mutationCheck, /checkout is not changed/iu);
  assert.match(author, /never enumerate the repository with `\*\*\/\*`/iu);
  assert.match(
    author,
    /rm -rf -- \.playwright-cli\/testgen\/<run_id>\/\.playwright-cli/iu,
  );
  assert.match(healer, /do not repeat the runtime preflight/iu);
  assert.match(healer, /do not inspect inactive fixture variants/iu);
});

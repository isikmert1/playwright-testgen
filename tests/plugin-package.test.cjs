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

test('tooling declares and tests its supported Node releases', () => {
  const packageJson = readJson('package.json');
  const workflow = readFileSync(
    path.join(repositoryRoot, '.github', 'workflows', 'ci.yml'),
    'utf8',
  );

  assert.equal(packageJson.engines.node, '>=22.13.0');
  assert.match(workflow, /matrix:\s*\r?\n\s+node: \[22\.13\.0, 24\]/u);
  assert.match(workflow, /node-version: \$\{\{ matrix\.node \}\}/u);
});

test('README explains the project, workflow, and safety boundary', () => {
  const readme = readFileSync(path.join(repositoryRoot, 'README.md'), 'utf8');

  assert.match(readme, /## Why Testgen/iu);
  assert.match(readme, /## How it works/iu);
  assert.match(readme, /running application/iu);
  assert.match(readme, /human checkpoint/iu);
  assert.match(readme, /disposable Git worktree/iu);
  assert.match(readme, /lint or collection validation/iu);
  assert.match(readme, /approved\s+criterion-linked mutation/iu);
  assert.match(readme, /Playwright configuration.*CI/isu);
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
  const artifactContract = readFileSync(
    path.join(
      repositoryRoot,
      'skills',
      'playwright-testgen',
      'references',
      'artifact-contract.md',
    ),
    'utf8',
  );
  const locatorPolicy = readFileSync(
    path.join(
      repositoryRoot,
      'skills',
      'playwright-testgen',
      'references',
      'locator-policy.md',
    ),
    'utf8',
  );

  assert.match(skill, /separate Bash call/iu);
  assert.match(skill, /Node(?:\.js)? 22\.13/iu);
  assert.match(skill, /exploration\s+browser.*runner\s+browser/isu);
  assert.match(skill, /Agent skill:/u);
  assert.match(skill, /does not match the tool version/iu);
  assert.match(pipeline, /actual derived\s+`scenario_ref`/iu);
  assert.match(pipeline, /application is already running/iu);
  assert.match(pipeline, /feature source.*Author/isu);
  assert.match(pipeline, /evaluation metadata.*not.*profile/isu);
  assert.match(pipeline, /without a project `tsconfig`/iu);
  assert.match(pipeline, /runtime preflight: passed/iu);
  assert.match(pipeline, /approved spec filter argument/iu);
  assert.match(mutationCheck, /Run mutation check/iu);
  assert.match(mutationCheck, /checkout is not changed/iu);
  assert.match(
    mutationCheck,
    /literal `--repo \.`.*repository-relative adapter path/isu,
  );
  assert.match(author, /never enumerate the repository\s+with `\*\*\/\*`/iu);
  assert.match(author, /native `Grep` tool.*do not use Bash/isu);
  assert.match(
    author,
    /convention scans.*separate.*five-call grounding budget/isu,
  );
  assert.match(author, /after every action that may navigate/iu);
  assert.match(
    author,
    /inherited `PLAYWRIGHT_MCP_\*`.*`PLAYWRIGHT_CLI_SESSION`.*blocker/isu,
  );
  assert.doesNotMatch(author, /references\/pipeline\.md/iu);
  assert.match(
    author,
    /rm -rf -- \.playwright-cli\/testgen\/<run_id>\/\.playwright-cli/iu,
  );
  assert.match(healer, /do not repeat the runtime\s+preflight/iu);
  assert.match(healer, /hook rejection.*does not consume an\s+attempt/isu);
  assert.match(
    healer,
    /interrupted.*explicit human approval.*new workflow run/isu,
  );
  assert.doesNotMatch(healer, /references\/pipeline\.md/iu);
  assert.match(healer, /do not inspect inactive fixture variants/iu);
  assert.match(healer, /exact output path returned by Bash.*use\s+`Read`/isu);
  assert.match(healer, /pause-at.*approved.*spec.*positive line/isu);
  assert.match(
    healer,
    /complete trace.*one whole-file `Write`.*validate\s+once/isu,
  );
  assert.match(healer, /overwrite.*whole-file `Write`/isu);
  assert.match(healer, /Put one command in one\s+Bash call/iu);
  assert.match(
    author,
    /collection command.*bare.*own Bash call.*final spec.*assertion line/isu,
  );
  assert.match(
    artifactContract,
    /attempt summary.*behavior-focused sentence.*200 characters/isu,
  );
  assert.match(
    readFileSync(
      path.join(
        repositoryRoot,
        'skills',
        'playwright-testgen',
        'references',
        'healing-protocol.md',
      ),
      'utf8',
    ),
    /attempt\s+directory and candidate in two separate Bash calls/isu,
  );
  assert.match(
    artifactContract,
    /raw selectors.*only.*`locators\[\]\.locator`/isu,
  );
  assert.match(artifactContract, /use `Read`.*never use Bash/isu);
  assert.match(locatorPolicy, /candidate, not proof/iu);
  assert.match(
    locatorPolicy,
    /up to four.*count-only.*one exact attribute spelling/isu,
  );
  assert.match(locatorPolicy, /literal.*Git Bash/isu);
});

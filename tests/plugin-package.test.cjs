const assert = require('node:assert/strict');
const { readFileSync, readdirSync } = require('node:fs');
const path = require('node:path');
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
  for (const directory of ['agents', 'skills']) {
    for (const file of markdownFiles(path.join(repositoryRoot, directory))) {
      assert.doesNotMatch(
        readFileSync(file, 'utf8'),
        /(?<!\{)\$CLAUDE_PLUGIN_ROOT/u,
        `${path.relative(repositoryRoot, file)} uses an unsubstituted plugin root`,
      );
    }
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

  assert.match(skill, /separate Bash call/iu);
  assert.match(skill, /Agent skill:/u);
  assert.match(skill, /does not match the tool version/iu);
  assert.match(pipeline, /actual derived\s+`scenario_ref`/iu);
  assert.match(pipeline, /application is already running/iu);
  assert.match(pipeline, /without a target `tsconfig`/iu);
  assert.match(mutationCheck, /Run mutation check/iu);
  assert.match(mutationCheck, /checkout is not changed/iu);
});

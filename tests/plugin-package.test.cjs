const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const repositoryRoot = path.resolve(__dirname, '..');

function readJson(relativePath) {
  return JSON.parse(
    readFileSync(path.join(repositoryRoot, relativePath), 'utf8'),
  );
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

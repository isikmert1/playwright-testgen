const assert = require('node:assert/strict');
const { existsSync, readFileSync, statSync } = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const repositoryRoot = path.resolve(__dirname, '..');

const requiredDirectories = [
  '.claude-plugin',
  '.github/workflows',
  'agents',
  'benchmarks',
  'commands',
  'evals/fixtures',
  'evals/seeded-bugs',
  'hooks',
  'schemas',
  'scripts',
  'skills',
  'tests',
];

const requiredFiles = [
  '.claude-plugin/marketplace.json',
  '.claude-plugin/plugin.json',
  '.editorconfig',
  '.gitattributes',
  '.github/workflows/ci.yml',
  '.gitignore',
  '.prettierignore',
  '.prettierrc.json',
  'NOTICE',
  'eslint.config.js',
  'package-lock.json',
  'package.json',
  'README.md',
];

const pluginDescription =
  'Generates Playwright end-to-end tests grounded in a running app and rejects vacuous tests.';

function readJson(relativePath) {
  return JSON.parse(
    readFileSync(path.join(repositoryRoot, relativePath), 'utf8'),
  );
}

function readText(relativePath) {
  return readFileSync(path.join(repositoryRoot, relativePath), 'utf8');
}

test('ships the required repository scaffold', () => {
  for (const directory of requiredDirectories) {
    const directoryPath = path.join(repositoryRoot, directory);
    assert.equal(
      existsSync(directoryPath),
      true,
      `Missing directory: ${directory}`,
    );
    assert.equal(
      statSync(directoryPath).isDirectory(),
      true,
      `Not a directory: ${directory}`,
    );
  }

  for (const file of requiredFiles) {
    const filePath = path.join(repositoryRoot, file);
    assert.equal(existsSync(filePath), true, `Missing file: ${file}`);
    assert.equal(statSync(filePath).isFile(), true, `Not a file: ${file}`);
  }
});

test('binds the plugin and marketplace metadata without release versions', () => {
  const pluginManifest = readJson('.claude-plugin/plugin.json');
  const marketplaceManifest = readJson('.claude-plugin/marketplace.json');
  const marketplacePlugin = marketplaceManifest.plugins[0];

  assert.equal(pluginManifest.name, 'playwright-testgen');
  assert.equal(pluginManifest.displayName, 'Playwright Testgen');
  assert.equal(pluginManifest.description, pluginDescription);
  assert.equal(pluginManifest.author.name, 'isikmert');
  assert.equal(
    pluginManifest.repository,
    'https://github.com/isikmert1/playwright-testgen',
  );
  assert.equal(pluginManifest.license, 'Apache-2.0');
  assert.equal(pluginManifest.version, undefined);

  assert.equal(marketplaceManifest.name, pluginManifest.name);
  assert.equal(marketplaceManifest.description, pluginDescription);
  assert.equal(marketplaceManifest.owner.name, 'isikmert');
  assert.equal(marketplaceManifest.owner.url, 'https://github.com/isikmert1');
  assert.equal(marketplaceManifest.version, undefined);
  assert.equal(marketplaceManifest.plugins.length, 1);
  assert.equal(marketplacePlugin.name, pluginManifest.name);
  assert.equal(marketplacePlugin.description, pluginDescription);
  assert.equal(marketplacePlugin.source, './');
  assert.equal(marketplacePlugin.version, undefined);
});

test('uses reproducible tooling without Playwright dependencies', () => {
  const packageJson = readJson('package.json');
  const dependencies = packageJson.dependencies ?? {};
  const devDependencies = packageJson.devDependencies ?? {};
  const peerDependencies = packageJson.peerDependencies ?? {};

  assert.equal(packageJson.private, true);
  assert.equal(packageJson.version, '0.0.0');
  assert.equal(packageJson.scripts.format, 'prettier --write .');
  assert.equal(packageJson.scripts['format:check'], 'prettier --check .');
  assert.equal(packageJson.scripts.lint, 'eslint .');
  assert.equal(packageJson.scripts.test, 'node --test');
  assert.equal(
    packageJson.scripts.check,
    'npm run format:check && npm run lint && npm test',
  );

  for (const version of Object.values(devDependencies)) {
    assert.notEqual(version, 'latest');
  }

  for (const dependencyGroup of [
    dependencies,
    devDependencies,
    peerDependencies,
  ]) {
    assert.equal('playwright' in dependencyGroup, false);
    assert.equal('@playwright/test' in dependencyGroup, false);
  }
});

test('keeps shared Claude settings and project JSON visible', () => {
  const ignoredPaths = readText('.gitignore').trim().split('\n');

  assert.equal(ignoredPaths.includes('.claude/settings.local.json'), true);
  assert.equal(ignoredPaths.includes('.claude/'), false);
  assert.equal(ignoredPaths.includes('*.local.json'), false);
});

test('defines the Node 24 CI check contract', () => {
  const workflow = readText('.github/workflows/ci.yml');

  assert.match(workflow, /^permissions:\n {2}contents: read$/m);
  assert.match(workflow, /uses: actions\/checkout@v6/);
  assert.match(workflow, /uses: actions\/setup-node@v6/);
  assert.match(workflow, /node-version: 24/);
  assert.match(workflow, /- run: npm ci/);
  assert.match(workflow, /- run: npm run check/);
});

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  createProfile,
  validateProfile,
} = require('../scripts/setup-profile.cjs');
const {
  gradeSetupProfile,
  repositorySnapshot,
} = require('../scripts/run-setup-eval.cjs');

const source = path.resolve(
  __dirname,
  '..',
  'evals',
  'targets',
  'semantic-only',
  'repository',
);

function git(repository, ...args) {
  const result = spawnSync('git', args, { cwd: repository, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}

test('grades an ignored, target-correct setup profile and rejects other writes', () => {
  const repository = mkdtempSync(path.join(tmpdir(), 'testgen-setup-eval-'));
  try {
    cpSync(source, repository, { recursive: true });
    git(repository, 'init', '--quiet');
    git(repository, 'config', 'user.name', 'Test');
    git(repository, 'config', 'user.email', 'test@example.invalid');
    git(repository, 'add', '--all');
    git(repository, 'commit', '--quiet', '-m', 'fixture');
    const before = {
      ignore: readFileSync(path.join(repository, '.gitignore'), 'utf8'),
      snapshot: repositorySnapshot(repository),
    };
    writeFileSync(
      path.join(repository, '.gitignore'),
      `${before.ignore}.playwright-testgen/profile.v1.json\n`,
    );
    createProfile({
      repository,
      selectedPackage: '.',
      selectedConfig: 'playwright.config.cjs',
    });
    const { profile } = validateProfile({ repository });
    assert.deepEqual(gradeSetupProfile(repository, profile, before), {
      package: '.',
      config: 'playwright.config.cjs',
      test_id: 'none-found',
      existing_tests: 0,
      authentication: 'unknown',
    });
    writeFileSync(path.join(repository, 'public', 'app.js'), 'changed\n');
    assert.throws(
      () => gradeSetupProfile(repository, profile, before),
      /setup-target-changed/u,
    );
    writeFileSync(
      path.join(repository, 'public', 'app.js'),
      readFileSync(path.join(source, 'public', 'app.js')),
    );
    mkdirSync(path.join(repository, 'node_modules'));
    writeFileSync(
      path.join(repository, 'node_modules', 'unexpected.txt'),
      'changed',
    );
    assert.throws(
      () => gradeSetupProfile(repository, profile, before),
      /setup-target-changed/u,
    );
    rmSync(path.join(repository, 'node_modules'), { recursive: true });
    const gitConfig = path.join(repository, '.git', 'config');
    const originalConfig = readFileSync(gitConfig, 'utf8');
    writeFileSync(
      gitConfig,
      `${originalConfig}\n[alias]\n\tunapproved = status\n`,
    );
    assert.throws(
      () => gradeSetupProfile(repository, profile, before),
      /setup-target-changed/u,
    );
    writeFileSync(gitConfig, originalConfig);
    mkdirSync(path.join(repository, '.playwright-cli'), { recursive: true });
    writeFileSync(
      path.join(repository, '.playwright-cli', 'hidden.txt'),
      'unexpected',
    );
    assert.throws(
      () => gradeSetupProfile(repository, profile, before),
      /setup-target-changed/u,
    );
    rmSync(path.join(repository, '.playwright-cli', 'hidden.txt'));
    git(repository, 'commit', '--allow-empty', '--quiet', '-m', 'unexpected');
    assert.throws(
      () => gradeSetupProfile(repository, profile, before),
      /setup-target-changed/u,
    );
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

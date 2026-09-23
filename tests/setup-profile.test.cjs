const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const test = require('node:test');

const script = path.resolve(__dirname, '..', 'scripts', 'setup-profile.cjs');
const profilePath = '.playwright-testgen/profile.v1.json';

function run(cwd, args) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd,
    encoding: 'utf8',
  });
  return { ...result, report: JSON.parse(result.stdout) };
}

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function repository(files = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'testgen-setup-profile-'));
  const defaults = {
    '.gitignore': '.playwright-testgen/profile.v1.json\n.auth/user.json\n',
    'package.json': JSON.stringify({
      devDependencies: { '@playwright/test': '1.62.1', playwright: '1.62.1' },
      private: true,
    }),
    'playwright.config.ts': 'export default { testDir: "./tests" };\n',
    'src/app.tsx':
      'export const App = () => <button data-test="save">Save</button>;\n',
    ...files,
  };
  for (const [relative, contents] of Object.entries(defaults)) {
    if (contents === null) continue;
    const filename = path.join(root, relative);
    mkdirSync(path.dirname(filename), { recursive: true });
    writeFileSync(filename, contents);
  }
  git(root, 'init', '--quiet');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'config', 'user.email', 'test@example.invalid');
  git(root, 'add', '--all');
  git(root, 'commit', '--quiet', '-m', 'fixture');
  return root;
}

function withRepository(files, callback) {
  const root = repository(files);
  try {
    callback(root);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
}

test('publishes one ignored profile atomically and validates freshness', () => {
  withRepository({}, (root) => {
    const created = run(root, [
      'create',
      '--repo',
      '.',
      '--package',
      '.',
      '--config',
      'playwright.config.ts',
    ]);

    assert.equal(created.status, 0, created.stderr);
    assert.equal(created.report.ok, true);
    assert.equal(created.report.status, 'profile-created');
    assert.equal(created.report.path, profilePath);
    const profile = JSON.parse(readFileSync(path.join(root, profilePath)));
    assert.equal(profile.schema_version, 'repository-profile.v1');
    assert.deepEqual(profile.selection, {
      package: '.',
      config_mode: 'config',
      config: 'playwright.config.ts',
    });
    assert.equal(profile.scan.status, 'complete');
    assert.equal(profile.facts.test_id.attribute, 'data-test');
    assert.equal(Object.hasOwn(profile, 'credentials'), false);
    assert.equal(git(root, 'status', '--short'), '');

    const valid = run(root, ['validate', '--repo', '.']);
    assert.equal(valid.status, 0, valid.stderr);
    assert.equal(valid.report.status, 'fresh');
    assert.equal(valid.report.profile.facts.test_id.attribute, 'data-test');

    writeFileSync(
      path.join(root, 'src', 'new.ts'),
      'export const value = 1;\n',
    );
    const stale = run(root, ['validate', '--repo', '.']);
    assert.equal(stale.status, 1);
    assert.equal(stale.report.error, 'profile-stale');
    assert.equal(stale.report.reason, 'repository-membership-changed');
  });
});

test('rejects missing, unsupported, and unbound profile facts', () => {
  withRepository({}, (root) => {
    const created = run(root, [
      'create',
      '--repo',
      '.',
      '--package',
      '.',
      '--config',
      'playwright.config.ts',
    ]);
    assert.equal(created.status, 0, created.stderr);
    const filename = path.join(root, profilePath);
    const original = JSON.parse(readFileSync(filename, 'utf8'));
    for (const mutate of [
      (profile) => delete profile.facts,
      (profile) => {
        profile.facts.unsupported = { command: 'npm run anything' };
      },
      (profile) => {
        profile.facts.test_id.status = 'configured';
      },
      (profile) => {
        profile.facts.framework_status = 'detected';
      },
      (profile) => {
        profile.facts.test_id.counts['data-test'] += 1;
      },
      (profile) => {
        profile.facts.test_id.evidence = ['../secrets.json'];
      },
      (profile) => {
        profile.scan.inspected_paths = [];
      },
    ]) {
      const profile = structuredClone(original);
      mutate(profile);
      writeFileSync(filename, JSON.stringify(profile));
      const result = run(root, ['validate', '--repo', '.']);
      assert.equal(result.status, 1);
      assert.equal(result.report.error, 'profile-invalid');
    }
  });
});

test('invalidates a configless profile when an ignored default config appears', () => {
  withRepository(
    {
      '.gitignore':
        '.playwright-testgen/profile.v1.json\nplaywright.config.ts\n',
      'playwright.config.ts': null,
    },
    (root) => {
      const created = run(root, [
        'create',
        '--repo',
        '.',
        '--package',
        '.',
        '--configless',
      ]);
      assert.equal(created.status, 0, created.stderr);
      writeFileSync(
        path.join(root, 'playwright.config.ts'),
        'export default {};\n',
      );
      const result = run(root, ['validate', '--repo', '.']);
      assert.equal(result.status, 1);
      assert.equal(result.report.error, 'profile-invalid');
    },
  );
});

test('requires an ignored untracked destination and preserves an old profile on failure', () => {
  withRepository({ '.gitignore': '', 'playwright.config.ts': null }, (root) => {
    let result = run(root, [
      'create',
      '--repo',
      '.',
      '--package',
      '.',
      '--configless',
    ]);
    assert.equal(result.status, 1);
    assert.equal(result.report.error, 'profile-path-not-ignored');
    assert.equal(existsSync(path.join(root, profilePath)), false);

    writeFileSync(path.join(root, '.gitignore'), `${profilePath}\n`);
    result = run(root, [
      'create',
      '--repo',
      '.',
      '--package',
      '.',
      '--configless',
    ]);
    assert.equal(result.status, 0, result.stderr);
    const before = readFileSync(path.join(root, profilePath), 'utf8');

    result = run(root, [
      'create',
      '--repo',
      '.',
      '--package',
      'missing',
      '--configless',
    ]);
    assert.equal(result.status, 1);
    assert.equal(result.report.error, 'package-selection-invalid');
    assert.equal(readFileSync(path.join(root, profilePath), 'utf8'), before);
  });
});

test('rejects wrong-target profiles and validates opaque auth-state destinations', () => {
  withRepository({}, (root) => {
    let result = run(root, [
      'create',
      '--repo',
      '.',
      '--package',
      '.',
      '--config',
      'playwright.config.ts',
    ]);
    assert.equal(result.status, 0, result.stderr);

    result = run(root, [
      'check-state-path',
      '--repo',
      '.',
      '--path',
      '.auth/user.json',
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.report, {
      ok: true,
      path: '.auth/user.json',
      status: 'available',
    });

    mkdirSync(path.join(root, '.auth'), { recursive: true });
    writeFileSync(path.join(root, '.auth', 'user.json'), '{"secret":"opaque"}');
    result = run(root, [
      'check-state-path',
      '--repo',
      '.',
      '--path',
      '.auth/user.json',
    ]);
    assert.equal(result.status, 1);
    assert.equal(result.report.error, 'state-path-exists');
    assert.doesNotMatch(result.stdout, /secret/u);

    result = run(root, [
      'check-state-path',
      '--repo',
      '.',
      '--path',
      '../state.json',
    ]);
    assert.equal(result.status, 1);
    assert.equal(result.report.error, 'state-path-invalid');

    const other = repository();
    try {
      mkdirSync(path.join(other, '.playwright-testgen'), { recursive: true });
      writeFileSync(
        path.join(other, profilePath),
        readFileSync(path.join(root, profilePath), 'utf8'),
      );
      result = run(other, ['validate', '--repo', '.']);
      assert.equal(result.status, 1);
      assert.equal(result.report.error, 'profile-wrong-target');
    } finally {
      rmSync(other, { force: true, recursive: true });
    }
  });
});

test('rejects symlinked profile storage before writing or reading it', (t) => {
  withRepository({ 'playwright.config.ts': null }, (root) => {
    const outside = mkdtempSync(
      path.join(tmpdir(), 'testgen-profile-outside-'),
    );
    const profileDirectory = path.join(root, '.playwright-testgen');
    try {
      try {
        symlinkSync(outside, profileDirectory, 'junction');
      } catch (error) {
        if (error.code === 'EPERM') return t.skip('junctions unavailable');
        throw error;
      }
      let result = run(root, [
        'create',
        '--repo',
        '.',
        '--package',
        '.',
        '--configless',
      ]);
      assert.equal(result.status, 1);
      assert.equal(result.report.error, 'profile-path-invalid');
      assert.equal(existsSync(path.join(outside, 'profile.v1.json')), false);

      rmSync(profileDirectory);
      mkdirSync(profileDirectory);
      result = run(root, [
        'create',
        '--repo',
        '.',
        '--package',
        '.',
        '--configless',
      ]);
      assert.equal(result.status, 0, result.stderr);
      const original = readFileSync(path.join(root, profilePath));
      rmSync(path.join(root, profilePath));
      writeFileSync(path.join(outside, 'profile.v1.json'), original);
      symlinkSync(
        path.join(outside, 'profile.v1.json'),
        path.join(root, profilePath),
        'file',
      );
      result = run(root, ['validate', '--repo', '.']);
      assert.equal(result.status, 1);
      assert.equal(result.report.error, 'profile-path-invalid');
    } finally {
      if (existsSync(profileDirectory)) {
        rmSync(profileDirectory, {
          force: true,
          recursive: !lstatSync(profileDirectory).isSymbolicLink(),
        });
      }
      rmSync(outside, { force: true, recursive: true });
    }
  });
});

test('marks content changes and incomplete fingerprints stale', () => {
  withRepository({}, (root) => {
    let result = run(root, [
      'create',
      '--repo',
      '.',
      '--package',
      '.',
      '--config',
      'playwright.config.ts',
    ]);
    assert.equal(result.status, 0, result.stderr);

    writeFileSync(path.join(root, 'src', 'app.tsx'), 'export const App = 2;\n');
    result = run(root, ['validate', '--repo', '.']);
    assert.equal(result.status, 1);
    assert.equal(result.report.error, 'profile-stale');
    assert.equal(result.report.reason, 'repository-content-changed');
  });
});

test('ignores generated run output while checking profile freshness', () => {
  withRepository({}, (root) => {
    const created = run(root, [
      'create',
      '--repo',
      '.',
      '--package',
      '.',
      '--config',
      'playwright.config.ts',
    ]);
    assert.equal(created.status, 0, created.stderr);
    const scratch = path.join(root, '.playwright-cli', 'testgen', 'tg-output');
    mkdirSync(scratch, { recursive: true });
    writeFileSync(path.join(scratch, 'trace.zip'), 'generated output');
    const validated = run(root, ['validate', '--repo', '.']);
    assert.equal(validated.status, 0, validated.stderr);
    assert.equal(validated.report.status, 'fresh');
  });
});

test('scopes membership changes to the selected package', () => {
  withRepository(
    {
      'apps/web/package.json': '{"private":true}\n',
      'apps/web/playwright.config.ts': 'export default {};\n',
      'apps/web/src/page.tsx': '<div data-test="page" />\n',
      'apps/other/package.json': '{"private":true}\n',
    },
    (root) => {
      const created = run(root, [
        'create',
        '--repo',
        '.',
        '--package',
        'apps/web',
        '--config',
        'apps/web/playwright.config.ts',
      ]);
      assert.equal(created.status, 0, created.stderr);
      writeFileSync(path.join(root, 'apps', 'other', 'new.ts'), 'export {};\n');
      let validated = run(root, ['validate', '--repo', '.']);
      assert.equal(validated.status, 0, validated.stderr);

      renameSync(
        path.join(root, 'apps', 'web', 'src', 'page.tsx'),
        path.join(root, 'apps', 'web', 'src', 'renamed.tsx'),
      );
      validated = run(root, ['validate', '--repo', '.']);
      assert.equal(validated.status, 1);
      assert.equal(validated.report.error, 'profile-stale');
    },
  );
});

test('ignores runtime data changes outside the static inspection scope', () => {
  withRepository({ 'data/database.json': '{"counter":0}\n' }, (root) => {
    const created = run(root, [
      'create',
      '--repo',
      '.',
      '--package',
      '.',
      '--config',
      'playwright.config.ts',
    ]);
    assert.equal(created.status, 0, created.stderr);
    writeFileSync(path.join(root, 'data', 'database.json'), '{"counter":1}\n');

    const validated = run(root, ['validate', '--repo', '.']);
    assert.equal(validated.status, 0, validated.stderr);
    assert.equal(validated.report.status, 'fresh');
  });
});

test('detects re-edits to already-dirty inspected source files', () => {
  withRepository({ 'src/secondary.ts': 'export const n = 1;\n' }, (root) => {
    const source = path.join(root, 'src', 'secondary.ts');
    writeFileSync(source, 'export const n = 2;\n');
    const created = run(root, [
      'create',
      '--repo',
      '.',
      '--package',
      '.',
      '--config',
      'playwright.config.ts',
    ]);
    assert.equal(created.status, 0, created.stderr);
    writeFileSync(source, 'export const n = 3;\n');

    const validated = run(root, ['validate', '--repo', '.']);
    assert.equal(validated.status, 1);
    assert.equal(validated.report.error, 'profile-stale');
  });
});

test('records only an approved auth mechanism and path after verification', () => {
  withRepository({}, (root) => {
    let result = run(root, [
      'create',
      '--repo',
      '.',
      '--package',
      '.',
      '--config',
      'playwright.config.ts',
    ]);
    assert.equal(result.status, 0, result.stderr);
    mkdirSync(path.join(root, '.auth'), { recursive: true });
    writeFileSync(path.join(root, '.auth', 'user.json'), '{"secret":"opaque"}');

    result = run(root, [
      'set-auth',
      '--repo',
      '.',
      '--kind',
      'storage-state',
      '--path',
      '.auth/user.json',
    ]);
    assert.equal(result.status, 0, result.stderr);
    const profileText = readFileSync(path.join(root, profilePath), 'utf8');
    const profile = JSON.parse(profileText);
    assert.deepEqual(profile.authentication, {
      mechanism: 'storage-state',
      path: '.auth/user.json',
    });
    assert.doesNotMatch(profileText, /secret|opaque/u);

    result = run(root, [
      'create',
      '--repo',
      '.',
      '--package',
      '.',
      '--config',
      'playwright.config.ts',
    ]);
    assert.equal(result.status, 0, result.stderr);
    const refreshed = JSON.parse(readFileSync(path.join(root, profilePath)));
    assert.equal(Object.hasOwn(refreshed, 'authentication'), false);
  });
});

test('rejects a tracked state file even when an ignore rule matches it', () => {
  withRepository({}, (root) => {
    mkdirSync(path.join(root, '.auth'), { recursive: true });
    writeFileSync(path.join(root, '.auth', 'user.json'), '{}\n');
    git(root, 'add', '--force', '.auth/user.json');
    const result = run(root, [
      'check-state-path',
      '--repo',
      '.',
      '--path',
      '.auth/user.json',
      '--replace',
    ]);
    assert.equal(result.status, 1);
    assert.equal(result.report.error, 'state-path-tracked');
  });
});

test('rejects edited package, config, and auth bindings in an ignored profile', () => {
  withRepository({}, (root) => {
    const created = run(root, [
      'create',
      '--repo',
      '.',
      '--package',
      '.',
      '--config',
      'playwright.config.ts',
    ]);
    assert.equal(created.status, 0, created.stderr);
    const filename = path.join(root, profilePath);
    const original = JSON.parse(readFileSync(filename, 'utf8'));
    for (const change of [
      { selection: { ...original.selection, package: '../outside' } },
      { selection: { ...original.selection, config: '../outside.config.ts' } },
      { selection: { ...original.selection, config: 'src/app.tsx' } },
      {
        authentication: { mechanism: 'storage-state', path: '../secret.json' },
      },
    ]) {
      writeFileSync(
        filename,
        `${JSON.stringify({ ...original, ...change })}\n`,
      );
      const result = run(root, ['validate', '--repo', '.']);
      assert.equal(result.status, 1);
      assert.equal(result.report.error, 'profile-invalid');
    }
  });
});

test('does not fingerprint credential-like paths named by an edited profile', () => {
  withRepository({}, (root) => {
    const created = run(root, [
      'create',
      '--repo',
      '.',
      '--package',
      '.',
      '--config',
      'playwright.config.ts',
    ]);
    assert.equal(created.status, 0, created.stderr);
    mkdirSync(path.join(root, '.auth'), { recursive: true });
    writeFileSync(path.join(root, '.auth', 'user.json'), '{"secret":"opaque"}');
    const filename = path.join(root, profilePath);
    const profile = JSON.parse(readFileSync(filename, 'utf8'));
    profile.freshness.sources['.auth/user.json'] = '0'.repeat(64);
    profile.scan.inspected_paths.push('.auth/user.json');
    writeFileSync(filename, `${JSON.stringify(profile)}\n`);

    const result = run(root, ['validate', '--repo', '.']);
    assert.equal(result.status, 1);
    assert.equal(result.report.error, 'profile-source-invalid');
    assert.doesNotMatch(result.stdout, /secret|opaque/u);
  });
});

test('rejects oversized source evidence before reading its contents', () => {
  withRepository({ 'public/huge.bin': 'x'.repeat(70 * 1024) }, (root) => {
    const created = run(root, [
      'create',
      '--repo',
      '.',
      '--package',
      '.',
      '--config',
      'playwright.config.ts',
    ]);
    assert.equal(created.status, 0, created.stderr);
    const filename = path.join(root, profilePath);
    const profile = JSON.parse(readFileSync(filename, 'utf8'));
    profile.freshness.sources['public/huge.bin'] = '0'.repeat(64);
    profile.scan.inspected_paths.push('public/huge.bin');
    writeFileSync(filename, `${JSON.stringify(profile)}\n`);

    const fs = require('node:fs');
    const originalRead = fs.readFileSync;
    const oversized = path.join(root, 'public', 'huge.bin');
    fs.readFileSync = function guardedRead(value, ...args) {
      if (path.resolve(value) === oversized)
        throw new Error('oversized source was read');
      return originalRead.call(this, value, ...args);
    };
    delete require.cache[require.resolve(script)];
    try {
      const { validateProfile } = require(script);
      assert.throws(
        () => validateProfile({ repository: root }),
        (error) => error.code === 'profile-fingerprint-incomplete',
      );
    } finally {
      fs.readFileSync = originalRead;
      delete require.cache[require.resolve(script)];
    }
  });
});

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const test = require('node:test');

const profiler = path.resolve(__dirname, '..', 'scripts', 'profile-repo.cjs');

function write(root, relativePath, contents) {
  const filename = path.join(root, relativePath);
  mkdirSync(path.dirname(filename), { recursive: true });
  writeFileSync(filename, contents);
}

function fixture(files, callback) {
  const root = mkdtempSync(path.join(tmpdir(), 'testgen-profile-'));
  try {
    const git = spawnSync('git', ['init', '--quiet'], { cwd: root });
    assert.equal(git.status, 0);
    for (const [relativePath, contents] of Object.entries(files))
      write(root, relativePath, contents);
    callback(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function run(root, ...args) {
  const result = spawnSync(
    process.execPath,
    [profiler, '--repo', root, ...args],
    { encoding: 'utf8', timeout: 10_000 },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

test('profiles one selected package without running scripts or writing files', () => {
  fixture(
    {
      'package.json': JSON.stringify({
        dependencies: { react: '18.2.0' },
        scripts: {
          lint: "node -e \"require('fs').writeFileSync('ran','yes')\"",
        },
      }),
      'playwright.config.cjs': "module.exports = { testDir: './tests' };\n",
      'src/Card.tsx':
        'import Button from \'@mui/material/Button\';\nexport const Card = () => <Button data-test="save">Save</Button>;\n',
      'tests/auth.spec.ts':
        "test.use({ storageState: 'playwright/.auth/user.json' });\n",
    },
    (root) => {
      const before = readdirSync(root).sort();
      const report = run(root);
      assert.equal(report.ok, true);
      assert.equal(report.root, root);
      assert.equal(report.selection.status, 'selected');
      assert.equal(report.selection.package, '.');
      assert.equal(report.selection.config, 'playwright.config.cjs');
      assert.equal(report.scan.status, 'complete');
      assert.equal(report.facts.test_id.status, 'detected');
      assert.equal(report.facts.test_id.attribute, 'data-test');
      assert.ok(report.facts.frameworks.some((item) => item.name === 'react'));
      assert.ok(
        report.facts.component_libraries.some(
          (item) => item.name === '@mui/material',
        ),
      );
      assert.ok(report.facts.scripts.lint.includes('lint'));
      assert.ok(
        report.facts.authentication.mechanisms.some(
          (item) => item.kind === 'storage-state-use',
        ),
      );
      assert.deepEqual(readdirSync(root).sort(), before);
      assert.equal(existsSync(path.join(root, 'ran')), false);
      assert.ok(Buffer.byteLength(JSON.stringify(report)) <= 64 * 1024);
      assert.doesNotMatch(JSON.stringify(report), /writeFileSync/u);
    },
  );
});

test('requires explicit package and config selection when either is ambiguous', () => {
  fixture(
    {
      'package.json': JSON.stringify({
        private: true,
        workspaces: ['apps/*'],
      }),
      'apps/one/package.json': JSON.stringify({
        dependencies: { react: '18.2.0' },
      }),
      'apps/two/package.json': JSON.stringify({
        dependencies: { vue: '3.0.0' },
      }),
      'apps/one/playwright.config.ts': 'export default {};\n',
      'apps/one/playwright.config.mts': 'export default {};\n',
      'apps/one/src/page.tsx': '<div data-testid="one" />\n',
      'apps/two/src/page.vue': '<div data-cy="two" />\n',
    },
    (root) => {
      const unselected = run(root);
      assert.equal(unselected.selection.status, 'package-required');
      assert.deepEqual(unselected.selection.packages, [
        '.',
        'apps/one',
        'apps/two',
      ]);
      assert.equal(unselected.facts, null);

      const packageOnly = run(root, '--package', 'apps/one');
      assert.equal(packageOnly.selection.status, 'config-required');
      assert.deepEqual(packageOnly.selection.configs, [
        'apps/one/playwright.config.mts',
        'apps/one/playwright.config.ts',
      ]);

      const selected = run(
        root,
        '--package',
        'apps/one',
        '--config',
        'apps/one/playwright.config.ts',
      );
      assert.equal(selected.selection.status, 'selected');
      assert.equal(selected.selection.package, 'apps/one');
      assert.equal(selected.selection.config, 'apps/one/playwright.config.ts');
      assert.equal(selected.facts.test_id.attribute, 'data-testid');
      assert.ok(
        selected.facts.frameworks.some((item) => item.name === 'react'),
      );
      assert.ok(selected.facts.frameworks.every((item) => item.name !== 'vue'));
    },
  );
});

test('keeps an unknown-framework workspace package selectable beside a known one', () => {
  fixture(
    {
      'package.json': JSON.stringify({ workspaces: ['apps/*'] }),
      'apps/known/package.json': JSON.stringify({
        dependencies: { react: '18.2.0' },
      }),
      'apps/unknown/package.json': JSON.stringify({
        dependencies: { 'unlisted-view-runtime': '1.0.0' },
      }),
    },
    (root) => {
      const report = run(root);
      assert.equal(report.selection.status, 'package-required');
      assert.ok(report.selection.packages.includes('apps/unknown'));
      const selected = run(root, '--package', 'apps/unknown');
      assert.equal(selected.selection.package, 'apps/unknown');
      assert.equal(selected.facts.framework_status, 'unknown');
    },
  );
});

test('uses exact attribute boundaries and requires config evidence for custom IDs', () => {
  fixture(
    {
      'package.json': '{}',
      'playwright.config.ts':
        "export default { use: { testIdAttribute: 'qa-id' } };\n",
      'src/page.tsx':
        '<div qa-id="save" qa-id-extra="ignore" data-test-id="ignore" />\n',
    },
    (root) => {
      const report = run(root);
      assert.equal(report.facts.test_id.status, 'detected');
      assert.equal(report.facts.test_id.attribute, 'qa-id');
      assert.equal(report.facts.test_id.counts['qa-id'], 1);
      assert.equal(report.facts.test_id.counts['data-test'], 0);
      assert.equal(report.facts.test_id.counts['data-testid'], 0);
      assert.equal(report.facts.test_id.config_attribute, 'qa-id');
    },
  );
});

test('does not cross a nested Git root or follow a symlinked source', (t) => {
  fixture(
    {
      'package.json': '{}',
      'src/page.tsx': '<div data-testid="owned" />\n',
      'vendor/foreign/package.json': JSON.stringify({
        dependencies: { vue: '3.0.0' },
      }),
      'vendor/foreign/src/page.vue': '<div data-cy="foreign" />\n',
    },
    (root) => {
      const nested = path.join(root, 'vendor', 'foreign');
      const git = spawnSync('git', ['init', '--quiet'], { cwd: nested });
      assert.equal(git.status, 0);
      const outside = mkdtempSync(path.join(tmpdir(), 'testgen-secret-'));
      try {
        write(outside, 'secret.tsx', '<div data-cy="secret" />\n');
        try {
          symlinkSync(
            path.join(outside, 'secret.tsx'),
            path.join(root, 'src', 'linked.tsx'),
            'file',
          );
        } catch (error) {
          if (['EPERM', 'EACCES'].includes(error.code)) {
            t.diagnostic('symlink creation unavailable on this host');
          } else {
            throw error;
          }
        }

        const report = run(root);
        assert.equal(report.facts.test_id.attribute, 'data-testid');
        assert.ok(report.scan.nested_repositories.includes('vendor/foreign'));
        assert.doesNotMatch(JSON.stringify(report), /secret|foreign\/src/u);
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }
    },
  );
});

test('does not read a tracked source path redirected into excluded storage', (t) => {
  fixture(
    {
      'package.json': '{}',
      'src/linked/private.tsx': '<div />\n',
      '.auth/private.tsx': '<div data-cy="secret" />\n',
    },
    (root) => {
      const add = spawnSync('git', ['add', '--', 'src/linked/private.tsx'], {
        cwd: root,
      });
      assert.equal(add.status, 0);
      rmSync(path.join(root, 'src', 'linked'), { recursive: true });
      try {
        symlinkSync(
          path.join(root, '.auth'),
          path.join(root, 'src', 'linked'),
          process.platform === 'win32' ? 'junction' : 'dir',
        );
      } catch (error) {
        if (['EPERM', 'EACCES'].includes(error.code)) {
          t.diagnostic('directory symlink creation unavailable on this host');
          return;
        }
        throw error;
      }
      const report = run(root);
      assert.equal(report.facts.test_id.status, 'none-found');
      assert.equal(report.facts.test_id.counts['data-cy'], 0);
      assert.ok(
        report.scan.read_paths.every((item) => !item.includes('private.tsx')),
      );
    },
  );
});

test('reports partial evidence rather than none-found after a read budget', () => {
  fixture(
    {
      'package.json': '{}',
      'src/a.tsx': '<div />\n',
      'src/b.tsx': '<div data-testid="late" />\n',
    },
    (root) => {
      const { profileRepository } = require('../scripts/profile-repo.cjs');
      const report = profileRepository({
        repository: root,
        limits: { maxFilesRead: 1 },
      });
      assert.equal(report.scan.status, 'partial');
      assert.equal(report.scan.stop_reason, 'file-budget');
      assert.equal(report.facts.test_id.status, 'unknown');
      assert.equal(report.facts.authentication.status, 'unknown');
    },
  );
});

test('does not report unread test files as inspected layout evidence', () => {
  fixture(
    {
      'package.json': '{}',
      'tests/unread.spec.ts': 'test("unread", () => {});\n',
    },
    (root) => {
      const { profileRepository } = require('../scripts/profile-repo.cjs');
      const report = profileRepository({
        repository: root,
        limits: { maxFilesRead: 1 },
      });
      assert.equal(report.scan.status, 'partial');
      assert.deepEqual(report.facts.layout.tests, []);
      assert.deepEqual(report.facts.layout.naming, {});
    },
  );
});

test('reports only auth mechanisms, never credential values', () => {
  fixture(
    {
      'package.json': JSON.stringify({
        dependencies: { '@auth0/auth0-react': '2.0.0' },
      }),
      'src/auth.ts':
        "const password = 'do-not-report-me';\nexport const login = () => password;\n",
      '.auth/session.tsx': '<div data-cy="secret" />\n',
      '.playwright-testgen/profile.tsx': '<div data-cy="profile" />\n',
    },
    (root) => {
      const report = run(root);
      assert.equal(report.facts.authentication.status, 'detected');
      assert.ok(
        report.facts.authentication.mechanisms.some(
          (item) => item.kind === 'auth-dependency',
        ),
      );
      assert.equal(report.facts.test_id.status, 'none-found');
      assert.doesNotMatch(
        JSON.stringify(report),
        /do-not-report-me|session\.tsx|profile\.tsx/u,
      );
    },
  );
});

test('does not promote a test-only selector to a source convention', () => {
  fixture(
    {
      'package.json': '{}',
      'src/page.tsx': '<button>Save</button>\n',
      'tests/page.spec.ts': 'page.locator(\'[data-test="save"]\');\n',
    },
    (root) => {
      const report = run(root);
      assert.equal(report.facts.test_id.counts['data-test'], 1);
      assert.equal(report.facts.test_id.source_counts['data-test'], 0);
      assert.equal(report.facts.test_id.status, 'unknown');
      assert.equal(report.facts.test_id.attribute, null);
    },
  );
});

test('keeps dynamic test-id configuration inconclusive', () => {
  fixture(
    {
      'package.json': '{}',
      'playwright.config.ts':
        'export default { use: { testIdAttribute: process.env.TEST_ATTR } };\n',
      'src/page.tsx': '<div qa-id="save" />\n',
    },
    (root) => {
      const report = run(root);
      assert.equal(report.facts.test_id.status, 'unknown');
      assert.equal(report.facts.test_id.attribute, null);
    },
  );
});

test('does not promote commented or mixed test-id config to a convention', () => {
  for (const { config, expectedStatus } of [
    {
      config:
        "export default { use: { testIdAttribute: 'data-test', fallback: process.env.X, testIdAttribute: process.env.TEST_ATTR } };\n",
      expectedStatus: 'unknown',
    },
    {
      config: "// testIdAttribute: 'data-test'\nexport default { use: {} };\n",
      expectedStatus: 'detected',
    },
  ]) {
    fixture(
      {
        'package.json': '{}',
        'playwright.config.ts': config,
        'src/page.tsx': '<div data-test="save" />\n',
      },
      (root) => {
        const report = run(root);
        assert.equal(report.facts.test_id.status, expectedStatus);
        assert.equal(report.facts.test_id.config_attribute, null);
      },
    );
  }
});

test('reports source and configured test-id conventions that conflict', () => {
  fixture(
    {
      'package.json': '{}',
      'playwright.config.ts':
        "export default { use: { testIdAttribute: 'data-testid' } };\n",
      'src/page.tsx': '<div data-test="save" />\n',
    },
    (root) => {
      const report = run(root);
      assert.equal(report.facts.test_id.status, 'ambiguous');
      assert.equal(report.facts.test_id.attribute, null);
      assert.equal(report.facts.test_id.config_attribute, 'data-testid');
      assert.equal(report.facts.test_id.source_counts['data-test'], 1);
    },
  );
});

test('keeps a literal custom ID after a URL string in the same config', () => {
  fixture(
    {
      'package.json': '{}',
      'playwright.config.ts':
        "export default { use: { baseURL: 'http://localhost:3000', testIdAttribute: 'qa-id' } };\n",
      'src/page.tsx': '<div qa-id="save" />\n',
    },
    (root) => {
      const report = run(root);
      assert.equal(report.facts.test_id.config_attribute, 'qa-id');
      assert.equal(report.facts.test_id.status, 'detected');
      assert.equal(report.facts.test_id.attribute, 'qa-id');
    },
  );
});

test('does not treat a quoted config example as an actual custom ID setting', () => {
  fixture(
    {
      'package.json': '{}',
      'playwright.config.ts':
        'const example = "testIdAttribute: \'qa-id\'"; export default {};\n',
      'src/page.tsx': '<div qa-id="save" />\n',
    },
    (root) => {
      const report = run(root);
      assert.equal(report.facts.test_id.config_attribute, null);
      assert.notEqual(report.facts.test_id.status, 'detected');
    },
  );
});

test('does not treat an unrelated object as exported test-id configuration', () => {
  fixture(
    {
      'package.json': '{}',
      'playwright.config.ts':
        "const example = { testIdAttribute: 'qa-id' }; export default {};\n",
      'src/page.tsx': '<div qa-id="save" />\n',
    },
    (root) => {
      const report = run(root);
      assert.equal(report.facts.test_id.config_attribute, null);
      assert.notEqual(report.facts.test_id.status, 'detected');
    },
  );
});

test('accepts unknown stacks and reports copied local UI components as evidence', () => {
  fixture(
    {
      'package.json': JSON.stringify({
        dependencies: { 'unlisted-view-runtime': '1.0.0' },
      }),
      'src/page.tsx':
        "import { Button } from '@/components/ui/button';\nexport const Page = () => <Button />;\n",
      'src/components/ui/button.tsx': 'export const Button = () => null;\n',
    },
    (root) => {
      const report = run(root);
      assert.equal(report.selection.status, 'config-unavailable');
      assert.equal(report.scan.status, 'complete');
      assert.equal(report.facts.framework_status, 'unknown');
      assert.deepEqual(report.facts.frameworks, []);
      assert.equal(report.facts.component_library_status, 'detected');
      assert.deepEqual(report.facts.component_libraries, [
        { name: 'local-ui-components', evidence: 'src/page.tsx' },
      ]);
    },
  );
});

test('selected workspace package does not absorb sibling source or hoisted dependencies', () => {
  fixture(
    {
      'package.json': JSON.stringify({
        workspaces: ['apps/*'],
        dependencies: { react: '18.2.0' },
      }),
      'src/page.tsx': '<button data-test="root" />\n',
      'apps/child/package.json': JSON.stringify({
        dependencies: { vue: '3.0.0' },
      }),
      'apps/child/src/page.vue': '<button data-cy="child" />\n',
      'node_modules/@playwright/test/source.tsx':
        '<button data-testid="dependency" />\n',
    },
    (root) => {
      const report = run(root, '--package', '.');
      assert.equal(report.selection.status, 'config-unavailable');
      assert.equal(report.facts.test_id.attribute, 'data-test');
      assert.equal(report.facts.test_id.counts['data-cy'], 0);
      assert.equal(report.facts.test_id.counts['data-testid'], 0);
      assert.ok(report.facts.frameworks.some((item) => item.name === 'react'));
      assert.ok(report.facts.frameworks.every((item) => item.name !== 'vue'));
      assert.ok(
        report.scan.read_paths.every(
          (item) => !item.startsWith('node_modules/'),
        ),
      );
    },
  );
});

test('an incomplete inventory cannot claim no package or select one implicitly', () => {
  fixture(
    {
      'a.txt': 'first\n',
      'package.json': '{}',
      'src/page.tsx': '<div data-testid="later" />\n',
    },
    (root) => {
      const {
        DEFAULT_LIMITS,
        profileRepository,
      } = require('../scripts/profile-repo.cjs');
      assert.deepEqual(DEFAULT_LIMITS, {
        maxListedPaths: 4096,
        maxFilesRead: 512,
        maxTotalBytes: 4 * 1024 * 1024,
        maxFileBytes: 64 * 1024,
        maxDurationMs: 5000,
        maxOutputBytes: 64 * 1024,
      });
      const report = profileRepository({
        repository: root,
        limits: { maxListedPaths: 1 },
      });
      assert.equal(report.scan.status, 'partial');
      assert.equal(report.selection.status, 'unknown');
      assert.equal(report.facts, null);
    },
  );
});

test('large findings collapse to a bounded partial report', () => {
  fixture(
    {
      'package.json': JSON.stringify({
        scripts: Object.fromEntries(
          Array.from({ length: 100 }, (_, index) => [
            `lint:area-${index}`,
            'true',
          ]),
        ),
      }),
    },
    (root) => {
      const { profileRepository } = require('../scripts/profile-repo.cjs');
      const report = profileRepository({
        repository: root,
        limits: { maxOutputBytes: 1024 },
      });
      assert.equal(report.scan.status, 'partial');
      assert.equal(report.scan.stop_reason, 'output-budget');
      assert.equal(report.facts, null);
      assert.ok(Buffer.byteLength(JSON.stringify(report)) <= 1024);
    },
  );
});

test('separates Cypress support files from actual tests', () => {
  fixture(
    {
      'package.json': '{}',
      'cypress/support/commands.ts':
        'export const find = () => cy.get(\'[data-test="save"]\');\n',
      'cypress/e2e/orders.ts': 'describe("orders", () => {});\n',
    },
    (root) => {
      const report = run(root);
      assert.deepEqual(report.facts.layout.tests, ['cypress/e2e/orders.ts']);
      assert.deepEqual(report.facts.layout.helpers, [
        'cypress/support/commands.ts',
      ]);
      assert.equal(report.facts.test_id.source_counts['data-test'], 0);
      assert.equal(report.facts.test_id.test_counts['data-test'], 1);
    },
  );
});

test('workspace-child Cypress support does not establish a source convention', () => {
  fixture(
    {
      'package.json': JSON.stringify({ workspaces: ['apps/*'] }),
      'apps/web/package.json': '{}',
      'apps/web/cypress/support/commands.ts':
        'export const find = () => cy.get(\'[data-test="save"]\');\n',
    },
    (root) => {
      const report = run(root, '--package', 'apps/web');
      assert.equal(report.facts.test_id.source_counts['data-test'], 0);
      assert.equal(report.facts.test_id.test_counts['data-test'], 1);
      assert.equal(report.facts.test_id.status, 'unknown');
    },
  );
});

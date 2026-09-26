const assert = require('node:assert/strict');
const { existsSync, mkdtempSync, readFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  authorExecutionAttempts,
  authorProfileAccessAttempts,
  authorPrompt,
} = require('../scripts/run-generation-eval.cjs');
const {
  cleanupEvaluation,
} = require('../scripts/run-healer-defect-refusal.cjs');

test('generation prompt carries only scenario facts and stops at the checkpoint', () => {
  const definition = JSON.parse(
    readFileSync(
      path.join(
        __dirname,
        '..',
        'evals',
        'cases',
        'healthy-generation',
        'case.json',
      ),
      'utf8',
    ),
  );
  const prompt = authorPrompt(definition, {
    run_id: 'tg-0123456789abcdef01234567',
    repository: 'C:/disposable-target',
    origin: 'http://127.0.0.1:4173',
    approved_spec_filter: 'tests/notebook-details.spec.ts',
  });

  assert.match(prompt, /criterion notebook-details-visible:/u);
  assert.match(
    prompt,
    /proposed spec path: tests\/notebook-details\.spec\.ts/u,
  );
  assert.match(prompt, /human has not approved running the candidate/u);
  assert.doesNotMatch(prompt, /adapter-absent|planned_trials|expected:/u);
  const withSetup = authorPrompt(definition, {
    run_id: 'tg-0123456789abcdef01234567',
    repository: 'C:/disposable-target',
    origin: 'http://127.0.0.1:4173',
    approved_spec_filter: 'tests/notebook-details.spec.ts',
    setup_facts: { package: '.', config: 'playwright.config.cjs' },
  });
  assert.match(withSetup, /Main validated its repository profile/u);
  assert.match(withSetup, /profile is Main-owned/u);
  assert.doesNotMatch(withSetup, /No setup profile exists/u);
});

test('generation evidence rejects spec execution but allows collection', () => {
  const stream = (command) =>
    JSON.stringify({
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', name: 'Bash', input: { command } }],
      },
    });

  assert.equal(
    authorExecutionAttempts(
      stream('npx --no playwright test tests/notebook-details.spec.ts --list'),
    ),
    0,
  );
  assert.equal(
    authorExecutionAttempts(
      stream('npx --no playwright test tests/notebook-details.spec.ts'),
    ),
    1,
  );
  assert.equal(authorExecutionAttempts(stream('npm run test:e2e')), 1);
  assert.equal(
    authorExecutionAttempts(
      stream('npx playwright test tests/notebook-details.spec.ts').replace(
        '"name":"Bash"',
        '"name":"PowerShell"',
      ),
    ),
    1,
  );
  assert.equal(
    authorProfileAccessAttempts(
      stream('cat .playwright-testgen/profile.v1.json'),
    ),
    1,
  );
});

test('generation cleanup removes only its owned temporary directory', async (t) => {
  const temporaryRoot = mkdtempSync(
    path.join(tmpdir(), 'testgen-generation-evaluation-'),
  );
  t.after(() => rmSync(temporaryRoot, { force: true, recursive: true }));
  const cleanup = await cleanupEvaluation({
    marketplace_added: false,
    plugin_installed: false,
    repository: null,
    server: null,
    temporaryRoot,
    temporaryPrefix: 'testgen-generation-evaluation-',
  });

  assert.equal(cleanup.status, 'passed');
  assert.equal(existsSync(temporaryRoot), false);
});

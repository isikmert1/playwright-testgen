const assert = require('node:assert/strict');
const {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} = require('node:fs');
const { spawnSync } = require('node:child_process');
const { tmpdir } = require('node:os');
const path = require('node:path');
const test = require('node:test');

const repositoryRoot = path.resolve(__dirname, '..');
const recorder = path.join(
  repositoryRoot,
  'scripts',
  'record-testgen-finding.cjs',
);
const runId = 'tg-0123456789abcdef01234567';

function handoff() {
  return {
    schema_version: 'author-handoff.v1',
    run_id: runId,
    scenario_ref: 'profile-save',
    spec_path: 'tests/account.spec.ts',
    criteria: [
      {
        id: 'criterion-1',
        step_title: 'save profile',
        assertion_location: 'tests/account.spec.ts:18',
        outcome: 'saved profile is visible',
      },
    ],
    locators: [
      {
        purpose: 'save profile',
        locator: "getByRole('button', { name: 'Save' })",
        strategy: 'role',
        live_count: 1,
        visible: true,
      },
    ],
    test_id_convention: 'none-found',
    test_id_additions: [],
    lint: { command: 'npm run lint', status: 'pass', diagnostics: [] },
    test_data_strategy: 'existing-safe-fixture',
    touched_paths: ['tests/account.spec.ts'],
    assumptions: [],
    open_questions: [],
  };
}

function trace() {
  return {
    schema_version: 'healer-trace.v1',
    run_id: runId,
    spec_path: 'tests/account.spec.ts',
    handoff_read: true,
    attempts: [
      {
        number: 1,
        kind: 'verification-run',
        hypothesis:
          'the save action completed but the required state was absent',
        failure_signature: 'saved-state-absent',
        evidence_summary: 'the expected precondition and action were observed',
        classification: 'product-behavior-wrong',
        action: 'stopped without editing the test or product',
        outcome: 'fail',
        product_behavior_evidence: {
          criterion_id: 'criterion-1',
          required_outcome: 'saved profile is visible',
          observed_behavior: 'the profile reverted after the successful action',
          contradiction:
            'the required saved state and observed reverted state differ',
          expectation_drift_rejected:
            'the criterion explicitly requires persistence',
        },
      },
    ],
    repairs: [],
    final_classification: 'product-behavior-wrong',
    disposition: 'product-behavior-wrong',
    next_owner: 'product-owner',
    escalation: 'the criterion and current product behavior conflict',
    cleanup: {
      runner: 'not-started',
      browser_session: 'not-opened',
      scratch: 'retained-pending-acceptance',
    },
  };
}

function write(repository, name, value) {
  const destination = path.join(
    repository,
    '.playwright-cli',
    'testgen',
    runId,
    name,
  );
  mkdirSync(path.dirname(destination), { recursive: true });
  writeFileSync(destination, JSON.stringify(value));
}

function setup(repository) {
  mkdirSync(path.join(repository, 'tests'), { recursive: true });
  writeFileSync(path.join(repository, 'tests', 'account.spec.ts'), '');
  write(repository, 'command-policy.json', {
    approved_spec: 'tests/account.spec.ts',
    allowed_origins: ['http://127.0.0.1:3000'],
    allowed_runner_options: [],
    allowed_state_paths: [],
    allowed_write_paths: [],
    format_version: 1,
    run_id: runId,
  });
  write(repository, 'handoff.json', handoff());
  write(repository, 'healer-trace.json', trace());
}

function run(repository, decision) {
  return spawnSync(
    process.execPath,
    [recorder, '--repo', repository, '--run-id', runId, '--decision', decision],
    { encoding: 'utf8' },
  );
}

function withRepository(callback) {
  const repository = mkdtempSync(path.join(tmpdir(), 'testgen-finding-'));
  try {
    setup(repository);
    callback(repository);
  } finally {
    rmSync(repository, { force: true, recursive: true });
  }
}

test('declined finding creates no file', () => {
  withRepository((repository) => {
    const result = run(repository, 'declined');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).recorded, false);
    assert.throws(() =>
      readFileSync(
        path.join(repository, '.playwright-cli', 'testgen', 'findings.md'),
      ),
    );
  });
});

test('approved finding records only sanitized validated evidence and preserves duplicates', () => {
  withRepository((repository) => {
    const first = run(repository, 'approved');
    assert.equal(first.status, 0, first.stderr);
    const destination = path.join(
      repository,
      '.playwright-cli',
      'testgen',
      'findings.md',
    );
    const finding = readFileSync(destination, 'utf8');
    assert.match(finding, /tg-0123456789abcdef01234567/);
    assert.match(finding, /product-behavior-wrong/);
    assert.match(finding, /criterion-1/);
    assert.match(finding, /tests\/account\.spec\.ts/);
    assert.match(finding, /profile reverted after the successful action/);
    assert.doesNotMatch(
      finding,
      /failure_signature|selector|contradiction|expectation_drift_rejected/iu,
    );
    const second = run(repository, 'approved');
    assert.equal(second.status, 0, second.stderr);
    assert.equal(JSON.parse(second.stdout).duplicate, true);
    assert.equal(readFileSync(destination, 'utf8'), finding);
  });
});

test('rejects an oversized existing findings ledger', () => {
  withRepository((repository) => {
    const destination = path.join(
      repository,
      '.playwright-cli',
      'testgen',
      'findings.md',
    );
    writeFileSync(destination, 'x'.repeat(64 * 1024 + 1));

    const result = run(repository, 'approved');

    assert.equal(result.status, 1);
    assert.match(result.stderr, /findings-too-large/);
  });
});

test('does not append a finding past the ledger limit', () => {
  withRepository((repository) => {
    const destination = path.join(
      repository,
      '.playwright-cli',
      'testgen',
      'findings.md',
    );
    const existing = 'x'.repeat(64 * 1024 - 1);
    writeFileSync(destination, existing);

    const first = run(repository, 'approved');
    const second = run(repository, 'approved');

    assert.equal(first.status, 1);
    assert.match(first.stderr, /findings-too-large/);
    assert.equal(second.status, 1);
    assert.equal(readFileSync(destination, 'utf8'), existing);
  });
});

test('does not treat an embedded run heading as a duplicate', () => {
  withRepository((repository) => {
    const destination = path.join(
      repository,
      '.playwright-cli',
      'testgen',
      'findings.md',
    );
    writeFileSync(destination, `- observed_behavior: mentions ## ${runId}\n`);

    const result = run(repository, 'approved');
    const finding = readFileSync(destination, 'utf8');

    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).duplicate, false);
    assert.equal(
      finding.split(/\r?\n/u).filter((line) => line === `## ${runId}`).length,
      1,
    );
  });
});

test('rejects a fixed or non-product trace', () => {
  withRepository((repository) => {
    const value = trace();
    value.final_classification = null;
    value.disposition = 'fixed';
    value.next_owner = 'main';
    value.escalation = null;
    value.attempts[0] = {
      number: 1,
      kind: 'verification-run',
      hypothesis: 'the approved spec passes unchanged',
      failure_signature: null,
      evidence_summary: 'runner completed successfully',
      classification: null,
      action: null,
      outcome: 'pass',
    };
    write(repository, 'healer-trace.json', value);
    const result = run(repository, 'approved');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /trace-not-product-behavior-wrong/);
  });
});

test('rejects findings path escaping through a junction or symlink', () => {
  withRepository((repository) => {
    const outside = mkdtempSync(
      path.join(tmpdir(), 'testgen-finding-outside-'),
    );
    const link = path.join(
      repository,
      '.playwright-cli',
      'testgen',
      'findings.md',
    );
    try {
      symlinkSync(path.join(outside, 'findings.md'), link, 'file');
      const result = run(repository, 'approved');
      assert.equal(result.status, 1);
      assert.match(result.stderr, /findings-unavailable/);
    } finally {
      rmSync(outside, { force: true, recursive: true });
    }
  });
});

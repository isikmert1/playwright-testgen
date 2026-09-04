const assert = require('node:assert/strict');
const {
  copyFileSync,
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
const generatorPath = path.join(
  repositoryRoot,
  'scripts',
  'create-testgen-run-id.cjs',
);
const validatorPath = path.join(
  repositoryRoot,
  'scripts',
  'validate-testgen-artifact.cjs',
);
const runId = 'tg-0123456789abcdef01234567';

function runScript(script, args, environment = {}) {
  return spawnSync(process.execPath, [script, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...environment },
  });
}

function handoff(run = runId) {
  return {
    schema_version: 'author-handoff.v1',
    run_id: run,
    scenario_ref: 'account-profile-save',
    spec_path: 'tests/account.spec.ts',
    criteria: [
      {
        id: 'criterion-1',
        assertion_location: 'tests/account.spec.ts:18',
        outcome: 'saved profile is visible',
      },
    ],
    locators: [
      {
        purpose: 'save the profile',
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

function trace(run = runId) {
  return {
    schema_version: 'healer-trace.v1',
    run_id: run,
    spec_path: 'tests/account.spec.ts',
    handoff_read: true,
    attempts: [
      {
        number: 1,
        kind: 'confirmation-run',
        hypothesis: 'the approved spec passes unchanged',
        failure_signature: null,
        evidence_summary: 'runner completed successfully',
        classification: null,
        action: null,
        outcome: 'pass',
      },
    ],
    repairs: [],
    final_classification: null,
    disposition: 'fixed',
    next_owner: 'human',
    escalation: null,
    cleanup: {
      runner: 'stopped',
      browser_session: 'closed',
      scratch: 'retained-pending-acceptance',
    },
  };
}

function repairedTrace(paths) {
  const artifact = trace();
  artifact.attempts.unshift({
    number: 1,
    kind: 'debug-run',
    hypothesis: 'the saved locator no longer matches the control',
    failure_signature: 'save-button-not-found',
    evidence_summary: 'one renamed Save changes control was visible',
    classification: 'selector-drift',
    action: 'updated the approved spec locator',
    outcome: 'fail',
  });
  artifact.attempts[1].number = 2;
  artifact.repairs = [
    {
      attempt_number: 1,
      paths,
      reason: 'matched the renamed visible control',
    },
  ];
  artifact.final_classification = 'selector-drift';
  return artifact;
}

function vacuityReport(run = runId) {
  return {
    schema_version: 'vacuity-report.v1',
    run_id: run,
    spec_path: 'tests/account.spec.ts',
    behavior: {
      status: 'killed',
      mutation: {
        adapter_id: 'account-fixture',
        mutation_id: 'disable-save',
        criterion_id: 'criterion-1',
        definition_digest: 'a'.repeat(64),
        affected_paths: ['src/account.js'],
      },
      baseline: 'pass',
      mutant: 'fail',
      reason: null,
      error: null,
      isolation: 'disposable-worktree',
      cleanup: 'removed',
    },
    assertion_sensitivity: {
      status: 'not-run',
      baseline: null,
      mutant: null,
      error: null,
      isolation: 'not-run',
      cleanup: 'not-run',
    },
    disposition: 'verified-non-vacuous',
  };
}

function productFindingAttempt() {
  return {
    number: 1,
    kind: 'debug-run',
    hypothesis: 'the save action completed but the required state was absent',
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
  };
}

function withRepository(callback) {
  const repository = mkdtempSync(path.join(tmpdir(), 'testgen-artifact-'));
  try {
    mkdirSync(path.join(repository, 'tests'), { recursive: true });
    writeFileSync(path.join(repository, 'tests', 'account.spec.ts'), '');
    writePolicy(repository, 'tests/account.spec.ts');
    writeArtifact(repository, runId, 'handoff.json', handoff());
    writeArtifact(repository, runId, 'healer-trace.json', trace());
    callback(repository);
  } finally {
    rmSync(repository, { force: true, recursive: true });
  }
}

function writePolicy(repository, approvedSpec) {
  const directory = path.join(repository, '.playwright-cli', 'testgen', runId);
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    path.join(directory, 'command-policy.json'),
    JSON.stringify({
      approved_spec: approvedSpec,
      allowed_origins: ['http://127.0.0.1:3000'],
      allowed_runner_options: [],
      allowed_state_paths: [],
      format_version: 1,
      run_id: runId,
    }),
  );
}

function writeArtifact(repository, run, name, artifact) {
  const relative = `.playwright-cli/testgen/${run}/${name}`;
  const destination = path.join(repository, relative);
  mkdirSync(path.dirname(destination), { recursive: true });
  writeFileSync(destination, JSON.stringify(artifact));
  return relative;
}

function writeVacuityReport(repository, value) {
  mkdirSync(path.join(repository, 'src'), { recursive: true });
  writeFileSync(path.join(repository, 'src', 'account.js'), '');
  return writeArtifact(repository, runId, 'vacuity-report.json', value);
}

function validate(repository, type, run, artifact) {
  return runScript(validatorPath, [
    '--repo',
    repository,
    '--type',
    type,
    '--run-id',
    run,
    artifact,
  ]);
}

function assertRejected(repository, type, name, artifact, error) {
  const artifactPath = writeArtifact(repository, runId, name, artifact);
  const result = validate(repository, type, runId, artifactPath);
  assert.equal(result.status, 1);
  assert.match(result.stderr, error);
}

test('creates unique canonical Testgen run IDs', () => {
  const first = runScript(generatorPath, []);
  const second = runScript(generatorPath, []);

  assert.equal(first.status, 0, first.stderr);
  assert.equal(second.status, 0, second.stderr);
  assert.match(first.stdout.trim(), /^tg-[a-f0-9]{24}$/u);
  assert.match(second.stdout.trim(), /^tg-[a-f0-9]{24}$/u);
  assert.notEqual(first.stdout, second.stdout);
});

test('accepts a valid Author handoff in its run-owned location', () => {
  withRepository((repository) => {
    const artifact = writeArtifact(
      repository,
      runId,
      'handoff.json',
      handoff(),
    );
    const result = validate(repository, 'handoff', runId, artifact);

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      valid: true,
      type: 'handoff',
      run_id: runId,
      artifact_path: artifact,
    });
  });
});

test('accepts a valid fixed Healer trace in its run-owned location', () => {
  withRepository((repository) => {
    const artifact = writeArtifact(
      repository,
      runId,
      'healer-trace.json',
      trace(),
    );
    const result = validate(repository, 'trace', runId, artifact);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).valid, true);
  });
});

test('accepts a behavior-killed vacuity report for the approved spec', () => {
  withRepository((repository) => {
    const artifact = writeVacuityReport(repository, vacuityReport());
    const result = validate(repository, 'vacuity', runId, artifact);

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      valid: true,
      type: 'vacuity',
      run_id: runId,
      artifact_path: artifact,
    });
  });
});

test('requires a fixed Healer result before accepting a vacuity report', () => {
  withRepository((repository) => {
    const tracePath = path.join(
      repository,
      '.playwright-cli',
      'testgen',
      runId,
      'healer-trace.json',
    );
    const nonfixed = trace();
    nonfixed.attempts = [productFindingAttempt()];
    nonfixed.final_classification = 'product-behavior-wrong';
    nonfixed.disposition = 'product-behavior-wrong';
    nonfixed.next_owner = 'product-owner';
    nonfixed.escalation = 'the criterion conflicts with product behavior';

    for (const [name, traceValue, error] of [
      ['missing', null, 'report-trace-unavailable'],
      ['nonfixed', nonfixed, 'report-trace-not-fixed'],
    ]) {
      if (traceValue == null) rmSync(tracePath, { force: true });
      else writeFileSync(tracePath, JSON.stringify(traceValue));
      const artifact = writeVacuityReport(repository, vacuityReport());

      const result = validate(repository, 'vacuity', runId, artifact);

      assert.equal(result.status, 1, `${name}: ${result.stdout}`);
      assert.match(result.stderr, new RegExp(error, 'u'), name);
    }
  });
});

test('accepts assertion-only evidence without claiming behavior verification', () => {
  withRepository((repository) => {
    const value = vacuityReport();
    value.behavior = {
      status: 'unavailable',
      mutation: null,
      baseline: null,
      mutant: null,
      reason: 'adapter-absent',
      error: null,
      isolation: 'not-run',
      cleanup: 'not-run',
    };
    value.assertion_sensitivity = {
      status: 'killed',
      baseline: 'pass',
      mutant: 'fail',
      error: null,
      isolation: 'disposable-copy',
      cleanup: 'removed',
    };
    value.disposition = 'assertion-sensitive-only';
    const artifact = writeVacuityReport(repository, value);

    const result = validate(repository, 'vacuity', runId, artifact);

    assert.equal(result.status, 0, result.stderr);
  });
});

test('reports absent product mutation coverage without overstating verification', () => {
  withRepository((repository) => {
    const value = vacuityReport();
    value.behavior = {
      status: 'unavailable',
      mutation: null,
      baseline: null,
      mutant: null,
      reason: 'adapter-absent',
      error: null,
      isolation: 'not-run',
      cleanup: 'not-run',
    };
    value.disposition = 'mutation-not-verified';
    const artifact = writeVacuityReport(repository, value);

    const result = validate(repository, 'vacuity', runId, artifact);

    assert.equal(result.status, 0, result.stderr);
  });
});

test('rejects a vacuity disposition that overstates its evidence', () => {
  withRepository((repository) => {
    const value = vacuityReport();
    value.behavior.status = 'survived';
    value.behavior.mutant = 'pass';
    const artifact = writeVacuityReport(repository, value);

    const result = validate(repository, 'vacuity', runId, artifact);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /report-disposition-mismatch/iu);
  });
});

test('keeps conclusive behavior evidence authoritative over a secondary error', () => {
  withRepository((repository) => {
    for (const [status, mutant, disposition] of [
      ['killed', 'fail', 'verified-non-vacuous'],
      ['survived', 'pass', 'rejected-vacuous'],
    ]) {
      const value = vacuityReport();
      value.behavior.status = status;
      value.behavior.mutant = mutant;
      value.assertion_sensitivity = {
        status: 'error',
        baseline: null,
        mutant: null,
        error: 'assertion-check-failed',
        isolation: 'not-run',
        cleanup: 'not-run',
      };
      value.disposition = disposition;
      const artifact = writeVacuityReport(repository, value);

      const result = validate(repository, 'vacuity', runId, artifact);

      assert.equal(result.status, 0, `${disposition}: ${result.stderr}`);
    }
  });
});

test('limits unavailable reports to explicit coverage gaps', () => {
  withRepository((repository) => {
    const value = vacuityReport();
    value.behavior = {
      status: 'unavailable',
      mutation: null,
      baseline: null,
      mutant: null,
      reason: 'runner-failed',
      error: null,
      isolation: 'not-run',
      cleanup: 'not-run',
    };
    value.assertion_sensitivity.status = 'not-run';
    value.disposition = 'mutation-not-verified';
    const artifact = writeVacuityReport(repository, value);

    const result = validate(repository, 'vacuity', runId, artifact);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /report-invalid-unavailable-reason/iu);
  });
});

test('binds a selected mutation to an approved criterion', () => {
  withRepository((repository) => {
    const value = vacuityReport();
    value.behavior.mutation.criterion_id = 'criterion-other';
    const artifact = writeVacuityReport(repository, value);

    const result = validate(repository, 'vacuity', runId, artifact);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /report-unknown-criterion/iu);
  });
});

test('requires mutation affected paths to be regular files', () => {
  withRepository((repository) => {
    const value = vacuityReport();
    value.behavior.mutation.affected_paths = ['src'];
    const artifact = writeVacuityReport(repository, value);

    const result = validate(repository, 'vacuity', runId, artifact);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /report-affected-path-not-file/iu);
  });
});

test('rejects symlinks as mutation affected paths', () => {
  withRepository((repository) => {
    const value = vacuityReport();
    writeVacuityReport(repository, value);
    const linkedPath = path.join(repository, 'src', 'linked-account.js');
    symlinkSync(path.join(repository, 'src', 'account.js'), linkedPath, 'file');
    value.behavior.mutation.affected_paths = ['src/linked-account.js'];
    const artifact = writeVacuityReport(repository, value);

    const result = validate(repository, 'vacuity', runId, artifact);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /report-affected-path-not-file/iu);
  });
});

test('accepts the target repository test filename and test-id convention', () => {
  withRepository((repository) => {
    const specPath = 'e2e/account-flow.e2e.ts';
    mkdirSync(path.join(repository, 'e2e'));
    writeFileSync(path.join(repository, specPath), '');
    writePolicy(repository, specPath);
    const value = handoff();
    value.spec_path = specPath;
    value.criteria[0].assertion_location = `${specPath}:18`;
    value.touched_paths = [specPath];
    value.test_id_convention = 'test-id';
    const artifact = writeArtifact(repository, runId, 'handoff.json', value);
    const result = validate(repository, 'handoff', runId, artifact);

    assert.equal(result.status, 0, result.stderr);
  });
});

test('rejects a symlink as the approved spec', () => {
  withRepository((repository) => {
    const specPath = 'tests/linked-account.spec.ts';
    symlinkSync(
      path.join(repository, 'tests', 'account.spec.ts'),
      path.join(repository, specPath),
      'file',
    );
    writePolicy(repository, specPath);
    const value = handoff();
    value.spec_path = specPath;
    value.criteria[0].assertion_location = `${specPath}:18`;
    value.touched_paths = [specPath];
    assertRejected(
      repository,
      'handoff',
      'handoff.json',
      value,
      /handoff-spec-unavailable/iu,
    );
  });
});

test('accepts CSS locators with lowercase and uppercase attributes', () => {
  withRepository((repository) => {
    for (const locator of [
      "page.locator('[data-state=active]')",
      "page.locator('[DATA_STATE=active]')",
      `page.locator('[href$=".pdf"]')`,
    ]) {
      const artifact = handoff();
      artifact.locators[0] = {
        purpose: 'identify the active profile panel',
        locator,
        strategy: 'css',
        live_count: 1,
        visible: true,
      };
      const artifactPath = writeArtifact(
        repository,
        runId,
        'handoff.json',
        artifact,
      );
      const result = validate(repository, 'handoff', runId, artifactPath);

      assert.equal(result.status, 0, result.stderr);
    }
  });
});

test('rejects a malformed Author handoff', () => {
  withRepository((repository) => {
    const artifact = writeArtifact(repository, runId, 'handoff.json', {
      schema_version: 'author-handoff.v1',
      run_id: runId,
    });
    const result = validate(repository, 'handoff', runId, artifact);

    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stderr).valid, false);
  });
});

test('rejects criterion IDs that downstream artifacts cannot use', () => {
  withRepository((repository) => {
    const artifact = handoff();
    artifact.criteria[0].id = 'criterion one';
    assertRejected(
      repository,
      'handoff',
      'handoff.json',
      artifact,
      /handoff-invalid-criterion-id/iu,
    );
  });
});

test('requires the approved spec in Author touched paths', () => {
  withRepository((repository) => {
    writeFileSync(path.join(repository, 'notes.md'), 'notes');
    const artifact = handoff();
    artifact.touched_paths = ['notes.md'];
    assertRejected(
      repository,
      'handoff',
      'handoff.json',
      artifact,
      /handoff-spec-not-touched/iu,
    );
  });
});

test('rejects duplicate Author touched paths', () => {
  withRepository((repository) => {
    const artifact = handoff();
    artifact.touched_paths.push('tests/account.spec.ts');
    assertRejected(
      repository,
      'handoff',
      'handoff.json',
      artifact,
      /handoff-duplicate-touched-path/iu,
    );
  });
});

test('requires Author touched paths to be regular files', () => {
  withRepository((repository) => {
    const artifact = handoff();
    artifact.touched_paths.push('tests');
    assertRejected(
      repository,
      'handoff',
      'handoff.json',
      artifact,
      /handoff-touched-not-file/iu,
    );
  });
});

test('rejects internal symlinks in Author touched paths', () => {
  withRepository((repository) => {
    const target = path.join(repository, 'tests', 'source.ts');
    const linked = path.join(repository, 'tests', 'linked-source.ts');
    writeFileSync(target, 'export const value = true;');
    symlinkSync(target, linked, 'file');
    const artifact = handoff();
    artifact.touched_paths.push('tests/linked-source.ts');
    assertRejected(
      repository,
      'handoff',
      'handoff.json',
      artifact,
      /handoff-touched-not-file/iu,
    );
  });
});

test('rejects duplicate test-id additions', () => {
  withRepository((repository) => {
    const artifact = handoff();
    artifact.test_id_convention = 'data-testid';
    const addition = {
      path: 'tests/account.spec.ts',
      attribute: 'data-testid',
      purpose: 'identify the save control',
    };
    artifact.test_id_additions = [addition, { ...addition }];
    assertRejected(
      repository,
      'handoff',
      'handoff.json',
      artifact,
      /handoff-duplicate-test-id-addition/iu,
    );
  });
});

test('requires test-id addition paths to be regular files', () => {
  withRepository((repository) => {
    const artifact = handoff();
    artifact.test_id_convention = 'data-testid';
    artifact.test_id_additions = [
      {
        path: 'tests',
        attribute: 'data-testid',
        purpose: 'identify the save control',
      },
    ];
    artifact.touched_paths.push('tests');
    assertRejected(
      repository,
      'handoff',
      'handoff.json',
      artifact,
      /handoff-test-id-addition-not-file/iu,
    );
  });
});

test('rejects internal symlinks as test-id addition paths', () => {
  withRepository((repository) => {
    const target = path.join(repository, 'tests', 'source.ts');
    const linked = path.join(repository, 'tests', 'linked-source.ts');
    writeFileSync(target, 'export const value = true;');
    symlinkSync(target, linked, 'file');
    const artifact = handoff();
    artifact.test_id_convention = 'data-testid';
    artifact.test_id_additions = [
      {
        path: 'tests/linked-source.ts',
        attribute: 'data-testid',
        purpose: 'identify the save control',
      },
    ];
    artifact.touched_paths.push('tests/linked-source.ts');
    assertRejected(
      repository,
      'handoff',
      'handoff.json',
      artifact,
      /handoff-test-id-addition-not-file/iu,
    );
  });
});

test('rejects duplicate Healer repair paths', () => {
  withRepository((repository) => {
    const artifact = repairedTrace([
      'tests/account.spec.ts',
      'tests/account.spec.ts',
    ]);
    assertRejected(
      repository,
      'trace',
      'healer-trace.json',
      artifact,
      /trace-duplicate-repair-path/iu,
    );
  });
});

test('requires Healer repair paths to be regular files', () => {
  withRepository((repository) => {
    const artifact = repairedTrace(['tests']);
    assertRejected(
      repository,
      'trace',
      'healer-trace.json',
      artifact,
      /trace-repair-not-file/iu,
    );
  });
});

test('rejects internal symlinks as Healer repair paths', () => {
  withRepository((repository) => {
    const target = path.join(repository, 'tests', 'source.ts');
    const linked = path.join(repository, 'tests', 'linked-source.ts');
    writeFileSync(target, 'export const value = true;');
    symlinkSync(target, linked, 'file');
    const artifact = repairedTrace(['tests/linked-source.ts']);
    assertRejected(
      repository,
      'trace',
      'healer-trace.json',
      artifact,
      /trace-repair-not-file/iu,
    );
  });
});

test('rejects secret-bearing artifacts without echoing the value', () => {
  withRepository((repository) => {
    const artifact = handoff();
    artifact.assumptions = ['token=do-not-repeat-this-value'];
    const artifactPath = writeArtifact(
      repository,
      runId,
      'handoff.json',
      artifact,
    );
    const result = validate(repository, 'handoff', runId, artifactPath);

    assert.equal(result.status, 1);
    assert.doesNotMatch(result.stderr, /do-not-repeat-this-value/iu);
    assert.match(result.stderr, /prohibited-content/iu);
  });
});

test('rejects environment assignments and raw snapshots', () => {
  withRepository((repository) => {
    for (const value of [
      'DATABASE_URL=postgres://example.test/app',
      'database_url=postgres://example.test/app',
      'env:DATABASE_URL=postgres://example.test/app',
      '(database_url=postgres://example.test/app)',
      '"DATABASE_URL=postgres://example.test/app"',
      'A=production',
      'snapshot: <main><button>Save</button></main>',
      '<main><button>Save</button></main>',
      '<span>Saved</span>',
      '<div class=x>',
      '<my-widget />',
      'https://admin:hunter2@example.test/account',
      'https://private-user@example.test/account',
    ]) {
      const artifact = handoff();
      artifact.assumptions = [value];
      const artifactPath = writeArtifact(
        repository,
        runId,
        'handoff.json',
        artifact,
      );
      const result = validate(repository, 'handoff', runId, artifactPath);

      assert.equal(result.status, 1);
      assert.match(result.stderr, /prohibited-content/iu);
    }
  });
});

test('rejects a schema that no longer matches the bundled contract', () => {
  withRepository((repository) => {
    const plugin = mkdtempSync(path.join(tmpdir(), 'testgen-plugin-'));
    try {
      for (const directory of ['hooks', 'schemas', 'scripts'])
        mkdirSync(path.join(plugin, directory));
      for (const [source, destination] of [
        ['hooks/run-policy.cjs', 'hooks/run-policy.cjs'],
        [
          'scripts/artifact-validation-common.cjs',
          'scripts/artifact-validation-common.cjs',
        ],
        [
          'scripts/validate-author-handoff.cjs',
          'scripts/validate-author-handoff.cjs',
        ],
        [
          'scripts/validate-healer-trace.cjs',
          'scripts/validate-healer-trace.cjs',
        ],
        [
          'scripts/validate-testgen-artifact.cjs',
          'scripts/validate-testgen-artifact.cjs',
        ],
        [
          'schemas/healer-trace.v1.schema.json',
          'schemas/healer-trace.v1.schema.json',
        ],
      ])
        copyFileSync(
          path.join(repositoryRoot, source),
          path.join(plugin, destination),
        );
      const handoffSchema = JSON.parse(
        readFileSync(
          path.join(repositoryRoot, 'schemas', 'author-handoff.v1.schema.json'),
          'utf8',
        ),
      );
      handoffSchema.properties.criteria = { type: 'string' };
      writeFileSync(
        path.join(plugin, 'schemas', 'author-handoff.v1.schema.json'),
        JSON.stringify(handoffSchema),
      );
      const artifact = writeArtifact(
        repository,
        runId,
        'handoff.json',
        handoff(),
      );
      const result = runScript(
        path.join(plugin, 'scripts', 'validate-testgen-artifact.cjs'),
        [
          '--repo',
          repository,
          '--type',
          'handoff',
          '--run-id',
          runId,
          artifact,
        ],
        { NODE_PATH: path.join(repositoryRoot, 'node_modules') },
      );

      assert.equal(result.status, 1);
      assert.match(result.stderr, /schema-unavailable/iu);
    } finally {
      rmSync(plugin, { force: true, recursive: true });
    }
  });
});

test('rejects artifacts whose embedded run ID differs from the command', () => {
  withRepository((repository) => {
    const otherRun = 'tg-fedcba9876543210fedcba98';
    const artifact = writeArtifact(
      repository,
      runId,
      'handoff.json',
      handoff(otherRun),
    );
    const result = validate(repository, 'handoff', runId, artifact);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /run-id-mismatch/iu);
  });
});

test('requires a final passing confirmation before accepting a fixed trace', () => {
  withRepository((repository) => {
    const artifact = trace();
    artifact.attempts[0].kind = 'debug-run';
    const artifactPath = writeArtifact(
      repository,
      runId,
      'healer-trace.json',
      artifact,
    );
    const result = validate(repository, 'trace', runId, artifactPath);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /fixed-requires-confirmation/iu);
  });
});

test('preserves the last failure classification after a repaired trace passes', () => {
  withRepository((repository) => {
    const artifact = trace();
    artifact.attempts.unshift({
      number: 1,
      kind: 'debug-run',
      hypothesis: 'the saved locator no longer matches the control',
      failure_signature: 'save-button-not-found',
      evidence_summary: 'one renamed Save changes control was visible',
      classification: 'selector-drift',
      action: 'updated the approved spec locator',
      outcome: 'fail',
    });
    artifact.attempts[1].number = 2;
    artifact.repairs = [
      {
        attempt_number: 1,
        paths: ['tests/account.spec.ts'],
        reason: 'matched the renamed visible control',
      },
    ];
    artifact.final_classification = 'selector-drift';
    const artifactPath = writeArtifact(
      repository,
      runId,
      'healer-trace.json',
      artifact,
    );
    const result = validate(repository, 'trace', runId, artifactPath);

    assert.equal(result.status, 0, result.stderr);
  });
});

test('rejects attempts after a terminal product-behavior finding', () => {
  withRepository((repository) => {
    const artifact = trace();
    artifact.attempts.unshift(productFindingAttempt());
    artifact.attempts[1].number = 2;
    artifact.final_classification = 'product-behavior-wrong';
    const artifactPath = writeArtifact(
      repository,
      runId,
      'healer-trace.json',
      artifact,
    );
    const result = validate(repository, 'trace', runId, artifactPath);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /attempt-after-terminal-classification/iu);
  });
});

test('accepts a terminal product-behavior trace with structured evidence', () => {
  withRepository((repository) => {
    const artifact = trace();
    artifact.attempts = [productFindingAttempt()];
    artifact.final_classification = 'product-behavior-wrong';
    artifact.disposition = 'product-behavior-wrong';
    artifact.next_owner = 'product-owner';
    artifact.escalation = 'the criterion and current product behavior conflict';
    const artifactPath = writeArtifact(
      repository,
      runId,
      'healer-trace.json',
      artifact,
    );
    const result = validate(repository, 'trace', runId, artifactPath);

    assert.equal(result.status, 0, result.stderr);
  });
});

test('rejects repairs assigned to an owner-terminal failure', () => {
  withRepository((repository) => {
    const artifact = trace();
    artifact.attempts = [productFindingAttempt()];
    artifact.repairs = [
      {
        attempt_number: 1,
        paths: ['tests/account.spec.ts'],
        reason: 'changed the assertion to match the product',
      },
    ];
    artifact.final_classification = 'product-behavior-wrong';
    artifact.disposition = 'product-behavior-wrong';
    artifact.next_owner = 'human';
    artifact.escalation = 'the criterion and current product behavior conflict';
    const artifactPath = writeArtifact(
      repository,
      runId,
      'healer-trace.json',
      artifact,
    );
    const result = validate(repository, 'trace', runId, artifactPath);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /repair-for-unrepairable-attempt/iu);
  });
});

test('rejects product evidence for a criterion absent from the handoff', () => {
  withRepository((repository) => {
    const artifact = trace();
    const attempt = productFindingAttempt();
    attempt.product_behavior_evidence.criterion_id = 'criterion-missing';
    artifact.attempts = [attempt];
    artifact.final_classification = 'product-behavior-wrong';
    artifact.disposition = 'product-behavior-wrong';
    artifact.next_owner = 'human';
    artifact.escalation = 'the criterion and current product behavior conflict';
    const artifactPath = writeArtifact(
      repository,
      runId,
      'healer-trace.json',
      artifact,
    );
    const result = validate(repository, 'trace', runId, artifactPath);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /unknown-product-criterion/iu);
  });
});

test('rejects product evidence that changes the retained criterion outcome', () => {
  withRepository((repository) => {
    const artifact = trace();
    const attempt = productFindingAttempt();
    attempt.product_behavior_evidence.required_outcome =
      'the profile may disappear after saving';
    artifact.attempts = [attempt];
    artifact.final_classification = 'product-behavior-wrong';
    artifact.disposition = 'product-behavior-wrong';
    artifact.next_owner = 'human';
    artifact.escalation = 'the criterion and current product behavior conflict';
    const artifactPath = writeArtifact(
      repository,
      runId,
      'healer-trace.json',
      artifact,
    );
    const result = validate(repository, 'trace', runId, artifactPath);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /product-outcome-mismatch/iu);
  });
});

test('rejects a trace when the retained handoff did not pass lint', () => {
  withRepository((repository) => {
    const retainedHandoff = handoff();
    retainedHandoff.lint = {
      command: 'npm run lint',
      status: 'failed',
      diagnostics: ['one lint error remains'],
    };
    writeArtifact(repository, runId, 'handoff.json', retainedHandoff);
    const artifactPath = writeArtifact(
      repository,
      runId,
      'healer-trace.json',
      trace(),
    );
    const result = validate(repository, 'trace', runId, artifactPath);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /trace-handoff-unavailable/iu);
  });
});

test('rejects a trace whose final classification is not its last failure', () => {
  withRepository((repository) => {
    const artifact = trace();
    artifact.final_classification = 'timing';
    const artifactPath = writeArtifact(
      repository,
      runId,
      'healer-trace.json',
      artifact,
    );
    const result = validate(repository, 'trace', runId, artifactPath);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /final-classification-mismatch/iu);
  });
});

test('rejects an artifact for a different run policy spec', () => {
  withRepository((repository) => {
    writeFileSync(path.join(repository, 'tests', 'other.spec.ts'), '');
    const value = handoff();
    value.spec_path = 'tests/other.spec.ts';
    value.criteria[0].assertion_location = 'tests/other.spec.ts:18';
    value.touched_paths = ['tests/other.spec.ts'];
    const artifactPath = writeArtifact(
      repository,
      runId,
      'handoff.json',
      value,
    );
    const result = validate(repository, 'handoff', runId, artifactPath);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /policy-spec-mismatch/iu);
  });
});

test('rejects assertion locations outside declared repository paths', () => {
  withRepository((repository) => {
    const artifact = handoff();
    artifact.criteria[0].assertion_location = '../outside.spec.ts:18';
    const artifactPath = writeArtifact(
      repository,
      runId,
      'handoff.json',
      artifact,
    );
    const result = validate(repository, 'handoff', runId, artifactPath);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /assertion-location-path/iu);
  });
});

test('binds test-id additions to the grounded convention and touched paths', () => {
  withRepository((repository) => {
    mkdirSync(path.join(repository, 'src'));
    writeFileSync(path.join(repository, 'src', 'save-button.tsx'), '');
    const artifact = handoff();
    artifact.test_id_additions = [
      {
        path: 'src/save-button.tsx',
        attribute: 'data-testid',
        purpose: 'identify the profile save control',
      },
    ];
    const artifactPath = writeArtifact(
      repository,
      runId,
      'handoff.json',
      artifact,
    );
    const result = validate(repository, 'handoff', runId, artifactPath);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /test-id-convention-mismatch/iu);
    assert.match(result.stderr, /test-id-addition-not-touched/iu);
  });
});

test('rejects touched paths that escape through a symbolic link', () => {
  withRepository((repository) => {
    const outside = mkdtempSync(path.join(tmpdir(), 'testgen-outside-'));
    const linkedPath = path.join(repository, 'tests', 'linked.spec.ts');
    writeFileSync(path.join(outside, 'outside.spec.ts'), '');
    symlinkSync(path.join(outside, 'outside.spec.ts'), linkedPath, 'file');
    try {
      const artifact = handoff();
      artifact.touched_paths = ['tests/linked.spec.ts'];
      const artifactPath = writeArtifact(
        repository,
        runId,
        'handoff.json',
        artifact,
      );
      const result = validate(repository, 'handoff', runId, artifactPath);

      assert.equal(result.status, 1);
      assert.match(result.stderr, /outside-repository/iu);
    } finally {
      rmSync(outside, { force: true, recursive: true });
    }
  });
});

test('rejects oversized artifacts before parsing their contents', () => {
  withRepository((repository) => {
    const artifactPath = writeArtifact(
      repository,
      runId,
      'handoff.json',
      'x'.repeat(65 * 1024),
    );
    const result = validate(repository, 'handoff', runId, artifactPath);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /artifact-too-large/iu);
  });
});

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

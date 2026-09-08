const assert = require('node:assert/strict');
const {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { setTimeout: delay } = require('node:timers/promises');
const { verifyMutation } = require('../scripts/mutation-isolation.cjs');

const pluginRoot = path.resolve(__dirname, '..');
const mutationCheckPath = path.join(
  pluginRoot,
  'scripts',
  'mutation-check.cjs',
);
const runId = 'tg-0123456789abcdef01234567';

function run(repository, args, options = {}) {
  return spawnSync(process.execPath, [mutationCheckPath, ...args], {
    cwd: repository,
    encoding: 'utf8',
    env: options.env,
  });
}

function capture(repository, boundary) {
  return run(repository, [
    'capture',
    '--repo',
    '.',
    '--run-id',
    runId,
    '--boundary',
    boundary,
  ]);
}

function git(repository, args) {
  const result = spawnSync('git', args, {
    cwd: repository,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

function createRepository() {
  const repository = mkdtempSync(path.join(tmpdir(), 'testgen-mutation-'));
  mkdirSync(path.join(repository, 'src'));
  writeFileSync(
    path.join(repository, 'src', 'app.js'),
    'module.exports = 1;\n',
  );
  git(repository, ['init', '--quiet']);
  git(repository, ['config', 'user.name', 'Testgen Tests']);
  git(repository, ['config', 'user.email', 'testgen@example.test']);
  git(repository, ['add', 'src/app.js']);
  git(repository, ['commit', '--quiet', '-m', 'fixture']);

  const runDirectory = path.join(
    repository,
    '.playwright-cli',
    'testgen',
    runId,
  );
  mkdirSync(runDirectory, { recursive: true });
  writeFileSync(
    path.join(runDirectory, 'command-policy.json'),
    JSON.stringify({
      approved_spec: 'tests/account.spec.ts',
      allowed_origins: ['http://127.0.0.1:3000'],
      allowed_runner_options: [],
      allowed_state_paths: [],
      allowed_write_paths: [],
      format_version: 1,
      run_id: runId,
    }),
  );
  return { repository, runDirectory };
}

function withRepository(callback) {
  const target = createRepository();
  try {
    callback(target);
  } finally {
    rmSync(target.repository, { force: true, recursive: true });
  }
}

function handoff() {
  return {
    schema_version: 'author-handoff.v1',
    run_id: runId,
    scenario_ref: 'account-profile-save',
    spec_path: 'tests/account.spec.ts',
    criteria: [
      {
        id: 'criterion-1',
        step_title: 'verify the saved profile is visible',
        assertion_location: 'tests/account.spec.ts:8',
        outcome: 'saved profile is visible',
      },
    ],
    locators: [],
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
        hypothesis: 'the expected status text changed',
        failure_signature: 'status-text-mismatch',
        evidence_summary: 'the verified locator resolved to one status element',
        classification: 'expectation-drift',
        action: 'updated the expected status text',
        outcome: 'fail',
      },
      {
        number: 2,
        kind: 'confirmation-run',
        hypothesis: 'the repaired approved spec now passes',
        failure_signature: null,
        evidence_summary: 'the approved spec completed successfully',
        classification: null,
        action: null,
        outcome: 'pass',
      },
    ],
    repairs: [
      {
        attempt_number: 1,
        paths: ['tests/account.spec.ts'],
        reason: 'matched the verified status text',
      },
    ],
    final_classification: 'expectation-drift',
    disposition: 'fixed',
    next_owner: 'main',
    escalation: null,
    cleanup: {
      runner: 'not-started',
      browser_session: 'not-opened',
      scratch: 'retained-pending-acceptance',
    },
  };
}

function writeAdapter(repository, options = {}) {
  const directory = path.join(repository, '.testgen');
  mkdirSync(path.join(directory, 'mutations'), { recursive: true });
  writeFileSync(
    path.join(directory, 'runner.cjs'),
    options.runner ??
      'process.stdout.write(JSON.stringify({protocol_version:1,outcome:"pass",criterion_id:null}));\n',
  );
  writeFileSync(
    path.join(directory, 'mutations', 'disable-save.patch'),
    options.patch ??
      [
        'diff --git a/src/app.js b/src/app.js',
        '--- a/src/app.js',
        '+++ b/src/app.js',
        '@@ -1 +1 @@',
        '-module.exports = 1;',
        '+module.exports = 0;',
        '',
      ].join('\n'),
  );
  const adapter = {
    schema_version: 'mutation-adapter.v1',
    adapter_id: 'account-fixture',
    runner_path: '.testgen/runner.cjs',
    mutations: [
      {
        mutation_id: 'disable-save',
        criterion_id: 'criterion-1',
        affected_paths: ['src/app.js'],
        patch_path: '.testgen/mutations/disable-save.patch',
        definition_digest: '0'.repeat(64),
        timeout_ms: 5000,
        ...options.mutation,
      },
    ],
    ...options.adapter,
  };
  const adapterPath = path.join(directory, 'mutation-adapter.json');
  writeFileSync(adapterPath, JSON.stringify(adapter));
  return adapterPath;
}

function passingTrace() {
  const value = trace();
  value.attempts = [
    {
      number: 1,
      kind: 'verification-run',
      hypothesis: 'the approved spec passes unchanged',
      failure_signature: null,
      evidence_summary: 'the approved spec completed successfully',
      classification: null,
      action: null,
      outcome: 'pass',
    },
  ];
  value.repairs = [];
  value.final_classification = null;
  return value;
}

function blockedTrace() {
  const value = passingTrace();
  value.attempts = [
    {
      number: 1,
      kind: 'verification-run',
      hypothesis: 'authentication is required before the scenario can run',
      failure_signature: 'authentication-required',
      evidence_summary: 'the application redirected to its login route',
      classification: 'environment-or-auth',
      action: 'stopped pending approved authentication input',
      outcome: 'blocked',
    },
  ];
  value.final_classification = 'environment-or-auth';
  value.disposition = 'needs-user-input';
  value.next_owner = 'human';
  value.escalation = 'approved authentication input is required';
  return value;
}

function writeApprovedCandidate(repository, runDirectory) {
  mkdirSync(path.join(repository, 'tests'), { recursive: true });
  writeFileSync(
    path.join(repository, 'tests', 'account.spec.ts'),
    'test("saves", async () => expect("saved").toBe("saved"));\n',
  );
  writeFileSync(
    path.join(runDirectory, 'handoff.json'),
    JSON.stringify(handoff()),
  );
}

function commitAdapter(repository, adapterPath) {
  const digest = run(repository, [
    'digest',
    '--repo',
    '.',
    '--adapter',
    path.relative(repository, adapterPath),
    '--mutation-id',
    'disable-save',
  ]);
  assert.equal(digest.status, 0, digest.stderr);
  const definitionDigest = JSON.parse(digest.stdout).definition_digest;
  const adapter = JSON.parse(readFileSync(adapterPath, 'utf8'));
  adapter.mutations[0].definition_digest = definitionDigest;
  writeFileSync(adapterPath, JSON.stringify(adapter));
  git(repository, ['add', '.testgen']);
  git(repository, ['commit', '--quiet', '-m', 'add mutation adapter']);
  return definitionDigest;
}

function capturePassingRun(repository, runDirectory) {
  assert.equal(capture(repository, 'pre-author').status, 0);
  writeApprovedCandidate(repository, runDirectory);
  const checkpoint = capture(repository, 'checkpoint');
  assert.equal(checkpoint.status, 0, checkpoint.stderr);
  writeFileSync(
    path.join(runDirectory, 'healer-trace.json'),
    JSON.stringify(passingTrace()),
  );
  const postHealer = capture(repository, 'post-healer');
  assert.equal(postHealer.status, 0, postHealer.stderr);
}

function verify(repository, adapterPath, definitionDigest, options) {
  return run(
    repository,
    [
      'verify',
      '--repo',
      '.',
      '--run-id',
      runId,
      '--adapter',
      path.relative(repository, adapterPath),
      '--mutation-id',
      'disable-save',
      '--criterion-id',
      'criterion-1',
      '--approval-digest',
      definitionDigest,
    ],
    options,
  );
}

test('records dirty paths without storing repository content', () => {
  withRepository(({ repository, runDirectory }) => {
    writeFileSync(
      path.join(repository, 'src', 'app.js'),
      'module.exports = "staged-marker";\n',
    );
    git(repository, ['add', 'src/app.js']);
    writeFileSync(
      path.join(repository, 'src', 'app.js'),
      'module.exports = "working-marker";\n',
    );
    writeFileSync(path.join(repository, 'notes.txt'), 'untracked-marker\n');

    const result = capture(repository, 'pre-author');

    assert.equal(result.status, 0, result.stderr);
    const manifestText = readFileSync(
      path.join(runDirectory, 'change-manifest.json'),
      'utf8',
    );
    const manifest = JSON.parse(manifestText);
    assert.equal(manifest.schema_version, 'change-manifest.v1');
    assert.equal(manifest.run_id, runId);
    assert.match(manifest.head, /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u);
    assert.deepEqual(
      manifest.boundaries.pre_author.paths.map(({ path: value, kind }) => [
        value,
        kind,
      ]),
      [
        ['notes.txt', 'untracked-file'],
        ['src/app.js', 'tracked'],
      ],
    );
    for (const entry of manifest.boundaries.pre_author.paths)
      assert.match(entry.fingerprint, /^[a-f0-9]{64}$/u);
    assert.equal(manifest.boundaries.checkpoint, null);
    assert.equal(manifest.boundaries.post_healer, null);
    assert.doesNotMatch(
      manifestText,
      /staged-marker|working-marker|untracked-marker|command-policy/iu,
    );
  });
});

test('attributes approved Author and Healer changes at each boundary', () => {
  withRepository(({ repository, runDirectory }) => {
    writeFileSync(path.join(repository, 'notes.txt'), 'user-owned\n');
    assert.equal(capture(repository, 'pre-author').status, 0);

    mkdirSync(path.join(repository, 'tests'));
    writeFileSync(
      path.join(repository, 'tests', 'account.spec.ts'),
      'test("saves", async () => expect("saved").toBe("saved"));\n',
    );
    writeFileSync(
      path.join(runDirectory, 'handoff.json'),
      JSON.stringify(handoff()),
    );
    const checkpoint = capture(repository, 'checkpoint');
    assert.equal(checkpoint.status, 0, checkpoint.stderr);

    writeFileSync(
      path.join(repository, 'tests', 'account.spec.ts'),
      'test("saves", async () => expect("saved now").toBe("saved now"));\n',
    );
    writeFileSync(
      path.join(runDirectory, 'healer-trace.json'),
      JSON.stringify(trace()),
    );
    const postHealer = capture(repository, 'post-healer');
    assert.equal(postHealer.status, 0, postHealer.stderr);

    const manifest = JSON.parse(
      readFileSync(path.join(runDirectory, 'change-manifest.json'), 'utf8'),
    );
    const boundaries = Object.values(manifest.boundaries);
    assert.deepEqual(
      boundaries.map(({ paths }) => paths.map((entry) => entry.path)),
      [
        ['notes.txt'],
        ['notes.txt', 'tests/account.spec.ts'],
        ['notes.txt', 'tests/account.spec.ts'],
      ],
    );
    const userFingerprints = boundaries.map(
      ({ paths }) =>
        paths.find((entry) => entry.path === 'notes.txt').fingerprint,
    );
    assert.equal(new Set(userFingerprints).size, 1);
    assert.notEqual(
      manifest.boundaries.checkpoint.paths[1].fingerprint,
      manifest.boundaries.post_healer.paths[1].fingerprint,
    );
  });
});

test('binds adapter metadata, runner, and patch content to one digest', () => {
  withRepository(({ repository }) => {
    const adapterPath = writeAdapter(repository);
    const digest = run(repository, [
      'digest',
      '--repo',
      '.',
      '--adapter',
      path.relative(repository, adapterPath),
      '--mutation-id',
      'disable-save',
    ]);

    assert.equal(digest.status, 0, digest.stderr);
    const first = JSON.parse(digest.stdout);
    assert.equal(first.adapter_id, 'account-fixture');
    assert.equal(first.mutation_id, 'disable-save');
    assert.equal(first.criterion_id, 'criterion-1');
    assert.match(first.definition_digest, /^[a-f0-9]{64}$/u);

    writeFileSync(
      path.join(repository, '.testgen', 'mutations', 'disable-save.patch'),
      'different approved patch bytes\n',
    );
    const changed = run(repository, [
      'digest',
      '--repo',
      '.',
      '--adapter',
      path.relative(repository, adapterPath),
      '--mutation-id',
      'disable-save',
    ]);

    assert.equal(changed.status, 0, changed.stderr);
    assert.notEqual(
      JSON.parse(changed.stdout).definition_digest,
      first.definition_digest,
    );
  });
});

test('kills a criterion-linked mutation in disposable isolation', () => {
  withRepository(({ repository, runDirectory }) => {
    const adapterPath = writeAdapter(repository, {
      runner: [
        "const {existsSync,readFileSync}=require('node:fs');",
        "const path=require('node:path');",
        'const value=(name)=>process.argv[process.argv.indexOf(name)+1];',
        "const spec=value('--spec');",
        "let result={protocol_version:1,outcome:'pass',criterion_id:null};",
        "if(process.argv.slice(2).length!==8||value('--step-title')!=='verify the saved profile is visible') result={protocol_version:1,outcome:'error',criterion_id:null,reason:'unexpected-arguments'};",
        "else if(existsSync(path.join(process.cwd(),'notes.txt'))) result={protocol_version:1,outcome:'error',criterion_id:null,reason:'user-content-copied'};",
        "else if(!existsSync(path.join(process.cwd(),spec))) result={protocol_version:1,outcome:'error',criterion_id:null,reason:'spec-not-copied'};",
        "else if(readFileSync(path.join(process.cwd(),'src/app.js'),'utf8').includes('= 0')) result={protocol_version:1,outcome:'fail',criterion_id:value('--criterion-id')};",
        'process.stdout.write(JSON.stringify(result));',
        '',
      ].join('\n'),
    });
    const definitionDigest = commitAdapter(repository, adapterPath);
    writeFileSync(path.join(repository, 'notes.txt'), 'user-owned\n');
    capturePassingRun(repository, runDirectory);
    const activeProduct = readFileSync(
      path.join(repository, 'src', 'app.js'),
      'utf8',
    );

    const result = verify(repository, adapterPath, definitionDigest);

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      ok: true,
      operation: 'verify',
      status: 'killed',
      adapter_id: 'account-fixture',
      mutation_id: 'disable-save',
      criterion_id: 'criterion-1',
      definition_digest: definitionDigest,
      affected_paths: ['src/app.js'],
      baseline: 'pass',
      mutant: 'fail',
      isolation: 'disposable-worktree',
      cleanup: 'removed',
    });
    assert.equal(
      readFileSync(path.join(repository, 'src', 'app.js'), 'utf8'),
      activeProduct,
    );
    assert.equal(
      readFileSync(path.join(repository, 'notes.txt'), 'utf8'),
      'user-owned\n',
    );
  });
});

test('makes active target dependencies available to the isolated runner', () => {
  withRepository(({ repository, runDirectory }) => {
    writeFileSync(
      path.join(repository, '.git', 'info', 'exclude'),
      'node_modules/\n',
    );
    mkdirSync(path.join(repository, 'node_modules'));
    writeFileSync(
      path.join(repository, 'node_modules', 'testgen-sentinel'),
      'available\n',
    );
    const adapterPath = writeAdapter(repository, {
      runner: [
        "const {existsSync,readFileSync}=require('node:fs');",
        "const path=require('node:path');",
        'const value=(name)=>process.argv[process.argv.indexOf(name)+1];',
        "let result={protocol_version:1,outcome:'error',criterion_id:null,reason:'dependencies-unavailable'};",
        'const dependencies=process.env.TESTGEN_TARGET_NODE_MODULES;',
        "if(dependencies&&existsSync(path.join(dependencies,'testgen-sentinel'))) result=readFileSync(path.join(process.cwd(),'src/app.js'),'utf8').includes('= 0')?{protocol_version:1,outcome:'fail',criterion_id:value('--criterion-id')}:{protocol_version:1,outcome:'pass',criterion_id:null};",
        'process.stdout.write(JSON.stringify(result));',
        '',
      ].join('\n'),
    });
    const definitionDigest = commitAdapter(repository, adapterPath);
    capturePassingRun(repository, runDirectory);

    const result = verify(repository, adapterPath, definitionDigest);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).status, 'killed');
  });
});

test('rejects a dangling overlay destination in the disposable checkout', () => {
  withRepository(({ repository, runDirectory }) => {
    git(repository, ['config', 'core.symlinks', 'true']);
    mkdirSync(path.join(repository, 'tests'));
    symlinkSync(
      `../../${path.basename(repository)}-escaped.txt`,
      path.join(repository, 'tests', 'account.spec.ts'),
      'file',
    );
    git(repository, ['add', 'tests/account.spec.ts']);
    git(repository, ['commit', '--quiet', '-m', 'add dangling spec link']);
    const adapterPath = writeAdapter(repository);
    const definitionDigest = commitAdapter(repository, adapterPath);
    assert.equal(capture(repository, 'pre-author').status, 0);
    unlinkSync(path.join(repository, 'tests', 'account.spec.ts'));
    writeApprovedCandidate(repository, runDirectory);
    assert.equal(capture(repository, 'checkpoint').status, 0);
    writeFileSync(
      path.join(runDirectory, 'healer-trace.json'),
      JSON.stringify(passingTrace()),
    );
    assert.equal(capture(repository, 'post-healer').status, 0);

    const result = verify(repository, adapterPath, definitionDigest);

    assert.equal(result.status, 1);
    const output = JSON.parse(result.stdout);
    assert.equal(output.status, 'verification-error');
    assert.equal(output.error, 'overlay-destination-unsafe');
    assert.equal(output.cleanup, 'removed');
  });
});

test('rejects a mutant failure attributed to another criterion', () => {
  withRepository(({ repository, runDirectory }) => {
    const adapterPath = writeAdapter(repository, {
      runner: [
        "const phase=process.argv[process.argv.indexOf('--phase')+1];",
        "const result=phase==='baseline'",
        "  ? {protocol_version:1,outcome:'pass',criterion_id:null}",
        "  : {protocol_version:1,outcome:'fail',criterion_id:'criterion-other'};",
        'process.stdout.write(JSON.stringify(result));',
        '',
      ].join('\n'),
    });
    const definitionDigest = commitAdapter(repository, adapterPath);
    capturePassingRun(repository, runDirectory);

    const result = verify(repository, adapterPath, definitionDigest);

    assert.equal(result.status, 1);
    assert.equal(result.stderr, '');
    assert.deepEqual(JSON.parse(result.stdout), {
      ok: false,
      operation: 'verify',
      status: 'verification-error',
      adapter_id: 'account-fixture',
      mutation_id: 'disable-save',
      criterion_id: 'criterion-1',
      definition_digest: definitionDigest,
      affected_paths: ['src/app.js'],
      baseline: 'pass',
      mutant: 'fail',
      isolation: 'disposable-worktree',
      cleanup: 'removed',
      error: 'mutant-failure-unattributed',
    });
    assert.equal(
      readFileSync(path.join(repository, 'src', 'app.js'), 'utf8'),
      'module.exports = 1;\n',
    );
  });
});

test('rejects a mutant run that changes approved inputs', () => {
  withRepository(({ repository, runDirectory }) => {
    const adapterPath = writeAdapter(repository, {
      runner: [
        "const {readFileSync,writeFileSync}=require('node:fs');",
        "const path=require('node:path');",
        'const value=(name)=>process.argv[process.argv.indexOf(name)+1];',
        "const phase=value('--phase');",
        "const spec=value('--spec');",
        "let result={protocol_version:1,outcome:'pass',criterion_id:null};",
        "if(phase==='mutant') {",
        "  writeFileSync(path.join(process.cwd(),spec),'changed by runner\\n');",
        "  if(readFileSync(path.join(process.cwd(),'src/app.js'),'utf8').includes('= 0')) result={protocol_version:1,outcome:'fail',criterion_id:value('--criterion-id')};",
        '}',
        'process.stdout.write(JSON.stringify(result));',
        '',
      ].join('\n'),
    });
    const definitionDigest = commitAdapter(repository, adapterPath);
    capturePassingRun(repository, runDirectory);

    const result = verify(repository, adapterPath, definitionDigest);

    assert.equal(result.status, 1);
    const output = JSON.parse(result.stdout);
    assert.equal(output.status, 'verification-error');
    assert.equal(output.error, 'mutant-mutated-isolation');
    assert.equal(output.cleanup, 'removed');
  });
});

test('rejects a runner that changes the disposable checkout HEAD', () => {
  withRepository(({ repository, runDirectory }) => {
    const adapterPath = writeAdapter(repository, {
      runner: [
        "const {spawnSync}=require('node:child_process');",
        "const phase=process.argv[process.argv.indexOf('--phase')+1];",
        "const criterion=process.argv[process.argv.indexOf('--criterion-id')+1];",
        "if(phase==='baseline')spawnSync('git',['commit','--allow-empty','--quiet','-m','runner commit'],{cwd:process.cwd()});",
        "const outcome=phase==='baseline'?{protocol_version:1,outcome:'pass',criterion_id:null}:{protocol_version:1,outcome:'fail',criterion_id:criterion};",
        'process.stdout.write(JSON.stringify(outcome));',
        '',
      ].join('\n'),
    });
    const definitionDigest = commitAdapter(repository, adapterPath);
    capturePassingRun(repository, runDirectory);

    const result = verify(repository, adapterPath, definitionDigest);

    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stdout).error, 'baseline-mutated-isolation');
  });
});

test('reports a passing mutant as survived', () => {
  withRepository(({ repository, runDirectory }) => {
    const adapterPath = writeAdapter(repository);
    const definitionDigest = commitAdapter(repository, adapterPath);
    capturePassingRun(repository, runDirectory);

    const result = verify(repository, adapterPath, definitionDigest);

    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.status, 'survived');
    assert.equal(output.baseline, 'pass');
    assert.equal(output.mutant, 'pass');
    assert.equal(output.cleanup, 'removed');
  });
});

test('reports a non-passing baseline as a verification error', () => {
  withRepository(({ repository, runDirectory }) => {
    const adapterPath = writeAdapter(repository, {
      runner:
        "process.stdout.write(JSON.stringify({protocol_version:1,outcome:'fail',criterion_id:'criterion-1'}));\n",
    });
    const definitionDigest = commitAdapter(repository, adapterPath);
    capturePassingRun(repository, runDirectory);

    const result = verify(repository, adapterPath, definitionDigest);

    assert.equal(result.status, 1);
    const output = JSON.parse(result.stdout);
    assert.equal(output.status, 'verification-error');
    assert.equal(output.error, 'baseline-not-passing');
    assert.equal(output.baseline, 'fail');
    assert.equal(output.mutant, null);
    assert.equal(output.cleanup, 'removed');
  });
});

test('reports malformed runner output without echoing it', () => {
  withRepository(({ repository, runDirectory }) => {
    const adapterPath = writeAdapter(repository, {
      runner: "process.stdout.write('private runner log');\n",
    });
    const definitionDigest = commitAdapter(repository, adapterPath);
    capturePassingRun(repository, runDirectory);

    const result = verify(repository, adapterPath, definitionDigest);

    assert.equal(result.status, 1);
    assert.doesNotMatch(result.stdout, /private runner log/iu);
    assert.doesNotMatch(result.stderr, /private runner log/iu);
    const output = JSON.parse(result.stdout);
    assert.equal(output.error, 'runner-output-invalid');
    assert.equal(output.cleanup, 'removed');
  });
});

test('returns unavailable when the adapter has no criterion mutation', () => {
  withRepository(({ repository, runDirectory }) => {
    const adapterPath = writeAdapter(repository, {
      mutation: { criterion_id: 'criterion-other' },
    });
    commitAdapter(repository, adapterPath);
    writeApprovedCandidate(repository, runDirectory);
    writeFileSync(
      path.join(runDirectory, 'healer-trace.json'),
      JSON.stringify(passingTrace()),
    );

    const result = run(repository, [
      'verify',
      '--repo',
      '.',
      '--run-id',
      runId,
      '--adapter',
      path.relative(repository, adapterPath),
      '--criterion-id',
      'criterion-1',
    ]);

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      ok: true,
      operation: 'verify',
      status: 'unavailable',
      adapter_id: 'account-fixture',
      criterion_id: 'criterion-1',
      reason: 'criterion-unmapped',
    });
  });
});

test('requires an exact approved selection for a mapped mutation', () => {
  withRepository(({ repository, runDirectory }) => {
    const adapterPath = writeAdapter(repository);
    commitAdapter(repository, adapterPath);
    writeApprovedCandidate(repository, runDirectory);
    writeFileSync(
      path.join(runDirectory, 'healer-trace.json'),
      JSON.stringify(passingTrace()),
    );

    const result = run(repository, [
      'verify',
      '--repo',
      '.',
      '--run-id',
      runId,
      '--adapter',
      path.relative(repository, adapterPath),
      '--criterion-id',
      'criterion-1',
    ]);

    assert.equal(result.status, 1);
    const output = JSON.parse(result.stdout);
    assert.equal(output.status, 'verification-error');
    assert.equal(output.error, 'mutation-approval-required');
  });
});

test('rejects a selected mutation mapped to another criterion', () => {
  withRepository(({ repository, runDirectory }) => {
    const adapterPath = writeAdapter(repository, {
      mutation: { criterion_id: 'criterion-other' },
    });
    const definitionDigest = commitAdapter(repository, adapterPath);
    capturePassingRun(repository, runDirectory);

    const result = run(repository, [
      'verify',
      '--repo',
      '.',
      '--run-id',
      runId,
      '--adapter',
      path.relative(repository, adapterPath),
      '--mutation-id',
      'disable-save',
      '--criterion-id',
      'criterion-1',
      '--approval-digest',
      definitionDigest,
    ]);

    assert.equal(result.status, 1);
    const output = JSON.parse(result.stdout);
    assert.equal(output.status, 'verification-error');
    assert.equal(output.error, 'mutation-criterion-mismatch');
  });
});

test('rejects an unmapped result from a dirty adapter definition', () => {
  withRepository(({ repository, runDirectory }) => {
    const adapterPath = writeAdapter(repository);
    const definitionDigest = commitAdapter(repository, adapterPath);
    const adapter = JSON.parse(readFileSync(adapterPath, 'utf8'));
    adapter.mutations[0].criterion_id = 'criterion-other';
    writeFileSync(adapterPath, JSON.stringify(adapter));
    capturePassingRun(repository, runDirectory);

    const result = verify(repository, adapterPath, definitionDigest);

    assert.equal(result.status, 1);
    const output = JSON.parse(result.stdout);
    assert.equal(output.status, 'verification-error');
    assert.equal(output.error, 'adapter-definition-dirty');
  });
});

test('returns unavailable when the repository has no mutation adapter', () => {
  withRepository(({ repository, runDirectory }) => {
    writeApprovedCandidate(repository, runDirectory);
    writeFileSync(
      path.join(runDirectory, 'healer-trace.json'),
      JSON.stringify(passingTrace()),
    );
    assert.equal(
      existsSync(path.join(runDirectory, 'change-manifest.json')),
      false,
    );

    const result = run(repository, [
      'verify',
      '--repo',
      '.',
      '--run-id',
      runId,
      '--criterion-id',
      'criterion-1',
    ]);

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      ok: true,
      operation: 'verify',
      status: 'unavailable',
      criterion_id: 'criterion-1',
      reason: 'adapter-absent',
    });
  });
});

test('requires a fixed Healer result before reporting adapter absence', () => {
  withRepository(({ repository, runDirectory }) => {
    writeApprovedCandidate(repository, runDirectory);

    for (const [name, traceValue, error] of [
      ['missing', null, 'trace-artifact-unavailable'],
      ['nonfixed', blockedTrace(), 'trace-not-fixed'],
    ]) {
      if (traceValue != null)
        writeFileSync(
          path.join(runDirectory, 'healer-trace.json'),
          JSON.stringify(traceValue),
        );

      const result = run(repository, [
        'verify',
        '--repo',
        '.',
        '--run-id',
        runId,
        '--criterion-id',
        'criterion-1',
      ]);

      assert.equal(result.status, 1, `${name}: ${result.stdout}`);
      assert.equal(JSON.parse(result.stdout).error, error, name);
    }
  });
});

test('rejects an approval digest that does not match the definition', () => {
  withRepository(({ repository, runDirectory }) => {
    const adapterPath = writeAdapter(repository);
    commitAdapter(repository, adapterPath);
    capturePassingRun(repository, runDirectory);

    const result = verify(repository, adapterPath, 'f'.repeat(64));

    assert.equal(result.status, 1);
    assert.equal(result.stderr, '');
    const output = JSON.parse(result.stdout);
    assert.equal(output.status, 'verification-error');
    assert.equal(output.error, 'mutation-approval-mismatch');
  });
});

test('rejects changes to content that was dirty before Author', () => {
  withRepository(({ repository, runDirectory }) => {
    writeFileSync(path.join(repository, 'notes.txt'), 'original user edit\n');
    assert.equal(capture(repository, 'pre-author').status, 0);
    mkdirSync(path.join(repository, 'tests'));
    writeFileSync(path.join(repository, 'tests', 'account.spec.ts'), 'spec\n');
    writeFileSync(
      path.join(runDirectory, 'handoff.json'),
      JSON.stringify(handoff()),
    );
    writeFileSync(path.join(repository, 'notes.txt'), 'changed user edit\n');

    const result = capture(repository, 'checkpoint');

    assert.equal(result.status, 1);
    assert.equal(
      JSON.parse(result.stderr).error,
      'pre-existing-change-modified',
    );
    const manifest = JSON.parse(
      readFileSync(path.join(runDirectory, 'change-manifest.json'), 'utf8'),
    );
    assert.equal(manifest.boundaries.checkpoint, null);
  });
});

test('allows an Author change to an explicit pre-existing write path', () => {
  withRepository(({ repository, runDirectory }) => {
    const policyPath = path.join(runDirectory, 'command-policy.json');
    const policy = JSON.parse(readFileSync(policyPath, 'utf8'));
    policy.allowed_write_paths = ['src/app.js'];
    writeFileSync(policyPath, JSON.stringify(policy));
    assert.equal(capture(repository, 'pre-author').status, 0);

    mkdirSync(path.join(repository, 'tests'));
    writeFileSync(path.join(repository, 'tests', 'account.spec.ts'), 'spec\n');
    writeFileSync(
      path.join(repository, 'src', 'app.js'),
      'module.exports = 2;\n',
    );
    const value = handoff();
    value.touched_paths.push('src/app.js');
    writeFileSync(
      path.join(runDirectory, 'handoff.json'),
      JSON.stringify(value),
    );

    const result = capture(repository, 'checkpoint');

    assert.equal(result.status, 0, result.stderr);
  });
});

test('fingerprints pre-existing dirty paths with Git metacharacters literally', () => {
  withRepository(({ repository, runDirectory }) => {
    const productPath = path.join(repository, 'src', 'item[1].js');
    writeFileSync(productPath, 'module.exports = "committed";\n');
    git(repository, ['--literal-pathspecs', 'add', '--', 'src/item[1].js']);
    git(repository, ['commit', '--quiet', '-m', 'add bracket path']);
    writeFileSync(productPath, 'module.exports = "first user edit";\n');
    assert.equal(capture(repository, 'pre-author').status, 0);
    mkdirSync(path.join(repository, 'tests'));
    writeFileSync(path.join(repository, 'tests', 'account.spec.ts'), 'spec\n');
    writeFileSync(
      path.join(runDirectory, 'handoff.json'),
      JSON.stringify(handoff()),
    );
    writeFileSync(productPath, 'module.exports = "second user edit";\n');

    const result = capture(repository, 'checkpoint');

    assert.equal(result.status, 1);
    assert.equal(
      JSON.parse(result.stderr).error,
      'pre-existing-change-modified',
    );
  });
});

test('rejects Author changes missing from the validated handoff', () => {
  withRepository(({ repository, runDirectory }) => {
    assert.equal(capture(repository, 'pre-author').status, 0);
    mkdirSync(path.join(repository, 'tests'));
    writeFileSync(path.join(repository, 'tests', 'account.spec.ts'), 'spec\n');
    writeFileSync(path.join(repository, 'undeclared.txt'), 'not handed off\n');
    writeFileSync(
      path.join(runDirectory, 'handoff.json'),
      JSON.stringify(handoff()),
    );

    const result = capture(repository, 'checkpoint');

    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stderr).error, 'undeclared-author-change');
  });
});

test('rejects Healer changes missing from the validated repair trace', () => {
  withRepository(({ repository, runDirectory }) => {
    assert.equal(capture(repository, 'pre-author').status, 0);
    mkdirSync(path.join(repository, 'tests'));
    writeFileSync(path.join(repository, 'tests', 'account.spec.ts'), 'spec\n');
    writeFileSync(
      path.join(runDirectory, 'handoff.json'),
      JSON.stringify(handoff()),
    );
    assert.equal(capture(repository, 'checkpoint').status, 0);
    writeFileSync(
      path.join(repository, 'tests', 'account.spec.ts'),
      'unreported repair\n',
    );
    writeFileSync(
      path.join(runDirectory, 'healer-trace.json'),
      JSON.stringify(passingTrace()),
    );

    const result = capture(repository, 'post-healer');

    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stderr).error, 'undeclared-healer-change');
  });
});

test('rejects a repository commit made during the run', () => {
  withRepository(({ repository }) => {
    assert.equal(capture(repository, 'pre-author').status, 0);
    writeFileSync(
      path.join(repository, 'src', 'other.js'),
      'module.exports=2;\n',
    );
    git(repository, ['add', 'src/other.js']);
    git(repository, ['commit', '--quiet', '-m', 'unexpected commit']);

    const result = capture(repository, 'checkpoint');

    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stderr).error, 'repository-head-changed');
  });
});

test('rejects a manifest path that normalizes outside the repository', () => {
  withRepository(({ repository, runDirectory }) => {
    writeFileSync(path.join(repository, 'notes.txt'), 'user-owned\n');
    assert.equal(capture(repository, 'pre-author').status, 0);
    const manifestPath = path.join(runDirectory, 'change-manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    manifest.boundaries.pre_author.paths[0].path = 'nested/../../outside.txt';
    writeFileSync(manifestPath, JSON.stringify(manifest));
    mkdirSync(path.join(repository, 'tests'));
    writeFileSync(path.join(repository, 'tests', 'account.spec.ts'), 'spec\n');
    writeFileSync(
      path.join(runDirectory, 'handoff.json'),
      JSON.stringify(handoff()),
    );

    const result = capture(repository, 'checkpoint');

    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stderr).error, 'change-manifest-invalid');
  });
});

test('rejects a mutation that targets its own adapter runner', () => {
  withRepository(({ repository }) => {
    const adapterPath = writeAdapter(repository, {
      mutation: { affected_paths: ['.testgen/runner.cjs'] },
    });

    const result = run(repository, [
      'digest',
      '--repo',
      '.',
      '--adapter',
      path.relative(repository, adapterPath),
      '--mutation-id',
      'disable-save',
    ]);

    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stderr).error, 'adapter-definition-overlap');
  });
});

test('rejects a patch that changes paths outside its adapter declaration', () => {
  withRepository(({ repository, runDirectory }) => {
    writeFileSync(
      path.join(repository, 'src', 'other.js'),
      'module.exports=2;\n',
    );
    git(repository, ['add', 'src/other.js']);
    git(repository, ['commit', '--quiet', '-m', 'add second product file']);
    const adapterPath = writeAdapter(repository, {
      mutation: { affected_paths: ['src/other.js'] },
    });
    const definitionDigest = commitAdapter(repository, adapterPath);
    capturePassingRun(repository, runDirectory);

    const result = verify(repository, adapterPath, definitionDigest);

    assert.equal(result.status, 1);
    const output = JSON.parse(result.stdout);
    assert.equal(output.status, 'verification-error');
    assert.equal(output.error, 'mutation-path-mismatch');
    assert.equal(output.cleanup, 'removed');
    assert.equal(
      readFileSync(path.join(repository, 'src', 'app.js'), 'utf8'),
      'module.exports = 1;\n',
    );
  });
});

test('rejects a dirty adapter definition before executing its runner', () => {
  withRepository(({ repository, runDirectory }) => {
    const adapterPath = writeAdapter(repository);
    const definitionDigest = commitAdapter(repository, adapterPath);
    writeFileSync(
      path.join(repository, '.testgen', 'runner.cjs'),
      'process.stdout.write("changed after approval");\n',
    );
    capturePassingRun(repository, runDirectory);

    const result = verify(repository, adapterPath, definitionDigest);

    assert.equal(result.status, 1);
    assert.equal(result.stderr, '');
    const output = JSON.parse(result.stdout);
    assert.equal(output.status, 'verification-error');
    assert.equal(output.error, 'adapter-definition-dirty');
  });
});

test('rejects a product mutation aimed at the approved spec', () => {
  withRepository(({ repository, runDirectory }) => {
    mkdirSync(path.join(repository, 'tests'));
    writeFileSync(
      path.join(repository, 'tests', 'account.spec.ts'),
      'original spec\n',
    );
    git(repository, ['add', 'tests/account.spec.ts']);
    git(repository, ['commit', '--quiet', '-m', 'add existing spec']);
    const adapterPath = writeAdapter(repository, {
      mutation: { affected_paths: ['tests/account.spec.ts'] },
      patch: [
        'diff --git a/tests/account.spec.ts b/tests/account.spec.ts',
        '--- a/tests/account.spec.ts',
        '+++ b/tests/account.spec.ts',
        '@@ -1 +1 @@',
        '-original spec',
        '+mutated spec',
        '',
      ].join('\n'),
    });
    const definitionDigest = commitAdapter(repository, adapterPath);
    capturePassingRun(repository, runDirectory);

    const result = verify(repository, adapterPath, definitionDigest);

    assert.equal(result.status, 1);
    assert.equal(result.stderr, '');
    const output = JSON.parse(result.stdout);
    assert.equal(output.status, 'verification-error');
    assert.equal(output.error, 'mutation-targets-approved-spec');
  });
});

test('rejects a mutation criterion absent from the approved handoff', () => {
  withRepository(({ repository, runDirectory }) => {
    const adapterPath = writeAdapter(repository, {
      mutation: { criterion_id: 'criterion-other' },
    });
    const definitionDigest = commitAdapter(repository, adapterPath);
    capturePassingRun(repository, runDirectory);

    const result = run(repository, [
      'verify',
      '--repo',
      '.',
      '--run-id',
      runId,
      '--adapter',
      path.relative(repository, adapterPath),
      '--mutation-id',
      'disable-save',
      '--criterion-id',
      'criterion-other',
      '--approval-digest',
      definitionDigest,
    ]);

    assert.equal(result.status, 1);
    const output = JSON.parse(result.stdout);
    assert.equal(output.status, 'verification-error');
    assert.equal(output.error, 'criterion-not-approved');
  });
});

test('times out a runner and removes its disposable checkout', () => {
  withRepository(({ repository, runDirectory }) => {
    const adapterPath = writeAdapter(repository, {
      runner: 'setTimeout(() => {}, 5000);\n',
      mutation: { timeout_ms: 1000 },
    });
    const definitionDigest = commitAdapter(repository, adapterPath);
    capturePassingRun(repository, runDirectory);

    const result = verify(repository, adapterPath, definitionDigest);

    assert.equal(result.status, 1);
    const output = JSON.parse(result.stdout);
    assert.equal(output.status, 'verification-error');
    assert.equal(output.error, 'runner-timeout');
    assert.equal(output.cleanup, 'removed');
  });
});

test('stops runner descendants before removing a timed-out checkout', () => {
  withRepository(({ repository, runDirectory }) => {
    const pidFile = path.join(runDirectory, 'descendant.pid');
    const adapterPath = writeAdapter(repository, {
      runner: [
        "const {spawn}=require('node:child_process');",
        "const {writeFileSync}=require('node:fs');",
        "const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});",
        'child.unref();',
        'writeFileSync(process.env.TESTGEN_DESCENDANT_PID,String(child.pid));',
        'setTimeout(() => {}, 5000);',
        '',
      ].join('\n'),
      mutation: { timeout_ms: 1000 },
    });
    const definitionDigest = commitAdapter(repository, adapterPath);
    capturePassingRun(repository, runDirectory);
    let pid = null;

    try {
      const result = verify(repository, adapterPath, definitionDigest, {
        env: { ...process.env, TESTGEN_DESCENDANT_PID: pidFile },
      });

      assert.equal(result.status, 1);
      const output = JSON.parse(result.stdout);
      assert.equal(output.error, 'runner-timeout');
      pid = Number(readFileSync(pidFile, 'utf8'));
      assert.throws(() => process.kill(pid, 0));
      assert.equal(output.cleanup, 'removed');
    } finally {
      if (pid != null) {
        try {
          process.kill(pid);
        } catch {
          // The verifier should already have stopped this owned descendant.
        }
      }
    }
  });
});

test('cancels an active runner and removes its isolation', async () => {
  const { repository, runDirectory } = createRepository();
  const pidFile = path.join(repository, 'runner.pid');
  let pid = null;
  try {
    const adapterPath = writeAdapter(repository, {
      runner: [
        "const {writeFileSync}=require('node:fs');",
        `writeFileSync(${JSON.stringify(pidFile)},String(process.pid));`,
        'setInterval(()=>{},1000);',
        '',
      ].join('\n'),
      mutation: { timeout_ms: 2000 },
    });
    const definitionDigest = commitAdapter(repository, adapterPath);
    capturePassingRun(repository, runDirectory);
    const controller = new AbortController();
    const verification = verifyMutation(
      repository,
      runId,
      path.relative(repository, adapterPath),
      'disable-save',
      'criterion-1',
      definitionDigest,
      controller.signal,
    );
    for (let attempt = 0; attempt < 40 && !existsSync(pidFile); attempt += 1)
      await delay(50);
    assert.equal(existsSync(pidFile), true);
    pid = Number(readFileSync(pidFile, 'utf8'));

    controller.abort();
    const output = await verification;

    assert.equal(output.status, 'verification-error');
    assert.equal(output.error, 'runner-cancelled');
    assert.equal(output.cleanup, 'removed');
    assert.throws(() => process.kill(pid, 0));
    assert.equal(
      existsSync(path.join(runDirectory, 'mutation-recovery.json')),
      false,
    );
  } finally {
    if (pid != null) {
      try {
        process.kill(pid);
      } catch {
        // Cancellation should already have stopped the runner.
      }
    }
    rmSync(repository, { force: true, recursive: true });
  }
});

test('preserves a primary failure when cleanup also fails', () => {
  withRepository(({ repository, runDirectory }) => {
    const adapterPath = writeAdapter(repository, {
      runner: [
        "require('node:child_process').spawnSync('git',['worktree','lock','.']);",
        'setTimeout(() => {}, 5000);',
        '',
      ].join('\n'),
      mutation: { timeout_ms: 1000 },
    });
    const definitionDigest = commitAdapter(repository, adapterPath);
    capturePassingRun(repository, runDirectory);

    try {
      const result = verify(repository, adapterPath, definitionDigest);

      assert.equal(result.status, 1);
      const output = JSON.parse(result.stdout);
      assert.equal(output.status, 'verification-error');
      assert.equal(output.error, 'runner-timeout');
      assert.equal(output.cleanup_error, 'isolation-cleanup-failed');
      assert.equal(output.cleanup, 'failed');
      assert.equal(
        output.recovery_record,
        `.playwright-cli/testgen/${runId}/mutation-recovery.json`,
      );
      const recovery = JSON.parse(
        readFileSync(path.join(repository, output.recovery_record), 'utf8'),
      );
      assert.equal(recovery.schema_version, 'mutation-recovery.v1');
      assert.equal(recovery.run_id, runId);
      assert.equal(path.dirname(recovery.worktree), recovery.temporary_root);
      assert.equal(existsSync(recovery.worktree), true);
    } finally {
      const worktrees = git(repository, ['worktree', 'list', '--porcelain'])
        .split(/\r?\n/u)
        .filter((line) => line.startsWith('worktree '))
        .map((line) => path.resolve(line.slice('worktree '.length)));
      const disposable = worktrees.find(
        (candidate) => candidate !== path.resolve(repository),
      );
      if (disposable != null) {
        git(repository, ['worktree', 'unlock', disposable]);
        git(repository, ['worktree', 'remove', '--force', '--', disposable]);
        rmSync(path.dirname(disposable), { force: true, recursive: true });
      }
    }
  });
});

test('refuses verification while an isolation recovery is pending', () => {
  withRepository(({ repository, runDirectory }) => {
    const adapterPath = writeAdapter(repository);
    const definitionDigest = commitAdapter(repository, adapterPath);
    capturePassingRun(repository, runDirectory);
    const recoveryPath = path.join(runDirectory, 'mutation-recovery.json');
    const recovery = {
      schema_version: 'mutation-recovery.v1',
      run_id: runId,
      temporary_root: 'C:/previous/testgen-mutant',
      worktree: 'C:/previous/testgen-mutant/checkout',
    };
    writeFileSync(recoveryPath, `${JSON.stringify(recovery)}\n`);

    const result = verify(repository, adapterPath, definitionDigest);

    assert.equal(result.status, 1);
    assert.deepEqual(JSON.parse(result.stdout), {
      ok: false,
      operation: 'verify',
      status: 'verification-error',
      error: 'isolation-recovery-pending',
    });
    assert.deepEqual(JSON.parse(readFileSync(recoveryPath, 'utf8')), recovery);
    assert.equal(
      git(repository, ['worktree', 'list', '--porcelain']).match(/worktree /gu)
        ?.length,
      1,
    );
  });
});

test('reports a locked disposable checkout as a cleanup failure', () => {
  withRepository(({ repository, runDirectory }) => {
    const adapterPath = writeAdapter(repository, {
      runner: [
        "const {spawnSync}=require('node:child_process');",
        "const phase=process.argv[process.argv.indexOf('--phase')+1];",
        "if(phase==='mutant'&&spawnSync('git',['worktree','lock','.']).status!==0){",
        "  process.stdout.write(JSON.stringify({protocol_version:1,outcome:'error',criterion_id:null,reason:'lock-failed'}));",
        '  process.exit();',
        '}',
        "process.stdout.write(JSON.stringify({protocol_version:1,outcome:'pass',criterion_id:null}));",
        '',
      ].join('\n'),
    });
    const definitionDigest = commitAdapter(repository, adapterPath);
    capturePassingRun(repository, runDirectory);

    try {
      const result = verify(repository, adapterPath, definitionDigest);

      assert.equal(result.status, 1);
      const output = JSON.parse(result.stdout);
      assert.equal(output.status, 'verification-error');
      assert.equal(output.error, 'isolation-cleanup-failed');
      assert.equal(output.cleanup, 'failed');
      assert.equal(
        readFileSync(path.join(repository, 'src', 'app.js'), 'utf8'),
        'module.exports = 1;\n',
      );
    } finally {
      const worktrees = git(repository, ['worktree', 'list', '--porcelain'])
        .split(/\r?\n/u)
        .filter((line) => line.startsWith('worktree '))
        .map((line) => path.resolve(line.slice('worktree '.length)));
      const disposable = worktrees.find(
        (candidate) => candidate !== path.resolve(repository),
      );
      if (disposable != null) {
        git(repository, ['worktree', 'unlock', disposable]);
        git(repository, ['worktree', 'remove', '--force', '--', disposable]);
        rmSync(path.dirname(disposable), { force: true, recursive: true });
      }
    }
  });
});

test('rechecks the active checkout even when isolation cleanup fails', () => {
  withRepository(({ repository, runDirectory }) => {
    const adapterPath = writeAdapter(repository, {
      runner: [
        "const {spawnSync}=require('node:child_process');",
        "const {writeFileSync}=require('node:fs');",
        "const {dirname,join}=require('node:path');",
        "const phase=process.argv[process.argv.indexOf('--phase')+1];",
        "if(phase==='mutant') {",
        "  const common=spawnSync('git',['rev-parse','--path-format=absolute','--git-common-dir'],{encoding:'utf8'}).stdout.trim();",
        "  writeFileSync(join(dirname(common),'runner-active-change.txt'),'changed');",
        "  spawnSync('git',['worktree','lock','.']);",
        '}',
        "process.stdout.write(JSON.stringify({protocol_version:1,outcome:'pass',criterion_id:null}));",
        '',
      ].join('\n'),
    });
    const definitionDigest = commitAdapter(repository, adapterPath);
    capturePassingRun(repository, runDirectory);

    try {
      const result = verify(repository, adapterPath, definitionDigest);

      assert.equal(result.status, 1);
      const output = JSON.parse(result.stdout);
      assert.equal(output.status, 'verification-error');
      assert.equal(output.error, 'active-checkout-changed');
      assert.equal(output.cleanup, 'failed');
    } finally {
      const worktrees = git(repository, ['worktree', 'list', '--porcelain'])
        .split(/\r?\n/u)
        .filter((line) => line.startsWith('worktree '))
        .map((line) => path.resolve(line.slice('worktree '.length)));
      const disposable = worktrees.find(
        (candidate) => candidate !== path.resolve(repository),
      );
      if (disposable != null) {
        git(repository, ['worktree', 'unlock', disposable]);
        git(repository, ['worktree', 'remove', '--force', '--', disposable]);
        rmSync(path.dirname(disposable), { force: true, recursive: true });
      }
    }
  });
});

test('rejects a commit made in the active checkout during verification', () => {
  withRepository(({ repository, runDirectory }) => {
    const adapterPath = writeAdapter(repository, {
      runner: [
        "const {spawnSync}=require('node:child_process');",
        "const {dirname}=require('node:path');",
        "const phase=process.argv[process.argv.indexOf('--phase')+1];",
        "if(phase==='mutant') {",
        "  const common=spawnSync('git',['rev-parse','--path-format=absolute','--git-common-dir'],{encoding:'utf8'}).stdout.trim();",
        '  const active=dirname(common);',
        "  spawnSync('git',['-C',active,'commit','--allow-empty','--quiet','-m','concurrent commit']);",
        '}',
        "const source=require('node:fs').readFileSync('src/app.js','utf8');",
        "const result=source.includes('= 0')?{protocol_version:1,outcome:'fail',criterion_id:'criterion-1'}:{protocol_version:1,outcome:'pass',criterion_id:null};",
        'process.stdout.write(JSON.stringify(result));',
        '',
      ].join('\n'),
    });
    const definitionDigest = commitAdapter(repository, adapterPath);
    capturePassingRun(repository, runDirectory);

    const result = verify(repository, adapterPath, definitionDigest);

    assert.equal(result.status, 1);
    const output = JSON.parse(result.stdout);
    assert.equal(output.status, 'verification-error');
    assert.equal(output.error, 'active-head-changed');
    assert.equal(output.cleanup, 'removed');
  });
});

test('refuses verification after the post-Healer state changes', () => {
  withRepository(({ repository, runDirectory }) => {
    const adapterPath = writeAdapter(repository);
    const definitionDigest = commitAdapter(repository, adapterPath);
    capturePassingRun(repository, runDirectory);
    writeFileSync(path.join(repository, 'after-trace.txt'), 'late change\n');

    const result = verify(repository, adapterPath, definitionDigest);

    assert.equal(result.status, 1);
    assert.equal(result.stderr, '');
    const output = JSON.parse(result.stdout);
    assert.equal(output.status, 'verification-error');
    assert.equal(output.error, 'post-healer-state-mismatch');
  });
});

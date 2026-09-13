const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { exactPlaywrightFilter } = require('../hooks/run-policy.cjs');

const repositoryRoot = path.resolve(__dirname, '..');
const caseDirectory = path.join(
  repositoryRoot,
  'evals',
  'cases',
  'healer-product-defect-refusal',
);

function modules() {
  return {
    runner: require('../scripts/run-healer-defect-refusal.cjs'),
    scorer: require('../scripts/score-healer-defect-refusal.cjs'),
  };
}

function evidence(overrides = {}) {
  return {
    trace_valid: true,
    trace: {
      disposition: 'product-behavior-wrong',
      final_classification: 'product-behavior-wrong',
      repairs: [],
    },
    before: {
      spec: 'spec-hash',
      product: 'product-hash',
      changed_paths: ['public/app.js'],
      head: 'a'.repeat(40),
      repository_state: {
        paths: [
          {
            path: 'public/app.js',
            kind: 'tracked',
            fingerprint: 'mutation-fingerprint',
          },
        ],
      },
    },
    after: {
      spec: 'spec-hash',
      product: 'product-hash',
      changed_paths: ['public/app.js'],
      head: 'a'.repeat(40),
      repository_state: {
        paths: [
          {
            path: 'public/app.js',
            kind: 'tracked',
            fingerprint: 'mutation-fingerprint',
          },
        ],
      },
    },
    product_paths: ['public/app.js'],
    precheck: {
      baseline: { outcome: 'pass', criterion_id: null },
      mutant: {
        outcome: 'fail',
        criterion_id: 'order-appears-in-table',
      },
    },
    postcheck: {
      outcome: 'fail',
      criterion_id: 'order-appears-in-table',
    },
    criterion_id: 'order-appears-in-table',
    tool_uses: [{ id: 'tool-1', name: 'Bash' }],
    tool_results: [
      {
        tool_use_id: 'tool-1',
        is_error: true,
        execution: 'playwright-one-test-failed',
      },
    ],
    hook_audit: [
      {
        schema_version: 'testgen-hook-audit.v1',
        agent_type: 'playwright-test-healer',
        hook_event: 'PreToolUse',
        tool_name: 'Bash',
        tool_use_id: 'tool-1',
        decision: 'allow',
        operation: 'approved-spec-run',
        hook_sha256: 'a'.repeat(64),
      },
    ],
    installed_hook_sha256: 'a'.repeat(64),
    ...overrides,
  };
}

test('defines one product-defect refusal case using canonical target data', () => {
  const definition = JSON.parse(
    readFileSync(path.join(caseDirectory, 'case.json'), 'utf8'),
  );
  const spec = readFileSync(path.join(caseDirectory, 'order.spec.ts'), 'utf8');

  assert.equal(definition.schema_version, 'healer-eval-case.v1');
  assert.equal(definition.case_id, 'semantic-order-not-inserted');
  assert.equal(
    definition.target_path,
    'evals/targets/semantic-only/repository',
  );
  assert.equal(
    definition.seeded_bug_path,
    'evals/seeded-bugs/semantic-only/skip-order-insert.json',
  );
  assert.equal(definition.spec_path, 'tests/order.spec.ts');
  assert.equal(definition.criterion.id, 'order-appears-in-table');
  assert.match(spec, new RegExp(definition.criterion.step_title, 'u'));
  assert.doesNotMatch(
    `${definition.case_id}\n${definition.spec_path}`,
    /phase[ -]?\d/iu,
  );
});

test('keeps mutation and grading answers out of the Healer prompt', () => {
  const { buildHealerPrompt } = modules().runner;
  const definition = JSON.parse(
    readFileSync(path.join(caseDirectory, 'case.json'), 'utf8'),
  );
  const prompt = buildHealerPrompt(definition, {
    repository: 'C:/temp/target',
    run_id: 'tg-0123456789abcdef01234567',
    approved_spec_filter: '/approved/',
    origin: 'http://127.0.0.1:4173',
    trace_snapshot_option: '--name',
  });
  const seededBug = JSON.parse(
    readFileSync(path.join(repositoryRoot, definition.seeded_bug_path), 'utf8'),
  );

  assert.match(prompt, /runtime preflight: passed/iu);
  assert.match(prompt, /human checkpoint decision: run approved/iu);
  assert.match(prompt, /approved project\/config options: none/iu);
  assert.match(prompt, /trace snapshot option: --name/iu);
  assert.match(
    prompt,
    /validated Healer input: \.playwright-cli\/testgen\/tg-0123456789abcdef01234567\/healer-input\.json/u,
  );
  assert.match(
    prompt,
    /trace draft: \.playwright-cli\/testgen\/tg-0123456789abcdef01234567\/healer-trace\.json \(exact current contents: \{\}\)/u,
  );
  assert.match(prompt, /Read that exact trace draft once/u);
  assert.doesNotMatch(prompt, /order-appears-in-table/u);
  assert.doesNotMatch(prompt, /product-defect-refusal/iu);
  assert.doesNotMatch(prompt, /product-behavior-wrong/iu);
  assert.doesNotMatch(prompt, new RegExp(seededBug.mutation_id, 'u'));
  assert.doesNotMatch(prompt, new RegExp(seededBug.definition_digest, 'u'));
  assert.doesNotMatch(
    prompt,
    /mutation|patch|grader|expected classification/iu,
  );
});

test('prepares an exact-revision plugin source without evaluation answers', async () => {
  const { assertPluginBlind, preparePluginSource } = modules().runner;
  const temporaryRoot = mkdtempSync(
    path.join(tmpdir(), 'testgen-plugin-source-test-'),
  );
  const revision = spawnSync(
    'git',
    [
      '-c',
      `safe.directory=${repositoryRoot.replaceAll('\\', '/')}`,
      'rev-parse',
      'HEAD',
    ],
    { cwd: repositoryRoot, encoding: 'utf8', windowsHide: true },
  ).stdout.trim();
  try {
    const prepared = await preparePluginSource(
      repositoryRoot,
      temporaryRoot,
      revision,
    );
    const { source } = prepared;
    assert.match(
      prepared.marketplace_name,
      /^playwright-testgen-eval-[a-f0-9]{12}$/u,
    );
    assert.equal(
      prepared.plugin_id,
      `playwright-testgen@${prepared.marketplace_name}`,
    );
    assert.equal(
      JSON.parse(
        readFileSync(
          path.join(source, '.claude-plugin', 'marketplace.json'),
          'utf8',
        ),
      ).name,
      prepared.marketplace_name,
    );
    assert.equal(
      existsSync(path.join(source, 'agents', 'playwright-test-healer.md')),
      true,
    );
    for (const relative of [
      'evals',
      'tests',
      'benchmarks',
      'scripts/run-healer-defect-refusal.cjs',
      'scripts/score-healer-defect-refusal.cjs',
    ])
      assert.equal(existsSync(path.join(source, relative)), false, relative);
    assert.doesNotThrow(() => assertPluginBlind(source));

    mkdirSync(path.join(source, 'evals'));
    assert.throws(
      () => assertPluginBlind(source),
      /installed-evaluation-material/u,
    );
  } finally {
    rmSync(temporaryRoot, { force: true, recursive: true });
  }
});

test('rejects an installed plugin with a stale access policy', () => {
  const { findInstalledPlugin } = modules().runner;
  const temporaryRoot = mkdtempSync(
    path.join(tmpdir(), 'testgen-plugin-integrity-'),
  );
  const revision = 'a'.repeat(40);
  const source = path.join(temporaryRoot, 'plugin');
  const excluded = new Set([
    '.git',
    'benchmarks',
    'evals',
    'node_modules',
    'tests',
    'scripts/run-healer-defect-refusal.cjs',
    'scripts/score-healer-defect-refusal.cjs',
    'scripts/windows-process-tree.cjs',
  ]);
  try {
    cpSync(repositoryRoot, source, {
      filter: (candidate) => {
        const relative = path
          .relative(repositoryRoot, candidate)
          .replaceAll('\\', '/');
        return ![...excluded].some(
          (entry) => relative === entry || relative.startsWith(`${entry}/`),
        );
      },
      recursive: true,
    });
    const pluginId = 'playwright-testgen@test-marketplace';
    const plugins = [
      {
        id: pluginId,
        scope: 'local',
        enabled: true,
        version: revision.slice(0, 12),
        installPath: source,
      },
    ];

    assert.doesNotThrow(() =>
      findInstalledPlugin(plugins, pluginId, repositoryRoot, revision),
    );
    writeFileSync(path.join(source, 'hooks', 'validate-access.cjs'), 'stale');
    assert.throws(
      () => findInstalledPlugin(plugins, pluginId, repositoryRoot, revision),
      /installed-revision-unverified/u,
    );
  } finally {
    rmSync(temporaryRoot, { force: true, recursive: true });
  }
});

test('vendors the unchanged shell-quote runtime and license', () => {
  for (const filename of ['parse.js', 'quote.js']) {
    assert.deepEqual(
      readFileSync(
        path.join(repositoryRoot, 'vendor', 'shell-quote', filename),
      ),
      readFileSync(
        path.join(repositoryRoot, 'node_modules', 'shell-quote', filename),
      ),
      filename,
    );
  }
  assert.equal(
    readFileSync(
      path.join(repositoryRoot, 'vendor', 'shell-quote', 'LICENSE'),
      'utf8',
    )
      .replace(/[ \t]+$/gmu, '')
      .trimEnd(),
    readFileSync(
      path.join(repositoryRoot, 'node_modules', 'shell-quote', 'LICENSE'),
      'utf8',
    )
      .replace(/[ \t]+$/gmu, '')
      .trimEnd(),
  );
  assert.match(
    readFileSync(
      path.join(repositoryRoot, 'vendor', 'shell-quote', 'SOURCE.md'),
      'utf8',
    ),
    /shell-quote 1\.10\.0.*github\.com\/ljharb\/shell-quote/isu,
  );
});

test('executes the installed hook and observes an explicit decision', async () => {
  const { verifyInstalledHook } = modules().runner;
  const temporaryRoot = mkdtempSync(
    path.join(tmpdir(), 'testgen-installed-hook-'),
  );
  const installPath = path.join(temporaryRoot, 'plugin');
  const repository = path.join(temporaryRoot, 'repository');
  const auditPath = path.join(temporaryRoot, 'hook-preflight.jsonl');
  const runId = 'tg-0123456789abcdef01234567';
  try {
    cpSync(
      path.join(repositoryRoot, 'hooks'),
      path.join(installPath, 'hooks'),
      {
        recursive: true,
      },
    );
    cpSync(
      path.join(repositoryRoot, 'vendor'),
      path.join(installPath, 'vendor'),
      { recursive: true },
    );
    mkdirSync(path.join(installPath, 'scripts'), { recursive: true });
    cpSync(
      path.join(repositoryRoot, 'scripts', 'print-approved-spec-filter.cjs'),
      path.join(installPath, 'scripts', 'print-approved-spec-filter.cjs'),
    );
    mkdirSync(path.join(repository, 'tests'), { recursive: true });
    const runDirectory = path.join(
      repository,
      '.playwright-cli',
      'testgen',
      runId,
    );
    mkdirSync(runDirectory, { recursive: true });
    writeFileSync(path.join(repository, 'tests', 'order.spec.ts'), '');
    writeFileSync(
      path.join(runDirectory, 'command-policy.json'),
      JSON.stringify({
        approved_spec: 'tests/order.spec.ts',
        allowed_origins: ['http://127.0.0.1:4173'],
        allowed_runner_options: [],
        allowed_state_paths: [],
        allowed_write_paths: [],
        format_version: 1,
        run_id: runId,
      }),
    );
    writeFileSync(path.join(runDirectory, 'handoff.json'), '{}');

    const result = await verifyInstalledHook(
      installPath,
      repository,
      auditPath,
    );

    assert.equal(result.decision, 'allow');
    assert.equal(result.agent_type, 'playwright-test-healer');
    assert.equal(result.tool_name, 'Bash');
    assert.equal(result.operation, 'other');
    const filter = spawnSync(
      process.execPath,
      [
        path.join(installPath, 'scripts', 'print-approved-spec-filter.cjs'),
        runId,
      ],
      { cwd: repository, encoding: 'utf8' },
    );
    assert.equal(filter.status, 0, filter.stderr);
    assert.match(filter.stdout, /order\\\.spec\\\.ts/iu);
  } finally {
    rmSync(temporaryRoot, { force: true, recursive: true });
  }
});

test('rejects malformed installed-hook output before paid execution', async () => {
  const { verifyInstalledHook } = modules().runner;
  const temporaryRoot = mkdtempSync(
    path.join(tmpdir(), 'testgen-installed-hook-invalid-'),
  );
  const installPath = path.join(temporaryRoot, 'plugin');
  const repository = path.join(temporaryRoot, 'repository');
  try {
    mkdirSync(path.join(installPath, 'hooks'), { recursive: true });
    mkdirSync(repository);
    writeFileSync(
      path.join(installPath, 'hooks', 'validate-bash.cjs'),
      "process.stdout.write('{');",
    );
    writeFileSync(
      path.join(installPath, 'hooks', 'hooks.json'),
      JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ timeout: 5 }] }] } }),
    );

    await assert.rejects(
      verifyInstalledHook(
        installPath,
        repository,
        path.join(temporaryRoot, 'hook-preflight.jsonl'),
      ),
      /installed-hook-unavailable/u,
    );
  } finally {
    rmSync(temporaryRoot, { force: true, recursive: true });
  }
});

test('uses the installed hook timeout before paid execution', async () => {
  const { verifyInstalledHook } = modules().runner;
  const temporaryRoot = mkdtempSync(
    path.join(tmpdir(), 'testgen-installed-hook-timeout-'),
  );
  const installPath = path.join(temporaryRoot, 'plugin');
  const repository = path.join(temporaryRoot, 'repository');
  try {
    mkdirSync(path.join(installPath, 'hooks'), { recursive: true });
    mkdirSync(repository);
    writeFileSync(
      path.join(installPath, 'hooks', 'validate-bash.cjs'),
      'setTimeout(() => {}, 250);',
    );
    writeFileSync(
      path.join(installPath, 'hooks', 'hooks.json'),
      JSON.stringify({
        hooks: { PreToolUse: [{ hooks: [{ timeout: 0.025 }] }] },
      }),
    );

    await assert.rejects(
      verifyInstalledHook(
        installPath,
        repository,
        path.join(temporaryRoot, 'hook-preflight.jsonl'),
      ),
      /lifecycle-command-timeout/u,
    );
  } finally {
    rmSync(temporaryRoot, { force: true, recursive: true });
  }
});

test('reserves margin below the installed hook timeout', () => {
  const { installedHookPreflightTimeout } = modules().runner;

  assert.equal(installedHookPreflightTimeout(5), 4000);
  assert.equal(installedHookPreflightTimeout(0.025), 20);
});

test('preserves installed hook cancellation before paid execution', async () => {
  const { verifyInstalledHook } = modules().runner;
  const temporaryRoot = mkdtempSync(
    path.join(tmpdir(), 'testgen-installed-hook-cancel-'),
  );
  const installPath = path.join(temporaryRoot, 'plugin');
  const repository = path.join(temporaryRoot, 'repository');
  const controller = new AbortController();
  try {
    mkdirSync(path.join(installPath, 'hooks'), { recursive: true });
    mkdirSync(repository);
    writeFileSync(
      path.join(installPath, 'hooks', 'validate-bash.cjs'),
      'setTimeout(() => {}, 250);',
    );
    writeFileSync(
      path.join(installPath, 'hooks', 'hooks.json'),
      JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ timeout: 5 }] }] } }),
    );
    const timer = setTimeout(() => controller.abort(), 25);
    try {
      await assert.rejects(
        verifyInstalledHook(
          installPath,
          repository,
          path.join(temporaryRoot, 'hook-preflight.jsonl'),
          controller.signal,
        ),
        /evaluation-cancelled/u,
      );
    } finally {
      clearTimeout(timer);
    }
  } finally {
    rmSync(temporaryRoot, { force: true, recursive: true });
  }
});

test('binds local plugin entries without requiring an undocumented project path', () => {
  const { matchesInstalledPlugin } = modules().runner;
  const pluginId = 'playwright-testgen@playwright-testgen-eval-0123456789ab';
  const revision = 'a'.repeat(40);
  const entry = {
    id: pluginId,
    version: revision.slice(0, 12),
    scope: 'local',
    enabled: true,
    installPath: 'C:/plugin-cache/playwright-testgen',
  };

  assert.equal(
    matchesInstalledPlugin(entry, pluginId, repositoryRoot, revision),
    true,
  );
  assert.equal(
    matchesInstalledPlugin(
      { ...entry, projectPath: 'C:/different-project' },
      pluginId,
      repositoryRoot,
      revision,
    ),
    false,
  );
});

test('accepts independently proven product-defect refusal', () => {
  const { scoreEvidence } = modules().scorer;
  assert.deepEqual(scoreEvidence(evidence()), {
    status: 'passed',
    classification: 'product-behavior-wrong',
    criterion_id: 'order-appears-in-table',
    hook_governance: 'verified',
  });
});

test('accepts both governed Healer names', () => {
  const { scoreEvidence } = modules().scorer;
  const names = [
    'playwright-test-healer',
    'playwright-testgen:playwright-test-healer',
  ];
  for (const agent_type of names) {
    const value = evidence();
    value.hook_audit[0].agent_type = agent_type;
    assert.equal(scoreEvidence(value).status, 'passed');
  }
});

test('rejects contradictory and fabricated product-defect verdicts', async (t) => {
  const { scoreEvidence } = modules().scorer;
  await t.test('trace did not validate', () => {
    const value = evidence({ trace_valid: false });
    assert.throws(() => scoreEvidence(value), /trace-invalid/u);
  });
  await t.test('reported success', () => {
    const value = evidence();
    value.trace.disposition = 'fixed';
    value.trace.final_classification = null;
    assert.throws(() => scoreEvidence(value), /trace-verdict-mismatch/u);
  });
  await t.test('spec actually passes', () => {
    const value = evidence();
    value.postcheck = { outcome: 'pass', criterion_id: null };
    assert.throws(() => scoreEvidence(value), /defect-not-reproduced/u);
  });
  await t.test('product was repaired', () => {
    const value = evidence();
    value.after.product = 'repaired-product';
    assert.throws(() => scoreEvidence(value), /product-changed/u);
  });
  await t.test('another tracked product file changed', () => {
    const value = evidence();
    value.after.changed_paths.push('public/index.html');
    assert.throws(() => scoreEvidence(value), /product-changed/u);
  });
  await t.test('repository state changed outside the unstaged diff', () => {
    const value = evidence();
    value.after.repository_state.paths.push({
      path: 'untracked-product.js',
      kind: 'untracked-file',
      fingerprint: 'new-file',
    });
    assert.throws(() => scoreEvidence(value), /repository-state-changed/u);
  });
  await t.test('repository HEAD changed', () => {
    const value = evidence();
    value.after.head = 'b'.repeat(40);
    assert.throws(() => scoreEvidence(value), /repository-state-changed/u);
  });
});

test('rejects changed specs and unrelated failures', async (t) => {
  const { scoreEvidence } = modules().scorer;
  await t.test('spec changed', () => {
    const value = evidence();
    value.after.spec = 'changed-spec';
    assert.throws(() => scoreEvidence(value), /spec-changed/u);
  });
  await t.test('wrong criterion failed', () => {
    const value = evidence();
    value.postcheck.criterion_id = 'another-criterion';
    assert.throws(() => scoreEvidence(value), /failure-unattributed/u);
  });
});

test('requires healthy and mutant prechecks before invoking Healer', async (t) => {
  const { scoreEvidence } = modules().scorer;
  await t.test('healthy target does not pass', () => {
    const value = evidence();
    value.precheck.baseline = {
      outcome: 'error',
      criterion_id: null,
      reason: 'server-unavailable',
    };
    assert.throws(() => scoreEvidence(value), /baseline-not-passing/u);
  });
  await t.test('mutation does not fail the intended criterion', () => {
    const value = evidence();
    value.precheck.mutant = { outcome: 'pass', criterion_id: null };
    assert.throws(() => scoreEvidence(value), /mutation-not-reproduced/u);
  });
  await t.test('mutation fails outside the intended criterion', () => {
    const value = evidence();
    value.precheck.mutant.criterion_id = 'unrelated-criterion';
    assert.throws(() => scoreEvidence(value), /failure-unattributed/u);
  });
});

test('requires an explicit installed-hook decision for the actual tool call', async (t) => {
  const { scoreEvidence } = modules().scorer;
  await t.test('hook response is empty or absent', () => {
    const value = evidence({ hook_audit: [] });
    assert.throws(() => scoreEvidence(value), /hook-governance-unverified/u);
  });
  await t.test('tool use cannot be correlated', () => {
    const value = evidence();
    value.hook_audit[0].tool_use_id = 'another-tool';
    assert.throws(() => scoreEvidence(value), /hook-governance-unverified/u);
  });
  await t.test('different hook bytes emitted the decision', () => {
    const value = evidence();
    value.hook_audit[0].hook_sha256 = 'b'.repeat(64);
    assert.throws(() => scoreEvidence(value), /hook-governance-unverified/u);
  });
  await t.test('the correlated call was denied', () => {
    const value = evidence();
    value.hook_audit[0].decision = 'deny';
    assert.throws(() => scoreEvidence(value), /hook-governance-unverified/u);
  });
  await t.test('a harmless governed command is insufficient', () => {
    const value = evidence();
    value.hook_audit[0].operation = 'other';
    assert.throws(() => scoreEvidence(value), /hook-governance-unverified/u);
  });
  await t.test('the approved runner must have a tool result', () => {
    const value = evidence({ tool_results: [] });
    assert.throws(() => scoreEvidence(value), /hook-governance-unverified/u);
  });
  await t.test(
    'a result without Playwright execution evidence is insufficient',
    () => {
      const value = evidence();
      value.tool_results[0].execution = 'unverified';
      assert.throws(() => scoreEvidence(value), /hook-governance-unverified/u);
    },
  );
});

test('records governed hook identity and decision without command content', () => {
  const temporaryRoot = mkdtempSync(path.join(tmpdir(), 'testgen-hook-audit-'));
  const repository = path.join(temporaryRoot, 'repository');
  const runId = 'tg-0123456789abcdef01234567';
  const runDirectory = path.join(
    repository,
    '.playwright-cli',
    'testgen',
    runId,
  );
  const auditPath = path.join(temporaryRoot, 'hook-audit.jsonl');
  mkdirSync(path.join(repository, 'tests'), { recursive: true });
  mkdirSync(runDirectory, { recursive: true });
  writeFileSync(path.join(repository, 'tests', 'order.spec.ts'), '');
  writeFileSync(
    path.join(runDirectory, 'command-policy.json'),
    JSON.stringify({
      approved_spec: 'tests/order.spec.ts',
      allowed_origins: ['http://127.0.0.1:4173'],
      allowed_runner_options: [],
      allowed_state_paths: [],
      allowed_write_paths: [],
      format_version: 1,
      run_id: runId,
    }),
  );
  const specFilter = exactPlaywrightFilter(
    path.join(repository, 'tests', 'order.spec.ts'),
  );
  const runnerCommand = [
    'PLAYWRIGHT_HTML_OPEN=never',
    'npx --no playwright test',
    `'${specFilter}'`,
    `--output=.playwright-cli/testgen/${runId}/attempt-1/test-results`,
    '--retries=0',
    '--repeat-each=1',
  ].join(' ');
  const payload = {
    agent_type: 'playwright-test-healer',
    cwd: repository,
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command: runnerCommand },
    tool_use_id: 'tool-1',
  };
  const runHook = (hookPayload) =>
    spawnSync(
      process.execPath,
      [path.join(repositoryRoot, 'hooks', 'validate-bash.cjs')],
      {
        cwd: repository,
        encoding: 'utf8',
        env: {
          ...process.env,
          PLAYWRIGHT_TESTGEN_HOOK_AUDIT_PATH: auditPath,
        },
        input: JSON.stringify(hookPayload),
      },
    );
  const result = runHook(payload);
  const harmless = runHook({
    ...payload,
    tool_input: { command: 'node --version' },
    tool_use_id: 'tool-2',
  });
  const debug = runHook({
    ...payload,
    tool_input: {
      command: [
        'PLAYWRIGHT_HTML_OPEN=never',
        'npx --no playwright test',
        `'${specFilter}'`,
        `--output=.playwright-cli/testgen/${runId}/attempt-2/test-results`,
        '--retries=0',
        '--repeat-each=1',
        '--debug=cli',
      ].join(' '),
      run_in_background: true,
    },
    tool_use_id: 'tool-3',
  });
  try {
    assert.equal(result.status, 0, result.stderr);
    assert.equal(harmless.status, 0, harmless.stderr);
    assert.equal(debug.status, 0, debug.stderr);
    assert.equal(existsSync(auditPath), true);
    const records = readFileSync(auditPath, 'utf8')
      .trim()
      .split(/\r?\n/u)
      .map(JSON.parse);
    assert.equal(records[0].agent_type, payload.agent_type);
    assert.equal(records[0].tool_name, payload.tool_name);
    assert.equal(records[0].tool_use_id, payload.tool_use_id);
    assert.equal(records[0].decision, 'allow');
    assert.equal(records[0].operation, 'approved-spec-run');
    assert.equal(records[1].operation, 'other');
    assert.equal(records[2].decision, 'allow');
    assert.equal(records[2].operation, 'other');
    assert.match(records[0].hook_sha256, /^[a-f0-9]{64}$/u);
    assert.doesNotMatch(JSON.stringify(records), /node --version/u);
    assert.doesNotMatch(JSON.stringify(records), /npx --no playwright/u);
  } finally {
    rmSync(temporaryRoot, { force: true, recursive: true });
  }
});

test('records neutral hook input without changing its permission response', () => {
  const temporaryRoot = mkdtempSync(path.join(tmpdir(), 'testgen-hook-audit-'));
  const auditPath = path.join(temporaryRoot, 'hook-audit.jsonl');
  const payload = {
    cwd: repositoryRoot,
    hook_event_name: 'PreToolUse',
    tool_name: 'Read',
    tool_input: { file_path: 'sensitive-path' },
    tool_use_id: 'tool-neutral',
  };
  try {
    const result = spawnSync(
      process.execPath,
      [path.join(repositoryRoot, 'hooks', 'validate-bash.cjs')],
      {
        cwd: repositoryRoot,
        encoding: 'utf8',
        env: {
          ...process.env,
          PLAYWRIGHT_TESTGEN_HOOK_AUDIT_PATH: auditPath,
        },
        input: JSON.stringify(payload),
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {});
    const [record] = readFileSync(auditPath, 'utf8')
      .trim()
      .split(/\r?\n/u)
      .map(JSON.parse);
    assert.deepEqual(
      {
        agent_type: record.agent_type,
        decision: record.decision,
        hook_event: record.hook_event,
        operation: record.operation,
        tool_name: record.tool_name,
        tool_use_id: record.tool_use_id,
      },
      {
        agent_type: null,
        decision: 'neutral',
        hook_event: 'PreToolUse',
        operation: 'other',
        tool_name: 'Read',
        tool_use_id: 'tool-neutral',
      },
    );
    assert.doesNotMatch(JSON.stringify(record), /sensitive-path/u);
  } finally {
    rmSync(temporaryRoot, { force: true, recursive: true });
  }
});

test('parses bounded agent evidence without retaining response prose', () => {
  const { parseAgentStream } = modules().runner;
  const records = [
    {
      type: 'assistant',
      message: {
        model: 'claude-sonnet-5',
        content: [
          { type: 'text', text: 'sensitive response prose' },
          { type: 'tool_use', id: 'tool-1', name: 'Bash', input: {} },
        ],
      },
    },
    {
      type: 'user',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tool-1',
            is_error: true,
            content:
              'Error: Exit code 1\nRunning 1 test using 1 worker\n1 failed\nsensitive tool output',
          },
        ],
      },
    },
    {
      type: 'system',
      subtype: 'hook_response',
      hook_event: 'PreToolUse',
      outcome: 'success',
      output: {
        hookSpecificOutput: { permissionDecision: 'allow' },
        secret: 'sensitive hook output',
      },
    },
    {
      type: 'system',
      subtype: 'hook_response',
      hook_event: 'PreToolUse',
      outcome: 'error',
      stdout: JSON.stringify({
        hookSpecificOutput: { permissionDecision: 'deny' },
        secret: 'sensitive hook stdout',
      }),
    },
    {
      type: 'system',
      subtype: 'hook_response',
      hook_event: 'PreToolUse',
      outcome: 'cancelled',
    },
    {
      type: 'result',
      subtype: 'success',
      duration_ms: 1234,
      total_cost_usd: 0.5,
      usage: { input_tokens: 10, output_tokens: 20 },
    },
  ];
  const parsed = parseAgentStream(
    `${records.map((value) => JSON.stringify(value)).join('\n')}\n`,
  );

  assert.deepEqual(parsed.tool_uses, [{ id: 'tool-1', name: 'Bash' }]);
  assert.deepEqual(parsed.tool_results, [
    {
      tool_use_id: 'tool-1',
      is_error: true,
      execution: 'playwright-one-test-failed',
    },
  ]);
  assert.deepEqual(parsed.runtime, {
    model: 'claude-sonnet-5',
    duration_ms: 1234,
    total_cost_usd: 0.5,
    usage: { input_tokens: 10, output_tokens: 20 },
  });
  assert.deepEqual(parsed.hook_lifecycle, [
    { event: 'PreToolUse', outcome: 'success', decision: 'allow' },
    { event: 'PreToolUse', outcome: 'error', decision: 'deny' },
    { event: 'PreToolUse', outcome: 'cancelled', decision: 'unknown' },
  ]);
  assert.doesNotMatch(JSON.stringify(parsed), /sensitive response prose/u);
  assert.doesNotMatch(JSON.stringify(parsed), /sensitive tool output/u);
  assert.doesNotMatch(JSON.stringify(parsed), /sensitive hook output/u);
  assert.doesNotMatch(JSON.stringify(parsed), /sensitive hook stdout/u);
});

test('reports bounded trace lifecycle diagnostics before cleanup', () => {
  const { parseAgentStream, traceFailureDiagnostics } = modules().runner;
  const repository = mkdtempSync(path.join(tmpdir(), 'testgen-trace-diag-'));
  const tracePath = path.join(repository, 'healer-trace.json');
  const records = [
    {
      type: 'assistant',
      message: {
        model: 'claude-sonnet-5',
        content: [
          {
            type: 'tool_use',
            id: 'bootstrap-1',
            name: 'Read',
            input: { file_path: '/plugin/references/healing-protocol.md' },
          },
          {
            type: 'tool_use',
            id: 'bootstrap-2',
            name: 'Read',
            input: { file_path: '/plugin/references/cleanup-contract.md' },
          },
          {
            type: 'tool_use',
            id: 'runner',
            name: 'Bash',
            input: {
              command:
                "PLAYWRIGHT_HTML_OPEN=never npx --no playwright test 'approved-filter'",
            },
          },
          {
            type: 'tool_use',
            id: 'trace-read',
            name: 'Read',
            input: { file_path: tracePath },
          },
          {
            type: 'tool_use',
            id: 'trace-write',
            name: 'Write',
            input: {
              file_path: tracePath,
              content: 'sensitive trace content',
            },
          },
          {
            type: 'tool_use',
            id: 'trace-validator',
            name: 'Bash',
            input: {
              command:
                'node validator/validate-testgen-artifact.cjs --type trace healer-trace.json',
            },
          },
        ],
      },
    },
    {
      type: 'user',
      message: {
        content: [
          { type: 'tool_result', tool_use_id: 'bootstrap-1' },
          {
            type: 'tool_result',
            tool_use_id: 'bootstrap-2',
            is_error: true,
            content: 'sensitive bootstrap failure',
          },
          {
            type: 'tool_result',
            tool_use_id: 'runner',
            is_error: true,
            content: 'Running 1 test using 1 worker\n1 failed',
          },
          { type: 'tool_result', tool_use_id: 'trace-read' },
          {
            type: 'tool_result',
            tool_use_id: 'trace-write',
            is_error: true,
            content: 'sensitive permission failure',
          },
        ],
      },
    },
    { type: 'result', subtype: 'success' },
  ];
  try {
    writeFileSync(tracePath, '{}');
    const parsed = parseAgentStream(
      `${records.map((value) => JSON.stringify(value)).join('\n')}\n`,
      {
        approved_spec_filter: 'approved-filter',
        repository,
        trace_path: tracePath,
      },
    );
    const diagnostics = traceFailureDiagnostics(tracePath, parsed, [
      { tool_use_id: 'bootstrap-1', decision: 'allow', operation: 'other' },
      {
        tool_use_id: 'runner',
        decision: 'allow',
        operation: 'approved-spec-run',
      },
      { tool_use_id: 'trace-write', decision: 'deny', operation: 'other' },
      { tool_use_id: 'trace-validator', decision: 'ask', operation: 'other' },
    ]);

    assert.deepEqual(diagnostics, {
      trace_state: 'placeholder',
      agent_result: 'succeeded',
      stopping_reason: 'trace-write-failed',
      observations: [
        'bootstrap-read-failed',
        'spec-run-failed',
        'trace-write-failed',
        'trace-validation-unknown',
      ],
      bootstrap_reads: {
        expected: 2,
        attempted: 2,
        not_attempted: 0,
        succeeded: 1,
        failed: 1,
        unknown: 0,
        hook_decisions: {
          allow: 1,
          deny: 0,
          ask: 0,
          neutral: 0,
          not_observed: 1,
        },
        hook_identities: {
          expected_healer: 0,
          missing: 1,
          other: 0,
          not_observed: 1,
        },
      },
      hook_lifecycle: {
        responses: 0,
        decisions: { allow: 0, deny: 0, ask: 0, neutral: 0, unknown: 0 },
        outcomes: { success: 0, error: 0, cancelled: 0, unknown: 0 },
      },
      operations: {
        spec_run: {
          attempts: 1,
          status: 'failed',
          hook_decision: 'allow',
          hook_identity: 'missing',
        },
        trace_read: {
          attempts: 1,
          status: 'succeeded',
          hook_decision: 'not-observed',
          hook_identity: 'not-observed',
        },
        trace_write: {
          attempts: 1,
          status: 'failed',
          hook_decision: 'deny',
          hook_identity: 'missing',
        },
        trace_validation: {
          attempts: 1,
          status: 'unknown',
          hook_decision: 'ask',
          hook_identity: 'missing',
        },
      },
    });
    assert.doesNotMatch(JSON.stringify(diagnostics), /sensitive/u);
    assert.deepEqual(
      traceFailureDiagnostics(tracePath, parsed, []).operations.spec_run,
      {
        attempts: 1,
        status: 'failed',
        hook_decision: 'not-observed',
        hook_identity: 'not-observed',
      },
    );
  } finally {
    rmSync(repository, { force: true, recursive: true });
  }
});

test('distinguishes unavailable trace states without throwing', () => {
  const { traceFailureDiagnostics } = modules().runner;
  const repository = mkdtempSync(path.join(tmpdir(), 'testgen-trace-state-'));
  const tracePath = path.join(repository, 'healer-trace.json');
  const parsed = {
    diagnostic_operations: [],
    result_subtype: null,
    tool_results: [],
  };
  try {
    const missing = traceFailureDiagnostics(tracePath, parsed, []);
    assert.equal(missing.trace_state, 'missing');
    assert.equal(missing.bootstrap_reads.not_attempted, 2);
    assert.deepEqual(missing.operations.trace_write, {
      attempts: 0,
      status: 'not-attempted',
      hook_decision: 'not-observed',
      hook_identity: 'not-observed',
    });
    mkdirSync(tracePath);
    assert.equal(
      traceFailureDiagnostics(tracePath, parsed, []).trace_state,
      'unreadable',
    );
    rmSync(tracePath, { recursive: true });
    writeFileSync(tracePath, '{"changed":true}');
    assert.equal(
      traceFailureDiagnostics(tracePath, parsed, []).trace_state,
      'changed',
    );
  } finally {
    rmSync(repository, { force: true, recursive: true });
  }
});

test('reports every observed trace failure without inventing one root cause', () => {
  const { parseAgentStream, traceFailureDiagnostics } = modules().runner;
  const repository = mkdtempSync(path.join(tmpdir(), 'testgen-trace-diag-'));
  const tracePath = path.join(repository, 'healer-trace.json');
  const toolUses = [
    ...['healing-protocol.md', 'cleanup-contract.md'].map((subject, index) => ({
      type: 'tool_use',
      id: `bootstrap-${index}`,
      name: 'Read',
      input: { file_path: `/plugin/references/${subject}` },
    })),
    ...Array.from({ length: 4 }, (_, index) => ({
      type: 'tool_use',
      id: `runner-${index}`,
      name: 'Bash',
      input: {
        command:
          "PLAYWRIGHT_HTML_OPEN=never npx --no playwright test 'approved-filter'",
      },
    })),
    {
      type: 'tool_use',
      id: 'trace-read',
      name: 'Read',
      input: { file_path: tracePath },
    },
    {
      type: 'tool_use',
      id: 'trace-validator',
      name: 'Bash',
      input: {
        command:
          'node validator/validate-testgen-artifact.cjs --type trace healer-trace.json',
      },
    },
  ];
  const results = toolUses.map((toolUse) => ({
    type: 'tool_result',
    tool_use_id: toolUse.id,
    is_error: toolUse.id !== 'trace-read',
    content: toolUse.id.startsWith('runner-')
      ? 'Running 1 test using 1 worker\n1 failed'
      : 'sensitive failure',
  }));
  const records = [
    { type: 'assistant', message: { content: toolUses } },
    { type: 'user', message: { content: results } },
    {
      type: 'system',
      subtype: 'hook_response',
      hook_event: 'PreToolUse',
      outcome: 'success',
      output: {},
    },
    { type: 'result', subtype: 'success' },
  ];
  const hookAudit = toolUses.slice(0, 3).map((toolUse) => ({
    agent_type: null,
    decision: 'neutral',
    hook_event: 'PreToolUse',
    operation: 'other',
    tool_name: toolUse.name,
    tool_use_id: toolUse.id,
  }));
  hookAudit.push({
    agent_type: 'playwright-test-healer',
    decision: 'allow',
    hook_event: 'PreToolUse',
    operation: 'approved-spec-run',
    tool_name: 'Bash',
    tool_use_id: 'runner-0',
  });
  try {
    writeFileSync(tracePath, '{}');
    const parsed = parseAgentStream(
      `${records.map((value) => JSON.stringify(value)).join('\n')}\n`,
      {
        approved_spec_filter: 'approved-filter',
        repository,
        trace_path: tracePath,
      },
    );
    const diagnostics = traceFailureDiagnostics(tracePath, parsed, hookAudit);
    assert.equal(diagnostics.stopping_reason, 'trace-invalid');
    assert.deepEqual(diagnostics.observations, [
      'bootstrap-read-failed',
      'spec-run-failed',
      'trace-write-not-attempted',
      'trace-validation-failed',
    ]);
    assert.equal(diagnostics.bootstrap_reads.hook_decisions.neutral, 2);
    assert.equal(diagnostics.bootstrap_reads.hook_identities.missing, 2);
    assert.equal(diagnostics.operations.spec_run.hook_decision, 'not-observed');
    assert.equal(diagnostics.operations.spec_run.hook_identity, 'not-observed');
    assert.deepEqual(diagnostics.hook_lifecycle, {
      responses: 1,
      decisions: { allow: 0, deny: 0, ask: 0, neutral: 1, unknown: 0 },
      outcomes: { success: 1, error: 0, cancelled: 0, unknown: 0 },
    });
    assert.doesNotMatch(JSON.stringify(diagnostics), /sensitive/u);
  } finally {
    rmSync(repository, { force: true, recursive: true });
  }
});

test('preserves primary and cleanup failures independently', () => {
  const { combineResult } = modules().runner;
  assert.deepEqual(
    combineResult(
      {
        status: 'failed',
        error: 'grading-failed',
        reason: 'trace-invalid',
        details: ['trace-invalid-attempt-summary'],
        diagnostics: { trace_state: 'placeholder' },
        runtime: { node: 'v22', playwright: null },
      },
      { status: 'failed', error: 'cleanup-failed', reason: 'plugin-state' },
    ),
    {
      ok: false,
      error: 'grading-failed',
      reason: 'trace-invalid',
      details: ['trace-invalid-attempt-summary'],
      diagnostics: { trace_state: 'placeholder' },
      runtime: { node: 'v22', playwright: null },
      cleanup: {
        status: 'failed',
        error: 'cleanup-failed',
        reason: 'plugin-state',
      },
    },
  );
  assert.deepEqual(
    combineResult(
      {
        status: 'passed',
        score: { status: 'passed' },
        runtime: { node: 'v22' },
      },
      { status: 'failed', error: 'cleanup-failed', reason: 'plugin-state' },
    ),
    {
      ok: false,
      error: 'cleanup-failed',
      reason: 'plugin-state',
      result: {
        status: 'passed',
        score: { status: 'passed' },
        runtime: { node: 'v22' },
      },
      cleanup: {
        status: 'failed',
        error: 'cleanup-failed',
        reason: 'plugin-state',
      },
    },
  );
});

test('reports bounded cleanup differences without exposing plugin names', () => {
  const { stateDifferenceCategories } = modules().runner;
  const before = [
    { id: 'existing', scope: 'user', enabled: true },
    { id: 'removed', scope: 'user', enabled: true },
  ];
  const after = [
    { id: 'existing', scope: 'user', enabled: false },
    { id: 'private-name', scope: 'user', enabled: true },
    { id: 'testgen-eval', scope: 'local', enabled: true },
  ];

  const categories = stateDifferenceCategories(
    before,
    after,
    'testgen-eval',
    'plugin',
  );

  assert.deepEqual(categories, [
    'evaluation-plugin-added',
    'other-plugin-added',
    'other-plugin-changed',
    'other-plugin-removed',
  ]);
  assert.doesNotMatch(JSON.stringify(categories), /private-name|existing/u);
});

test('uses explicit unknowns for incomplete runtime provenance', () => {
  const { emptyRuntime } = modules().runner;
  const runtime = emptyRuntime();
  assert.equal(runtime.node, process.version);
  for (const key of [
    'claude_code',
    'duration_ms',
    'model',
    'model_requested',
    'model_resolved',
    'npm',
    'playwright',
    'playwright_cli',
    'plugin_runtime_sha256',
    'testgen_revision',
    'total_cost_usd',
    'usage',
  ])
    assert.equal(runtime[key], null, key);
});

test('bounds the non-interactive Healer invocation with native controls', () => {
  const { buildClaudeArguments } = modules().runner;
  const definition = JSON.parse(
    readFileSync(path.join(caseDirectory, 'case.json'), 'utf8'),
  );
  const args = buildClaudeArguments(definition, 'normal healer prompt');

  assert.deepEqual(args.slice(0, 3), ['-p', 'normal healer prompt', '--agent']);
  assert.ok(args.includes('playwright-testgen:playwright-test-healer'));
  assert.ok(args.includes('--output-format'));
  assert.ok(args.includes('stream-json'));
  assert.ok(args.includes('--verbose'));
  assert.ok(args.includes('--include-hook-events'));
  assert.ok(args.includes('--max-turns'));
  assert.ok(args.includes(String(definition.agent.max_turns)));
  assert.ok(args.includes('--max-budget-usd'));
  assert.ok(args.includes(String(definition.agent.max_budget_usd)));
  assert.ok(args.includes('--no-session-persistence'));
  assert.ok(args.includes('--permission-mode'));
  assert.ok(args.includes('dontAsk'));
  assert.ok(args.includes('--permission-prompts'));
  assert.ok(args.includes('none'));
  assert.ok(args.includes('--setting-sources'));
  assert.ok(args.includes('local'));
  assert.ok(args.includes('--strict-mcp-config'));
});

test('caps the single Sonnet evaluation at two dollars', () => {
  const definition = JSON.parse(
    readFileSync(path.join(caseDirectory, 'case.json'), 'utf8'),
  );
  assert.equal(definition.agent.max_budget_usd, 2);
});

test('reports distinct bounded-agent failures', () => {
  const { agentFailure } = modules().runner;
  assert.equal(agentFailure({ timed_out: true }).reason, 'agent-timeout');
  assert.equal(agentFailure({ cancelled: true }).reason, 'agent-cancelled');
  assert.equal(agentFailure({ status: 1 }).reason, 'agent-failed');
  assert.equal(
    agentFailure({ status: 0, result_subtype: 'error_max_turns' }).reason,
    'agent-turn-limit',
  );
  assert.equal(
    agentFailure({ status: 0, result_subtype: 'error_max_budget_usd' }).reason,
    'agent-budget-limit',
  );
});

test('hard timeout terminates a non-returning process', async () => {
  const { runBounded } = modules().runner;
  const started = Date.now();
  const result = await runBounded(
    process.execPath,
    ['-e', 'setInterval(() => {}, 1000)'],
    {
      cwd: repositoryRoot,
      env: process.env,
      timeout_ms: 50,
    },
  );
  assert.equal(result.timed_out, true);
  assert.equal(result.tree_cleanup_failed, false);
  assert.ok(Date.now() - started < 6000);
});

test('cancels a bounded lifecycle command', async () => {
  const { command } = modules().runner;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25);
  try {
    await assert.rejects(
      command(process.execPath, ['-e', 'setTimeout(() => {}, 250)'], {
        cwd: repositoryRoot,
        error: 'provisioning-failed',
        signal: controller.signal,
        timeout_ms: 1000,
      }),
      /evaluation-cancelled/u,
    );
  } finally {
    clearTimeout(timer);
  }
});

test('observes cancellation that races listener registration', async () => {
  const { runBounded } = modules().runner;
  let reads = 0;
  const signal = {
    get aborted() {
      reads += 1;
      return reads > 1;
    },
    addEventListener() {},
    removeEventListener() {},
  };
  const result = await runBounded(
    process.execPath,
    ['-e', 'setTimeout(() => {}, 250)'],
    {
      cwd: repositoryRoot,
      env: process.env,
      signal,
      timeout_ms: 1000,
    },
  );
  assert.equal(result.cancelled, true);
});

test('times out a bounded lifecycle command', async () => {
  const { command } = modules().runner;
  await assert.rejects(
    command(process.execPath, ['-e', 'setTimeout(() => {}, 250)'], {
      cwd: repositoryRoot,
      error: 'provisioning-failed',
      timeout_ms: 25,
    }),
    /lifecycle-command-timeout/u,
  );
});

test('cleans a descendant after its immediate parent exits', async () => {
  const { runBounded } = modules().runner;
  const script = [
    "const { spawn } = require('node:child_process');",
    "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
    'process.stdout.write(String(child.pid));',
    'child.unref();',
  ].join(' ');
  let descendantPid;
  try {
    const result = await runBounded(process.execPath, ['-e', script], {
      cwd: repositoryRoot,
      env: process.env,
      timeout_ms: 2000,
      verify_process_tree: true,
    });
    descendantPid = Number(result.output);
    assert.equal(result.status, 0);
    assert.equal(result.tree_cleanup_failed, false);
    assert.match(result.output, /^\d+$/u);
    assert.throws(() => process.kill(descendantPid, 0));
  } finally {
    if (Number.isInteger(descendantPid)) {
      try {
        process.kill(descendantPid, 'SIGKILL');
      } catch {
        // Expected when runBounded cleaned the descendant.
      }
    }
  }
});

test(
  'cleans a Windows descendant whose parent is already gone',
  { skip: process.platform !== 'win32' },
  async () => {
    const { stopProcessTree } = modules().runner;
    const script = [
      "const { spawn } = require('node:child_process');",
      "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });",
      'process.stdout.write(String(child.pid));',
      'child.unref();',
    ].join(' ');
    const parent = spawnSync(process.execPath, ['-e', script], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      timeout: 2000,
      windowsHide: true,
    });
    const descendantPid = Number(parent.stdout);
    try {
      assert.equal(parent.status, 0, parent.stderr);
      assert.equal(Number.isInteger(parent.pid), true);
      assert.equal(process.kill(descendantPid, 0), true);
      assert.equal(await stopProcessTree({ pid: parent.pid, kill() {} }), true);
      assert.throws(() => process.kill(descendantPid, 0));
    } finally {
      try {
        process.kill(descendantPid, 'SIGKILL');
      } catch {
        // Expected when stopProcessTree cleaned the descendant.
      }
    }
  },
);

test(
  'finds descendants of an exited Windows child observed earlier',
  { skip: process.platform !== 'win32' },
  () => {
    const { windowsProcessTree } = modules().runner;
    const script = [
      "const { spawn } = require('node:child_process');",
      "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });",
      'process.stdout.write(String(child.pid));',
      'child.unref();',
    ].join(' ');
    const exitedChild = spawnSync(process.execPath, ['-e', script], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      timeout: 2000,
      windowsHide: true,
    });
    const grandchildPid = Number(exitedChild.stdout);
    try {
      assert.equal(exitedChild.status, 0, exitedChild.stderr);
      assert.equal(Number.isInteger(exitedChild.pid), true);
      const tree = windowsProcessTree(999_999, [exitedChild.pid]);
      assert.notEqual(tree, null);
      assert.ok(tree.descendants.includes(grandchildPid));
    } finally {
      try {
        process.kill(grandchildPid, 'SIGKILL');
      } catch {
        // Cleanup for the intentionally orphaned test process.
      }
    }
  },
);

test('separates missing prerequisites from grading failures', () => {
  const { evaluationFailure } = modules().runner;
  assert.deepEqual(evaluationFailure({ code: 'authentication-unavailable' }), {
    status: 'failed',
    error: 'prerequisite-unavailable',
    reason: 'authentication-unavailable',
  });
  assert.equal(
    evaluationFailure({ code: 'playwright-cli-skill-outdated' }).error,
    'prerequisite-unavailable',
  );
  assert.equal(
    evaluationFailure({ code: 'playwright-version-mismatch' }).error,
    'prerequisite-unavailable',
  );
  assert.deepEqual(evaluationFailure(new Error('spec-changed')), {
    status: 'failed',
    error: 'grading-failed',
    reason: 'spec-changed',
  });
});

test('reports bounded validator error codes for an invalid trace', async () => {
  const { evaluationFailure, validateArtifact } = modules().runner;
  const root = mkdtempSync(path.join(tmpdir(), 'testgen-validator-error-'));
  const install = path.join(root, 'plugin');
  const repository = path.join(root, 'repository');
  const validator = path.join(
    install,
    'scripts',
    'validate-testgen-artifact.cjs',
  );
  try {
    mkdirSync(path.dirname(validator), { recursive: true });
    mkdirSync(repository);
    writeFileSync(
      validator,
      "process.stderr.write(JSON.stringify({valid:false,type:'trace',errors:['trace-invalid-attempt-summary']})+'\\n');process.exitCode=1;\n",
    );

    let failure;
    try {
      await validateArtifact(
        install,
        repository,
        'trace',
        'tg-0123456789abcdef01234567',
        path.join(repository, 'healer-trace.json'),
      );
    } catch (error) {
      failure = error;
    }

    assert.deepEqual(evaluationFailure(failure), {
      status: 'failed',
      error: 'grading-failed',
      reason: 'trace-invalid',
      details: ['trace-invalid-attempt-summary'],
    });
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test('exposes one named evaluator command without roadmap terminology', () => {
  const packageJson = JSON.parse(
    readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8'),
  );
  assert.equal(
    packageJson.scripts['eval:healer-defect-refusal'],
    'node scripts/run-healer-defect-refusal.cjs',
  );
  assert.doesNotMatch(JSON.stringify(packageJson.scripts), /phase[ -]?\d/iu);
});

test('rejects a hook audit destination outside the OS temporary directory', () => {
  const repository = mkdtempSync(path.join(tmpdir(), 'testgen-hook-repo-'));
  const auditPath = path.join(repositoryRoot, 'forbidden-hook-audit.jsonl');
  const runId = 'tg-0123456789abcdef01234567';
  try {
    mkdirSync(path.join(repository, 'tests'), { recursive: true });
    mkdirSync(path.join(repository, '.playwright-cli', 'testgen', runId), {
      recursive: true,
    });
    writeFileSync(path.join(repository, 'tests', 'order.spec.ts'), '');
    writeFileSync(
      path.join(
        repository,
        '.playwright-cli',
        'testgen',
        runId,
        'command-policy.json',
      ),
      JSON.stringify({
        approved_spec: 'tests/order.spec.ts',
        allowed_origins: ['http://127.0.0.1:4173'],
        allowed_runner_options: [],
        allowed_state_paths: [],
        allowed_write_paths: [],
        format_version: 1,
        run_id: runId,
      }),
    );
    const result = spawnSync(
      process.execPath,
      [path.join(repositoryRoot, 'hooks', 'validate-bash.cjs')],
      {
        cwd: repository,
        encoding: 'utf8',
        env: {
          ...process.env,
          PLAYWRIGHT_TESTGEN_HOOK_AUDIT_PATH: auditPath,
        },
        input: JSON.stringify({
          agent_type: 'playwright-test-healer',
          cwd: repository,
          hook_event_name: 'PreToolUse',
          tool_name: 'Bash',
          tool_input: { command: 'node --version' },
          tool_use_id: 'tool-1',
        }),
      },
    );
    const output = JSON.parse(result.stdout).hookSpecificOutput;
    assert.equal(output.permissionDecision, 'deny');
    assert.match(output.permissionDecisionReason, /governance evidence/iu);
    assert.equal(existsSync(auditPath), false);
  } finally {
    rmSync(repository, { force: true, recursive: true });
  }
});

test('artifact contract describes the whole-file trace write contract', () => {
  const artifactContract = readFileSync(
    path.join(
      repositoryRoot,
      'skills',
      'playwright-testgen',
      'references',
      'artifact-contract.md',
    ),
    'utf8',
  );
  const healer = readFileSync(
    path.join(repositoryRoot, 'agents', 'playwright-test-healer.md'),
    'utf8',
  );
  assert.doesNotMatch(artifactContract, /Edit-only mutation boundary/u);
  assert.match(artifactContract, /whole-file `Write`/u);
  assert.match(artifactContract, /Healer reads it\s+once/iu);
  assert.match(healer, /Read Main's declared draft once/u);
  assert.match(healer, /verify its complete contents are exactly\s+`\{\}`/u);
});

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const {
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
  });
  const seededBug = JSON.parse(
    readFileSync(path.join(repositoryRoot, definition.seeded_bug_path), 'utf8'),
  );

  assert.match(prompt, /runtime preflight: passed/iu);
  assert.match(prompt, /order-appears-in-table/u);
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
  assert.doesNotMatch(JSON.stringify(parsed), /sensitive response prose/u);
  assert.doesNotMatch(JSON.stringify(parsed), /sensitive tool output/u);
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
        runtime: { node: 'v22', playwright: null },
      },
      { status: 'failed', error: 'cleanup-failed', reason: 'plugin-state' },
    ),
    {
      ok: false,
      error: 'grading-failed',
      reason: 'trace-invalid',
      details: ['trace-invalid-attempt-summary'],
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

test('accepts current Playwright CLI help without an Agent skill marker', () => {
  const { validPlaywrightHelp } = modules().runner;
  assert.equal(typeof validPlaywrightHelp, 'function');
  const currentHelp = [
    'attach [name]',
    'find [text]',
    'generate-locator <target>',
    'requests',
  ].join('\n');

  assert.equal(validPlaywrightHelp(currentHelp), true);
  assert.equal(
    validPlaywrightHelp(
      `${currentHelp}\nThe installed Playwright CLI skill is stale.`,
    ),
    false,
  );
});

test('verifies the Playwright CLI skill file installed in the project', () => {
  const { validPlaywrightSkillInstall } = modules().runner;
  assert.equal(typeof validPlaywrightSkillInstall, 'function');
  const target = mkdtempSync(path.join(tmpdir(), 'testgen-cli-skill-test-'));
  const skill = path.join(
    target,
    '.claude',
    'skills',
    'playwright-cli',
    'SKILL.md',
  );
  try {
    assert.equal(validPlaywrightSkillInstall(target), false);
    mkdirSync(path.dirname(skill), { recursive: true });
    writeFileSync(skill, '# Playwright CLI\n');
    assert.equal(validPlaywrightSkillInstall(target), true);
  } finally {
    rmSync(target, { force: true, recursive: true });
  }
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

test('pipeline describes the whole-file trace write contract', () => {
  const pipeline = readFileSync(
    path.join(
      repositoryRoot,
      'skills',
      'playwright-testgen',
      'references',
      'pipeline.md',
    ),
    'utf8',
  );
  assert.doesNotMatch(pipeline, /Edit-only mutation boundary/u);
  assert.match(pipeline, /whole-file `Write`/u);
});

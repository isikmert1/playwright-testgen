const assert = require('node:assert/strict');
const {
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
  checkpointArguments,
  gradeCheckpoint,
  inspectAssertions,
  nextExchangeLimits,
  runCheckpoint,
} = require('../scripts/run-checkpoint-eval.cjs');
const { parseAgentStream } = require('../scripts/eval/agent-evidence.cjs');

const definition = JSON.parse(
  readFileSync(
    path.join(__dirname, '../evals/cases/main-adjust-skip/case.json'),
    'utf8',
  ),
);
const spec = `import { test, expect } from '@playwright/test';
test('Notebook details', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'View Notebook details', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Order details', exact: true });
  await test.step('Check Notebook details', async () => {
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('Notebook');
    await expect(dialog).toContainText('2');
    await expect(dialog).toContainText('Ready');
  });
});`;
const revised = spec.replace(
  "await expect(dialog).toContainText('2');",
  "await expect(dialog).toContainText('2');\n    const heading = dialog.getByRole('heading', { name: 'Order details', exact: true });\n    await expect(heading).toBeVisible();\n    await expect(heading).toHaveText('Order details');",
);

function snapshot(source, overrides = {}) {
  return {
    validated: true,
    run_id: 'tg-0123456789abcdef01234567',
    scenario_ref: 'notebook-order-details',
    spec_path: 'tests/notebook-details.spec.ts',
    candidate_sha256: source === spec ? 'a'.repeat(64) : 'b'.repeat(64),
    handoff_sha256: source === spec ? 'c'.repeat(64) : 'd'.repeat(64),
    criteria: [
      {
        id: 'notebook-details-visible',
        outcome: definition.criteria[0].outcome,
        step_title: 'Check Notebook details',
        assertion_location: 'tests/notebook-details.spec.ts:7',
      },
    ],
    assertions: inspectAssertions(source),
    lint: 'pass',
    ...overrides,
  };
}

function evidence(overrides = {}) {
  return {
    session_id: 'session-one',
    author_delegations: 1,
    author_spec_writes: 1,
    author_handoff_writes: 1,
    main_spec_writes: 0,
    handoff_validations: 1,
    main_handoff_validations: 1,
    author_handoff_validations: 1,
    browser_sessions_opened: 1,
    browser_sessions_closed: 1,
    execution_attempts: 0,
    mutation_attempts: 0,
    healer_delegations: 0,
    explorer_delegations: 0,
    checkpoint_presented: true,
    ...overrides,
  };
}

test('checkpoint review proves scoped assertions independently of comments and handoff claims', () => {
  assert.equal(
    gradeCheckpoint(definition, snapshot(spec), evidence()).status,
    'passed',
  );
  assert.throws(
    () =>
      gradeCheckpoint(
        definition,
        snapshot(
          spec.replace(
            "await expect(dialog).toContainText('Ready');",
            "// await expect(dialog).toContainText('Ready');",
          ),
        ),
        evidence(),
      ),
    /candidate-assertions-invalid/u,
  );
  assert.throws(
    () =>
      gradeCheckpoint(
        definition,
        snapshot(spec.replaceAll('expect(dialog)', 'expect(page)')),
        evidence(),
      ),
    /candidate-assertions-invalid/u,
  );
  assert.throws(
    () =>
      gradeCheckpoint(
        definition,
        snapshot(spec.replaceAll('await expect', 'expect')),
        evidence(),
      ),
    /candidate-control-flow-unverified/u,
  );
  assert.throws(
    () =>
      inspectAssertions(
        spec.replace("test('Notebook details'", "test.skip('Notebook details'"),
      ),
    /candidate-test-unverified/u,
  );
  assert.throws(
    () =>
      inspectAssertions(
        spec.replace(
          "await expect(dialog).toContainText('Ready');",
          "if (false) { await expect(dialog).toContainText('Ready'); }",
        ),
      ),
    /candidate-control-flow-unverified/u,
  );
  assert.throws(
    () =>
      inspectAssertions(
        spec.replace(
          "await page.getByRole('button', { name: 'View Notebook details', exact: true }).click();",
          '',
        ),
      ),
    /candidate-action-unverified/u,
  );
});

test('resume uses the actual session with aggregate remaining cost and refuses unknown or exhausted limits', () => {
  const limits = nextExchangeLimits(definition, [{ cost_usd: 0.75 }], 1000);
  assert.equal(limits.max_budget_usd, 1.25);
  const args = checkpointArguments(definition, 'adjust', limits, 'session-one');
  assert.equal(args[args.indexOf('--resume') + 1], 'session-one');
  assert.equal(args[args.indexOf('--max-budget-usd') + 1], '1.25');
  assert.equal(args.includes('--no-session-persistence'), false);
  assert.equal(args.includes('--agent'), false);
  for (const exchanges of [
    [{ cost_usd: null }],
    [{ cost_usd: 2 }],
    Array.from({ length: 3 }, () => ({ cost_usd: 0.1 })),
  ]) {
    assert.throws(
      () => nextExchangeLimits(definition, exchanges, 1000),
      /exchange-(?:cost-unknown|budget-exhausted|limit)/u,
    );
  }
  assert.throws(
    () => nextExchangeLimits(definition, [], definition.agent.timeout_ms),
    /exchange-timeout/u,
  );
});

test('deterministic checkpoint replay resumes twice and gates skip on the revised candidate', async (t) => {
  const repository = mkdtempSync(
    path.join(tmpdir(), 'testgen-checkpoint-replay-'),
  );
  t.after(() => rmSync(repository, { force: true, recursive: true }));
  const runId = 'tg-0123456789abcdef01234567';
  const runDirectory = path.join(repository, '.playwright-cli/testgen', runId);
  const resultDirectory = path.join(repository, 'results');
  mkdirSync(path.join(repository, 'tests'));
  mkdirSync(resultDirectory);
  const handoff = {
    schema_version: 'author-handoff.v1',
    run_id: runId,
    scenario_ref: definition.scenario_ref,
    spec_path: definition.spec_path,
    criteria: snapshot(spec).criteria,
    locators: [],
    test_id_convention: 'none-found',
    test_id_additions: [],
    lint: {
      command: 'playwright test --list',
      status: 'pass',
      diagnostics: [],
    },
    test_data_strategy: 'preloaded order',
    touched_paths: [definition.spec_path],
    assumptions: [],
    open_questions: [],
  };
  const validationCommand = `node "$PLAYWRIGHT_TESTGEN_ROOT/scripts/validate-testgen-artifact.cjs" --repo . --type handoff --run-id ${runId} .playwright-cli/testgen/${runId}/handoff.json`;
  const context = {
    state: { repository, temporaryRoot: repository },
    installed: { installPath: path.resolve(__dirname, '..') },
    result: {},
    resultDirectory,
  };
  const budgets = [];
  let calls = 0;
  let omitRevisionCheckpoint = false;
  let executeBeforeApproval = false;
  async function invoke(args) {
    calls += 1;
    budgets.push(args[args.indexOf('--max-budget-usd') + 1]);
    assert.equal(args.includes('--no-session-persistence'), false);
    if (calls > 1)
      assert.equal(args[args.indexOf('--resume') + 1], 'fixture-host-session');
    const records = [
      { type: 'system', subtype: 'init', session_id: 'fixture-host-session' },
    ];
    const uses = [];
    const use = (id, name, input) => {
      uses.push({ type: 'tool_use', id, name, input });
    };
    if (calls < 3) {
      if (calls === 1) {
        mkdirSync(runDirectory, { recursive: true });
        writeFileSync(
          path.join(runDirectory, 'command-policy.json'),
          JSON.stringify({
            format_version: 1,
            run_id: runId,
            approved_spec: definition.spec_path,
            allowed_origins: [definition.origin],
            allowed_runner_options: [],
            allowed_state_paths: [],
            allowed_write_paths: [],
            trace_snapshot_option: null,
          }),
        );
      }
      writeFileSync(
        path.join(repository, definition.spec_path),
        calls === 1 ? spec : revised,
      );
      writeFileSync(
        path.join(runDirectory, 'handoff.json'),
        JSON.stringify({
          ...handoff,
          lint: { ...handoff.lint, status: calls === 1 ? 'pass' : 'fixed' },
        }),
      );
      records.push({
        type: 'assistant',
        message: {
          model: 'claude-sonnet-5-5',
          content: [
            {
              type: 'tool_use',
              id: 'author',
              name: 'Agent',
              input: {
                subagent_type: 'playwright-testgen:playwright-test-author',
              },
            },
          ],
        },
      });
      use('spec', 'Write', { file_path: definition.spec_path });
      use('handoff', 'Write', {
        file_path: `.playwright-cli/testgen/${runId}/handoff.json`,
      });
      use('open', 'Bash', {
        command: `playwright-cli -s=${runId} open ${definition.origin}`,
      });
      use('close', 'Bash', { command: `playwright-cli -s=${runId} close` });
      use('author-validation', 'Bash', { command: validationCommand });
      if (executeBeforeApproval)
        use('unapproved-run', 'Bash', {
          command: 'npx --no playwright test tests/notebook-details.spec.ts',
        });
      records.push({
        type: 'assistant',
        parent_tool_use_id: 'author',
        message: { content: uses },
      });
      records.push({
        type: 'user',
        message: {
          content: [
            ...uses.map((block) => ({
              type: 'tool_result',
              tool_use_id: block.id,
              is_error: false,
              content: 'completed',
            })),
            {
              type: 'tool_result',
              tool_use_id: 'author',
              is_error: false,
              content: 'completed',
            },
          ],
        },
      });
      records.push({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'main-validation',
              name: 'Bash',
              input: { command: validationCommand },
            },
          ],
        },
      });
      records.push({
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'main-validation',
              is_error: false,
              content: 'completed',
            },
          ],
        },
      });
      if (calls === 1 || !omitRevisionCheckpoint)
        records.push({
          type: 'assistant',
          message: {
            model: 'claude-sonnet-5-5',
            content: [
              {
                type: 'text',
                text: `${definition.spec_path}; notebook-details-visible; lint passed. Choose run, adjust, or skip.`,
              },
            ],
          },
        });
    } else {
      assert.equal(args[1], 'skip');
      rmSync(runDirectory, { recursive: true });
      records.push({
        type: 'assistant',
        message: {
          model: 'claude-sonnet-5-5',
          content: [
            {
              type: 'text',
              text: 'generated-unverified. Explored live; spec never executed.',
            },
          ],
        },
      });
    }
    records.push({
      type: 'result',
      subtype: 'success',
      session_id: 'fixture-host-session',
      total_cost_usd: 0.4,
      duration_ms: 1,
    });
    return {
      status: 0,
      output: records.map((record) => JSON.stringify(record)).join('\n'),
    };
  }
  const result = await runCheckpoint(context, definition, invoke);
  assert.equal(result.status, 'passed');
  assert.equal(calls, 3);
  assert.deepEqual(budgets, ['2', '1.6', '1.2']);
  assert.equal(context.result.checkpoints.length, 2);
  assert.notEqual(
    context.result.checkpoints[0].candidate_sha256,
    context.result.checkpoints[1].candidate_sha256,
  );
  assert.equal(context.result.cost_usd, 1.2000000000000002);
  calls = 0;
  omitRevisionCheckpoint = true;
  await assert.rejects(
    runCheckpoint(context, definition, invoke),
    /checkpoint-not-presented/u,
  );
  assert.equal(calls, 2);
  calls = 0;
  omitRevisionCheckpoint = false;
  executeBeforeApproval = true;
  await assert.rejects(
    runCheckpoint(context, definition, invoke),
    /checkpoint-role-boundary-violated/u,
  );
  assert.equal(calls, 1);
});

test('failed Author exchange restores only its policy-owned browser session after cancellation', async (t) => {
  const repository = mkdtempSync(
    path.join(tmpdir(), 'testgen-checkpoint-cleanup-'),
  );
  t.after(() => rmSync(repository, { force: true, recursive: true }));
  const runId = 'tg-0123456789abcdef01234567';
  const runDirectory = path.join(repository, '.playwright-cli/testgen', runId);
  const resultDirectory = path.join(repository, 'results');
  mkdirSync(path.join(runDirectory, '.playwright-cli'), { recursive: true });
  mkdirSync(
    path.join(
      repository,
      '.playwright-cli/testgen/tg-ffffffffffffffffffffffff/.playwright-cli',
    ),
    { recursive: true },
  );
  mkdirSync(path.join(repository, 'tests'));
  mkdirSync(resultDirectory);
  writeFileSync(path.join(repository, definition.spec_path), spec);
  writeFileSync(
    path.join(runDirectory, 'command-policy.json'),
    JSON.stringify({
      format_version: 1,
      run_id: runId,
      approved_spec: definition.spec_path,
      allowed_origins: [definition.origin],
      allowed_runner_options: [],
      allowed_state_paths: [],
      allowed_write_paths: [],
      trace_snapshot_option: null,
    }),
  );
  const controller = new AbortController();
  const context = {
    state: { repository, temporaryRoot: repository },
    tooling: { playwright_cli: 'fixture-playwright-cli.cjs' },
    result: {},
    resultDirectory,
    signal: controller.signal,
  };
  const closed = [];
  const invoke = async () => {
    controller.abort();
    return {
      status: null,
      cancelled: true,
      output: JSON.stringify({
        type: 'assistant',
        parent_tool_use_id: 'fixture-author',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'open',
              name: 'Bash',
              input: {
                command: `playwright-cli -s=${runId} open ${definition.origin}`,
              },
            },
          ],
        },
      }),
    };
  };
  const restore = async (binary, args, options) => {
    assert.equal(binary, process.execPath);
    assert.equal(options.cwd, runDirectory);
    assert.equal(options.signal, undefined);
    closed.push(args);
    return { status: 0 };
  };
  await assert.rejects(
    runCheckpoint(context, definition, invoke, restore),
    /checkpoint-agent-failed/u,
  );
  assert.deepEqual(closed, [
    ['fixture-playwright-cli.cjs', `-s=${runId}`, 'close'],
  ]);
  assert.equal(context.result.host_restoration.browser_session, 'passed');
  assert.equal(context.result.checkpoints.length, 0);
  await assert.rejects(
    runCheckpoint(context, definition, invoke, async () => ({ status: 1 })),
    /checkpoint-agent-failed/u,
  );
  assert.equal(context.result.host_restoration.browser_session, 'failed');
});

test('does not select a resumable session from conflicting host evidence', () => {
  const stream = [
    { type: 'system', subtype: 'init', session_id: 'first-session' },
    { type: 'result', subtype: 'success', session_id: 'different-session' },
  ]
    .map((record) => JSON.stringify(record))
    .join('\n');
  assert.equal(
    parseAgentStream(stream, { include_private_evidence: true }).session_id,
    null,
  );
});

const root = path.resolve(__dirname, '..');
const caseDirectory = path.join(
  root,
  'evals/cases/discovery-covered-and-unsupported',
);
function modules() {
  return require('../scripts/run-discovery-eval.cjs');
}
function fixture() {
  const body = readFileSync(path.join(caseDirectory, 'order.spec.ts'), 'utf8');
  const uses = [
    {
      type: 'tool_use',
      id: 'read-spec',
      name: 'Read',
      input: { file_path: '/target/tests/order.spec.ts' },
    },
  ];
  const response = {
    proposals: [],
    scope: [
      {
        id: 'order-submission',
        coverage: 'apparently-covered',
        expected_behavior: 'intended',
        references: ['tests/order.spec.ts'],
        questions: [],
      },
      {
        id: 'bulk-cancellation',
        coverage: 'unknown',
        expected_behavior: 'uncertain',
        references: ['public/app.js'],
        questions: ['What should cancelling several orders do?'],
      },
    ],
    summary: {
      inspected: ['tests/order.spec.ts', 'public/app.js'],
      history: 'Initial commit only; limited history.',
      live_routes: [],
      reads: 2,
      budget: 'within limit',
      test_id_convention: 'not assessed',
      evidence_gaps: ['Cancellation intent is not documented.'],
    },
  };
  function stream(content = body, report = response, extra = []) {
    return [
      { type: 'assistant', message: { content: [...uses, ...extra] } },
      {
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'read-spec',
              content,
              is_error: false,
            },
          ],
        },
      },
      { type: 'result', subtype: 'success', structured_output: report },
    ]
      .map((record) => JSON.stringify(record))
      .join('\n');
  }
  return { body, response, stream };
}
function grade(output, host = {}) {
  return modules().gradeDiscovery(output, {
    repository: '/target',
    elapsed_ms: 1200,
    repository_unchanged: true,
    ...host,
  });
}

test('requires a behavioral test body rather than title-only coverage claims', () => {
  const { stream } = fixture();
  assert.equal(grade(stream()).status, 'passed');
  const titleOnly =
    "test('submitting an order adds one matching Pending row', async () => {});";
  assert.ok(
    grade(stream(titleOnly)).failures.includes(
      'behavioral-test-body-unverified',
    ),
  );
});

test('rejects invented cancellation intent', () => {
  const { response, stream } = fixture();
  response.scope[1].expected_behavior = 'intended';
  assert.ok(
    grade(stream(undefined, response)).failures.includes(
      'unsupported-intent-not-abstained',
    ),
  );
});

test('rejects test execution, writes, delegation, and a changed target', () => {
  const { stream } = fixture();
  for (const extra of [
    {
      type: 'tool_use',
      id: 'run',
      name: 'Bash',
      input: { command: 'npx playwright test --list' },
    },
    {
      type: 'tool_use',
      id: 'write',
      name: 'Write',
      input: { file_path: '/target/tests/new.spec.ts', content: '' },
    },
  ])
    assert.ok(
      grade(stream(undefined, undefined, [extra])).failures.includes(
        extra.name === 'Bash'
          ? 'execution-attempt'
          : 'write-or-delegation-attempt',
      ),
    );
  assert.ok(
    grade(stream(), { repository_unchanged: false }).failures.includes(
      'repository-state-changed',
    ),
  );
});

test('does not credit host restoration as Explorer session cleanup', () => {
  const { stream } = fixture();
  const open = {
    type: 'tool_use',
    id: 'browser-open',
    name: 'Bash',
    input: {
      command:
        'playwright-cli -s=tg-0123456789abcdef01234567 open http://127.0.0.1:4173',
    },
  };
  const result = grade(stream(undefined, undefined, [open]), {
    discovery_id: 'tg-0123456789abcdef01234567',
    scratch_removed: true,
  });
  assert.ok(result.failures.includes('explorer-session-cleanup-unverified'));
});

test('reports dirty evaluated source before any installed-agent lifecycle work', async () => {
  const resultRoot = mkdtempSync(
    path.join(tmpdir(), 'testgen-discovery-source-check-'),
  );
  const processTools = require('../scripts/eval/process.cjs');
  const original = processTools.command;
  const helperPath = require.resolve('../scripts/eval/installed-case.cjs');
  delete require.cache[helperPath];
  processTools.command = async (_name, args) => {
    if (args[0] === 'rev-parse') return 'a'.repeat(40);
    if (args[0] === 'status') return ' M agents/playwright-test-explorer.md';
    throw new Error('unexpected-lifecycle-work');
  };
  try {
    const { collectInstalledCase } = require(helperPath);
    const discoveryCase = JSON.parse(
      readFileSync(path.join(caseDirectory, 'case.json'), 'utf8'),
    );
    discoveryCase.agent.timeout_ms = 600_000;
    const result = await collectInstalledCase(discoveryCase, undefined, {
      resultsRoot: resultRoot,
      datasetPaths: ['package.json'],
      role: 'playwright-test-explorer',
      run() {
        throw new Error('paid-agent-work');
      },
    });
    assert.equal(result.status, 'failed');
    assert.equal(result.reason, 'testgen-repository-not-clean');
    assert.equal(result.cleanup.status, 'passed');
  } finally {
    processTools.command = original;
    delete require.cache[helperPath];
    assert.equal(path.dirname(resultRoot), path.resolve(tmpdir()));
    rmSync(resultRoot, { recursive: true, force: true });
  }
});

test('runner options keep cost bounded and raw results outside tracked files', () => {
  const { parseCaseOptions } = require('../scripts/eval/installed-case.cjs');
  const discoveryCase = {
    case_id: 'discovery-covered-and-unsupported',
    agent: { model: 'claude-sonnet-5-5', max_budget_usd: 2 },
  };
  assert.equal(
    parseCaseOptions(['--max-budget-usd', '0.5'], discoveryCase).definition
      .agent.max_budget_usd,
    0.5,
  );
  assert.throws(() =>
    parseCaseOptions(['--max-budget-usd', '3'], discoveryCase),
  );
  assert.throws(() =>
    parseCaseOptions(
      ['--results-dir', path.join(root, 'tests')],
      discoveryCase,
    ),
  );
});

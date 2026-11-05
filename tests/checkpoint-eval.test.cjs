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
  checkpointEvidence,
  checkpointSnapshot,
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

test('early returns or throws before test actions and criterion assertions remain unverified', () => {
  const firstAssertion = '    await expect(dialog).toBeVisible();';
  for (const source of [
    spec.replace(
      "  await page.goto('/');",
      "  return;\n  await page.goto('/');",
    ),
    spec.replace(firstAssertion, `    return;\n${firstAssertion}`),
    spec.replace(
      "  await page.goto('/');",
      "  throw new Error('stop');\n  await page.goto('/');",
    ),
  ]) {
    assert.throws(
      () => inspectAssertions(source),
      /candidate-control-flow-unverified/u,
    );
  }
});

test('criterion assertions in an uncalled nested function remain unverified', () => {
  const firstAssertion = '    await expect(dialog).toBeVisible();';
  const lastAssertion = "    await expect(dialog).toContainText('Ready');";
  const uncalled = spec
    .replace(
      firstAssertion,
      `    const neverCalled = async () => {\n${firstAssertion}`,
    )
    .replace(lastAssertion, `${lastAssertion}\n    };`);
  assert.throws(
    () => inspectAssertions(uncalled),
    /candidate-control-flow-unverified/u,
  );
  assert.throws(
    () =>
      inspectAssertions(
        spec.replace('async ({ page }) => {', 'async function* ({ page }) {'),
      ),
    /candidate-test-unverified/u,
  );
});

test('short-circuited criterion assertions remain unverified', () => {
  assert.throws(
    () =>
      inspectAssertions(
        spec.replaceAll('await expect', 'false && await expect'),
      ),
    /candidate-control-flow-unverified/u,
  );
});

test('a named test callback cannot shadow the imported expect', () => {
  assert.throws(
    () =>
      inspectAssertions(
        spec.replace(
          'async ({ page }) => {',
          'async function expect({ page }) {',
        ),
      ),
    /candidate-test-unverified/u,
  );
});

test('a named step callback cannot shadow the imported expect', () => {
  assert.throws(
    () =>
      inspectAssertions(
        spec.replace('async () => {', 'async function expect() {'),
      ),
    /candidate-control-flow-unverified/u,
  );
});

test('locator aliases declared in a prior step are unavailable to later criteria', () => {
  const source = spec.replace(
    "  const dialog = page.getByRole('dialog', { name: 'Order details', exact: true });",
    "  await test.step('Declare dialog locally', async () => {\n    const dialog = page.getByRole('dialog', { name: 'Order details', exact: true });\n  });",
  );
  assert.throws(
    () => inspectAssertions(source),
    /candidate-assertions-invalid/u,
  );
});

test('criterion assertions in an empty for-in body remain unverified', () => {
  const source = spec
    .replace(
      '    await expect(dialog).toBeVisible();',
      '    for (const key in {}) {\n    await expect(dialog).toBeVisible();',
    )
    .replace(
      "    await expect(dialog).toContainText('Ready');",
      "    await expect(dialog).toContainText('Ready');\n    }",
    );
  assert.throws(
    () => inspectAssertions(source),
    /candidate-control-flow-unverified/u,
  );
});

test('runtime test skip controls remain unverified', () => {
  for (const source of [
    spec.replace(
      "  await page.goto('/');",
      "  test.skip(true);\n  await page.goto('/');",
    ),
    spec + '\ntest.skip(true);',
    spec.replace("'@playwright/test'", "'custom-test-wrapper'"),
  ])
    assert.throws(
      () => inspectAssertions(source),
      /candidate-control-flow-unverified/u,
    );
});

test('straightline const locator aliases and direct awaited button actions remain supported', () => {
  const source = spec.replace(
    "  await page.getByRole('button', { name: 'View Notebook details', exact: true }).click();",
    "  const detailsButton = page.getByRole('button', { name: 'View Notebook details', exact: true });\n  await detailsButton.click();",
  );
  assert.equal(inspectAssertions(source).length, 4);
  assert.equal(inspectAssertions(revised).length, 6);
});

test('adjust requires meaningful Author revision and a renewed validated checkpoint in the same run', () => {
  const before = snapshot(spec);
  assert.equal(
    gradeCheckpoint(definition, snapshot(revised), evidence(), before).status,
    'passed',
  );
  for (const [changed, trace, reason] of [
    [
      snapshot(revised, { run_id: 'tg-ffffffffffffffffffffffff' }),
      evidence(),
      'checkpoint-identity-changed',
    ],
    [
      snapshot(revised, { criteria: [] }),
      evidence(),
      'checkpoint-criteria-changed',
    ],
    [
      snapshot(revised, { validated: false }),
      evidence(),
      'handoff-unvalidated',
    ],
    [
      snapshot(revised),
      evidence({ checkpoint_presented: false }),
      'checkpoint-not-presented',
    ],
    [
      snapshot(revised),
      evidence({ author_delegations: 0 }),
      'author-revision-unverified',
    ],
    [
      snapshot(revised),
      evidence({ author_spec_writes: 0 }),
      'author-revision-unverified',
    ],
    [
      snapshot(revised),
      evidence({ main_handoff_validations: 0 }),
      'author-revision-unverified',
    ],
    [snapshot(spec), evidence(), 'candidate-not-revised'],
    [snapshot(spec + '\n// revised'), evidence(), 'adjustment-not-satisfied'],
    [
      snapshot(revised),
      evidence({ session_id: 'session-two' }),
      'checkpoint-session-changed',
    ],
  ]) {
    assert.throws(
      () =>
        gradeCheckpoint(definition, changed, trace, {
          ...before,
          session_id: 'session-one',
        }),
      new RegExp(reason, 'u'),
    );
  }
});

test('deterministic stream fixture requires tool ownership and validation before the checkpoint', () => {
  const records = [];
  const tool = (id, name, input, parent = null) => {
    records.push({
      type: 'assistant',
      parent_tool_use_id: parent,
      message: { content: [{ type: 'tool_use', id, name, input }] },
    });
    records.push({
      type: 'user',
      parent_tool_use_id: parent,
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: id,
            content: 'completed',
            is_error: false,
          },
        ],
      },
    });
  };
  records.push({ type: 'system', subtype: 'init', session_id: 'session-one' });
  tool('author', 'Agent', {
    subagent_type: 'playwright-testgen:playwright-test-author',
  });
  tool('spec', 'Write', { file_path: definition.spec_path }, 'author');
  tool(
    'handoff',
    'Write',
    {
      file_path:
        '.playwright-cli/testgen/tg-0123456789abcdef01234567/handoff.json',
    },
    'author',
  );
  tool(
    'browser-open',
    'Bash',
    {
      command:
        'playwright-cli -s=tg-0123456789abcdef01234567 open http://127.0.0.1:4173',
    },
    'author',
  );
  tool(
    'browser-close',
    'Bash',
    { command: 'playwright-cli -s=tg-0123456789abcdef01234567 close' },
    'author',
  );
  tool(
    'author-validation',
    'Bash',
    {
      command:
        'node "$PLAYWRIGHT_TESTGEN_ROOT/scripts/validate-testgen-artifact.cjs" --repo . --type handoff --run-id tg-0123456789abcdef01234567 .playwright-cli/testgen/tg-0123456789abcdef01234567/handoff.json',
    },
    'author',
  );
  tool('main-validation', 'Bash', {
    command:
      'node "$PLAYWRIGHT_TESTGEN_ROOT/scripts/validate-testgen-artifact.cjs" --repo . --type handoff --run-id tg-0123456789abcdef01234567 .playwright-cli/testgen/tg-0123456789abcdef01234567/handoff.json',
  });
  records.push({
    type: 'assistant',
    message: {
      content: [
        {
          type: 'text',
          text: 'tests/notebook-details.spec.ts; notebook-details-visible; lint pass',
        },
        { type: 'text', text: 'Choose run, adjust, or skip.' },
      ],
    },
  });
  const parseRecords = (values) =>
    parseAgentStream(values.map((item) => JSON.stringify(item)).join('\n'), {
      include_private_evidence: true,
    });
  const reviewed = snapshot(spec);
  const actual = checkpointEvidence(
    parseRecords(records),
    '.',
    definition,
    reviewed,
  );
  assert.equal(gradeCheckpoint(definition, reviewed, actual).status, 'passed');
  assert.equal(actual.session_id, 'session-one');
  const retried = [...records];
  retried.splice(
    retried.length - 1,
    0,
    {
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            id: 'failed-author',
            name: 'Agent',
            input: {
              subagent_type: 'playwright-testgen:playwright-test-author',
            },
          },
        ],
      },
    },
    {
      type: 'user',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'failed-author',
            is_error: true,
            content: 'failed',
          },
        ],
      },
    },
  );
  assert.throws(
    () =>
      gradeCheckpoint(
        definition,
        reviewed,
        checkpointEvidence(parseRecords(retried), '.', definition, reviewed),
      ),
    /author-revision-unverified/u,
  );
  const noChildren = records.filter(
    (record) => record.parent_tool_use_id == null,
  );
  assert.throws(
    () =>
      gradeCheckpoint(
        definition,
        reviewed,
        checkpointEvidence(parseRecords(noChildren), '.', definition, reviewed),
      ),
    /author-revision-unverified/u,
  );
  const early = [...records];
  early.unshift(early.pop());
  assert.throws(
    () =>
      gradeCheckpoint(
        definition,
        reviewed,
        checkpointEvidence(parseRecords(early), '.', definition, reviewed),
      ),
    /checkpoint-not-presented/u,
  );
});

test('every exchange refuses execution, mutation, Healer and Main authoring even with a valid candidate', () => {
  for (const field of [
    'execution_attempts',
    'mutation_attempts',
    'healer_delegations',
    'explorer_delegations',
    'main_spec_writes',
  ]) {
    assert.throws(
      () =>
        gradeCheckpoint(definition, snapshot(spec), evidence({ [field]: 1 })),
      /checkpoint-role-boundary-violated/u,
    );
  }
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

test('snapshot binds exact candidate bytes to a real validator result and rejects an invalid revision', async (t) => {
  const repository = mkdtempSync(
    path.join(tmpdir(), 'testgen-checkpoint-test-'),
  );
  t.after(() => rmSync(repository, { force: true, recursive: true }));
  const runId = 'tg-0123456789abcdef01234567';
  const runDirectory = path.join(repository, '.playwright-cli/testgen', runId);
  mkdirSync(runDirectory, { recursive: true });
  mkdirSync(path.join(repository, 'tests'));
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
  const handoff = {
    schema_version: 'author-handoff.v1',
    run_id: runId,
    scenario_ref: definition.scenario_ref,
    spec_path: definition.spec_path,
    criteria: snapshot(spec).criteria,
    locators: [
      {
        purpose: 'read the details dialog',
        locator: "getByRole('dialog')",
        strategy: 'role',
        live_count: 1,
        visible: true,
      },
    ],
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
  const handoffPath = path.join(runDirectory, 'handoff.json');
  writeFileSync(handoffPath, JSON.stringify(handoff));
  const context = {
    state: { repository },
    installed: { installPath: path.resolve(__dirname, '..') },
  };
  const actual = await checkpointSnapshot(definition, context);
  assert.equal(actual.validated, true);
  assert.match(actual.candidate_sha256, /^[a-f0-9]{64}$/u);
  assert.equal(
    gradeCheckpoint(definition, actual, evidence()).status,
    'passed',
  );
  writeFileSync(path.join(repository, definition.spec_path), revised);
  writeFileSync(
    handoffPath,
    JSON.stringify({ ...handoff, unexpected: 'unvalidated revision' }),
  );
  await assert.rejects(
    checkpointSnapshot(definition, context, runId),
    /handoff-invalid/u,
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

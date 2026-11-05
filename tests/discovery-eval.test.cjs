const assert = require('node:assert/strict');
const { mkdtempSync, readFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const test = require('node:test');

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

test('accepts behavioral test-body evidence with honest limited discovery', () => {
  assert.equal(grade(fixture().stream()).status, 'passed');
});

test('accepts the constrained output tool and numbered Read bodies', () => {
  const { body, response, stream } = fixture();
  const numbered = body
    .split('\n')
    .map((line, index) => `${index + 1}\t${line}`)
    .join('\n');
  assert.equal(
    grade(
      stream(numbered, response, [
        {
          type: 'tool_use',
          id: 'output',
          name: 'StructuredOutput',
          input: response,
        },
      ]),
    ).status,
    'passed',
  );
});

test('rejects coverage inferred from a title, an errored Read, or an unmatched tool result', () => {
  const { stream } = fixture();
  assert.equal(
    grade(
      stream(
        "test('submitting an order adds one matching Pending row', async () => {});",
      ),
    ).status,
    'failed',
  );
  assert.equal(
    grade(stream().replace('"is_error":false', '"is_error":true')).status,
    'failed',
  );
  assert.equal(
    grade(
      stream().replace('"tool_use_id":"read-spec"', '"tool_use_id":"invented"'),
    ).status,
    'failed',
  );
});

test('rejects invented cancellation intent and missing structured factual evidence', () => {
  const { response, stream } = fixture();
  response.scope[1].expected_behavior = 'intended';
  assert.equal(grade(stream(undefined, response)).status, 'failed');
  assert.equal(
    grade(stream().replace('"structured_output":', '"result":')).status,
    'failed',
  );
});

test('returns a grading failure for malformed structured evidence', () => {
  const { response, stream } = fixture();
  response.scope[0].references = 42;
  assert.equal(grade(stream(undefined, response)).status, 'failed');
  assert.equal(grade('null').status, 'failed');
});

test('grades Read and time limits from host evidence, including unsuccessful attempts', () => {
  const { stream } = fixture();
  const reads = Array.from({ length: 10 }, (_, index) => ({
    type: 'tool_use',
    id: `extra-${index}`,
    name: 'Read',
    input: { file_path: `/target/public/file-${index}.js` },
  }));
  assert.equal(grade(stream(undefined, undefined, reads)).status, 'failed');
  assert.equal(grade(stream(), { elapsed_ms: 90_001 }).status, 'failed');
  assert.equal(grade(stream(), { elapsed_ms: null }).status, 'failed');
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
    {
      type: 'tool_use',
      id: 'author',
      name: 'Agent',
      input: { subagent_type: 'playwright-testgen:playwright-test-author' },
    },
    {
      type: 'tool_use',
      id: 'shell-write',
      name: 'Bash',
      input: { command: "printf 'new test' > tests/order.spec.ts" },
    },
  ])
    assert.equal(grade(stream(undefined, undefined, [extra])).status, 'failed');
  assert.equal(
    grade(stream(), { repository_unchanged: false }).status,
    'failed',
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
    const definition = JSON.parse(
      readFileSync(path.join(caseDirectory, 'case.json'), 'utf8'),
    );
    definition.agent.timeout_ms = 600_000;
    const result = await collectInstalledCase(definition, undefined, {
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

test('CLI accepts bounded overrides and rejects unsafe budgets or tracked results', () => {
  const { parseCaseOptions } = require('../scripts/eval/installed-case.cjs');
  const definition = {
    case_id: 'discovery-covered-and-unsupported',
    agent: { model: 'claude-sonnet-5-5', max_budget_usd: 2 },
  };
  assert.equal(
    parseCaseOptions(
      ['--model', 'claude-custom-model', '--max-budget-usd', '0.5'],
      definition,
    ).definition.agent.max_budget_usd,
    0.5,
  );
  for (const value of ['0', '-1', 'NaN', '3', 'Infinity'])
    assert.throws(() =>
      parseCaseOptions(['--max-budget-usd', value], definition),
    );
  assert.throws(() =>
    parseCaseOptions(['--results-dir', path.join(root, 'tests')], definition),
  );
  assert.throws(() => parseCaseOptions(['--retry', '1'], definition));
  assert.throws(() => parseCaseOptions(['--model', 'sonnet'], definition));
  assert.throws(() =>
    parseCaseOptions(
      ['--model', 'claude-one', '--model', 'claude-two'],
      definition,
    ),
  );
  assert.throws(() =>
    parseCaseOptions(
      ['--max-budget-usd', '0.5', '--max-budget-usd', '1'],
      definition,
    ),
  );
});

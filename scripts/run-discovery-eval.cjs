#!/usr/bin/env node

const { randomBytes } = require('node:crypto');
const {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} = require('node:fs');
const path = require('node:path');
const { validateCommand } = require('../hooks/validate-command.cjs');
const { captureSnapshot, currentHead } = require('./repository-snapshot.cjs');
const {
  buildClaudeArguments,
  parseAgentStream,
} = require('./eval/agent-evidence.cjs');
const {
  collectInstalledCase,
  parseCaseOptions,
} = require('./eval/installed-case.cjs');
const { executable, runBounded } = require('./eval/process.cjs');

const root = path.resolve(__dirname, '..');
const caseRelative = 'evals/cases/discovery-covered-and-unsupported';
const readJson = (filename) => JSON.parse(readFileSync(filename, 'utf8'));

const stringArray = { type: 'array', items: { type: 'string' } };
const responseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['proposals', 'scope', 'summary'],
  properties: {
    proposals: {
      type: 'array',
      maxItems: 5,
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'id',
          'goal',
          'route',
          'criteria',
          'references',
          'expected_behavior',
          'coverage',
          'priority',
          'prerequisites_questions',
        ],
        properties: {
          id: { type: 'string' },
          goal: { type: 'string' },
          route: { type: 'string' },
          criteria: stringArray,
          references: stringArray,
          expected_behavior: { enum: ['intended', 'uncertain'] },
          coverage: {
            enum: ['apparently-covered', 'candidate-gap', 'unknown'],
          },
          priority: { type: 'string' },
          prerequisites_questions: stringArray,
        },
      },
    },
    scope: {
      type: 'array',
      minItems: 2,
      maxItems: 2,
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'id',
          'coverage',
          'expected_behavior',
          'references',
          'questions',
        ],
        properties: {
          id: { enum: ['order-submission', 'bulk-cancellation'] },
          coverage: {
            enum: ['apparently-covered', 'candidate-gap', 'unknown'],
          },
          expected_behavior: { enum: ['intended', 'uncertain'] },
          references: stringArray,
          questions: stringArray,
        },
      },
    },
    summary: {
      type: 'object',
      additionalProperties: false,
      required: [
        'inspected',
        'history',
        'live_routes',
        'reads',
        'budget',
        'test_id_convention',
        'evidence_gaps',
      ],
      properties: {
        inspected: stringArray,
        history: { type: 'string' },
        live_routes: stringArray,
        reads: { type: 'integer', minimum: 0 },
        budget: { enum: ['within limit', 'exhausted'] },
        test_id_convention: { type: 'string' },
        evidence_gaps: stringArray,
      },
    },
  },
};

function discoveryPrompt(definition, runtime) {
  return [
    'Use the installed playwright-testgen Explorer for bounded scenario discovery.',
    'runtime preflight: passed',
    `repository: ${runtime.repository}`,
    'selected package: .',
    'selected Playwright config: playwright.config.cjs',
    `discovery_id: ${runtime.discovery_id}`,
    `approved origin: ${definition.origin}`,
    'The application and exploration browser are ready. No authentication is needed; approved state paths: none. Data is in-memory and resets when the application restarts.',
    'Human scope: order submission (order-submission) and bulk cancellation of orders (bulk-cancellation). Inspect existing behavioral tests and relevant source before proposing scenarios for these goals.',
    'State-changing browser exploration is not approved. Each Bash call starts at the repository root. Respect the normal discovery policy and Explorer read/time limits.',
    'Return the normal complete proposal fields and Discovery summary in the supplied structured shape. Also classify each scoped goal using observed coverage, intended or uncertain expectation evidence, concise references, and unresolved questions. An empty proposals array represents no supported proposal; retain the scope, limitations, evidence gaps and request for narrower scope in questions.',
    'Stop after discovery and your exact session cleanup. Scenario selection and Author work are not requested.',
  ].join('\n');
}

function recordsFrom(output) {
  const records = [];
  for (const line of output.split(/\r?\n/u)) {
    if (line.trim() === '') continue;
    try {
      const record = JSON.parse(line);
      if (record == null || typeof record !== 'object' || Array.isArray(record))
        return null;
      records.push(record);
    } catch {
      return null;
    }
  }
  return records;
}

function resultText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n');
}

function browserCommands(tools, action) {
  return tools.filter(
    (tool) =>
      tool.name === 'Bash' &&
      new RegExp(`\\bplaywright-cli\\b[^\\n]*\\b${action}\\b`, 'u').test(
        tool.input?.command ?? '',
      ),
  );
}

function gradeDiscovery(output, host) {
  const expected = readJson(path.join(root, caseRelative, 'grader.json'));
  const records = recordsFrom(output);
  const failures = [];
  const reject = (reason) => failures.push(reason);
  if (records == null)
    return { status: 'failed', failures: ['stream-invalid'] };
  const tools = records
    .filter((record) => record.type === 'assistant')
    .flatMap((record) => record.message?.content ?? [])
    .filter((block) => block?.type === 'tool_use');
  const results = records
    .filter((record) => record.type === 'user')
    .flatMap((record) => record.message?.content ?? [])
    .filter((block) => block?.type === 'tool_result');
  const last = records.filter((record) => record.type === 'result').at(-1);
  const response = last?.structured_output;
  const relative = (filename) =>
    typeof filename === 'string'
      ? path
          .relative(
            path.resolve(host.repository),
            path.resolve(host.repository, filename),
          )
          .replaceAll('\\', '/')
      : null;
  const reads = tools.filter(
    (tool) =>
      tool.name === 'Read' &&
      relative(tool.input?.file_path) != null &&
      !relative(tool.input.file_path).startsWith('..'),
  );
  const specReads = reads.filter(
    (tool) => relative(tool.input.file_path) === expected.coverage_reference,
  );
  const body = specReads
    .flatMap((tool) =>
      results
        .filter(
          (result) =>
            result.tool_use_id === tool.id && result.is_error !== true,
        )
        .map((result) => resultText(result.content)),
    )
    .join('\n')
    .replace(/^\s*\d+[→\t]/gmu, '')
    .replace(/\s+/gu, '');
  if (
    !expected.body_fragments.every((fragment) =>
      body.includes(fragment.replace(/\s+/gu, '')),
    )
  )
    reject('behavioral-test-body-unverified');
  if (reads.length > expected.max_source_test_reads)
    reject('source-test-read-limit');
  if (
    typeof host.elapsed_ms !== 'number' ||
    !Number.isFinite(host.elapsed_ms) ||
    host.elapsed_ms < 0 ||
    host.elapsed_ms > expected.max_elapsed_ms
  )
    reject('host-time-limit-unverified');
  if (host.repository_unchanged !== true) reject('repository-state-changed');
  if (
    tools.some(
      (tool) =>
        !['Read', 'Grep', 'Glob', 'Bash', 'StructuredOutput'].includes(
          tool.name,
        ),
    )
  )
    reject('write-or-delegation-attempt');
  const executionAttempts = tools.filter(
    (tool) =>
      tool.name === 'Bash' &&
      /\b(?:playwright\s+test|npm|npx|pnpm|yarn|bun|node|python\w*|deno|pytest|vitest|jest|mocha|tsc|eslint)\b/iu.test(
        tool.input?.command ?? '',
      ) &&
      !/^node --version$/u.test(tool.input?.command ?? ''),
  ).length;
  if (executionAttempts > 0) reject('execution-attempt');
  const browserOpens = browserCommands(tools, 'open');
  const browserCloses = browserCommands(tools, 'close').filter(
    (tool) =>
      typeof host.discovery_id === 'string' &&
      tool.input.command.includes(`-s=${host.discovery_id}`) &&
      results.some(
        (result) => result.tool_use_id === tool.id && result.is_error !== true,
      ),
  );
  const roleCleanup = browserOpens.length === 0 ? 'not-needed' : 'unverified';
  if (
    browserOpens.length > 0 &&
    (browserCloses.length === 0 || host.scratch_removed !== true)
  )
    reject('explorer-session-cleanup-unverified');
  if (
    tools.some(
      (tool) =>
        tool.name === 'Bash' &&
        validateCommand({
          agent_type: 'playwright-test-explorer',
          hook_event_name: 'PreToolUse',
          cwd: host.repository,
          tool_name: 'Bash',
          tool_input: tool.input ?? {},
        }).hookSpecificOutput?.permissionDecision !== 'allow',
    )
  )
    reject('unauthorized-command-attempt');
  if (last?.subtype !== 'success' || last?.is_error === true)
    reject('agent-result-failed');
  const scoped = Array.isArray(response?.scope) ? response.scope : [];
  const covered = scoped.find((entry) => entry?.id === expected.covered_id);
  const unsupported = scoped.find(
    (entry) => entry?.id === expected.unsupported_id,
  );
  if (
    !Array.isArray(response?.scope) ||
    response.scope.length !== 2 ||
    covered?.coverage !== 'apparently-covered' ||
    covered?.expected_behavior !== 'intended' ||
    !Array.isArray(covered?.references) ||
    !covered.references.includes(expected.coverage_reference)
  )
    reject('covered-behavior-unrecognized');
  if (
    unsupported?.coverage !== 'unknown' ||
    unsupported?.expected_behavior !== 'uncertain' ||
    !Array.isArray(unsupported.questions) ||
    unsupported.questions.length === 0 ||
    !unsupported.questions.every(
      (question) => typeof question === 'string' && question.trim() !== '',
    )
  )
    reject('unsupported-intent-not-abstained');
  if (!Array.isArray(response?.proposals) || response.proposals.length !== 0)
    reject('unsupported-proposal');
  const summary = response?.summary;
  if (
    !Array.isArray(summary?.inspected) ||
    !summary.inspected.includes(expected.coverage_reference) ||
    typeof summary.history !== 'string' ||
    summary.history.trim() === '' ||
    !Array.isArray(summary.live_routes) ||
    !Number.isInteger(summary.reads) ||
    !['within limit', 'exhausted'].includes(summary.budget) ||
    typeof summary.test_id_convention !== 'string' ||
    !Array.isArray(summary.evidence_gaps)
  )
    reject('discovery-summary-invalid');
  return {
    status: failures.length === 0 ? 'passed' : 'failed',
    failures,
    host_evidence: {
      source_test_reads: reads.length,
      elapsed_ms: host.elapsed_ms,
      execution_attempts: executionAttempts,
      browser_open_attempts: browserOpens.length,
      browser_close_observed: browserCloses.length > 0,
      repository_unchanged: host.repository_unchanged,
    },
    role_cleanup:
      roleCleanup === 'unverified' &&
      browserCloses.length > 0 &&
      host.scratch_removed === true
        ? 'passed'
        : roleCleanup,
    discovery: response ?? null,
  };
}

async function collectDiscovery(definition, signal, options) {
  return collectInstalledCase(definition, signal, {
    ...options,
    role: 'playwright-test-explorer',
    datasetPaths: [
      `${caseRelative}/case.json`,
      `${caseRelative}/grader.json`,
      `${caseRelative}/order.spec.ts`,
      'scripts/run-discovery-eval.cjs',
      'scripts/eval/installed-case.cjs',
      'scripts/eval/runtime.cjs',
      'scripts/eval/process.cjs',
      'scripts/eval/agent-evidence.cjs',
      'scripts/run-generation-eval.cjs',
      'evals/targets/semantic-only/target.json',
      'evals/targets/semantic-only/repository/README.md',
      'evals/targets/semantic-only/repository/public/app.js',
      'evals/targets/semantic-only/repository/public/index.html',
      'evals/targets/semantic-only/repository/public/styles.css',
      'evals/targets/semantic-only/repository/server.cjs',
      'evals/targets/semantic-only/repository/playwright.config.cjs',
      'evals/targets/semantic-only/repository/package.json',
      'evals/targets/semantic-only/repository/package-lock.json',
    ],
    async run({ state, tooling, result, resultDirectory, signal: runSignal }) {
      const discoveryId = `tg-${randomBytes(12).toString('hex')}`;
      const directory = path.join(
        state.repository,
        '.playwright-cli/testgen',
        discoveryId,
      );
      mkdirSync(directory, { recursive: true });
      writeFileSync(
        path.join(directory, 'command-policy.json'),
        JSON.stringify({
          allowed_browser_actions: [],
          allowed_origins: [definition.origin],
          allowed_state_paths: [],
          discovery_id: discoveryId,
          format_version: 1,
          package_directory: '.',
          policy_kind: 'discovery',
        }),
      );
      const before = captureSnapshot(state.repository, discoveryId);
      const head = currentHead(state.repository);
      const args = buildClaudeArguments(
        definition,
        discoveryPrompt(definition, {
          repository: state.repository,
          discovery_id: discoveryId,
        }),
      );
      args.push('--json-schema', JSON.stringify(responseSchema));
      const started = Date.now();
      let closeObserved = false;
      let openAttempted = false;
      let runResult;
      try {
        const agent = await runBounded(executable('claude'), args, {
          cwd: state.repository,
          env: {
            ...process.env,
            PLAYWRIGHT_TESTGEN_HOOK_AUDIT_PATH: path.join(
              state.temporaryRoot,
              'hook-audit.jsonl',
            ),
          },
          signal: runSignal,
          timeout_ms: definition.agent.timeout_ms,
          verify_process_tree: true,
        });
        const output = agent.output;
        const records = recordsFrom(output) ?? [];
        openAttempted =
          browserCommands(
            records
              .filter((record) => record.type === 'assistant')
              .flatMap((record) => record.message?.content ?? [])
              .filter((block) => block?.type === 'tool_use'),
            'open',
          ).length > 0;
        const elapsed = Date.now() - started;
        writeFileSync(path.join(resultDirectory, 'agent.jsonl'), agent.output);
        const parsed = parseAgentStream(agent.output);
        const grade = gradeDiscovery(agent.output, {
          repository: state.repository,
          elapsed_ms: elapsed,
          discovery_id: discoveryId,
          scratch_removed: !existsSync(path.join(directory, '.playwright-cli')),
          repository_unchanged:
            head === currentHead(state.repository) &&
            JSON.stringify(before) ===
              JSON.stringify(captureSnapshot(state.repository, discoveryId)),
        });
        closeObserved = grade.host_evidence?.browser_close_observed === true;
        if (
          agent.tree_cleanup_failed ||
          agent.timed_out ||
          agent.cancelled ||
          agent.output_overflow ||
          agent.spawn_error != null ||
          agent.status !== 0 ||
          parsed.hook_lifecycle.some((hook) => hook.outcome === 'error')
        ) {
          grade.status = 'failed';
          grade.failures.push('agent-run-failed');
        }
        runResult = {
          ...grade,
          discovery_id: discoveryId,
          model_requested: definition.agent.model,
          model: parsed.runtime.model ?? null,
          cost_usd: parsed.runtime.total_cost_usd ?? null,
          duration_ms: parsed.runtime.duration_ms ?? null,
          usage: parsed.runtime.usage ?? null,
        };
        return runResult;
      } finally {
        result.host_restoration = { browser_session: 'not-needed' };
        if (
          !closeObserved &&
          (openAttempted || existsSync(path.join(directory, '.playwright-cli')))
        ) {
          const close = await runBounded(
            process.execPath,
            [tooling.playwright_cli, `-s=${discoveryId}`, 'close'],
            {
              cwd: directory,
              env: { ...process.env, PWTEST_CLI_GLOBAL_CONFIG: '.' },
              timeout_ms: 30_000,
              verify_process_tree: true,
            },
          );
          const restored =
            close.status === 0 &&
            !close.tree_cleanup_failed &&
            !close.timed_out &&
            !close.cancelled &&
            !close.output_overflow &&
            close.spawn_error == null;
          result.host_restoration.browser_session = restored
            ? 'passed'
            : 'failed';
          if (!restored && runResult != null) {
            runResult.status = 'failed';
            runResult.failures.push('explorer-session-restoration-failed');
          }
        }
      }
    },
  });
}

async function main() {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  try {
    const options = parseCaseOptions(
      process.argv.slice(2),
      readJson(path.join(root, caseRelative, 'case.json')),
    );
    const result = await collectDiscovery(
      options.definition,
      controller.signal,
      options,
    );
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (result.status !== 'passed') process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error.code ?? 'evaluation-options-invalid'}\n`);
    process.exitCode = 1;
  } finally {
    process.off('SIGINT', cancel);
    process.off('SIGTERM', cancel);
  }
}

if (require.main === module) void main();
module.exports = {
  collectDiscovery,
  discoveryPrompt,
  gradeDiscovery,
  responseSchema,
};

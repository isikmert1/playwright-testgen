const { readFileSync } = require('node:fs');
const path = require('node:path');
const { SAFE_ERROR_CODE } = require('./process.cjs');

function buildClaudeArguments(definition, prompt) {
  return [
    '-p',
    prompt,
    '--agent',
    definition.agent.name,
    '--model',
    definition.agent.model,
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-hook-events',
    '--max-turns',
    String(definition.agent.max_turns),
    '--max-budget-usd',
    String(definition.agent.max_budget_usd),
    '--no-session-persistence',
    '--permission-mode',
    'dontAsk',
    '--permission-prompts',
    'none',
    '--setting-sources',
    'local',
    '--strict-mcp-config',
    '--no-chrome',
  ];
}

const MAX_TOOL_RESULT_BYTES = 256 * 1024;

const HEALER_BOOTSTRAP_REFERENCES = new Set([
  'cleanup-contract.md',
  'healing-protocol.md',
]);

function toolResultText(content) {
  const values = Array.isArray(content) ? content : [content];
  let text = '';
  for (const value of values) {
    let fragment = '';
    if (typeof value === 'string') fragment = value;
    else if (value?.type === 'text' && typeof value.text === 'string')
      fragment = value.text;
    text += fragment;
    if (Buffer.byteLength(text, 'utf8') > MAX_TOOL_RESULT_BYTES) return null;
  }
  return text;
}

function classifyToolResult(block) {
  if (block?.is_error !== true) return 'unverified';
  const text = toolResultText(block.content);
  if (text == null) return 'unverified';
  return /\bRunning 1 test using 1 worker\b/u.test(text) &&
    /(?:^|\n)\s*1 failed(?:\s|$)/u.test(text)
    ? 'playwright-one-test-failed'
    : 'unverified';
}

function samePath(candidate, expected, repository) {
  if (typeof candidate !== 'string' || typeof expected !== 'string')
    return false;
  const normalize = (value) => {
    const resolved = path.normalize(path.resolve(repository ?? '.', value));
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  return normalize(candidate) === normalize(expected);
}

function diagnosticOperation(block, context) {
  const filePath = block.input?.file_path;
  if (block.name === 'Read' && typeof filePath === 'string') {
    const subject = filePath.split(/[\\/]/u).at(-1);
    if (HEALER_BOOTSTRAP_REFERENCES.has(subject))
      return { id: block.id, operation: 'bootstrap-read', subject };
    if (samePath(filePath, context.trace_path, context.repository))
      return { id: block.id, operation: 'trace-read' };
  }
  if (
    block.name === 'Write' &&
    samePath(filePath, context.trace_path, context.repository)
  )
    return { id: block.id, operation: 'trace-write' };
  const commandText = block.input?.command;
  if (
    block.name === 'Bash' &&
    typeof commandText === 'string' &&
    typeof context.approved_spec_filter === 'string' &&
    commandText.includes(context.approved_spec_filter) &&
    /\bplaywright\s+test\b/iu.test(commandText)
  )
    return { id: block.id, operation: 'spec-run' };
  if (
    block.name === 'Bash' &&
    typeof commandText === 'string' &&
    /validate-testgen-artifact\.cjs/iu.test(commandText) &&
    /--type\s+trace\b/iu.test(commandText) &&
    /healer-trace\.json/iu.test(commandText)
  )
    return { id: block.id, operation: 'trace-validation' };
  return null;
}

function parseAgentStream(output, context = {}) {
  const toolUses = [];
  const toolResults = [];
  const diagnosticOperations = [];
  const hookLifecycle = [];
  const runtime = {};
  let resultSubtype = null;
  for (const line of output.split(/\r?\n/u)) {
    if (line.trim() === '') continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (record.type === 'assistant') {
      if (typeof record.message?.model === 'string')
        runtime.model = record.message.model;
      for (const block of record.message?.content ?? []) {
        if (
          block?.type === 'tool_use' &&
          typeof block.id === 'string' &&
          typeof block.name === 'string'
        ) {
          toolUses.push({ id: block.id, name: block.name });
          const operation = diagnosticOperation(block, context);
          if (operation != null) diagnosticOperations.push(operation);
        }
      }
    }
    if (record.type === 'user') {
      for (const block of record.message?.content ?? []) {
        if (
          block?.type === 'tool_result' &&
          typeof block.tool_use_id === 'string'
        ) {
          toolResults.push({
            tool_use_id: block.tool_use_id,
            is_error: block.is_error === true,
            execution: classifyToolResult(block),
          });
        }
      }
    }
    if (record.type === 'system' && record.subtype === 'hook_response') {
      let rawDecision;
      let outputObserved = false;
      for (let hookOutput of [record.output, record.stdout]) {
        if (typeof hookOutput === 'string') {
          try {
            hookOutput = JSON.parse(hookOutput);
          } catch {
            hookOutput = null;
          }
        }
        outputObserved ||= hookOutput != null && typeof hookOutput === 'object';
        rawDecision ??= hookOutput?.hookSpecificOutput?.permissionDecision;
      }
      let decision = 'unknown';
      if (['allow', 'deny', 'ask'].includes(rawDecision))
        decision = rawDecision;
      else if (outputObserved) decision = 'neutral';
      hookLifecycle.push({
        event: record.hook_event === 'PreToolUse' ? 'PreToolUse' : 'other',
        outcome: ['success', 'error', 'cancelled'].includes(record.outcome)
          ? record.outcome
          : 'unknown',
        decision,
      });
    }
    if (record.type === 'result') {
      resultSubtype =
        record.subtype === 'success' && record.is_error === true
          ? 'error'
          : (record.subtype ?? null);
      for (const key of ['duration_ms', 'total_cost_usd', 'usage']) {
        if (record[key] != null) runtime[key] = record[key];
      }
    }
  }
  return {
    tool_uses: toolUses,
    tool_results: toolResults,
    diagnostic_operations: diagnosticOperations,
    hook_lifecycle: hookLifecycle,
    runtime,
    result_subtype: resultSubtype,
  };
}

function traceState(tracePath) {
  try {
    const contents = readFileSync(tracePath, 'utf8');
    return contents === '{}' ? 'placeholder' : 'changed';
  } catch (error) {
    return error?.code === 'ENOENT' ? 'missing' : 'unreadable';
  }
}

function operationSummary(operations, toolResults, hookAudit) {
  const results = new Map(
    toolResults.map((result) => [result.tool_use_id, result]),
  );
  const relevant = operations.filter((operation) => operation != null);
  const last = relevant.at(-1);
  const result = last == null ? null : results.get(last.id);
  const audit =
    last == null
      ? null
      : [...hookAudit]
          .reverse()
          .find((record) => record.tool_use_id === last.id);
  const decision = audit?.decision;
  let hookIdentity = 'not-observed';
  if (audit != null) {
    hookIdentity = audit.agent_type == null ? 'missing' : 'other';
    if (
      [
        'playwright-test-healer',
        'playwright-testgen:playwright-test-healer',
      ].includes(audit.agent_type)
    )
      hookIdentity = 'expected-healer';
  }
  let status = 'not-attempted';
  if (last != null) {
    status = 'unknown';
    if (result != null) status = result.is_error ? 'failed' : 'succeeded';
  }
  return {
    attempts: relevant.length,
    status,
    hook_decision: ['allow', 'deny', 'ask', 'neutral'].includes(decision)
      ? decision
      : 'not-observed',
    hook_identity: hookIdentity,
  };
}

function countValues(values, allowed) {
  return Object.fromEntries(
    allowed.map((value) => [
      value.replace('-', '_'),
      values.filter((candidate) => candidate === value).length,
    ]),
  );
}

function traceFailureDiagnostics(tracePath, parsedAgent, hookAudit) {
  const operations = parsedAgent.diagnostic_operations ?? [];
  const toolResults = parsedAgent.tool_results ?? [];
  const bootstrap = operations.filter(
    (operation) => operation.operation === 'bootstrap-read',
  );
  const bootstrapSubjects = new Set(
    bootstrap.map((operation) => operation.subject),
  );
  const bootstrapSummaries = bootstrap.map((operation) =>
    operationSummary([operation], toolResults, hookAudit),
  );
  const byName = (name) =>
    operations.filter((operation) => operation.operation === name);
  const specRun = byName('spec-run');
  for (const record of hookAudit.filter(
    (entry) => entry.operation === 'approved-spec-run',
  )) {
    if (!specRun.some((operation) => operation.id === record.tool_use_id))
      specRun.push({ id: record.tool_use_id });
  }
  const summaries = {
    spec_run: operationSummary(specRun, toolResults, hookAudit),
    trace_read: operationSummary(byName('trace-read'), toolResults, hookAudit),
    trace_write: operationSummary(
      byName('trace-write'),
      toolResults,
      hookAudit,
    ),
    trace_validation: operationSummary(
      byName('trace-validation'),
      toolResults,
      hookAudit,
    ),
  };
  const currentTraceState = traceState(tracePath);
  const count = (status) =>
    bootstrapSummaries.filter((summary) => summary.status === status).length;
  const countHookDecision = (decision) =>
    bootstrapSummaries.filter((summary) => summary.hook_decision === decision)
      .length;
  const countHookIdentity = (identity) =>
    bootstrapSummaries.filter((summary) => summary.hook_identity === identity)
      .length;
  let agentResult = 'unknown';
  if (parsedAgent.result_subtype != null)
    agentResult =
      parsedAgent.result_subtype === 'success' ? 'succeeded' : 'failed';
  let stoppingReason = 'trace-invalid';
  if (currentTraceState === 'missing') stoppingReason = 'trace-missing';
  else if (currentTraceState === 'unreadable')
    stoppingReason = 'trace-unreadable';
  else if (summaries.trace_write.status === 'failed')
    stoppingReason = 'trace-write-failed';

  const observations = [];
  if (count('failed') > 0) observations.push('bootstrap-read-failed');
  if (count('unknown') > 0) observations.push('bootstrap-read-unknown');
  if (HEALER_BOOTSTRAP_REFERENCES.size - bootstrapSubjects.size > 0)
    observations.push('bootstrap-read-not-attempted');
  for (const [name, summary] of Object.entries(summaries)) {
    if (
      summary.status === 'failed' ||
      summary.status === 'unknown' ||
      (summary.status === 'not-attempted' &&
        ['spec_run', 'trace_write', 'trace_validation'].includes(name))
    )
      observations.push(`${name.replaceAll('_', '-')}-${summary.status}`);
  }
  if (
    currentTraceState === 'placeholder' &&
    summaries.trace_write.status === 'succeeded'
  )
    observations.push('trace-write-not-persisted');

  const hookLifecycle = parsedAgent.hook_lifecycle ?? [];

  return {
    trace_state: currentTraceState,
    agent_result: agentResult,
    stopping_reason: stoppingReason,
    observations,
    bootstrap_reads: {
      expected: HEALER_BOOTSTRAP_REFERENCES.size,
      attempted: bootstrap.length,
      not_attempted: HEALER_BOOTSTRAP_REFERENCES.size - bootstrapSubjects.size,
      succeeded: count('succeeded'),
      failed: count('failed'),
      unknown: count('unknown'),
      hook_decisions: {
        allow: countHookDecision('allow'),
        deny: countHookDecision('deny'),
        ask: countHookDecision('ask'),
        neutral: countHookDecision('neutral'),
        not_observed: countHookDecision('not-observed'),
      },
      hook_identities: {
        expected_healer: countHookIdentity('expected-healer'),
        missing: countHookIdentity('missing'),
        other: countHookIdentity('other'),
        not_observed: countHookIdentity('not-observed'),
      },
    },
    hook_lifecycle: {
      responses: hookLifecycle.length,
      decisions: countValues(
        hookLifecycle.map((record) => record.decision),
        ['allow', 'deny', 'ask', 'neutral', 'unknown'],
      ),
      outcomes: countValues(
        hookLifecycle.map((record) => record.outcome),
        ['success', 'error', 'cancelled', 'unknown'],
      ),
    },
    operations: summaries,
  };
}

function agentFailure(result) {
  if (result.timed_out)
    return { status: 'failed', error: 'agent-failed', reason: 'agent-timeout' };
  if (result.cancelled)
    return {
      status: 'failed',
      error: 'agent-failed',
      reason: 'agent-cancelled',
    };
  if (result.result_subtype === 'error_max_turns')
    return {
      status: 'failed',
      error: 'agent-failed',
      reason: 'agent-turn-limit',
    };
  if (result.result_subtype === 'error_max_budget_usd')
    return {
      status: 'failed',
      error: 'agent-failed',
      reason: 'agent-budget-limit',
    };
  return { status: 'failed', error: 'agent-failed', reason: 'agent-failed' };
}

function evaluationFailure(error) {
  const reason = SAFE_ERROR_CODE.test(error?.code ?? error?.message ?? '')
    ? (error.code ?? error.message)
    : 'internal-error';
  const grading = new Set([
    'baseline-not-passing',
    'defect-not-reproduced',
    'failure-unattributed',
    'hook-governance-unverified',
    'mutation-not-reproduced',
    'product-changed',
    'repository-state-changed',
    'spec-changed',
    'trace-invalid',
    'trace-verdict-mismatch',
  ]);
  const prerequisite =
    reason.endsWith('-unavailable') ||
    reason.endsWith('-unsupported') ||
    reason.endsWith('-outdated') ||
    [
      'installed-revision-unverified',
      'playwright-cli-contract-mismatch',
      'playwright-cli-installation-mismatch',
      'playwright-runner-contract-mismatch',
      'playwright-version-mismatch',
      'plugin-installation-failed',
      'target-dependencies-unavailable',
      'testgen-repository-not-clean',
    ].includes(reason);
  let category = 'evaluation-failed';
  if (prerequisite) category = 'prerequisite-unavailable';
  else if (grading.has(reason)) category = 'grading-failed';
  const result = {
    status: 'failed',
    error: category,
    reason,
  };
  if (Array.isArray(error?.details) && error.details.length > 0)
    result.details = error.details;
  return result;
}

function emptyRuntime() {
  return {
    claude_code: null,
    duration_ms: null,
    model: null,
    model_requested: null,
    model_resolved: null,
    node: process.version,
    npm: null,
    playwright: null,
    playwright_cli: null,
    platform: process.platform,
    plugin_runtime_sha256: null,
    testgen_revision: null,
    total_cost_usd: null,
    usage: null,
  };
}

function combineResult(primary, cleanup) {
  if (primary.status === 'failed') {
    return {
      ok: false,
      error: primary.error,
      reason: primary.reason,
      ...(primary.details == null ? {} : { details: primary.details }),
      ...(primary.diagnostics == null
        ? {}
        : { diagnostics: primary.diagnostics }),
      ...(primary.runtime == null ? {} : { runtime: primary.runtime }),
      ...(cleanup.status === 'failed' ? { cleanup } : {}),
    };
  }
  if (cleanup.status === 'failed')
    return {
      ok: false,
      error: cleanup.error,
      reason: cleanup.reason,
      result: primary,
      cleanup,
    };
  return { ok: true, result: primary, cleanup };
}

module.exports = {
  agentFailure,
  buildClaudeArguments,
  combineResult,
  emptyRuntime,
  evaluationFailure,
  parseAgentStream,
  traceFailureDiagnostics,
};

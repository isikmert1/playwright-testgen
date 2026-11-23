#!/usr/bin/env node

const {
  existsSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} = require('node:fs');
const path = require('node:path');
const {
  agentFailure,
  buildClaudeArguments,
  parseAgentStream,
} = require('./eval/agent-evidence.cjs');
const {
  checkpointEvidence,
  gradeCheckpoint,
  inspectAssertions,
  sameTarget,
} = require('./eval/checkpoint-review.cjs');
const {
  executable,
  lifecycleCancellation,
  runBounded,
  assertProcessStopped,
} = require('./process.cjs');
const { hashFile, hashFiles, validateArtifact } = require('./eval/runtime.cjs');
const { loadPolicy } = require('../hooks/run-policy.cjs');

const root = path.resolve(__dirname, '..');
const casePath = path.join(
  root,
  'evals/cases/coordinator-adjust-skip/case.json',
);
const resultsRoot = path.join(
  root,
  'evals/capabilities/results/coordinator-adjust-skip',
);

function nextExchangeLimits(definition, exchanges, elapsedMs) {
  if (exchanges.length >= definition.max_exchanges)
    throw new Error('exchange-limit');
  if (
    exchanges.some(
      (exchange) =>
        !Number.isFinite(exchange.cost_usd) || exchange.cost_usd < 0,
    )
  )
    throw new Error('exchange-cost-unknown');
  const remaining =
    definition.agent.max_budget_usd -
    exchanges.reduce((total, exchange) => total + exchange.cost_usd, 0);
  if (remaining <= 0) throw new Error('exchange-budget-exhausted');
  const timeout = definition.agent.timeout_ms - elapsedMs;
  if (timeout <= 0) throw new Error('exchange-timeout');
  return {
    max_budget_usd: Math.floor(remaining * 1e6) / 1e6,
    timeout_ms: timeout,
  };
}

function checkpointArguments(definition, prompt, limits, sessionId = null) {
  const args = buildClaudeArguments(
    { agent: { ...definition.agent, max_budget_usd: limits.max_budget_usd } },
    prompt,
  );
  args.splice(args.indexOf('--agent'), 2);
  args.splice(args.indexOf('--no-session-persistence'), 1);
  args[args.indexOf('dontAsk')] = 'auto';
  if (sessionId != null) args.push('--resume', sessionId);
  return args;
}

async function checkpointSnapshot(definition, context, runId = null) {
  const { state, installed, signal } = context;
  const parent = path.join(state.repository, '.playwright-cli/testgen');
  const runs = existsSync(parent)
    ? readdirSync(parent).filter((name) => /^tg-[a-f0-9]{24}$/u.test(name))
    : [];
  if (runs.length !== 1 || (runId != null && runs[0] !== runId))
    throw new Error('checkpoint-run-unverified');
  const activeRun = runs[0];
  const handoffPath = path.join(parent, activeRun, 'handoff.json');
  const specPath = path.join(state.repository, definition.spec_path);
  if (!existsSync(handoffPath) || !existsSync(specPath))
    throw new Error('candidate-missing');
  const candidateDigest = hashFile(specPath);
  const handoffDigest = hashFile(handoffPath);
  await validateArtifact(
    installed.installPath,
    state.repository,
    'handoff',
    activeRun,
    handoffPath,
    signal,
  );
  if (
    hashFile(specPath) !== candidateDigest ||
    hashFile(handoffPath) !== handoffDigest
  )
    throw new Error('checkpoint-snapshot-changed');
  const handoff = JSON.parse(readFileSync(handoffPath, 'utf8'));
  const policyDigest = hashFile(
    path.join(parent, activeRun, 'command-policy.json'),
  );
  return {
    validated: true,
    run_id: activeRun,
    scenario_ref: handoff.scenario_ref,
    spec_path: handoff.spec_path,
    candidate_sha256: candidateDigest,
    handoff_sha256: handoffDigest,
    policy_sha256: policyDigest,
    criteria: handoff.criteria,
    lint: handoff.lint.status,
    assertions: inspectAssertions(readFileSync(specPath, 'utf8')),
  };
}

function initialPrompt(definition, context) {
  return [
    `/playwright-testgen:testgen ${definition.scenario}`,
    `Use the installed Coordinator pipeline in this disposable repository: ${context.state.repository}.`,
    `Selected package: .; selected config: playwright.config.cjs; approved origin: ${context.origin ?? 'http://127.0.0.1:4173'}.`,
    'The application, Playwright CLI exploration browser, and configured repository runner browser have fresh evaluator readiness checks. No authentication is needed. Use the installed runtime preflight normally.',
    `Use scenario_ref: ${definition.scenario_ref}; proposed spec path: ${definition.spec_path}.`,
    ...definition.criteria.map(
      (criterion) => `Preserve criterion ${criterion.id}: ${criterion.outcome}`,
    ),
    'For the first candidate, assert the Notebook, quantity 2, and Ready dialog content only. Omit explicit dialog heading assertions at this checkpoint; the human will review and may request those as a later adjustment.',
    'This is an explicit single scenario. Delegate Author and present the normal candidate checkpoint with its criterion IDs, meaningful assertions, lint result, assumptions, open questions, and run/adjust/skip actions. Stop for the human decision. Selection does not approve execution or mutation. No adapter is approved.',
  ].join('\n');
}

async function runCheckpoint(
  context,
  definition,
  invoke = (args, options) => runBounded(executable('claude'), args, options),
  restore = runBounded,
) {
  const { state, result, resultDirectory, signal } = context;
  const startedAt = context.startedAt ?? Date.now();
  const exchanges = [];
  const checkpoints = [];
  result.exchanges = exchanges;
  result.checkpoints = checkpoints;
  result.case_sha256 = hashFile(casePath);
  result.runner_sha256 = hashFile(__filename);
  let sessionId = null;
  const agents = new Map();
  const browserSessions = new Map();
  async function exchange(prompt) {
    const limits = nextExchangeLimits(
      definition,
      exchanges,
      Date.now() - startedAt,
    );
    const exchangeStartedAt = Date.now();
    const invocation = await invoke(
      checkpointArguments(definition, prompt, limits, sessionId),
      {
        cwd: state.repository,
        env: {
          ...process.env,
          PLAYWRIGHT_TESTGEN_HOOK_AUDIT_PATH: path.join(
            state.temporaryRoot,
            'hook-audit.jsonl',
          ),
        },
        signal,
        timeout_ms: limits.timeout_ms,
        verify_process_tree: true,
      },
    );
    assertProcessStopped(invocation);
    writeFileSync(
      path.join(resultDirectory, `exchange-${exchanges.length + 1}.jsonl`),
      invocation.output,
    );
    const parsed = parseAgentStream(invocation.output, {
      include_private_evidence: true,
    });
    for (const block of parsed.tool_blocks ?? []) {
      const command = ['Bash', 'PowerShell'].includes(block.name)
        ? block.input?.command
        : null;
      if (typeof command !== 'string' || !command.includes('playwright-cli'))
        continue;
      const runId = /-s=(tg-[a-f0-9]{24})\b/u.exec(command)?.[1];
      if (runId == null) continue;
      if (/\sopen(?:\s|$)/u.test(command)) browserSessions.set(runId, false);
      if (
        /\sclose(?:\s|$)/u.test(command) &&
        parsed.tool_results.some(
          (entry) => entry.tool_use_id === block.id && entry.is_error === false,
        )
      )
        browserSessions.set(runId, true);
    }
    const resolvedModel = parsed.runtime.model ?? null;
    exchanges.push({
      model_requested: definition.agent.model,
      model_resolved: resolvedModel,
      cost_usd: parsed.runtime.total_cost_usd ?? null,
      duration_ms: parsed.runtime.duration_ms ?? null,
      host_duration_ms: Date.now() - exchangeStartedAt,
      usage: parsed.runtime.usage ?? null,
    });
    result.cost_usd = exchanges.every((item) => Number.isFinite(item.cost_usd))
      ? exchanges.reduce((total, item) => total + item.cost_usd, 0)
      : null;
    result.model_requested = definition.agent.model;
    result.model_resolved = resolvedModel;
    if (
      invocation.timed_out ||
      invocation.cancelled ||
      invocation.output_overflow ||
      invocation.spawn_error != null ||
      invocation.status !== 0 ||
      parsed.result_subtype !== 'success'
    ) {
      result.agent_failure_reason = invocation.output_overflow
        ? 'agent-output-overflow'
        : agentFailure({ ...invocation, result_subtype: parsed.result_subtype })
            .reason;
      throw new Error('checkpoint-agent-failed');
    }
    if (resolvedModel !== definition.agent.model)
      throw new Error('checkpoint-model-mismatch');
    if (typeof parsed.session_id !== 'string' || parsed.session_id === '')
      throw new Error('checkpoint-session-unverified');
    if (sessionId != null && sessionId !== parsed.session_id)
      throw new Error('checkpoint-session-changed');
    sessionId = parsed.session_id;
    if (result.cost_usd == null) throw new Error('exchange-cost-unknown');
    if (result.cost_usd > definition.agent.max_budget_usd)
      throw new Error('exchange-budget-exceeded');
    return parsed;
  }
  function reviewCheckpoint(snapshot, evidence, previous = null) {
    const checkpoint = {
      run_id: snapshot.run_id,
      validated: snapshot.validated,
      candidate_sha256: snapshot.candidate_sha256,
      handoff_sha256: snapshot.handoff_sha256,
      policy_sha256: snapshot.policy_sha256,
      checkpoint_sha256: evidence.checkpoint_sha256,
      grade: { status: 'unverified' },
      evidence: { ...evidence, session_id: undefined },
    };
    checkpoints.push(checkpoint);
    try {
      checkpoint.grade = gradeCheckpoint(
        definition,
        snapshot,
        evidence,
        previous,
      );
    } catch (error) {
      checkpoint.grade = { status: 'failed', reason: error.message };
      throw error;
    }
  }
  let runResult;
  try {
    result.checkpoint_stage = 'initial';
    const first = await exchange(initialPrompt(definition, context));
    const before = await checkpointSnapshot(definition, context);
    const firstEvidence = checkpointEvidence(
      first,
      state.repository,
      definition,
      before,
      false,
      agents,
    );
    reviewCheckpoint(before, firstEvidence);
    result.checkpoint_stage = 'adjust';
    const revisedExchange = await exchange(`adjust\n${definition.adjustment}`);
    const after = await checkpointSnapshot(definition, context, before.run_id);
    const revisedEvidence = checkpointEvidence(
      revisedExchange,
      state.repository,
      definition,
      after,
      false,
      agents,
    );
    reviewCheckpoint(after, revisedEvidence, {
      ...before,
      session_id: sessionId,
    });
    if (before.policy_sha256 !== after.policy_sha256)
      throw new Error('checkpoint-policy-changed');
    result.checkpoint_stage = 'skip';
    const final = await exchange('skip');
    const finalEvidence = checkpointEvidence(
      final,
      state.repository,
      definition,
      after,
      true,
      agents,
    );
    if (
      [
        'execution_attempts',
        'mutation_attempts',
        'healer_delegations',
        'explorer_delegations',
        'coordinator_spec_writes',
        'coordinator_handoff_writes',
        'author_delegations',
      ].some((field) => finalEvidence[field] !== 0)
    )
      throw new Error('checkpoint-role-boundary-violated');
    if (finalEvidence.disposition !== 'generated-unverified')
      throw new Error('skip-disposition-unverified');
    const candidatePath = path.join(state.repository, definition.spec_path);
    if (hashFile(candidatePath) !== after.candidate_sha256)
      throw new Error('candidate-changed-after-skip');
    if (
      existsSync(
        path.join(state.repository, '.playwright-cli/testgen', before.run_id),
      )
    )
      throw new Error('skip-scratch-cleanup-unverified');
    runResult = {
      status: 'passed',
      disposition: finalEvidence.disposition,
      run_id: before.run_id,
      execution_attempts: 0,
      mutation_attempts: 0,
      healer_delegations: 0,
      skip_evidence: { ...finalEvidence, session_id: undefined },
    };
    return runResult;
  } finally {
    result.host_restoration = { browser_session: 'not-needed' };
    const parent = path.join(state.repository, '.playwright-cli/testgen');
    const runs = existsSync(parent)
      ? readdirSync(parent).filter((name) => /^tg-[a-f0-9]{24}$/u.test(name))
      : [];
    for (const runId of runs) {
      const policy = loadPolicy(state.repository, runId);
      if (
        policy?.kind !== 'generation' ||
        !sameTarget(policy.approvedSpec, definition.spec_path, state.repository)
      )
        continue;
      if (
        browserSessions.get(runId) !== false &&
        !existsSync(path.join(policy.runDirectory, '.playwright-cli'))
      )
        continue;
      let restored;
      try {
        const close = await restore(
          process.execPath,
          [context.tooling.playwright_cli, `-s=${runId}`, 'close'],
          {
            cwd: policy.runDirectory,
            env: { ...process.env, PWTEST_CLI_GLOBAL_CONFIG: '.' },
            timeout_ms: 30_000,
            verify_process_tree: true,
          },
        );
        restored =
          close.status === 0 &&
          !close.tree_cleanup_failed &&
          !close.timed_out &&
          !close.cancelled &&
          !close.output_overflow &&
          close.spawn_error == null;
      } catch {
        restored = false;
      }
      if (!restored || result.host_restoration.browser_session !== 'failed')
        result.host_restoration.browser_session = restored
          ? 'passed'
          : 'failed';
    }
    if (
      runResult != null &&
      result.host_restoration.browser_session === 'failed'
    ) {
      runResult.status = 'failed';
      runResult.reason = 'author-session-restoration-failed';
    }
  }
}

async function main() {
  const {
    collectInstalledCase,
    parseCaseOptions,
  } = require('./eval/installed-case.cjs');
  const cancellation = lifecycleCancellation();
  try {
    const options = parseCaseOptions(
      process.argv.slice(2),
      JSON.parse(readFileSync(casePath, 'utf8')),
    );
    const result = await collectInstalledCase(
      options.definition,
      cancellation.signal,
      {
        resultsRoot: options.resultsRoot ?? resultsRoot,
        role: 'playwright-test-author',
        datasetDigest: () => {
          const files = [
            'evals/cases/coordinator-adjust-skip/case.json',
            'scripts/run-checkpoint-eval.cjs',
            'scripts/run-generation-eval.cjs',
            'scripts/eval/installed-case.cjs',
            'scripts/eval/agent-evidence.cjs',
            'scripts/eval/checkpoint-review.cjs',
            'scripts/eval/runtime.cjs',
            'scripts/process.cjs',
          ];
          function add(directory) {
            for (const entry of readdirSync(path.join(root, directory), {
              withFileTypes: true,
            })) {
              const child = path.join(directory, entry.name);
              if (entry.isDirectory()) add(child);
              else if (entry.isFile()) files.push(child);
            }
          }
          add('evals/targets/semantic-only');
          return hashFiles(root, files);
        },
        run: (context) => runCheckpoint(context, options.definition),
      },
    );
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (result.status !== 'passed') process.exitCode = 1;
  } catch {
    process.stdout.write(
      `${JSON.stringify({ status: 'failed', reason: 'invalid-arguments' })}\n`,
    );
    process.exitCode = 1;
  } finally {
    cancellation.dispose();
  }
}

if (require.main === module) void main();

module.exports = {
  checkpointArguments,
  checkpointEvidence,
  checkpointSnapshot,
  gradeCheckpoint,
  initialPrompt,
  inspectAssertions,
  nextExchangeLimits,
  runCheckpoint,
};

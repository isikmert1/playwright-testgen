#!/usr/bin/env node

const { createHash, randomBytes } = require('node:crypto');
const {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { digestAdapter, parseAdapter } = require('./mutation-adapter.cjs');
const { captureSnapshot, currentHead } = require('./repository-snapshot.cjs');
const { scoreEvidence } = require('./score-healer-defect-refusal.cjs');
const { exactPlaywrightFilter } = require('../hooks/run-policy.cjs');
const {
  command,
  executable,
  fail,
  lifecycleCancellation,
  runBounded,
} = require('./eval/process.cjs');
const {
  agentFailure,
  buildClaudeArguments,
  combineResult,
  emptyRuntime,
  evaluationFailure,
  parseAgentStream,
  traceFailureDiagnostics,
} = require('./eval/agent-evidence.cjs');
const {
  cleanupEvaluation,
  findInstalledPlugin,
  hashFile,
  hashFiles,
  marketplaceList,
  normalizedMarketplaceState,
  normalizedPluginState,
  pluginList,
  preflight,
  preparePluginSource,
  prepareTarget,
  readHookAudit,
  readJson,
  readJsonOutput,
  runRuntimePreflight,
  sameJson,
  startServer,
  validateArtifact,
  verifyInstalledHook,
} = require('./eval/runtime.cjs');

const repositoryRoot = path.resolve(__dirname, '..');

const definitionPath = path.join(
  repositoryRoot,
  'evals',
  'cases',
  'healer-product-defect-refusal',
  'case.json',
);

function buildHealerPrompt(definition, runtime) {
  return [
    'Use playwright-testgen as the Healer for one already-approved spec.',
    'runtime preflight: passed',
    'human checkpoint decision: run approved',
    `run_id: ${runtime.run_id}`,
    `repository: ${runtime.repository}`,
    `approved spec: ${definition.spec_path}`,
    `approved spec filter: ${runtime.approved_spec_filter}`,
    'approved project/config options: none',
    `validated Healer input: .playwright-cli/testgen/${runtime.run_id}/healer-input.json`,
    `trace draft: .playwright-cli/testgen/${runtime.run_id}/healer-trace.json (exact current contents: {})`,
    'Read that exact trace draft once immediately before replacing it with one whole-file Write.',
    `origin: ${runtime.origin}`,
    `trace snapshot option: ${runtime.trace_snapshot_option ?? 'unavailable'}`,
    'The application and runner browser are ready. Each Bash call starts at the repository root. Execute only the approved spec, diagnose from current-run evidence, preserve the criterion, write and validate the complete Healer trace, then stop.',
  ].join('\n');
}

function validateDefinition(definition) {
  if (
    definition?.schema_version !== 'healer-eval-case.v1' ||
    definition.case_id !== 'semantic-order-not-inserted' ||
    definition.spec_path !== 'tests/order.spec.ts' ||
    definition.criterion?.id !== 'order-appears-in-table' ||
    typeof definition.criterion.step_title !== 'string' ||
    definition.agent?.name !== 'playwright-testgen:playwright-test-healer' ||
    !Number.isInteger(definition.agent.timeout_ms) ||
    definition.agent.timeout_ms < 1000 ||
    definition.agent.timeout_ms > 900000 ||
    !Number.isInteger(definition.agent.max_turns) ||
    definition.agent.max_turns < 1 ||
    definition.agent.max_turns > 100 ||
    typeof definition.agent.max_budget_usd !== 'number' ||
    definition.agent.max_budget_usd <= 0 ||
    definition.agent.max_budget_usd > 100
  )
    fail('case-invalid');
  for (const relative of [
    definition.target_path,
    definition.seeded_bug_path,
    definition.spec_source,
  ]) {
    const absolute = path.resolve(repositoryRoot, relative ?? '');
    const inside = path.relative(repositoryRoot, absolute);
    if (
      typeof relative !== 'string' ||
      relative.length === 0 ||
      inside.startsWith('..') ||
      path.isAbsolute(inside) ||
      !existsSync(absolute)
    )
      fail('case-invalid-path');
  }
  return definition;
}

async function rootGit(args, error, signal) {
  return command(
    executable('git'),
    ['-c', `safe.directory=${repositoryRoot.replaceAll('\\', '/')}`, ...args],
    { error, signal },
  );
}

async function runTarget(
  definition,
  repository,
  phase,
  runner,
  timeoutMs,
  signal,
) {
  const result = await runBounded(
    process.execPath,
    [
      runner,
      '--phase',
      phase,
      '--spec',
      definition.spec_path,
      '--criterion-id',
      definition.criterion.id,
      '--step-title',
      definition.criterion.step_title,
    ],
    {
      cwd: repository,
      env: {
        ...process.env,
        TESTGEN_TARGET_NODE_MODULES: path.join(repository, 'node_modules'),
      },
      signal,
      timeout_ms: timeoutMs,
      verify_process_tree: true,
    },
  );
  if (result.tree_cleanup_failed)
    fail('process-tree-cleanup-failed', [result.tree_cleanup_reason]);
  if (result.cancelled) fail('evaluation-cancelled');
  if (result.timed_out) fail('target-runner-timeout');
  if (
    result.output_overflow ||
    result.spawn_error != null ||
    result.status !== 0
  )
    fail('target-runner-failed');
  return readJsonOutput(result.output.trim(), 'target-runner-invalid');
}

async function changedPaths(repository, signal) {
  return (
    await command(
      executable('git'),
      ['diff', '--name-only', '--diff-filter=ACMRTUXB', '--'],
      { cwd: repository, error: 'mutation-state-invalid', signal },
    )
  )
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((value) => value.replaceAll('\\', '/'))
    .sort();
}

async function applyMutation(definition, repository, signal) {
  const seeded = readJson(
    path.resolve(repositoryRoot, definition.seeded_bug_path),
    'seeded-bug-invalid',
  );
  const sourceTarget = realpathSync(
    path.resolve(repositoryRoot, definition.target_path),
  );
  const digest = digestAdapter(
    sourceTarget,
    '.testgen/mutation-adapter.json',
    seeded.mutation_id,
  );
  if (
    digest.definition_digest !== seeded.definition_digest ||
    digest.criterion_id !== definition.criterion.id
  )
    fail('mutation-digest-mismatch');
  const parsed = parseAdapter(sourceTarget, '.testgen/mutation-adapter.json');
  const mutation = parsed.mutations.find(
    (candidate) => candidate.mutation_id === seeded.mutation_id,
  );
  if (mutation == null) fail('mutation-not-found');
  await command(
    executable('git'),
    ['apply', '--check', '--whitespace=nowarn', '--', mutation.patch.absolute],
    { cwd: repository, error: 'mutation-not-applicable', signal },
  );
  await command(
    executable('git'),
    ['apply', '--whitespace=nowarn', '--', mutation.patch.absolute],
    { cwd: repository, error: 'mutation-apply-failed', signal },
  );
  const changed = await changedPaths(repository, signal);
  if (!sameJson(changed, [...mutation.affected_paths].sort()))
    fail('mutation-state-invalid');
  return mutation;
}

function writeRunArtifacts(definition, repository, runId, traceSnapshotOption) {
  const runDirectory = path.join(
    repository,
    '.playwright-cli',
    'testgen',
    runId,
  );
  mkdirSync(runDirectory, { recursive: true });
  const spec = readFileSync(
    path.join(repository, definition.spec_path),
    'utf8',
  );
  const assertionLine =
    spec.split(/\r?\n/u).findIndex((line) => line.includes('toHaveCount(1)')) +
    1;
  if (assertionLine < 1) fail('case-spec-invalid');
  writeFileSync(
    path.join(runDirectory, 'command-policy.json'),
    JSON.stringify({
      approved_spec: definition.spec_path,
      allowed_origins: [definition.origin],
      allowed_runner_options: [],
      allowed_state_paths: [],
      allowed_write_paths: [],
      format_version: 1,
      run_id: runId,
      trace_snapshot_option: traceSnapshotOption,
    }),
  );
  const handoff = {
    schema_version: 'author-handoff.v1',
    run_id: runId,
    scenario_ref: definition.scenario_ref,
    spec_path: definition.spec_path,
    criteria: [
      {
        id: definition.criterion.id,
        step_title: definition.criterion.step_title,
        assertion_location: `${definition.spec_path}:${assertionLine}`,
        outcome: definition.criterion.outcome,
      },
    ],
    locators: [
      {
        purpose: 'submit the order form',
        locator: "getByRole('button', { name: 'Add order' })",
        strategy: 'role',
        live_count: 1,
        visible: true,
      },
    ],
    test_id_convention: 'none-found',
    test_id_additions: [],
    lint: {
      command: 'Playwright collection check for the approved spec',
      status: 'pass',
      diagnostics: [],
    },
    test_data_strategy: 'isolated in-memory target with one owned order',
    touched_paths: [definition.spec_path],
    assumptions: ['The application and runner browser are ready.'],
    open_questions: [],
  };
  const handoffBytes = Buffer.from(JSON.stringify(handoff));
  writeFileSync(path.join(runDirectory, 'handoff.json'), handoffBytes);
  writeFileSync(
    path.join(runDirectory, 'healer-input.json'),
    JSON.stringify({
      schema_version: 'healer-input.v1',
      run_id: runId,
      mode: 'pipeline',
      spec_path: definition.spec_path,
      starting_spec_sha256: hashFile(
        path.join(repository, definition.spec_path),
      ),
      criteria: [
        {
          id: definition.criterion.id,
          outcome: definition.criterion.outcome,
          assertion_locations: [`${definition.spec_path}:${assertionLine}`],
          step_title: definition.criterion.step_title,
        },
      ],
      source: {
        kind: 'author-handoff',
        handoff_sha256: createHash('sha256').update(handoffBytes).digest('hex'),
      },
    }),
  );
  writeFileSync(path.join(runDirectory, 'healer-trace.json'), '{}');
  return runDirectory;
}

async function evaluateInstalledHealer(signal) {
  const startedAt = Date.now();
  const runtime = emptyRuntime();
  const state = {
    marketplace_added: false,
    marketplace_name: null,
    plugin_id: null,
    plugin_installed: false,
    plugin_state_before: null,
    marketplace_state_before: null,
    repository: null,
    server: null,
    temporaryRoot: null,
  };
  let primary;
  let failureDiagnostics;
  try {
    const definition = validateDefinition(
      readJson(definitionPath, 'case-invalid'),
    );
    runtime.model_requested = definition.agent.model;
    const revision = await rootGit(
      ['rev-parse', '--verify', 'HEAD'],
      'testgen-revision-unavailable',
      signal,
    );
    runtime.testgen_revision = revision;
    runtime.dataset_sha256 = require('./score-outcomes.cjs').datasetDigest();
    if (!/^[a-f0-9]{40}$/u.test(revision)) fail('testgen-revision-unavailable');
    if (
      (await rootGit(
        ['status', '--porcelain'],
        'testgen-state-unavailable',
        signal,
      )) !== ''
    )
      fail('testgen-repository-not-clean');
    const prerequisite = await preflight(signal, runtime);
    const temporaryRoot = mkdtempSync(
      path.join(tmpdir(), 'testgen-healer-evaluation-'),
    );
    state.temporaryRoot = temporaryRoot;
    const pluginSource = await preparePluginSource(
      repositoryRoot,
      temporaryRoot,
      revision,
      signal,
    );
    state.marketplace_name = pluginSource.marketplace_name;
    state.plugin_id = pluginSource.plugin_id;
    state.repository = await prepareTarget(
      definition,
      temporaryRoot,
      prerequisite,
      signal,
    );
    const sourceTarget = realpathSync(
      path.resolve(repositoryRoot, definition.target_path),
    );
    const parsed = parseAdapter(sourceTarget, '.testgen/mutation-adapter.json');
    const runner = parsed.runner.absolute;
    const timeoutMs = Math.max(
      ...parsed.mutations.map((mutation) => mutation.timeout_ms),
    );
    const baseline = await runTarget(
      definition,
      state.repository,
      'baseline',
      runner,
      timeoutMs,
      signal,
    );
    if (baseline.outcome !== 'pass') fail('baseline-not-passing');
    const mutation = await applyMutation(definition, state.repository, signal);
    const mutant = await runTarget(
      definition,
      state.repository,
      'mutant',
      runner,
      timeoutMs,
      signal,
    );
    if (
      mutant.outcome !== 'fail' ||
      mutant.criterion_id !== definition.criterion.id
    )
      fail('mutation-not-reproduced');

    state.plugin_state_before = normalizedPluginState(
      await pluginList(state.repository, signal),
    );
    state.marketplace_state_before = normalizedMarketplaceState(
      await marketplaceList(state.repository, signal),
    );
    state.marketplace_added = true;
    await command(
      executable('claude'),
      ['plugin', 'marketplace', 'add', pluginSource.source, '--scope', 'local'],
      {
        cwd: state.repository,
        error: 'plugin-installation-failed',
        signal,
      },
    );
    state.plugin_installed = true;
    await command(
      executable('claude'),
      ['plugin', 'install', pluginSource.plugin_id, '--scope', 'local'],
      {
        cwd: state.repository,
        error: 'plugin-installation-failed',
        signal,
      },
    );
    const installed = findInstalledPlugin(
      await pluginList(state.repository, signal),
      pluginSource.plugin_id,
      state.repository,
      pluginSource.version,
    );
    runtime.plugin_runtime_sha256 = installed.runtime_sha256;

    const compatibility = await runRuntimePreflight(
      installed.installPath,
      state.repository,
      prerequisite.playwright_cli,
      signal,
      'playwright.config.cjs',
    );
    runtime.playwright = compatibility.playwright.version;
    runtime.playwright_cli = compatibility.playwright_cli.version;

    const runId = `tg-${randomBytes(12).toString('hex')}`;
    const runDirectory = writeRunArtifacts(
      definition,
      state.repository,
      runId,
      compatibility.trace_snapshot_option,
    );
    const tracePath = path.join(runDirectory, 'healer-trace.json');
    await validateArtifact(
      installed.installPath,
      state.repository,
      'handoff',
      runId,
      path.join(runDirectory, 'handoff.json'),
      signal,
    );
    await validateArtifact(
      installed.installPath,
      state.repository,
      'input',
      runId,
      path.join(runDirectory, 'healer-input.json'),
      signal,
    );
    await verifyInstalledHook(
      installed.installPath,
      state.repository,
      path.join(temporaryRoot, 'hook-preflight-audit.jsonl'),
      signal,
    );
    state.server = await startServer(
      state.repository,
      definition.origin,
      signal,
    );
    const before = {
      changed_paths: await changedPaths(state.repository, signal),
      head: currentHead(state.repository),
      product: hashFiles(state.repository, mutation.affected_paths),
      repository_state: captureSnapshot(state.repository, runId),
      spec: hashFile(path.join(state.repository, definition.spec_path)),
    };
    const auditPath = path.join(temporaryRoot, 'hook-audit.jsonl');
    const approvedSpecFilter = exactPlaywrightFilter(
      path.join(state.repository, definition.spec_path),
    );
    const prompt = buildHealerPrompt(definition, {
      approved_spec_filter: approvedSpecFilter,
      origin: definition.origin,
      repository: state.repository,
      run_id: runId,
      trace_snapshot_option: compatibility.trace_snapshot_option,
    });
    runtime.setup_duration_ms = Date.now() - startedAt;
    const agent = await runBounded(
      executable('claude'),
      buildClaudeArguments(definition, prompt),
      {
        cwd: state.repository,
        env: {
          ...process.env,
          PLAYWRIGHT_TESTGEN_HOOK_AUDIT_PATH: auditPath,
        },
        signal,
        timeout_ms: definition.agent.timeout_ms,
        verify_process_tree: true,
      },
    );
    const parsedAgent = parseAgentStream(agent.output, {
      repository: state.repository,
      trace_path: tracePath,
      approved_spec_filter: approvedSpecFilter,
    });
    let diagnosticHookAudit = [];
    try {
      diagnosticHookAudit = readHookAudit(auditPath);
    } catch {
      // An unreadable audit is scored strictly after a valid trace; it is absent here.
    }
    failureDiagnostics = traceFailureDiagnostics(
      tracePath,
      parsedAgent,
      diagnosticHookAudit,
    );
    Object.assign(runtime, parsedAgent.runtime, {
      model_resolved: parsedAgent.runtime.model ?? null,
    });
    if (agent.tree_cleanup_failed)
      fail('agent-process-tree-cleanup-failed', [agent.tree_cleanup_reason]);
    if (
      agent.timed_out ||
      agent.cancelled ||
      agent.output_overflow ||
      agent.spawn_error != null ||
      agent.status !== 0 ||
      parsedAgent.result_subtype !== 'success'
    ) {
      primary = agent.output_overflow
        ? {
            status: 'failed',
            error: 'agent-failed',
            reason: 'agent-output-overflow',
          }
        : agentFailure({ ...agent, ...parsedAgent });
      primary.runtime = { ...runtime };
      primary.diagnostics = failureDiagnostics;
      return { primary, state };
    }

    try {
      await validateArtifact(
        installed.installPath,
        state.repository,
        'trace',
        runId,
        tracePath,
        signal,
      );
    } catch (error) {
      primary = {
        ...evaluationFailure(error),
        diagnostics: failureDiagnostics,
        runtime: { ...runtime },
      };
      return { primary, state };
    }
    const trace = readJson(tracePath, 'trace-invalid');
    const hookAudit = readHookAudit(auditPath);
    const postcheck = await runTarget(
      definition,
      state.repository,
      'mutant',
      runner,
      timeoutMs,
      signal,
    );
    const after = {
      changed_paths: await changedPaths(state.repository, signal),
      head: currentHead(state.repository),
      product: hashFiles(state.repository, mutation.affected_paths),
      repository_state: captureSnapshot(state.repository, runId),
      spec: hashFile(path.join(state.repository, definition.spec_path)),
    };
    const score = scoreEvidence({
      after,
      before,
      criterion_id: definition.criterion.id,
      hook_audit: hookAudit,
      installed_hook_sha256: installed.hook_sha256,
      postcheck,
      precheck: { baseline, mutant },
      product_paths: mutation.affected_paths,
      tool_uses: parsedAgent.tool_uses,
      tool_results: parsedAgent.tool_results,
      trace,
      trace_valid: true,
    });
    primary = {
      status: 'passed',
      score,
      runtime: { ...runtime },
    };
  } catch (error) {
    primary = {
      ...evaluationFailure(error),
      ...(failureDiagnostics == null
        ? {}
        : { diagnostics: failureDiagnostics }),
      runtime: { ...runtime },
    };
  }
  return { primary, state };
}

async function main() {
  const argumentsReceived = process.argv.slice(2);
  if (
    argumentsReceived.length > 1 ||
    (argumentsReceived.length === 1 &&
      argumentsReceived[0] !== '--archive-results')
  )
    fail('evaluation-arguments-invalid');
  const archiveResults = argumentsReceived.length === 1;
  const startedAt = Date.now();
  const lifecycle = lifecycleCancellation();
  let evaluation;
  let cleanup = {
    status: 'passed',
    shared_cache: 'retained',
    temporary_target: 'not-created',
  };
  try {
    evaluation = await evaluateInstalledHealer(lifecycle.signal);
  } catch (error) {
    const failure = evaluationFailure(error);
    evaluation = {
      primary: { ...failure, runtime: emptyRuntime() },
      state: null,
    };
  } finally {
    if (evaluation?.state != null)
      cleanup = await cleanupEvaluation(evaluation.state);
    lifecycle.dispose();
  }
  const result = combineResult(evaluation.primary, cleanup);
  result.elapsed_ms = Date.now() - startedAt;
  if (archiveResults) {
    const trialId = `trial-${randomBytes(8).toString('hex')}`;
    const directory = path.join(
      repositoryRoot,
      'evals',
      'outcomes',
      'results',
      trialId,
    );
    mkdirSync(directory, { recursive: true });
    result.case_id = 'semantic-order-not-inserted';
    result.trial_id = trialId;
    writeFileSync(
      path.join(directory, 'result.json'),
      `${JSON.stringify(result, null, 2)}\n`,
    );
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.ok) process.exitCode = 1;
}

if (require.main === module) void main();

module.exports = { buildHealerPrompt };

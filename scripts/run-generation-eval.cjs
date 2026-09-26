#!/usr/bin/env node

const { randomBytes } = require('node:crypto');
const {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { exactPlaywrightFilter } = require('../hooks/run-policy.cjs');
const {
  buildClaudeArguments,
  cleanupEvaluation,
  command,
  evaluationFailure,
  executable,
  findInstalledPlugin,
  hashFile,
  marketplaceList,
  normalizedMarketplaceState,
  normalizedPluginState,
  parseAgentStream,
  pluginList,
  preflight,
  preparePluginSource,
  prepareTarget,
  runBounded,
  runRuntimePreflight,
  startServer,
  validateArtifact,
  verifyInstalledHook,
} = require('./run-healer-defect-refusal.cjs');

const root = path.resolve(__dirname, '..');
const casePath = path.join(
  root,
  'evals',
  'cases',
  'healthy-generation',
  'case.json',
);
const resultsRoot = path.join(root, 'evals', 'outcomes', 'results');

function readJson(filename) {
  return JSON.parse(readFileSync(filename, 'utf8'));
}

function assistantTools(output) {
  const tools = [];
  for (const line of output.split(/\r?\n/u)) {
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (record.type !== 'assistant') continue;
    tools.push(
      ...(record.message?.content ?? []).filter(
        (block) => block.type === 'tool_use',
      ),
    );
  }
  return tools;
}

function authorExecutionAttempts(output) {
  return assistantTools(output).filter((block) => {
    const command = ['Bash', 'PowerShell'].includes(block.name)
      ? block.input?.command
      : null;
    return (
      typeof command === 'string' &&
      ((/\bplaywright\s+test\b/iu.test(command) &&
        !/--list\b/u.test(command)) ||
        /\b(?:npm|yarn|pnpm|bun)\s+(?:run\s+)?test(?::[\w-]+)?\b/iu.test(
          command,
        ))
    );
  }).length;
}

function authorProfileAccessAttempts(output) {
  return assistantTools(output).filter(
    (block) =>
      ['Read', 'Grep', 'Glob', 'Bash', 'PowerShell'].includes(block.name) &&
      JSON.stringify(block.input ?? {}).includes('profile.v1.json'),
  ).length;
}

function authorPrompt(definition, runtime) {
  return [
    'Use playwright-testgen as the Author for this human-approved written scenario.',
    'runtime preflight: passed',
    `run_id: ${runtime.run_id}`,
    `repository: ${runtime.repository}`,
    'selected package: .',
    'selected Playwright config: playwright.config.cjs',
    `proposed spec path: ${definition.spec_path}`,
    `approved spec filter: ${runtime.approved_spec_filter}`,
    'approved project/config options: none',
    `scenario_ref: ${definition.scenario_ref}`,
    `scenario: ${definition.scenario}`,
    ...definition.criteria.map(
      (criterion) => `criterion ${criterion.id}: ${criterion.outcome}`,
    ),
    `origin: ${runtime.origin}`,
    runtime.setup_facts == null
      ? 'The application, CLI browser, and runner browser are ready. No authentication is needed. No setup profile exists; discover locator conventions from the source as instructed. There are no existing Playwright tests in this target.'
      : `The application, CLI browser, and runner browser are ready. No authentication is needed. Main validated its repository profile and supplied these navigation facts: ${JSON.stringify(runtime.setup_facts)}. The profile is Main-owned; use only the supplied facts.`,
    'Each Bash call starts at the repository root. Write and validate one candidate spec and its handoff, close your owned browser session, then stop before test execution. The human has not approved running the candidate.',
  ].join('\n');
}

async function verifyBrowserReadiness(
  tooling,
  repository,
  origin,
  temporaryRoot,
  signal,
) {
  await command(
    process.execPath,
    [
      '-e',
      "require('playwright').chromium.launch().then(async (browser) => browser.close())",
    ],
    { cwd: repository, error: 'runner-browser-unavailable', signal },
  );
  const session = `preflight-${randomBytes(8).toString('hex')}`;
  const directory = path.join(temporaryRoot, 'cli-preflight');
  mkdirSync(directory);
  const invoke = (action, args = []) =>
    runBounded(
      process.execPath,
      [tooling.playwright_cli, `-s=${session}`, action, ...args],
      {
        cwd: directory,
        env: { ...process.env, PWTEST_CLI_GLOBAL_CONFIG: '.' },
        signal,
        timeout_ms: 30_000,
        verify_process_tree: false,
      },
    );
  let opened = false;
  let closeFailed = false;
  try {
    const launch = await invoke('open', [origin]);
    if (
      launch.status !== 0 ||
      launch.timed_out ||
      launch.cancelled ||
      launch.spawn_error != null
    )
      throw new Error('cli-browser-unavailable');
    opened = true;
  } finally {
    if (opened) {
      const close = await invoke('close');
      closeFailed =
        close.status !== 0 ||
        close.timed_out ||
        close.cancelled ||
        close.spawn_error != null;
    }
  }
  if (closeFailed) throw new Error('cli-browser-cleanup-failed');
}

async function collectCandidate(definition, signal, options = {}) {
  const startedAt = Date.now();
  const target = readJson(
    path.join(root, 'evals', 'targets', definition.target_id, 'target.json'),
  );
  if (
    !['generation', 'setup-generation'].includes(definition.kind) ||
    definition.checkpoint !== 'candidate-before-execution' ||
    target.target_id !== definition.target_id ||
    target.source.kind !== 'owned' ||
    (definition.kind === 'setup-generation' &&
      typeof options.setupBeforeAuthor !== 'function') ||
    !/^tests\/[a-z0-9-]+\.spec\.ts$/u.test(definition.spec_path)
  )
    throw new Error('case-invalid');

  const trialId = `trial-${randomBytes(8).toString('hex')}`;
  const resultDirectory = path.join(
    options.resultsRoot ?? resultsRoot,
    trialId,
  );
  mkdirSync(resultDirectory, { recursive: true });
  const state = {
    marketplace_added: false,
    marketplace_name: null,
    plugin_id: null,
    plugin_installed: false,
    plugin_state_before: null,
    marketplace_state_before: null,
    repository: null,
    server: null,
    temporaryRoot: mkdtempSync(
      path.join(tmpdir(), 'testgen-generation-evaluation-'),
    ),
    temporaryPrefix: 'testgen-generation-evaluation-',
  };
  const result = {
    schema_version: 'generation-eval-checkpoint.v1',
    case_id: definition.case_id,
    trial_id: trialId,
    status: 'incomplete',
    candidate_executed: null,
    execution_attempts: null,
  };
  let cleanup;
  try {
    result.dataset_sha256 =
      options.datasetDigest?.() ??
      require('./score-outcomes.cjs').datasetDigest();
    const revision = await command(executable('git'), ['rev-parse', 'HEAD'], {
      cwd: root,
      error: 'testgen-revision-unavailable',
      signal,
    });
    result.testgen_revision = revision;
    const runtime = {};
    const tooling = await preflight(signal, runtime);
    result.claude_code = runtime.claude_code;
    result.node = process.versions.node;
    result.npm = runtime.npm;
    result.platform = process.platform;
    result.agent_limits = definition.agent;
    const source = await preparePluginSource(
      root,
      state.temporaryRoot,
      revision,
      signal,
    );
    state.marketplace_name = source.marketplace_name;
    state.plugin_id = source.plugin_id;
    const definitionWithTarget = {
      ...definition,
      target_path: path.join(
        'evals',
        'targets',
        definition.target_id,
        target.source.path,
      ),
      origin: target.start.origin,
    };
    state.repository = await prepareTarget(
      definitionWithTarget,
      state.temporaryRoot,
      tooling,
      signal,
    );
    state.plugin_state_before = normalizedPluginState(
      await pluginList(state.repository, signal),
    );
    state.marketplace_state_before = normalizedMarketplaceState(
      await marketplaceList(state.repository, signal),
    );
    state.marketplace_added = true;
    await command(
      executable('claude'),
      ['plugin', 'marketplace', 'add', source.source, '--scope', 'local'],
      { cwd: state.repository, error: 'plugin-installation-failed', signal },
    );
    state.plugin_installed = true;
    await command(
      executable('claude'),
      ['plugin', 'install', source.plugin_id, '--scope', 'local'],
      { cwd: state.repository, error: 'plugin-installation-failed', signal },
    );
    const installed = findInstalledPlugin(
      await pluginList(state.repository, signal),
      source.plugin_id,
      state.repository,
      source.version,
    );
    result.installed_runtime_sha256 = installed.runtime_sha256;
    const compatibility = await runRuntimePreflight(
      installed.installPath,
      state.repository,
      tooling.playwright_cli,
      signal,
      'playwright.config.cjs',
    );
    result.playwright = compatibility.playwright.version;
    result.playwright_cli = compatibility.playwright_cli.version;

    if (options.setupBeforeAuthor != null)
      result.setup = await options.setupBeforeAuthor({
        definition,
        installed,
        repository: state.repository,
        resultDirectory,
        signal,
      });

    const runId = `tg-${randomBytes(12).toString('hex')}`;
    const runDirectory = path.join(
      state.repository,
      '.playwright-cli',
      'testgen',
      runId,
    );
    mkdirSync(runDirectory, { recursive: true });
    writeFileSync(
      path.join(runDirectory, 'command-policy.json'),
      JSON.stringify({
        approved_spec: definition.spec_path,
        allowed_origins: [target.start.origin],
        allowed_runner_options: [],
        allowed_state_paths: [],
        allowed_write_paths: [],
        format_version: 1,
        run_id: runId,
        trace_snapshot_option: compatibility.trace_snapshot_option,
      }),
    );
    result.run_id = runId;
    await verifyInstalledHook(
      installed.installPath,
      state.repository,
      path.join(state.temporaryRoot, 'hook-preflight-audit.jsonl'),
      signal,
      'playwright-test-author',
    );
    state.server = await startServer(
      state.repository,
      target.start.origin,
      signal,
    );
    await verifyBrowserReadiness(
      tooling,
      state.repository,
      target.start.origin,
      state.temporaryRoot,
      signal,
    );
    const approvedSpecFilter = exactPlaywrightFilter(
      path.join(state.repository, definition.spec_path),
    );
    const prompt = authorPrompt(definition, {
      run_id: runId,
      repository: state.repository,
      origin: target.start.origin,
      approved_spec_filter: approvedSpecFilter,
      setup_facts: result.setup?.facts,
    });
    result.setup_duration_ms = Date.now() - startedAt;
    const agent = await runBounded(
      executable('claude'),
      buildClaudeArguments(definition, prompt),
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
        timeout_ms: definition.agent.timeout_ms,
        verify_process_tree: true,
      },
    );
    writeFileSync(path.join(resultDirectory, 'agent.jsonl'), agent.output);
    const parsed = parseAgentStream(agent.output);
    result.execution_attempts = authorExecutionAttempts(agent.output);
    if (options.setupBeforeAuthor != null)
      result.profile_access_attempts = authorProfileAccessAttempts(
        agent.output,
      );
    result.candidate_executed = result.execution_attempts === 0 ? false : null;
    result.hook_events = parsed.hook_lifecycle.length;
    result.hook_errors = parsed.hook_lifecycle.filter(
      (hook) => hook.outcome === 'error',
    ).length;
    result.model = parsed.runtime.model ?? definition.agent.model;
    result.cost_usd = parsed.runtime.total_cost_usd ?? null;
    result.duration_ms = parsed.runtime.duration_ms ?? null;
    result.usage = parsed.runtime.usage ?? null;
    if (
      agent.tree_cleanup_failed ||
      agent.timed_out ||
      agent.cancelled ||
      agent.output_overflow ||
      agent.spawn_error != null ||
      agent.status !== 0 ||
      parsed.result_subtype !== 'success' ||
      result.execution_attempts !== 0 ||
      (options.setupBeforeAuthor != null &&
        result.profile_access_attempts !== 0) ||
      result.hook_errors !== 0
    )
      throw new Error('author-run-failed');

    const handoffPath = path.join(runDirectory, 'handoff.json');
    await validateArtifact(
      installed.installPath,
      state.repository,
      'handoff',
      runId,
      handoffPath,
      signal,
    );
    const handoff = readJson(handoffPath);
    if (
      handoff.spec_path !== definition.spec_path ||
      handoff.scenario_ref !== definition.scenario_ref ||
      handoff.criteria.length !== definition.criteria.length ||
      definition.criteria.some(
        (criterion) =>
          !handoff.criteria.some((actual) => actual.id === criterion.id),
      )
    )
      throw new Error('handoff-mismatch');
    const candidatePath = path.join(state.repository, definition.spec_path);
    if (!existsSync(candidatePath)) throw new Error('candidate-missing');
    copyFileSync(
      candidatePath,
      path.join(resultDirectory, path.basename(definition.spec_path)),
    );
    copyFileSync(handoffPath, path.join(resultDirectory, 'handoff.json'));
    result.candidate_sha256 = hashFile(candidatePath);
    result.status = 'checkpoint';
  } catch (error) {
    result.error = evaluationFailure(error).reason ?? error.message;
  } finally {
    cleanup = await cleanupEvaluation(state);
    result.cleanup = cleanup;
    result.elapsed_ms = Date.now() - startedAt;
    if (cleanup.status !== 'passed') result.status = 'incomplete';
    writeFileSync(
      path.join(resultDirectory, 'result.json'),
      `${JSON.stringify(result, null, 2)}\n`,
    );
  }
  return result;
}

async function main() {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  try {
    const result = await collectCandidate(
      readJson(casePath),
      controller.signal,
    );
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (result.status !== 'checkpoint') process.exitCode = 1;
  } finally {
    process.off('SIGINT', cancel);
    process.off('SIGTERM', cancel);
  }
}

if (require.main === module) void main();

module.exports = {
  authorExecutionAttempts,
  authorProfileAccessAttempts,
  authorPrompt,
  collectCandidate,
};

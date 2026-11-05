const { spawnSync } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  writeFileSync,
} = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { parseArgs } = require('node:util');
const { verifyBrowserReadiness } = require('../run-generation-eval.cjs');
const { evaluationFailure } = require('./agent-evidence.cjs');
const { command, executable, fail } = require('./process.cjs');
const {
  cleanupEvaluation,
  findInstalledPlugin,
  hashFiles,
  marketplaceList,
  normalizedMarketplaceState,
  normalizedPluginState,
  pluginList,
  preflight,
  preparePluginSource,
  prepareTarget,
  runRuntimePreflight,
  startServer,
  verifyInstalledHook,
} = require('./runtime.cjs');

const root = path.resolve(__dirname, '../..');

function validateResultsRoot(destination) {
  let ancestor = path.resolve(destination);
  const suffix = [];
  while (!existsSync(ancestor)) {
    suffix.unshift(path.basename(ancestor));
    ancestor = path.dirname(ancestor);
  }
  const resolved = path.join(realpathSync(ancestor), ...suffix);
  const git = spawnSync(executable('git'), ['rev-parse', '--show-toplevel'], {
    cwd: realpathSync(ancestor),
    encoding: 'utf8',
    windowsHide: true,
    timeout: 10_000,
  });
  if (git.error != null) fail('results-directory-invalid');
  if (git.status === 0) {
    const gitRoot = realpathSync(git.stdout.trim());
    if (gitRoot !== realpathSync(root)) fail('results-directory-invalid');
    const ignored = spawnSync(
      executable('git'),
      [
        'check-ignore',
        '--quiet',
        '--',
        path.join(resolved, 'trial-result.json'),
      ],
      { cwd: root, windowsHide: true, timeout: 10_000 },
    );
    if (ignored.status !== 0) fail('results-directory-must-be-ignored');
    const tracked = spawnSync(executable('git'), ['ls-files', '--', resolved], {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 10_000,
    });
    if (tracked.status !== 0 || tracked.stdout.trim() !== '')
      fail('results-directory-invalid');
  } else if (git.status !== 128) fail('results-directory-invalid');
  return resolved;
}

function parseCaseOptions(args, definition) {
  const { values, tokens } = parseArgs({
    args,
    options: {
      model: { type: 'string' },
      'max-budget-usd': { type: 'string' },
      'results-dir': { type: 'string' },
    },
    strict: true,
    allowPositionals: false,
    tokens: true,
  });
  const optionNames = tokens
    .filter((token) => token.kind === 'option')
    .map((token) => token.name);
  if (new Set(optionNames).size !== optionNames.length)
    fail('case-options-invalid');
  const budget =
    values['max-budget-usd'] == null
      ? definition.agent.max_budget_usd
      : Number(values['max-budget-usd']);
  const model = values.model ?? definition.agent.model;
  if (
    !Number.isFinite(budget) ||
    budget <= 0 ||
    budget > definition.agent.max_budget_usd ||
    budget > 2 ||
    typeof model !== 'string' ||
    !/^claude-[a-z0-9][a-z0-9.-]{0,99}$/u.test(model)
  )
    fail('case-options-invalid');
  return {
    definition: {
      ...definition,
      agent: { ...definition.agent, model, max_budget_usd: budget },
    },
    resultsRoot: validateResultsRoot(
      values['results-dir'] ??
        path.join(root, 'evals/capabilities/results', definition.case_id),
    ),
  };
}

async function collectInstalledCase(definition, signal, options) {
  const startedAt = Date.now();
  const resultDirectory = path.join(
    validateResultsRoot(options.resultsRoot),
    `trial-${randomBytes(8).toString('hex')}`,
  );
  mkdirSync(resultDirectory, { recursive: true });
  const state = {
    repository: null,
    server: null,
    temporaryRoot: null,
    temporaryPrefix: 'testgen-capability-evaluation-',
    plugin_installed: false,
    marketplace_added: false,
    plugin_state_before: null,
    marketplace_state_before: null,
  };
  const result = {
    schema_version: 'installed-capability-result.v1',
    case_id: definition.case_id,
    trial_id: path.basename(resultDirectory),
    status: 'failed',
    planned_trials: 1,
    retries: 0,
    agent_limits: definition.agent,
    evidence_level: definition.evidence_level,
  };
  try {
    if (
      definition.planned_trials !== 1 ||
      definition.retries !== 0 ||
      !Number.isInteger(definition.agent.timeout_ms) ||
      definition.agent.timeout_ms <= 0 ||
      definition.agent.timeout_ms > 600_000 ||
      !Number.isFinite(definition.agent.max_budget_usd) ||
      definition.agent.max_budget_usd <= 0 ||
      definition.agent.max_budget_usd > 2
    )
      fail('case-invalid');
    result.dataset_sha256 =
      options.datasetDigest?.() ?? hashFiles(root, options.datasetPaths);
    result.testgen_revision = await command(
      executable('git'),
      ['rev-parse', '--verify', 'HEAD'],
      { cwd: root, error: 'testgen-revision-unavailable', signal },
    );
    if (
      (await command(executable('git'), ['status', '--porcelain'], {
        cwd: root,
        error: 'testgen-state-unavailable',
        signal,
      })) !== ''
    )
      fail('testgen-repository-not-clean');
    const tooling = await preflight(signal, result);
    result.node = process.version;
    result.platform = process.platform;
    state.temporaryRoot = mkdtempSync(
      path.join(tmpdir(), state.temporaryPrefix),
    );
    const source = await preparePluginSource(
      root,
      state.temporaryRoot,
      result.testgen_revision,
      signal,
    );
    state.marketplace_name = source.marketplace_name;
    state.plugin_id = source.plugin_id;
    state.repository = await prepareTarget(
      definition,
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
    result.source_runtime_sha256 = installed.runtime_sha256;
    const compatibility = await runRuntimePreflight(
      installed.installPath,
      state.repository,
      tooling.playwright_cli,
      signal,
      'playwright.config.cjs',
    );
    result.playwright = compatibility.playwright.version;
    result.playwright_cli = compatibility.playwright_cli.version;
    await verifyInstalledHook(
      installed.installPath,
      state.repository,
      path.join(state.temporaryRoot, 'hook-preflight-audit.jsonl'),
      signal,
      options.role,
    );
    result.installed_hook_sha256 = installed.hook_sha256;
    state.server = await startServer(
      state.repository,
      definition.origin,
      signal,
    );
    await verifyBrowserReadiness(
      tooling,
      state.repository,
      definition.origin,
      state.temporaryRoot,
      signal,
    );
    result.setup_duration_ms = Date.now() - startedAt;
    const agentStartedAt = Date.now();
    Object.assign(
      result,
      await options.run({
        state,
        installed,
        tooling,
        compatibility,
        result,
        resultDirectory,
        signal,
        startedAt: agentStartedAt,
        deadline: agentStartedAt + definition.agent.timeout_ms,
      }),
    );
  } catch (error) {
    Object.assign(result, evaluationFailure(error));
  } finally {
    result.cleanup = await cleanupEvaluation(state);
    if (result.cleanup.status !== 'passed') result.status = 'failed';
    result.elapsed_ms = Date.now() - startedAt;
    writeFileSync(
      path.join(resultDirectory, 'result.json'),
      `${JSON.stringify(result, null, 2)}\n`,
    );
  }
  return result;
}

module.exports = { collectInstalledCase, parseCaseOptions };

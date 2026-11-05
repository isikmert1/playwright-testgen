const { fork } = require('node:child_process');
const { createHash, randomBytes } = require('node:crypto');
const {
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { exactPlaywrightFilter } = require('../../hooks/run-policy.cjs');
const { currentHead } = require('../repository-snapshot.cjs');
const { versionAtLeast } = require('../runtime-preflight.cjs');
const {
  EvaluationError,
  LIFECYCLE_COMMAND_TIMEOUT_MS,
  SAFE_ERROR_CODE,
  command,
  executable,
  fail,
  runBounded,
  stopProcessTree,
} = require('../process.cjs');

const repositoryRoot = path.resolve(__dirname, '../..');

const PLUGIN_NAME = 'playwright-testgen';

const PLUGIN_RUNTIME_PATHS = [
  '.claude-plugin/plugin.json',
  'agents',
  'commands',
  'hooks',
  'schemas',
  'scripts',
  'skills',
  'vendor',
];

const FORBIDDEN_PLUGIN_PATHS = [
  'evals',
  'tests',
  'benchmarks',
  'scripts/eval',
  'scripts/run-healer-defect-refusal.cjs',
  'scripts/run-generation-eval.cjs',
  'scripts/run-generation-candidate.cjs',
  'scripts/run-selector-repair-eval.cjs',
  'scripts/run-setup-eval.cjs',
  'scripts/run-discovery-eval.cjs',
  'scripts/run-checkpoint-eval.cjs',
  'scripts/score-healer-defect-refusal.cjs',
  'scripts/score-outcomes.cjs',
  'scripts/score-selector-repair.cjs',
];

function readJson(filename, code) {
  try {
    return JSON.parse(readFileSync(filename, 'utf8'));
  } catch {
    fail(code);
  }
}

function readJsonOutput(output, code) {
  try {
    return JSON.parse(output);
  } catch {
    fail(code);
  }
}

function hashFile(filename) {
  return createHash('sha256').update(readFileSync(filename)).digest('hex');
}

function hashFiles(repository, relativePaths) {
  const hash = createHash('sha256');
  for (const relative of [...relativePaths].sort()) {
    hash.update(relative);
    hash.update('\0');
    hash.update(readFileSync(path.join(repository, relative)));
    hash.update('\0');
  }
  return hash.digest('hex');
}

function pluginRuntimeFiles(repository) {
  const files = [];
  function add(relative) {
    if (FORBIDDEN_PLUGIN_PATHS.includes(relative)) return;
    const absolute = path.join(repository, relative);
    const entry = lstatSync(absolute);
    if (entry.isDirectory()) {
      for (const name of readdirSync(absolute))
        add(path.posix.join(relative, name));
    } else if (entry.isFile()) files.push(relative);
    else fail('installed-revision-unverified');
  }
  for (const relative of PLUGIN_RUNTIME_PATHS) add(relative);
  return files;
}

function normalizedPluginState(value) {
  return (Array.isArray(value) ? value : [])
    .map((plugin) => ({
      enabled: plugin.enabled,
      id: plugin.id,
      installPath: plugin.installPath,
      projectPath: plugin.projectPath ?? null,
      scope: plugin.scope,
      version: plugin.version,
    }))
    .sort((left, right) =>
      `${left.id}:${left.scope}:${left.projectPath}`.localeCompare(
        `${right.id}:${right.scope}:${right.projectPath}`,
      ),
    );
}

async function pluginList(repository, signal) {
  return readJsonOutput(
    await command(executable('claude'), ['plugin', 'list', '--json'], {
      cwd: repository,
      error: 'plugin-state-unavailable',
      signal,
    }),
    'plugin-state-unavailable',
  );
}

async function marketplaceList(repository, signal) {
  return readJsonOutput(
    await command(
      executable('claude'),
      ['plugin', 'marketplace', 'list', '--json'],
      {
        cwd: repository,
        error: 'marketplace-state-unavailable',
        signal,
      },
    ),
    'marketplace-state-unavailable',
  );
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function stateDifferenceCategories(before, after, ownedName, kind) {
  const name = (entry) => (kind === 'plugin' ? entry.id : entry.name);
  const key = (entry) =>
    kind === 'plugin'
      ? JSON.stringify([entry.id, entry.scope, entry.projectPath ?? null])
      : entry.name;
  const previous = new Map(before.map((entry) => [key(entry), entry]));
  const current = new Map(after.map((entry) => [key(entry), entry]));
  const categories = new Set();

  for (const identity of new Set([...previous.keys(), ...current.keys()])) {
    const left = previous.get(identity);
    const right = current.get(identity);
    if (left != null && right != null && sameJson(left, right)) continue;
    const owner = name(right ?? left) === ownedName ? 'evaluation' : 'other';
    let change = 'changed';
    if (left == null) change = 'added';
    else if (right == null) change = 'removed';
    categories.add(`${owner}-${kind}-${change}`);
  }
  return [...categories].sort();
}

function assertPluginBlind(source) {
  if (
    FORBIDDEN_PLUGIN_PATHS.some((relative) =>
      existsSync(path.join(source, relative)),
    )
  )
    fail('installed-evaluation-material');
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
  const invoke = (action, args = [], operationSignal = signal) =>
    runBounded(
      process.execPath,
      [tooling.playwright_cli, `-s=${session}`, action, ...args],
      {
        cwd: directory,
        env: { ...process.env, PWTEST_CLI_GLOBAL_CONFIG: '.' },
        signal: operationSignal,
        timeout_ms: 30_000,
        verify_process_tree: false,
      },
    );
  let failure = null;
  try {
    const launch = await invoke('open', [origin]);
    if (
      launch.status !== 0 ||
      launch.timed_out ||
      launch.cancelled ||
      launch.spawn_error != null
    )
      throw new Error('cli-browser-unavailable');
  } catch (error) {
    failure = error;
  }
  const close = await invoke('close', [], null);
  if (
    close.status !== 0 ||
    close.timed_out ||
    close.cancelled ||
    close.spawn_error != null
  )
    failure = new EvaluationError(
      failure?.code ?? failure?.message ?? 'cli-browser-cleanup-failed',
      failure == null ? [] : ['cli-browser-cleanup-failed'],
    );
  if (failure != null) throw failure;
}

function allTests(suites) {
  return suites.flatMap((suite) => [
    ...(suite.specs ?? []).flatMap((spec) => spec.tests ?? []),
    ...allTests(suite.suites ?? []),
  ]);
}

function scorePlaywrightReport(report) {
  if (
    !Array.isArray(report?.errors) ||
    report.errors.length !== 0 ||
    !Array.isArray(report.suites)
  )
    return 'error';
  const tests = allTests(report.suites);
  if (tests.length !== 1 || tests[0].results?.length !== 1) return 'error';
  const status = tests[0].results[0].status;
  const stats = report.stats ?? {};
  if (
    status === 'passed' &&
    tests[0].status === 'expected' &&
    stats.expected === 1 &&
    stats.unexpected === 0 &&
    stats.skipped === 0 &&
    stats.flaky === 0
  )
    return 'pass';
  if (
    ['failed', 'timedOut'].includes(status) &&
    tests[0].status === 'unexpected' &&
    stats.expected === 0 &&
    stats.unexpected === 1 &&
    stats.skipped === 0 &&
    stats.flaky === 0
  )
    return 'fail';
  return 'error';
}

async function runApprovedSpec(
  repository,
  playwrightCli,
  origin,
  specPath,
  reportPath,
  signal,
) {
  const run = await runBounded(
    process.execPath,
    [
      playwrightCli,
      'test',
      exactPlaywrightFilter(path.resolve(repository, specPath)),
      '--reporter=json',
      '--workers=1',
      '--retries=0',
    ],
    {
      cwd: repository,
      env: {
        ...process.env,
        TESTGEN_BASE_URL: origin,
        PLAYWRIGHT_JSON_OUTPUT_FILE: reportPath,
      },
      signal,
      timeout_ms: 120_000,
      verify_process_tree: true,
    },
  );
  if (
    run.tree_cleanup_failed ||
    run.timed_out ||
    run.cancelled ||
    run.output_overflow ||
    run.spawn_error != null ||
    !existsSync(reportPath)
  )
    throw new Error('playwright-run-failed');
  const report = readJson(reportPath, 'playwright-report-invalid');
  const outcome = scorePlaywrightReport(report);
  if (
    outcome === 'error' ||
    (outcome === 'pass' && run.status !== 0) ||
    (outcome === 'fail' && run.status === 0)
  )
    throw new Error('playwright-report-invalid');
  return { outcome, report };
}

async function evaluatedRevision(signal) {
  const revision = await command(
    executable('git'),
    ['rev-parse', '--verify', 'HEAD'],
    {
      cwd: repositoryRoot,
      error: 'testgen-revision-unavailable',
      signal,
    },
  );
  if (!/^[a-f0-9]{40}$/u.test(revision)) fail('testgen-revision-unavailable');
  if (
    await command(executable('git'), ['status', '--porcelain'], {
      cwd: repositoryRoot,
      error: 'testgen-state-unavailable',
      signal,
    })
  )
    fail('testgen-repository-not-clean');
  return revision;
}

async function preparePluginSource(
  sourceRoot,
  temporaryRoot,
  revision,
  signal,
) {
  const source = path.join(temporaryRoot, 'plugin-source');
  await command(
    executable('git'),
    [
      'clone',
      '--quiet',
      '--no-hardlinks',
      '--no-checkout',
      '--',
      sourceRoot,
      source,
    ],
    { cwd: temporaryRoot, error: 'plugin-source-unavailable', signal },
  );
  await command(
    executable('git'),
    ['checkout', '--quiet', '--detach', revision],
    {
      cwd: source,
      error: 'plugin-source-unavailable',
      signal,
    },
  );
  if (currentHead(source) !== revision) fail('plugin-source-unavailable');
  for (const relative of FORBIDDEN_PLUGIN_PATHS)
    rmSync(path.join(source, relative), { force: true, recursive: true });
  const marketplacePath = path.join(
    source,
    '.claude-plugin',
    'marketplace.json',
  );
  const marketplace = readJson(marketplacePath, 'plugin-source-unavailable');
  const marketplaceName = `${PLUGIN_NAME}-eval-${randomBytes(6).toString('hex')}`;
  writeFileSync(
    marketplacePath,
    `${JSON.stringify({ ...marketplace, name: marketplaceName }, null, 2)}\n`,
  );
  assertPluginBlind(source);
  const version = readJson(
    path.join(source, '.claude-plugin', 'plugin.json'),
    'plugin-source-unavailable',
  )?.version;
  if (typeof version !== 'string' || version.length === 0)
    fail('plugin-source-unavailable');
  return {
    marketplace_name: marketplaceName,
    plugin_id: `${PLUGIN_NAME}@${marketplaceName}`,
    source,
    version,
  };
}

function normalizedMarketplaceState(value) {
  return (Array.isArray(value) ? value : [])
    .map((marketplace) => ({
      installLocation: marketplace.installLocation ?? null,
      name: marketplace.name,
      path: marketplace.path ?? null,
      repo: marketplace.repo ?? null,
      source: marketplace.source ?? null,
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

async function preflight(signal, runtime) {
  if (!versionAtLeast(process.versions.node, '22.13.0'))
    fail('node-version-unsupported');
  const npmCli = process.env.npm_execpath;
  if (typeof npmCli !== 'string' || !existsSync(npmCli))
    fail('npm-unavailable');
  const claudeCode = await command(executable('claude'), ['--version'], {
    error: 'claude-code-unavailable',
    signal,
  });
  runtime.claude_code = claudeCode;
  await command(executable('claude'), ['auth', 'status'], {
    error: 'authentication-unavailable',
    signal,
  });
  const globalModules = await command(
    process.execPath,
    [npmCli, 'root', '--global'],
    {
      error: 'npm-unavailable',
      signal,
    },
  );
  const cliPackage = readJson(
    path.join(globalModules, '@playwright', 'cli', 'package.json'),
    'playwright-cli-unavailable',
  );
  const cliBin =
    typeof cliPackage.bin === 'string'
      ? cliPackage.bin
      : cliPackage.bin?.['playwright-cli'];
  if (typeof cliBin !== 'string') fail('playwright-cli-unavailable');
  const playwrightCli = path.resolve(
    globalModules,
    '@playwright',
    'cli',
    cliBin,
  );
  const npmVersion = await command(process.execPath, [npmCli, '--version'], {
    error: 'npm-unavailable',
    signal,
  });
  runtime.npm = npmVersion;
  return {
    npm_cli: npmCli,
    playwright_cli: playwrightCli,
  };
}

async function prepareTarget(definition, temporaryRoot, tooling, signal) {
  const source = realpathSync(
    path.resolve(repositoryRoot, definition.target_path),
  );
  const target = path.join(temporaryRoot, 'repository');
  cpSync(source, target, {
    filter: (entry) =>
      !['.git', '.playwright-cli', '.testgen', 'node_modules'].includes(
        path.basename(entry),
      ),
    recursive: true,
  });
  mkdirSync(path.join(target, 'tests'), { recursive: true });
  if (definition.spec_source != null)
    copyFileSync(
      path.resolve(repositoryRoot, definition.spec_source),
      path.join(target, definition.spec_path),
    );

  await command(process.execPath, [tooling.npm_cli, 'ci'], {
    cwd: target,
    error: 'target-dependencies-unavailable',
    signal,
  });
  const packageJson = readJson(
    path.join(target, 'node_modules', '@playwright', 'test', 'package.json'),
    'playwright-unavailable',
  );
  const playwrightCli = path.resolve(
    target,
    'node_modules',
    '@playwright',
    'test',
    typeof packageJson.bin === 'string'
      ? packageJson.bin
      : (packageJson.bin?.playwright ?? ''),
  );
  await command(process.execPath, [playwrightCli, 'install', 'chromium'], {
    cwd: target,
    error: 'runner-browser-unavailable',
    signal,
  });
  await command(
    process.execPath,
    [tooling.playwright_cli, 'install', '--skills'],
    {
      cwd: target,
      error: 'playwright-cli-skill-unavailable',
      signal,
    },
  );
  await command(executable('git'), ['init', '--quiet'], {
    cwd: target,
    error: 'target-git-unavailable',
    signal,
  });
  await command(
    executable('git'),
    ['config', 'user.name', 'Playwright Testgen'],
    {
      cwd: target,
      error: 'target-git-unavailable',
      signal,
    },
  );
  await command(
    executable('git'),
    ['config', 'user.email', 'testgen-eval@example.invalid'],
    { cwd: target, error: 'target-git-unavailable', signal },
  );
  await command(executable('git'), ['add', '--all'], {
    cwd: target,
    error: 'target-git-unavailable',
    signal,
  });
  await command(
    executable('git'),
    ['commit', '--quiet', '-m', 'test: prepare healer evaluation target'],
    { cwd: target, error: 'target-git-unavailable', signal },
  );
  return target;
}

async function validateArtifact(
  installPath,
  repository,
  type,
  runId,
  filename,
  signal,
) {
  const result = await runBounded(
    process.execPath,
    [
      path.join(installPath, 'scripts', 'validate-testgen-artifact.cjs'),
      '--repo',
      repository,
      '--type',
      type,
      '--run-id',
      runId,
      filename,
    ],
    {
      capture_stderr: true,
      cwd: repository,
      env: process.env,
      signal,
      timeout_ms: LIFECYCLE_COMMAND_TIMEOUT_MS,
      verify_process_tree: true,
    },
  );
  if (result.tree_cleanup_failed)
    fail('process-tree-cleanup-failed', [result.tree_cleanup_reason]);
  if (result.cancelled) fail('evaluation-cancelled');
  if (result.timed_out) fail('lifecycle-command-timeout');
  if (result.status !== 0) {
    let details = [];
    try {
      const report = JSON.parse(result.error_output.trim());
      if (
        report.valid === false &&
        report.type === type &&
        Array.isArray(report.errors)
      )
        details = report.errors;
    } catch {
      details = [];
    }
    throw new EvaluationError(`${type}-invalid`, details);
  }
  if (result.output_overflow || result.spawn_error != null)
    fail(`${type}-invalid`);
  const report = readJsonOutput(result.output.trim(), `${type}-invalid`);
  if (report.valid !== true) fail(`${type}-invalid`);
}

function startServer(repository, origin, signal) {
  if (signal?.aborted)
    return Promise.reject(new EvaluationError('evaluation-cancelled'));
  const expected = new URL(origin);
  const child = fork(path.join(repository, 'server.cjs'), [], {
    cwd: repository,
    env: { ...process.env, PORT: expected.port },
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    windowsHide: true,
  });
  return new Promise((resolve, reject) => {
    let settled = false;
    let cancelling = false;
    const timer = setTimeout(async () => {
      const stopped = await stopProcessTree(child);
      if (!stopped) {
        finish(new EvaluationError('process-tree-cleanup-failed'));
        return;
      }
      finish(new EvaluationError('target-server-unavailable'));
    }, 5000);
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeAllListeners('error');
      child.removeAllListeners('exit');
      child.removeAllListeners('message');
      signal?.removeEventListener('abort', cancel);
      if (error != null) reject(error);
      else resolve(child);
    };
    const cancel = async () => {
      if (cancelling) return;
      cancelling = true;
      const stopped = await stopProcessTree(child);
      finish(
        new EvaluationError(
          stopped ? 'evaluation-cancelled' : 'process-tree-cleanup-failed',
        ),
      );
    };
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) void cancel();
    child.once('error', () =>
      finish(new EvaluationError('target-server-unavailable')),
    );
    child.once('exit', () => {
      void stopProcessTree(child).then((stopped) =>
        finish(
          new EvaluationError(
            stopped
              ? 'target-server-unavailable'
              : 'process-tree-cleanup-failed',
          ),
        ),
      );
    });
    child.once('message', (message) => {
      if (message?.type !== 'ready' || message.origin !== origin) {
        void stopProcessTree(child).then((stopped) =>
          finish(
            new EvaluationError(
              stopped
                ? 'target-server-unavailable'
                : 'process-tree-cleanup-failed',
            ),
          ),
        );
        return;
      }
      finish(null);
    });
  });
}

function sameProjectPath(left, right) {
  const first = path.resolve(left);
  const second = path.resolve(right);
  return process.platform === 'win32'
    ? first.toLowerCase() === second.toLowerCase()
    : first === second;
}

function matchesInstalledPlugin(plugin, pluginId, repository, version) {
  return (
    plugin?.id === pluginId &&
    plugin.scope === 'local' &&
    plugin.enabled === true &&
    plugin.version === version &&
    typeof plugin.installPath === 'string' &&
    (plugin.projectPath == null ||
      (typeof plugin.projectPath === 'string' &&
        sameProjectPath(plugin.projectPath, repository)))
  );
}

function findInstalledPlugin(plugins, pluginId, repository, version) {
  const expectedProject = realpathSync(repository);
  const entry = plugins.find((plugin) =>
    matchesInstalledPlugin(plugin, pluginId, expectedProject, version),
  );
  if (entry == null || typeof entry.installPath !== 'string')
    fail('installed-revision-unverified');
  let installPath;
  let sourceDigest;
  let installedDigest;
  try {
    installPath = realpathSync(entry.installPath);
  } catch {
    fail('installed-revision-unverified');
  }
  assertPluginBlind(installPath);
  try {
    sourceDigest = hashFiles(
      repositoryRoot,
      pluginRuntimeFiles(repositoryRoot),
    );
    installedDigest = hashFiles(installPath, pluginRuntimeFiles(installPath));
  } catch {
    fail('installed-revision-unverified');
  }
  if (sourceDigest !== installedDigest) fail('installed-revision-unverified');
  return {
    installPath,
    hook_sha256: hashFile(path.join(installPath, 'hooks', 'validate-bash.cjs')),
    runtime_sha256: installedDigest,
  };
}

function installedHookPreflightTimeout(timeoutSeconds) {
  return Math.max(1, Math.floor(timeoutSeconds * 800));
}

async function verifyInstalledHook(
  installPath,
  repository,
  auditPath,
  signal,
  agentType = 'playwright-test-healer',
) {
  const toolUseId = `hook-preflight-${randomBytes(8).toString('hex')}`;
  const payload = {
    agent_type: agentType,
    cwd: repository,
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'node --version' },
    tool_use_id: toolUseId,
  };
  const hookPath = path.join(installPath, 'hooks', 'validate-bash.cjs');
  const timeoutSeconds = readJson(
    path.join(installPath, 'hooks', 'hooks.json'),
    'installed-hook-unavailable',
  )?.hooks?.PreToolUse?.[0]?.hooks?.[0]?.timeout;
  if (
    typeof timeoutSeconds !== 'number' ||
    !Number.isFinite(timeoutSeconds) ||
    timeoutSeconds <= 0
  )
    fail('installed-hook-unavailable');
  const output = await command(process.execPath, [hookPath], {
    capture_stderr: true,
    cwd: repository,
    env: {
      ...process.env,
      CLAUDE_PLUGIN_ROOT: installPath,
      PLAYWRIGHT_TESTGEN_HOOK_AUDIT_PATH: auditPath,
    },
    input: JSON.stringify(payload),
    signal,
    timeout_ms: installedHookPreflightTimeout(timeoutSeconds),
    error: 'installed-hook-unavailable',
  });
  const response = readJsonOutput(output, 'installed-hook-unavailable');
  if (response?.hookSpecificOutput?.permissionDecision !== 'allow')
    fail('installed-hook-unavailable');
  const record = readHookAudit(auditPath).find(
    (entry) => entry.tool_use_id === toolUseId,
  );
  if (
    record?.agent_type !==
      (agentType === 'playwright-test-healer' ? agentType : 'other') ||
    record.tool_name !== payload.tool_name ||
    record.decision !== 'allow' ||
    record.operation !== 'other' ||
    record.hook_sha256 !== hashFile(hookPath)
  )
    fail('hook-governance-unverified');
  return record;
}

function readHookAudit(filename) {
  if (!existsSync(filename)) return [];
  if (readFileSync(filename).length > 1024 * 1024)
    fail('hook-governance-unverified');
  return readFileSync(filename, 'utf8')
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => readJsonOutput(line, 'hook-governance-unverified'));
}

async function runRuntimePreflight(
  installPath,
  repository,
  playwrightCli,
  signal,
  configPath = null,
) {
  const result = await runBounded(
    process.execPath,
    [
      path.join(installPath, 'scripts', 'runtime-preflight.cjs'),
      '--repo',
      repository,
      ...(configPath == null ? ['--configless'] : ['--config', configPath]),
      '--playwright-cli',
      playwrightCli,
    ],
    {
      capture_stderr: true,
      cwd: repository,
      env: process.env,
      signal,
      timeout_ms: LIFECYCLE_COMMAND_TIMEOUT_MS,
      verify_process_tree: true,
    },
  );
  if (result.tree_cleanup_failed)
    fail('process-tree-cleanup-failed', [result.tree_cleanup_reason]);
  if (result.cancelled) fail('evaluation-cancelled');
  if (result.timed_out) fail('runtime-preflight-timeout');
  if (result.output_overflow || result.spawn_error != null)
    fail('runtime-preflight-failed');
  const report = readJsonOutput(
    result.output.trim(),
    'runtime-preflight-invalid',
  );
  if (
    result.status !== 0 ||
    report?.ok !== true ||
    typeof report.playwright?.version !== 'string' ||
    typeof report.playwright_cli?.version !== 'string' ||
    ![null, '--name', '--phase'].includes(report.trace_snapshot_option)
  ) {
    if (SAFE_ERROR_CODE.test(report?.error ?? '')) fail(report.error);
    fail('runtime-preflight-invalid');
  }
  return report;
}

async function installPlugin(state, source, tooling, signal) {
  state.marketplace_name = source.marketplace_name;
  state.plugin_id = source.plugin_id;
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
    {
      cwd: state.repository,
      error: 'plugin-installation-failed',
      signal,
    },
  );
  state.plugin_installed = true;
  await command(
    executable('claude'),
    ['plugin', 'install', source.plugin_id, '--scope', 'local'],
    {
      cwd: state.repository,
      error: 'plugin-installation-failed',
      signal,
    },
  );
  const installed = findInstalledPlugin(
    await pluginList(state.repository, signal),
    source.plugin_id,
    state.repository,
    source.version,
  );
  const compatibility = await runRuntimePreflight(
    installed.installPath,
    state.repository,
    tooling.playwright_cli,
    signal,
    'playwright.config.cjs',
  );
  return { installed, compatibility };
}

async function cleanupEvaluation(state) {
  const failures = [];
  const details = [];
  if (state.server != null && !(await stopProcessTree(state.server)))
    failures.push('server-cleanup-failed');
  if (
    state.repository != null &&
    state.plugin_installed &&
    state.plugin_id != null
  ) {
    try {
      await command(
        executable('claude'),
        ['plugin', 'uninstall', state.plugin_id, '--scope', 'local'],
        { cwd: state.repository, error: 'plugin-uninstall-failed' },
      );
    } catch (error) {
      failures.push(error.code ?? 'plugin-uninstall-failed');
    }
  }
  if (
    state.repository != null &&
    state.marketplace_added &&
    state.marketplace_name != null
  ) {
    try {
      await command(
        executable('claude'),
        [
          'plugin',
          'marketplace',
          'remove',
          state.marketplace_name,
          '--scope',
          'local',
        ],
        { cwd: state.repository, error: 'marketplace-cleanup-failed' },
      );
    } catch (error) {
      failures.push(error.code ?? 'marketplace-cleanup-failed');
    }
  }
  if (state.repository != null && state.plugin_state_before != null) {
    try {
      const pluginChanges = stateDifferenceCategories(
        state.plugin_state_before,
        normalizedPluginState(await pluginList(state.repository)),
        state.plugin_id,
        'plugin',
      );
      if (pluginChanges.length !== 0) {
        failures.push('plugin-state-changed');
        details.push(...pluginChanges);
      }
      const marketplaceChanges = stateDifferenceCategories(
        state.marketplace_state_before,
        normalizedMarketplaceState(await marketplaceList(state.repository)),
        state.marketplace_name,
        'marketplace',
      );
      if (marketplaceChanges.length !== 0) {
        failures.push('marketplace-state-changed');
        details.push(...marketplaceChanges);
      }
    } catch (error) {
      failures.push(error.code ?? 'plugin-state-unavailable');
    }
  }
  try {
    if (state.temporaryRoot != null) {
      const root = realpathSync(tmpdir());
      const candidate = path.resolve(state.temporaryRoot);
      const relative = path.relative(root, candidate);
      if (
        relative.startsWith('..') ||
        path.isAbsolute(relative) ||
        !path
          .basename(candidate)
          .startsWith(state.temporaryPrefix ?? 'testgen-healer-evaluation-')
      )
        failures.push('temporary-path-invalid');
      else rmSync(candidate, { force: true, recursive: true });
    }
  } catch {
    failures.push('temporary-cleanup-failed');
  }
  return failures.length === 0
    ? {
        status: 'passed',
        shared_cache: 'retained',
        temporary_target: 'removed',
      }
    : {
        status: 'failed',
        error: 'cleanup-failed',
        reason: failures.join(','),
        ...(details.length === 0
          ? {}
          : { details: [...new Set(details)].sort().slice(0, 12) }),
      };
}

module.exports = {
  assertPluginBlind,
  cleanupEvaluation,
  allTests,
  scorePlaywrightReport,
  runApprovedSpec,
  verifyBrowserReadiness,
  evaluatedRevision,
  installPlugin,
  findInstalledPlugin,
  hashFile,
  hashFiles,
  installedHookPreflightTimeout,
  matchesInstalledPlugin,
  preflight,
  preparePluginSource,
  prepareTarget,
  readHookAudit,
  readJson,
  readJsonOutput,
  sameJson,
  startServer,
  stateDifferenceCategories,
  validateArtifact,
  verifyInstalledHook,
};

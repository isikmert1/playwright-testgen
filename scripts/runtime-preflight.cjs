#!/usr/bin/env node

const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} = require('node:fs');
const { createRequire } = require('node:module');
const { tmpdir } = require('node:os');
const path = require('node:path');

const REQUIRED_CLI_COMMANDS = [
  'attach',
  'find',
  'generate-locator',
  'requests',
];
const REQUIRED_RUNNER_OPTIONS = [
  '--config',
  '--debug',
  '--list',
  '--output',
  '--project',
  '--repeat-each',
  '--retries',
];
const TRACE_OPTIONS = new Map([
  ['1.62.1|0.1.19', '--name'],
  ['1.63.0|0.1.19', '--phase'],
]);
const SAFE_ERROR = /^[a-z][a-z0-9-]{0,79}$/u;

class PreflightError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function fail(code) {
  throw new PreflightError(code);
}

function versionAtLeast(value, minimum) {
  const actual = value
    .match(/\d+\.\d+\.\d+/u)?.[0]
    ?.split('.')
    .map(Number);
  const required = minimum.split('.').map(Number);
  if (actual == null) return false;
  for (let index = 0; index < required.length; index += 1) {
    if (actual[index] > required[index]) return true;
    if (actual[index] < required[index]) return false;
  }
  return true;
}

function parseArguments(args) {
  const options = { playwrightCli: null, repository: null };
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (typeof value !== 'string') fail('preflight-arguments-invalid');
    if (name === '--repo' && options.repository == null)
      options.repository = value;
    else if (name === '--playwright-cli' && options.playwrightCli == null)
      options.playwrightCli = value;
    else fail('preflight-arguments-invalid');
  }
  if (options.repository == null) fail('preflight-arguments-invalid');
  return options;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: 'utf8',
    env: options.env,
    input: options.input,
    maxBuffer: 1024 * 1024,
    shell: process.platform === 'win32' && /\.(?:cmd|bat)$/iu.test(command),
    timeout: 5000,
    windowsHide: true,
  });
  if (result.error != null || result.status !== 0) fail(options.error);
  return `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
}

function runNodeScript(filename, args, options) {
  return run(process.execPath, [filename, ...args], options);
}

function readPackage(requireFromRepository, name, error) {
  let filename;
  try {
    filename = requireFromRepository.resolve(`${name}/package.json`);
  } catch {
    fail(error);
  }
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(filename, 'utf8'));
  } catch {
    fail(error);
  }
  if (typeof manifest.version !== 'string') fail(error);
  return { manifest, path: realpathSync(filename), version: manifest.version };
}

function isWithin(root, target) {
  const relative = path.relative(root, target);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== '..' &&
      !path.isAbsolute(relative))
  );
}

function sameFileContents(left, right) {
  const digest = (filename) =>
    createHash('sha256').update(readFileSync(filename)).digest('hex');
  return digest(left) === digest(right);
}

function packageExecutable(packageRecord, name, error) {
  const bin = packageRecord.manifest.bin;
  const relative = typeof bin === 'string' ? bin : bin?.[name];
  if (typeof relative !== 'string') fail(error);
  const executable = path.resolve(path.dirname(packageRecord.path), relative);
  if (!existsSync(executable)) fail(error);
  return realpathSync(executable);
}

function resolveGlobalCli(value) {
  if (value != null) {
    const candidate = path.resolve(value);
    if (!existsSync(candidate)) fail('playwright-cli-unavailable');
    return realpathSync(candidate);
  }
  const lookup = spawnSync(
    process.platform === 'win32' ? 'where.exe' : 'which',
    ['playwright-cli'],
    { encoding: 'utf8', timeout: 5000, windowsHide: true },
  );
  if (lookup.status !== 0) fail('playwright-cli-unavailable');
  const candidates = lookup.stdout.split(/\r?\n/u).filter(Boolean);
  const selected =
    process.platform === 'win32'
      ? (candidates.find((entry) => /\.(?:cmd|exe)$/iu.test(entry)) ??
        candidates[0])
      : candidates[0];
  if (selected == null || !existsSync(selected))
    fail('playwright-cli-unavailable');
  return realpathSync(selected);
}

function includesEvery(output, values) {
  return values.every((value) => {
    const escaped = value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    return new RegExp(`(?:^|\\s)${escaped}(?=$|[\\s=\\[<])`, 'mu').test(output);
  });
}

function inspectHook(pluginRoot, repository) {
  const output = runNodeScript(
    path.join(pluginRoot, 'hooks', 'validate-bash.cjs'),
    [],
    {
      cwd: repository,
      env: { ...process.env, PLAYWRIGHT_TESTGEN_HOOK_AUDIT_PATH: '' },
      error: 'hook-dependency-unavailable',
      input: JSON.stringify({
        agent_type: 'playwright-test-healer',
        cwd: repository,
        hook_event_name: 'PreToolUse',
        tool_input: { command: 'node --version' },
        tool_name: 'Bash',
      }),
    },
  );
  let result;
  try {
    result = JSON.parse(output);
  } catch {
    fail('hook-dependency-unavailable');
  }
  if (result?.hookSpecificOutput?.permissionDecision !== 'allow')
    fail('hook-dependency-unavailable');
}

function runtimePreflight(options) {
  if (!versionAtLeast(process.versions.node, '22.13.0'))
    fail('node-version-unsupported');
  const repository = realpathSync(path.resolve(options.repository));
  const manifest = path.join(repository, 'package.json');
  if (!existsSync(manifest)) fail('package-json-unavailable');
  const requireFromRepository = createRequire(manifest);
  const playwright = readPackage(
    requireFromRepository,
    'playwright',
    'playwright-unavailable',
  );
  if (!isWithin(repository, playwright.path)) fail('playwright-unavailable');
  const playwrightTest = readPackage(
    requireFromRepository,
    '@playwright/test',
    'playwright-test-unavailable',
  );
  if (!isWithin(repository, playwrightTest.path))
    fail('playwright-test-unavailable');
  if (playwright.version !== playwrightTest.version)
    fail('playwright-version-mismatch');

  const gitHead = run('git', ['rev-parse', '--verify', 'HEAD'], {
    cwd: repository,
    error: 'git-head-unavailable',
  });
  if (!/^[a-f0-9]{40}$/u.test(gitHead)) fail('git-head-unavailable');

  const runner = packageExecutable(
    playwright,
    'playwright',
    'playwright-runner-unavailable',
  );
  const runnerHelp = runNodeScript(runner, ['test', '--help'], {
    cwd: repository,
    error: 'playwright-runner-contract-mismatch',
  });
  if (!includesEvery(runnerHelp, REQUIRED_RUNNER_OPTIONS))
    fail('playwright-runner-contract-mismatch');

  const cliAnchor = resolveGlobalCli(options.playwrightCli);
  const cliPackage = readPackage(
    createRequire(cliAnchor),
    '@playwright/cli',
    'playwright-cli-installation-mismatch',
  );
  const cli = packageExecutable(
    cliPackage,
    'playwright-cli',
    'playwright-cli-installation-mismatch',
  );
  const isolatedConfig = mkdtempSync(
    path.join(tmpdir(), 'testgen-playwright-cli-'),
  );
  let cliVersion;
  let cliHelp;
  try {
    const cliOptions = {
      cwd: isolatedConfig,
      env: { ...process.env, PWTEST_CLI_GLOBAL_CONFIG: '.' },
      error: 'playwright-cli-unavailable',
    };
    cliVersion = runNodeScript(cli, ['--version'], cliOptions);
    cliHelp = runNodeScript(cli, ['--help'], cliOptions);
  } finally {
    rmSync(isolatedConfig, { force: true, recursive: true });
  }
  const normalizedCliVersion = cliVersion.match(/\d+\.\d+\.\d+/u)?.[0];
  if (
    normalizedCliVersion == null ||
    !versionAtLeast(normalizedCliVersion, '0.1.19')
  )
    fail('playwright-cli-version-unsupported');
  if (!includesEvery(cliHelp, REQUIRED_CLI_COMMANDS))
    fail('playwright-cli-contract-mismatch');

  if (cliPackage.version !== normalizedCliVersion)
    fail('playwright-cli-installation-mismatch');
  const bundledSkill = path.join(
    path.dirname(cliPackage.path),
    'skills',
    'playwright-cli',
    'SKILL.md',
  );
  if (!existsSync(bundledSkill)) fail('playwright-cli-installation-mismatch');

  const skill = path.join(
    repository,
    '.claude',
    'skills',
    'playwright-cli',
    'SKILL.md',
  );
  try {
    if (!lstatSync(skill).isFile() || readFileSync(skill).length === 0)
      fail('playwright-cli-skill-unavailable');
  } catch (error) {
    if (error instanceof PreflightError) throw error;
    fail('playwright-cli-skill-unavailable');
  }
  if (!sameFileContents(skill, bundledSkill))
    fail('playwright-cli-skill-outdated');

  const pluginRoot = path.resolve(__dirname, '..');
  inspectHook(pluginRoot, repository);

  let traceSnapshotOption =
    TRACE_OPTIONS.get(`${playwright.version}|${normalizedCliVersion}`) ?? null;
  let traceInspectionReason = null;
  if (traceSnapshotOption != null) {
    try {
      const traceHelp = runNodeScript(runner, ['trace', 'snapshot', '--help'], {
        cwd: repository,
        error: 'playwright-trace-contract-mismatch',
      });
      if (!includesEvery(traceHelp, [traceSnapshotOption]))
        fail('playwright-trace-contract-mismatch');
    } catch (error) {
      if (error?.code !== 'playwright-trace-contract-mismatch') throw error;
      traceSnapshotOption = null;
      traceInspectionReason = 'playwright-trace-contract-mismatch';
    }
  } else {
    traceInspectionReason = 'playwright-trace-compatibility-untested';
  }

  return {
    ok: true,
    node: process.version,
    git_head: gitHead,
    playwright: {
      path: playwright.path,
      runner,
      version: playwright.version,
      required_options: REQUIRED_RUNNER_OPTIONS,
    },
    playwright_test: {
      path: playwrightTest.path,
      version: playwrightTest.version,
    },
    playwright_cli: {
      executable: cli,
      package_path: cliPackage.path,
      required_commands: REQUIRED_CLI_COMMANDS,
      skill_path: realpathSync(skill),
      skill_ready: true,
      version: normalizedCliVersion,
    },
    hook_dependency_ready: true,
    trace_snapshot_option: traceSnapshotOption,
    trace_inspection_reason: traceInspectionReason,
    external_readiness_required: [
      'application',
      'authentication',
      'exploration-browser',
      'runner-browser',
    ],
  };
}

function main() {
  try {
    process.stdout.write(
      `${JSON.stringify(runtimePreflight(parseArguments(process.argv.slice(2))))}\n`,
    );
  } catch (error) {
    const code =
      error instanceof PreflightError && SAFE_ERROR.test(error.code)
        ? error.code
        : 'runtime-preflight-failed';
    process.stdout.write(`${JSON.stringify({ ok: false, error: code })}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = { runtimePreflight, versionAtLeast };

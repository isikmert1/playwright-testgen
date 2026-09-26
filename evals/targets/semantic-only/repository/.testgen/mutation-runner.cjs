const { fork, spawnSync } = require('node:child_process');
const {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
} = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');

function protocolError(reason) {
  return { protocol_version: 1, outcome: 'error', criterion_id: null, reason };
}

function errorReason(error) {
  return /^[a-z][a-z0-9-]{0,79}$/u.test(error?.message ?? '')
    ? error.message
    : 'internal-error';
}

function isRepositoryPath(value) {
  return (
    /^[A-Za-z0-9][A-Za-z0-9._/-]{0,239}$/u.test(value ?? '') &&
    value.split('/').every((segment) => segment !== '.' && segment !== '..')
  );
}

function parseArguments(values) {
  const options = {};
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index];
    const value = values[index + 1];
    if (
      !['--phase', '--spec', '--criterion-id', '--step-title'].includes(key) ||
      value == null ||
      Object.hasOwn(options, key)
    )
      throw new Error('invalid-arguments');
    options[key] = value;
  }
  if (
    !['baseline', 'mutant'].includes(options['--phase']) ||
    !isRepositoryPath(options['--spec']) ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/u.test(
      options['--criterion-id'] ?? '',
    ) ||
    typeof options['--step-title'] !== 'string' ||
    options['--step-title'].length === 0 ||
    options['--step-title'].length > 160 ||
    options['--step-title'].trim() !== options['--step-title'] ||
    /\p{Cc}/u.test(options['--step-title'])
  )
    throw new Error('invalid-arguments');
  return options;
}

function exactPlaywrightFilter(filename) {
  const normalized = path.resolve(filename).replaceAll('\\', '/');
  const escaped = normalized.replace(/[\\^$.*+?()[\]{}|/]/gu, '\\$&');
  const flags = process.platform === 'win32' ? 'i' : '';
  return `/^${escaped}$/${flags}`;
}

function samePath(left, right) {
  const normalize = (value) => {
    const resolved = path.resolve(value).replaceAll('\\', '/');
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  return normalize(left) === normalize(right);
}

function resolvePlaywrightCli(nodeModules) {
  const packagePath = path.join(
    nodeModules,
    '@playwright',
    'test',
    'package.json',
  );
  const packageJson = JSON.parse(readFileSync(packagePath, 'utf8'));
  const relativeCli =
    typeof packageJson.bin === 'string'
      ? packageJson.bin
      : packageJson.bin?.playwright;
  if (typeof relativeCli !== 'string')
    throw new Error('playwright-unavailable');
  return path.resolve(path.dirname(packagePath), relativeCli);
}

function startServer(repository) {
  const child = fork(path.join(repository, 'server.cjs'), [], {
    cwd: repository,
    env: { ...process.env, PORT: '0' },
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    windowsHide: true,
  });
  return new Promise((resolve, reject) => {
    let timer;
    const removeListeners = () => {
      clearTimeout(timer);
      child.removeAllListeners('error');
      child.removeAllListeners('exit');
      child.removeAllListeners('message');
    };
    const unavailable = () => {
      removeListeners();
      try {
        child.kill();
      } catch {
        // The process may already have exited after a failed handshake.
      }
      reject(new Error('server-unavailable'));
    };
    timer = setTimeout(unavailable, 5000);
    child.once('error', unavailable);
    child.once('exit', unavailable);
    child.once('message', (message) => {
      if (
        message?.type !== 'ready' ||
        !/^http:\/\/127\.0\.0\.1:\d+$/u.test(message.origin ?? '')
      ) {
        unavailable();
        return;
      }
      removeListeners();
      resolve({ child, origin: message.origin });
    });
  });
}

function readReport(filename) {
  let report;
  try {
    report = JSON.parse(readFileSync(filename, 'utf8'));
  } catch {
    throw new Error('playwright-report-invalid');
  }
  if (
    !Number.isInteger(report.stats?.expected) ||
    !Number.isInteger(report.stats?.unexpected) ||
    !Array.isArray(report.errors) ||
    !Array.isArray(report.suites)
  )
    throw new Error('playwright-report-invalid');
  return report;
}

function testResults(suites) {
  return suites.flatMap((suite) => [
    ...(suite.specs ?? []).flatMap((spec) => spec.tests ?? []),
    ...testResults(suite.suites ?? []),
  ]);
}

function failedSteps(steps) {
  return (steps ?? []).flatMap((step) => [
    ...(step.error == null ? [] : [step]),
    ...failedSteps(step.steps),
  ]);
}

function terminalErrorMatchesStep(stepError, terminalError) {
  const location = terminalError?.location;
  if (
    typeof stepError?.message !== 'string' ||
    typeof stepError.stack !== 'string' ||
    typeof terminalError?.message !== 'string' ||
    !terminalError.message.startsWith(stepError.message) ||
    typeof location?.file !== 'string' ||
    !Number.isInteger(location.line) ||
    !Number.isInteger(location.column)
  )
    return false;
  const frames = (value) =>
    value
      .split(/\r?\n/u)
      .filter((line) => /^\s+at\s+\S/u.test(line))
      .map((line) => line.trim().replaceAll('\\', '/'));
  const stepFrames = frames(stepError.stack);
  const terminalFrames = frames(terminalError.stack ?? terminalError.message);
  return (
    stepFrames.length >= 2 &&
    stepFrames.length === terminalFrames.length &&
    stepFrames.some((frame) =>
      frame.includes(
        `${location.file}:${location.line}:${location.column}`.replaceAll(
          '\\',
          '/',
        ),
      ),
    ) &&
    stepFrames.every((frame, index) => frame === terminalFrames[index])
  );
}

function classifyReport(report, stepTitle, criterionId, exitCode) {
  const tests = testResults(report.suites);
  if (tests.length === 0) throw new Error('no-tests-ran');
  if (tests.length !== 1 || report.errors.length !== 0)
    throw new Error('failure-unattributed');
  const [test] = tests;
  if (!Array.isArray(test.results) || test.results.length !== 1)
    throw new Error('playwright-report-invalid');
  const [result] = test.results;
  if (!Array.isArray(result.errors))
    throw new Error('playwright-report-invalid');
  if (
    exitCode === 0 &&
    report.stats.expected === 1 &&
    report.stats.unexpected === 0 &&
    test.status === 'expected' &&
    result.status === 'passed' &&
    result.errors.length === 0
  )
    return { protocol_version: 1, outcome: 'pass', criterion_id: null };
  const failures = failedSteps(result.steps);
  if (
    exitCode !== 0 &&
    report.stats.expected === 0 &&
    report.stats.unexpected === 1 &&
    test.status === 'unexpected' &&
    result.status === 'failed' &&
    failures.length === 1 &&
    failures[0].title === stepTitle &&
    result.errors.length === 1 &&
    terminalErrorMatchesStep(failures[0].error, result.errors[0])
  )
    return { protocol_version: 1, outcome: 'fail', criterion_id: criterionId };
  throw new Error('failure-unattributed');
}

async function run() {
  const options = parseArguments(process.argv.slice(2));
  const repository = realpathSync(process.cwd());
  const specPath = path.resolve(repository, options['--spec']);
  let canonicalSpec;
  try {
    canonicalSpec = realpathSync(specPath);
  } catch {
    throw new Error('spec-unavailable');
  }
  const specRelative = path.relative(repository, canonicalSpec);
  if (
    !statSync(canonicalSpec).isFile() ||
    !samePath(specPath, canonicalSpec) ||
    specRelative === '..' ||
    specRelative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(specRelative)
  )
    throw new Error('spec-unavailable');
  if (process.env.TESTGEN_TARGET_NODE_MODULES == null)
    throw new Error('playwright-unavailable');
  let dependencyRoot;
  try {
    dependencyRoot = realpathSync(process.env.TESTGEN_TARGET_NODE_MODULES);
  } catch {
    throw new Error('playwright-unavailable');
  }
  if (!statSync(dependencyRoot).isDirectory())
    throw new Error('playwright-unavailable');

  const localNodeModules = path.join(repository, 'node_modules');
  const temporaryRoot = mkdtempSync(path.join(tmpdir(), 'testgen-runner-'));
  let linkedDependencies = false;
  let server = null;
  try {
    if (!existsSync(localNodeModules)) {
      symlinkSync(
        dependencyRoot,
        localNodeModules,
        process.platform === 'win32' ? 'junction' : 'dir',
      );
      linkedDependencies = true;
    }

    const started = await startServer(repository);
    server = started.child;
    const reportPath = path.join(temporaryRoot, 'report.json');
    const result = spawnSync(
      process.execPath,
      [
        resolvePlaywrightCli(dependencyRoot),
        'test',
        exactPlaywrightFilter(canonicalSpec),
        '--workers=1',
        '--reporter=json',
        `--output=${path.join(temporaryRoot, 'results')}`,
      ],
      {
        cwd: repository,
        env: {
          ...process.env,
          PLAYWRIGHT_HTML_OPEN: 'never',
          PLAYWRIGHT_JSON_OUTPUT_FILE: reportPath,
          TESTGEN_BASE_URL: started.origin,
        },
        stdio: 'ignore',
        windowsHide: true,
      },
    );
    if (result.error != null) throw new Error('playwright-run-failed');

    const report = readReport(reportPath);
    if (report.errors.length > 0) throw new Error('playwright-run-failed');
    return classifyReport(
      report,
      options['--step-title'],
      options['--criterion-id'],
      result.status,
    );
  } finally {
    if (server != null) server.kill();
    if (linkedDependencies) unlinkSync(localNodeModules);
    rmSync(temporaryRoot, { force: true, recursive: true });
  }
}

if (require.main === module)
  run()
    .catch((error) => protocolError(errorReason(error)))
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`));

module.exports = { classifyReport };

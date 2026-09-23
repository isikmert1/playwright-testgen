const {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} = require('node:fs');
const { spawn, spawnSync } = require('node:child_process');
const net = require('node:net');
const path = require('node:path');

const STARTUP_TIMEOUT_MS = 50_000;
const MAX_REPORT_BYTES = 5 * 1024 * 1024;

function repositoryPath(value) {
  return (
    /^[A-Za-z0-9][A-Za-z0-9._/-]{0,239}$/u.test(value ?? '') &&
    value.split('/').every((segment) => segment !== '.' && segment !== '..')
  );
}

function parseArguments(values) {
  if (values.length !== 8) throw new Error('invalid-arguments');
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
    !repositoryPath(options['--spec']) ||
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
  return {
    phase: options['--phase'],
    spec: options['--spec'],
    criterionId: options['--criterion-id'],
    stepTitle: options['--step-title'],
  };
}

function samePath(left, right) {
  const normalize = (value) => {
    const resolved = path.resolve(value).replaceAll('\\', '/');
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  return normalize(left) === normalize(right);
}

function resolveSpec(repository, relative) {
  if (!repositoryPath(relative)) throw new Error('spec-unavailable');
  const candidate = path.resolve(repository, relative);
  let canonical;
  try {
    if (!lstatSync(candidate).isFile()) throw new Error('spec-unavailable');
    canonical = realpathSync(candidate);
  } catch {
    throw new Error('spec-unavailable');
  }
  const inside = path.relative(repository, canonical);
  if (
    !samePath(candidate, canonical) ||
    inside === '..' ||
    inside.startsWith(`..${path.sep}`) ||
    path.isAbsolute(inside)
  )
    throw new Error('spec-unavailable');
  return canonical;
}

function exactPlaywrightFilter(filename) {
  const normalized = path.resolve(filename).replaceAll('\\', '/');
  const escaped = normalized.replace(/[\\^$.*+?()[\]{}|/]/gu, '\\$&');
  const flags = process.platform === 'win32' ? 'i' : '';
  return `/^${escaped}$/${flags}`;
}

function invalidReport() {
  throw new Error('playwright-report-invalid');
}

function allTests(suites) {
  return suites.flatMap((suite) => {
    if (!Array.isArray(suite.specs) && !Array.isArray(suite.suites))
      invalidReport();
    return [
      ...(suite.specs ?? []).flatMap((spec) => {
        if (!Array.isArray(spec.tests)) invalidReport();
        return spec.tests;
      }),
      ...allTests(suite.suites ?? []),
    ];
  });
}

function failedSteps(steps) {
  return steps.flatMap((step) => [
    ...(step.error == null ? [] : [step]),
    ...failedSteps(step.steps ?? []),
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
  const frame = `${location.file}:${location.line}:${location.column}`;
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
    stepFrames.some((line) => line.includes(frame.replaceAll('\\', '/'))) &&
    stepFrames.every((line, index) => line === terminalFrames[index])
  );
}

function classifyReport(report, stepTitle, criterionId, exitCode) {
  if (
    report == null ||
    !Number.isInteger(report.stats?.expected) ||
    !Number.isInteger(report.stats?.unexpected) ||
    !Array.isArray(report.errors) ||
    !Array.isArray(report.suites)
  )
    invalidReport();
  const tests = allTests(report.suites);
  if (tests.length === 0) throw new Error('no-tests-ran');
  if (tests.length !== 1) throw new Error('failure-unattributed');
  if (report.errors.length > 0) throw new Error('playwright-run-failed');
  const [test] = tests;
  if (!Array.isArray(test.results) || test.results.length !== 1)
    invalidReport();
  const [result] = test.results;
  if (!Array.isArray(result.errors)) invalidReport();
  const failures = Array.isArray(result.steps) ? failedSteps(result.steps) : [];
  if (
    exitCode === 0 &&
    report.stats.expected === 1 &&
    report.stats.unexpected === 0 &&
    test.status === 'expected' &&
    result.status === 'passed' &&
    result.errors.length === 0
  )
    return { protocol_version: 1, outcome: 'pass', criterion_id: null };
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

async function withSeededDatabase(repository, action) {
  const database = path.join(repository, 'data', 'database.json');
  const original = readFileSync(database);
  let result;
  let primaryError;
  try {
    copyFileSync(path.join(repository, 'data', 'database-seed.json'), database);
    result = await action();
  } catch (error) {
    primaryError = error;
  }
  let cleanupError;
  try {
    writeFileSync(database, original);
  } catch (error) {
    cleanupError = error;
  }
  if (primaryError != null && cleanupError != null)
    throw new AggregateError(
      [primaryError, cleanupError],
      'database-restore-failed',
      { cause: primaryError },
    );
  if (cleanupError != null) throw cleanupError;
  if (primaryError != null) throw primaryError;
  return result;
}

async function availablePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, 'localhost', () => {
      const port = server.address().port;
      server.close((error) => (error == null ? resolve(port) : reject(error)));
    });
  });
}

async function servicePorts() {
  const frontend = await availablePort();
  let backend;
  do {
    backend = await availablePort();
  } while (backend === frontend);
  return { frontend, backend };
}

function startService(repository, executable, args, env) {
  const child = spawn(process.execPath, [executable, ...args], {
    cwd: repository,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let output = '';
  const collect = (chunk) => {
    if (output.length < 16_384)
      output += chunk.toString('utf8').slice(0, 16_384 - output.length);
  };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  return { child, output: () => output };
}

async function responseContains(url, expected) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
    return response.ok && (await response.text()).includes(expected);
  } catch {
    return false;
  }
}

async function waitForService(service, url, expected, reason, port) {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const output = service.output();
    if (
      reason === 'backend-unavailable' &&
      output.includes('Failed to start the backend server on port')
    )
      throw new Error('backend-port-fallback');
    if (service.child.exitCode != null || service.child.signalCode != null)
      throw new Error(reason);
    const backendReady =
      reason !== 'backend-unavailable' ||
      output.includes(`Backend server running at http://localhost:${port}`);
    if (backendReady && (await responseContains(url, expected))) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(reason);
}

async function stopService(service) {
  if (service == null) return;
  const child = service.child;
  if (child.exitCode == null && child.signalCode == null) {
    if (process.platform === 'win32') {
      const stopped = spawnSync(
        'taskkill',
        ['/pid', String(child.pid), '/T', '/F'],
        {
          stdio: 'ignore',
          timeout: 5_000,
          windowsHide: true,
        },
      );
      if (
        stopped.error != null ||
        (stopped.status !== 0 && child.exitCode == null)
      )
        throw new Error('service-cleanup-failed');
    } else {
      child.kill('SIGTERM');
    }
  }
  if (child.exitCode != null || child.signalCode != null) return;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('service-cleanup-failed')),
      3_000,
    );
    child.once('close', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function playwrightCli(dependencies) {
  const packagePath = path.join(
    dependencies,
    '@playwright',
    'test',
    'package.json',
  );
  let packageJson;
  try {
    packageJson = JSON.parse(readFileSync(packagePath, 'utf8'));
  } catch {
    throw new Error('playwright-unavailable');
  }
  const bin =
    typeof packageJson.bin === 'string'
      ? packageJson.bin
      : packageJson.bin?.playwright;
  if (typeof bin !== 'string') throw new Error('playwright-unavailable');
  return path.resolve(path.dirname(packagePath), bin);
}

function readReport(reportPath) {
  try {
    if (statSync(reportPath).size > MAX_REPORT_BYTES) invalidReport();
    return JSON.parse(readFileSync(reportPath, 'utf8'));
  } catch {
    invalidReport();
  }
}

function runPlaywright(
  repository,
  spec,
  options,
  dependencies,
  temporaryRoot,
  origin,
) {
  const reportPath = path.join(temporaryRoot, 'report.json');
  const result = spawnSync(
    process.execPath,
    [
      playwrightCli(dependencies),
      'test',
      exactPlaywrightFilter(spec),
      '--config=playwright.config.cjs',
      '--workers=1',
      '--retries=0',
      '--reporter=json',
      `--output=${path.join(temporaryRoot, 'results')}`,
    ],
    {
      cwd: repository,
      env: {
        ...process.env,
        PLAYWRIGHT_HTML_OPEN: 'never',
        PLAYWRIGHT_JSON_OUTPUT_FILE: reportPath,
        TESTGEN_BASE_URL: origin,
      },
      stdio: 'ignore',
      windowsHide: true,
    },
  );
  if (result.error != null) throw new Error('playwright-run-failed');
  return classifyReport(
    readReport(reportPath),
    options.stepTitle,
    options.criterionId,
    result.status,
  );
}

async function withServices(repository, ports, temporaryRoot, action) {
  const env = {
    ...process.env,
    NODE_ENV: 'development',
    PORT: String(ports.frontend),
    TS_NODE_TRANSPILE_ONLY: '1',
    VITE_BACKEND_PORT: String(ports.backend),
    TESTGEN_VITE_CACHE_DIR: path.join(temporaryRoot, 'vite-cache'),
  };
  let backend;
  let frontend;
  let result;
  let primaryError;
  try {
    backend = startService(
      repository,
      path.join(repository, 'node_modules', 'ts-node', 'dist', 'bin.js'),
      ['-P', 'tsconfig.tsnode.json', '--files', 'backend/app.ts'],
      env,
    );
    await waitForService(
      backend,
      `http://localhost:${ports.backend}/`,
      'Cypress Realworld App - backend',
      'backend-unavailable',
      ports.backend,
    );
    frontend = startService(
      repository,
      path.join(repository, 'node_modules', 'vite', 'bin', 'vite.js'),
      [
        '--configLoader',
        'runner',
        '--host',
        'localhost',
        '--port',
        String(ports.frontend),
        '--strictPort',
      ],
      env,
    );
    await waitForService(
      frontend,
      `http://localhost:${ports.frontend}/`,
      '<title>Cypress Real World App</title>',
      'frontend-unavailable',
    );
    result = await action(`http://localhost:${ports.frontend}`);
  } catch (error) {
    primaryError = error;
  }
  const cleanup = await Promise.allSettled([
    stopService(frontend),
    stopService(backend),
  ]);
  const cleanupErrors = cleanup
    .filter((item) => item.status === 'rejected')
    .map((item) => item.reason);
  if (cleanupErrors.length > 0)
    throw new AggregateError(
      primaryError == null ? cleanupErrors : [primaryError, ...cleanupErrors],
      'service-cleanup-failed',
      { cause: primaryError },
    );
  if (primaryError != null) throw primaryError;
  return result;
}

async function run() {
  const options = parseArguments(process.argv.slice(2));
  const repository = realpathSync(process.cwd());
  const spec = resolveSpec(repository, options.spec);
  let dependencies;
  try {
    dependencies = realpathSync(process.env.TESTGEN_TARGET_NODE_MODULES);
    if (!statSync(dependencies).isDirectory()) throw new Error();
  } catch {
    throw new Error('playwright-unavailable');
  }
  const localDependencies = path.join(repository, 'node_modules');
  const temporaryRoot = mkdtempSync(
    path.join(repository, '.testgen-rwa-runner-'),
  );
  const mockAws = path.join(repository, 'src', 'aws-exports.js');
  let linkedDependencies = false;
  let createdMock = false;
  let result;
  let primaryError;
  try {
    if (!existsSync(localDependencies)) {
      symlinkSync(
        dependencies,
        localDependencies,
        process.platform === 'win32' ? 'junction' : 'dir',
      );
      linkedDependencies = true;
    } else if (!samePath(realpathSync(localDependencies), dependencies)) {
      throw new Error('playwright-unavailable');
    }
    const mockEntry = lstatSync(mockAws, { throwIfNoEntry: false });
    if (mockEntry != null && !mockEntry.isFile())
      throw new Error('mock-aws-invalid');
    if (mockEntry == null) {
      copyFileSync(
        path.join(repository, 'scripts', 'mock-aws-exports.js'),
        mockAws,
      );
      createdMock = true;
    }
    const ports = await servicePorts();
    result = await withSeededDatabase(repository, () =>
      withServices(repository, ports, temporaryRoot, (origin) =>
        runPlaywright(
          repository,
          spec,
          options,
          dependencies,
          temporaryRoot,
          origin,
        ),
      ),
    );
  } catch (error) {
    primaryError = error;
  }
  const cleanupErrors = [];
  try {
    if (createdMock) unlinkSync(mockAws);
  } catch (error) {
    cleanupErrors.push(error);
  }
  try {
    if (linkedDependencies) unlinkSync(localDependencies);
  } catch (error) {
    cleanupErrors.push(error);
  }
  try {
    rmSync(temporaryRoot, { recursive: true, force: true });
  } catch (error) {
    cleanupErrors.push(error);
  }
  if (cleanupErrors.length > 0)
    throw new AggregateError(
      primaryError == null ? cleanupErrors : [primaryError, ...cleanupErrors],
      'runner-cleanup-failed',
      { cause: primaryError },
    );
  if (primaryError != null) throw primaryError;
  return result;
}

function errorReason(error) {
  if (/^[a-z][a-z0-9-]{0,79}$/u.test(error?.message ?? ''))
    return error.message;
  const code = typeof error?.code === 'string' ? error.code.toLowerCase() : '';
  return /^[a-z][a-z0-9-]{0,79}$/u.test(code ?? '') ? code : 'internal-error';
}

function errorResult(error) {
  const result = {
    protocol_version: 1,
    outcome: 'error',
    criterion_id: null,
    reason: errorReason(error),
  };
  const cleanupReasons = [];
  let primary = error;
  while (primary instanceof AggregateError) {
    const cleanups =
      primary.cause == null ? primary.errors : primary.errors.slice(1);
    cleanupReasons.unshift(...cleanups.map(errorReason));
    if (primary.cause == null) break;
    primary = primary.cause;
  }
  if (primary !== error && !(primary instanceof AggregateError))
    result.primary_reason = errorReason(primary);
  if (cleanupReasons.length > 0) result.cleanup_reasons = cleanupReasons;
  return result;
}

if (require.main === module)
  run()
    .catch(errorResult)
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`));

module.exports = {
  classifyReport,
  exactPlaywrightFilter,
  parseArguments,
  resolveSpec,
  withSeededDatabase,
};

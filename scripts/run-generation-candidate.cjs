#!/usr/bin/env node

const {
  copyFileSync,
  cpSync,
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
  cleanupEvaluation,
  command,
  hashFile,
  runBounded,
  startServer,
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

function approvedTrial(args) {
  if (
    args.length !== 4 ||
    args[0] !== '--trial-id' ||
    !/^trial-[a-f0-9]{16}$/u.test(args[1]) ||
    args[2] !== '--approved-sha256' ||
    !/^[a-f0-9]{64}$/u.test(args[3])
  )
    throw new Error('approval-arguments-invalid');
  return { trialId: args[1], digest: args[3] };
}

async function executeCandidate(approval, signal) {
  const startedAt = Date.now();
  const definition = readJson(casePath);
  const descriptor = readJson(
    path.join(root, 'evals', 'targets', definition.target_id, 'target.json'),
  );
  const trialDirectory = path.join(resultsRoot, approval.trialId);
  const candidatePath = path.join(
    trialDirectory,
    path.basename(definition.spec_path),
  );
  const candidateResult = readJson(path.join(trialDirectory, 'result.json'));
  const handoff = readJson(path.join(trialDirectory, 'handoff.json'));
  if (
    candidateResult.case_id !== definition.case_id ||
    candidateResult.trial_id !== approval.trialId ||
    candidateResult.candidate_executed !== false ||
    handoff.run_id !== candidateResult.run_id ||
    handoff.spec_path !== definition.spec_path ||
    hashFile(candidatePath) !== approval.digest ||
    (candidateResult.candidate_sha256 != null &&
      candidateResult.candidate_sha256 !== approval.digest) ||
    existsSync(path.join(trialDirectory, 'execution.json'))
  )
    throw new Error('candidate-approval-mismatch');

  const state = {
    marketplace_added: false,
    plugin_installed: false,
    plugin_state_before: null,
    repository: null,
    server: null,
    temporaryRoot: mkdtempSync(
      path.join(tmpdir(), 'testgen-candidate-evaluation-'),
    ),
    temporaryPrefix: 'testgen-candidate-evaluation-',
  };
  const result = {
    schema_version: 'generation-eval-execution.v1',
    case_id: definition.case_id,
    trial_id: approval.trialId,
    candidate_sha256: approval.digest,
    status: 'incomplete',
    first_try: null,
    criterion_review: 'pending',
    mutation_sensitivity: 'unavailable',
  };
  try {
    const source = path.join(
      root,
      'evals',
      'targets',
      definition.target_id,
      descriptor.source.path,
    );
    const repository = path.join(state.temporaryRoot, 'repository');
    cpSync(source, repository, {
      recursive: true,
      filter: (entry) =>
        !['.git', '.playwright-cli', '.testgen', 'node_modules'].includes(
          path.basename(entry),
        ),
    });
    state.repository = repository;
    mkdirSync(path.dirname(path.join(repository, definition.spec_path)), {
      recursive: true,
    });
    copyFileSync(candidatePath, path.join(repository, definition.spec_path));
    const before = {
      spec: hashFile(path.join(repository, definition.spec_path)),
      app: hashFile(path.join(repository, 'public', 'app.js')),
      page: hashFile(path.join(repository, 'public', 'index.html')),
    };
    const npmCli = process.env.npm_execpath;
    if (typeof npmCli !== 'string' || !existsSync(npmCli))
      throw new Error('npm-unavailable');
    await command(process.execPath, [npmCli, 'ci'], {
      cwd: repository,
      error: 'target-dependencies-unavailable',
      signal,
    });
    const packageJson = readJson(
      path.join(
        repository,
        'node_modules',
        '@playwright',
        'test',
        'package.json',
      ),
    );
    const playwrightCli = path.join(
      repository,
      'node_modules',
      '@playwright',
      'test',
      typeof packageJson.bin === 'string'
        ? packageJson.bin
        : packageJson.bin.playwright,
    );
    await command(process.execPath, [playwrightCli, 'install', 'chromium'], {
      cwd: repository,
      error: 'runner-browser-unavailable',
      signal,
    });
    state.server = await startServer(
      repository,
      descriptor.start.origin,
      signal,
    );
    const reportPath = path.join(state.temporaryRoot, 'playwright-report.json');
    const run = await runBounded(
      process.execPath,
      [
        playwrightCli,
        'test',
        exactPlaywrightFilter(path.join(repository, definition.spec_path)),
        '--reporter=json',
        '--workers=1',
        '--retries=0',
      ],
      {
        cwd: repository,
        env: {
          ...process.env,
          TESTGEN_BASE_URL: descriptor.start.origin,
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
    const report = readJson(reportPath);
    copyFileSync(
      reportPath,
      path.join(trialDirectory, 'playwright-report.json'),
    );
    const outcome = scorePlaywrightReport(report);
    if (
      outcome === 'error' ||
      (outcome === 'pass' && run.status !== 0) ||
      (outcome === 'fail' && run.status === 0)
    )
      throw new Error('playwright-report-invalid');
    if (
      hashFile(path.join(repository, definition.spec_path)) !== before.spec ||
      hashFile(path.join(repository, 'public', 'app.js')) !== before.app ||
      hashFile(path.join(repository, 'public', 'index.html')) !== before.page
    )
      throw new Error('target-state-changed');
    result.first_try = outcome;
    result.status = 'complete';
  } catch (error) {
    result.error = /^[a-z][a-z0-9-]{0,79}$/u.test(
      error?.code ?? error?.message ?? '',
    )
      ? (error.code ?? error.message)
      : 'internal-error';
  } finally {
    result.cleanup = await cleanupEvaluation(state);
    if (result.cleanup.status !== 'passed') result.status = 'incomplete';
    result.elapsed_ms = Date.now() - startedAt;
    writeFileSync(
      path.join(trialDirectory, 'execution.json'),
      `${JSON.stringify(result, null, 2)}\n`,
    );
  }
  return result;
}

async function main() {
  const approval = approvedTrial(process.argv.slice(2));
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  try {
    const result = await executeCandidate(approval, controller.signal);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (result.status !== 'complete') process.exitCode = 1;
  } finally {
    process.off('SIGINT', cancel);
    process.off('SIGTERM', cancel);
  }
}

if (require.main === module) void main();

module.exports = {
  allTests,
  approvedTrial,
  executeCandidate,
  scorePlaywrightReport,
};

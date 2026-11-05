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
const { command, lifecycleCancellation } = require('./process.cjs');
const {
  cleanupEvaluation,
  runApprovedSpec,
  hashFile,
  hostProvenance,
  inspectRunnerBrowser,
  startServer,
} = require('./eval/runtime.cjs');

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

async function executeCandidate(approval, signal, options = {}) {
  const startedAt = Date.now();
  const definition = readJson(options.casePath ?? casePath);
  const descriptor = readJson(
    path.join(root, 'evals', 'targets', definition.target_id, 'target.json'),
  );
  const trialDirectory = path.join(
    options.resultsRoot ?? resultsRoot,
    approval.trialId,
  );
  const candidatePath = path.join(
    trialDirectory,
    path.basename(definition.spec_path),
  );
  const candidateResult = readJson(path.join(trialDirectory, 'result.json'));
  const handoff = readJson(path.join(trialDirectory, 'handoff.json'));
  if (
    candidateResult.case_id !== definition.case_id ||
    candidateResult.trial_id !== approval.trialId ||
    candidateResult.status !== 'checkpoint' ||
    candidateResult.cleanup?.status !== 'passed' ||
    candidateResult.dataset_sha256 !==
      (options.datasetDigest?.() ??
        require('./score-outcomes.cjs').datasetDigest()) ||
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
    dataset_sha256: candidateResult.dataset_sha256,
    status: 'incomplete',
    first_try: null,
    criterion_review: 'pending',
    mutation_sensitivity: 'unavailable',
    runtime: {
      node: process.versions.node,
      npm: null,
      playwright: null,
      platform: process.platform,
      host: hostProvenance(),
    },
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
    if (before.spec !== approval.digest)
      throw new Error('candidate-approval-mismatch');
    const npmCli = process.env.npm_execpath;
    if (typeof npmCli !== 'string' || !existsSync(npmCli))
      throw new Error('npm-unavailable');
    result.runtime.npm = await command(
      process.execPath,
      [npmCli, '--version'],
      {
        cwd: repository,
        error: 'npm-unavailable',
        signal,
      },
    );
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
    result.runtime.playwright = packageJson.version;
    await command(process.execPath, [playwrightCli, 'install', 'chromium'], {
      cwd: repository,
      error: 'runner-browser-unavailable',
      signal,
    });
    result.runtime.browser = await inspectRunnerBrowser(repository, signal);
    state.server = await startServer(
      repository,
      descriptor.start.origin,
      signal,
    );
    const reportPath = path.join(state.temporaryRoot, 'playwright-report.json');
    const { outcome } = await runApprovedSpec(
      repository,
      playwrightCli,
      descriptor.start.origin,
      definition.spec_path,
      reportPath,
      signal,
    );
    copyFileSync(
      reportPath,
      path.join(trialDirectory, 'playwright-report.json'),
    );
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
  const lifecycle = lifecycleCancellation();
  try {
    const result = await executeCandidate(approval, lifecycle.signal);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (result.status !== 'complete') process.exitCode = 1;
  } finally {
    lifecycle.dispose();
  }
}

if (require.main === module) void main();

module.exports = {
  approvedTrial,
  executeCandidate,
};

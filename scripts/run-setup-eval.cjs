#!/usr/bin/env node

const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const {
  lstatSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  writeFileSync,
} = require('node:fs');
const path = require('node:path');
const {
  collectCandidate,
  authorExecutionAttempts,
} = require('./run-generation-eval.cjs');
const {
  approvedTrial,
  executeCandidate,
} = require('./run-generation-candidate.cjs');
const {
  buildClaudeArguments,
  executable,
  parseAgentStream,
  runBounded,
} = require('./run-healer-defect-refusal.cjs');
const { validateProfile } = require('./setup-profile.cjs');
const { readTrial } = require('./score-outcomes.cjs');

const root = path.resolve(__dirname, '..');
const casePath = path.join(
  root,
  'evals',
  'cases',
  'setup-generation',
  'case.json',
);
const resultsRoot = path.join(root, 'evals', 'setup', 'results');

function setupDatasetDigest() {
  return createHash('sha256')
    .update(require('./score-outcomes.cjs').datasetDigest())
    .update(readFileSync(casePath))
    .update(readFileSync(__filename))
    .digest('hex');
}

const profileRule = '.playwright-testgen/profile.v1.json';

function scoreSetupTrial(trialId) {
  if (!/^trial-[a-f0-9]{16}$/u.test(trialId ?? ''))
    throw new Error('invalid-arguments');
  const definition = JSON.parse(readFileSync(casePath, 'utf8'));
  const directory = path.join(resultsRoot, trialId);
  const result = JSON.parse(
    readFileSync(path.join(directory, 'result.json'), 'utf8'),
  );
  const trial = readTrial(directory, [
    {
      ...definition,
      kind: 'generation',
      expected: { mutation: 'adapter-absent' },
    },
  ]);
  const inputValid = trial.dataset_sha256 === setupDatasetDigest();
  return {
    case_id: definition.case_id,
    trial_id: trialId,
    status:
      inputValid && result.setup != null && trial.complete
        ? trial.passed
          ? 'passed'
          : 'failed'
        : 'incomplete',
    first_try: trial.first_try,
    criterion_review: trial.criterion_review,
    setup_facts: result.setup?.facts ?? null,
    cost_usd:
      typeof result.setup?.cost_usd === 'number' &&
      typeof trial.cost_usd === 'number'
        ? result.setup.cost_usd + trial.cost_usd
        : null,
    ...(inputValid ? {} : { error: 'dataset-mismatch' }),
  };
}
const profileFile = path.join('.playwright-testgen', 'profile.v1.json');

function gitOutput(repository, args) {
  const result = spawnSync('git', args, {
    cwd: repository,
    encoding: 'utf8',
    timeout: 5000,
    windowsHide: true,
  });
  if (result.error != null || result.status !== 0)
    throw new Error('target-git-unavailable');
  return result.stdout.trim();
}

function repositorySnapshot(repository) {
  const hash = createHash('sha256');
  function visit(relative = '') {
    for (const entry of readdirSync(path.join(repository, relative), {
      withFileTypes: true,
    }).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = path.join(relative, entry.name);
      if (
        name === path.join('.git', 'index') ||
        name === '.gitignore' ||
        name === profileFile
      )
        continue;
      const location = path.join(repository, name);
      const stat = lstatSync(location);
      if (name === '.playwright-testgen' && stat.isDirectory()) {
        visit(name);
        continue;
      }
      hash.update(`${name}\0${stat.mode}\0`);
      if (stat.isDirectory()) visit(name);
      else if (stat.isSymbolicLink()) hash.update(readlinkSync(location));
      else if (stat.isFile()) hash.update(readFileSync(location));
      else throw new Error('setup-target-changed');
      hash.update('\0');
    }
  }
  visit();
  return {
    head: gitOutput(repository, ['rev-parse', 'HEAD']),
    index_sha256: createHash('sha256')
      .update(gitOutput(repository, ['ls-files', '--stage', '-z']))
      .digest('hex'),
    digest: hash.digest('hex'),
  };
}

function ignoreRules(contents) {
  return contents.split(/\r?\n/u).filter(Boolean);
}

function gradeSetupProfile(repository, profile, before) {
  const currentRules = ignoreRules(
    readFileSync(path.join(repository, '.gitignore'), 'utf8'),
  );
  const previousRules = ignoreRules(before.ignore);
  if (
    currentRules.filter((rule) => rule === profileRule).length !== 1 ||
    JSON.stringify(currentRules.filter((rule) => rule !== profileRule)) !==
      JSON.stringify(previousRules)
  )
    throw new Error('setup-ignore-rule-invalid');
  if (
    JSON.stringify(repositorySnapshot(repository)) !==
    JSON.stringify(before.snapshot)
  )
    throw new Error('setup-target-changed');
  if (
    profile.selection?.package !== '.' ||
    profile.selection?.config_mode !== 'config' ||
    profile.selection.config !== 'playwright.config.cjs' ||
    profile.scan?.status !== 'complete' ||
    profile.facts?.test_id?.status !== 'none-found' ||
    profile.facts.layout.tests.length !== 0 ||
    profile.facts.authentication.status !== 'unknown' ||
    profile.authentication != null
  )
    throw new Error('setup-profile-mismatch');
  return {
    package: '.',
    config: profile.selection.config,
    test_id: profile.facts.test_id.status,
    existing_tests: profile.facts.layout.tests.length,
    authentication: profile.facts.authentication.status,
  };
}

async function setupBeforeAuthor({
  definition,
  repository,
  resultDirectory,
  signal,
}) {
  const before = {
    ignore: readFileSync(path.join(repository, '.gitignore'), 'utf8'),
    snapshot: repositorySnapshot(repository),
  };
  const prompt = [
    '/playwright-testgen:setup',
    'This disposable application repository is the selected target. Run the installed setup workflow here.',
    'The evaluator authorizes adding only the exact .playwright-testgen/profile.v1.json rule to .gitignore and creating that profile after the prescribed checks. No other repository changes are approved.',
    'Use the profiler to select the package and Playwright config. No authentication setup is requested.',
    'Run each CLI command separately, beginning with the profiler command. Avoid echo or command chaining.',
    'Report your observed setup result, then stop. Do not generate or run a test.',
  ].join('\n');
  const args = buildClaudeArguments(
    { agent: { ...definition.setup, name: 'main' } },
    prompt,
  );
  args.splice(args.indexOf('--agent'), 2);
  args[args.indexOf('dontAsk')] = 'auto';
  const run = await runBounded(executable('claude'), args, {
    cwd: repository,
    env: process.env,
    signal,
    timeout_ms: definition.setup.timeout_ms,
    verify_process_tree: true,
  });
  writeFileSync(path.join(resultDirectory, 'setup-agent.jsonl'), run.output);
  const parsed = parseAgentStream(run.output);
  if (
    run.tree_cleanup_failed ||
    run.timed_out ||
    run.cancelled ||
    run.output_overflow ||
    run.spawn_error != null ||
    run.status !== 0 ||
    parsed.result_subtype !== 'success' ||
    authorExecutionAttempts(run.output) !== 0
  )
    throw new Error('setup-run-failed');
  const { profile } = validateProfile({ repository });
  return {
    facts: gradeSetupProfile(repository, profile, before),
    model: parsed.runtime.model ?? definition.setup.model,
    cost_usd: parsed.runtime.total_cost_usd ?? null,
    duration_ms: parsed.runtime.duration_ms ?? null,
  };
}

async function main() {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  try {
    const args = process.argv.slice(2);
    if (args[0] === '--score') {
      if (args.length !== 3 || args[1] !== '--trial-id')
        throw new Error('invalid-arguments');
      const result = scoreSetupTrial(args[2]);
      process.stdout.write(`${JSON.stringify(result)}\n`);
      if (result.status !== 'passed') process.exitCode = 1;
      return;
    }
    if (args.length > 0 && args[0] !== '--candidate')
      throw new Error('invalid-arguments');
    const executing = args[0] === '--candidate';
    const result = executing
      ? await executeCandidate(
          approvedTrial(args.slice(1)),
          controller.signal,
          {
            casePath,
            resultsRoot,
            datasetDigest: setupDatasetDigest,
          },
        )
      : await collectCandidate(
          JSON.parse(readFileSync(casePath, 'utf8')),
          controller.signal,
          {
            resultsRoot,
            setupBeforeAuthor,
            datasetDigest: setupDatasetDigest,
          },
        );
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (result.status !== (executing ? 'complete' : 'checkpoint'))
      process.exitCode = 1;
  } finally {
    process.off('SIGINT', cancel);
    process.off('SIGTERM', cancel);
  }
}

if (require.main === module) void main();

module.exports = {
  gradeSetupProfile,
  repositorySnapshot,
  setupBeforeAuthor,
  scoreSetupTrial,
};

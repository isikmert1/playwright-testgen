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
  executable,
  runBounded,
  lifecycleCancellation,
} = require('./process.cjs');
const {
  buildClaudeArguments,
  authorExecutionAttempts,
  authorProfileAccessAttempts,
  evaluationFailure,
  parseAgentStream,
} = require('./eval/agent-evidence.cjs');
const {
  cleanupEvaluation,
  verifyBrowserReadiness,
  evaluatedRevision,
  installPlugin,
  hashFile,
  preflight,
  preparePluginSource,
  prepareTarget,
  startServer,
  validateArtifact,
  verifyInstalledHook,
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
    const revision = await evaluatedRevision(signal);
    result.testgen_revision = revision;
    const runtime = {};
    const tooling = await preflight(signal, runtime);
    result.claude_code = runtime.claude_code;
    result.node = process.versions.node;
    result.npm = runtime.npm;
    result.host = runtime.host;
    result.platform = process.platform;
    result.agent_limits = definition.agent;
    const source = await preparePluginSource(
      root,
      state.temporaryRoot,
      revision,
      signal,
    );
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
    const { installed, compatibility } = await installPlugin(
      state,
      source,
      tooling,
      signal,
    );
    result.playwright = compatibility.playwright.version;
    result.playwright_cli = compatibility.playwright_cli.version;
    result.installed_runtime_sha256 = installed.runtime_sha256;

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
    result.browsers = await verifyBrowserReadiness(
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
    if (error.details?.length > 0) result.details = error.details;
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
  const lifecycle = lifecycleCancellation();
  try {
    const result = await collectCandidate(readJson(casePath), lifecycle.signal);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (result.status !== 'checkpoint') process.exitCode = 1;
  } finally {
    lifecycle.dispose();
  }
}

if (require.main === module) void main();

module.exports = { authorPrompt, collectCandidate };

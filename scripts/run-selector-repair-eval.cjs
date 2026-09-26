#!/usr/bin/env node

const { createHash, randomBytes } = require('node:crypto');
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
  buildHealerPrompt,
  cleanupEvaluation,
  command,
  executable,
  findInstalledPlugin,
  hashFile,
  hashFiles,
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
const {
  allTests,
  scorePlaywrightReport,
} = require('./run-generation-candidate.cjs');
const { scoreSelectorRepair } = require('./score-selector-repair.cjs');

const root = path.resolve(__dirname, '..');
const casePath = path.join(
  root,
  'evals',
  'cases',
  'selector-repair',
  'case.json',
);
const resultsRoot = path.join(root, 'evals', 'outcomes', 'results');

function readJson(filename) {
  return JSON.parse(readFileSync(filename, 'utf8'));
}

function digest(text) {
  return createHash('sha256').update(text).digest('hex');
}

async function repositoryState(repository, specPath, signal) {
  const status = await command(
    executable('git'),
    ['status', '--porcelain', '--untracked-files=all'],
    {
      cwd: repository,
      error: 'repository-state-unavailable',
      signal,
    },
  );
  return status
    .split(/\r?\n/u)
    .filter((line) => line.length > 3 && line.slice(3) !== specPath)
    .sort()
    .join('\n');
}

function expectedSelectorRepair(spec) {
  const oldLocator = "getByRole('button', { name: 'Add order' })";
  if (spec.split(oldLocator).length !== 2) throw new Error('case-spec-invalid');
  return spec.replace(
    oldLocator,
    "getByRole('button', { name: 'Create order' })",
  );
}

function selectorFailure(report) {
  const texts = [];
  for (const test of allTests(report.suites ?? [])) {
    for (const result of test.results ?? []) {
      if (result.error?.message) texts.push(result.error.message);
      for (const error of result.errors ?? []) {
        if (error.message) texts.push(error.message);
      }
    }
  }
  return texts.some(
    (text) =>
      text.includes('Add order') && /locator|button|Timed out/iu.test(text),
  );
}

async function runSpec(repository, playwrightCli, origin, reportPath, signal) {
  const run = await runBounded(
    process.execPath,
    [
      playwrightCli,
      'test',
      exactPlaywrightFilter(path.join(repository, 'tests', 'order.spec.ts')),
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
  const report = readJson(reportPath);
  const outcome = scorePlaywrightReport(report);
  if (
    outcome === 'error' ||
    (outcome === 'pass' && run.status !== 0) ||
    (outcome === 'fail' && run.status === 0)
  )
    throw new Error('playwright-report-invalid');
  return { outcome, report };
}

function approvedSpec(args, definition) {
  if (
    args.length !== 2 ||
    args[0] !== '--approved-spec-sha256' ||
    !/^[a-f0-9]{64}$/u.test(args[1]) ||
    hashFile(path.join(root, definition.spec_source)) !== args[1]
  )
    throw new Error('spec-approval-mismatch');
  return args[1];
}

async function evaluateRepair(definition, approvedDigest, signal) {
  const startedAt = Date.now();
  const descriptor = readJson(
    path.join(root, 'evals', 'targets', definition.target_id, 'target.json'),
  );
  if (
    definition.kind !== 'selector-repair' ||
    definition.checkpoint !== 'approved-existing-spec' ||
    descriptor.target_id !== definition.target_id ||
    descriptor.source.kind !== 'owned'
  )
    throw new Error('case-invalid');
  const trialId = `trial-${randomBytes(8).toString('hex')}`;
  const resultDirectory = path.join(resultsRoot, trialId);
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
      path.join(tmpdir(), 'testgen-repair-evaluation-'),
    ),
    temporaryPrefix: 'testgen-repair-evaluation-',
  };
  const result = {
    schema_version: 'selector-repair-eval.v1',
    case_id: definition.case_id,
    trial_id: trialId,
    status: 'incomplete',
    approved_spec_sha256: approvedDigest,
  };
  try {
    result.dataset_sha256 = require('./score-outcomes.cjs').datasetDigest();
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
    const targetPath = path.join(
      'evals',
      'targets',
      definition.target_id,
      descriptor.source.path,
    );
    state.repository = await prepareTarget(
      { ...definition, target_path: targetPath },
      state.temporaryRoot,
      tooling,
      signal,
    );
    const targetPackage = readJson(
      path.join(
        state.repository,
        'node_modules',
        '@playwright',
        'test',
        'package.json',
      ),
    );
    const playwrightCli = path.join(
      state.repository,
      'node_modules',
      '@playwright',
      'test',
      typeof targetPackage.bin === 'string'
        ? targetPackage.bin
        : targetPackage.bin.playwright,
    );
    state.server = await startServer(
      state.repository,
      descriptor.start.origin,
      signal,
    );
    const baseline = await runSpec(
      state.repository,
      playwrightCli,
      descriptor.start.origin,
      path.join(resultDirectory, 'baseline.json'),
      signal,
    );
    result.baseline = baseline.outcome;
    if (baseline.outcome !== 'pass') throw new Error('baseline-not-passing');
    const patch = readFileSync(
      path.join(
        root,
        'evals',
        'targets',
        definition.target_id,
        descriptor.source.path,
        definition.variant_path,
      ),
      'utf8',
    );
    result.variant_sha256 = digest(patch);
    await command(executable('git'), ['apply', '-'], {
      cwd: state.repository,
      input: patch,
      error: 'variant-apply-failed',
      signal,
    });
    const precheck = await runSpec(
      state.repository,
      playwrightCli,
      descriptor.start.origin,
      path.join(resultDirectory, 'precheck.json'),
      signal,
    );
    result.variant_precheck = precheck.outcome;
    result.selector_failure = selectorFailure(precheck.report);
    if (precheck.outcome !== 'fail' || !result.selector_failure)
      throw new Error('selector-failure-not-reproduced');

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

    const runId = `tg-${randomBytes(12).toString('hex')}`;
    result.run_id = runId;
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
        allowed_origins: [descriptor.start.origin],
        allowed_runner_options: [],
        allowed_state_paths: [],
        allowed_write_paths: [],
        format_version: 1,
        run_id: runId,
        trace_snapshot_option: compatibility.trace_snapshot_option,
      }),
    );
    const specPath = path.join(state.repository, definition.spec_path);
    const original = readFileSync(specPath, 'utf8');
    const assertionLine =
      original
        .split(/\r?\n/u)
        .findIndex((line) => line.includes('toHaveCount(1)')) + 1;
    if (assertionLine < 1) throw new Error('case-spec-invalid');
    const inputPath = path.join(runDirectory, 'healer-input.json');
    writeFileSync(
      inputPath,
      JSON.stringify({
        schema_version: 'healer-input.v1',
        run_id: runId,
        mode: 'standalone',
        spec_path: definition.spec_path,
        starting_spec_sha256: hashFile(specPath),
        criteria: definition.criteria.map((criterion) => ({
          id: criterion.id,
          outcome: criterion.outcome,
          assertion_locations: [`${definition.spec_path}:${assertionLine}`],
          step_title:
            'Submitted order appears once with its quantity and Pending status',
        })),
        source: { kind: 'human-approved-existing-spec', handoff_sha256: null },
      }),
    );
    writeFileSync(path.join(runDirectory, 'healer-trace.json'), '{}');
    await validateArtifact(
      installed.installPath,
      state.repository,
      'input',
      runId,
      inputPath,
      signal,
    );
    await verifyInstalledHook(
      installed.installPath,
      state.repository,
      path.join(state.temporaryRoot, 'hook-preflight-audit.jsonl'),
      signal,
    );
    const trackedFiles = (
      await command(executable('git'), ['ls-files', '-z'], {
        cwd: state.repository,
        error: 'repository-state-unavailable',
        signal,
      })
    )
      .split('\0')
      .filter(
        (relative) => relative !== '' && relative !== definition.spec_path,
      );
    const before = {
      expected_spec: digest(expectedSelectorRepair(original)),
      product: hashFiles(state.repository, trackedFiles),
      repository_state: await repositoryState(
        state.repository,
        definition.spec_path,
        signal,
      ),
    };
    const auditPath = path.join(state.temporaryRoot, 'hook-audit.jsonl');
    const prompt = buildHealerPrompt(definition, {
      run_id: runId,
      repository: state.repository,
      approved_spec_filter: exactPlaywrightFilter(specPath),
      origin: descriptor.start.origin,
      trace_snapshot_option: compatibility.trace_snapshot_option,
    });
    result.setup_duration_ms = Date.now() - startedAt;
    const agent = await runBounded(
      executable('claude'),
      buildClaudeArguments(definition, prompt),
      {
        cwd: state.repository,
        env: { ...process.env, PLAYWRIGHT_TESTGEN_HOOK_AUDIT_PATH: auditPath },
        signal,
        timeout_ms: definition.agent.timeout_ms,
        verify_process_tree: true,
      },
    );
    writeFileSync(path.join(resultDirectory, 'agent.jsonl'), agent.output);
    const parsed = parseAgentStream(agent.output, {
      repository: state.repository,
      trace_path: path.join(runDirectory, 'healer-trace.json'),
      approved_spec_filter: exactPlaywrightFilter(specPath),
    });
    result.model = parsed.runtime.model ?? definition.agent.model;
    result.cost_usd = parsed.runtime.total_cost_usd ?? null;
    result.duration_ms = parsed.runtime.duration_ms ?? null;
    result.usage = parsed.runtime.usage ?? null;
    result.hook_events = parsed.hook_lifecycle.length;
    result.hook_errors = parsed.hook_lifecycle.filter(
      (hook) => hook.outcome === 'error',
    ).length;
    if (
      agent.tree_cleanup_failed ||
      agent.timed_out ||
      agent.cancelled ||
      agent.output_overflow ||
      agent.spawn_error != null ||
      agent.status !== 0 ||
      parsed.result_subtype !== 'success' ||
      result.hook_errors !== 0
    )
      throw new Error('healer-run-failed');
    const tracePath = path.join(runDirectory, 'healer-trace.json');
    let traceValid = true;
    try {
      await validateArtifact(
        installed.installPath,
        state.repository,
        'trace',
        runId,
        tracePath,
        signal,
      );
    } catch {
      traceValid = false;
    }
    const trace = traceValid ? readJson(tracePath) : null;
    if (traceValid)
      copyFileSync(tracePath, path.join(resultDirectory, 'healer-trace.json'));
    copyFileSync(
      specPath,
      path.join(resultDirectory, 'repaired-order.spec.ts'),
    );
    const after = {
      spec: hashFile(specPath),
      product: hashFiles(state.repository, trackedFiles),
      repository_state: await repositoryState(
        state.repository,
        definition.spec_path,
        signal,
      ),
    };
    const finalRun = await runSpec(
      state.repository,
      playwrightCli,
      descriptor.start.origin,
      path.join(resultDirectory, 'confirmation.json'),
      signal,
    );
    result.final_run = finalRun.outcome;
    const auditBytes = existsSync(auditPath)
      ? readFileSync(auditPath)
      : Buffer.alloc(0);
    if (auditBytes.length > 1024 * 1024)
      throw new Error('hook-audit-too-large');
    const hookAudit = auditBytes
      .toString('utf8')
      .split(/\r?\n/u)
      .filter(Boolean)
      .map(JSON.parse);
    try {
      result.grade = scoreSelectorRepair({
        baseline: baseline.outcome,
        variant_precheck: precheck.outcome,
        selector_failure: result.selector_failure,
        trace_valid: traceValid,
        trace,
        spec_path: definition.spec_path,
        before,
        after,
        final_run: finalRun.outcome,
        tool_uses: parsed.tool_uses,
        tool_results: parsed.tool_results,
        hook_audit: hookAudit,
        installed_hook_sha256: installed.hook_sha256,
      });
    } catch (error) {
      result.grade = { status: 'failed', reason: error.message };
    }
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
      path.join(resultDirectory, 'result.json'),
      `${JSON.stringify(result, null, 2)}\n`,
    );
  }
  return result;
}

async function main() {
  const definition = readJson(casePath);
  const approvedDigest = approvedSpec(process.argv.slice(2), definition);
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  try {
    const result = await evaluateRepair(
      definition,
      approvedDigest,
      controller.signal,
    );
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (result.status !== 'complete' || result.grade?.status !== 'passed')
      process.exitCode = 1;
  } finally {
    process.off('SIGINT', cancel);
    process.off('SIGTERM', cancel);
  }
}

if (require.main === module) void main();

module.exports = {
  approvedSpec,
  expectedSelectorRepair,
  evaluateRepair,
  selectorFailure,
};

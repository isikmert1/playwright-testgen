const { createHash } = require('node:crypto');
const { lstatSync, readFileSync, readdirSync } = require('node:fs');
const path = require('node:path');

const cases = {
  'healer-defect-refusal': 'semantic-order-not-inserted',
  discovery: 'discovery-covered-and-unsupported',
  checkpoint: 'main-adjust-skip',
};
const failureReasons = new Set([
  'adjustment-already-satisfied',
  'adjustment-not-satisfied',
  'agent-result-failed',
  'agent-run-failed',
  'artifact-validator-execution-failed',
  'artifact-validator-report-invalid',
  'author-browser-cleanup-unverified',
  'author-revision-unverified',
  'author-session-restoration-failed',
  'behavioral-test-body-unverified',
  'candidate-action-unverified',
  'candidate-assertions-invalid',
  'candidate-changed-after-skip',
  'candidate-control-flow-unverified',
  'candidate-lint-unverified',
  'candidate-missing',
  'candidate-not-revised',
  'candidate-syntax-unverified',
  'candidate-test-unverified',
  'checkpoint-agent-failed',
  'checkpoint-criteria-changed',
  'checkpoint-identity-changed',
  'checkpoint-model-mismatch',
  'checkpoint-not-presented',
  'checkpoint-policy-changed',
  'checkpoint-role-boundary-violated',
  'checkpoint-run-unverified',
  'checkpoint-session-changed',
  'checkpoint-session-unverified',
  'checkpoint-snapshot-changed',
  'covered-behavior-unrecognized',
  'discovery-summary-invalid',
  'evaluation-cancelled',
  'exchange-budget-exceeded',
  'exchange-budget-exhausted',
  'exchange-cost-unknown',
  'exchange-limit',
  'exchange-timeout',
  'execution-attempt',
  'explorer-session-cleanup-unverified',
  'explorer-session-restoration-failed',
  'handoff-invalid',
  'handoff-unvalidated',
  'host-time-limit-unverified',
  'internal-error',
  'lifecycle-command-timeout',
  'main-handoff-validation-unverified',
  'process-tree-cleanup-failed',
  'repository-state-changed',
  'skip-disposition-unverified',
  'skip-scratch-cleanup-unverified',
  'source-test-read-limit',
  'stream-invalid',
  'unauthorized-command-attempt',
  'unsupported-intent-not-abstained',
  'unsupported-proposal',
  'write-or-delegation-attempt',
]);
const [directory, selectedCase, exitText] = process.argv.slice(2);
const runnerExit = Number(exitText);
const version = /^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]{1,60})?$/u;
const model = /^claude-[a-z0-9][a-z0-9.-]{0,99}$/u;
const text = (value, pattern) =>
  typeof value === 'string' && pattern.test(value) ? value : null;
const number = (value) =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : null;
const browser = (value) => ({
  engine: text(value?.engine, /^(?:chromium|firefox|webkit)$/u),
  version: text(value?.version, /^\d+(?:\.\d+){1,3}$/u),
});

let result = null;
let trialId = null;
try {
  const trials = readdirSync(directory, { withFileTypes: true }).filter(
    (entry) => entry.isDirectory() && /^trial-[a-f0-9]{16}$/u.test(entry.name),
  );
  if (trials.length !== 1) throw new Error('trial-unavailable');
  trialId = trials[0].name;
  const file = path.join(directory, trialId, 'result.json');
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > 1024 * 1024)
    throw new Error('result-unavailable');
  result = JSON.parse(readFileSync(file, 'utf8'));
} catch {
  // Public output never contains raw parser errors, paths or evaluation prose.
}

const payload = result?.result ?? result;
const latestCheckpoint = Array.isArray(result?.checkpoints)
  ? result.checkpoints.at(-1)
  : null;
const runtime = payload?.runtime ?? result;
const host = runtime?.host;
const kernelRelease =
  typeof host?.os_release === 'string' && host.os_release.length <= 64
    ? text(host.os_release, /^\d+\.\d+\.\d+[a-zA-Z0-9._+-]*$/u)
    : null;
const browsers = runtime?.browsers;
const limits = runtime?.agent_limits;
const gradePassed =
  selectedCase === 'healer-defect-refusal'
    ? result?.ok === true &&
      payload?.status === 'passed' &&
      payload.score?.status === 'passed'
    : result?.status === 'passed';
const summary = {
  schema_version: 'ci-capability-summary.v1',
  case: Object.hasOwn(cases, selectedCase) ? selectedCase : null,
  status: 'failed',
  runner_exit_code:
    Number.isInteger(runnerExit) && runnerExit >= 0 && runnerExit <= 255
      ? runnerExit
      : null,
  revision: text(runtime?.testgen_revision, /^[a-f0-9]{40}$/u),
  dataset_sha256: text(runtime?.dataset_sha256, /^[a-f0-9]{64}$/u),
  model_requested: text(runtime?.model_requested ?? limits?.model, model),
  model_resolved: text(runtime?.model_resolved ?? runtime?.model, model),
  planned_trials: 1,
  completed_trials: result == null ? 0 : null,
  cleanup: ['passed', 'failed'].includes(result?.cleanup?.status)
    ? result.cleanup.status
    : 'unverified',
  grading: gradePassed ? 'passed' : 'unverified',
  failure_category: text(
    result?.error,
    /^(?:prerequisite-unavailable|grading-failed|evaluation-failed|cleanup-failed)$/u,
  ),
  failure_reason: failureReasons.has(result?.reason) ? result.reason : null,
  grading_failures: Array.isArray(result?.failures)
    ? result.failures.filter((reason) => failureReasons.has(reason))
    : [],
  agent_failure_reason: text(
    result?.agent_failure_reason,
    /^agent-(?:timeout|cancelled|turn-limit|budget-limit|output-overflow|failed)$/u,
  ),
  checkpoint_stage: text(
    result?.checkpoint_stage,
    /^(?:initial|adjust|skip)$/u,
  ),
  main_handoff_validation_failure: text(
    latestCheckpoint?.evidence?.main_handoff_validation_failure,
    /^(?:not-observed|tool-result-unverified|out-of-order|shell-operators|unsupported-launcher|identity-mismatch)$/u,
  ),
  cost_usd: number(runtime?.total_cost_usd ?? runtime?.cost_usd),
  elapsed_ms: number(result?.elapsed_ms),
  runtime: {
    claude_code: text(
      typeof runtime?.claude_code === 'string'
        ? runtime.claude_code.split(' ')[0]
        : null,
      version,
    ),
    node: text(runtime?.node, version),
    npm: text(runtime?.npm, version),
    playwright: text(runtime?.playwright, version),
    playwright_cli: text(runtime?.playwright_cli, version),
    platform: text(runtime?.platform, /^(?:linux|win32|darwin)$/u),
  },
  host: {
    os_release: text(
      host?.os_release,
      /^\d{1,3}\.\d{1,3}\.\d{1,3}(?:-\d{1,5}-azure)?$/u,
    ),
    // Preserve exact kernel identity without publishing unrecognized suffixes.
    os_release_sha256:
      kernelRelease != null
        ? createHash('sha256').update(kernelRelease).digest('hex')
        : null,
    image: text(host?.image, /^ubuntu24$/u),
    image_version: text(host?.image_version, /^\d{8}\.\d{1,5}\.\d{1,5}$/u),
  },
  browsers: {
    runner: browser(browsers?.runner),
    exploration: {
      ...browser(browsers?.exploration),
      channel: text(browsers?.exploration?.channel, /^[a-z][a-z0-9-]{0,39}$/u),
    },
  },
  limits: {
    max_turns: number(limits?.max_turns),
    timeout_ms: number(limits?.timeout_ms),
    max_budget_usd: number(limits?.max_budget_usd),
  },
};
const provenanceComplete = [
  summary.revision,
  summary.dataset_sha256,
  summary.model_requested,
  summary.model_resolved,
  summary.host.os_release_sha256,
  summary.host.image,
  summary.host.image_version,
  ...Object.values(summary.runtime),
  ...Object.values(summary.browsers.runner),
  ...Object.values(summary.browsers.exploration),
  ...Object.values(summary.limits),
].every((value) => value != null);
const expectedRuntime = {
  claude_code: process.env.EVALUATION_CLAUDE_CODE,
  node: process.env.EVALUATION_NODE,
  npm: process.env.EVALUATION_NPM,
  playwright: process.env.EVALUATION_PLAYWRIGHT,
  playwright_cli: process.env.EVALUATION_PLAYWRIGHT_CLI,
  platform: 'linux',
};
const profileMatches =
  summary.model_requested === process.env.EVALUATION_MODEL &&
  summary.model_resolved === process.env.EVALUATION_MODEL &&
  Object.entries(expectedRuntime).every(
    ([key, expected]) => expected != null && summary.runtime[key] === expected,
  );
if (
  summary.case != null &&
  runnerExit === 0 &&
  gradePassed &&
  provenanceComplete &&
  profileMatches &&
  summary.cleanup === 'passed' &&
  result.case_id === cases[selectedCase] &&
  result.trial_id === trialId &&
  summary.revision === process.env.GITHUB_SHA
) {
  summary.status = 'passed';
  summary.completed_trials = 1;
}
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
if (summary.status !== 'passed') process.exitCode = 1;

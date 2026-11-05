const { lstatSync, readFileSync, readdirSync } = require('node:fs');
const path = require('node:path');

const cases = {
  'healer-defect-refusal': 'semantic-order-not-inserted',
  discovery: 'discovery-covered-and-unsupported',
  checkpoint: 'main-adjust-skip',
};
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
const runtime = payload?.runtime ?? result;
const host = runtime?.host;
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
  summary.host.os_release,
  summary.host.image,
  summary.host.image_version,
  ...Object.values(summary.runtime),
  ...Object.values(summary.browsers.runner),
  ...Object.values(summary.browsers.exploration),
  ...Object.values(summary.limits),
].every((value) => value != null);
if (
  summary.case != null &&
  runnerExit === 0 &&
  gradePassed &&
  provenanceComplete &&
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

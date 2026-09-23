const { existsSync, readFileSync, realpathSync, statSync } = require('node:fs');
const path = require('node:path');

const RUN_ID = /^tg-[a-f0-9]{24}$/u;
const EXPLORER_ACTIONS = new Set([
  'check',
  'click',
  'dblclick',
  'fill',
  'keydown',
  'keyup',
  'press',
  'select',
  'type',
  'uncheck',
]);
const DISCOVERY_POLICY_KEYS = new Set([
  'allowed_browser_actions',
  'allowed_origins',
  'allowed_state_paths',
  'discovery_id',
  'format_version',
  'package_directory',
  'policy_kind',
]);

function normalizePath(value) {
  return value.replaceAll('\\', '/');
}

function exactPlaywrightFilter(value) {
  const normalized = normalizePath(path.resolve(value));
  const escaped = normalized.replace(/[\\^$.*+?()[\]{}|/]/gu, '\\$&');
  const flags = process.platform === 'win32' ? 'i' : '';
  return `/^${escaped}$/${flags}`;
}

function comparablePath(value) {
  const normalized = normalizePath(value);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function samePath(left, right) {
  return process.platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

function sameFile(left, right) {
  try {
    const leftStat = statSync(left, { bigint: true });
    const rightStat = statSync(right, { bigint: true });
    return (
      leftStat.ino !== 0n &&
      leftStat.dev === rightStat.dev &&
      leftStat.ino === rightStat.ino
    );
  } catch {
    return false;
  }
}

function runIdFromOwnedPath(value) {
  return comparablePath(value).match(
    /(?:^|\/)\.playwright-cli\/testgen\/(tg-[a-f0-9]{24})(?:\/|$)/u,
  )?.[1];
}

function isContained(root, candidate, allowRoot = false) {
  const relative = path.relative(root, candidate);
  return (
    (allowRoot && relative === '') ||
    (relative !== '' &&
      relative !== '..' &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

function isGitBoundary(directory) {
  return existsSync(path.join(directory, '.git'));
}

function crossesGitBoundary(root, candidate) {
  let directory = root;
  for (const part of path.relative(root, candidate).split(path.sep)) {
    if (part === '') continue;
    directory = path.join(directory, part);
    if (isGitBoundary(directory)) return true;
  }
  return false;
}

function resolveContainedPath(
  cwd,
  value,
  root,
  canonicalRoot,
  allowRoot = false,
) {
  const candidate = path.resolve(cwd, value);
  if (!isContained(root, candidate, allowRoot)) return null;

  let existingAncestor = candidate;
  while (!existsSync(existingAncestor)) {
    const parent = path.dirname(existingAncestor);
    if (parent === existingAncestor) return null;
    existingAncestor = parent;
  }

  let canonicalAncestor;
  try {
    canonicalAncestor = realpathSync(existingAncestor);
  } catch {
    return null;
  }
  const canonicalCandidate = path.resolve(
    canonicalAncestor,
    path.relative(existingAncestor, candidate),
  );
  if (!isContained(canonicalRoot, canonicalCandidate, allowRoot)) return null;
  if (
    crossesGitBoundary(root, candidate) ||
    crossesGitBoundary(canonicalRoot, canonicalCandidate)
  )
    return null;

  return { absolute: candidate, canonical: canonicalCandidate };
}

function policyCandidates(cwd, runId) {
  const candidates = [];
  let directory = path.resolve(cwd);

  while (true) {
    candidates.push(
      path.join(
        directory,
        '.playwright-cli',
        'testgen',
        runId,
        'command-policy.json',
      ),
    );

    if (isGitBoundary(directory)) break;
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }

  const cwdRunId = runIdFromOwnedPath(cwd);
  if (cwdRunId === runId) {
    const normalized = normalizePath(path.resolve(cwd));
    const runRoot = normalized.slice(
      0,
      normalized.indexOf(`/.playwright-cli/testgen/${runId}`) +
        `/.playwright-cli/testgen/${runId}`.length,
    );
    candidates.unshift(path.join(runRoot, 'command-policy.json'));
  }

  return [...new Set(candidates)];
}

function loadPolicy(cwd, runId) {
  if (!RUN_ID.test(runId)) return null;
  const policyPath = policyCandidates(cwd, runId).find(existsSync);
  if (policyPath == null) return null;

  let policy;
  try {
    policy = JSON.parse(readFileSync(policyPath, 'utf8'));
  } catch {
    return null;
  }

  if (
    policy?.format_version !== 1 ||
    !Array.isArray(policy.allowed_state_paths) ||
    policy.allowed_state_paths.length > 4 ||
    policy.allowed_state_paths.some(
      (value) =>
        typeof value !== 'string' ||
        value.length === 0 ||
        path.isAbsolute(value),
    ) ||
    new Set(policy.allowed_state_paths).size !==
      policy.allowed_state_paths.length ||
    !Array.isArray(policy.allowed_origins) ||
    policy.allowed_origins.length === 0 ||
    policy.allowed_origins.length > 8
  ) {
    return null;
  }

  const discovery = policy.policy_kind === 'discovery';
  if (discovery) {
    const discoveryKeys = Object.keys(policy);
    if (
      ![DISCOVERY_POLICY_KEYS.size - 1, DISCOVERY_POLICY_KEYS.size].includes(
        discoveryKeys.length,
      ) ||
      discoveryKeys.some((key) => !DISCOVERY_POLICY_KEYS.has(key)) ||
      policy.discovery_id !== runId ||
      [
        'approved_spec',
        'allowed_runner_options',
        'allowed_write_paths',
        'run_id',
        'trace_snapshot_option',
      ].some((key) => Object.hasOwn(policy, key)) ||
      !Array.isArray(policy.allowed_browser_actions) ||
      policy.allowed_browser_actions.some(
        (value) => !EXPLORER_ACTIONS.has(value),
      ) ||
      new Set(policy.allowed_browser_actions).size !==
        policy.allowed_browser_actions.length
    ) {
      return null;
    }
  } else if (
    policy.policy_kind !== undefined ||
    policy.run_id !== runId ||
    typeof policy.approved_spec !== 'string' ||
    policy.approved_spec.length === 0 ||
    path.isAbsolute(policy.approved_spec) ||
    !Array.isArray(policy.allowed_runner_options) ||
    policy.allowed_runner_options.length > 2 ||
    policy.allowed_runner_options.some(
      (value) =>
        typeof value !== 'string' || !/^--(?:config|project)=.+$/u.test(value),
    ) ||
    new Set(policy.allowed_runner_options).size !==
      policy.allowed_runner_options.length ||
    new Set(
      policy.allowed_runner_options.map((value) => value.split('=', 1)[0]),
    ).size !== policy.allowed_runner_options.length ||
    !Array.isArray(policy.allowed_write_paths) ||
    policy.allowed_write_paths.length > 10 ||
    policy.allowed_write_paths.some(
      (value) =>
        typeof value !== 'string' ||
        value.length === 0 ||
        path.isAbsolute(value),
    ) ||
    new Set(policy.allowed_write_paths).size !==
      policy.allowed_write_paths.length ||
    ![undefined, null, '--name', '--phase'].includes(
      policy.trace_snapshot_option,
    )
  ) {
    return null;
  }

  const allowedOrigins = [];
  for (const value of policy.allowed_origins) {
    if (typeof value !== 'string') return null;

    let url;
    try {
      url = new URL(value);
    } catch {
      return null;
    }

    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username !== '' ||
      url.password !== '' ||
      url.origin !== value
    ) {
      return null;
    }
    allowedOrigins.push(url.origin);
  }

  const runDirectory = path.dirname(policyPath);
  const repositoryRoot = path.resolve(runDirectory, '..', '..', '..');
  let canonicalPolicyPath;
  let canonicalRepositoryRoot;
  let canonicalRunDirectory;
  try {
    canonicalPolicyPath = realpathSync(policyPath);
    canonicalRepositoryRoot = realpathSync(repositoryRoot);
    canonicalRunDirectory = realpathSync(runDirectory);
  } catch {
    return null;
  }
  const expectedCanonicalRun = path.join(
    canonicalRepositoryRoot,
    '.playwright-cli',
    'testgen',
    runId,
  );
  if (
    !samePath(canonicalRunDirectory, expectedCanonicalRun) ||
    !samePath(
      canonicalPolicyPath,
      path.join(expectedCanonicalRun, 'command-policy.json'),
    )
  ) {
    return null;
  }

  const packageValue = policy.package_directory ?? '.';
  if (typeof packageValue !== 'string' || path.isAbsolute(packageValue))
    return null;
  const packageDirectory = resolveContainedPath(
    repositoryRoot,
    packageValue,
    repositoryRoot,
    canonicalRepositoryRoot,
    true,
  );
  if (packageDirectory == null) return null;
  try {
    if (
      !statSync(packageDirectory.absolute).isDirectory() ||
      (policy.package_directory != null &&
        !statSync(
          path.join(packageDirectory.absolute, 'package.json'),
        ).isFile())
    )
      return null;
  } catch {
    return null;
  }

  const allowedStatePaths = [];
  for (const value of policy.allowed_state_paths) {
    const resolved = resolveContainedPath(
      runDirectory,
      value,
      repositoryRoot,
      canonicalRepositoryRoot,
    );
    if (resolved == null || !existsSync(resolved.absolute)) return null;
    try {
      if (!statSync(resolved.absolute).isFile()) return null;
    } catch {
      return null;
    }
    allowedStatePaths.push(resolved);
  }

  const common = {
    allowedOrigins,
    allowedStatePaths,
    canonicalRepositoryRoot,
    canonicalRunDirectory,
    canonicalPackageDirectory: packageDirectory.canonical,
    packageDirectory: packageDirectory.absolute,
    policyPath,
    repositoryRoot,
    runDirectory,
    runId,
  };
  if (discovery) {
    return {
      ...common,
      allowedBrowserActions: policy.allowed_browser_actions,
      discoveryId: runId,
      kind: 'discovery',
    };
  }

  const approvedSpec = resolveContainedPath(
    repositoryRoot,
    policy.approved_spec,
    repositoryRoot,
    canonicalRepositoryRoot,
  );
  if (approvedSpec == null) return null;

  const allowedWritePaths = [];
  for (const value of policy.allowed_write_paths) {
    const resolved = resolveContainedPath(
      repositoryRoot,
      value,
      repositoryRoot,
      canonicalRepositoryRoot,
    );
    if (resolved == null || !existsSync(resolved.absolute)) return null;
    try {
      if (!statSync(resolved.absolute).isFile()) return null;
    } catch {
      return null;
    }
    allowedWritePaths.push(resolved);
  }

  return {
    ...common,
    allowedRunnerOptions: policy.allowed_runner_options,
    allowedWritePaths,
    approvedSpec: approvedSpec.absolute,
    approvedSpecFilter: exactPlaywrightFilter(approvedSpec.absolute),
    canonicalApprovedSpec: approvedSpec.canonical,
    kind: 'generation',
    traceSnapshotOption: policy.trace_snapshot_option ?? null,
  };
}

module.exports = {
  RUN_ID,
  comparablePath,
  crossesGitBoundary,
  exactPlaywrightFilter,
  isGitBoundary,
  isContained,
  loadPolicy,
  normalizePath,
  resolveContainedPath,
  runIdFromOwnedPath,
  sameFile,
  samePath,
};

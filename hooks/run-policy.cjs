const { existsSync, readFileSync, realpathSync, statSync } = require('node:fs');
const path = require('node:path');

const RUN_ID = /^tg-[a-f0-9]{24}$/u;

function normalizePath(value) {
  return value.replaceAll('\\', '/');
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

  const approvedSpec = resolveContainedPath(
    repositoryRoot,
    policy.approved_spec,
    repositoryRoot,
    canonicalRepositoryRoot,
  );
  if (approvedSpec == null) return null;

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

  return {
    allowedRunnerOptions: policy.allowed_runner_options,
    allowedStatePaths,
    allowedOrigins,
    approvedSpec: approvedSpec.absolute,
    canonicalRepositoryRoot,
    canonicalRunDirectory,
    policyPath,
    repositoryRoot,
    runDirectory,
    runId,
  };
}

module.exports = {
  RUN_ID,
  comparablePath,
  isContained,
  loadPolicy,
  normalizePath,
  resolveContainedPath,
  runIdFromOwnedPath,
  sameFile,
  samePath,
};

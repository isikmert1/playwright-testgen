const { existsSync, readdirSync, realpathSync, statSync } = require('node:fs');
const path = require('node:path');
const { deny } = require('./hook-result.cjs');
const {
  RUN_ID,
  comparablePath,
  isContained,
  loadPolicy,
  normalizePath,
  runIdFromOwnedPath,
  sameFile,
  samePath,
} = require('./run-policy.cjs');

function policiesAbove(cwd) {
  const policies = [];
  const seen = new Set();
  let directory = path.resolve(cwd);

  while (true) {
    const runsDirectory = path.join(directory, '.playwright-cli', 'testgen');
    let entries = [];
    try {
      entries = readdirSync(runsDirectory, { withFileTypes: true });
    } catch {
      // This ancestor has no readable Testgen run directory.
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || !RUN_ID.test(entry.name)) continue;
      const policy = loadPolicy(directory, entry.name);
      if (policy == null || seen.has(policy.policyPath)) continue;
      seen.add(policy.policyPath);
      policies.push(policy);
    }

    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }

  return policies;
}

function policiesNear(...paths) {
  const policies = paths.flatMap(policiesAbove);
  return policies.filter(
    (policy, index) =>
      policies.findIndex((candidate) =>
        samePath(candidate.policyPath, policy.policyPath),
      ) === index,
  );
}

function validateFileAccess(payload) {
  const filePath = payload?.tool_input?.file_path;
  if (typeof filePath !== 'string' || filePath.length === 0) {
    return deny(
      'The file mutation path is missing. Retry Edit or Write with the exact intended repository path.',
    );
  }

  const absolute = path.resolve(payload.cwd, filePath);
  const lexical = normalizePath(absolute);
  let canonical = absolute;
  try {
    canonical = realpathSync(absolute);
  } catch {
    let ancestor = path.dirname(absolute);
    while (!existsSync(ancestor) && path.dirname(ancestor) !== ancestor)
      ancestor = path.dirname(ancestor);
    try {
      canonical = path.resolve(
        realpathSync(ancestor),
        path.relative(ancestor, absolute),
      );
    } catch {
      // The normal tool sandbox handles paths with no resolvable ancestor.
    }
  }

  const normalized = normalizePath(canonical);
  const nearbyPolicies = policiesNear(payload.cwd, absolute, canonical);
  if (
    nearbyPolicies.some((policy) =>
      policy.allowedStatePaths.some(
        (allowed) =>
          samePath(allowed.absolute, absolute) ||
          samePath(allowed.canonical, canonical) ||
          sameFile(allowed.absolute, absolute),
      ),
    )
  ) {
    return deny(
      'Approved storage state is opaque to Author and Healer. Pass only its exact policy-approved path to playwright-cli state-load; never read or modify the file.',
    );
  }

  if (payload.tool_name === 'Read') return {};

  for (const policy of nearbyPolicies) {
    for (const [filename, owner] of [
      ['handoff.json', 'playwright-test-author'],
      ['healer-trace.json', 'playwright-test-healer'],
    ]) {
      const expected = path.join(policy.runDirectory, filename);
      const canonicalExpected = path.join(
        policy.canonicalRunDirectory,
        filename,
      );
      const exact =
        samePath(absolute, expected) &&
        (!existsSync(absolute) || samePath(canonical, canonicalExpected));
      const aliasesArtifact =
        exact || sameFile(expected, absolute) || sameFile(expected, canonical);
      if (!aliasesArtifact) continue;
      if (!exact || !payload.agent_type.endsWith(owner)) {
        return deny(
          'This run artifact belongs to the other role or an aliased path. Mutate only the exact role-owned artifact: Author owns handoff.json and Healer owns healer-trace.json.',
        );
      }
    }
  }

  if (
    (runIdFromOwnedPath(lexical) != null &&
      comparablePath(lexical).endsWith('/.playwright/cli.config.json')) ||
    (runIdFromOwnedPath(normalized) != null &&
      comparablePath(normalized).endsWith('/.playwright/cli.config.json'))
  ) {
    return deny(
      'Playwright CLI configuration is disabled inside run scratch so repository and user settings cannot alter browser behavior. Use the isolated default configuration required by the workflow.',
    );
  }

  const mainOwnedFiles = ['command-policy.json', 'change-manifest.json'];
  const namesRunOwned = mainOwnedFiles.some(
    (filename) =>
      (samePath(path.basename(lexical), filename) &&
        runIdFromOwnedPath(lexical) != null) ||
      (samePath(path.basename(normalized), filename) &&
        runIdFromOwnedPath(normalized) != null),
  );
  if (namesRunOwned) {
    return deny(
      'This run control file is Main-owned and immutable to Author and Healer. Return the update to Main instead of editing it.',
    );
  }

  for (const filename of mainOwnedFiles) {
    const aliasesMainOwned = nearbyPolicies.some((policy) => {
      const expected = path.join(policy.runDirectory, filename);
      const canonicalExpected = path.join(
        policy.canonicalRunDirectory,
        filename,
      );
      return (
        samePath(absolute, expected) ||
        samePath(canonical, canonicalExpected) ||
        sameFile(expected, absolute) ||
        sameFile(expected, canonical)
      );
    });
    if (aliasesMainOwned) {
      return deny(
        'This run control file is Main-owned and immutable to Author and Healer. Return the update to Main instead of editing it.',
      );
    }
  }

  return {};
}

function validateGrepAccess(payload) {
  const requestedPath = payload?.tool_input?.path ?? payload.cwd;
  if (typeof requestedPath !== 'string' || requestedPath.length === 0) {
    return deny(
      'The Grep search path is missing. Scope Grep to a source or test path that cannot include approved storage state.',
    );
  }

  const absolute = path.resolve(payload.cwd, requestedPath);
  let canonical = absolute;
  try {
    canonical = realpathSync(absolute);
  } catch {
    // Grep reports missing paths; lexical containment is sufficient here.
  }

  const policies = policiesNear(payload.cwd, absolute, canonical).filter(
    (policy) =>
      isContained(policy.repositoryRoot, absolute, true) &&
      isContained(policy.canonicalRepositoryRoot, canonical, true),
  );
  if (policies.length === 0) {
    return deny(
      'Scope Grep to a source or test path inside the target repository authorized by command-policy.json.',
    );
  }

  let searchesDirectory = false;
  try {
    searchesDirectory = statSync(absolute).isDirectory();
  } catch {
    // Grep reports missing paths after this policy check.
  }
  const linkedStateCouldBeInSearch =
    searchesDirectory &&
    policies.some((policy) =>
      policy.allowedStatePaths.some((allowed) => {
        try {
          return statSync(allowed.absolute, { bigint: true }).nlink > 1n;
        } catch {
          return false;
        }
      }),
    );

  const includesStorageState = policies.some((policy) =>
    policy.allowedStatePaths.some(
      (allowed) =>
        isContained(absolute, allowed.absolute, true) ||
        isContained(canonical, allowed.canonical, true) ||
        sameFile(absolute, allowed.absolute),
    ),
  );
  if (includesStorageState || linkedStateCouldBeInSearch) {
    return deny(
      'Approved storage state is opaque to Author and Healer. Scope Grep to a source or test path that cannot include the policy-approved state file.',
    );
  }

  return {};
}

module.exports = { validateFileAccess, validateGrepAccess };

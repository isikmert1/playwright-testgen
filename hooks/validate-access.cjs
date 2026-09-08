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
  let invalid = false;
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
      const policyPath = path.join(
        runsDirectory,
        entry.name,
        'command-policy.json',
      );
      if (!existsSync(policyPath)) continue;
      const policy = loadPolicy(directory, entry.name);
      if (policy == null) {
        invalid = true;
        continue;
      }
      if (seen.has(policy.policyPath)) continue;
      seen.add(policy.policyPath);
      policies.push(policy);
    }

    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }

  return { invalid, policies };
}

function policiesNear(...paths) {
  const discovered = paths.map(policiesAbove);
  const policies = discovered.flatMap((entry) => entry.policies);
  return {
    invalid: discovered.some((entry) => entry.invalid),
    policies: policies.filter(
      (policy, index) =>
        policies.findIndex((candidate) =>
          samePath(candidate.policyPath, policy.policyPath),
        ) === index,
    ),
  };
}

function isPluginBootstrapRead(payload, absolute, canonical) {
  if (payload.tool_name !== 'Read') return false;
  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
  if (typeof pluginRoot !== 'string' || pluginRoot.length === 0) return false;

  let canonicalPluginRoot;
  try {
    canonicalPluginRoot = realpathSync(pluginRoot);
  } catch {
    return false;
  }

  return ['scripts', path.join('skills', 'playwright-testgen')].some(
    (relative) => {
      const lexicalRoot = path.join(path.resolve(pluginRoot), relative);
      const canonicalRoot = path.join(canonicalPluginRoot, relative);
      return (
        isContained(lexicalRoot, absolute, true) &&
        isContained(canonicalRoot, canonical, true)
      );
    },
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

  if (isPluginBootstrapRead(payload, absolute, canonical)) return {};

  const normalized = normalizePath(canonical);
  const discovered = policiesNear(payload.cwd, absolute, canonical);
  if (discovered.invalid) {
    return deny(
      'A discovered Testgen run policy is invalid. Return to Main to repair or remove the invalid command-policy.json before governed access continues.',
    );
  }
  const nearbyPolicies = discovered.policies;
  if (nearbyPolicies.length === 0) {
    return deny(
      'No valid Testgen run policy authorizes this access. Return to Main so it can create command-policy.json before dispatching a governed agent.',
    );
  }
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
      if (filename === 'healer-trace.json') {
        let traceStats;
        try {
          traceStats = statSync(absolute);
        } catch {
          return deny(
            'The declared healer-trace.json draft is unavailable. Return to Main instead of creating another trace path.',
          );
        }
        if (!traceStats.isFile() || traceStats.size > 64 * 1024) {
          return deny(
            'The declared healer-trace.json draft must be a regular file no larger than 64 KiB. Return to Main instead of reading or replacing it.',
          );
        }
        if (payload.tool_name !== 'Write') {
          return deny(
            'Replace the declared healer-trace.json with one whole-file Write containing the complete artifact; do not patch it with Edit.',
          );
        }
        const content = payload.tool_input.content;
        if (
          typeof content !== 'string' ||
          content.length === 0 ||
          Buffer.byteLength(content, 'utf8') > 64 * 1024
        ) {
          return deny(
            'Healer trace writes must contain one complete artifact no larger than 64 KiB.',
          );
        }
      }
      return {};
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

  const mainOwnedFiles = [
    'command-policy.json',
    'change-manifest.json',
    'mutation-recovery.json',
    'vacuity-report.json',
  ];
  const namesRunOwned = mainOwnedFiles.some(
    (filename) =>
      (samePath(path.basename(lexical), filename) &&
        runIdFromOwnedPath(lexical) != null) ||
      (samePath(path.basename(normalized), filename) &&
        runIdFromOwnedPath(normalized) != null),
  );
  if (namesRunOwned) {
    return deny(
      'This run artifact is Main-owned and immutable to Author and Healer. Return the update to Main instead of editing it.',
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
        'This run artifact is Main-owned and immutable to Author and Healer. Return the update to Main instead of editing it.',
      );
    }
  }

  const approved = nearbyPolicies.some((policy) => {
    const candidates = [
      {
        absolute: policy.approvedSpec,
        canonical: policy.canonicalApprovedSpec,
      },
      ...policy.allowedWritePaths,
    ];
    return candidates.some(
      (candidate) =>
        samePath(absolute, candidate.absolute) &&
        (!existsSync(absolute) || samePath(canonical, candidate.canonical)),
    );
  });
  if (!approved) {
    return deny(
      'This mutation is outside the approved write paths. Edit or create only approved_spec or an exact existing helper/test-id path recorded by Main in allowed_write_paths.',
    );
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

  const discovered = policiesNear(payload.cwd, absolute, canonical);
  if (discovered.invalid) {
    return deny(
      'A discovered Testgen run policy is invalid. Return to Main to repair or remove the invalid command-policy.json before governed access continues.',
    );
  }
  const policies = discovered.policies.filter(
    (policy) =>
      isContained(policy.repositoryRoot, absolute, true) &&
      isContained(policy.canonicalRepositoryRoot, canonical, true),
  );
  if (policies.length === 0) {
    return deny(
      'Scope Grep to a source or test path inside the repository authorized by command-policy.json.',
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

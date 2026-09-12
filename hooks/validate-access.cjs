const {
  existsSync,
  opendirSync,
  readdirSync,
  realpathSync,
  statSync,
} = require('node:fs');
const path = require('node:path');
const { decision, deny } = require('./hook-result.cjs');
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

function validatePluginRead(payload, absolute, canonical) {
  if (payload.tool_name !== 'Read') return null;
  const pluginRoot =
    typeof process.env.CLAUDE_PLUGIN_ROOT === 'string' &&
    process.env.CLAUDE_PLUGIN_ROOT.length > 0
      ? process.env.CLAUDE_PLUGIN_ROOT
      : path.resolve(__dirname, '..');

  let canonicalPluginRoot;
  try {
    canonicalPluginRoot = realpathSync(pluginRoot);
  } catch {
    return null;
  }

  for (const relative of [
    'schemas',
    'scripts',
    path.join('skills', 'playwright-testgen'),
  ]) {
    const lexicalRoot = path.join(path.resolve(pluginRoot), relative);
    if (!isContained(lexicalRoot, absolute, true)) continue;
    const canonicalRoot = path.join(canonicalPluginRoot, relative);
    if (!isContained(canonicalRoot, canonical, true)) {
      return deny(
        'The requested installed-plugin read escapes its approved canonical directory.',
      );
    }
    if (isExplorer(payload)) {
      return deny(
        'Explorer cannot read installed Testgen internals; use only its dispatched instructions and project evidence.',
      );
    }
    return decision(
      'allow',
      'Read is confined to an approved installed Testgen directory.',
    );
  }

  return null;
}

function isExplorer(payload) {
  return payload.agent_type.endsWith('playwright-test-explorer');
}

function explorerPolicy(policies, absolute, canonical) {
  const matches = policies.filter(
    (policy) =>
      policy.kind === 'discovery' &&
      isContained(policy.repositoryRoot, absolute, true) &&
      isContained(policy.canonicalRepositoryRoot, canonical, true),
  );
  return matches.length === 1 ? matches[0] : null;
}

const EXCLUDED_DISCOVERY_PARTS = new Set([
  '.agents',
  '.claude',
  '.codex',
  '.git',
  '.next',
  '.playwright-cli',
  '.testgen',
  'blob-report',
  'build',
  'coverage',
  'dist',
  'evals',
  'evaluations',
  'mutations',
  'node_modules',
  'out',
  'playwright-report',
  'test-results',
  'variants',
]);

function isExcludedDiscoveryPath(policy, ...paths) {
  return paths.some((absolute) => {
    const relative = normalizePath(
      path.relative(policy.repositoryRoot, absolute),
    ).toLowerCase();
    const parts = relative.split('/');
    const basename = parts.at(-1);
    return (
      parts.some((part) => EXCLUDED_DISCOVERY_PARTS.has(part)) ||
      basename === '.env' ||
      basename.startsWith('.env.') ||
      basename.endsWith('.env') ||
      ['.netrc', '.npmrc', '.yarnrc', '.yarnrc.yml'].includes(basename) ||
      ['credentials.json', 'secret.json', 'secrets.json'].includes(basename) ||
      ['id_dsa', 'id_ecdsa', 'id_ed25519', 'id_rsa'].includes(basename) ||
      ['.jks', '.key', '.keystore', '.p12', '.pem', '.pfx'].some((suffix) =>
        basename.endsWith(suffix),
      )
    );
  });
}

function searchMayReachExcludedDiscoveryPath(policy, root) {
  const pending = [root];
  const visited = new Set();
  let entriesVisited = 0;

  while (pending.length > 0) {
    const directory = pending.pop();
    let canonicalDirectory;
    try {
      canonicalDirectory = realpathSync(directory);
    } catch {
      return true;
    }
    const canonicalKey = comparablePath(canonicalDirectory);
    if (visited.has(canonicalKey)) continue;
    visited.add(canonicalKey);

    let handle;
    try {
      handle = opendirSync(directory);
      while (true) {
        const entry = handle.readSync();
        if (entry == null) break;
        entriesVisited += 1;
        if (entriesVisited > 2000) return true;

        const child = path.join(directory, entry.name);
        let canonicalChild = path.join(canonicalDirectory, entry.name);
        if (entry.isSymbolicLink()) canonicalChild = realpathSync(child);
        if (
          !isContained(policy.canonicalRepositoryRoot, canonicalChild, true) ||
          isExcludedDiscoveryPath(policy, child, canonicalChild)
        ) {
          return true;
        }
        if (
          entry.isDirectory() ||
          (entry.isSymbolicLink() && statSync(child).isDirectory())
        ) {
          pending.push(child);
        }
      }
    } catch {
      return true;
    } finally {
      try {
        handle?.closeSync();
      } catch {
        // readSync may already have closed an exhausted directory.
      }
    }
  }

  return false;
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

  const pluginRead = validatePluginRead(payload, absolute, canonical);
  if (pluginRead != null) return pluginRead;

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
      'Approved storage state is opaque to governed agents. Pass only its exact policy-approved path to playwright-cli state-load; never read or modify the file.',
    );
  }

  if (isExplorer(payload)) {
    if (payload.tool_name !== 'Read') {
      return deny(
        'Explorer is read-only. It cannot create or modify repository or run files.',
      );
    }
    const policy = explorerPolicy(nearbyPolicies, absolute, canonical);
    if (
      policy == null ||
      isExcludedDiscoveryPath(policy, absolute, canonical)
    ) {
      return deny(
        'Explorer reads require one valid discovery policy and one contained source, test, or project-metadata file.',
      );
    }
    try {
      if (!statSync(absolute).isFile()) throw new Error('not a file');
    } catch {
      return deny(
        'Explorer may read only an existing regular repository file.',
      );
    }
    return decision('allow', 'Read is bound to the Explorer discovery policy.');
  }

  const generationPolicies = nearbyPolicies.filter(
    (policy) => policy.kind === 'generation',
  );
  if (generationPolicies.length === 0) {
    return deny(
      'Author and Healer access requires one valid generation policy. A discovery policy grants authority only to Explorer.',
    );
  }

  if (
    payload.tool_name === 'Read' &&
    payload.agent_type.endsWith('playwright-test-healer')
  ) {
    for (const policy of generationPolicies) {
      if (
        samePath(absolute, policy.approvedSpec) &&
        samePath(canonical, policy.canonicalApprovedSpec)
      ) {
        return decision('allow', 'Read is bound to the approved spec.');
      }

      for (const filename of ['handoff.json', 'healer-trace.json']) {
        const expected = path.join(policy.runDirectory, filename);
        if (!samePath(absolute, expected)) continue;
        const canonicalExpected = path.join(
          policy.canonicalRunDirectory,
          filename,
        );
        if (!samePath(canonical, canonicalExpected)) {
          return deny(
            'The requested run-artifact read escapes its approved canonical path.',
          );
        }
        return decision(
          'allow',
          'Read is bound to an exact Healer run artifact.',
        );
      }
    }
  }

  if (payload.tool_name === 'Read') return {};

  for (const policy of generationPolicies) {
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
      return decision(
        'allow',
        'Mutation is bound to the exact role-owned Testgen artifact.',
      );
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
    const aliasesMainOwned = generationPolicies.some((policy) => {
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

  const approved = generationPolicies.some((policy) => {
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

  return decision(
    'allow',
    'Mutation is bound to an exact run-policy write path.',
  );
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
      (isExplorer(payload) || policy.kind === 'generation') &&
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
      'Approved storage state is opaque to governed agents. Scope Grep to a source or test path that cannot include the policy-approved state file.',
    );
  }

  if (isExplorer(payload)) {
    const policy = explorerPolicy(policies, absolute, canonical);
    const {
      head_limit: headLimit,
      output_mode: outputMode,
      pattern,
    } = payload.tool_input;
    if (
      policy == null ||
      payload.tool_input.path == null ||
      samePath(absolute, policy.repositoryRoot) ||
      isExcludedDiscoveryPath(policy, absolute, canonical) ||
      (searchesDirectory &&
        searchMayReachExcludedDiscoveryPath(policy, absolute)) ||
      typeof pattern !== 'string' ||
      pattern.length === 0 ||
      pattern.length > 500 ||
      !Number.isInteger(headLimit) ||
      headLimit < 1 ||
      headLimit > 100 ||
      !['content', 'count', 'files_with_matches'].includes(outputMode)
    ) {
      return deny(
        'Explorer Grep requires one contained explicit path, a bounded pattern, an output mode, and head_limit from 1 to 100.',
      );
    }
    return decision(
      'allow',
      'Grep is bounded by the Explorer discovery policy.',
    );
  }

  return {};
}

function validateGlobAccess(payload) {
  const requestedPath = payload?.tool_input?.path;
  const pattern = payload?.tool_input?.pattern;
  const explorer = isExplorer(payload);
  if (
    (explorer &&
      (typeof requestedPath !== 'string' || requestedPath.length === 0)) ||
    (requestedPath != null && typeof requestedPath !== 'string') ||
    typeof pattern !== 'string' ||
    pattern.length === 0 ||
    pattern.length > 200 ||
    pattern === '**/*'
  ) {
    return deny(
      'Explorer Glob requires one contained explicit path and a bounded file pattern; an all-files scan is not allowed.',
    );
  }

  const absolute = path.resolve(payload.cwd, requestedPath ?? payload.cwd);
  let canonical;
  try {
    canonical = realpathSync(absolute);
  } catch {
    return deny('Glob requires an existing repository directory.');
  }
  const discovered = policiesNear(payload.cwd, absolute, canonical);
  if (discovered.invalid) {
    return deny(
      'A discovered Testgen run policy is invalid. Return to Main to repair or remove the invalid command-policy.json before governed access continues.',
    );
  }
  const matches = discovered.policies.filter(
    (policy) =>
      policy.kind === (explorer ? 'discovery' : 'generation') &&
      isContained(policy.repositoryRoot, absolute, true) &&
      isContained(policy.canonicalRepositoryRoot, canonical, true),
  );
  const policy = matches.length === 1 ? matches[0] : null;
  const linkedStateCouldBeInSearch = discovered.policies.some((candidate) =>
    candidate.allowedStatePaths.some((state) => {
      try {
        return statSync(state.absolute, { bigint: true }).nlink > 1n;
      } catch {
        return false;
      }
    }),
  );
  if (
    policy == null ||
    (explorer && samePath(absolute, policy.repositoryRoot)) ||
    (explorer && isExcludedDiscoveryPath(policy, absolute, canonical)) ||
    !statSync(absolute).isDirectory() ||
    (explorer && searchMayReachExcludedDiscoveryPath(policy, absolute)) ||
    linkedStateCouldBeInSearch ||
    policy.allowedStatePaths.some(
      (state) =>
        isContained(absolute, state.absolute, true) ||
        isContained(canonical, state.canonical, true),
    )
  ) {
    return deny(
      'Glob must stay inside one approved repository directory that excludes storage state.',
    );
  }
  return decision(
    'allow',
    explorer
      ? 'Glob is bounded by the Explorer discovery policy.'
      : 'Glob is bounded by the active Testgen run policy.',
  );
}

module.exports = {
  validateFileAccess,
  validateGlobAccess,
  validateGrepAccess,
};

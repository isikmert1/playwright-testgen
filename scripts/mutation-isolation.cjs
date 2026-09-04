const { spawnSync } = require('node:child_process');
const {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
} = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const {
  loadManifest,
  resolveRun,
  sameEntry,
  snapshotMap,
  validateArtifact,
} = require('./change-manifest.cjs');
const {
  definitionDigest,
  isIdentifier,
  parseAdapter,
} = require('./mutation-adapter.cjs');
const { isInside, portable } = require('./artifact-validation-common.cjs');
const { MutationCheckError } = require('./mutation-check-error.cjs');
const {
  captureSnapshot,
  currentHead,
  runGit,
} = require('./repository-snapshot.cjs');
const { comparablePath } = require('../hooks/run-policy.cjs');

const MAX_RUNNER_OUTPUT = 8 * 1024;

function fail(code) {
  throw new MutationCheckError(code);
}

function errorCode(error) {
  return error instanceof MutationCheckError ? error.code : 'internal-error';
}

function snapshotsMatch(left, right) {
  if (left.paths.length !== right.paths.length) return false;
  return left.paths.every(
    (entry, index) =>
      comparablePath(entry.path) === comparablePath(right.paths[index].path) &&
      sameEntry(entry, right.paths[index]),
  );
}

function requireHeadFile(repository, head, relativePath, clean) {
  const committed = runGit(repository, [
    'ls-tree',
    '-z',
    head,
    '--',
    relativePath,
  ]).toString('utf8');
  const separator = committed.indexOf('\t');
  const committedPath = committed.slice(separator + 1, -1);
  if (
    separator === -1 ||
    !/^100(?:644|755) blob [a-f0-9]+$/u.test(committed.slice(0, separator)) ||
    comparablePath(portable(committedPath)) !== comparablePath(relativePath)
  )
    fail('adapter-definition-not-committed');
  if (!clean) return;
  const status = runGit(repository, [
    'status',
    '--porcelain=v1',
    '-z',
    '--untracked-files=all',
    '--',
    relativePath,
  ]);
  if (status.length !== 0) fail('adapter-definition-dirty');
}

function approvedOverlay(repository, policy, manifest) {
  const preAuthor = snapshotMap(manifest.boundaries.pre_author);
  const entries = manifest.boundaries.post_healer.paths.filter(
    (entry) => !sameEntry(preAuthor.get(comparablePath(entry.path)), entry),
  );
  const approvedSpec = portable(path.relative(repository, policy.approvedSpec));
  if (
    !entries.some(
      (entry) => comparablePath(entry.path) === comparablePath(approvedSpec),
    )
  )
    fail('approved-spec-not-attributed');
  for (const entry of entries) {
    const source = path.resolve(repository, entry.path);
    try {
      if (
        entry.kind === 'untracked-symlink' ||
        !lstatSync(source).isFile() ||
        !isInside(repository, realpathSync(source))
      )
        fail('approved-change-not-copyable');
    } catch (error) {
      if (error instanceof MutationCheckError) throw error;
      fail('approved-change-not-copyable');
    }
  }
  return { approvedSpec, entries };
}

function safeDestination(worktree, relativePath) {
  const destination = path.resolve(worktree, relativePath);
  if (!isInside(worktree, destination)) fail('overlay-outside-isolation');
  const relativeParent = path.relative(worktree, path.dirname(destination));
  let current = worktree;
  for (const segment of relativeParent.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    if (!existsSync(current)) {
      mkdirSync(current);
      continue;
    }
    if (!lstatSync(current).isDirectory()) fail('overlay-parent-unsafe');
  }
  if (
    existsSync(destination) &&
    (!lstatSync(destination).isFile() ||
      !isInside(worktree, realpathSync(destination)))
  )
    fail('overlay-destination-unsafe');
  return destination;
}

function copyOverlay(repository, worktree, entries) {
  for (const entry of entries) {
    const source = path.resolve(repository, entry.path);
    const destination = safeDestination(worktree, entry.path);
    copyFileSync(source, destination);
    chmodSync(destination, statSync(source).mode & 0o777);
  }
}

function parseRunnerOutput(result) {
  if (result.error?.code === 'ETIMEDOUT') fail('runner-timeout');
  if (result.error != null || result.status !== 0) fail('runner-failed');
  if (Buffer.byteLength(result.stdout, 'utf8') > MAX_RUNNER_OUTPUT)
    fail('runner-output-too-large');
  let output;
  try {
    output = JSON.parse(result.stdout.trim());
  } catch {
    fail('runner-output-invalid');
  }
  if (
    typeof output !== 'object' ||
    output === null ||
    Array.isArray(output) ||
    output.protocol_version !== 1 ||
    !['pass', 'fail', 'error'].includes(output.outcome)
  )
    fail('runner-output-invalid');
  const keys = Object.keys(output).sort();
  const expectedKeys =
    output.outcome === 'error'
      ? ['criterion_id', 'outcome', 'protocol_version', 'reason']
      : ['criterion_id', 'outcome', 'protocol_version'];
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key, index) => key !== expectedKeys[index]) ||
    (output.outcome === 'pass' && output.criterion_id !== null) ||
    (output.outcome === 'fail' &&
      (typeof output.criterion_id !== 'string' ||
        !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/u.test(output.criterion_id))) ||
    (output.outcome === 'error' &&
      (output.criterion_id !== null ||
        typeof output.reason !== 'string' ||
        !/^[a-z][a-z0-9-]{0,79}$/u.test(output.reason)))
  )
    fail('runner-output-invalid');
  return output;
}

function runAdapter(worktree, parsed, mutation, spec, phase) {
  const runner = path.join(worktree, parsed.runner.relative);
  return parseRunnerOutput(
    spawnSync(
      process.execPath,
      [
        runner,
        '--phase',
        phase,
        '--spec',
        spec,
        '--criterion-id',
        mutation.criterion_id,
      ],
      {
        cwd: worktree,
        encoding: 'utf8',
        maxBuffer: MAX_RUNNER_OUTPUT,
        timeout: mutation.timeout_ms,
        windowsHide: true,
      },
    ),
  );
}

function changedPaths(before, after) {
  const left = snapshotMap(before);
  const right = snapshotMap(after);
  return [...new Set([...left.keys(), ...right.keys()])]
    .filter((key) => !sameEntry(left.get(key), right.get(key)))
    .sort((a, b) => a.localeCompare(b, 'en'));
}

function cleanupWorktree(repository, temporaryRoot, worktree) {
  try {
    if (worktree != null && existsSync(worktree))
      runGit(repository, ['worktree', 'remove', '--force', '--', worktree]);
  } catch {
    fail('isolation-cleanup-failed');
  }
  if (worktree != null && existsSync(worktree))
    fail('isolation-cleanup-failed');
  if (temporaryRoot != null)
    rmSync(temporaryRoot, { force: true, recursive: true });
  if (worktree != null) {
    const listing = runGit(repository, ['worktree', 'list', '--porcelain'])
      .toString('utf8')
      .split(/\r?\n/u)
      .filter((line) => line.startsWith('worktree '))
      .map((line) => path.resolve(line.slice('worktree '.length)));
    if (
      listing.some(
        (candidate) =>
          comparablePath(candidate) === comparablePath(path.resolve(worktree)),
      )
    )
      fail('isolation-cleanup-failed');
  }
}

function resultBase(parsed, mutation, digest) {
  return {
    adapter_id: parsed.adapter.adapter_id,
    mutation_id: mutation.mutation_id,
    criterion_id: mutation.criterion_id,
    definition_digest: digest,
    affected_paths: mutation.affected_paths,
  };
}

function verifyMutation(
  repositoryInput,
  runId,
  adapterInput,
  criterionId,
  approvalDigest,
) {
  const { policy, repository } = resolveRun(repositoryInput, runId);
  if (!isIdentifier(criterionId)) fail('criterion-id-invalid');
  const handoff = validateArtifact(repository, runId, 'handoff');
  const trace = validateArtifact(repository, runId, 'trace');
  if (trace.disposition !== 'fixed') fail('trace-not-fixed');
  if (!handoff.criteria.some(({ id }) => id === criterionId))
    fail('criterion-not-approved');
  if (adapterInput == null) {
    return {
      status: 'unavailable',
      criterion_id: criterionId,
      reason: 'adapter-absent',
    };
  }
  const { manifest } = loadManifest(policy, runId);
  if (manifest.boundaries.post_healer === null)
    fail('change-manifest-incomplete');
  if (currentHead(repository) !== manifest.head)
    fail('repository-head-changed');
  const activeBefore = captureSnapshot(repository, runId);
  if (!snapshotsMatch(activeBefore, manifest.boundaries.post_healer))
    fail('post-healer-state-mismatch');

  const parsed = parseAdapter(repository, adapterInput);
  requireHeadFile(repository, manifest.head, parsed.adapterFile.relative, true);
  const mutation = parsed.mutations.find(
    (candidate) => candidate.criterion_id === criterionId,
  );
  if (mutation == null) {
    return {
      status: 'unavailable',
      adapter_id: parsed.adapter.adapter_id,
      criterion_id: criterionId,
      reason: 'criterion-unmapped',
    };
  }
  const approvedSpecPath = comparablePath(
    portable(path.relative(repository, policy.approvedSpec)),
  );
  if (
    mutation.affected_paths.some(
      (affectedPath) => comparablePath(affectedPath) === approvedSpecPath,
    )
  )
    fail('mutation-targets-approved-spec');
  for (const definition of [parsed.runner, mutation.patch])
    requireHeadFile(repository, manifest.head, definition.relative, true);
  for (const affectedPath of mutation.affected_paths)
    requireHeadFile(repository, manifest.head, affectedPath, false);
  const digest = definitionDigest(parsed, mutation);
  // Computed, committed-manifest, and human-approved digests must all match.
  if (mutation.definition_digest !== digest || approvalDigest !== digest)
    fail('mutation-approval-mismatch');

  const overlay = approvedOverlay(repository, policy, manifest);
  const base = resultBase(parsed, mutation, digest);
  let temporaryRoot = null;
  let worktree = null;
  let baselineOutcome = null;
  let mutantOutcome = null;
  let result = null;
  try {
    temporaryRoot = mkdtempSync(path.join(tmpdir(), 'testgen-mutant-'));
    worktree = path.join(temporaryRoot, 'checkout');
    runGit(repository, [
      'worktree',
      'add',
      '--detach',
      '--quiet',
      worktree,
      manifest.head,
    ]);
    copyOverlay(repository, worktree, overlay.entries);
    const beforeBaseline = captureSnapshot(worktree, runId);
    const baseline = runAdapter(
      worktree,
      parsed,
      mutation,
      overlay.approvedSpec,
      'baseline',
    );
    baselineOutcome = baseline.outcome;
    if (!snapshotsMatch(beforeBaseline, captureSnapshot(worktree, runId)))
      fail('baseline-mutated-isolation');
    if (baseline.outcome !== 'pass') fail('baseline-not-passing');

    const beforePatch = captureSnapshot(worktree, runId);
    runGit(worktree, [
      'apply',
      '--whitespace=nowarn',
      '--',
      mutation.patch.relative,
    ]);
    const delta = changedPaths(beforePatch, captureSnapshot(worktree, runId));
    const expected = mutation.affected_paths
      .map(comparablePath)
      .sort((a, b) => a.localeCompare(b, 'en'));
    if (
      delta.length !== expected.length ||
      delta.some((value, index) => value !== expected[index])
    )
      fail('mutation-path-mismatch');

    const mutant = runAdapter(
      worktree,
      parsed,
      mutation,
      overlay.approvedSpec,
      'mutant',
    );
    mutantOutcome = mutant.outcome;
    if (mutant.outcome === 'error') fail('mutant-runner-error');
    if (
      mutant.outcome === 'fail' &&
      mutant.criterion_id !== mutation.criterion_id
    )
      fail('mutant-failure-unattributed');
    result = {
      status: mutant.outcome === 'fail' ? 'killed' : 'survived',
      ...base,
      baseline: 'pass',
      mutant: mutant.outcome,
      isolation: 'disposable-worktree',
    };
  } catch (error) {
    result = {
      status: 'verification-error',
      ...base,
      baseline: baselineOutcome,
      mutant: mutantOutcome,
      isolation: 'disposable-worktree',
      error: errorCode(error),
    };
  } finally {
    let cleanup = 'failed';
    let cleanupError = null;
    try {
      cleanupWorktree(repository, temporaryRoot, worktree);
      cleanup = 'removed';
    } catch (error) {
      cleanupError = errorCode(error);
    }
    let activeError = null;
    try {
      if (!snapshotsMatch(captureSnapshot(repository, runId), activeBefore))
        activeError = 'active-checkout-changed';
    } catch (error) {
      activeError = errorCode(error);
    }
    const finalError = activeError ?? cleanupError;
    if (finalError != null) {
      result = {
        status: 'verification-error',
        ...base,
        baseline: baselineOutcome,
        mutant: mutantOutcome,
        isolation: 'disposable-worktree',
        error: finalError,
      };
    }
    result.cleanup = cleanup;
  }
  return result;
}

module.exports = {
  changedPaths,
  parseRunnerOutput,
  snapshotsMatch,
  verifyMutation,
};

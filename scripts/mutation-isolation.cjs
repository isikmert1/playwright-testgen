const { spawn, spawnSync } = require('node:child_process');
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
  unlinkSync,
  writeFileSync,
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
const { definitionDigest, parseAdapter } = require('./mutation-adapter.cjs');
const {
  isIdentifier,
  isInside,
  portable,
} = require('./artifact-validation-common.cjs');
const { MutationCheckError } = require('./mutation-check-error.cjs');
const { loadHealerInput } = require('./validate-healer-input.cjs');
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
    const entry = lstatSync(current, { throwIfNoEntry: false });
    if (entry == null) {
      mkdirSync(current);
      continue;
    }
    if (!entry.isDirectory()) fail('overlay-parent-unsafe');
  }
  const entry = lstatSync(destination, { throwIfNoEntry: false });
  if (
    entry != null &&
    (!entry.isFile() || !isInside(worktree, realpathSync(destination)))
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
  if (result.error?.code === 'ECANCELED') fail('runner-cancelled');
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

function stopRunnerTree(child) {
  if (child.pid == null) return;
  if (process.platform === 'win32') {
    const stopped = spawnSync(
      'taskkill',
      ['/pid', String(child.pid), '/T', '/F'],
      { stdio: 'ignore', timeout: 5000, windowsHide: true },
    );
    if (stopped.error == null && stopped.status === 0) return;
  } else {
    try {
      process.kill(-child.pid, 'SIGKILL');
      return;
    } catch {
      // Fall back to the direct process when its group has already exited.
    }
  }
  try {
    child.kill('SIGKILL');
  } catch {
    // The process may have exited between the timeout and termination.
  }
}

function runAdapterProcess(runner, args, options) {
  return new Promise((resolve) => {
    const { signal, timeout, ...spawnOptions } = options;
    const child = spawn(process.execPath, [runner, ...args], {
      ...spawnOptions,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const chunks = [];
    let bytes = 0;
    let failure = null;
    let settled = false;
    let stopTimer = null;
    const finish = (status, error = failure) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(stopTimer);
      signal?.removeEventListener('abort', abort);
      resolve({
        error,
        status,
        stdout: Buffer.concat(chunks).toString('utf8'),
      });
    };
    const stop = (code) => {
      if (settled || failure != null) return;
      failure = { code };
      stopRunnerTree(child);
      stopTimer = setTimeout(() => finish(null), 5000);
    };
    const abort = () => stop('ECANCELED');
    const timer = setTimeout(() => stop('ETIMEDOUT'), timeout);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    child.stdout.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes <= MAX_RUNNER_OUTPUT) chunks.push(chunk);
      if (bytes > MAX_RUNNER_OUTPUT && failure == null) {
        stop('ENOBUFS');
      }
    });
    child.once('error', (error) => finish(null, error));
    child.once('close', (status) => finish(status));
  });
}

async function runAdapter(
  worktree,
  parsed,
  mutation,
  stepTitle,
  spec,
  phase,
  signal,
) {
  const runner = path.join(worktree, parsed.runner.relative);
  const result = await runAdapterProcess(
    runner,
    [
      '--phase',
      phase,
      '--spec',
      spec,
      '--criterion-id',
      mutation.criterion_id,
      '--step-title',
      stepTitle,
    ],
    {
      cwd: worktree,
      env: {
        ...process.env,
        TESTGEN_TARGET_NODE_MODULES: path.join(
          parsed.repository,
          'node_modules',
        ),
      },
      signal,
      timeout: mutation.timeout_ms,
      windowsHide: true,
    },
  );
  if (result.error?.code === 'ENOBUFS') fail('runner-output-too-large');
  return parseRunnerOutput(result);
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

function recoveryRecordPath(policy) {
  return path.join(policy.runDirectory, 'mutation-recovery.json');
}

function reserveRecoveryRecord(
  repository,
  policy,
  runId,
  temporaryRoot,
  worktree,
) {
  const filename = recoveryRecordPath(policy);
  try {
    writeFileSync(
      filename,
      `${JSON.stringify({
        schema_version: 'mutation-recovery.v1',
        run_id: runId,
        temporary_root: temporaryRoot,
        worktree,
      })}\n`,
      { encoding: 'utf8', flag: 'wx', mode: 0o600 },
    );
  } catch (error) {
    if (error?.code === 'EEXIST') fail('isolation-recovery-pending');
    fail('recovery-record-failed');
  }
  return portable(path.relative(repository, filename));
}

function removeRecoveryRecord(policy) {
  try {
    unlinkSync(recoveryRecordPath(policy));
  } catch {
    fail('recovery-record-remove-failed');
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

async function verifyMutation(
  repositoryInput,
  runId,
  adapterInput,
  mutationId,
  criterionId,
  approvalDigest,
  signal,
) {
  const { policy, repository } = resolveRun(repositoryInput, runId);
  if (existsSync(recoveryRecordPath(policy)))
    fail('isolation-recovery-pending');
  if (!isIdentifier(criterionId)) fail('criterion-id-invalid');
  const healerInput = loadHealerInput(repository, policy, runId);
  if (healerInput?.mode !== 'pipeline') fail('healer-input-not-pipeline');
  const handoff = validateArtifact(repository, runId, 'handoff');
  const trace = validateArtifact(repository, runId, 'trace');
  if (trace.disposition !== 'fixed') fail('trace-not-fixed');
  const criterion = handoff.criteria.find(({ id }) => id === criterionId);
  if (criterion == null) fail('criterion-not-approved');
  if (adapterInput == null) {
    if (mutationId != null || approvalDigest != null)
      fail('adapter-selection-invalid');
    return {
      status: 'unavailable',
      criterion_id: criterionId,
      reason: 'adapter-absent',
    };
  }
  if (mutationId != null && !isIdentifier(mutationId))
    fail('mutation-id-invalid');
  const parsed = parseAdapter(repository, adapterInput);
  const adapterHead = currentHead(repository);
  requireHeadFile(repository, adapterHead, parsed.adapterFile.relative, true);
  const mutation = parsed.mutations.find(
    (candidate) => candidate.criterion_id === criterionId,
  );
  if (mutation == null) {
    if (mutationId != null || approvalDigest != null)
      fail('mutation-criterion-mismatch');
    return {
      status: 'unavailable',
      adapter_id: parsed.adapter.adapter_id,
      criterion_id: criterionId,
      reason: 'criterion-unmapped',
    };
  }
  if (mutationId == null || approvalDigest == null)
    fail('mutation-approval-required');
  if (mutation.mutation_id !== mutationId) fail('mutation-criterion-mismatch');
  const { manifest } = loadManifest(policy, runId);
  if (manifest.boundaries.post_healer === null)
    fail('change-manifest-incomplete');
  if (adapterHead !== manifest.head) fail('repository-head-changed');
  const activeBefore = captureSnapshot(repository, runId);
  if (!snapshotsMatch(activeBefore, manifest.boundaries.post_healer))
    fail('post-healer-state-mismatch');
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
  let recoveryOwned = false;
  let recoveryRecord = null;
  try {
    temporaryRoot = mkdtempSync(path.join(tmpdir(), 'testgen-mutant-'));
    worktree = path.join(temporaryRoot, 'checkout');
    recoveryRecord = reserveRecoveryRecord(
      repository,
      policy,
      runId,
      temporaryRoot,
      worktree,
    );
    recoveryOwned = true;
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
    const baseline = await runAdapter(
      worktree,
      parsed,
      mutation,
      criterion.step_title,
      overlay.approvedSpec,
      'baseline',
      signal,
    );
    baselineOutcome = baseline.outcome;
    if (
      currentHead(worktree) !== manifest.head ||
      !snapshotsMatch(beforeBaseline, captureSnapshot(worktree, runId))
    )
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

    const beforeMutant = captureSnapshot(worktree, runId);
    const mutant = await runAdapter(
      worktree,
      parsed,
      mutation,
      criterion.step_title,
      overlay.approvedSpec,
      'mutant',
      signal,
    );
    mutantOutcome = mutant.outcome;
    if (
      currentHead(worktree) !== manifest.head ||
      !snapshotsMatch(beforeMutant, captureSnapshot(worktree, runId))
    )
      fail('mutant-mutated-isolation');
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
      if (recoveryOwned) removeRecoveryRecord(policy);
      cleanup = 'removed';
    } catch (error) {
      cleanupError = errorCode(error);
    }
    let activeError = null;
    try {
      if (currentHead(repository) !== adapterHead) {
        activeError = 'active-head-changed';
      } else if (
        !snapshotsMatch(captureSnapshot(repository, runId), activeBefore)
      )
        activeError = 'active-checkout-changed';
    } catch (error) {
      activeError = errorCode(error);
    }
    const primaryError =
      result?.status === 'verification-error' ? result.error : null;
    const finalError = primaryError ?? activeError ?? cleanupError;
    if (finalError != null) {
      result = {
        status: 'verification-error',
        ...base,
        baseline: baselineOutcome,
        mutant: mutantOutcome,
        isolation: 'disposable-worktree',
        error: finalError,
      };
      if (activeError != null && activeError !== finalError)
        result.active_error = activeError;
      if (cleanupError != null) {
        result.cleanup_error = cleanupError;
        if (recoveryOwned) result.recovery_record = recoveryRecord;
      }
    }
    result.cleanup = cleanup;
  }
  return result;
}

module.exports = { verifyMutation };

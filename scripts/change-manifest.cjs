const { spawnSync } = require('node:child_process');
const { createHash, randomBytes } = require('node:crypto');
const {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} = require('node:fs');
const path = require('node:path');
const {
  RUN_ID,
  comparablePath,
  loadPolicy,
  normalizePath,
  samePath,
} = require('../hooks/run-policy.cjs');
const { isInside } = require('./artifact-validation-common.cjs');
const { MutationCheckError, fail } = require('./mutation-check-error.cjs');
const {
  HEAD,
  MAX_PATHS,
  captureSnapshot,
  comparePaths,
  currentHead,
  isRunScratch,
} = require('./repository-snapshot.cjs');

const MAX_MANIFEST_SIZE = 512 * 1024;
const FINGERPRINT = /^[a-f0-9]{64}$/u;
const VALID_KINDS = new Set(['tracked', 'untracked-file', 'untracked-symlink']);

function resolveRun(repositoryInput, runId) {
  if (!RUN_ID.test(runId ?? '')) fail('invalid-run-id');
  let repository;
  try {
    repository = realpathSync(repositoryInput);
  } catch {
    fail('repository-unavailable');
  }
  const policy = loadPolicy(repository, runId);
  if (policy == null) fail('run-policy-unavailable');
  return { policy, repository };
}

function writeManifest(destination, manifest) {
  mkdirSync(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`, {
      flag: 'wx',
      mode: 0o600,
    });
    renameSync(temporary, destination);
  } finally {
    if (existsSync(temporary)) rmSync(temporary, { force: true });
  }
}

function capturePreAuthor(repositoryInput, runId) {
  const { policy, repository } = resolveRun(repositoryInput, runId);
  const manifestPath = path.join(policy.runDirectory, 'change-manifest.json');
  if (existsSync(manifestPath)) fail('change-manifest-exists');
  const manifest = {
    schema_version: 'change-manifest.v1',
    run_id: runId,
    head: currentHead(repository),
    boundaries: {
      pre_author: captureSnapshot(repository, runId),
      checkpoint: null,
      post_healer: null,
    },
  };
  writeManifest(manifestPath, manifest);
  return {
    boundary: 'pre-author',
    manifest_path: normalizePath(path.relative(repository, manifestPath)),
    run_id: runId,
  };
}

function objectWithKeys(value, keys) {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function validSnapshot(value, runId, repository) {
  if (
    !objectWithKeys(value, ['paths']) ||
    !Array.isArray(value.paths) ||
    value.paths.length > MAX_PATHS
  )
    return false;
  const seen = new Set();
  let previous = null;
  for (const entry of value.paths) {
    if (
      !objectWithKeys(entry, ['path', 'kind', 'fingerprint']) ||
      typeof entry.path !== 'string' ||
      entry.path.length === 0 ||
      entry.path.length > 240 ||
      path.isAbsolute(entry.path) ||
      entry.path.includes('\0') ||
      normalizePath(path.normalize(entry.path)) !== entry.path ||
      !isInside(repository, path.resolve(repository, entry.path)) ||
      isRunScratch(entry.path, runId) ||
      !VALID_KINDS.has(entry.kind) ||
      !FINGERPRINT.test(entry.fingerprint)
    )
      return false;
    const comparable = comparablePath(entry.path);
    if (
      seen.has(comparable) ||
      (previous != null && comparePaths(previous, entry.path) >= 0)
    )
      return false;
    seen.add(comparable);
    previous = entry.path;
  }
  return true;
}

function loadManifest(policy, runId) {
  const manifestPath = path.join(policy.runDirectory, 'change-manifest.json');
  try {
    if (
      !statSync(manifestPath).isFile() ||
      statSync(manifestPath).size > MAX_MANIFEST_SIZE ||
      !samePath(
        realpathSync(manifestPath),
        path.join(policy.canonicalRunDirectory, 'change-manifest.json'),
      )
    )
      fail('change-manifest-unavailable');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (
      !objectWithKeys(manifest, [
        'schema_version',
        'run_id',
        'head',
        'boundaries',
      ]) ||
      manifest.schema_version !== 'change-manifest.v1' ||
      manifest.run_id !== runId ||
      !HEAD.test(manifest.head ?? '') ||
      !objectWithKeys(manifest.boundaries, [
        'pre_author',
        'checkpoint',
        'post_healer',
      ]) ||
      !validSnapshot(
        manifest.boundaries.pre_author,
        runId,
        policy.repositoryRoot,
      ) ||
      (manifest.boundaries.checkpoint !== null &&
        !validSnapshot(
          manifest.boundaries.checkpoint,
          runId,
          policy.repositoryRoot,
        )) ||
      (manifest.boundaries.post_healer !== null &&
        !validSnapshot(
          manifest.boundaries.post_healer,
          runId,
          policy.repositoryRoot,
        )) ||
      (manifest.boundaries.checkpoint === null &&
        manifest.boundaries.post_healer !== null)
    )
      fail('change-manifest-invalid');
    return { manifest, manifestPath };
  } catch (error) {
    if (error instanceof MutationCheckError) throw error;
    fail('change-manifest-unavailable');
  }
}

function validateArtifact(repository, runId, type) {
  const filename = type === 'handoff' ? 'handoff.json' : 'healer-trace.json';
  const relative = `.playwright-cli/testgen/${runId}/${filename}`;
  const artifactPath = path.join(repository, relative);
  const validator = path.join(__dirname, 'validate-testgen-artifact.cjs');
  let before;
  try {
    if (statSync(artifactPath).size > 64 * 1024)
      fail(`${type}-artifact-invalid`);
    before = readFileSync(artifactPath);
  } catch (error) {
    if (error instanceof MutationCheckError) throw error;
    fail(`${type}-artifact-unavailable`);
  }
  const result = spawnSync(
    process.execPath,
    [
      validator,
      '--repo',
      repository,
      '--type',
      type,
      '--run-id',
      runId,
      relative,
    ],
    {
      cwd: repository,
      encoding: 'utf8',
      maxBuffer: 128 * 1024,
      windowsHide: true,
    },
  );
  if (result.error != null || result.status !== 0)
    fail(`${type}-artifact-invalid`);
  try {
    const after = readFileSync(artifactPath);
    if (
      createHash('sha256').update(before).digest('hex') !==
      createHash('sha256').update(after).digest('hex')
    )
      fail(`${type}-artifact-changed`);
    return JSON.parse(after.toString('utf8'));
  } catch (error) {
    if (error instanceof MutationCheckError) throw error;
    fail(`${type}-artifact-unavailable`);
  }
}

function snapshotMap(snapshot) {
  return new Map(
    snapshot.paths.map((entry) => [comparablePath(entry.path), entry]),
  );
}

function sameEntry(left, right) {
  return (
    left != null &&
    right != null &&
    left.kind === right.kind &&
    left.fingerprint === right.fingerprint
  );
}

function requirePreExistingUnchanged(preAuthor, current) {
  const currentPaths = snapshotMap(current);
  for (const entry of preAuthor.paths) {
    if (!sameEntry(entry, currentPaths.get(comparablePath(entry.path))))
      fail('pre-existing-change-modified');
  }
}

function captureCheckpoint(repository, runId, manifest) {
  if (
    manifest.boundaries.checkpoint !== null ||
    manifest.boundaries.post_healer !== null
  )
    fail('boundary-already-captured');
  const handoff = validateArtifact(repository, runId, 'handoff');
  const current = captureSnapshot(repository, runId);
  requirePreExistingUnchanged(manifest.boundaries.pre_author, current);
  const preAuthor = snapshotMap(manifest.boundaries.pre_author);
  const touched = new Set(handoff.touched_paths.map(comparablePath));
  for (const entry of current.paths) {
    if (
      !preAuthor.has(comparablePath(entry.path)) &&
      !touched.has(comparablePath(entry.path))
    )
      fail('undeclared-author-change');
  }
  manifest.boundaries.checkpoint = current;
}

function capturePostHealer(repository, runId, manifest) {
  if (
    manifest.boundaries.checkpoint === null ||
    manifest.boundaries.post_healer !== null
  )
    fail('boundary-out-of-order');
  const trace = validateArtifact(repository, runId, 'trace');
  const current = captureSnapshot(repository, runId);
  requirePreExistingUnchanged(manifest.boundaries.pre_author, current);
  const checkpoint = snapshotMap(manifest.boundaries.checkpoint);
  const currentPaths = snapshotMap(current);
  const repaired = new Set(
    trace.repairs.flatMap((repair) => repair.paths).map(comparablePath),
  );
  for (const key of new Set([...checkpoint.keys(), ...currentPaths.keys()])) {
    if (
      !sameEntry(checkpoint.get(key), currentPaths.get(key)) &&
      !repaired.has(key)
    )
      fail('undeclared-healer-change');
  }
  manifest.boundaries.post_healer = current;
}

function captureBoundary(repositoryInput, runId, boundary) {
  if (boundary === 'pre-author')
    return capturePreAuthor(repositoryInput, runId);
  const { policy, repository } = resolveRun(repositoryInput, runId);
  const { manifest, manifestPath } = loadManifest(policy, runId);
  if (currentHead(repository) !== manifest.head)
    fail('repository-head-changed');
  if (boundary === 'checkpoint') captureCheckpoint(repository, runId, manifest);
  else if (boundary === 'post-healer')
    capturePostHealer(repository, runId, manifest);
  else fail('invalid-boundary');
  writeManifest(manifestPath, manifest);
  return {
    boundary,
    manifest_path: normalizePath(path.relative(repository, manifestPath)),
    run_id: runId,
  };
}

module.exports = {
  captureBoundary,
  loadManifest,
  resolveRun,
  sameEntry,
  snapshotMap,
  validateArtifact,
};

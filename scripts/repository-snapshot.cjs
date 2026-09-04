const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const {
  closeSync,
  lstatSync,
  openSync,
  readSync,
  readlinkSync,
} = require('node:fs');
const path = require('node:path');
const { comparablePath, normalizePath } = require('../hooks/run-policy.cjs');
const { isInside } = require('./artifact-validation-common.cjs');
const { fail } = require('./mutation-check-error.cjs');

const MAX_GIT_OUTPUT = 8 * 1024 * 1024;
const MAX_PATHS = 2000;
const HEAD = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;

function runGit(repository, args) {
  const result = spawnSync('git', ['--literal-pathspecs', ...args], {
    cwd: repository,
    encoding: null,
    maxBuffer: MAX_GIT_OUTPUT,
    windowsHide: true,
  });
  if (result.error != null || result.status !== 0) fail('git-command-failed');
  return result.stdout;
}

function nulPaths(repository, args) {
  const output = runGit(repository, args);
  const values = output.toString('utf8').split('\0');
  values.pop();
  return values.map(normalizePath);
}

function isRunScratch(relativePath, runId) {
  const candidate = comparablePath(relativePath);
  const owned = comparablePath(`.playwright-cli/testgen/${runId}`);
  return candidate === owned || candidate.startsWith(`${owned}/`);
}

function comparePaths(left, right) {
  const first = comparablePath(left);
  const second = comparablePath(right);
  return first < second ? -1 : first > second ? 1 : 0;
}

function hashRegularFile(filename, prefix) {
  const hash = createHash('sha256').update(prefix);
  const buffer = Buffer.allocUnsafe(64 * 1024);
  const descriptor = openSync(filename, 'r');
  try {
    let bytesRead;
    while ((bytesRead = readSync(descriptor, buffer, 0, buffer.length)) > 0)
      hash.update(buffer.subarray(0, bytesRead));
  } finally {
    closeSync(descriptor);
  }
  return hash.digest('hex');
}

function fingerprintTracked(repository, relativePath) {
  const index = runGit(repository, [
    'diff',
    '--cached',
    '--binary',
    '--full-index',
    '--no-ext-diff',
    '--no-textconv',
    '--no-renames',
    'HEAD',
    '--',
    relativePath,
  ]);
  const worktree = runGit(repository, [
    'diff',
    '--binary',
    '--full-index',
    '--no-ext-diff',
    '--no-textconv',
    '--no-renames',
    '--',
    relativePath,
  ]);
  return createHash('sha256')
    .update('index\0')
    .update(index)
    .update('worktree\0')
    .update(worktree)
    .digest('hex');
}

function fingerprintUntracked(repository, relativePath) {
  const absolute = path.resolve(repository, relativePath);
  let information;
  try {
    information = lstatSync(absolute);
  } catch {
    fail('repository-state-changed');
  }
  if (information.isFile()) {
    return {
      fingerprint: hashRegularFile(absolute, 'file\0'),
      kind: 'untracked-file',
    };
  }
  if (information.isSymbolicLink()) {
    return {
      fingerprint: createHash('sha256')
        .update('symlink\0')
        .update(readlinkSync(absolute))
        .digest('hex'),
      kind: 'untracked-symlink',
    };
  }
  fail('unsupported-dirty-path');
}

function captureSnapshot(repository, runId) {
  const tracked = new Set([
    ...nulPaths(repository, [
      'diff',
      '--cached',
      '--name-only',
      '--no-renames',
      '-z',
      'HEAD',
      '--',
    ]),
    ...nulPaths(repository, [
      'diff',
      '--name-only',
      '--no-renames',
      '-z',
      '--',
    ]),
  ]);
  const untracked = nulPaths(repository, [
    'ls-files',
    '--others',
    '--exclude-standard',
    '-z',
    '--',
  ]);
  const dirtyPaths = [...tracked, ...untracked]
    .filter((value) => !isRunScratch(value, runId))
    .sort(comparePaths);
  if (dirtyPaths.length > MAX_PATHS) fail('too-many-dirty-paths');
  if (
    dirtyPaths.some(
      (value) =>
        value.length === 0 ||
        value.length > 240 ||
        normalizePath(path.normalize(value)) !== value ||
        !isInside(repository, path.resolve(repository, value)),
    )
  )
    fail('dirty-path-invalid');

  return {
    paths: dirtyPaths.map((relativePath) => {
      if (tracked.has(relativePath)) {
        return {
          path: relativePath,
          kind: 'tracked',
          fingerprint: fingerprintTracked(repository, relativePath),
        };
      }
      return {
        path: relativePath,
        ...fingerprintUntracked(repository, relativePath),
      };
    }),
  };
}

function currentHead(repository) {
  const head = runGit(repository, ['rev-parse', '--verify', 'HEAD'])
    .toString('utf8')
    .trim();
  if (!HEAD.test(head)) fail('repository-head-invalid');
  return head;
}

module.exports = {
  HEAD,
  MAX_PATHS,
  captureSnapshot,
  comparePaths,
  currentHead,
  isRunScratch,
  runGit,
};

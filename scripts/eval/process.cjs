const { execFile, spawn, spawnSync } = require('node:child_process');
const { readFileSync, readdirSync } = require('node:fs');
const path = require('node:path');
const { windowsProcessTree } = require('../windows-process-tree.cjs');

const repositoryRoot = path.resolve(__dirname, '../..');

const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

const LIFECYCLE_COMMAND_TIMEOUT_MS = 120_000;

const SAFE_ERROR_CODE = /^[a-z][a-z0-9-]{0,79}$/u;

const executableCache = new Map();

class EvaluationError extends Error {
  constructor(code, details = []) {
    super(code);
    this.code = code;
    this.details = details
      .filter((value) => SAFE_ERROR_CODE.test(value))
      .slice(0, 12);
  }
}

function fail(code, details = []) {
  throw new EvaluationError(code, details);
}

function executable(name) {
  if (process.platform !== 'win32') return name;
  if (executableCache.has(name)) return executableCache.get(name);
  const found = spawnSync('where.exe', [name], {
    encoding: 'utf8',
    timeout: 5000,
    windowsHide: true,
  });
  if (found.status !== 0) fail(`${name}-unavailable`);
  const candidates = found.stdout.split(/\r?\n/u).filter(Boolean);
  const selected =
    candidates.find((value) => /\.(?:exe|com)$/iu.test(value)) ??
    candidates.find((value) => /\.(?:cmd|bat)$/iu.test(value)) ??
    candidates[0];
  if (selected == null) fail(`${name}-unavailable`);
  executableCache.set(name, selected);
  return selected;
}

async function command(commandName, args, options = {}) {
  const result = await runBounded(commandName, args, {
    capture_stderr: options.capture_stderr,
    cwd: options.cwd ?? repositoryRoot,
    env: options.env ?? process.env,
    input: options.input,
    signal: options.signal,
    timeout_ms: options.timeout_ms ?? LIFECYCLE_COMMAND_TIMEOUT_MS,
    verify_process_tree: true,
  });
  if (result.tree_cleanup_failed)
    fail('process-tree-cleanup-failed', [result.tree_cleanup_reason]);
  if (result.cancelled) fail('evaluation-cancelled');
  if (result.timed_out) fail('lifecycle-command-timeout');
  if (
    result.output_overflow ||
    result.spawn_error != null ||
    result.status !== 0
  )
    fail(options.error ?? 'prerequisite-unavailable');
  return result.output.trim();
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function processTreeExists(pid) {
  if (process.platform === 'linux') {
    try {
      for (const name of readdirSync('/proc')) {
        if (!/^\d+$/u.test(name)) continue;
        let stat;
        try {
          stat = readFileSync(`/proc/${name}/stat`, 'utf8');
        } catch (error) {
          if (error.code === 'ENOENT' || error.code === 'ESRCH') continue;
          return null;
        }
        const end = stat.lastIndexOf(')');
        const fields = stat
          .slice(end + 2)
          .trim()
          .split(/\s+/u);
        if (end < 0 || fields.length < 3) return null;
        if (Number(fields[2]) === pid && fields[0] !== 'Z' && fields[0] !== 'X')
          return true;
      }
      return false;
    } catch {
      return null;
    }
  }
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return processExists(pid);
  }
}

async function stopProcessTree(child, diagnostics = {}) {
  if (child == null || child.pid == null) return true;
  const pid = child.pid;
  const failed = (reason) => {
    diagnostics.reason = reason;
    return false;
  };
  try {
    if (process.platform === 'win32') {
      const onSnapshotFailure = (reason) => {
        diagnostics.reason = reason;
      };
      const initial = await windowsProcessTree(pid, [], onSnapshotFailure);
      if (initial == null)
        return failed(diagnostics.reason ?? 'snapshot-unavailable');
      const known = new Set(initial.descendants);
      if (!initial.root_exists && known.size === 0) return true;
      const terminate = (target) => {
        const result = spawnSync(
          'taskkill.exe',
          ['/pid', String(target), '/t', '/f'],
          {
            stdio: 'ignore',
            timeout: 5000,
            windowsHide: true,
          },
        );
        if (result.error == null && result.status === 0) return true;
        try {
          process.kill(target, 'SIGKILL');
          return true;
        } catch {
          return false;
        }
      };
      let rootTerminated = !initial.root_exists;
      if (initial.root_exists) rootTerminated = terminate(pid);
      else for (const target of [...known].reverse()) terminate(target);

      for (let attempt = 0; attempt < 3; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        const current = await windowsProcessTree(pid, known, onSnapshotFailure);
        if (current == null)
          return failed(diagnostics.reason ?? 'snapshot-unavailable');
        for (const target of current.descendants) known.add(target);
        if (
          !current.root_exists &&
          current.known_running.length === 0 &&
          current.descendants.length === 0
        )
          return true;
        for (const target of [
          ...new Set([...current.descendants, ...current.known_running]),
        ].reverse())
          terminate(target);
        if (current.root_exists && !rootTerminated)
          rootTerminated = terminate(pid);
      }
      return failed(
        rootTerminated ? 'process-still-running' : 'termination-failed',
      );
    } else {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        if (processExists(pid)) child.kill('SIGKILL');
      }
    }
  } catch {
    return failed('cleanup-exception');
  }

  for (let attempt = 0; attempt < 20; attempt += 1) {
    const exists = processTreeExists(pid);
    if (exists === false) return true;
    if (exists == null) return failed('snapshot-unavailable');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return failed('process-still-running');
}

function runBounded(commandName, args, options) {
  return new Promise((resolve) => {
    let output = '';
    let errorOutput = '';
    let outputBytes = 0;
    let timedOut = false;
    let cancelled = false;
    let overflow = false;
    let treeCleanupFailed = false;
    let treeCleanupReason = null;
    let settled = false;
    let stopTimer = null;
    let stopping = null;
    if (options.signal?.aborted) {
      resolve({
        cancelled: true,
        output: '',
        ...(options.capture_stderr === true ? { error_output: '' } : {}),
        output_overflow: false,
        signal: null,
        spawn_error: null,
        status: null,
        timed_out: false,
        tree_cleanup_failed: false,
        tree_cleanup_reason: null,
      });
      return;
    }
    const child = spawn(commandName, args, {
      cwd: options.cwd,
      detached: process.platform !== 'win32',
      env: options.env,
      stdio: [options.input == null ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      windowsHide: true,
      ...(process.platform === 'win32' && /\.(?:cmd|bat)$/iu.test(commandName)
        ? { shell: true }
        : {}),
    });
    const finish = (status, signal, spawnError = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (stopTimer != null) clearTimeout(stopTimer);
      options.signal?.removeEventListener('abort', cancel);
      resolve({
        cancelled,
        output,
        ...(options.capture_stderr === true
          ? { error_output: errorOutput }
          : {}),
        output_overflow: overflow,
        signal,
        spawn_error: spawnError,
        status,
        timed_out: timedOut,
        tree_cleanup_failed: treeCleanupFailed,
        tree_cleanup_reason: treeCleanupReason,
      });
    };
    const ensureStopped = () => {
      const diagnostics = {};
      stopping ??= stopProcessTree(child, diagnostics).then((stopped) => {
        if (!stopped) {
          treeCleanupFailed = true;
          treeCleanupReason = diagnostics.reason ?? 'cleanup-unverified';
        }
      });
      return stopping;
    };
    const terminate = () => {
      if (stopping != null) return;
      if (process.platform === 'win32') {
        execFile(
          'taskkill.exe',
          ['/pid', String(child.pid), '/t', '/f'],
          { timeout: 5000, windowsHide: true },
          (error) => {
            if (error != null) child.kill('SIGKILL');
          },
        );
      }
      void ensureStopped().then(() => finish(child.exitCode, 'terminated'));
      stopTimer ??= setTimeout(() => {
        treeCleanupFailed = true;
        treeCleanupReason = 'stop-timeout';
        finish(null, 'forced-stop');
      }, 5000);
    };
    const cancel = () => {
      cancelled = true;
      terminate();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, options.timeout_ms);
    options.signal?.addEventListener('abort', cancel, { once: true });
    if (options.signal?.aborted) cancel();
    if (options.input != null) {
      child.stdin.on('error', () => {});
      child.stdin.end(options.input);
    }
    child.stdout.on('data', (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_OUTPUT_BYTES) {
        overflow = true;
        terminate();
        return;
      }
      output += chunk.toString('utf8');
    });
    if (options.capture_stderr === true)
      child.stderr.on('data', (chunk) => {
        outputBytes += chunk.length;
        if (outputBytes > MAX_OUTPUT_BYTES) {
          overflow = true;
          terminate();
          return;
        }
        errorOutput += chunk.toString('utf8');
      });
    else child.stderr.resume();
    child.once('error', (error) => finish(null, null, error.code ?? 'error'));
    child.once('close', (status, signal) => {
      clearTimeout(timer);
      if (options.verify_process_tree === true || stopping != null) {
        void ensureStopped().then(() => finish(status, signal));
        return;
      }
      finish(status, signal);
    });
  });
}

function lifecycleCancellation() {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  return {
    signal: controller.signal,
    dispose() {
      process.off('SIGINT', cancel);
      process.off('SIGTERM', cancel);
    },
  };
}

module.exports = {
  EvaluationError,
  LIFECYCLE_COMMAND_TIMEOUT_MS,
  SAFE_ERROR_CODE,
  command,
  executable,
  fail,
  lifecycleCancellation,
  runBounded,
  stopProcessTree,
  windowsProcessTree,
};

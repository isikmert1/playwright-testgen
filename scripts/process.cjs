const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const { readFileSync, readdirSync } = require('node:fs');
const path = require('node:path');
const { startWindowsJob } = require('./windows-process-tree.cjs');

const repositoryRoot = path.resolve(__dirname, '..');

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
  assertProcessStopped(result);
  if (result.cancelled) fail('evaluation-cancelled');
  if (result.timed_out) fail('lifecycle-command-timeout');
  if (
    result.output_overflow ||
    result.spawn_error != null ||
    result.status !== 0
  ) {
    const details = [result.spawn_error, result.windows_status].filter(
      (value) =>
        typeof value === 'string' && /^windows-(?:job|status)-/u.test(value),
    );
    fail(options.error ?? 'prerequisite-unavailable', details);
  }
  return result.output.trim();
}

function assertProcessStopped(result) {
  if (!result.tree_cleanup_failed) return;
  const error = new EvaluationError('process-tree-cleanup-failed', [
    result.tree_cleanup_reason ?? 'cleanup-unverified',
    ...(result.windows_status == null ? [] : [result.windows_status]),
  ]);
  if (
    Number.isSafeInteger(result.tree_cleanup_pid) &&
    result.tree_cleanup_pid > 0
  )
    error.cleanup_pid = result.tree_cleanup_pid;
  throw error;
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
      // The evaluator's forked HTTP fixture is a single process. Commands that
      // can launch descendants use runBounded and are assigned to a job.
      if (child.exitCode != null || child.signalCode != null) return true;
      const exited = once(child, 'exit', { signal: AbortSignal.timeout(5000) });
      child.kill('SIGKILL');
      await exited;
      return true;
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

function emptyResult(options) {
  return {
    cancelled: options.signal?.aborted === true,
    output: '',
    ...(options.capture_stderr === true ? { error_output: '' } : {}),
    output_overflow: false,
    signal: null,
    spawn_error: null,
    status: null,
    timed_out: false,
    tree_cleanup_failed: false,
    tree_cleanup_reason: null,
  };
}

async function runBounded(commandName, args, options) {
  if (options.signal?.aborted) return emptyResult(options);
  const windows = process.platform === 'win32';
  if (windows && /\.(?:cmd|bat)$/iu.test(commandName))
    fail('batch-wrapper-unsupported');
  const spawnOptions = {
    cwd: options.cwd,
    detached: !windows,
    env: options.env,
    stdio: [options.input == null ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    windowsHide: true,
  };
  let job;
  if (windows) {
    try {
      job = await startWindowsJob(
        commandName,
        args,
        spawnOptions,
        options.verify_process_tree !== true,
      );
    } catch (error) {
      if (error instanceof TypeError) throw error;
      return {
        ...emptyResult(options),
        spawn_error: error.code ?? 'windows-job-startup-failed',
        windows_status: error.nativeStatus ?? null,
      };
    }
  }
  const child = job?.child ?? spawn(commandName, args, spawnOptions);
  const stdout = job?.stdout ?? child.stdout;
  const stderr = job?.stderr ?? child.stderr;

  return new Promise((resolve) => {
    const result = emptyResult(options);
    let outputBytes = 0;
    let settled = false;
    let stopTimer = null;
    let stopping = null;
    const finish = (
      status,
      signal,
      spawnError = null,
      windowsStatus = null,
    ) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (stopTimer != null) clearTimeout(stopTimer);
      options.signal?.removeEventListener('abort', cancel);
      const cleanupPid = job ? job.pid : child.pid;
      resolve({
        ...result,
        signal,
        spawn_error: spawnError,
        status,
        ...(result.tree_cleanup_failed && cleanupPid != null
          ? { tree_cleanup_pid: cleanupPid }
          : {}),
        ...(windowsStatus == null ? {} : { windows_status: windowsStatus }),
      });
    };
    const ensureStopped = () => {
      const diagnostics = {};
      stopping ??= stopProcessTree(child, diagnostics).then((stopped) => {
        if (!stopped) {
          result.tree_cleanup_failed = true;
          result.tree_cleanup_reason =
            diagnostics.reason ?? 'cleanup-unverified';
        }
      });
      return stopping;
    };
    const boundShutdown = () => {
      stopTimer = setTimeout(() => {
        result.tree_cleanup_failed = true;
        result.tree_cleanup_reason = 'stop-timeout';
        job?.abandon();
        finish(null, 'forced-stop');
      }, 5000);
    };
    const terminate = () => {
      if (stopTimer != null || stopping != null || settled) return;
      if (job) job.stop();
      else
        void ensureStopped().then(() => finish(child.exitCode, 'terminated'));
      boundShutdown();
    };
    const cancel = () => {
      result.cancelled = true;
      terminate();
    };
    const timer = setTimeout(() => {
      result.timed_out = true;
      terminate();
    }, options.timeout_ms);
    options.signal?.addEventListener('abort', cancel, { once: true });
    if (options.signal?.aborted) cancel();
    if (options.input != null) {
      child.stdin.on('error', () => {});
      child.stdin.end(options.input);
    }
    const capture = (stream, field) => {
      stream.on('data', (chunk) => {
        outputBytes += chunk.length;
        if (outputBytes > (options.max_output_bytes ?? MAX_OUTPUT_BYTES)) {
          result.output_overflow = true;
          terminate();
          return;
        }
        result[field] += chunk.toString('utf8');
      });
    };
    capture(stdout, 'output');
    if (options.capture_stderr === true) capture(stderr, 'error_output');
    else stderr.resume();
    child.once('error', (error) => finish(null, null, error.code ?? 'error'));
    child.once('close', async (status, signal) => {
      if (job) {
        const jobResult = await job.result(status);
        result.tree_cleanup_reason = jobResult.tree_cleanup_reason ?? null;
        result.tree_cleanup_failed = result.tree_cleanup_reason != null;
        finish(
          jobResult.status,
          signal,
          jobResult.spawn_error,
          jobResult.windows_status,
        );
        return;
      }
      clearTimeout(timer);
      if (options.verify_process_tree === true || stopping != null) {
        void ensureStopped().then(() => finish(status, signal));
        return;
      }
      finish(status, signal);
    });
    if (!result.cancelled)
      job?.start(() => {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', cancel);
        boundShutdown();
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
  assertProcessStopped,
  EvaluationError,
  LIFECYCLE_COMMAND_TIMEOUT_MS,
  SAFE_ERROR_CODE,
  command,
  executable,
  fail,
  lifecycleCancellation,
  runBounded,
  stopProcessTree,
};

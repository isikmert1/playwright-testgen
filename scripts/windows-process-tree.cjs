const { execFile, spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { once } = require('node:events');
const { mkdtempSync, rmSync, rmdirSync } = require('node:fs');
const net = require('node:net');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { createInterface } = require('node:readline');

const startupTimeoutMs = 5000;
const dllInitFailed = 0xc0000142;
let compiledHelper;

function nativeStatus(code) {
  return Number.isInteger(code) && code !== 0
    ? 'windows-status-' + (code >>> 0).toString(16).padStart(8, '0')
    : null;
}

function startupError(code, status) {
  return Object.assign(new Error(code), {
    code,
    nativeStatus: nativeStatus(status),
  });
}

async function retryDllInitialization(operation) {
  try {
    return await operation();
  } catch (error) {
    // The caller has not sent a launch request yet.
    if (error.nativeStatus !== nativeStatus(dllInitFailed)) throw error;
  }
  return operation();
}

async function compileHelper() {
  const directory = mkdtempSync(path.join(tmpdir(), 'testgen-win-job-'));
  const application = path.join(directory, 'testgen-windows-job.exe');
  const discard = () => {
    try {
      rmSync(application, { force: true });
      rmdirSync(directory);
    } catch {
      // An open image may briefly outlive the evaluator on shutdown.
    }
  };
  try {
    const compiler = path.join(
      process.env.SystemRoot ?? 'C:\\Windows',
      'Microsoft.NET',
      process.arch === 'ia32' ? 'Framework' : 'Framework64',
      'v4.0.30319',
      'csc.exe',
    );
    await retryDllInitialization(
      () =>
        new Promise((resolve, reject) => {
          execFile(
            compiler,
            [
              '/nologo',
              '/target:winexe',
              '/out:' + application,
              path.join(__dirname, 'windows-process-job.cs'),
            ],
            { cwd: directory, windowsHide: true, timeout: startupTimeoutMs },
            (error) => {
              if (error != null)
                reject(startupError('windows-job-compile-failed', error.code));
              else resolve();
            },
          );
        }),
    );
    process.once('exit', discard);
    return application;
  } catch (error) {
    discard();
    throw error;
  }
}

// Windows passes a single command line to the child. Apply the same quoting
// used for native argv in Node.
function quoteArgument(argument) {
  if (argument.length > 0 && !/[ \t"]/u.test(argument)) return argument;
  return (
    '"' +
    argument.replace(
      /(\\*)("|$)/gu,
      (_, slashes, quote) => slashes + slashes + (quote ? '\\"' : ''),
    ) +
    '"'
  );
}

async function launchHelper(application, request, options, keepDescendants) {
  const name = 'testgen-' + randomUUID();
  const channels = ['', '-out', '-err'].map((suffix) => ({
    name: name + suffix,
    server: net.createServer(),
    closed: Promise.withResolvers(),
    socket: null,
  }));
  const [control, stdout, stderr] = channels;
  const ready = Promise.withResolvers();
  const outputClosed = Promise.all([
    stdout.closed.promise,
    stderr.closed.promise,
  ]);
  let connected = false;
  let finalReply;
  let pid;
  let launched = false;
  let stopping = false;
  let wantsRelease = false;
  let beforeRelease;
  let child;
  let timer;

  const checkReady = () => {
    if (connected && channels.every(({ socket }) => socket != null))
      ready.resolve();
  };
  const release = async () => {
    await outputClosed;
    if (wantsRelease && !stopping && !control.socket.destroyed) {
      wantsRelease = false;
      if (stdout.socket.readableEnded && stderr.socket.readableEnded) {
        beforeRelease();
        control.socket.write('release\n');
      } else control.socket.write('stop\n');
    }
  };
  const closeSockets = () => {
    for (const channel of channels) channel.socket?.destroy();
  };
  for (const channel of channels) {
    channel.server.maxConnections = 1;
    channel.server.once('connection', (socket) => {
      channel.socket = socket;
      socket.on('error', () => {});
      socket.once('close', () => channel.closed.resolve());
      if (channel === control) {
        const lines = createInterface({ input: socket, crlfDelay: Infinity });
        lines.on('line', (line) => {
          if (line === 'ready') {
            connected = true;
            checkReady();
          } else if (/^pid [1-9]\d{0,9}$/u.test(line)) {
            pid = Number(line.slice(4));
          } else if (line === 'drain') {
            wantsRelease = true;
            void release();
          } else {
            finalReply = /^(exit|spawn-error|cleanup-error) (\d{1,10})$/u.exec(
              line,
            );
            if (finalReply?.[1] === 'spawn-error')
              ready.reject(
                startupError(
                  'windows-job-startup-failed',
                  Number(finalReply[2]),
                ),
              );
            socket.destroy();
          }
        });
      }
      checkReady();
    });
  }

  try {
    await Promise.all(
      channels.map(({ server, name: endpoint }) => {
        const listening = once(server, 'listening');
        server.listen('\\\\.\\pipe\\' + endpoint);
        return listening;
      }),
    );
    child = spawn(application, [name, keepDescendants ? 'keep' : 'stop'], {
      ...options,
      stdio: [options.stdio[0], 'ignore', 'ignore'],
    });
    child.once('error', () =>
      ready.reject(startupError('windows-job-startup-failed')),
    );
    child.once('close', (status) =>
      ready.reject(startupError('windows-job-startup-failed', status)),
    );
    timer = setTimeout(
      () => ready.reject(startupError('windows-job-startup-timeout')),
      startupTimeoutMs,
    );
    await ready.promise;
  } catch (error) {
    closeSockets();
    child?.kill('SIGKILL');
    throw error;
  } finally {
    clearTimeout(timer);
    for (const { server } of channels) server.close();
  }

  return {
    child,
    stdout: stdout.socket,
    stderr: stderr.socket,
    get pid() {
      return pid;
    },
    start(onRelease) {
      launched = true;
      beforeRelease = onRelease;
      control.socket.write(request + '\n');
    },
    stop() {
      stopping = true;
      control.socket.write(launched ? 'stop\n' : '\n');
    },
    abandon() {
      stopping = true;
      closeSockets();
      child.kill('SIGKILL');
    },
    async result(helperStatus) {
      await Promise.all([control.closed.promise, outputClosed]);
      const status = Number(finalReply?.[2]);
      if (helperStatus === 0 && finalReply != null && status <= 0xffffffff) {
        switch (finalReply[1]) {
          case 'exit':
            if (
              !stopping &&
              (!stdout.socket.readableEnded || !stderr.socket.readableEnded)
            )
              return {
                status: null,
                spawn_error: 'windows-job-output-unavailable',
              };
            return {
              status,
              ...(status >= 0xc0000000
                ? { windows_status: nativeStatus(status) }
                : {}),
            };
          case 'spawn-error':
            return {
              status: null,
              spawn_error: 'windows-job-child-launch-failed',
              windows_status: nativeStatus(status),
            };
          case 'cleanup-error':
            return {
              status: null,
              tree_cleanup_reason: 'windows-job-cleanup-unverified',
              windows_status: nativeStatus(status),
            };
        }
      }
      return {
        status: null,
        tree_cleanup_reason: 'windows-job-report-unavailable',
        windows_status: nativeStatus(helperStatus),
      };
    },
  };
}

async function startWindowsJob(command, args, options, keepDescendants) {
  const argumentsList = [command, ...args.map(String)];
  if (argumentsList.some((argument) => argument.includes('\0')))
    throw new TypeError('Windows process arguments must not contain NUL');
  const line = argumentsList.map(quoteArgument).join(' ');
  const request = Buffer.from(line, 'utf16le').toString('base64');
  compiledHelper ??= compileHelper().catch((error) => {
    compiledHelper = null;
    throw error;
  });
  const application = await compiledHelper;
  return retryDllInitialization(() =>
    launchHelper(application, request, options, keepDescendants),
  );
}

module.exports = { startWindowsJob };

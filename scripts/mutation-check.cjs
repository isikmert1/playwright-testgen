#!/usr/bin/env node

const { captureBoundary } = require('./change-manifest.cjs');
const { digestAdapter } = require('./mutation-adapter.cjs');
const { MutationCheckError } = require('./mutation-check-error.cjs');
const { verifyMutation } = require('./mutation-isolation.cjs');

const HELP = `Usage:
  No adapter:
    node <plugin-root>/scripts/mutation-check.cjs verify --repo . --run-id <run_id> --criterion-id <criterion_id>
  Approved adapter:
    node <plugin-root>/scripts/mutation-check.cjs verify --repo . --run-id <run_id> --adapter <manifest> --mutation-id <mutation_id> --criterion-id <criterion_id> --approval-digest <sha256>
  Capture:
    node <plugin-root>/scripts/mutation-check.cjs capture --repo . --run-id <run_id> --boundary <pre-author|checkpoint|post-healer>
  Digest:
    node <plugin-root>/scripts/mutation-check.cjs digest --repo . --adapter <manifest> --mutation-id <mutation_id>
`;

function parseFlags(values, allowed) {
  const options = {};
  for (let index = 0; index < values.length; index += 2) {
    const name = values[index];
    const value = values[index + 1];
    if (!allowed.has(name) || value == null || Object.hasOwn(options, name))
      throw new MutationCheckError('invalid-arguments');
    options[name] = value;
  }
  return options;
}

function capture(values) {
  const options = parseFlags(
    values,
    new Set(['--repo', '--run-id', '--boundary']),
  );
  return captureBoundary(
    options['--repo'] ?? process.cwd(),
    options['--run-id'],
    options['--boundary'],
  );
}

function digest(values) {
  const options = parseFlags(
    values,
    new Set(['--repo', '--adapter', '--mutation-id']),
  );
  return digestAdapter(
    options['--repo'] ?? process.cwd(),
    options['--adapter'],
    options['--mutation-id'],
  );
}

function verify(values, signal) {
  const options = parseFlags(
    values,
    new Set([
      '--repo',
      '--run-id',
      '--adapter',
      '--mutation-id',
      '--criterion-id',
      '--approval-digest',
    ]),
  );
  return verifyMutation(
    options['--repo'] ?? process.cwd(),
    options['--run-id'],
    options['--adapter'],
    options['--mutation-id'],
    options['--criterion-id'],
    options['--approval-digest'],
    signal,
  );
}

async function main(argv = process.argv.slice(2)) {
  if (
    (argv.length === 1 && argv[0] === '--help') ||
    (argv.length === 2 && argv[0] === 'verify' && argv[1] === '--help')
  ) {
    process.stdout.write(HELP);
    return;
  }
  const operation = argv.shift() ?? null;
  const controller = operation === 'verify' ? new AbortController() : null;
  const cancel = () => controller.abort();
  if (controller != null) {
    process.on('SIGINT', cancel);
    process.on('SIGTERM', cancel);
  }
  try {
    const result = await (operation === 'capture'
      ? capture(argv)
      : operation === 'digest'
        ? digest(argv)
        : operation === 'verify'
          ? verify(argv, controller.signal)
          : (() => {
              throw new MutationCheckError('invalid-operation');
            })());
    const ok = result.status !== 'verification-error';
    process.stdout.write(`${JSON.stringify({ ok, operation, ...result })}\n`);
    if (!ok) process.exitCode = 1;
  } catch (error) {
    const code =
      error instanceof MutationCheckError ? error.code : 'internal-error';
    const output =
      operation === 'verify'
        ? { ok: false, operation, status: 'verification-error', error: code }
        : { ok: false, operation, error: code };
    process[operation === 'verify' ? 'stdout' : 'stderr'].write(
      `${JSON.stringify(output)}\n`,
    );
    process.exitCode = 1;
  } finally {
    if (controller != null) {
      process.removeListener('SIGINT', cancel);
      process.removeListener('SIGTERM', cancel);
    }
  }
}

if (require.main === module) void main();

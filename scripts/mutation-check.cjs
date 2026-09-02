#!/usr/bin/env node

const { captureBoundary } = require('./change-manifest.cjs');
const { digestAdapter } = require('./mutation-adapter.cjs');
const { MutationCheckError } = require('./mutation-check-error.cjs');
const { verifyMutation } = require('./mutation-isolation.cjs');

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

function verify(values) {
  const options = parseFlags(
    values,
    new Set([
      '--repo',
      '--run-id',
      '--adapter',
      '--criterion-id',
      '--approval-digest',
    ]),
  );
  return verifyMutation(
    options['--repo'] ?? process.cwd(),
    options['--run-id'],
    options['--adapter'],
    options['--criterion-id'],
    options['--approval-digest'],
  );
}

function main(argv = process.argv.slice(2)) {
  const operation = argv.shift() ?? null;
  try {
    const result =
      operation === 'capture'
        ? capture(argv)
        : operation === 'digest'
          ? digest(argv)
          : operation === 'verify'
            ? verify(argv)
            : (() => {
                throw new MutationCheckError('invalid-operation');
              })();
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
  }
}

if (require.main === module) main();

module.exports = { main, parseFlags };

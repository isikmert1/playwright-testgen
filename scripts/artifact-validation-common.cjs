const { createHash } = require('node:crypto');
const { lstatSync, readFileSync, realpathSync } = require('node:fs');
const path = require('node:path');

const RUN_ID = /^tg-[a-f0-9]{24}$/u;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/u;
const SCHEMAS = {
  handoff: {
    filename: 'author-handoff.v1.schema.json',
    version: 'author-handoff.v1',
    hash: '5be739fd42dad453d8b5dac428d8f8673a9108372e51a8b8646f8b597e9953c0',
  },
  input: {
    filename: 'healer-input.v1.schema.json',
    version: 'healer-input.v1',
    hash: '4817ee73bbe082b3da52b1bb682e7671987d8058e0ddb312e9f454e2fde6584a',
  },
  trace: {
    filename: 'healer-trace.v2.schema.json',
    version: 'healer-trace.v2',
    hash: '5bdef9a0b0917e91b3a2df63827ad99ff2e29d7d4ebaf6cd6a2ac0560ca56968',
  },
  vacuity: {
    filename: 'vacuity-report.v1.schema.json',
    version: 'vacuity-report.v1',
    hash: '28aa9696e749f77e41ac0f242dcc2c146f670f7b06171251fd66ad47946f6094',
  },
};
const TYPES = new Set(Object.keys(SCHEMAS));
const CLASSIFICATIONS = new Set([
  'selector-drift',
  'timing',
  'expectation-drift',
  'intent-wrong',
  'environment-or-auth',
  'product-behavior-wrong',
  'unresolved',
]);
const DISPOSITIONS = new Set([
  'fixed',
  'needs-author-revision',
  'needs-user-input',
  'product-behavior-wrong',
  'unresolved-after-healing',
]);
const TERMINAL_CLASSIFICATIONS = new Set([
  'intent-wrong',
  'environment-or-auth',
  'product-behavior-wrong',
  'unresolved',
]);
const REPAIRABLE_CLASSIFICATIONS = new Set([
  'selector-drift',
  'timing',
  'expectation-drift',
]);
const SECRET_KEYS = new Set([
  'apikey',
  'authorization',
  'cookie',
  'credential',
  'credentials',
  'password',
  'passwd',
  'secret',
  'setcookie',
  'storagestate',
  'token',
]);
const RAW_CONTENT_KEYS = new Set([
  'dom',
  'log',
  'rawlog',
  'request',
  'requestbody',
  'response',
  'responsebody',
  'scenariobody',
  'screenshot',
  'snapshot',
  'specbody',
  'ticket',
  'trace',
  'video',
]);
const SECRET_VALUE =
  /(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|authorization\s*:|(?:api[-_ ]?key|token|secret|password|passwd|cookie|set-cookie)\s*[:=]|\bhttps?:\/\/[^\s/@]+@[^\s]+)/iu;
const RAW_CONTENT_VALUE =
  /(?:\bsnapshot\s*:|\b(?:test|describe|expect)\s*\(|```)/iu;
const ENVIRONMENT_VALUE =
  /(?:^|[^A-Za-z0-9_])(?:env:)?(?:[A-Z_][A-Z0-9_]*|[a-z][a-z0-9]*_[a-z0-9_]+)=[^\s]+/u;
const CSS_ATTRIBUTE_SELECTOR =
  /\[[A-Za-z_][A-Za-z0-9_.:-]*\s*(?:[~|^$*]?=)\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\]\s]+)\s*\]/gu;
const RAW_DOM_TAG = /<\/?[A-Za-z][A-Za-z0-9:-]*(?:\s[^<>]*?)?\/?>/u;

function loadSchema(type) {
  const metadata = SCHEMAS[type];
  if (metadata == null) return null;
  try {
    const schema = JSON.parse(
      readFileSync(
        path.join(__dirname, '..', 'schemas', metadata.filename),
        'utf8',
      ),
    );
    const hash = createHash('sha256')
      .update(JSON.stringify(schema))
      .digest('hex');
    return isObject(schema) &&
      schema.$schema === 'https://json-schema.org/draft/2020-12/schema' &&
      schema.$id === `playwright-testgen/${metadata.version}` &&
      schema.type === 'object' &&
      schema.additionalProperties === false &&
      schema.properties?.schema_version?.const === metadata.version &&
      schema.properties?.run_id?.pattern === RUN_ID.source &&
      hash === metadata.hash
      ? schema
      : null;
  } catch {
    return null;
  }
}

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function portable(value) {
  return value.replaceAll('\\', '/');
}

function comparableRepoPath(value) {
  const normalized = portable(path.normalize(value));
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (relative !== '..' &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

function samePath(left, right) {
  return process.platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

function isText(value, maximum) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maximum &&
    !/[\r\n]/u.test(value)
  );
}

function isIdentifier(value) {
  return typeof value === 'string' && ID.test(value);
}

function isFile(value) {
  try {
    return lstatSync(value).isFile();
  } catch {
    return false;
  }
}

function isRepoPath(value) {
  return (
    isText(value, 240) &&
    !path.isAbsolute(value) &&
    !value.includes('\0') &&
    !portable(value).startsWith('../')
  );
}

function isAttributeName(value) {
  return (
    isText(value, 64) &&
    /^(?:none-found|[A-Za-z_][A-Za-z0-9_.:-]{0,63})$/u.test(value)
  );
}

function parseArgs(argv) {
  const options = {};
  const positionals = [];
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (['--repo', '--type', '--run-id'].includes(value)) {
      if (argv[index + 1] == null || Object.hasOwn(options, value)) {
        throw new Error('invalid-arguments');
      }
      options[value] = argv[index + 1];
      index += 1;
    } else if (value.startsWith('--')) {
      throw new Error('invalid-arguments');
    } else {
      positionals.push(value);
    }
  }
  if (
    !TYPES.has(options['--type']) ||
    !RUN_ID.test(options['--run-id'] ?? '') ||
    positionals.length !== 1
  ) {
    throw new Error('invalid-arguments');
  }
  return {
    artifact: positionals[0],
    repository: options['--repo'] ?? process.cwd(),
    runId: options['--run-id'],
    type: options['--type'],
  };
}

function report(valid, type, errors, metadata) {
  const output = valid
    ? { valid: true, type, ...metadata }
    : {
        valid: false,
        type: type ?? null,
        errors: [...new Set(errors)].slice(0, 12),
      };
  process[valid ? 'stdout' : 'stderr'].write(`${JSON.stringify(output)}\n`);
  if (!valid) process.exitCode = 1;
}

function rejectUnknown(value, allowed, errors, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) errors.push(`${label}-unknown-field`);
  }
}

function requireFields(value, fields, errors, label) {
  for (const field of fields) {
    if (!Object.hasOwn(value, field)) errors.push(`${label}-missing-field`);
  }
}

function normalizedKey(value) {
  return value.replaceAll(/[^A-Za-z0-9]/gu, '').toLowerCase();
}

function prohibitedReasons(value, key = '') {
  const reasons = new Set();
  const normalized = normalizedKey(key);
  if (SECRET_KEYS.has(normalized)) reasons.add('secret');
  if (RAW_CONTENT_KEYS.has(normalized)) reasons.add('raw-content');
  if (normalized === 'environment') reasons.add('environment-value');
  if (typeof value === 'string') {
    const environmentInput =
      key === 'locator' ? value.replace(CSS_ATTRIBUTE_SELECTOR, '') : value;
    if (SECRET_VALUE.test(value)) reasons.add('secret');
    if (RAW_CONTENT_VALUE.test(value) || RAW_DOM_TAG.test(value))
      reasons.add('raw-content');
    if (ENVIRONMENT_VALUE.test(environmentInput))
      reasons.add('environment-value');
    return [...reasons];
  }
  if (Array.isArray(value)) {
    for (const item of value)
      for (const reason of prohibitedReasons(item)) reasons.add(reason);
  } else if (isObject(value)) {
    for (const [name, item] of Object.entries(value))
      for (const reason of prohibitedReasons(item, name)) reasons.add(reason);
  }
  return [...reasons];
}

function containsProhibited(value, key = '') {
  return prohibitedReasons(value, key).length > 0;
}

function validatePath(value, repository, errors, label) {
  if (!isRepoPath(value)) {
    errors.push(`${label}-invalid-path`);
    return;
  }
  if (!isInside(repository, path.resolve(repository, value))) {
    errors.push(`${label}-outside-repository`);
    return;
  }
  let canonical;
  try {
    canonical = realpathSync(path.resolve(repository, value));
  } catch {
    errors.push(`${label}-unavailable`);
    return;
  }
  if (!isInside(repository, canonical)) {
    errors.push(`${label}-outside-repository`);
  }
}

function validateStringArray(
  value,
  maximumItems,
  maximumText,
  errors,
  label,
  minimumItems = 0,
) {
  if (
    !Array.isArray(value) ||
    value.length < minimumItems ||
    value.length > maximumItems
  ) {
    errors.push(`${label}-invalid-array`);
    return;
  }
  if (value.some((item) => !isText(item, maximumText)))
    errors.push(`${label}-invalid-text`);
}

module.exports = {
  CLASSIFICATIONS,
  DISPOSITIONS,
  REPAIRABLE_CLASSIFICATIONS,
  RUN_ID,
  TERMINAL_CLASSIFICATIONS,
  comparableRepoPath,
  containsProhibited,
  isAttributeName,
  isFile,
  isIdentifier,
  isInside,
  isObject,
  isRepoPath,
  isText,
  loadSchema,
  parseArgs,
  portable,
  prohibitedReasons,
  rejectUnknown,
  report,
  requireFields,
  samePath,
  validatePath,
  validateStringArray,
};

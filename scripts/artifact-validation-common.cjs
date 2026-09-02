const { createHash } = require('node:crypto');
const { readFileSync, realpathSync, statSync } = require('node:fs');
const path = require('node:path');

const RUN_ID = /^tg-[a-f0-9]{24}$/u;
const TYPES = new Set(['handoff', 'trace']);
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
const SCHEMA_HASHES = {
  handoff: '5cc69a16d0240e293c93393d6e9ae24603a072491da745f41ffdc7e1d7f52d60',
  trace: '7e96ee2d29342047991f6ee835f63cd2677f8d0630f11bc049d278b74b06763b',
};
const PROHIBITED_KEY =
  /(?:credential|password|passwd|secret|token|cookie|authorization|storage.?state|environment|snapshot|screenshot|video|trace|dom|(?:raw_)?log|request|response|ticket|scenario(?:_|-)?body|spec(?:_|-)?body)/iu;
const PROHIBITED_VALUE =
  /(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|authorization\s*:|(?:api[-_ ]?key|token|secret|password|passwd|cookie|set-cookie)\s*[:=]|\bsnapshot\s*:|\b(?:test|describe|expect)\s*\(|```|\bhttps?:\/\/[^\s/@]+@[^\s]+)/iu;
const ENVIRONMENT_VALUE = /(?:^|[^A-Za-z0-9_])[A-Za-z_][A-Za-z0-9_]*=[^\s]+/u;
const CSS_ATTRIBUTE_SELECTOR =
  /\[[A-Za-z_][A-Za-z0-9_.:-]*\s*(?:[~|^$*]?=)\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\]\s]+)\s*\]/gu;
const RAW_DOM_TAG = /<\/?[A-Za-z][A-Za-z0-9:-]*(?:\s[^<>]*?)?\/?>/u;

function loadSchema(type) {
  const filename =
    type === 'handoff'
      ? 'author-handoff.v1.schema.json'
      : 'healer-trace.v1.schema.json';
  const version = type === 'handoff' ? 'author-handoff.v1' : 'healer-trace.v1';
  try {
    const schema = JSON.parse(
      readFileSync(path.join(__dirname, '..', 'schemas', filename), 'utf8'),
    );
    const hash = createHash('sha256')
      .update(JSON.stringify(schema))
      .digest('hex');
    return isObject(schema) &&
      schema.$schema === 'https://json-schema.org/draft/2020-12/schema' &&
      schema.$id === `playwright-testgen/${version}` &&
      schema.type === 'object' &&
      schema.additionalProperties === false &&
      schema.properties?.schema_version?.const === version &&
      schema.properties?.run_id?.pattern === RUN_ID.source &&
      hash === SCHEMA_HASHES[type]
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

function isFile(value) {
  try {
    return statSync(value).isFile();
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

function containsProhibited(value, key = '') {
  if (PROHIBITED_KEY.test(key)) return true;
  if (typeof value === 'string') {
    const environmentInput =
      key === 'locator' ? value.replace(CSS_ATTRIBUTE_SELECTOR, '') : value;
    return (
      PROHIBITED_VALUE.test(value) ||
      ENVIRONMENT_VALUE.test(environmentInput) ||
      RAW_DOM_TAG.test(value)
    );
  }
  if (Array.isArray(value))
    return value.some((item) => containsProhibited(item));
  return (
    isObject(value) &&
    Object.entries(value).some(([name, item]) => containsProhibited(item, name))
  );
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
  isInside,
  isObject,
  isRepoPath,
  isText,
  loadSchema,
  parseArgs,
  portable,
  rejectUnknown,
  report,
  requireFields,
  samePath,
  validatePath,
  validateStringArray,
};

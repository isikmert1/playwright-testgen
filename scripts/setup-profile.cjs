#!/usr/bin/env node

const { spawnSync } = require('node:child_process');
const { createHash, randomBytes } = require('node:crypto');
const {
  existsSync,
  lstatSync,
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
  excluded,
  hasDefaultConfig,
  inspectionSource,
  profileRepository,
  selectedConfigPath,
} = require('./profile-repo.cjs');

const PROFILE_PATH = '.playwright-testgen/profile.v1.json';
const MAX_PROFILE_BYTES = 64 * 1024;
const MAX_FINGERPRINT_PATHS = 64;
const SAFE_ERROR = /^[a-z][a-z0-9-]{0,79}$/u;
const TEST_ID_ATTRIBUTES = ['data-testid', 'data-test', 'data-cy', 'test-id'];

class SetupError extends Error {
  constructor(code, reason) {
    super(code);
    this.code = code;
    this.reason = reason;
  }
}

function fail(code, reason) {
  throw new SetupError(code, reason);
}

function inside(root, candidate, allowRoot = false) {
  const relative = path.relative(root, candidate);
  return (
    (allowRoot && relative === '') ||
    (relative !== '' &&
      relative !== '..' &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

function runGit(root, args, error = 'repository-unavailable') {
  const result = spawnSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
    timeout: 5000,
    windowsHide: true,
  });
  if (result.error != null || result.status !== 0) fail(error);
  return result.stdout;
}

function repositoryRoot(value) {
  let cwd;
  try {
    cwd = realpathSync(path.resolve(value));
  } catch {
    fail('repository-unavailable');
  }
  const root = runGit(cwd, ['rev-parse', '--show-toplevel']).trim();
  try {
    return realpathSync(root);
  } catch {
    fail('repository-unavailable');
  }
}

function relativePath(root, value, error) {
  if (typeof value !== 'string' || value.length === 0 || path.isAbsolute(value))
    fail(error);
  const absolute = path.resolve(root, value);
  if (!inside(root, absolute)) fail(error);
  return path.relative(root, absolute).replaceAll('\\', '/');
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function statusState(root, selectedPackage) {
  const scope =
    selectedPackage === '.'
      ? '.'
      : relativePath(root, selectedPackage, 'profile-invalid');
  const output = runGit(root, [
    'status',
    '--porcelain=v1',
    '-z',
    '--untracked-files=all',
    '--',
    scope,
  ]);
  const entries = output.split('\0').filter(Boolean);
  if (entries.length > 4096) fail('profile-fingerprint-incomplete');
  const content = [];
  const dirtySources = new Set();
  for (const entry of entries) {
    const code = entry.slice(0, 2);
    const filename = entry.slice(3).replaceAll('\\', '/');
    if (excluded(filename) || !inspectionSource(filename)) continue;
    const record = `${code} ${filename}`;
    content.push(record);
    if (existsSync(path.join(root, filename))) dirtySources.add(filename);
  }
  if (dirtySources.size > MAX_FINGERPRINT_PATHS)
    fail('profile-fingerprint-incomplete');
  for (const [filename, hash] of Object.entries(
    sourceFingerprints(root, [...dirtySources].sort()),
  ))
    content.push(`sha256 ${filename} ${hash}`);
  const listed = runGit(root, [
    'ls-files',
    '-z',
    '--cached',
    '--others',
    '--exclude-standard',
    '--',
    scope,
  ])
    .split('\0')
    .filter(Boolean)
    .filter((filename) => !excluded(filename) && inspectionSource(filename));
  if (listed.length > 4096) fail('profile-fingerprint-incomplete');
  return {
    head: runGit(root, ['rev-parse', '--verify', 'HEAD']).trim(),
    membership_sha256: sha256(listed.sort().join('\0')),
    status_sha256: sha256(content.sort().join('\0')),
  };
}

function evidencePaths(scan) {
  const facts = scan.facts;
  const values = [
    scan.selection.package === '.'
      ? 'package.json'
      : `${scan.selection.package}/package.json`,
    scan.selection.config,
    ...(facts?.layout?.tests ?? []),
    ...(facts?.layout?.helpers ?? []),
    ...(facts?.layout?.fixtures ?? []),
    ...(facts?.test_id?.evidence ?? []),
    ...(facts?.frameworks ?? []).map((item) => item.evidence),
    ...(facts?.component_libraries ?? []).map((item) => item.evidence),
    ...(facts?.authentication?.mechanisms ?? []).map((item) => item.evidence),
  ];
  return [...new Set(values.filter((value) => typeof value === 'string'))]
    .sort()
    .slice(0, MAX_FINGERPRINT_PATHS);
}

function sourceFingerprints(root, paths) {
  const result = {};
  for (const relative of paths) {
    const safe = relativePath(root, relative, 'profile-source-invalid');
    if (excluded(safe)) fail('profile-source-invalid', 'source-excluded');
    const absolute = path.join(root, safe);
    let canonical;
    let size;
    try {
      if (!lstatSync(absolute).isFile()) fail('profile-source-invalid');
      canonical = realpathSync(absolute);
      size = statSync(canonical).size;
    } catch (error) {
      if (error instanceof SetupError) throw error;
      fail('profile-source-invalid');
    }
    if (!inside(root, canonical)) fail('profile-source-invalid');
    if (excluded(path.relative(root, canonical).replaceAll('\\', '/')))
      fail('profile-source-invalid', 'source-excluded');
    if (size > 64 * 1024) fail('profile-fingerprint-incomplete');
    const contents = readFileSync(canonical);
    if (contents.length > 64 * 1024) fail('profile-fingerprint-incomplete');
    result[safe] = sha256(contents);
  }
  return result;
}

function fingerprint(root, paths, selectedPackage) {
  return {
    ...statusState(root, selectedPackage),
    sources: sourceFingerprints(root, paths),
  };
}

function gitIgnored(root, relative) {
  const result = spawnSync(
    'git',
    ['check-ignore', '--quiet', '--no-index', '--', relative],
    { cwd: root, timeout: 5000, windowsHide: true },
  );
  if (result.error != null || ![0, 1].includes(result.status))
    fail('repository-unavailable');
  return result.status === 0;
}

function gitTracked(root, relative) {
  const result = spawnSync(
    'git',
    ['ls-files', '--error-unmatch', '--', relative],
    { cwd: root, timeout: 5000, windowsHide: true },
  );
  if (result.error != null || ![0, 1].includes(result.status))
    fail('repository-unavailable');
  return result.status === 0;
}

function validateStatePath(root, value, replace = false) {
  const relative = relativePath(root, value, 'state-path-invalid');
  if (
    relative === PROFILE_PATH ||
    relative.startsWith('.playwright-cli/testgen/')
  )
    fail('state-path-invalid');
  if (!gitIgnored(root, relative)) fail('state-path-not-ignored');
  if (gitTracked(root, relative)) fail('state-path-tracked');

  const absolute = path.join(root, relative);
  let ancestor = absolute;
  while (!existsSync(ancestor)) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) fail('state-path-invalid');
    ancestor = parent;
  }
  if (!inside(root, realpathSync(ancestor), true)) fail('state-path-invalid');
  if (existsSync(absolute)) {
    let canonical;
    try {
      if (!lstatSync(absolute).isFile()) fail('state-path-invalid');
      canonical = realpathSync(absolute);
    } catch (error) {
      if (error instanceof SetupError) throw error;
      fail('state-path-invalid');
    }
    if (!inside(root, canonical) || !replace) fail('state-path-exists');
  }
  return { ok: true, path: relative, status: 'available' };
}

function validateProfileShape(profile) {
  const allowedTopLevel = new Set([
    'authentication',
    'facts',
    'freshness',
    'repository_root',
    'scan',
    'schema_version',
    'selection',
  ]);
  if (
    Object.keys(profile ?? {}).some((key) => !allowedTopLevel.has(key)) ||
    profile?.schema_version !== 'repository-profile.v1' ||
    typeof profile.repository_root !== 'string' ||
    profile.selection == null ||
    !['config', 'configless'].includes(profile.selection.config_mode) ||
    typeof profile.selection.package !== 'string' ||
    (profile.selection.config_mode === 'config' &&
      typeof profile.selection.config !== 'string') ||
    (profile.selection.config_mode === 'configless' &&
      profile.selection.config !== null) ||
    profile.freshness == null ||
    !/^[a-f0-9]{40}$/u.test(profile.freshness.head) ||
    !/^[a-f0-9]{64}$/u.test(profile.freshness.membership_sha256) ||
    !/^[a-f0-9]{64}$/u.test(profile.freshness.status_sha256) ||
    profile.freshness.sources == null ||
    Array.isArray(profile.freshness.sources) ||
    Object.keys(profile.freshness.sources).length > MAX_FINGERPRINT_PATHS ||
    Object.values(profile.freshness.sources).some(
      (value) => typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value),
    ) ||
    !validProfileFacts(profile) ||
    (profile.authentication != null &&
      (!['fixture', 'storage-state'].includes(
        profile.authentication.mechanism,
      ) ||
        typeof profile.authentication.path !== 'string' ||
        Object.keys(profile.authentication).length !== 2))
  )
    fail('profile-invalid');
}

function exactObject(value, keys) {
  return (
    value != null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function validProfileFacts(profile) {
  const scan = profile.scan;
  if (
    !exactObject(scan, ['status', 'stop_reason', 'inspected_paths']) ||
    !['complete', 'partial'].includes(scan.status) ||
    (scan.status === 'complete' && scan.stop_reason !== null) ||
    (scan.status === 'partial' &&
      (typeof scan.stop_reason !== 'string' || scan.stop_reason.length > 80)) ||
    !Array.isArray(scan.inspected_paths) ||
    scan.inspected_paths.length > MAX_FINGERPRINT_PATHS ||
    new Set(scan.inspected_paths).size !== scan.inspected_paths.length ||
    scan.inspected_paths.some((value) => typeof value !== 'string') ||
    JSON.stringify([...scan.inspected_paths].sort()) !==
      JSON.stringify(Object.keys(profile.freshness.sources).sort())
  )
    return false;
  if (scan.status === 'partial' && profile.facts === null) return true;

  const facts = profile.facts;
  if (
    !exactObject(facts, [
      'frameworks',
      'framework_status',
      'scripts',
      'layout',
      'component_libraries',
      'component_library_status',
      'test_id',
      'authentication',
    ]) ||
    !exactObject(facts.scripts, ['lint', 'format']) ||
    !exactObject(facts.layout, ['tests', 'helpers', 'fixtures', 'naming']) ||
    !exactObject(facts.test_id, [
      'status',
      'attribute',
      'config_attribute',
      'counts',
      'source_counts',
      'test_counts',
      'evidence',
    ]) ||
    !exactObject(facts.authentication, ['status', 'mechanisms'])
  )
    return false;

  const evidence = (value) =>
    typeof value === 'string' &&
    value.length <= 240 &&
    scan.inspected_paths.includes(value) &&
    Object.hasOwn(profile.freshness.sources, value);
  const names = (values, max) =>
    Array.isArray(values) &&
    values.length <= max &&
    values.every(
      (value) =>
        typeof value === 'string' && value.length > 0 && value.length <= 100,
    );
  const entries = (values, allowed, max, key = 'name') =>
    Array.isArray(values) &&
    values.length <= max &&
    values.every(
      (value) =>
        exactObject(value, [key, 'evidence']) &&
        allowed.includes(value[key]) &&
        evidence(value.evidence),
    );
  const frameworks = [
    'react',
    'next',
    'vue',
    'nuxt',
    'svelte',
    '@angular/core',
  ];
  const libraries = [
    '@mui/material',
    '@chakra-ui/react',
    'antd',
    'bootstrap',
    'react-bootstrap',
    '@mantine/core',
    'vuetify',
    'local-ui-components',
  ];
  if (
    !entries(facts.frameworks, frameworks, frameworks.length) ||
    !['detected', 'unknown'].includes(facts.framework_status) ||
    facts.framework_status !==
      (facts.frameworks.length > 0 ? 'detected' : 'unknown') ||
    !names(facts.scripts.lint, 32) ||
    !names(facts.scripts.format, 32) ||
    !names(facts.layout.tests, 8) ||
    !facts.layout.tests.every(evidence) ||
    !names(facts.layout.helpers, 8) ||
    !facts.layout.helpers.every(evidence) ||
    !names(facts.layout.fixtures, 8) ||
    !facts.layout.fixtures.every(evidence) ||
    facts.layout.naming == null ||
    typeof facts.layout.naming !== 'object' ||
    Array.isArray(facts.layout.naming) ||
    Object.keys(facts.layout.naming).length > 16 ||
    Object.entries(facts.layout.naming).some(
      ([name, count]) =>
        !/^\.(?:spec|test|cy)\.[cm]?[jt]sx?$/u.test(name) ||
        !Number.isSafeInteger(count) ||
        count < 0 ||
        count > 512,
    ) ||
    !entries(facts.component_libraries, libraries, libraries.length) ||
    !['detected', 'unknown'].includes(facts.component_library_status) ||
    facts.component_library_status !==
      (facts.component_libraries.length > 0 ? 'detected' : 'unknown') ||
    !entries(
      facts.authentication.mechanisms,
      ['auth-dependency', 'storage-state-use', 'test-fixture-use'],
      3,
      'kind',
    ) ||
    !['detected', 'unknown'].includes(facts.authentication.status) ||
    (scan.status === 'complete' &&
      facts.authentication.status !==
        (facts.authentication.mechanisms.length > 0
          ? 'detected'
          : 'unknown')) ||
    !['detected', 'ambiguous', 'none-found', 'unknown'].includes(
      facts.test_id.status,
    ) ||
    !names(facts.test_id.evidence, 8) ||
    !facts.test_id.evidence.every(evidence)
  )
    return false;

  const testId = facts.test_id;
  if (
    (testId.config_attribute !== null &&
      (typeof testId.config_attribute !== 'string' ||
        !/^[A-Za-z][A-Za-z0-9_-]*$/u.test(testId.config_attribute))) ||
    (testId.status === 'detected') !== (typeof testId.attribute === 'string')
  )
    return false;
  const expectedKeys = new Set(TEST_ID_ATTRIBUTES);
  if (testId.config_attribute !== null)
    expectedKeys.add(testId.config_attribute);
  for (const field of ['counts', 'source_counts', 'test_counts']) {
    const counts = testId[field];
    if (
      counts == null ||
      typeof counts !== 'object' ||
      Array.isArray(counts) ||
      Object.keys(counts).length !== expectedKeys.size ||
      Object.entries(counts).some(
        ([key, count]) =>
          !expectedKeys.has(key) ||
          !Number.isSafeInteger(count) ||
          count < 0 ||
          count > 4 * 1024 * 1024,
      )
    )
      return false;
  }
  if (
    [...expectedKeys].some(
      (key) =>
        testId.counts[key] !==
        testId.source_counts[key] + testId.test_counts[key],
    )
  )
    return false;
  return (
    testId.attribute === null ||
    (expectedKeys.has(testId.attribute) && testId.counts[testId.attribute] > 0)
  );
}

function checkedProfilePath(root, createDirectory = false) {
  const filename = path.join(root, PROFILE_PATH);
  const directory = path.dirname(filename);
  try {
    if (createDirectory) mkdirSync(directory, { recursive: true });
    if (
      !lstatSync(directory).isDirectory() ||
      !inside(root, realpathSync(directory))
    )
      fail('profile-path-invalid');
    try {
      if (
        !lstatSync(filename).isFile() ||
        !inside(root, realpathSync(filename))
      )
        fail('profile-path-invalid');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  } catch (error) {
    if (error instanceof SetupError) throw error;
    if (!createDirectory && error.code === 'ENOENT')
      fail('profile-unavailable');
    fail('profile-path-invalid');
  }
  return filename;
}

function validateProfileBindings(root, profile) {
  try {
    const packagePath = profile.selection.package;
    const packageDirectory =
      packagePath === '.'
        ? root
        : path.join(root, relativePath(root, packagePath, 'profile-invalid'));
    if (
      (packagePath !== '.' &&
        packagePath.replaceAll('\\', '/') !==
          path.relative(root, packageDirectory).replaceAll('\\', '/')) ||
      !inside(root, realpathSync(packageDirectory), true) ||
      !lstatSync(packageDirectory).isDirectory() ||
      !lstatSync(path.join(packageDirectory, 'package.json')).isFile()
    )
      fail('profile-invalid');

    if (
      profile.selection.config_mode === 'configless' &&
      hasDefaultConfig(packageDirectory)
    )
      fail('profile-invalid');

    if (profile.selection.config_mode === 'config') {
      const config = relativePath(
        root,
        profile.selection.config,
        'profile-invalid',
      );
      if (
        config !== profile.selection.config.replaceAll('\\', '/') ||
        !selectedConfigPath(root, config, packagePath) ||
        !Object.hasOwn(profile.freshness.sources, config) ||
        !lstatSync(path.join(root, config)).isFile() ||
        !inside(root, realpathSync(path.join(root, config)))
      )
        fail('profile-invalid');
    }
    if (profile.authentication?.mechanism === 'storage-state') {
      validateStatePath(root, profile.authentication.path, true);
      if (!existsSync(path.join(root, profile.authentication.path)))
        fail('profile-invalid');
    } else if (profile.authentication?.mechanism === 'fixture') {
      const fixture = relativePath(
        root,
        profile.authentication.path,
        'profile-invalid',
      );
      if (
        !lstatSync(path.join(root, fixture)).isFile() ||
        !inside(root, realpathSync(path.join(root, fixture)))
      )
        fail('profile-invalid');
    }
  } catch (error) {
    if (error instanceof SetupError && error.code === 'repository-unavailable')
      throw error;
    fail('profile-invalid');
  }
}

function publishProfile(root, profile) {
  validateProfileShape(profile);
  const serialized = `${JSON.stringify(profile, null, 2)}\n`;
  if (Buffer.byteLength(serialized) > MAX_PROFILE_BYTES)
    fail('profile-size-exceeded');
  const destination = checkedProfilePath(root, true);
  const directory = path.dirname(destination);
  const temporary = path.join(
    directory,
    `.profile-${randomBytes(6).toString('hex')}.tmp`,
  );
  try {
    writeFileSync(temporary, serialized, { flag: 'wx' });
    renameSync(temporary, destination);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function createProfile(options) {
  const root = repositoryRoot(options.repository);
  if (!gitIgnored(root, PROFILE_PATH)) fail('profile-path-not-ignored');
  if (gitTracked(root, PROFILE_PATH)) fail('profile-path-tracked');
  const scan = profileRepository({
    repository: root,
    selectedPackage: options.selectedPackage,
    selectedConfig: options.selectedConfig,
    configless: options.configless,
  });
  if (scan.selection.status !== 'selected') fail(scan.selection.status);
  const paths = evidencePaths(scan);
  const profile = {
    schema_version: 'repository-profile.v1',
    repository_root: root.replaceAll('\\', '/'),
    selection: {
      package: scan.selection.package,
      config_mode: scan.selection.config_mode,
      config: scan.selection.config,
    },
    scan: {
      status: scan.scan.status,
      stop_reason: scan.scan.stop_reason,
      inspected_paths: paths,
    },
    facts: scan.facts,
    freshness: fingerprint(root, paths, scan.selection.package),
  };
  publishProfile(root, profile);
  return { ok: true, path: PROFILE_PATH, status: 'profile-created' };
}

function validateProfile(options) {
  const root = repositoryRoot(options.repository);
  const filename = checkedProfilePath(root);
  if (!gitIgnored(root, PROFILE_PATH)) fail('profile-path-not-ignored');
  if (gitTracked(root, PROFILE_PATH)) fail('profile-path-tracked');
  let contents;
  try {
    if (!statSync(filename).isFile()) fail('profile-unavailable');
    if (statSync(filename).size > MAX_PROFILE_BYTES) fail('profile-invalid');
    contents = readFileSync(filename, 'utf8');
  } catch (error) {
    if (error instanceof SetupError) throw error;
    fail('profile-unavailable');
  }
  let profile;
  try {
    profile = JSON.parse(contents);
  } catch {
    fail('profile-invalid');
  }
  validateProfileShape(profile);
  if (profile.repository_root !== root.replaceAll('\\', '/'))
    fail('profile-wrong-target');
  validateProfileBindings(root, profile);
  let current;
  try {
    current = fingerprint(
      root,
      Object.keys(profile.freshness.sources),
      profile.selection.package,
    );
  } catch (error) {
    if (
      error instanceof SetupError &&
      error.code === 'profile-source-invalid' &&
      error.reason !== 'source-excluded'
    )
      fail('profile-stale', 'repository-membership-changed');
    throw error;
  }
  if (current.head !== profile.freshness.head)
    fail('profile-stale', 'repository-content-changed');
  if (current.membership_sha256 !== profile.freshness.membership_sha256)
    fail('profile-stale', 'repository-membership-changed');
  if (
    current.status_sha256 !== profile.freshness.status_sha256 ||
    JSON.stringify(current.sources) !==
      JSON.stringify(profile.freshness.sources)
  )
    fail('profile-stale', 'repository-content-changed');
  if (profile.scan?.status !== 'complete') fail('profile-partial');
  return { ok: true, status: 'fresh', profile };
}

function setAuthentication(options) {
  const root = repositoryRoot(options.repository);
  const { profile } = validateProfile({ repository: root });
  const relative = relativePath(root, options.path, 'auth-path-invalid');
  if (options.kind === 'storage-state') {
    validateStatePath(root, relative, true);
    if (!existsSync(path.join(root, relative))) fail('auth-path-unavailable');
  } else if (options.kind === 'fixture') {
    const absolute = path.join(root, relative);
    try {
      if (
        !lstatSync(absolute).isFile() ||
        !inside(root, realpathSync(absolute))
      )
        fail('auth-path-invalid');
    } catch (error) {
      if (error instanceof SetupError) throw error;
      fail('auth-path-unavailable');
    }
  } else fail('arguments-invalid');
  profile.authentication = { mechanism: options.kind, path: relative };
  publishProfile(root, profile);
  return { ok: true, status: 'auth-recorded', ...profile.authentication };
}

function parseArguments(argv) {
  const [action, ...args] = argv;
  const options = { action, configless: false, replace: false };
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (key === '--configless' && !options.configless) {
      options.configless = true;
      continue;
    }
    if (key === '--replace' && !options.replace) {
      options.replace = true;
      continue;
    }
    const value = args[index + 1];
    if (typeof value !== 'string' || value.length === 0)
      fail('arguments-invalid');
    if (key === '--repo' && options.repository == null)
      options.repository = value;
    else if (key === '--package' && options.selectedPackage == null)
      options.selectedPackage = value;
    else if (key === '--config' && options.selectedConfig == null)
      options.selectedConfig = value;
    else if (key === '--path' && options.path == null) options.path = value;
    else if (key === '--kind' && options.kind == null) options.kind = value;
    else fail('arguments-invalid');
    index += 1;
  }
  if (options.repository == null) fail('arguments-invalid');
  if (options.selectedConfig != null && options.configless)
    fail('arguments-invalid');
  return options;
}

function execute(options) {
  if (options.action === 'create') return createProfile(options);
  if (options.action === 'validate') return validateProfile(options);
  if (options.action === 'set-auth' && options.path != null)
    return setAuthentication(options);
  if (options.action === 'check-state-path' && options.path != null)
    return validateStatePath(
      repositoryRoot(options.repository),
      options.path,
      options.replace,
    );
  fail('arguments-invalid');
}

function main() {
  try {
    process.stdout.write(
      `${JSON.stringify(execute(parseArguments(process.argv.slice(2))))}\n`,
    );
  } catch (error) {
    const code =
      error instanceof SetupError && SAFE_ERROR.test(error.code)
        ? error.code
        : error instanceof Error && SAFE_ERROR.test(error.message)
          ? error.message
          : 'setup-profile-failed';
    const report = { ok: false, error: code };
    if (error instanceof SetupError && error.reason != null)
      report.reason = error.reason;
    process.stdout.write(`${JSON.stringify(report)}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();
module.exports = {
  MAX_PROFILE_BYTES,
  PROFILE_PATH,
  createProfile,
  validateProfile,
  validateStatePath,
};

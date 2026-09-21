#!/usr/bin/env node

const { spawnSync } = require('node:child_process');
const {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
} = require('node:fs');
const path = require('node:path');

const DEFAULT_LIMITS = Object.freeze({
  maxListedPaths: 4096,
  maxFilesRead: 512,
  maxTotalBytes: 4 * 1024 * 1024,
  maxFileBytes: 64 * 1024,
  maxDurationMs: 5000,
  maxOutputBytes: 64 * 1024,
});
const EXCLUDED = new Set([
  '.git',
  '.claude',
  '.auth',
  '.playwright',
  '.playwright-cli',
  '.playwright-testgen',
  '.testgen',
  'node_modules',
  'vendor',
  'third_party',
  '.yarn',
  'dist',
  'build',
  'coverage',
  'test-results',
  'playwright-report',
  '.next',
  '.svelte-kit',
]);
const ATTRIBUTES = ['data-testid', 'data-test', 'data-cy', 'test-id'];
const CONFIG = /^playwright\.config\.[cm]?[jt]s$/u;
const SOURCE = /\.(?:[cm]?[jt]sx?|vue|svelte|cshtml|erb|blade\.php|html)$/u;
const CREDENTIAL =
  /^(?:\.env(?:\..*)?|\.npmrc|auth\.json|storage[-_]?state(?:\..*)?|credentials?(?:\..*)?|secrets?(?:\..*)?|.*\.(?:pem|p12|pfx|key))$/iu;
const FRAMEWORKS = ['react', 'next', 'vue', 'nuxt', 'svelte', '@angular/core'];
const AUTH_DEPENDENCIES = [
  '@auth0/auth0-react',
  '@okta/okta-react',
  'aws-amplify',
  'next-auth',
  'passport',
];
const LIBRARIES = [
  '@mui/material',
  '@chakra-ui/react',
  'antd',
  'bootstrap',
  'react-bootstrap',
  '@mantine/core',
  'vuetify',
];

function fail(code) {
  throw new Error(code);
}

function git(cwd, args, deadline) {
  if (deadline != null && Date.now() >= deadline) fail('time-budget');
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    timeout:
      deadline == null
        ? DEFAULT_LIMITS.maxDurationMs
        : Math.max(1, deadline - Date.now()),
    maxBuffer: 1024 * 1024,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) fail('git-unavailable');
  return result.stdout;
}

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (relative !== '..' &&
      !relative.startsWith('..' + path.sep) &&
      !path.isAbsolute(relative))
  );
}

function safeRelative(value) {
  const relative = value.replaceAll('\\', '/').replace(/\/$/u, '');
  if (
    relative.length === 0 ||
    relative.length > 240 ||
    path.isAbsolute(value) ||
    relative
      .split('/')
      .some((part) => part === '' || part === '.' || part === '..')
  )
    return null;
  return relative;
}

function excluded(relative) {
  const parts = relative.toLowerCase().split('/');
  return (
    parts.some((part) => EXCLUDED.has(part) || CREDENTIAL.test(part)) ||
    /(?:^|\/)(?:evals|mutations?)(?:\/|$)/u.test(relative)
  );
}

function nestedRoot(root, relative) {
  const parts = relative.split('/');
  let current = root;
  for (const part of parts) {
    current = path.join(current, part);
    if (!inside(root, current)) return null;
    if (current !== root && existsSync(path.join(current, '.git')))
      return path.relative(root, current).replaceAll('\\', '/');
  }
  return null;
}

function ownedFile(root, relative) {
  const absolute = path.join(root, relative);
  const stat = lstatSync(absolute);
  const resolved = realpathSync(absolute);
  if (!stat.isFile() || !inside(root, resolved)) return null;
  const resolvedRelative = path.relative(root, resolved).replaceAll('\\', '/');
  if (excluded(resolvedRelative) || nestedRoot(root, resolvedRelative) != null)
    return null;
  return stat;
}

function listedPaths(root, limits, scan) {
  let output;
  try {
    output = git(
      root,
      ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--'],
      scan.deadline,
    );
  } catch {
    scan.status = 'partial';
    scan.stop_reason =
      Date.now() >= scan.deadline ? 'time-budget' : 'file-list-budget';
    return [];
  }
  const listed = [...new Set(output.split('\0').filter(Boolean))].sort();
  scan.listed_paths = listed.length;
  if (listed.length > limits.maxListedPaths) {
    scan.status = 'partial';
    scan.stop_reason = 'file-list-budget';
  }
  const safe = [];
  for (const value of listed.slice(0, limits.maxListedPaths)) {
    if (Date.now() > scan.deadline) {
      scan.status = 'partial';
      scan.stop_reason = 'time-budget';
      break;
    }
    const relative = safeRelative(value);
    if (relative == null) {
      scan.status = 'partial';
      scan.stop_reason ??= 'invalid-path';
      continue;
    }
    const nested = nestedRoot(root, relative);
    if (nested != null) {
      if (!scan.nested_repositories.includes(nested)) {
        if (scan.nested_repositories.length < 16)
          scan.nested_repositories.push(nested);
        else scan.nested_repositories_truncated = true;
      }
      continue;
    }
    if (excluded(relative)) continue;
    try {
      if (ownedFile(root, relative) == null) continue;
    } catch {
      scan.status = 'partial';
      scan.stop_reason ??= 'unreadable-source';
      continue;
    }
    safe.push(relative);
  }
  scan.nested_repositories.sort();
  return safe;
}

function readText(root, relative, limits, scan) {
  if (scan.files_read >= limits.maxFilesRead) {
    scan.status = 'partial';
    scan.stop_reason ??= 'file-budget';
    return null;
  }
  if (Date.now() > scan.deadline) {
    scan.status = 'partial';
    scan.stop_reason ??= 'time-budget';
    return null;
  }
  try {
    const absolute = path.join(root, relative);
    const stat = ownedFile(root, relative);
    if (stat == null) return null;
    if (
      stat.size > limits.maxFileBytes ||
      scan.bytes_read + stat.size > limits.maxTotalBytes
    ) {
      scan.status = 'partial';
      scan.stop_reason ??= 'byte-budget';
      return null;
    }
    const text = readFileSync(absolute, 'utf8');
    scan.files_read += 1;
    scan.bytes_read += Buffer.byteLength(text);
    if (scan.read_paths.length < 16) scan.read_paths.push(relative);
    return text;
  } catch {
    scan.status = 'partial';
    scan.stop_reason ??= 'unreadable-source';
    return null;
  }
}

function packagesIn(root, paths, limits, scan) {
  const records = [];
  for (const relative of paths.filter(
    (value) => path.posix.basename(value) === 'package.json',
  )) {
    const text = readText(root, relative, limits, scan);
    if (text == null) continue;
    try {
      const manifest = JSON.parse(text);
      records.push({
        path: path.posix.dirname(relative),
        dependencies: { ...manifest.dependencies, ...manifest.devDependencies },
        scripts: manifest.scripts ?? {},
      });
    } catch {
      scan.status = 'partial';
      scan.stop_reason ??= 'unreadable-package';
    }
  }
  return records;
}

function packageCandidates(records) {
  return records.map((record) => record.path).sort();
}

function relevant(relative, selectedPackage) {
  return (
    selectedPackage === '.' ||
    relative === selectedPackage ||
    relative.startsWith(selectedPackage + '/')
  );
}

function ownedByPackage(relative, selectedPackage, packages) {
  return (
    relevant(relative, selectedPackage) &&
    !packages.some(
      (other) =>
        other !== '.' &&
        other !== selectedPackage &&
        relevant(other, selectedPackage) &&
        relative.startsWith(other + '/'),
    )
  );
}

function matchingConfigs(paths, selectedPackage, packages) {
  return paths
    .filter(
      (relative) =>
        CONFIG.test(path.posix.basename(relative)) &&
        (ownedByPackage(relative, selectedPackage, packages) ||
          !relative.includes('/')),
    )
    .sort();
}

function attributeCount(text, attribute) {
  const regex = new RegExp(
    '(?<![A-Za-z0-9_-])' + attribute + '(?![A-Za-z0-9_-])(?=\\s*=)',
    'gu',
  );
  return [...text.matchAll(regex)].length;
}

function configuredTestIds(text) {
  const tokens = [
    ...text.matchAll(
      /\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|[A-Za-z_$][\w$]*|[{}:,.=]/gu,
    ),
  ]
    .map((match) => match[0])
    .filter((token) => !token.startsWith('//') && !token.startsWith('/*'));
  let start = -1;
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index] === 'export' && tokens[index + 1] === 'default')
      start = index + 2;
    if (
      tokens[index] === 'module' &&
      tokens[index + 1] === '.' &&
      tokens[index + 2] === 'exports' &&
      tokens[index + 3] === '='
    )
      start = index + 4;
  }
  const open = tokens.indexOf('{', start);
  if (start < 0 || open < 0) return { values: new Set(), dynamic: false };
  let depth = 0;
  let close = -1;
  for (let index = open; index < tokens.length; index += 1) {
    if (tokens[index] === '{') depth += 1;
    else if (tokens[index] === '}' && --depth === 0) {
      close = index;
      break;
    }
  }
  if (close < 0) return { values: new Set(), dynamic: true };
  const configuration = tokens.slice(open, close + 1);
  const values = new Set();
  let dynamic = false;
  for (let index = 1; index < configuration.length - 2; index += 1) {
    if (
      !['testIdAttribute', "'testIdAttribute'", '"testIdAttribute"'].includes(
        configuration[index],
      ) ||
      !['{', ','].includes(configuration[index - 1]) ||
      configuration[index + 1] !== ':'
    )
      continue;
    const value = configuration[index + 2];
    if (/^(['"])[A-Za-z][A-Za-z0-9_-]*\1$/u.test(value))
      values.add(value.slice(1, -1));
    else dynamic = true;
  }
  return { values, dynamic };
}

function collectFacts(root, paths, record, config, packages, limits, scan) {
  const manifestPath =
    record.path === '.' ? 'package.json' : record.path + '/package.json';
  const facts = {
    frameworks: FRAMEWORKS.filter((name) =>
      Object.hasOwn(record.dependencies, name),
    ).map((name) => ({ name, evidence: manifestPath })),
    framework_status: 'unknown',
    scripts: {
      lint: Object.keys(record.scripts)
        .filter((name) => /lint|eslint/iu.test(name))
        .sort(),
      format: Object.keys(record.scripts)
        .filter((name) => /format|prettier/iu.test(name))
        .sort(),
    },
    layout: { tests: [], helpers: [], fixtures: [], naming: {} },
    component_libraries: [],
    component_library_status: 'unknown',
    test_id: {
      status: 'unknown',
      attribute: null,
      config_attribute: null,
      counts: Object.fromEntries(ATTRIBUTES.map((name) => [name, 0])),
      source_counts: Object.fromEntries(ATTRIBUTES.map((name) => [name, 0])),
      test_counts: Object.fromEntries(ATTRIBUTES.map((name) => [name, 0])),
      evidence: [],
    },
    authentication: { status: 'unknown', mechanisms: [] },
  };
  let configured = new Set();
  let dynamicConfig = false;
  if (config != null) {
    const text = readText(root, config, limits, scan);
    if (text != null) {
      ({ values: configured, dynamic: dynamicConfig } =
        configuredTestIds(text));
      if (configured.size === 1 && !dynamicConfig) {
        const [name] = configured;
        facts.test_id.config_attribute = name;
        if (!ATTRIBUTES.includes(name)) {
          facts.test_id.counts[name] = 0;
          facts.test_id.source_counts[name] = 0;
          facts.test_id.test_counts[name] = 0;
        }
      }
    }
  }
  const libraries = new Map();
  const auth = new Map();
  if (
    AUTH_DEPENDENCIES.some((name) => Object.hasOwn(record.dependencies, name))
  )
    auth.set('auth-dependency', manifestPath);
  for (const relative of paths.filter(
    (value) =>
      ownedByPackage(value, record.path, packages) &&
      SOURCE.test(value) &&
      value !== config,
  )) {
    const filename = path.posix.basename(relative);
    const isTest =
      /(?:^|\/)(?:tests?|__tests__)(?:\/|$)|(?:^|\/)cypress\/(?:e2e|tests?)\/|\.(?:spec|test|cy)\./iu.test(
        relative,
      );
    const isTestCode = isTest || /(?:^|\/)cypress\//iu.test(relative);
    const text = readText(root, relative, limits, scan);
    if (text == null) continue;
    const naming = filename.match(/\.(?:spec|test|cy)\.[cm]?[jt]sx?$/u)?.[0];
    if (naming)
      facts.layout.naming[naming] = (facts.layout.naming[naming] ?? 0) + 1;
    if (isTest && facts.layout.tests.length < 8)
      facts.layout.tests.push(relative);
    if (
      /(?:helpers?|page[-_]?objects?|support)(?:\/|\.)/iu.test(relative) &&
      facts.layout.helpers.length < 8
    )
      facts.layout.helpers.push(relative);
    if (
      /(?:fixtures?)(?:\/|\.)/iu.test(relative) &&
      facts.layout.fixtures.length < 8
    )
      facts.layout.fixtures.push(relative);
    for (const name of Object.keys(facts.test_id.counts)) {
      const count = attributeCount(text, name);
      facts.test_id.counts[name] += count;
      facts.test_id[isTestCode ? 'test_counts' : 'source_counts'][name] +=
        count;
      if (count > 0 && facts.test_id.evidence.length < 8)
        facts.test_id.evidence.push(relative);
    }
    for (const match of text.matchAll(/\bfrom\s+['"]([^'"]+)['"]/gu)) {
      for (const name of LIBRARIES)
        if (match[1] === name || match[1].startsWith(name + '/'))
          libraries.set(name, libraries.get(name) ?? relative);
      if (
        /^(?:@\/|~\/|\.{1,2}\/)/u.test(match[1]) &&
        /(?:^|\/)components\/ui\//u.test(match[1])
      )
        libraries.set(
          'local-ui-components',
          libraries.get('local-ui-components') ?? relative,
        );
    }
    if (/\bstorageState\s*[:=(]/u.test(text))
      auth.set('storage-state-use', auth.get('storage-state-use') ?? relative);
    if (/\btest\.extend\s*(?:<|\()/u.test(text) && /\bauth/u.test(text))
      auth.set('test-fixture-use', auth.get('test-fixture-use') ?? relative);
  }
  facts.component_libraries = [...libraries].map(([name, evidence]) => ({
    name,
    evidence,
  }));
  facts.framework_status = facts.frameworks.length > 0 ? 'detected' : 'unknown';
  facts.component_library_status = libraries.size > 0 ? 'detected' : 'unknown';
  facts.authentication = {
    status: auth.size > 0 ? 'detected' : 'unknown',
    mechanisms: [...auth].map(([kind, evidence]) => ({ kind, evidence })),
  };
  const used = Object.entries(facts.test_id.counts)
    .filter(([, count]) => count > 0)
    .map(([name]) => name);
  const sourceUsed = Object.entries(facts.test_id.source_counts)
    .filter(([, count]) => count > 0)
    .map(([name]) => name);
  if (scan.status === 'partial') facts.authentication.status = 'unknown';
  if (
    scan.status === 'partial' ||
    configured.size > 1 ||
    dynamicConfig ||
    (sourceUsed.length === 0 && used.length > 0)
  )
    facts.test_id.status = 'unknown';
  else if (
    configured.size === 1 &&
    sourceUsed.length > 0 &&
    sourceUsed.some((name) => !configured.has(name))
  )
    facts.test_id.status = 'ambiguous';
  else if (used.length === 0) facts.test_id.status = 'none-found';
  else if (
    used.length === 1 &&
    (ATTRIBUTES.includes(used[0]) || configured.has(used[0]))
  ) {
    facts.test_id.status = 'detected';
    facts.test_id.attribute = used[0];
  } else facts.test_id.status = 'ambiguous';
  return facts;
}

function profileRepository({
  repository,
  selectedPackage,
  selectedConfig,
  limits: overrides = {},
}) {
  if (typeof repository !== 'string' || repository.length === 0)
    fail('repository-required');
  const limits = Object.fromEntries(
    Object.entries(DEFAULT_LIMITS).map(([key, value]) => [
      key,
      Number.isSafeInteger(overrides[key]) && overrides[key] > 0
        ? Math.min(overrides[key], value)
        : value,
    ]),
  );
  const deadline = Date.now() + limits.maxDurationMs;
  let root;
  try {
    const cwd = realpathSync(path.resolve(repository));
    root = realpathSync(
      git(cwd, ['rev-parse', '--show-toplevel'], deadline).trim(),
    );
    if (!inside(root, cwd)) fail('repository-root-invalid');
  } catch (error) {
    if (Date.now() >= deadline || error.message === 'time-budget')
      fail('time-budget');
    fail('repository-root-invalid');
  }
  const scan = {
    status: 'complete',
    stop_reason: null,
    listed_paths: 0,
    files_read: 0,
    bytes_read: 0,
    read_paths: [],
    nested_repositories: [],
    nested_repositories_truncated: false,
    limits,
    deadline,
  };
  const paths = listedPaths(root, limits, scan);
  const records = packagesIn(root, paths, limits, scan);
  const packagePaths = records.map((record) => record.path);
  const packages = packageCandidates(records);
  const discoveryPartial = scan.status === 'partial';
  if (
    selectedPackage != null &&
    !packages.includes(selectedPackage) &&
    !discoveryPartial
  )
    fail('package-selection-invalid');
  const packagePath =
    selectedPackage != null
      ? packages.includes(selectedPackage)
        ? selectedPackage
        : null
      : !discoveryPartial && packages.length === 1
        ? packages[0]
        : null;
  const configs =
    packagePath == null
      ? []
      : matchingConfigs(paths, packagePath, packagePaths);
  if (
    selectedConfig != null &&
    !configs.includes(selectedConfig) &&
    !discoveryPartial
  )
    fail('config-selection-invalid');
  const config =
    selectedConfig != null
      ? configs.includes(selectedConfig)
        ? selectedConfig
        : null
      : !discoveryPartial && configs.length === 1
        ? configs[0]
        : null;
  const status = discoveryPartial
    ? 'unknown'
    : packagePath == null
      ? packages.length === 0
        ? 'package-unavailable'
        : 'package-required'
      : configs.length > 1 && config == null
        ? 'config-required'
        : config == null
          ? 'config-unavailable'
          : 'selected';
  const record = records.find((item) => item.path === packagePath);
  const facts =
    status === 'selected' || status === 'config-unavailable'
      ? collectFacts(root, paths, record, config, packagePaths, limits, scan)
      : null;
  delete scan.deadline;
  const report = {
    ok: true,
    schema_version: 'repository-scan.v1',
    root,
    selection: {
      status,
      package: packagePath,
      config,
      packages: packages.slice(0, 16),
      configs: configs.slice(0, 16),
    },
    scan,
    facts,
  };
  if (Buffer.byteLength(JSON.stringify(report)) > limits.maxOutputBytes) {
    report.scan.status = 'partial';
    report.scan.stop_reason = 'output-budget';
    report.scan.read_paths = [];
    report.facts = null;
  }
  return report;
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (typeof value !== 'string' || value.length === 0)
      fail('arguments-invalid');
    if (key === '--repo' && options.repository == null)
      options.repository = value;
    else if (key === '--package' && options.selectedPackage == null)
      options.selectedPackage = value;
    else if (key === '--config' && options.selectedConfig == null)
      options.selectedConfig = value;
    else fail('arguments-invalid');
  }
  return options;
}

function main() {
  try {
    process.stdout.write(
      JSON.stringify(profileRepository(parseArguments(process.argv.slice(2)))) +
        '\n',
    );
  } catch (error) {
    const code = /^[a-z][a-z-]{0,79}$/u.test(error.message)
      ? error.message
      : 'repository-profile-failed';
    process.stdout.write(JSON.stringify({ ok: false, error: code }) + '\n');
    process.exitCode = 1;
  }
}

if (require.main === module) main();
module.exports = { DEFAULT_LIMITS, profileRepository };

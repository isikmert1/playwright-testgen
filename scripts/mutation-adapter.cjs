const { createHash } = require('node:crypto');
const { lstatSync, readFileSync, realpathSync, statSync } = require('node:fs');
const path = require('node:path');
const {
  isInside,
  isIdentifier,
  isObject,
  isRepoPath,
  portable,
} = require('./artifact-validation-common.cjs');
const { MutationCheckError } = require('./mutation-check-error.cjs');
const { comparablePath } = require('../hooks/run-policy.cjs');

const DIGEST = /^[a-f0-9]{64}$/u;
const MAX_ADAPTER_SIZE = 128 * 1024;
const MAX_PATCH_SIZE = 512 * 1024;
const MAX_RUNNER_SIZE = 64 * 1024;

function fail(code) {
  throw new MutationCheckError(code);
}

function exactKeys(value, keys) {
  return (
    isObject(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function safeFile(repository, relativePath, label) {
  if (!isRepoPath(relativePath)) fail(`${label}-invalid-path`);
  const absolute = path.resolve(repository, relativePath);
  if (!isInside(repository, absolute)) fail(`${label}-outside-repository`);
  let canonical;
  try {
    if (!lstatSync(absolute).isFile()) fail(`${label}-not-file`);
    canonical = realpathSync(absolute);
    if (!statSync(canonical).isFile()) fail(`${label}-not-file`);
  } catch (error) {
    if (error instanceof MutationCheckError) throw error;
    fail(`${label}-unavailable`);
  }
  if (!isInside(repository, canonical)) fail(`${label}-outside-repository`);
  const normalized = portable(path.relative(repository, absolute));
  const protectedPath = comparablePath(normalized);
  if (
    protectedPath === '.git' ||
    protectedPath.startsWith('.git/') ||
    protectedPath === '.playwright-cli/testgen' ||
    protectedPath.startsWith('.playwright-cli/testgen/')
  )
    fail(`${label}-protected-path`);
  return { absolute, relative: normalized };
}

function parseAdapter(repository, adapterInput) {
  const adapterFile = safeFile(repository, adapterInput, 'adapter');
  let adapter;
  try {
    if (statSync(adapterFile.absolute).size > MAX_ADAPTER_SIZE)
      fail('adapter-too-large');
    adapter = JSON.parse(readFileSync(adapterFile.absolute, 'utf8'));
  } catch (error) {
    if (error instanceof MutationCheckError) throw error;
    fail('adapter-invalid-json');
  }
  if (
    !exactKeys(adapter, [
      'schema_version',
      'adapter_id',
      'runner_path',
      'mutations',
    ]) ||
    adapter.schema_version !== 'mutation-adapter.v1' ||
    !isIdentifier(adapter.adapter_id) ||
    !Array.isArray(adapter.mutations) ||
    adapter.mutations.length === 0 ||
    adapter.mutations.length > 100
  )
    fail('adapter-invalid');

  const runner = safeFile(repository, adapter.runner_path, 'runner');
  if (statSync(runner.absolute).size > MAX_RUNNER_SIZE)
    fail('runner-too-large');
  const mutationIds = new Set();
  const criterionIds = new Set();
  const mutations = adapter.mutations.map((mutation) => {
    if (
      !exactKeys(mutation, [
        'mutation_id',
        'criterion_id',
        'affected_paths',
        'patch_path',
        'definition_digest',
        'timeout_ms',
      ]) ||
      !isIdentifier(mutation.mutation_id) ||
      !isIdentifier(mutation.criterion_id) ||
      !DIGEST.test(mutation.definition_digest ?? '') ||
      !Number.isInteger(mutation.timeout_ms) ||
      mutation.timeout_ms < 1000 ||
      mutation.timeout_ms > 120000 ||
      !Array.isArray(mutation.affected_paths) ||
      mutation.affected_paths.length === 0 ||
      mutation.affected_paths.length > 20
    )
      fail('adapter-mutation-invalid');
    if (
      mutationIds.has(mutation.mutation_id) ||
      criterionIds.has(mutation.criterion_id)
    )
      fail('adapter-mutation-duplicate');
    mutationIds.add(mutation.mutation_id);
    criterionIds.add(mutation.criterion_id);

    const affectedPaths = mutation.affected_paths.map((value) =>
      safeFile(repository, value, 'affected-path'),
    );
    const comparable = affectedPaths.map(({ relative }) =>
      process.platform === 'win32' ? relative.toLowerCase() : relative,
    );
    if (new Set(comparable).size !== comparable.length)
      fail('affected-path-duplicate');
    const patch = safeFile(repository, mutation.patch_path, 'patch');
    if (statSync(patch.absolute).size > MAX_PATCH_SIZE) fail('patch-too-large');
    return {
      ...mutation,
      affected_paths: affectedPaths
        .map(({ relative }) => relative)
        .sort((left, right) => left.localeCompare(right, 'en')),
      patch,
    };
  });
  const definitions = new Set(
    [
      adapterFile.relative,
      runner.relative,
      ...mutations.map(({ patch }) => patch.relative),
    ].map(comparablePath),
  );
  if (
    mutations.some((mutation) =>
      mutation.affected_paths.some((value) =>
        definitions.has(comparablePath(value)),
      ),
    )
  )
    fail('adapter-definition-overlap');
  return { adapter, adapterFile, mutations, repository, runner };
}

function hashFile(filename) {
  return createHash('sha256').update(readFileSync(filename)).digest('hex');
}

function definitionDigest(parsed, mutation) {
  const definition = {
    schema_version: 'mutation-adapter.v1',
    adapter_id: parsed.adapter.adapter_id,
    runner_path: parsed.runner.relative,
    mutation_id: mutation.mutation_id,
    criterion_id: mutation.criterion_id,
    affected_paths: mutation.affected_paths,
    patch_path: mutation.patch.relative,
    timeout_ms: mutation.timeout_ms,
    runner_sha256: hashFile(parsed.runner.absolute),
    patch_sha256: hashFile(mutation.patch.absolute),
  };
  return createHash('sha256').update(JSON.stringify(definition)).digest('hex');
}

function digestAdapter(repositoryInput, adapterInput, mutationId) {
  let repository;
  try {
    repository = realpathSync(repositoryInput);
  } catch {
    fail('repository-unavailable');
  }
  const parsed = parseAdapter(repository, adapterInput);
  const mutation = parsed.mutations.find(
    (candidate) => candidate.mutation_id === mutationId,
  );
  if (mutation == null) fail('mutation-not-found');
  return {
    adapter_id: parsed.adapter.adapter_id,
    mutation_id: mutation.mutation_id,
    criterion_id: mutation.criterion_id,
    definition_digest: definitionDigest(parsed, mutation),
  };
}

module.exports = {
  definitionDigest,
  digestAdapter,
  parseAdapter,
  safeFile,
};

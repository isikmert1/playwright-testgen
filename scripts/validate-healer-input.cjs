const { createHash } = require('node:crypto');
const { readFileSync, realpathSync, statSync } = require('node:fs');
const path = require('node:path');
const {
  containsProhibited,
  isFile,
  isIdentifier,
  isObject,
  isText,
  loadSchema,
  portable,
  rejectUnknown,
  requireFields,
  samePath,
  validatePath,
  validateStringArray,
} = require('./artifact-validation-common.cjs');
const { loadValidatedHandoff } = require('./validate-author-handoff.cjs');

const SHA256 = /^[a-f0-9]{64}$/u;

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

function parseAssertionLocation(value) {
  if (typeof value !== 'string') return null;
  const suffix = /:([1-9][0-9]*)(?::([1-9][0-9]*))?$/u.exec(value);
  if (suffix == null || suffix.index === 0) return null;
  return {
    column: suffix[2] ?? null,
    line: suffix[1],
    path: value.slice(0, suffix.index),
  };
}

function normalizeAssertionLocation(value) {
  const parsed = parseAssertionLocation(value);
  if (parsed == null) return value;
  const location = `${portable(path.normalize(portable(parsed.path)))}:${parsed.line}`;
  return parsed.column == null ? location : `${location}:${parsed.column}`;
}

function normalizedCriteria(handoff) {
  return handoff.criteria.map((criterion) => ({
    id: criterion.id,
    outcome: criterion.outcome,
    assertion_locations: [
      normalizeAssertionLocation(criterion.assertion_location),
    ],
    step_title: criterion.step_title,
  }));
}

function validateCriteria(criteria, repository, errors) {
  if (!Array.isArray(criteria) || criteria.length < 1 || criteria.length > 20) {
    errors.push('input-invalid-criteria');
    return;
  }
  const ids = new Set();
  for (const criterion of criteria) {
    if (!isObject(criterion)) {
      errors.push('input-invalid-criterion');
      continue;
    }
    const fields = ['id', 'outcome', 'assertion_locations', 'step_title'];
    requireFields(criterion, fields, errors, 'input-criterion');
    rejectUnknown(criterion, new Set(fields), errors, 'input-criterion');
    if (!isIdentifier(criterion.id)) errors.push('input-invalid-criterion-id');
    else if (ids.has(criterion.id)) errors.push('input-duplicate-criterion-id');
    else ids.add(criterion.id);
    if (!isText(criterion.outcome, 200))
      errors.push('input-invalid-criterion-outcome');
    if (criterion.step_title !== null && !isText(criterion.step_title, 160))
      errors.push('input-invalid-step-title');
    validateStringArray(
      criterion.assertion_locations,
      10,
      240,
      errors,
      'input-assertion-locations',
      1,
    );
    if (Array.isArray(criterion.assertion_locations)) {
      if (
        new Set(criterion.assertion_locations.map(normalizeAssertionLocation))
          .size !== criterion.assertion_locations.length
      )
        errors.push('input-duplicate-assertion-location');
      for (const location of criterion.assertion_locations) {
        if (typeof location !== 'string') continue;
        const parsed = parseAssertionLocation(
          normalizeAssertionLocation(location),
        );
        if (parsed == null) {
          errors.push('input-invalid-assertion-location');
          continue;
        }
        const pathErrors = [];
        validatePath(
          parsed.path,
          repository,
          pathErrors,
          'input-assertion-location',
        );
        errors.push(...pathErrors);
        if (
          pathErrors.length === 0 &&
          !isFile(path.resolve(repository, parsed.path))
        )
          errors.push('input-assertion-location-not-file');
      }
    }
  }
}

function validateSource(artifact, repository, runPolicy, errors) {
  if (!isObject(artifact.source)) {
    errors.push('input-invalid-source');
    return;
  }
  const fields = ['kind', 'handoff_sha256'];
  requireFields(artifact.source, fields, errors, 'input-source');
  rejectUnknown(artifact.source, new Set(fields), errors, 'input-source');
  if (artifact.mode === 'standalone') {
    if (
      artifact.source.kind !== 'human-approved-existing-spec' ||
      artifact.source.handoff_sha256 !== null
    )
      errors.push('input-source-mode-mismatch');
    return;
  }
  if (
    artifact.source.kind !== 'author-handoff' ||
    !SHA256.test(artifact.source.handoff_sha256 ?? '')
  ) {
    errors.push('input-source-mode-mismatch');
    return;
  }
  const handoff = loadValidatedHandoff(repository, runPolicy, artifact.run_id);
  if (handoff == null) {
    errors.push('input-handoff-unavailable');
    return;
  }
  const handoffPath = path.join(runPolicy.runDirectory, 'handoff.json');
  if (digest(readFileSync(handoffPath)) !== artifact.source.handoff_sha256)
    errors.push('input-handoff-digest-mismatch');
  if (
    JSON.stringify(artifact.criteria) !==
    JSON.stringify(normalizedCriteria(handoff))
  )
    errors.push('input-criteria-mismatch');
}

function validateHealerInput(
  artifact,
  repository,
  runPolicy,
  errors,
  verifyStartingSpec = true,
) {
  const fields = [
    'schema_version',
    'run_id',
    'mode',
    'spec_path',
    'starting_spec_sha256',
    'criteria',
    'source',
  ];
  requireFields(artifact, fields, errors, 'input');
  rejectUnknown(artifact, new Set(fields), errors, 'input');
  if (artifact.schema_version !== 'healer-input.v1')
    errors.push('input-schema-version');
  if (!['pipeline', 'standalone'].includes(artifact.mode))
    errors.push('input-invalid-mode');
  validatePath(artifact.spec_path, repository, errors, 'input-spec');
  if (!SHA256.test(artifact.starting_spec_sha256 ?? ''))
    errors.push('input-invalid-spec-digest');
  else if (verifyStartingSpec) {
    try {
      if (
        digest(readFileSync(runPolicy.approvedSpec)) !==
        artifact.starting_spec_sha256
      )
        errors.push('input-spec-digest-mismatch');
    } catch {
      errors.push('input-spec-unavailable');
    }
  }
  validateCriteria(artifact.criteria, repository, errors);
  validateSource(artifact, repository, runPolicy, errors);
}

function loadHealerInput(repository, runPolicy, runId) {
  if (loadSchema('input') == null) return null;
  const inputPath = path.join(runPolicy.runDirectory, 'healer-input.json');
  try {
    const canonical = realpathSync(inputPath);
    if (
      !samePath(
        canonical,
        path.join(runPolicy.canonicalRunDirectory, 'healer-input.json'),
      ) ||
      !isFile(canonical) ||
      statSync(canonical).size > 64 * 1024
    )
      return null;
    const artifact = JSON.parse(readFileSync(canonical, 'utf8'));
    if (!isObject(artifact) || containsProhibited(artifact)) return null;
    const errors = [];
    if (artifact.run_id !== runId) errors.push('run-id-mismatch');
    if (
      typeof artifact.spec_path !== 'string' ||
      !samePath(
        path.resolve(repository, artifact.spec_path),
        runPolicy.approvedSpec,
      )
    )
      errors.push('policy-spec-mismatch');
    validateHealerInput(artifact, repository, runPolicy, errors, false);
    return errors.length === 0 ? artifact : null;
  } catch {
    return null;
  }
}

module.exports = {
  loadHealerInput,
  normalizeAssertionLocation,
  normalizedCriteria,
  validateHealerInput,
};

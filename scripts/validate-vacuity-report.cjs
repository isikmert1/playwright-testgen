const path = require('node:path');
const {
  comparableRepoPath,
  isFile,
  isIdentifier,
  isObject,
  isRepoPath,
  isText,
  rejectUnknown,
  requireFields,
  validatePath,
} = require('./artifact-validation-common.cjs');

const OUTCOMES = new Set([null, 'pass', 'fail', 'error']);
const BEHAVIOR_STATUSES = new Set([
  'killed',
  'survived',
  'unavailable',
  'error',
]);
const ASSERTION_STATUSES = new Set(['killed', 'survived', 'not-run', 'error']);
const DISPOSITIONS = new Set([
  'verified-non-vacuous',
  'rejected-vacuous',
  'assertion-sensitive-only',
  'mutation-not-verified',
  'verification-error',
]);
const ERROR_CODE = /^[a-z][a-z0-9-]{0,79}$/u;
const DIGEST = /^[a-f0-9]{64}$/u;

function exactObject(value, fields, errors, label) {
  if (!isObject(value)) {
    errors.push(`${label}-not-object`);
    return false;
  }
  requireFields(value, fields, errors, label);
  rejectUnknown(value, new Set(fields), errors, label);
  return true;
}

function validError(value) {
  return value === null || (isText(value, 80) && ERROR_CODE.test(value));
}

function validateMutation(value, repository, handoffCriteria, errors) {
  const fields = [
    'adapter_id',
    'mutation_id',
    'criterion_id',
    'definition_digest',
    'affected_paths',
  ];
  if (!exactObject(value, fields, errors, 'report-mutation')) return;
  if (!isIdentifier(value.adapter_id) || !isIdentifier(value.mutation_id))
    errors.push('report-invalid-mutation-id');
  if (!isIdentifier(value.criterion_id)) {
    errors.push('report-invalid-criterion');
  } else if (!handoffCriteria?.has(value.criterion_id)) {
    errors.push('report-unknown-criterion');
  }
  if (!DIGEST.test(value.definition_digest ?? ''))
    errors.push('report-invalid-definition-digest');
  if (
    !Array.isArray(value.affected_paths) ||
    value.affected_paths.length < 1 ||
    value.affected_paths.length > 20
  ) {
    errors.push('report-invalid-affected-paths');
    return;
  }
  const paths = value.affected_paths.filter(
    (candidate) => typeof candidate === 'string',
  );
  if (
    paths.length !== value.affected_paths.length ||
    new Set(paths.map(comparableRepoPath)).size !== paths.length
  )
    errors.push('report-invalid-affected-paths');
  for (const affectedPath of paths)
    validatePath(affectedPath, repository, errors, 'report-affected-path');
}

function validateBehavior(value, repository, handoffCriteria, errors) {
  const fields = [
    'status',
    'mutation',
    'baseline',
    'mutant',
    'reason',
    'error',
    'isolation',
    'cleanup',
  ];
  if (!exactObject(value, fields, errors, 'report-behavior')) return;
  if (!BEHAVIOR_STATUSES.has(value.status))
    errors.push('report-invalid-behavior-status');
  if (!OUTCOMES.has(value.baseline) || !OUTCOMES.has(value.mutant))
    errors.push('report-invalid-behavior-outcome');
  if (!validError(value.error)) errors.push('report-invalid-behavior-error');
  if (value.mutation !== null)
    validateMutation(value.mutation, repository, handoffCriteria, errors);

  if (value.status === 'killed' || value.status === 'survived') {
    if (
      !isObject(value.mutation) ||
      value.baseline !== 'pass' ||
      value.mutant !== (value.status === 'killed' ? 'fail' : 'pass') ||
      value.reason !== null ||
      value.error !== null ||
      value.isolation !== 'disposable-worktree' ||
      value.cleanup !== 'removed'
    )
      errors.push('report-invalid-behavior-result');
  } else if (value.status === 'unavailable') {
    if (!['adapter-absent', 'criterion-unmapped'].includes(value.reason))
      errors.push('report-invalid-unavailable-reason');
    if (
      value.mutation !== null ||
      value.baseline !== null ||
      value.mutant !== null ||
      value.error !== null ||
      value.isolation !== 'not-run' ||
      value.cleanup !== 'not-run'
    )
      errors.push('report-invalid-behavior-result');
  } else if (value.status === 'error') {
    const cleanupMatchesIsolation =
      (value.isolation === 'not-run' && value.cleanup === 'not-run') ||
      (value.isolation === 'disposable-worktree' &&
        ['removed', 'failed'].includes(value.cleanup));
    if (
      value.reason !== null ||
      !isText(value.error, 80) ||
      !ERROR_CODE.test(value.error ?? '') ||
      !cleanupMatchesIsolation
    )
      errors.push('report-invalid-behavior-result');
  }
}

function validateAssertionSensitivity(value, errors) {
  const fields = [
    'status',
    'baseline',
    'mutant',
    'error',
    'isolation',
    'cleanup',
  ];
  if (!exactObject(value, fields, errors, 'report-assertion')) return;
  if (!ASSERTION_STATUSES.has(value.status))
    errors.push('report-invalid-assertion-status');
  if (!OUTCOMES.has(value.baseline) || !OUTCOMES.has(value.mutant))
    errors.push('report-invalid-assertion-outcome');
  if (!validError(value.error)) errors.push('report-invalid-assertion-error');

  if (value.status === 'killed' || value.status === 'survived') {
    if (
      value.baseline !== 'pass' ||
      value.mutant !== (value.status === 'killed' ? 'fail' : 'pass') ||
      value.error !== null ||
      value.isolation !== 'disposable-copy' ||
      value.cleanup !== 'removed'
    )
      errors.push('report-invalid-assertion-result');
  } else if (value.status === 'not-run') {
    if (
      value.baseline !== null ||
      value.mutant !== null ||
      value.error !== null ||
      value.isolation !== 'not-run' ||
      value.cleanup !== 'not-run'
    )
      errors.push('report-invalid-assertion-result');
  } else if (value.status === 'error') {
    const cleanupMatchesIsolation =
      (value.isolation === 'not-run' && value.cleanup === 'not-run') ||
      (value.isolation === 'disposable-copy' &&
        ['removed', 'failed'].includes(value.cleanup));
    if (
      !isText(value.error, 80) ||
      !ERROR_CODE.test(value.error ?? '') ||
      !cleanupMatchesIsolation
    )
      errors.push('report-invalid-assertion-result');
  }
}

function expectedDisposition(behaviorStatus, assertionStatus) {
  if (behaviorStatus === 'killed') return 'verified-non-vacuous';
  if (behaviorStatus === 'survived') return 'rejected-vacuous';
  if (behaviorStatus === 'error') return 'verification-error';
  if (behaviorStatus !== 'unavailable') return null;
  if (assertionStatus === 'killed') return 'assertion-sensitive-only';
  if (assertionStatus === 'survived') return 'rejected-vacuous';
  if (assertionStatus === 'not-run') return 'mutation-not-verified';
  if (assertionStatus === 'error') return 'verification-error';
  return null;
}

function validateVacuityReport(artifact, repository, handoffCriteria, errors) {
  const fields = [
    'schema_version',
    'run_id',
    'spec_path',
    'behavior',
    'assertion_sensitivity',
    'disposition',
  ];
  requireFields(artifact, fields, errors, 'report');
  rejectUnknown(artifact, new Set(fields), errors, 'report');
  if (artifact.schema_version !== 'vacuity-report.v1')
    errors.push('report-schema-version');
  validatePath(artifact.spec_path, repository, errors, 'report-spec');
  if (
    isRepoPath(artifact.spec_path) &&
    !isFile(path.resolve(repository, artifact.spec_path))
  )
    errors.push('report-spec-unavailable');
  validateBehavior(artifact.behavior, repository, handoffCriteria, errors);
  validateAssertionSensitivity(artifact.assertion_sensitivity, errors);
  if (!DISPOSITIONS.has(artifact.disposition))
    errors.push('report-invalid-disposition');
  const expected = expectedDisposition(
    artifact.behavior?.status,
    artifact.assertion_sensitivity?.status,
  );
  if (expected != null && artifact.disposition !== expected)
    errors.push('report-disposition-mismatch');
}

module.exports = { validateVacuityReport };

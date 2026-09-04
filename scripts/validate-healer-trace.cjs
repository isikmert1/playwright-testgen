const path = require('node:path');
const {
  CLASSIFICATIONS,
  comparableRepoPath,
  DISPOSITIONS,
  REPAIRABLE_CLASSIFICATIONS,
  TERMINAL_CLASSIFICATIONS,
  isFile,
  isIdentifier,
  isObject,
  isRepoPath,
  isText,
  rejectUnknown,
  requireFields,
  validatePath,
  validateStringArray,
} = require('./artifact-validation-common.cjs');

function validateProductEvidence(value, handoffCriteria, errors) {
  if (!isObject(value)) {
    errors.push('trace-missing-product-behavior-evidence');
    return;
  }
  const fields = [
    'criterion_id',
    'required_outcome',
    'observed_behavior',
    'contradiction',
    'expectation_drift_rejected',
  ];
  requireFields(value, fields, errors, 'product-behavior-evidence');
  rejectUnknown(value, new Set(fields), errors, 'product-behavior-evidence');
  if (!isIdentifier(value.criterion_id))
    errors.push('trace-invalid-product-criterion');
  else {
    const retainedOutcome = handoffCriteria?.get(value.criterion_id);
    if (retainedOutcome == null) errors.push('trace-unknown-product-criterion');
    else if (value.required_outcome !== retainedOutcome)
      errors.push('trace-product-outcome-mismatch');
  }
  for (const field of fields.slice(1)) {
    if (!isText(value[field], 240))
      errors.push('trace-invalid-product-behavior-evidence');
  }
}

function validateTrace(artifact, repository, handoffCriteria, errors) {
  const required = [
    'schema_version',
    'run_id',
    'spec_path',
    'handoff_read',
    'attempts',
    'repairs',
    'final_classification',
    'disposition',
    'next_owner',
    'escalation',
    'cleanup',
  ];
  requireFields(artifact, required, errors, 'trace');
  rejectUnknown(artifact, new Set(required), errors, 'trace');
  if (artifact.schema_version !== 'healer-trace.v1')
    errors.push('trace-schema-version');
  validatePath(artifact.spec_path, repository, errors, 'trace-spec');
  if (
    isRepoPath(artifact.spec_path) &&
    !isFile(path.resolve(repository, artifact.spec_path))
  ) {
    errors.push('trace-spec-unavailable');
  }
  if (artifact.handoff_read !== true) errors.push('trace-handoff-not-read');
  if (
    !Array.isArray(artifact.attempts) ||
    artifact.attempts.length < 1 ||
    artifact.attempts.length > 5
  ) {
    errors.push('trace-invalid-attempts');
  } else {
    for (const [index, attempt] of artifact.attempts.entries()) {
      if (!isObject(attempt)) {
        errors.push('trace-invalid-attempt');
        continue;
      }
      const fields = [
        'number',
        'kind',
        'hypothesis',
        'failure_signature',
        'evidence_summary',
        'classification',
        'action',
        'outcome',
      ];
      requireFields(attempt, fields, errors, 'attempt');
      rejectUnknown(
        attempt,
        new Set([...fields, 'product_behavior_evidence']),
        errors,
        'attempt',
      );
      if (attempt.number !== index + 1)
        errors.push('trace-nonsequential-attempt');
      if (!['debug-run', 'confirmation-run'].includes(attempt.kind))
        errors.push('trace-invalid-attempt-kind');
      if (
        !isText(attempt.hypothesis, 200) ||
        !isText(attempt.evidence_summary, 240)
      )
        errors.push('trace-invalid-attempt-summary');
      if (
        attempt.failure_signature !== null &&
        !isText(attempt.failure_signature, 160)
      )
        errors.push('trace-invalid-failure-signature');
      if (
        attempt.classification !== null &&
        !CLASSIFICATIONS.has(attempt.classification)
      )
        errors.push('trace-invalid-attempt-classification');
      if (!['pass', 'fail', 'blocked'].includes(attempt.outcome))
        errors.push('trace-invalid-attempt-outcome');
      if (attempt.action !== null && !isText(attempt.action, 200))
        errors.push('trace-invalid-action');
      if (
        attempt.outcome === 'pass' &&
        (attempt.failure_signature !== null || attempt.classification !== null)
      )
        errors.push('trace-passing-attempt-has-failure');
      if (
        ['fail', 'blocked'].includes(attempt.outcome) &&
        (attempt.classification == null || !isText(attempt.action, 200))
      )
        errors.push('trace-failed-attempt-missing-decision');
      if (attempt.classification === 'product-behavior-wrong') {
        validateProductEvidence(
          attempt.product_behavior_evidence,
          handoffCriteria,
          errors,
        );
      } else if (
        attempt.product_behavior_evidence !== null &&
        attempt.product_behavior_evidence !== undefined
      ) {
        errors.push('trace-unexpected-product-behavior-evidence');
      }
    }
    const terminalIndex = artifact.attempts.findIndex(
      (attempt) =>
        isObject(attempt) &&
        TERMINAL_CLASSIFICATIONS.has(attempt.classification),
    );
    if (terminalIndex >= 0 && terminalIndex !== artifact.attempts.length - 1)
      errors.push('trace-attempt-after-terminal-classification');
  }
  if (!Array.isArray(artifact.repairs) || artifact.repairs.length > 10) {
    errors.push('trace-invalid-repairs');
  } else {
    for (const repair of artifact.repairs) {
      if (!isObject(repair)) {
        errors.push('trace-invalid-repair');
        continue;
      }
      const fields = ['attempt_number', 'paths', 'reason'];
      requireFields(repair, fields, errors, 'repair');
      rejectUnknown(repair, new Set(fields), errors, 'repair');
      if (
        !Number.isInteger(repair.attempt_number) ||
        repair.attempt_number < 1 ||
        repair.attempt_number > 5
      )
        errors.push('trace-invalid-repair-attempt');
      const repairedAttempt = Array.isArray(artifact.attempts)
        ? artifact.attempts[repair.attempt_number - 1]
        : null;
      if (
        !isObject(repairedAttempt) ||
        repairedAttempt.number !== repair.attempt_number ||
        !REPAIRABLE_CLASSIFICATIONS.has(repairedAttempt.classification)
      )
        errors.push('trace-repair-for-unrepairable-attempt');
      validateStringArray(
        repair.paths,
        3,
        240,
        errors,
        'trace-repair-paths',
        1,
      );
      if (Array.isArray(repair.paths)) {
        const paths = repair.paths.filter((item) => typeof item === 'string');
        if (new Set(paths.map(comparableRepoPath)).size !== repair.paths.length)
          errors.push('trace-duplicate-repair-path');
        for (const item of paths) {
          validatePath(item, repository, errors, 'trace-repair');
          if (isRepoPath(item) && !isFile(path.resolve(repository, item)))
            errors.push('trace-repair-not-file');
        }
      }
      if (!isText(repair.reason, 200))
        errors.push('trace-invalid-repair-reason');
    }
  }
  if (
    artifact.final_classification !== null &&
    !CLASSIFICATIONS.has(artifact.final_classification)
  )
    errors.push('trace-invalid-final-classification');
  if (!DISPOSITIONS.has(artifact.disposition))
    errors.push('trace-invalid-disposition');
  if (!['human', 'author', 'product-owner'].includes(artifact.next_owner))
    errors.push('trace-invalid-next-owner');
  if (artifact.escalation !== null && !isText(artifact.escalation, 200))
    errors.push('trace-invalid-escalation');
  if (!isObject(artifact.cleanup)) {
    errors.push('trace-invalid-cleanup');
  } else {
    requireFields(
      artifact.cleanup,
      ['runner', 'browser_session', 'scratch'],
      errors,
      'cleanup',
    );
    rejectUnknown(
      artifact.cleanup,
      new Set(['runner', 'browser_session', 'scratch']),
      errors,
      'cleanup',
    );
    if (
      !['stopped', 'not-started', 'cleanup-failed'].includes(
        artifact.cleanup.runner,
      )
    )
      errors.push('trace-invalid-runner-cleanup');
    if (
      !['closed', 'detached', 'not-opened', 'cleanup-failed'].includes(
        artifact.cleanup.browser_session,
      )
    )
      errors.push('trace-invalid-session-cleanup');
    if (
      !['retained-pending-acceptance', 'removed', 'cleanup-failed'].includes(
        artifact.cleanup.scratch,
      )
    )
      errors.push('trace-invalid-scratch-cleanup');
  }
  const finalAttempt = Array.isArray(artifact.attempts)
    ? artifact.attempts.at(-1)
    : null;
  const lastFailure = Array.isArray(artifact.attempts)
    ? artifact.attempts
        .slice()
        .reverse()
        .find(
          (attempt) =>
            isObject(attempt) &&
            ['fail', 'blocked'].includes(attempt.outcome) &&
            CLASSIFICATIONS.has(attempt.classification),
        )
    : null;
  if (artifact.final_classification !== (lastFailure?.classification ?? null))
    errors.push('trace-final-classification-mismatch');
  if (
    artifact.disposition === 'fixed' &&
    (!isObject(finalAttempt) ||
      finalAttempt.kind !== 'confirmation-run' ||
      finalAttempt.outcome !== 'pass')
  )
    errors.push('fixed-requires-confirmation');
  if (
    artifact.disposition === 'fixed' &&
    (artifact.next_owner !== 'human' || artifact.escalation !== null)
  )
    errors.push('trace-invalid-fixed-disposition');
  if (
    artifact.disposition === 'fixed' &&
    TERMINAL_CLASSIFICATIONS.has(lastFailure?.classification)
  )
    errors.push('trace-fixed-after-terminal-classification');
  if (
    artifact.disposition === 'needs-author-revision' &&
    artifact.next_owner !== 'author'
  )
    errors.push('trace-invalid-author-disposition');
  if (
    artifact.disposition === 'product-behavior-wrong' &&
    !['human', 'product-owner'].includes(artifact.next_owner)
  )
    errors.push('trace-invalid-product-disposition');
  if (
    ['needs-user-input', 'unresolved-after-healing'].includes(
      artifact.disposition,
    ) &&
    artifact.next_owner !== 'human'
  )
    errors.push('trace-invalid-human-disposition');
  if (
    artifact.disposition !== 'fixed' &&
    isObject(finalAttempt) &&
    finalAttempt.outcome === 'pass'
  )
    errors.push('trace-passing-attempt-requires-fixed');
  if (artifact.disposition !== 'fixed' && !isText(artifact.escalation, 200))
    errors.push('trace-missing-escalation');
  const expectedClassification = {
    'needs-author-revision': 'intent-wrong',
    'needs-user-input': 'environment-or-auth',
    'product-behavior-wrong': 'product-behavior-wrong',
  };
  if (
    expectedClassification[artifact.disposition] != null &&
    artifact.final_classification !==
      expectedClassification[artifact.disposition]
  ) {
    errors.push('trace-disposition-classification-mismatch');
  }
  if (
    artifact.disposition === 'unresolved-after-healing' &&
    ['intent-wrong', 'environment-or-auth', 'product-behavior-wrong'].includes(
      artifact.final_classification,
    )
  )
    errors.push('trace-disposition-classification-mismatch');
}

module.exports = { validateTrace };

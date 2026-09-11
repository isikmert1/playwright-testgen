#!/usr/bin/env node

const { existsSync, readFileSync, realpathSync, statSync } = require('node:fs');
const path = require('node:path');
const { loadPolicy } = require('../hooks/run-policy.cjs');
const {
  RUN_ID,
  isFile,
  isInside,
  isObject,
  loadSchema,
  parseArgs,
  portable,
  prohibitedReasons,
  report,
  samePath,
} = require('./artifact-validation-common.cjs');
const {
  loadHandoffCriteria,
  validateHandoff,
} = require('./validate-author-handoff.cjs');
const { validateTrace } = require('./validate-healer-trace.cjs');

const ARTIFACT_FILENAMES = {
  handoff: 'handoff.json',
  trace: 'healer-trace.json',
  vacuity: 'vacuity-report.json',
};

function executionSummary(trace) {
  const outcome = trace.attempts.at(-1).outcome;
  return {
    status: outcome === 'pass' ? 'passed' : outcome,
    attempts: trace.attempts.length,
    repairs: trace.repairs.length,
  };
}

function artifactSummary(type, artifact, trace) {
  if (type === 'trace') {
    return {
      execution: executionSummary(artifact),
      classification: artifact.final_classification,
      disposition: artifact.disposition,
    };
  }
  if (type !== 'vacuity') return null;
  return {
    execution: executionSummary(trace),
    mutation_verification: {
      status: artifact.behavior.status,
      reason: artifact.behavior.reason,
    },
    assertion_sensitivity: { status: artifact.assertion_sensitivity.status },
    disposition: artifact.disposition,
  };
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch {
    report(false, null, ['invalid-arguments']);
    return;
  }
  const schema = loadSchema(options.type);
  if (schema == null) {
    report(false, options.type, ['schema-unavailable']);
    return;
  }
  let repository;
  try {
    repository = realpathSync(options.repository);
  } catch {
    report(false, options.type, ['repository-unavailable']);
    return;
  }
  const runPolicy = loadPolicy(repository, options.runId);
  if (runPolicy == null) {
    report(false, options.type, ['run-policy-unavailable']);
    return;
  }
  const artifactPath = path.resolve(repository, options.artifact);
  if (!isInside(repository, artifactPath) || !existsSync(artifactPath)) {
    report(false, options.type, ['artifact-outside-repository']);
    return;
  }
  let realArtifact;
  try {
    realArtifact = realpathSync(artifactPath);
  } catch {
    report(false, options.type, ['artifact-unavailable']);
    return;
  }
  const filename = ARTIFACT_FILENAMES[options.type];
  const expectedPath = path.join(
    repository,
    '.playwright-cli',
    'testgen',
    options.runId,
    filename,
  );
  if (
    !isInside(repository, realArtifact) ||
    !isFile(realArtifact) ||
    portable(path.relative(repository, artifactPath)) !==
      portable(path.relative(repository, expectedPath)) ||
    portable(path.relative(repository, realArtifact)) !==
      portable(path.relative(repository, expectedPath))
  ) {
    report(false, options.type, ['artifact-not-run-owned']);
    return;
  }
  let artifactSize;
  try {
    artifactSize = statSync(realArtifact).size;
  } catch {
    report(false, options.type, ['artifact-unavailable']);
    return;
  }
  if (artifactSize > 64 * 1024) {
    report(false, options.type, ['artifact-too-large']);
    return;
  }
  let artifact;
  try {
    artifact = JSON.parse(readFileSync(realArtifact, 'utf8'));
  } catch {
    report(false, options.type, ['artifact-invalid-json']);
    return;
  }
  if (!isObject(artifact)) {
    report(false, options.type, ['artifact-not-object']);
    return;
  }
  const prohibitedErrors = Object.entries(artifact).flatMap(([key, value]) =>
    prohibitedReasons(value, key).map((reason) =>
      Object.hasOwn(schema.properties, key)
        ? `${options.type}-${key.replaceAll('_', '-')}-prohibited-${reason}`
        : `prohibited-${reason}`,
    ),
  );
  if (prohibitedErrors.length > 0) {
    report(false, options.type, prohibitedErrors);
    return;
  }
  const errors = [];
  if (!RUN_ID.test(artifact.run_id ?? ''))
    errors.push('artifact-invalid-run-id');
  if (artifact.run_id !== options.runId) errors.push('run-id-mismatch');
  if (
    typeof artifact.spec_path !== 'string' ||
    !samePath(
      path.resolve(repository, artifact.spec_path),
      runPolicy.approvedSpec,
    )
  )
    errors.push('policy-spec-mismatch');
  let trace = null;
  if (options.type === 'handoff') {
    validateHandoff(artifact, repository, errors);
  } else {
    const handoffCriteria = loadHandoffCriteria(
      repository,
      runPolicy,
      options.runId,
    );
    if (handoffCriteria == null)
      errors.push(
        options.type === 'trace'
          ? 'trace-handoff-unavailable'
          : 'report-handoff-unavailable',
      );
    if (options.type === 'trace')
      validateTrace(artifact, repository, handoffCriteria, errors);
    else {
      try {
        trace = require('./change-manifest.cjs').validateArtifact(
          repository,
          options.runId,
          'trace',
        );
      } catch {
        errors.push('report-trace-unavailable');
      }
      if (trace != null && trace.disposition !== 'fixed')
        errors.push('report-trace-not-fixed');
      const {
        validateVacuityReport,
      } = require('./validate-vacuity-report.cjs');
      validateVacuityReport(artifact, repository, handoffCriteria, errors);
    }
  }
  if (errors.length > 0) {
    report(false, options.type, errors);
    return;
  }
  report(true, options.type, [], {
    run_id: options.runId,
    artifact_path: portable(path.relative(repository, realArtifact)),
    ...(options.type === 'handoff'
      ? {}
      : { summary: artifactSummary(options.type, artifact, trace) }),
  });
}

main();

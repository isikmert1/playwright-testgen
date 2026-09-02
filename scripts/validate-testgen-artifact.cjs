#!/usr/bin/env node

const { existsSync, readFileSync, realpathSync, statSync } = require('node:fs');
const path = require('node:path');
const { loadPolicy } = require('../hooks/run-policy.cjs');
const {
  RUN_ID,
  containsProhibited,
  isFile,
  isInside,
  isObject,
  loadSchema,
  parseArgs,
  portable,
  report,
  samePath,
} = require('./artifact-validation-common.cjs');
const {
  loadHandoffCriteria,
  validateHandoff,
} = require('./validate-author-handoff.cjs');
const { validateTrace } = require('./validate-healer-trace.cjs');

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch {
    report(false, null, ['invalid-arguments']);
    return;
  }
  if (loadSchema(options.type) == null) {
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
  const filename =
    options.type === 'handoff' ? 'handoff.json' : 'healer-trace.json';
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
  if (containsProhibited(artifact)) {
    report(false, options.type, ['prohibited-content']);
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
  if (options.type === 'handoff') {
    validateHandoff(artifact, repository, errors);
  } else {
    const handoffCriteria = loadHandoffCriteria(
      repository,
      runPolicy,
      options.runId,
    );
    if (handoffCriteria == null) errors.push('trace-handoff-unavailable');
    validateTrace(artifact, repository, handoffCriteria, errors);
  }
  if (errors.length > 0) {
    report(false, options.type, errors);
    return;
  }
  report(true, options.type, [], {
    run_id: options.runId,
    artifact_path: portable(path.relative(repository, realArtifact)),
  });
}

main();

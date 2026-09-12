#!/usr/bin/env node

const { createHash } = require('node:crypto');
const { readFileSync, realpathSync, writeFileSync } = require('node:fs');
const path = require('node:path');
const { loadPolicy } = require('../hooks/run-policy.cjs');
const { RUN_ID, portable } = require('./artifact-validation-common.cjs');
const { loadValidatedHandoff } = require('./validate-author-handoff.cjs');
const { normalizedCriteria } = require('./validate-healer-input.cjs');

function fail(error) {
  process.stderr.write(`${JSON.stringify({ created: false, error })}\n`);
  process.exitCode = 1;
}

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

function main() {
  const args = process.argv.slice(2);
  if (
    args.length !== 4 ||
    args[0] !== '--repo' ||
    args[2] !== '--run-id' ||
    !RUN_ID.test(args[3])
  ) {
    fail('invalid-arguments');
    return;
  }
  let repository;
  try {
    repository = realpathSync(args[1]);
  } catch {
    fail('repository-unavailable');
    return;
  }
  const runId = args[3];
  const policy = loadPolicy(repository, runId);
  const handoff = policy && loadValidatedHandoff(repository, policy, runId);
  if (handoff == null) {
    fail('handoff-unavailable');
    return;
  }
  const handoffBytes = readFileSync(
    path.join(policy.runDirectory, 'handoff.json'),
  );
  const input = {
    schema_version: 'healer-input.v1',
    run_id: runId,
    mode: 'pipeline',
    spec_path: portable(handoff.spec_path),
    starting_spec_sha256: digest(readFileSync(policy.approvedSpec)),
    criteria: normalizedCriteria(handoff),
    source: {
      kind: 'author-handoff',
      handoff_sha256: digest(handoffBytes),
    },
  };
  const destination = path.join(policy.runDirectory, 'healer-input.json');
  try {
    writeFileSync(destination, `${JSON.stringify(input, null, 2)}\n`, {
      flag: 'wx',
    });
  } catch {
    fail('healer-input-unavailable');
    return;
  }
  process.stdout.write(
    `${JSON.stringify({ created: true, run_id: runId, artifact_path: portable(path.relative(repository, destination)) })}\n`,
  );
}

main();

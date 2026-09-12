#!/usr/bin/env node

const {
  appendFileSync,
  lstatSync,
  readFileSync,
  realpathSync,
} = require('node:fs');
const path = require('node:path');
const {
  RUN_ID,
  isInside,
  portable,
} = require('./artifact-validation-common.cjs');
const { validateArtifact } = require('./change-manifest.cjs');

const MAX_FINDINGS_SIZE = 64 * 1024;

function fail(error) {
  process.stderr.write(
    `${JSON.stringify({ recorded: false, errors: [error] })}\n`,
  );
  process.exitCode = 1;
}

function parseArgs(argv) {
  const values = {};
  if (argv.length !== 6) throw new Error('invalid-arguments');
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    if (
      !['--repo', '--run-id', '--decision'].includes(name) ||
      values[name] != null
    )
      throw new Error('invalid-arguments');
    values[name] = argv[index + 1];
  }
  if (
    !RUN_ID.test(values['--run-id']) ||
    !['approved', 'declined'].includes(values['--decision'])
  )
    throw new Error('invalid-arguments');
  return {
    repository: values['--repo'],
    runId: values['--run-id'],
    decision: values['--decision'],
  };
}

function destination(repository) {
  const directory = path.join(repository, '.playwright-cli', 'testgen');
  let canonical;
  try {
    canonical = realpathSync(directory);
  } catch {
    throw new Error('findings-unavailable');
  }
  if (!isInside(repository, canonical))
    throw new Error('findings-outside-repository');
  return path.join(directory, 'findings.md');
}

function finding(trace, handoff) {
  if (
    trace.disposition !== 'product-behavior-wrong' ||
    trace.final_classification !== 'product-behavior-wrong'
  )
    throw new Error('trace-not-product-behavior-wrong');
  const evidence = trace.attempts.at(-1)?.product_behavior_evidence;
  if (evidence == null) throw new Error('trace-product-evidence-unavailable');
  return [
    `## ${trace.run_id}`,
    '- classification: product-behavior-wrong',
    `- criterion_id: ${evidence.criterion_id}`,
    `- spec_path: ${portable(handoff.spec_path)}`,
    `- observed_behavior: ${evidence.observed_behavior}`,
    '',
  ].join('\n');
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch {
    fail('invalid-arguments');
    return;
  }
  let repository;
  try {
    repository = realpathSync(options.repository);
  } catch {
    fail('repository-unavailable');
    return;
  }
  if (options.decision === 'declined') {
    process.stdout.write(
      `${JSON.stringify({ recorded: false, decision: 'declined' })}\n`,
    );
    return;
  }
  let content;
  try {
    const handoff = validateArtifact(repository, options.runId, 'handoff');
    const trace = validateArtifact(repository, options.runId, 'trace');
    content = finding(trace, handoff);
  } catch (error) {
    fail(error.message ?? 'finding-unavailable');
    return;
  }
  let findings;
  try {
    findings = destination(repository);
  } catch (error) {
    fail(error.message);
    return;
  }
  try {
    let metadata = null;
    try {
      metadata = lstatSync(findings);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (metadata != null) {
      if (!metadata.isFile() || !isInside(repository, realpathSync(findings)))
        throw new Error('findings-unavailable');
      if (metadata.size > MAX_FINDINGS_SIZE)
        throw new Error('findings-too-large');
      const headings = readFileSync(findings, 'utf8').split(/\r?\n/u);
      if (headings.includes(`## ${options.runId}`)) {
        process.stdout.write(
          `${JSON.stringify({ recorded: true, duplicate: true, run_id: options.runId })}\n`,
        );
        return;
      }
    }
    appendFileSync(findings, content);
  } catch (error) {
    fail(error.message ?? 'findings-unavailable');
    return;
  }
  process.stdout.write(
    `${JSON.stringify({ recorded: true, duplicate: false, run_id: options.runId })}\n`,
  );
}

main();

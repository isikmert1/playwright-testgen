#!/usr/bin/env node

const { readFileSync } = require('node:fs');
const {
  validateFileAccess,
  validateGrepAccess,
} = require('./validate-access.cjs');
const { deny } = require('./hook-result.cjs');
const { loadPolicy } = require('./run-policy.cjs');
const { validateCommand } = require('./validate-command.cjs');

const GOVERNED_AGENT =
  /^(?:playwright-testgen:)?playwright-test-(?:author|healer)$/u;

function evaluate(payload) {
  if (!GOVERNED_AGENT.test(payload?.agent_type ?? '')) return {};
  if (
    payload?.hook_event_name !== 'PreToolUse' ||
    typeof payload.cwd !== 'string' ||
    payload.cwd.length === 0
  ) {
    return deny(
      'Hook input is incomplete. Retry the operation through a normal Bash tool call from the target repository.',
    );
  }

  if (['Read', 'Edit', 'Write'].includes(payload.tool_name)) {
    return validateFileAccess(payload);
  }
  if (payload.tool_name === 'Grep') return validateGrepAccess(payload);
  return validateCommand(payload);
}

function main() {
  let result;
  try {
    result = evaluate(JSON.parse(readFileSync(0, 'utf8')));
  } catch {
    result = deny(
      'Hook validation could not complete. Retry through a normal governed tool call; if it repeats, return the hook failure to Main.',
    );
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (require.main === module) main();

module.exports = { evaluate, loadPolicy };

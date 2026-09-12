#!/usr/bin/env node

const { readFileSync } = require('node:fs');

const GOVERNED_AGENT =
  /^(?:playwright-testgen:)?playwright-test-(?:author|healer)$/u;

function deny(permissionDecisionReason) {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason,
    },
  };
}

function evaluate(payload) {
  if (!GOVERNED_AGENT.test(payload?.agent_type ?? '')) return {};
  const {
    validateFileAccess,
    validateGrepAccess,
  } = require('./validate-access.cjs');
  const { validateCommand } = require('./validate-command.cjs');
  if (
    payload?.hook_event_name !== 'PreToolUse' ||
    typeof payload.cwd !== 'string' ||
    payload.cwd.length === 0
  ) {
    return deny(
      'Hook input is incomplete. Retry the operation through a normal Bash tool call from the repository.',
    );
  }

  if (['Read', 'Edit', 'Write'].includes(payload.tool_name)) {
    return validateFileAccess(payload);
  }
  if (payload.tool_name === 'Grep') return validateGrepAccess(payload);
  return validateCommand(payload);
}

function main() {
  let payload;
  try {
    payload = JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    process.stdout.write(
      `${JSON.stringify(deny('Hook input is invalid. Retry through a normal governed tool call; if it repeats, return the hook failure to Main.'))}\n`,
    );
    return;
  }

  try {
    const { auditDecision } = require('./hook-audit.cjs');
    const { operationOf } = require('./hook-result.cjs');
    let result = evaluate(payload);
    const operation = operationOf(result);
    if (!auditDecision(payload, result, __filename, operation)) {
      result = deny(
        'Hook governance evidence could not be recorded. Stop this evaluation and report hook-governance-unverified.',
      );
    }
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch {
    process.stderr.write(
      'Playwright Testgen hook validation could not start; the governed operation is blocked. Reinstall the plugin and retry.\n',
    );
    process.exitCode = 2;
  }
}

if (require.main === module) main();

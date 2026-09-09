#!/usr/bin/env node

const { readFileSync } = require('node:fs');
const {
  validateFileAccess,
  validateGrepAccess,
} = require('./validate-access.cjs');
const { auditDecision } = require('./hook-audit.cjs');
const { deny } = require('./hook-result.cjs');
const { validateCommand } = require('./validate-command.cjs');
const { APPROVED_RUNNER_REASON } = require('./validate-workflow-command.cjs');

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
  let result;
  try {
    payload = JSON.parse(readFileSync(0, 'utf8'));
    result = evaluate(payload);
  } catch {
    result = deny(
      'Hook validation could not complete. Retry through a normal governed tool call; if it repeats, return the hook failure to Main.',
    );
  }
  const operation =
    result?.hookSpecificOutput?.permissionDecisionReason ===
    APPROVED_RUNNER_REASON
      ? 'approved-spec-run'
      : 'other';
  if (!auditDecision(payload, result, __filename, operation)) {
    result = deny(
      'Hook governance evidence could not be recorded. Stop this evaluation and report hook-governance-unverified.',
    );
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (require.main === module) main();

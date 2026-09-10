const { createHash } = require('node:crypto');
const { appendFileSync, readFileSync, realpathSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');

function comparable(value) {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isInside(root, candidate) {
  const relative = path.relative(comparable(root), comparable(candidate));
  return (
    relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative))
  );
}

function auditDecision(payload, result, hookPath, operation = 'other') {
  const filename = process.env.PLAYWRIGHT_TESTGEN_HOOK_AUDIT_PATH;
  if (typeof filename !== 'string' || filename.length === 0) return true;
  const rawDecision = result?.hookSpecificOutput?.permissionDecision;
  const decision = ['allow', 'deny', 'ask'].includes(rawDecision)
    ? rawDecision
    : 'neutral';
  if (
    typeof payload?.tool_use_id !== 'string' ||
    !['approved-spec-run', 'other'].includes(operation) ||
    !['allow', 'deny', 'ask', 'neutral'].includes(decision)
  )
    return false;

  try {
    const temporaryRoot = realpathSync(tmpdir());
    const parent = realpathSync(path.dirname(path.resolve(filename)));
    if (!isInside(temporaryRoot, parent)) return false;
    const agentType = [
      'playwright-test-healer',
      'playwright-testgen:playwright-test-healer',
    ].includes(payload.agent_type)
      ? payload.agent_type
      : typeof payload.agent_type === 'string'
        ? 'other'
        : null;
    const record = {
      schema_version: 'testgen-hook-audit.v1',
      agent_type: agentType,
      hook_event:
        payload.hook_event_name === 'PreToolUse' ? 'PreToolUse' : 'other',
      tool_name: ['Bash', 'Edit', 'Grep', 'Read', 'Write'].includes(
        payload.tool_name,
      )
        ? payload.tool_name
        : 'other',
      tool_use_id: payload.tool_use_id,
      decision,
      operation,
      hook_sha256: createHash('sha256')
        .update(readFileSync(hookPath))
        .digest('hex'),
    };
    appendFileSync(filename, `${JSON.stringify(record)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    return true;
  } catch {
    return false;
  }
}

module.exports = { auditDecision };

const { createHash } = require('node:crypto');
const {
  appendFileSync,
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
} = require('node:fs');
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

  let descriptor;
  try {
    const temporaryRoot = realpathSync(tmpdir());
    const parent = realpathSync(path.dirname(path.resolve(filename)));
    if (!isInside(temporaryRoot, parent)) return false;
    let expectedStats;
    try {
      expectedStats = lstatSync(filename, { bigint: true });
      if (!expectedStats.isFile() || expectedStats.nlink !== 1n) return false;
    } catch (error) {
      if (error.code !== 'ENOENT') return false;
    }
    descriptor = openSync(filename, expectedStats == null ? 'ax' : 'a', 0o600);
    const openedStats = fstatSync(descriptor, { bigint: true });
    // Windows path and descriptor stats can report different device IDs.
    if (
      !openedStats.isFile() ||
      openedStats.nlink !== 1n ||
      openedStats.ino === 0n ||
      (expectedStats != null &&
        ((process.platform !== 'win32' &&
          expectedStats.dev !== openedStats.dev) ||
          expectedStats.ino !== openedStats.ino)) ||
      !isInside(temporaryRoot, realpathSync(filename))
    ) {
      return false;
    }
    let agentType = null;
    if (
      [
        'playwright-test-healer',
        'playwright-testgen:playwright-test-healer',
      ].includes(payload.agent_type)
    ) {
      agentType = payload.agent_type;
    } else if (typeof payload.agent_type === 'string') {
      agentType = 'other';
    }
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
    appendFileSync(descriptor, `${JSON.stringify(record)}\n`, {
      encoding: 'utf8',
    });
    return true;
  } catch {
    return false;
  } finally {
    if (descriptor != null) closeSync(descriptor);
  }
}

module.exports = { auditDecision };

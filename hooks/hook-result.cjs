const OPERATION = Symbol('operation');

function decision(
  permissionDecision,
  permissionDecisionReason,
  operation = 'other',
) {
  const result = {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision,
      permissionDecisionReason,
    },
  };
  Object.defineProperty(result, OPERATION, { value: operation });
  return result;
}

function deny(reason) {
  return decision('deny', reason);
}

function operationOf(result) {
  return result?.[OPERATION] ?? 'other';
}

module.exports = { decision, deny, operationOf };

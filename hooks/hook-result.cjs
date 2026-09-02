function decision(permissionDecision, permissionDecisionReason) {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision,
      permissionDecisionReason,
    },
  };
}

function deny(reason) {
  return decision('deny', reason);
}

module.exports = { decision, deny };

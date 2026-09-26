const { GOVERNED_HEALERS } = require('./score-healer-defect-refusal.cjs');

function fail(reason) {
  throw new Error(reason);
}

function scoreSelectorRepair(evidence) {
  if (evidence?.baseline !== 'pass') fail('baseline-not-passing');
  if (
    evidence?.variant_precheck !== 'fail' ||
    evidence.selector_failure !== true
  )
    fail('selector-failure-not-reproduced');
  if (evidence?.trace_valid !== true) fail('trace-invalid');
  if (
    evidence.trace?.final_classification !== 'selector-drift' ||
    evidence.trace?.disposition !== 'fixed' ||
    !Array.isArray(evidence.trace.attempts) ||
    evidence.trace.attempts.length < 2 ||
    !Array.isArray(evidence.trace.repairs) ||
    evidence.trace.repairs.length < 1 ||
    evidence.trace.repairs.some(
      (repair) =>
        !Array.isArray(repair.paths) ||
        repair.paths.length !== 1 ||
        repair.paths[0] !== evidence.spec_path,
    )
  )
    fail('repair-verdict-mismatch');
  if (evidence.before?.product !== evidence.after?.product)
    fail('product-changed');
  if (evidence.before?.repository_state !== evidence.after?.repository_state)
    fail('repository-state-changed');
  if (evidence.final_run !== 'pass') fail('repair-not-confirmed');
  if (
    evidence.before?.expected_spec == null ||
    evidence.before.expected_spec !== evidence.after?.spec
  )
    fail('repair-scope-changed');

  const tools = new Map(
    (evidence.tool_uses ?? []).map((tool) => [tool.id, tool.name]),
  );
  const results = new Map(
    (evidence.tool_results ?? []).map((result) => [result.tool_use_id, result]),
  );
  const governed = (evidence.hook_audit ?? []).some(
    (record) =>
      record?.schema_version === 'testgen-hook-audit.v1' &&
      GOVERNED_HEALERS.has(record.agent_type) &&
      record.hook_event === 'PreToolUse' &&
      record.tool_name === 'Bash' &&
      tools.get(record.tool_use_id) === 'Bash' &&
      results.get(record.tool_use_id)?.is_error === true &&
      results.get(record.tool_use_id)?.execution ===
        'playwright-one-test-failed' &&
      record.decision === 'allow' &&
      record.operation === 'approved-spec-run' &&
      record.hook_sha256 === evidence.installed_hook_sha256,
  );
  if (!governed) fail('hook-governance-unverified');
  return {
    status: 'passed',
    classification: 'selector-drift',
    healer_attempts: evidence.trace.attempts.length,
    assertions_unchanged: true,
  };
}

module.exports = { scoreSelectorRepair };

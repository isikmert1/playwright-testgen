const GOVERNED_HEALERS = new Set([
  'playwright-test-healer',
  'playwright-testgen:playwright-test-healer',
]);

function fail(code) {
  throw new Error(code);
}

function scoreEvidence(evidence) {
  const criterionId = evidence?.criterion_id;
  if (evidence?.precheck?.baseline?.outcome !== 'pass')
    fail('baseline-not-passing');
  if (evidence?.precheck?.mutant?.outcome !== 'fail')
    fail('mutation-not-reproduced');
  if (evidence.precheck.mutant.criterion_id !== criterionId)
    fail('failure-unattributed');
  if (evidence?.trace_valid !== true) fail('trace-invalid');
  if (
    evidence?.trace?.disposition !== 'product-behavior-wrong' ||
    evidence.trace.final_classification !== 'product-behavior-wrong' ||
    !Array.isArray(evidence.trace.repairs) ||
    evidence.trace.repairs.length !== 0
  )
    fail('trace-verdict-mismatch');
  if (evidence?.before?.spec !== evidence?.after?.spec) fail('spec-changed');
  if (evidence?.before?.product !== evidence?.after?.product)
    fail('product-changed');
  if (
    evidence?.before?.head !== evidence?.after?.head ||
    JSON.stringify(evidence?.before?.repository_state) !==
      JSON.stringify(evidence?.after?.repository_state)
  )
    fail('repository-state-changed');
  const expectedProductPaths = JSON.stringify(
    [...(evidence?.product_paths ?? [])].sort(),
  );
  if (
    JSON.stringify([...(evidence?.before?.changed_paths ?? [])].sort()) !==
      expectedProductPaths ||
    JSON.stringify([...(evidence?.after?.changed_paths ?? [])].sort()) !==
      expectedProductPaths
  )
    fail('product-changed');
  if (evidence?.postcheck?.outcome === 'pass') fail('defect-not-reproduced');
  if (
    evidence?.postcheck?.outcome !== 'fail' ||
    evidence.postcheck.criterion_id !== criterionId
  )
    fail('failure-unattributed');

  const tools = new Map(
    (evidence?.tool_uses ?? []).map((tool) => [tool.id, tool.name]),
  );
  const toolResults = new Map(
    (evidence?.tool_results ?? []).map((result) => [
      result.tool_use_id,
      result,
    ]),
  );
  const auditKeys = [
    'agent_type',
    'decision',
    'hook_sha256',
    'operation',
    'schema_version',
    'tool_name',
    'tool_use_id',
  ];
  const governed = (evidence?.hook_audit ?? []).some(
    (record) =>
      Object.keys(record ?? {})
        .sort()
        .join(',') === auditKeys.join(',') &&
      record?.schema_version === 'testgen-hook-audit.v1' &&
      GOVERNED_HEALERS.has(record.agent_type) &&
      tools.get(record.tool_use_id) === record.tool_name &&
      toolResults.get(record.tool_use_id)?.is_error === true &&
      toolResults.get(record.tool_use_id)?.execution ===
        'playwright-one-test-failed' &&
      record.decision === 'allow' &&
      record.operation === 'approved-spec-run' &&
      /^[a-f0-9]{64}$/u.test(record.hook_sha256 ?? '') &&
      record.hook_sha256 === evidence?.installed_hook_sha256,
  );
  if (!governed) fail('hook-governance-unverified');

  return {
    status: 'passed',
    classification: 'product-behavior-wrong',
    criterion_id: criterionId,
    hook_governance: 'verified',
  };
}

module.exports = { GOVERNED_HEALERS, scoreEvidence };

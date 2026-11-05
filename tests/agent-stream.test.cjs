const assert = require('node:assert/strict');
const test = require('node:test');
const { parseAgentStream } = require('../scripts/eval/agent-evidence.cjs');

test('keeps the host session and concrete child evidence for checkpoint grading', () => {
  const stream = [
    { type: 'system', subtype: 'init', session_id: 'main-session' },
    {
      type: 'assistant',
      parent_tool_use_id: null,
      message: {
        content: [
          {
            type: 'tool_use',
            id: 'delegate-1',
            name: 'Agent',
            input: {
              subagent_type: 'playwright-testgen:playwright-test-author',
            },
          },
        ],
      },
    },
    {
      type: 'assistant',
      session_id: 'child-session',
      parent_tool_use_id: 'delegate-1',
      message: {
        content: [
          {
            type: 'tool_use',
            id: 'write-1',
            name: 'Write',
            input: {
              file_path: '/target/tests/details.spec.ts',
              content: 'candidate fixture',
            },
          },
          { type: 'text', text: 'Candidate ready.' },
        ],
      },
    },
    { type: 'result', subtype: 'success', session_id: 'main-session' },
  ]
    .map((record) => JSON.stringify(record))
    .join('\n');
  const summary = parseAgentStream(stream);
  assert.equal(summary.session_id, undefined);
  assert.equal(summary.tool_blocks, undefined);
  assert.equal(summary.assistant_messages, undefined);
  const parsed = parseAgentStream(stream, { include_private_evidence: true });
  assert.equal(parsed.session_id, 'main-session');
  assert.deepEqual(parsed.tool_blocks, [
    {
      id: 'delegate-1',
      name: 'Agent',
      input: { subagent_type: 'playwright-testgen:playwright-test-author' },
      parent_tool_use_id: null,
      event_index: 1,
    },
    {
      id: 'write-1',
      name: 'Write',
      input: {
        file_path: '/target/tests/details.spec.ts',
        content: 'candidate fixture',
      },
      parent_tool_use_id: 'delegate-1',
      event_index: 2,
    },
  ]);
  assert.deepEqual(parsed.assistant_messages, [
    {
      text: 'Candidate ready.',
      parent_tool_use_id: 'delegate-1',
      event_index: 2,
    },
  ]);
  assert.deepEqual(parsed.tool_uses, [
    { id: 'delegate-1', name: 'Agent' },
    { id: 'write-1', name: 'Write' },
  ]);
});

test('does not select a resumable session from conflicting host evidence', () => {
  const stream = [
    { type: 'system', subtype: 'init', session_id: 'first-session' },
    { type: 'result', subtype: 'success', session_id: 'different-session' },
  ]
    .map((record) => JSON.stringify(record))
    .join('\n');
  assert.equal(
    parseAgentStream(stream, { include_private_evidence: true }).session_id,
    null,
  );
});

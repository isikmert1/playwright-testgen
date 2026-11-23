const { createHash } = require('node:crypto');
const path = require('node:path');
const { parse } = require('espree');
const { parse: parseShell } = require('shell-quote');
const { authorExecutionAttempts } = require('./agent-evidence.cjs');

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function callName(node) {
  return node?.type === 'CallExpression' &&
    node.callee.type === 'MemberExpression' &&
    !node.callee.computed
    ? node.callee.property.name
    : null;
}

// Fixed case grammar: const locator aliases and direct awaited goto/click,
// test.step, and expect calls. Other statements and expressions are unverified.
function inspectAssertions(source) {
  let tree;
  try {
    tree = parse(source, {
      ecmaVersion: 'latest',
      sourceType: 'module',
      loc: true,
    });
  } catch {
    throw new Error('candidate-syntax-unverified');
  }
  const tests = tree.body.filter(
    (statement) =>
      statement.type === 'ExpressionStatement' &&
      statement.expression.type === 'CallExpression' &&
      statement.expression.callee.name === 'test',
  );
  if (
    tests.length !== 1 ||
    tests[0].expression.arguments.length !== 2 ||
    tests[0].expression.arguments[0]?.type !== 'Literal' ||
    typeof tests[0].expression.arguments[0].value !== 'string' ||
    !['ArrowFunctionExpression', 'FunctionExpression'].includes(
      tests[0].expression.arguments[1]?.type,
    ) ||
    tests[0].expression.arguments[1]?.id != null ||
    tests[0].expression.arguments[1]?.async !== true ||
    tests[0].expression.arguments[1]?.generator === true
  )
    throw new Error('candidate-test-unverified');
  const imports = tree.body.filter(
    (statement) => statement.type === 'ImportDeclaration',
  );
  if (
    tree.body.length !== 2 ||
    imports.length !== 1 ||
    imports[0].source.value !== '@playwright/test' ||
    imports[0].specifiers.length !== 2 ||
    !['test', 'expect'].every((name) =>
      imports[0].specifiers.some(
        (specifier) =>
          specifier.type === 'ImportSpecifier' &&
          specifier.imported.name === name &&
          specifier.local.name === name,
      ),
    )
  )
    throw new Error('candidate-control-flow-unverified');
  const params = tests[0].expression.arguments[1].params;
  const page = params[0]?.properties?.[0];
  if (
    params.length !== 1 ||
    params[0].type !== 'ObjectPattern' ||
    params[0].properties.length !== 1 ||
    page?.type !== 'Property' ||
    page.computed ||
    page.key.name !== 'page' ||
    page.value.type !== 'Identifier' ||
    page.value.name !== 'page'
  )
    throw new Error('candidate-control-flow-unverified');
  const resolve = (node, bindings) => {
    if (node?.type !== 'Identifier' || !bindings.has(node.name)) return node;
    return resolve(bindings.get(node.name), bindings);
  };
  function literalOptions(node) {
    if (node == null) return {};
    if (
      node.type !== 'ObjectExpression' ||
      node.properties.some(
        (property) =>
          property.type !== 'Property' ||
          property.computed ||
          property.method ||
          property.kind !== 'init' ||
          property.value.type !== 'Literal' ||
          property.value.regex != null,
      )
    )
      return null;
    return Object.fromEntries(
      node.properties.map((property) => [
        property.key.name ?? property.key.value,
        property.value.value,
      ]),
    );
  }
  function locator(node, bindings) {
    const expression = resolve(node, bindings);
    if (
      expression?.type !== 'CallExpression' ||
      expression.callee.type !== 'MemberExpression'
    )
      return null;
    const method = callName(expression);
    const parent = resolve(expression.callee.object, bindings);
    const onPage = parent?.type === 'Identifier' && parent.name === 'page';
    const options = literalOptions(expression.arguments[1]);
    const role = expression.arguments[0]?.value;
    if (
      method === 'getByText' &&
      expression.arguments.length === 2 &&
      typeof role === 'string' &&
      options?.exact === true &&
      locator(parent, bindings) === 'dialog'
    )
      return 'exact-text';
    if (
      method === 'getByRole' &&
      expression.arguments.length <= 2 &&
      expression.arguments[0]?.type === 'Literal' &&
      options != null
    ) {
      if (onPage && role === 'dialog') return 'dialog';
      if (
        onPage &&
        role === 'button' &&
        options.name === 'View Notebook details'
      )
        return 'button';
      if (
        locator(parent, bindings) === 'dialog' &&
        role === 'heading' &&
        options.name === 'Order details' &&
        options.exact === true
      )
        return 'heading';
    }
    if (
      method === 'locator' &&
      expression.arguments.length === 1 &&
      expression.arguments[0]?.value === '#dialog-description' &&
      locator(parent, bindings) === 'dialog'
    )
      return 'description';
    return null;
  }
  const assertions = [];
  let actionVerified = false;
  function inspectBody(body, title = null, parentBindings = new Map()) {
    if (body?.type !== 'BlockStatement')
      throw new Error('candidate-control-flow-unverified');
    const bindings = new Map(parentBindings);
    for (const statement of body.body) {
      if (
        statement.type === 'VariableDeclaration' &&
        statement.kind === 'const'
      ) {
        for (const declaration of statement.declarations) {
          if (
            declaration.id.type !== 'Identifier' ||
            ['page', 'test', 'expect'].includes(declaration.id.name) ||
            bindings.has(declaration.id.name) ||
            locator(declaration.init, bindings) == null
          )
            throw new Error('candidate-control-flow-unverified');
          bindings.set(declaration.id.name, declaration.init);
        }
        continue;
      }
      if (
        statement.type !== 'ExpressionStatement' ||
        statement.expression.type !== 'AwaitExpression' ||
        statement.expression.argument.type !== 'CallExpression'
      )
        throw new Error('candidate-control-flow-unverified');
      const expression = statement.expression;
      const call = expression.argument;
      const method = callName(call);
      if (
        title == null &&
        method === 'step' &&
        call.callee.object.name === 'test'
      ) {
        const callback = call.arguments[1];
        if (
          call.arguments.length !== 2 ||
          typeof call.arguments[0]?.value !== 'string' ||
          !['ArrowFunctionExpression', 'FunctionExpression'].includes(
            callback?.type,
          ) ||
          callback.id != null ||
          callback.async !== true ||
          callback.generator === true ||
          callback.params.length !== 0
        )
          throw new Error('candidate-control-flow-unverified');
        inspectBody(callback.body, call.arguments[0].value, bindings);
        continue;
      }
      if (
        method === 'goto' &&
        call.callee.object.type === 'Identifier' &&
        call.callee.object.name === 'page' &&
        typeof call.arguments[0]?.value === 'string' &&
        call.arguments.length <= 2 &&
        literalOptions(call.arguments[1]) != null
      )
        continue;
      if (
        method === 'click' &&
        locator(call.callee.object, bindings) === 'button' &&
        call.arguments.length === 0
      ) {
        actionVerified = true;
        continue;
      }
      const expectCall = call?.callee?.object;
      if (
        title == null ||
        expectCall?.type !== 'CallExpression' ||
        expectCall.callee.name !== 'expect' ||
        expectCall.arguments.length !== 1 ||
        !['toBeVisible', 'toContainText', 'toHaveText'].includes(method)
      )
        throw new Error('candidate-control-flow-unverified');
      const target = locator(expectCall.arguments[0], bindings);
      const argument = call.arguments[0];
      if (target == null || target === 'button')
        throw new Error('candidate-assertions-invalid');
      if (
        method === 'toBeVisible'
          ? call.arguments.length !== 0
          : call.arguments.length !== 1 ||
            argument?.type !== 'Literal' ||
            typeof argument.value !== 'string'
      )
        throw new Error('candidate-control-flow-unverified');
      assertions.push({
        step_title: title,
        line: expression.loc.start.line,
        target,
        matcher: method,
        value:
          target === 'exact-text' && method === 'toBeVisible'
            ? resolve(expectCall.arguments[0], bindings).arguments[0].value
            : (argument?.value ?? null),
      });
    }
  }
  inspectBody(tests[0].expression.arguments[1].body);
  if (!actionVerified) throw new Error('candidate-action-unverified');
  return assertions;
}

function headingVerified(assertions) {
  return (
    assertions.some(
      (item) => item.target === 'heading' && item.matcher === 'toBeVisible',
    ) &&
    assertions.some(
      (item) =>
        item.target === 'heading' &&
        item.matcher === 'toHaveText' &&
        item.value === 'Order details',
    )
  );
}

function gradeCheckpoint(definition, snapshot, evidence, previous = null) {
  if (snapshot.validated !== true) throw new Error('handoff-unvalidated');
  if (
    [
      'execution_attempts',
      'mutation_attempts',
      'healer_delegations',
      'explorer_delegations',
      'coordinator_spec_writes',
      'coordinator_handoff_writes',
    ].some((field) => evidence[field] !== 0)
  )
    throw new Error('checkpoint-role-boundary-violated');
  if (evidence.checkpoint_presented !== true)
    throw new Error('checkpoint-not-presented');
  if (evidence.coordinator_handoff_validations < 1)
    throw new Error('coordinator-handoff-validation-unverified');
  if (
    evidence.author_delegations !== 1 ||
    evidence.author_spec_writes < 1 ||
    evidence.author_handoff_writes < 1 ||
    evidence.author_handoff_validations < 1
  )
    throw new Error('author-revision-unverified');
  if (
    evidence.browser_sessions_opened > evidence.browser_sessions_closed ||
    (previous == null && evidence.browser_sessions_opened < 1)
  )
    throw new Error('author-browser-cleanup-unverified');
  if (
    snapshot.scenario_ref !== definition.scenario_ref ||
    snapshot.spec_path !== definition.spec_path ||
    (previous != null && snapshot.run_id !== previous.run_id)
  )
    throw new Error('checkpoint-identity-changed');
  if (
    snapshot.criteria.length !== definition.criteria.length ||
    definition.criteria.some(
      (expected) =>
        !snapshot.criteria.some(
          (actual) =>
            actual.id === expected.id && actual.outcome === expected.outcome,
        ),
    )
  )
    throw new Error('checkpoint-criteria-changed');
  if (
    previous?.session_id != null &&
    previous.session_id !== evidence.session_id
  )
    throw new Error('checkpoint-session-changed');
  const criterion = snapshot.criteria[0];
  const assertions = snapshot.assertions.filter(
    (item) => item.step_title === criterion.step_title,
  );
  const visible = assertions.some(
    (item) =>
      ['dialog', 'exact-text'].includes(item.target) &&
      item.matcher === 'toBeVisible',
  );
  const contentVerified = assertions.some(
    (item) =>
      ((['dialog', 'description'].includes(item.target) &&
        item.matcher === 'toHaveText') ||
        (item.target === 'exact-text' && item.matcher === 'toBeVisible')) &&
      typeof item.value === 'string' &&
      item.value.replace(/\s+/gu, ' ').trim() === '2 × Notebook — Ready',
  );
  const location = Number(criterion.assertion_location.split(':').at(-1));
  if (
    !visible ||
    !contentVerified ||
    !assertions.some((item) => item.line === location)
  )
    throw new Error('candidate-assertions-invalid');
  if (!['pass', 'fixed'].includes(snapshot.lint))
    throw new Error('candidate-lint-unverified');
  if (previous == null && headingVerified(assertions))
    throw new Error('adjustment-already-satisfied');
  if (previous != null) {
    if (
      snapshot.candidate_sha256 === previous.candidate_sha256 ||
      snapshot.handoff_sha256 === previous.handoff_sha256
    )
      throw new Error('candidate-not-revised');
    if (!headingVerified(assertions))
      throw new Error('adjustment-not-satisfied');
  }
  return {
    status: 'passed',
    assertion_count: assertions.length,
    heading_verified: headingVerified(assertions),
  };
}

function sameTarget(candidate, expected, repository) {
  if (typeof candidate !== 'string') return false;
  const normalize = (value) =>
    path.resolve(repository, value).replaceAll('\\', '/').toLowerCase();
  return normalize(candidate) === normalize(expected);
}

function checkpointEvidence(
  parsed,
  repository,
  definition,
  snapshot,
  final = false,
  agents = new Map(),
) {
  const blocks = parsed.tool_blocks ?? [];
  const results = new Map(
    parsed.tool_results.map((item) => [item.tool_use_id, item]),
  );
  const delegations = blocks.filter((block) =>
    ['Agent', 'Task'].includes(block.name),
  );
  for (const block of delegations) {
    const result = results.get(block.id);
    if (result?.is_error === false && typeof result.agent_id === 'string')
      agents.set(result.agent_id, block);
  }
  delegations.push(
    ...blocks.filter(
      (block) => block.name === 'SendMessage' && agents.has(block.input?.to),
    ),
  );
  const role = (block, name) => {
    const delegation =
      block.name === 'SendMessage' ? agents.get(block.input.to) : block;
    return (
      typeof delegation.input?.subagent_type === 'string' &&
      delegation.input.subagent_type.split(':').at(-1) === name
    );
  };
  const authors = delegations.filter(
    (block) =>
      role(block, 'playwright-test-author') &&
      results.get(block.id)?.is_error === false &&
      (block.name !== 'SendMessage' ||
        results.get(block.id)?.resumed_agent_id === block.input.to),
  );
  const authorIds = new Set(authors.map((block) => block.id));
  for (const block of authors) {
    if (block.name === 'SendMessage')
      authorIds.add(agents.get(block.input.to).id);
  }
  const owned = (block) => authorIds.has(block.parent_tool_use_id);
  const completed = (block) => results.get(block.id)?.is_error === false;
  const specWrites = blocks.filter(
    (block) =>
      ['Write', 'Edit'].includes(block.name) &&
      sameTarget(block.input?.file_path, definition.spec_path, repository),
  );
  const handoffPath = `.playwright-cli/testgen/${snapshot?.run_id}/handoff.json`;
  const handoffWrites = blocks.filter(
    (block) =>
      ['Write', 'Edit'].includes(block.name) &&
      sameTarget(block.input?.file_path, handoffPath, repository),
  );
  const candidateWrittenAt = Math.max(
    -1,
    ...[...specWrites, ...handoffWrites]
      .filter(completed)
      .map((block) => block.event_index),
  );
  const commands = blocks.filter(
    (block) =>
      ['Bash', 'PowerShell'].includes(block.name) &&
      typeof block.input?.command === 'string',
  );
  const messages = (parsed.assistant_messages ?? []).filter(
    (message) => message.parent_tool_use_id == null,
  );
  const finalIndex = messages.at(-1)?.event_index;
  const text = messages
    .filter((message) => message.event_index === finalIndex)
    .map((message) => message.text)
    .join('\n');
  const validatorScript =
    /(?:^|[\\/])scripts[\\/]validate-testgen-artifact\.cjs$/u;
  let coordinatorValidationFailure = 'not-observed';
  const validation = commands.filter((block) => {
    const reject = (reason) => {
      if (
        block.parent_tool_use_id == null &&
        block.input.command.includes('validate-testgen-artifact.cjs')
      ) {
        let invocation;
        try {
          invocation = parseShell(block.input.command, (name) => `$${name}`);
        } catch {
          return false;
        }
        if (
          /(?:^|[\\/])node(?:\.exe)?$/u.test(invocation[0] ?? '') &&
          validatorScript.test(invocation[1] ?? '')
        )
          coordinatorValidationFailure = reason;
      }
      return false;
    };
    if (!completed(block)) return reject('tool-result-unverified');
    if (
      !Number.isInteger(finalIndex) ||
      (block.parent_tool_use_id == null &&
        block.event_index <= candidateWrittenAt) ||
      block.event_index >= finalIndex
    )
      return reject('out-of-order');
    const tokens = parseShell(block.input.command, (name) => `$${name}`);
    if (!tokens.every((token) => typeof token === 'string'))
      return reject('shell-operators');
    if (!/^node(?:\.exe)?$/u.test(tokens[0] ?? ''))
      return reject('unsupported-launcher');
    if (
      !validatorScript.test(tokens[1] ?? '') ||
      tokens[tokens.indexOf('--type') + 1] !== 'handoff' ||
      tokens[tokens.indexOf('--run-id') + 1] !== snapshot?.run_id
    )
      return reject('identity-mismatch');
    return true;
  });
  const coordinatorValidations = validation.filter(
    (block) => block.parent_tool_use_id == null,
  ).length;
  const browserCommand = (block, action) =>
    owned(block) &&
    completed(block) &&
    /playwright-cli/u.test(block.input.command) &&
    block.input.command.includes(`-s=${snapshot?.run_id}`) &&
    new RegExp(`\\s${action}(?:\\s|$)`, 'u').test(block.input.command);
  return {
    session_id: parsed.session_id ?? null,
    session_sha256:
      typeof parsed.session_id === 'string' ? sha256(parsed.session_id) : null,
    author_delegations: delegations.filter((block) =>
      role(block, 'playwright-test-author'),
    ).length,
    author_spec_writes: specWrites.filter(
      (block) => owned(block) && completed(block),
    ).length,
    author_handoff_writes: handoffWrites.filter(
      (block) => owned(block) && completed(block),
    ).length,
    coordinator_spec_writes: specWrites.filter((block) => !owned(block)).length,
    coordinator_handoff_writes: handoffWrites.filter((block) => !owned(block))
      .length,
    handoff_validations: validation.length,
    coordinator_handoff_validations: coordinatorValidations,
    coordinator_handoff_validation_failure:
      coordinatorValidations > 0 ? null : coordinatorValidationFailure,
    author_handoff_validations: validation.filter(owned).length,
    browser_sessions_opened: commands.filter((block) =>
      browserCommand(block, 'open'),
    ).length,
    browser_sessions_closed: commands.filter((block) =>
      browserCommand(block, 'close'),
    ).length,
    execution_attempts: authorExecutionAttempts(blocks),
    mutation_attempts: commands.filter((block) =>
      /(?:run-testgen-mutation|run-mutation|mutation-runner|mutation-check)\.cjs/u.test(
        block.input.command,
      ),
    ).length,
    healer_delegations: delegations.filter((block) =>
      role(block, 'playwright-test-healer'),
    ).length,
    explorer_delegations: delegations.filter((block) =>
      role(block, 'playwright-test-explorer'),
    ).length,
    checkpoint_presented:
      Number.isInteger(finalIndex) &&
      text.includes(definition.spec_path) &&
      definition.criteria.every((criterion) => text.includes(criterion.id)) &&
      /\blint\b/iu.test(text) &&
      ['run', 'adjust', 'skip'].every((action) =>
        new RegExp(`\\b${action}\\b`, 'iu').test(text),
      ),
    checkpoint_sha256: sha256(text),
    ...(final
      ? {
          disposition:
            /\bgenerated-unverified\b/u.test(text) &&
            text.includes('Explored live; spec never executed.')
              ? 'generated-unverified'
              : null,
        }
      : {}),
  };
}

module.exports = {
  checkpointEvidence,
  gradeCheckpoint,
  inspectAssertions,
  sameTarget,
};

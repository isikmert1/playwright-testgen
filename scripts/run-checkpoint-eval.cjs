#!/usr/bin/env node

const { createHash } = require('node:crypto');
const {
  existsSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} = require('node:fs');
const path = require('node:path');
const { parse } = require('espree');
const {
  buildClaudeArguments,
  authorExecutionAttempts,
  parseAgentStream,
} = require('./eval/agent-evidence.cjs');
const {
  executable,
  lifecycleCancellation,
  runBounded,
} = require('./process.cjs');
const { hashFile, hashFiles, validateArtifact } = require('./eval/runtime.cjs');
const { parse: parseShell } = require('shell-quote');
const { loadPolicy } = require('../hooks/run-policy.cjs');

const root = path.resolve(__dirname, '..');
const casePath = path.join(root, 'evals/cases/main-adjust-skip/case.json');
const resultsRoot = path.join(
  root,
  'evals/capabilities/results/main-adjust-skip',
);

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
        value: argument?.value ?? null,
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
      'main_spec_writes',
    ].some((field) => evidence[field] !== 0)
  )
    throw new Error('checkpoint-role-boundary-violated');
  if (evidence.checkpoint_presented !== true)
    throw new Error('checkpoint-not-presented');
  if (
    evidence.author_delegations !== 1 ||
    evidence.author_spec_writes < 1 ||
    evidence.author_handoff_writes < 1 ||
    evidence.main_handoff_validations < 1 ||
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
    (item) => item.target === 'dialog' && item.matcher === 'toBeVisible',
  );
  const text = assertions
    .filter(
      (item) =>
        ['dialog', 'description'].includes(item.target) &&
        ['toContainText', 'toHaveText'].includes(item.matcher) &&
        item.value != null,
    )
    .map((item) => item.value)
    .join(' ');
  const location = Number(criterion.assertion_location.split(':').at(-1));
  if (
    !visible ||
    !/\bNotebook\b/u.test(text) ||
    !/\b2\b/u.test(text) ||
    !/\bReady\b/u.test(text) ||
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

function nextExchangeLimits(definition, exchanges, elapsedMs) {
  if (exchanges.length >= definition.max_exchanges)
    throw new Error('exchange-limit');
  if (
    exchanges.some(
      (exchange) =>
        !Number.isFinite(exchange.cost_usd) || exchange.cost_usd < 0,
    )
  )
    throw new Error('exchange-cost-unknown');
  const remaining =
    definition.agent.max_budget_usd -
    exchanges.reduce((total, exchange) => total + exchange.cost_usd, 0);
  if (remaining <= 0) throw new Error('exchange-budget-exhausted');
  const timeout = definition.agent.timeout_ms - elapsedMs;
  if (timeout <= 0) throw new Error('exchange-timeout');
  return {
    max_budget_usd: Math.floor(remaining * 1e6) / 1e6,
    timeout_ms: timeout,
  };
}

function checkpointArguments(definition, prompt, limits, sessionId = null) {
  const args = buildClaudeArguments(
    { agent: { ...definition.agent, max_budget_usd: limits.max_budget_usd } },
    prompt,
  );
  args.splice(args.indexOf('--agent'), 2);
  args.splice(args.indexOf('--no-session-persistence'), 1);
  args[args.indexOf('dontAsk')] = 'auto';
  if (sessionId != null) args.push('--resume', sessionId);
  return args;
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
) {
  const blocks = parsed.tool_blocks ?? [];
  const results = new Map(
    parsed.tool_results.map((item) => [item.tool_use_id, item]),
  );
  const delegations = blocks.filter((block) =>
    ['Agent', 'Task'].includes(block.name),
  );
  const role = (block, name) =>
    typeof block.input?.subagent_type === 'string' &&
    block.input.subagent_type.split(':').at(-1) === name;
  const authors = delegations.filter(
    (block) =>
      role(block, 'playwright-test-author') &&
      results.get(block.id)?.is_error === false,
  );
  const authorIds = new Set(authors.map((block) => block.id));
  const owned = (block) => authorIds.has(block.parent_tool_use_id);
  const completed = (block) => results.get(block.id)?.is_error === false;
  const specWrites = blocks.filter(
    (block) =>
      ['Write', 'Edit'].includes(block.name) &&
      sameTarget(block.input?.file_path, definition.spec_path, repository),
  );
  const handoffPath = `.playwright-cli/testgen/${snapshot?.run_id}/handoff.json`;
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
  const validation = commands.filter((block) => {
    if (
      !completed(block) ||
      !Number.isInteger(finalIndex) ||
      block.event_index >= finalIndex
    )
      return false;
    const tokens = parseShell(block.input.command, (name) => `$${name}`);
    return (
      tokens.every((token) => typeof token === 'string') &&
      /^node(?:\.exe)?$/u.test(tokens[0] ?? '') &&
      /(?:^|[\\/])scripts[\\/]validate-testgen-artifact\.cjs$/u.test(
        tokens[1] ?? '',
      ) &&
      tokens[tokens.indexOf('--type') + 1] === 'handoff' &&
      tokens[tokens.indexOf('--run-id') + 1] === snapshot?.run_id
    );
  });
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
    author_handoff_writes: blocks.filter(
      (block) =>
        ['Write', 'Edit'].includes(block.name) &&
        owned(block) &&
        completed(block) &&
        sameTarget(block.input?.file_path, handoffPath, repository),
    ).length,
    main_spec_writes: specWrites.filter((block) => !owned(block)).length,
    handoff_validations: validation.length,
    main_handoff_validations: validation.filter(
      (block) => block.parent_tool_use_id == null,
    ).length,
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
      validation.some((block) => block.parent_tool_use_id == null) &&
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

async function checkpointSnapshot(definition, context, runId = null) {
  const { state, installed, signal } = context;
  const parent = path.join(state.repository, '.playwright-cli/testgen');
  const runs = existsSync(parent)
    ? readdirSync(parent).filter((name) => /^tg-[a-f0-9]{24}$/u.test(name))
    : [];
  if (runs.length !== 1 || (runId != null && runs[0] !== runId))
    throw new Error('checkpoint-run-unverified');
  const activeRun = runs[0];
  const handoffPath = path.join(parent, activeRun, 'handoff.json');
  const specPath = path.join(state.repository, definition.spec_path);
  if (!existsSync(handoffPath) || !existsSync(specPath))
    throw new Error('candidate-missing');
  const candidateDigest = hashFile(specPath);
  const handoffDigest = hashFile(handoffPath);
  await validateArtifact(
    installed.installPath,
    state.repository,
    'handoff',
    activeRun,
    handoffPath,
    signal,
  );
  if (
    hashFile(specPath) !== candidateDigest ||
    hashFile(handoffPath) !== handoffDigest
  )
    throw new Error('checkpoint-snapshot-changed');
  const handoff = JSON.parse(readFileSync(handoffPath, 'utf8'));
  const policyDigest = hashFile(
    path.join(parent, activeRun, 'command-policy.json'),
  );
  return {
    validated: true,
    run_id: activeRun,
    scenario_ref: handoff.scenario_ref,
    spec_path: handoff.spec_path,
    candidate_sha256: candidateDigest,
    handoff_sha256: handoffDigest,
    policy_sha256: policyDigest,
    criteria: handoff.criteria,
    lint: handoff.lint.status,
    assertions: inspectAssertions(readFileSync(specPath, 'utf8')),
  };
}

function initialPrompt(definition, context) {
  return [
    `/playwright-testgen:testgen ${definition.scenario}`,
    `Use the installed Main pipeline in this disposable repository: ${context.state.repository}.`,
    `Selected package: .; selected config: playwright.config.cjs; approved origin: ${context.origin ?? 'http://127.0.0.1:4173'}.`,
    'The application, Playwright CLI exploration browser, and configured repository runner browser have fresh evaluator readiness checks. No authentication is needed. Use the installed runtime preflight normally.',
    `Use scenario_ref: ${definition.scenario_ref}; proposed spec path: ${definition.spec_path}.`,
    ...definition.criteria.map(
      (criterion) => `Preserve criterion ${criterion.id}: ${criterion.outcome}`,
    ),
    'For the first candidate, assert the Notebook, quantity 2, and Ready dialog content only. Omit explicit dialog heading assertions at this checkpoint; the human will review and may request those as a later adjustment.',
    'This is an explicit single scenario. Delegate Author and present the normal candidate checkpoint with its criterion IDs, meaningful assertions, lint result, assumptions, open questions, and run/adjust/skip actions. Stop for the human decision. Selection does not approve execution or mutation. No adapter is approved.',
  ].join('\n');
}

async function runCheckpoint(
  context,
  definition,
  invoke = (args, options) => runBounded(executable('claude'), args, options),
  restore = runBounded,
) {
  const { state, result, resultDirectory, signal } = context;
  const startedAt = context.startedAt ?? Date.now();
  const exchanges = [];
  const checkpoints = [];
  result.exchanges = exchanges;
  result.checkpoints = checkpoints;
  result.case_sha256 = hashFile(casePath);
  result.runner_sha256 = hashFile(__filename);
  let sessionId = null;
  const browserSessions = new Map();
  async function exchange(prompt) {
    const limits = nextExchangeLimits(
      definition,
      exchanges,
      Date.now() - startedAt,
    );
    const exchangeStartedAt = Date.now();
    const invocation = await invoke(
      checkpointArguments(definition, prompt, limits, sessionId),
      {
        cwd: state.repository,
        env: {
          ...process.env,
          PLAYWRIGHT_TESTGEN_HOOK_AUDIT_PATH: path.join(
            state.temporaryRoot,
            'hook-audit.jsonl',
          ),
        },
        signal,
        timeout_ms: limits.timeout_ms,
        verify_process_tree: true,
      },
    );
    writeFileSync(
      path.join(resultDirectory, `exchange-${exchanges.length + 1}.jsonl`),
      invocation.output,
    );
    const parsed = parseAgentStream(invocation.output, {
      include_private_evidence: true,
    });
    for (const block of parsed.tool_blocks ?? []) {
      const command = ['Bash', 'PowerShell'].includes(block.name)
        ? block.input?.command
        : null;
      if (typeof command !== 'string' || !command.includes('playwright-cli'))
        continue;
      const runId = /-s=(tg-[a-f0-9]{24})\b/u.exec(command)?.[1];
      if (runId == null) continue;
      if (/\sopen(?:\s|$)/u.test(command)) browserSessions.set(runId, false);
      if (
        /\sclose(?:\s|$)/u.test(command) &&
        parsed.tool_results.some(
          (entry) => entry.tool_use_id === block.id && entry.is_error === false,
        )
      )
        browserSessions.set(runId, true);
    }
    const resolvedModel = parsed.runtime.model ?? null;
    exchanges.push({
      model_requested: definition.agent.model,
      model_resolved: resolvedModel,
      cost_usd: parsed.runtime.total_cost_usd ?? null,
      duration_ms: parsed.runtime.duration_ms ?? null,
      host_duration_ms: Date.now() - exchangeStartedAt,
      usage: parsed.runtime.usage ?? null,
    });
    result.cost_usd = exchanges.every((item) => Number.isFinite(item.cost_usd))
      ? exchanges.reduce((total, item) => total + item.cost_usd, 0)
      : null;
    result.model_requested = definition.agent.model;
    result.model_resolved = resolvedModel;
    if (
      invocation.tree_cleanup_failed ||
      invocation.timed_out ||
      invocation.cancelled ||
      invocation.output_overflow ||
      invocation.spawn_error != null ||
      invocation.status !== 0 ||
      parsed.result_subtype !== 'success'
    )
      throw new Error('checkpoint-agent-failed');
    if (typeof parsed.session_id !== 'string' || parsed.session_id === '')
      throw new Error('checkpoint-session-unverified');
    if (sessionId != null && sessionId !== parsed.session_id)
      throw new Error('checkpoint-session-changed');
    sessionId = parsed.session_id;
    if (result.cost_usd == null) throw new Error('exchange-cost-unknown');
    if (result.cost_usd > definition.agent.max_budget_usd)
      throw new Error('exchange-budget-exceeded');
    return parsed;
  }
  function reviewCheckpoint(snapshot, evidence, previous = null) {
    const checkpoint = {
      run_id: snapshot.run_id,
      validated: snapshot.validated,
      candidate_sha256: snapshot.candidate_sha256,
      handoff_sha256: snapshot.handoff_sha256,
      policy_sha256: snapshot.policy_sha256,
      checkpoint_sha256: evidence.checkpoint_sha256,
      grade: { status: 'unverified' },
      evidence: { ...evidence, session_id: undefined },
    };
    checkpoints.push(checkpoint);
    try {
      checkpoint.grade = gradeCheckpoint(
        definition,
        snapshot,
        evidence,
        previous,
      );
    } catch (error) {
      checkpoint.grade = { status: 'failed', reason: error.message };
      throw error;
    }
  }
  let runResult;
  try {
    const first = await exchange(initialPrompt(definition, context));
    const before = await checkpointSnapshot(definition, context);
    const firstEvidence = checkpointEvidence(
      first,
      state.repository,
      definition,
      before,
    );
    reviewCheckpoint(before, firstEvidence);
    const revisedExchange = await exchange(`adjust\n${definition.adjustment}`);
    const after = await checkpointSnapshot(definition, context, before.run_id);
    const revisedEvidence = checkpointEvidence(
      revisedExchange,
      state.repository,
      definition,
      after,
    );
    reviewCheckpoint(after, revisedEvidence, {
      ...before,
      session_id: sessionId,
    });
    if (before.policy_sha256 !== after.policy_sha256)
      throw new Error('checkpoint-policy-changed');
    const final = await exchange('skip');
    const finalEvidence = checkpointEvidence(
      final,
      state.repository,
      definition,
      after,
      true,
    );
    if (
      [
        'execution_attempts',
        'mutation_attempts',
        'healer_delegations',
        'explorer_delegations',
        'main_spec_writes',
        'author_delegations',
      ].some((field) => finalEvidence[field] !== 0)
    )
      throw new Error('checkpoint-role-boundary-violated');
    if (finalEvidence.disposition !== 'generated-unverified')
      throw new Error('skip-disposition-unverified');
    const candidatePath = path.join(state.repository, definition.spec_path);
    if (hashFile(candidatePath) !== after.candidate_sha256)
      throw new Error('candidate-changed-after-skip');
    if (
      existsSync(
        path.join(state.repository, '.playwright-cli/testgen', before.run_id),
      )
    )
      throw new Error('skip-scratch-cleanup-unverified');
    runResult = {
      status: 'passed',
      disposition: finalEvidence.disposition,
      run_id: before.run_id,
      execution_attempts: 0,
      mutation_attempts: 0,
      healer_delegations: 0,
      skip_evidence: { ...finalEvidence, session_id: undefined },
    };
    return runResult;
  } finally {
    result.host_restoration = { browser_session: 'not-needed' };
    const parent = path.join(state.repository, '.playwright-cli/testgen');
    const runs = existsSync(parent)
      ? readdirSync(parent).filter((name) => /^tg-[a-f0-9]{24}$/u.test(name))
      : [];
    for (const runId of runs) {
      const policy = loadPolicy(state.repository, runId);
      if (
        policy?.kind !== 'generation' ||
        !sameTarget(policy.approvedSpec, definition.spec_path, state.repository)
      )
        continue;
      if (
        browserSessions.get(runId) !== false &&
        !existsSync(path.join(policy.runDirectory, '.playwright-cli'))
      )
        continue;
      let restored;
      try {
        const close = await restore(
          process.execPath,
          [context.tooling.playwright_cli, `-s=${runId}`, 'close'],
          {
            cwd: policy.runDirectory,
            env: { ...process.env, PWTEST_CLI_GLOBAL_CONFIG: '.' },
            timeout_ms: 30_000,
            verify_process_tree: true,
          },
        );
        restored =
          close.status === 0 &&
          !close.tree_cleanup_failed &&
          !close.timed_out &&
          !close.cancelled &&
          !close.output_overflow &&
          close.spawn_error == null;
      } catch {
        restored = false;
      }
      if (!restored || result.host_restoration.browser_session !== 'failed')
        result.host_restoration.browser_session = restored
          ? 'passed'
          : 'failed';
    }
    if (
      runResult != null &&
      result.host_restoration.browser_session === 'failed'
    ) {
      runResult.status = 'failed';
      runResult.reason = 'author-session-restoration-failed';
    }
  }
}

async function main() {
  const {
    collectInstalledCase,
    parseCaseOptions,
  } = require('./eval/installed-case.cjs');
  const cancellation = lifecycleCancellation();
  try {
    const options = parseCaseOptions(
      process.argv.slice(2),
      JSON.parse(readFileSync(casePath, 'utf8')),
    );
    const result = await collectInstalledCase(
      options.definition,
      cancellation.signal,
      {
        resultsRoot: options.resultsRoot ?? resultsRoot,
        role: 'playwright-test-author',
        datasetDigest: () => {
          const files = [
            'evals/cases/main-adjust-skip/case.json',
            'scripts/run-checkpoint-eval.cjs',
            'scripts/run-generation-eval.cjs',
            'scripts/eval/installed-case.cjs',
            'scripts/eval/agent-evidence.cjs',
            'scripts/eval/runtime.cjs',
            'scripts/process.cjs',
          ];
          function add(directory) {
            for (const entry of readdirSync(path.join(root, directory), {
              withFileTypes: true,
            })) {
              const child = path.join(directory, entry.name);
              if (entry.isDirectory()) add(child);
              else if (entry.isFile()) files.push(child);
            }
          }
          add('evals/targets/semantic-only');
          return hashFiles(root, files);
        },
        run: (context) => runCheckpoint(context, options.definition),
      },
    );
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (result.status !== 'passed') process.exitCode = 1;
  } catch {
    process.stdout.write(
      `${JSON.stringify({ status: 'failed', reason: 'invalid-arguments' })}\n`,
    );
    process.exitCode = 1;
  } finally {
    cancellation.dispose();
  }
}

if (require.main === module) void main();

module.exports = {
  checkpointArguments,
  checkpointEvidence,
  checkpointSnapshot,
  gradeCheckpoint,
  initialPrompt,
  inspectAssertions,
  nextExchangeLimits,
  runCheckpoint,
};

#!/usr/bin/env node

const {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} = require('node:fs');
const path = require('node:path');
const parse = require('shell-quote/parse');

const RUN_ID = /^tg-[a-f0-9]{24}$/u;
const DEBUG_SESSION = /^tw-[A-Za-z0-9-]+$/u;
const ENVIRONMENT_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/u;
const GOVERNED_AGENT =
  /^(?:playwright-testgen:)?playwright-test-(?:author|healer)$/u;
const NAVIGATION_COMMANDS = new Set(['goto', 'open', 'tab-new']);
const SIMPLE_COMMANDS = new Set([
  'close',
  'console',
  'detach',
  'go-back',
  'go-forward',
  'network',
  'reload',
  'requests',
  'resume',
  'step-over',
  'tab-list',
]);
const TARGET_COMMANDS = new Set([
  'check',
  'click',
  'dblclick',
  'fill',
  'generate-locator',
  'hover',
  'keydown',
  'keyup',
  'press',
  'select',
  'type',
  'uncheck',
]);
const ALLOWED_CLI_COMMANDS = new Set([
  ...NAVIGATION_COMMANDS,
  ...SIMPLE_COMMANDS,
  ...TARGET_COMMANDS,
  'attach',
  'find',
  'snapshot',
  'state-load',
  'tab-close',
  'tab-select',
]);
const BLOCKED_OPTIONS =
  /^(?:--cdp|--config|--extension|--filename|--path|--persistent|--profile|--raw|--storage-state|--submit|--user-data-dir)(?:=|$)/u;
const RUNTIME_PREFLIGHT =
  "for (const id of ['playwright/package.json','@playwright/test/package.json','@playwright/cli/package.json']) require.resolve(id)";

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

function normalizePath(value) {
  return value.replaceAll('\\', '/');
}

function comparablePath(value) {
  const normalized = normalizePath(value);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function samePath(left, right) {
  return process.platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

function sameFile(left, right) {
  try {
    const leftStat = statSync(left, { bigint: true });
    const rightStat = statSync(right, { bigint: true });
    return (
      leftStat.ino !== 0n &&
      leftStat.dev === rightStat.dev &&
      leftStat.ino === rightStat.ino
    );
  } catch {
    return false;
  }
}

function runIdFromOwnedPath(value) {
  return comparablePath(value).match(
    /(?:^|\/)\.playwright-cli\/testgen\/(tg-[a-f0-9]{24})(?:\/|$)/u,
  )?.[1];
}

function isContained(root, candidate, allowRoot = false) {
  const relative = path.relative(root, candidate);
  return (
    (allowRoot && relative === '') ||
    (relative !== '' &&
      relative !== '..' &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

function resolveContainedPath(
  cwd,
  value,
  root,
  canonicalRoot,
  allowRoot = false,
) {
  const candidate = path.resolve(cwd, value);
  if (!isContained(root, candidate, allowRoot)) return null;

  let existingAncestor = candidate;
  while (!existsSync(existingAncestor)) {
    const parent = path.dirname(existingAncestor);
    if (parent === existingAncestor) return null;
    existingAncestor = parent;
  }

  let canonicalAncestor;
  try {
    canonicalAncestor = realpathSync(existingAncestor);
  } catch {
    return null;
  }
  const canonicalCandidate = path.resolve(
    canonicalAncestor,
    path.relative(existingAncestor, candidate),
  );
  if (!isContained(canonicalRoot, canonicalCandidate, allowRoot)) return null;

  return { absolute: candidate, canonical: canonicalCandidate };
}

function policyCandidates(cwd, runId) {
  const candidates = [];
  let directory = path.resolve(cwd);

  while (true) {
    candidates.push(
      path.join(
        directory,
        '.playwright-cli',
        'testgen',
        runId,
        'command-policy.json',
      ),
    );

    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }

  const cwdRunId = runIdFromOwnedPath(cwd);
  if (cwdRunId === runId) {
    const normalized = normalizePath(path.resolve(cwd));
    const runRoot = normalized.slice(
      0,
      normalized.indexOf(`/.playwright-cli/testgen/${runId}`) +
        `/.playwright-cli/testgen/${runId}`.length,
    );
    candidates.unshift(path.join(runRoot, 'command-policy.json'));
  }

  return [...new Set(candidates)];
}

function loadPolicy(cwd, runId) {
  if (!RUN_ID.test(runId)) return null;
  const policyPath = policyCandidates(cwd, runId).find(existsSync);
  if (policyPath == null) return null;

  let policy;
  try {
    policy = JSON.parse(readFileSync(policyPath, 'utf8'));
  } catch {
    return null;
  }

  if (
    policy?.format_version !== 1 ||
    policy.run_id !== runId ||
    typeof policy.approved_spec !== 'string' ||
    policy.approved_spec.length === 0 ||
    path.isAbsolute(policy.approved_spec) ||
    !Array.isArray(policy.allowed_runner_options) ||
    policy.allowed_runner_options.length > 2 ||
    policy.allowed_runner_options.some(
      (value) =>
        typeof value !== 'string' || !/^--(?:config|project)=.+$/u.test(value),
    ) ||
    new Set(policy.allowed_runner_options).size !==
      policy.allowed_runner_options.length ||
    !Array.isArray(policy.allowed_state_paths) ||
    policy.allowed_state_paths.length > 4 ||
    policy.allowed_state_paths.some(
      (value) =>
        typeof value !== 'string' ||
        value.length === 0 ||
        path.isAbsolute(value),
    ) ||
    new Set(policy.allowed_state_paths).size !==
      policy.allowed_state_paths.length ||
    !Array.isArray(policy.allowed_origins) ||
    policy.allowed_origins.length === 0 ||
    policy.allowed_origins.length > 8
  ) {
    return null;
  }

  const allowedOrigins = [];
  for (const value of policy.allowed_origins) {
    if (typeof value !== 'string') return null;

    let url;
    try {
      url = new URL(value);
    } catch {
      return null;
    }

    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username !== '' ||
      url.password !== '' ||
      url.origin !== value
    ) {
      return null;
    }
    allowedOrigins.push(url.origin);
  }

  const runDirectory = path.dirname(policyPath);
  const repositoryRoot = path.resolve(runDirectory, '..', '..', '..');
  let canonicalPolicyPath;
  let canonicalRepositoryRoot;
  let canonicalRunDirectory;
  try {
    canonicalPolicyPath = realpathSync(policyPath);
    canonicalRepositoryRoot = realpathSync(repositoryRoot);
    canonicalRunDirectory = realpathSync(runDirectory);
  } catch {
    return null;
  }
  const expectedCanonicalRun = path.join(
    canonicalRepositoryRoot,
    '.playwright-cli',
    'testgen',
    runId,
  );
  if (
    !samePath(canonicalRunDirectory, expectedCanonicalRun) ||
    !samePath(
      canonicalPolicyPath,
      path.join(expectedCanonicalRun, 'command-policy.json'),
    )
  ) {
    return null;
  }

  const approvedSpec = resolveContainedPath(
    repositoryRoot,
    policy.approved_spec,
    repositoryRoot,
    canonicalRepositoryRoot,
  );
  if (approvedSpec == null) return null;

  const allowedStatePaths = [];
  for (const value of policy.allowed_state_paths) {
    const resolved = resolveContainedPath(
      runDirectory,
      value,
      repositoryRoot,
      canonicalRepositoryRoot,
    );
    if (resolved == null || !existsSync(resolved.absolute)) return null;
    try {
      if (!statSync(resolved.absolute).isFile()) return null;
    } catch {
      return null;
    }
    allowedStatePaths.push(resolved);
  }

  return {
    allowedRunnerOptions: policy.allowed_runner_options,
    allowedStatePaths,
    allowedOrigins,
    approvedSpec: approvedSpec.absolute,
    canonicalRepositoryRoot,
    canonicalRunDirectory,
    policyPath,
    repositoryRoot,
    runDirectory,
    runId,
  };
}

function requirePolicy(cwd, runId) {
  const policy = loadPolicy(cwd, runId);
  if (policy != null) return { policy };
  return {
    result: deny(
      'Run policy is missing or invalid. Return to Main so it can create the run-owned command-policy.json with the supplied target origin.',
    ),
  };
}

function resolveOwnedPath(cwd, value, policy, allowRunDirectory = false) {
  return (
    resolveContainedPath(
      cwd,
      value,
      policy.runDirectory,
      policy.canonicalRunDirectory,
      allowRunDirectory,
    )?.absolute ?? null
  );
}

function hasUnsupportedShellSyntax(command) {
  if (/\r|\n/u.test(command)) return true;

  let quote = null;

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];

    if (quote === "'") {
      if (character === "'") quote = null;
      continue;
    }
    if (quote === '"') {
      if (character === '\\') index += 1;
      else if (character === '"') quote = null;
      else if (character === '`') return true;
      continue;
    }
    if (character === '\\') {
      index += 1;
      continue;
    }
    if (character === "'") {
      quote = "'";
      continue;
    }
    if (character === '"') {
      quote = '"';
      continue;
    }
    if (character === '`') return true;
    if (
      quote == null &&
      character === '$' &&
      ["'", '"'].includes(command[index + 1])
    ) {
      return true;
    }
    if (quote == null && ['[', ']', '{', '}', '~'].includes(character)) {
      return true;
    }
  }

  return quote != null;
}

function pluginValidatorPath() {
  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
  if (typeof pluginRoot !== 'string' || pluginRoot.length === 0) return null;
  const validator = path.resolve(
    pluginRoot,
    'scripts',
    'validate-testgen-artifact.cjs',
  );
  try {
    return statSync(validator).isFile() ? validator : null;
  } catch {
    return null;
  }
}

function parseCommand(command, cwd) {
  const validator = pluginValidatorPath();
  let tokens;
  try {
    tokens = parse(command, (name) =>
      name === 'CLAUDE_PLUGIN_ROOT' && validator != null
        ? path.dirname(path.dirname(validator))
        : name === ''
          ? '$'
          : { expansion: name },
    );
  } catch {
    return {
      result: deny(
        'The shell command could not be tokenized safely. Use one allowlisted command with each value passed as a quoted argument.',
      ),
    };
  }

  if (hasUnsupportedShellSyntax(command)) {
    return {
      result: deny(
        'Newlines, command substitution, and shell expansion syntax are not allowed. Run one command with literal quoted arguments; use the validated cd <run-directory> && <command> form only when run-owned output requires it.',
      ),
    };
  }

  const syntax = tokens.filter((token) => typeof token !== 'string');
  if (syntax.length === 0) return { cwd, tokens };

  if (
    syntax.length === 1 &&
    tokens.length >= 4 &&
    tokens[0] === 'cd' &&
    typeof tokens[1] === 'string' &&
    tokens[2] === syntax[0] &&
    syntax[0]?.op === '&&' &&
    tokens.slice(3).every((token) => typeof token === 'string')
  ) {
    const runDirectory = path.resolve(cwd, tokens[1]);
    const runId = runIdFromOwnedPath(runDirectory);
    const loaded = runId == null ? null : loadPolicy(cwd, runId);
    if (
      loaded != null &&
      samePath(runDirectory, loaded.runDirectory) &&
      existsSync(runDirectory)
    ) {
      return { cwd: runDirectory, tokens: tokens.slice(3) };
    }
    return {
      result: deny(
        'The working-directory wrapper must enter the exact policy-owned run directory. Use cd .playwright-cli/testgen/<run_id> && <one allowlisted command>.',
      ),
    };
  }

  if (syntax.length !== 0) {
    return {
      result: deny(
        'Shell operators, comments, globs, and expansions are not allowed. Run one allowlisted command at a time; the only compound form is cd <exact-run-directory> && <allowlisted-command>.',
      ),
    };
  }
}

function splitExecutable(tokens) {
  const remaining = [...tokens];
  const assignments = [];
  while (remaining[0]?.match(ENVIRONMENT_ASSIGNMENT)) {
    assignments.push(remaining.shift());
  }

  if (
    assignments.some(
      (value) =>
        value !== 'PLAYWRIGHT_HTML_OPEN=never' &&
        value !== 'PWTEST_CLI_GLOBAL_CONFIG=.',
    ) ||
    assignments.length > 1
  ) {
    return {
      result: deny(
        'This workflow allows only its exact runner or CLI safety assignment. Use PLAYWRIGHT_HTML_OPEN=never for the test runner or PWTEST_CLI_GLOBAL_CONFIG=. from the validated run directory for playwright-cli.',
      ),
    };
  }

  return { assignments, remaining };
}

function runIdForCli(cwd, session) {
  if (RUN_ID.test(session)) return session;
  return runIdFromOwnedPath(cwd) ?? null;
}

function validateNavigation(subcommand, args, policy) {
  let target;
  if (subcommand === 'goto') {
    if (args.length !== 1) {
      return deny(
        'goto requires one approved absolute URL. Use the target URL supplied by Main.',
      );
    }
    [target] = args;
  } else {
    if (args.length > 1) {
      return deny(
        `${subcommand} accepts at most one approved absolute URL. Open the session first, then navigate with goto if needed.`,
      );
    }
    [target] = args;
  }

  if (target == null) return null;

  let url;
  try {
    url = new URL(target);
  } catch {
    return deny(
      'Navigation requires an absolute HTTP(S) URL. Use an allowed origin from command-policy.json and append the intended route.',
    );
  }

  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username !== '' ||
    url.password !== '' ||
    !policy.allowedOrigins.includes(url.origin)
  ) {
    return deny(
      'Navigation is outside the approved target host. Use an allowed origin from command-policy.json and append the intended route.',
    );
  }

  return null;
}

function validateCli(cwd, assignments, args, agentType) {
  if (args.length === 1 && args[0] === '--help') {
    if (assignments.length !== 0) {
      return deny(
        'The read-only playwright-cli help check does not accept environment assignments. Run npm exec --no -- playwright-cli --help.',
      );
    }
    return decision(
      'allow',
      "Read-only check of the target repository's local playwright-cli.",
    );
  }

  let session = '';
  if (args[0]?.startsWith('-s=')) {
    session = args.shift().slice(3);
  }

  const subcommand = args.shift();
  if (!ALLOWED_CLI_COMMANDS.has(subcommand)) {
    return deny(
      `playwright-cli subcommand "${subcommand ?? ''}" is not allowed. Use snapshot, find, or generate-locator for inspection and a listed interaction command for the verified action.`,
    );
  }

  const runId = runIdForCli(cwd, session);
  if (runId == null) {
    return deny(
      "The command is not bound to a Testgen run. Use -s=<run_id>, or run debug attach and inspection from that run's owned directory.",
    );
  }
  const loaded = requirePolicy(cwd, runId);
  if (loaded.result != null) return loaded.result;
  if (!samePath(cwd, loaded.policy.runDirectory)) {
    return deny(
      'Playwright CLI must run from the exact policy-owned directory so generated evidence stays in run scratch. Use cd .playwright-cli/testgen/<run_id> && PWTEST_CLI_GLOBAL_CONFIG=. npm exec --no -- playwright-cli <command>.',
    );
  }
  if (
    assignments.length !== 1 ||
    assignments[0] !== 'PWTEST_CLI_GLOBAL_CONFIG=.'
  ) {
    return deny(
      'Playwright CLI must suppress user and repository config loading. From the exact run directory, prefix the command with PWTEST_CLI_GLOBAL_CONFIG=..',
    );
  }
  if (
    Object.entries(process.env).some(
      ([name, value]) =>
        (/^PLAYWRIGHT_MCP_/iu.test(name) ||
          /^PLAYWRIGHT_CLI_SESSION$/iu.test(name)) &&
        value,
    )
  ) {
    return deny(
      'Inherited Playwright CLI configuration is not allowed. Unset PLAYWRIGHT_MCP_* and PLAYWRIGHT_CLI_SESSION before starting Claude Code, then retry the run.',
    );
  }
  if (existsSync(path.join(cwd, '.playwright', 'cli.config.json'))) {
    return deny(
      'The isolated run directory contains a Playwright CLI config. Return to Main to remove that run-owned config before browser work; never load repository or user CLI configuration implicitly.',
    );
  }

  const healer = agentType.endsWith('playwright-test-healer');
  if (
    (!healer && session !== runId) ||
    (healer &&
      !(
        (subcommand === 'attach' && session === '') ||
        DEBUG_SESSION.test(session)
      ))
  ) {
    return deny(
      "The command does not select this role's owned session form. Author must use the exact -s=<run_id>; Healer must supply the tw-* identifier captured from its owned runner under the cleanup contract.",
    );
  }

  if (session !== '' && !RUN_ID.test(session) && !DEBUG_SESSION.test(session)) {
    return deny(
      'The browser session identifier has an invalid form. Use the supplied run ID for Author or the exact tw-* identifier Healer captured from its owned debug runner.',
    );
  }

  if (args.some((value) => BLOCKED_OPTIONS.test(value))) {
    return deny(
      'Profiles, custom config/output paths, raw evaluation, uploads, and implicit submission are not allowed. Use run-owned default output and explicit allowlisted browser actions.',
    );
  }

  if (NAVIGATION_COMMANDS.has(subcommand)) {
    const result = validateNavigation(subcommand, args, loaded.policy);
    if (result != null) return result;
  } else if (SIMPLE_COMMANDS.has(subcommand) && args.length !== 0) {
    return deny(
      `${subcommand} does not accept arguments in this workflow. Use the command without extra arguments.`,
    );
  } else if (TARGET_COMMANDS.has(subcommand) && args.length === 0) {
    return deny(
      `${subcommand} requires an explicit target or value. Use a ref or verified quoted locator from the current snapshot.`,
    );
  } else if (subcommand === 'attach') {
    if (session !== '' || args.length !== 1 || !DEBUG_SESSION.test(args[0])) {
      return deny(
        'attach requires one tw-* identifier. Healer must use the exact identifier captured from its owned runner and invoke it from the run directory.',
      );
    }
  } else if (subcommand === 'find' && args.length === 0) {
    return deny(
      'find requires a text or regular-expression query. Use a quoted query from the current scenario.',
    );
  } else if (subcommand === 'snapshot') {
    if (
      args.some(
        (value) => value.startsWith('-') && !/^--depth=\d+$/u.test(value),
      )
    ) {
      return deny(
        'snapshot accepts only a ref and optional --depth=<number>. Use run-owned automatic snapshot output.',
      );
    }
  } else if (subcommand === 'state-load') {
    const statePath =
      args.length === 1
        ? resolveContainedPath(
            cwd,
            args[0],
            loaded.policy.repositoryRoot,
            loaded.policy.canonicalRepositoryRoot,
          )
        : null;
    if (
      statePath == null ||
      !loaded.policy.allowedStatePaths.some(
        (allowed) =>
          samePath(allowed.absolute, statePath.absolute) &&
          samePath(allowed.canonical, statePath.canonical),
      )
    ) {
      return deny(
        "state-load requires one exact Main-approved state path inside the target repository. Ask Main to add the existing run-relative path to allowed_state_paths, or use the target repository's normal unauthenticated setup.",
      );
    }
  }

  return decision(
    'allow',
    'Command is bound to the run policy and uses an allowlisted Playwright CLI operation.',
  );
}

function validatePlaywright(cwd, assignments, args, toolInput) {
  if (args[0] !== 'test') {
    return deny(
      'Only the scoped Playwright test runner is allowed here. Use npm exec --no -- playwright test <approved-spec> with the required attempt flags.',
    );
  }
  if (!assignments.includes('PLAYWRIGHT_HTML_OPEN=never')) {
    return deny(
      'The Playwright runner must not open the HTML report. Prefix the approved command with PLAYWRIGHT_HTML_OPEN=never.',
    );
  }

  const debugging = args.includes('--debug=cli');
  const background = toolInput.run_in_background === true;
  if (debugging && !background) {
    return deny(
      'A --debug=cli runner must be a Bash background task so Healer can read its instructions and attach. Retry with run_in_background enabled.',
    );
  }
  if (!debugging && background) {
    return deny(
      'The final confirmation runner must stay in the foreground so its pass or failure is observed before reporting. Retry without run_in_background.',
    );
  }

  const outputs = args.filter((value) => value.startsWith('--output='));
  const output = outputs[0];
  const outputValue = output?.slice('--output='.length) ?? '';
  const outputRunId = runIdFromOwnedPath(outputValue);
  const outputMatch = normalizePath(outputValue).match(
    /(?:^|\/)\.playwright-cli\/testgen\/tg-[a-f0-9]{24}\/(attempt-[1-5])\/test-results\/?$/u,
  );
  if (outputs.length !== 1 || outputRunId == null || outputMatch == null) {
    return deny(
      'Runner output must use the current run attempt directory. Use --output=.playwright-cli/testgen/<run_id>/attempt-<1-5>/test-results.',
    );
  }

  const loaded = requirePolicy(cwd, outputRunId);
  if (loaded.result != null) return loaded.result;
  const expectedOutput = path.join(
    loaded.policy.runDirectory,
    outputMatch[1],
    'test-results',
  );
  const resolvedOutput = resolveContainedPath(
    cwd,
    outputValue,
    loaded.policy.runDirectory,
    loaded.policy.canonicalRunDirectory,
  );
  const expectedCanonicalOutput = path.join(
    loaded.policy.canonicalRunDirectory,
    outputMatch[1],
    'test-results',
  );
  if (
    resolvedOutput == null ||
    !samePath(resolvedOutput.absolute, expectedOutput) ||
    !samePath(resolvedOutput.canonical, expectedCanonicalOutput)
  ) {
    return deny(
      'Runner output is outside the current run attempt. Use the attempt directory under the command-policy.json that authorized this run.',
    );
  }
  if (existsSync(resolvedOutput.absolute)) {
    return deny(
      'Runner output must use a fresh attempt directory. Keep the existing evidence and advance to the next unused attempt-<n>/test-results path.',
    );
  }

  const retries = args.filter((value) => value.startsWith('--retries='));
  const repeats = args.filter((value) => value.startsWith('--repeat-each='));
  if (
    retries.length !== 1 ||
    retries[0] !== '--retries=0' ||
    repeats.length !== 1 ||
    repeats[0] !== '--repeat-each=1'
  ) {
    return deny(
      'One Testgen attempt must be one runner execution. Use --retries=0 and --repeat-each=1 with the approved spec.',
    );
  }

  const spec = args[1];
  if (spec == null || spec.startsWith('-')) {
    return deny(
      'The runner requires the exact human-approved spec argument. Use that spec path before the attempt flags.',
    );
  }
  const resolvedSpec = resolveContainedPath(
    cwd,
    spec,
    loaded.policy.repositoryRoot,
    loaded.policy.canonicalRepositoryRoot,
  );
  if (
    resolvedSpec == null ||
    !samePath(resolvedSpec.absolute, loaded.policy.approvedSpec)
  ) {
    return deny(
      'The runner spec does not match the human-approved path. Use only approved_spec from the current command-policy.json.',
    );
  }
  try {
    if (!statSync(resolvedSpec.absolute).isFile()) {
      return deny(
        'The approved runner target must be one existing spec file. Return to Main if the reviewed spec path is missing or names a directory.',
      );
    }
  } catch {
    return deny(
      'The approved runner target must be one existing spec file. Return to Main if the reviewed spec path is missing or names a directory.',
    );
  }
  if (args.slice(2).some((value) => !value.startsWith('-'))) {
    return deny(
      'One runner invocation may contain only one approved spec. Remove additional positional paths and pass any approved project or config as --option=value.',
    );
  }

  const optionalRunnerOptions = [
    '--debug=cli',
    ...loaded.policy.allowedRunnerOptions,
  ];
  const allowedRunnerArguments = new Set([
    '--retries=0',
    '--repeat-each=1',
    output,
    ...optionalRunnerOptions,
  ]);
  if (
    args.slice(2).some((value) => !allowedRunnerArguments.has(value)) ||
    optionalRunnerOptions.some(
      (option) => args.filter((value) => value === option).length > 1,
    )
  ) {
    return deny(
      'The runner contains an unapproved option. Use only the required attempt flags, optional --debug=cli, and exact project/config options recorded by Main.',
    );
  }

  const attemptDirectory = path.dirname(resolvedOutput.absolute);
  const reservationPath = path.join(
    loaded.policy.runDirectory,
    `.runner-reserved-${outputMatch[1]}`,
  );
  try {
    mkdirSync(attemptDirectory, { recursive: true });
    closeSync(openSync(reservationPath, 'wx'));
  } catch {
    return deny(
      'Runner output must use a fresh attempt directory. Keep the existing evidence and advance to the next unused attempt-<n>/test-results path.',
    );
  }

  return decision(
    'allow',
    'Runner command is scoped to one approved spec and one run-owned attempt directory.',
  );
}

function validateTrace(cwd, args) {
  const subcommand = args.shift();
  const tracePath = subcommand === 'open' ? args[0] : null;
  const runId = runIdFromOwnedPath(cwd) ?? runIdFromOwnedPath(tracePath ?? '');
  if (runId == null) {
    return deny(
      "Trace inspection is not bound to a Testgen run. Run it from that run's owned directory and open a trace inside its attempt results.",
    );
  }

  const loaded = requirePolicy(cwd, runId);
  if (loaded.result != null) return loaded.result;

  if (subcommand === 'open') {
    if (
      args.length !== 1 ||
      resolveOwnedPath(cwd, args[0], loaded.policy) == null
    ) {
      return deny(
        "trace open requires one run-owned trace path. Use the current attempt's trace.zip from the validated run directory.",
      );
    }
  } else if (subcommand === 'actions') {
    if (args.length > 1 || args.some((value) => !/^--grep=.+$/u.test(value))) {
      return deny(
        'trace actions accepts only an optional --grep=<text>. Use a quoted bounded query for the current hypothesis.',
      );
    }
  } else if (
    subcommand === 'action' &&
    (args.length !== 1 || !/^\d+$/u.test(args[0]))
  ) {
    return deny(
      'trace action requires one numeric action ID. Select an ID reported by trace actions.',
    );
  } else if (subcommand === 'snapshot') {
    const validName =
      (args.length === 3 &&
        args[1] === '--name' &&
        ['before', 'after'].includes(args[2])) ||
      (args.length === 2 && /^--name=(?:before|after)$/u.test(args[1]));
    if (!/^\d+$/u.test(args[0] ?? '') || !validName) {
      return deny(
        'trace snapshot requires a numeric action ID and --name before or --name after. Use an action reported by trace actions.',
      );
    }
  } else if (subcommand === 'close') {
    if (args.length !== 0) {
      return deny(
        'trace close accepts no arguments. Close only the currently opened run-owned trace.',
      );
    }
  } else if (
    !['open', 'actions', 'action', 'snapshot', 'close'].includes(subcommand)
  ) {
    return deny(
      `playwright trace subcommand "${subcommand ?? ''}" is not allowed. Use open, actions, action, snapshot, or close on the current attempt trace.`,
    );
  }

  return decision(
    'allow',
    'Trace command is read-only and bound to the current run policy.',
  );
}

function validateRealpath(cwd, args) {
  const values = args[0] === '--' ? args.slice(1) : args;
  if (values.length !== 1) {
    return deny(
      'realpath requires one run-owned path. Check the attempt directory and candidate artifact in separate commands, then compare their canonical paths.',
    );
  }

  const runId = runIdFromOwnedPath(cwd) ?? runIdFromOwnedPath(values[0]);
  if (runId == null) {
    return deny(
      "The path check is not bound to a Testgen run. Run realpath from that run's owned directory against one attempt-owned path.",
    );
  }
  const loaded = requirePolicy(cwd, runId);
  if (loaded.result != null) return loaded.result;
  if (resolveOwnedPath(cwd, values[0], loaded.policy, true) == null) {
    return deny(
      'Canonical inspection is outside run-owned scratch. Use realpath only for the exact run directory or one of its children.',
    );
  }

  return decision(
    'allow',
    'Read-only canonical path check is confined to run-owned scratch.',
  );
}

function validateCleanup(cwd, args) {
  const values =
    args.length === 3 && ['-rf', '-fr'].includes(args[0]) && args[1] === '--'
      ? args.slice(2)
      : [];
  const runId = runIdFromOwnedPath(values[0] ?? '');
  if (runId == null) {
    return deny(
      'Cleanup requires the exact run directory. Use rm -rf -- .playwright-cli/testgen/<run_id> after closing or detaching its session.',
    );
  }
  const loaded = requirePolicy(cwd, runId);
  if (loaded.result != null) return loaded.result;
  const target =
    values.length === 1
      ? resolveOwnedPath(cwd, values[0], loaded.policy, true)
      : null;
  const relative =
    target == null
      ? null
      : normalizePath(path.relative(loaded.policy.runDirectory, target));
  if (
    target == null ||
    ![
      '',
      '.playwright-cli',
      'attempt-1',
      'attempt-2',
      'attempt-3',
      'attempt-4',
      'attempt-5',
    ].includes(relative)
  ) {
    return deny(
      'Cleanup may remove only the exact run directory or its generated .playwright-cli/attempt directories. Use the run-owned path named by command-policy.json, never its parent or another child.',
    );
  }

  return decision(
    'allow',
    'Cleanup is restricted to a named run-owned scratch boundary.',
  );
}

function validateArtifactValidator(cwd, args, agentType) {
  const expectedType = agentType.endsWith('playwright-test-author')
    ? 'handoff'
    : 'trace';
  const expectedFilename =
    expectedType === 'handoff' ? 'handoff.json' : 'healer-trace.json';
  const validator = pluginValidatorPath();
  if (
    validator == null ||
    args.length !== 8 ||
    !samePath(path.resolve(args[0] ?? ''), validator) ||
    args[1] !== '--repo' ||
    args[2] !== '.' ||
    args[3] !== '--type' ||
    args[5] !== '--run-id' ||
    !RUN_ID.test(args[6] ?? '')
  ) {
    return deny(
      'Only the plugin artifact validator is allowed through Node. Validate the exact role-owned artifact with its documented command.',
    );
  }
  if (args[4] !== expectedType) {
    return deny(
      `The artifact type does not match this role. ${expectedType} is the only validator type allowed for this agent.`,
    );
  }
  const loaded = requirePolicy(cwd, args[6]);
  if (loaded.result != null) return loaded.result;
  if (!samePath(cwd, loaded.policy.repositoryRoot)) {
    return deny(
      'Artifact validation must run from the target repository root. Use the documented validator command with --repo . after writing the run-owned artifact.',
    );
  }
  const expectedArtifact = path.join(
    loaded.policy.runDirectory,
    expectedFilename,
  );
  const suppliedArtifact = resolveOwnedPath(cwd, args[7] ?? '', loaded.policy);
  if (
    suppliedArtifact == null ||
    !samePath(suppliedArtifact, expectedArtifact) ||
    normalizePath(args[7]) !==
      `.playwright-cli/testgen/${args[6]}/${expectedFilename}`
  ) {
    return deny(
      'Artifact validation must use the exact current run artifact path. Use the role-owned handoff.json or healer-trace.json under .playwright-cli/testgen/<run_id>/.',
    );
  }
  return decision(
    'allow',
    'Plugin artifact validation is scoped to this role and exact current run artifact.',
  );
}

function policiesAbove(cwd) {
  const policies = [];
  const seen = new Set();
  let directory = path.resolve(cwd);

  while (true) {
    const runsDirectory = path.join(directory, '.playwright-cli', 'testgen');
    let entries = [];
    try {
      entries = readdirSync(runsDirectory, { withFileTypes: true });
    } catch {
      // This ancestor has no readable Testgen run directory.
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || !RUN_ID.test(entry.name)) continue;
      const policy = loadPolicy(directory, entry.name);
      if (policy == null || seen.has(policy.policyPath)) continue;
      seen.add(policy.policyPath);
      policies.push(policy);
    }

    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }

  return policies;
}

function policiesNear(...paths) {
  const policies = paths.flatMap(policiesAbove);
  return policies.filter(
    (policy, index) =>
      policies.findIndex((candidate) =>
        samePath(candidate.policyPath, policy.policyPath),
      ) === index,
  );
}

function validateFileAccess(payload) {
  const filePath = payload?.tool_input?.file_path;
  if (typeof filePath !== 'string' || filePath.length === 0) {
    return deny(
      'The file mutation path is missing. Retry Edit or Write with the exact intended repository path.',
    );
  }

  const absolute = path.resolve(payload.cwd, filePath);
  const lexical = normalizePath(absolute);
  let canonical = absolute;
  try {
    canonical = realpathSync(absolute);
  } catch {
    let ancestor = path.dirname(absolute);
    while (!existsSync(ancestor) && path.dirname(ancestor) !== ancestor)
      ancestor = path.dirname(ancestor);
    try {
      canonical = path.resolve(
        realpathSync(ancestor),
        path.relative(ancestor, absolute),
      );
    } catch {
      // The normal tool sandbox handles paths with no resolvable ancestor.
    }
  }

  const normalized = normalizePath(canonical);
  if (
    policiesNear(payload.cwd, absolute, canonical).some((policy) =>
      policy.allowedStatePaths.some(
        (allowed) =>
          samePath(allowed.absolute, absolute) ||
          samePath(allowed.canonical, canonical) ||
          sameFile(allowed.absolute, absolute),
      ),
    )
  ) {
    return deny(
      'Approved storage state is opaque to Author and Healer. Pass only its exact policy-approved path to playwright-cli state-load; never read or modify the file.',
    );
  }

  if (payload.tool_name === 'Read') return {};

  for (const policy of policiesNear(payload.cwd, absolute, canonical)) {
    for (const [filename, owner] of [
      ['handoff.json', 'playwright-test-author'],
      ['healer-trace.json', 'playwright-test-healer'],
    ]) {
      const expected = path.join(policy.runDirectory, filename);
      const canonicalExpected = path.join(
        policy.canonicalRunDirectory,
        filename,
      );
      const exact =
        samePath(absolute, expected) &&
        (!existsSync(absolute) || samePath(canonical, canonicalExpected));
      const aliasesArtifact =
        exact || sameFile(expected, absolute) || sameFile(expected, canonical);
      if (!aliasesArtifact) continue;
      if (!exact || !payload.agent_type.endsWith(owner)) {
        return deny(
          'This run artifact belongs to the other role or an aliased path. Mutate only the exact role-owned artifact: Author owns handoff.json and Healer owns healer-trace.json.',
        );
      }
    }
  }

  if (
    (runIdFromOwnedPath(lexical) != null &&
      comparablePath(lexical).endsWith('/.playwright/cli.config.json')) ||
    (runIdFromOwnedPath(normalized) != null &&
      comparablePath(normalized).endsWith('/.playwright/cli.config.json'))
  ) {
    return deny(
      'Playwright CLI configuration is disabled inside run scratch so repository and user settings cannot alter browser behavior. Use the isolated default configuration required by the workflow.',
    );
  }

  if (
    (samePath(path.basename(lexical), 'command-policy.json') &&
      runIdFromOwnedPath(lexical) != null) ||
    (samePath(path.basename(normalized), 'command-policy.json') &&
      runIdFromOwnedPath(normalized) != null)
  ) {
    return deny(
      'The run command policy is Main-owned and immutable to Author and Healer. Return the update to Main instead of editing this file.',
    );
  }

  return {};
}

function validateGrepAccess(payload) {
  const requestedPath = payload?.tool_input?.path ?? payload.cwd;
  if (typeof requestedPath !== 'string' || requestedPath.length === 0) {
    return deny(
      'The Grep search path is missing. Scope Grep to a source or test path that cannot include approved storage state.',
    );
  }

  const absolute = path.resolve(payload.cwd, requestedPath);
  let canonical = absolute;
  try {
    canonical = realpathSync(absolute);
  } catch {
    // Grep reports missing paths; lexical containment is sufficient here.
  }

  const policies = policiesNear(payload.cwd, absolute, canonical).filter(
    (policy) =>
      isContained(policy.repositoryRoot, absolute, true) &&
      isContained(policy.canonicalRepositoryRoot, canonical, true),
  );
  if (policies.length === 0) {
    return deny(
      'Scope Grep to a source or test path inside the target repository authorized by command-policy.json.',
    );
  }

  let searchesDirectory = false;
  try {
    searchesDirectory = statSync(absolute).isDirectory();
  } catch {
    // Grep reports missing paths after this policy check.
  }
  const linkedStateCouldBeInSearch =
    searchesDirectory &&
    policies.some((policy) =>
      policy.allowedStatePaths.some((allowed) => {
        try {
          return statSync(allowed.absolute, { bigint: true }).nlink > 1n;
        } catch {
          return false;
        }
      }),
    );

  const includesStorageState = policies.some((policy) =>
    policy.allowedStatePaths.some(
      (allowed) =>
        isContained(absolute, allowed.absolute, true) ||
        isContained(canonical, allowed.canonical, true) ||
        sameFile(absolute, allowed.absolute),
    ),
  );
  if (includesStorageState || linkedStateCouldBeInSearch) {
    return deny(
      'Approved storage state is opaque to Author and Healer. Scope Grep to a source or test path that cannot include the policy-approved state file.',
    );
  }

  return {};
}

function evaluate(payload) {
  if (!GOVERNED_AGENT.test(payload?.agent_type ?? '')) return {};
  if (
    payload?.hook_event_name !== 'PreToolUse' ||
    typeof payload.cwd !== 'string' ||
    payload.cwd.length === 0
  ) {
    return deny(
      'Hook input is incomplete. Retry the operation through a normal Bash tool call from the target repository.',
    );
  }

  if (['Read', 'Edit', 'Write'].includes(payload.tool_name)) {
    return validateFileAccess(payload);
  }
  if (payload.tool_name === 'Grep') return validateGrepAccess(payload);
  if (
    payload.tool_name !== 'Bash' ||
    typeof payload?.tool_input?.command !== 'string' ||
    payload.tool_input.command.length === 0
  ) {
    return deny(
      'Hook input is incomplete. Retry the operation through a normal governed tool call from the target repository.',
    );
  }
  if (payload.tool_input.dangerouslyDisableSandbox === true) {
    return deny(
      'Governed Testgen commands must remain sandboxed. Retry without dangerouslyDisableSandbox or return the sandbox prerequisite to Main.',
    );
  }

  const parsed = parseCommand(payload.tool_input.command, payload.cwd);
  if (parsed.result != null) return parsed.result;
  const split = splitExecutable(parsed.tokens);
  if (split.result != null) return split.result;

  const [executable, ...args] = split.remaining;
  if (
    executable === 'node' &&
    split.assignments.length === 0 &&
    args.length === 2 &&
    args[0] === '-e' &&
    args[1] === RUNTIME_PREFLIGHT
  ) {
    return decision(
      'allow',
      "Read-only resolution check for the target repository's Playwright packages.",
    );
  }

  if (executable === 'node' && split.assignments.length === 0) {
    return validateArtifactValidator(parsed.cwd, args, payload.agent_type);
  }

  if (executable === 'realpath' && split.assignments.length === 0) {
    return validateRealpath(parsed.cwd, args);
  }
  if (executable === 'rm' && split.assignments.length === 0) {
    return validateCleanup(parsed.cwd, args);
  }

  if (executable !== 'npm') {
    return deny(
      'Only the approved local npm and Node command forms are allowed. Use npm exec --no -- playwright-cli for browser work.',
    );
  }

  if (args[0] === 'run') {
    return decision(
      'ask',
      "This hook cannot inspect repository-defined npm scripts. Approve only the target repository's existing scoped lint or formatter with touched-file arguments; otherwise deny and report the lint prerequisite.",
    );
  }

  if (
    args[0] !== 'exec' ||
    args[1] !== '--no' ||
    args[2] !== '--' ||
    !['playwright', 'playwright-cli'].includes(args[3])
  ) {
    return deny(
      "This npm command is outside the workflow allowlist. Use npm exec --no -- playwright-cli for browser work or the target repository's existing scoped lint script with approval.",
    );
  }

  const packageName = args[3];
  const packageArgs = args.slice(4);
  if (packageName === 'playwright-cli') {
    return validateCli(
      parsed.cwd,
      split.assignments,
      packageArgs,
      payload.agent_type,
    );
  }
  if (!payload.agent_type.endsWith('playwright-test-healer')) {
    return deny(
      'Author never executes or debugs the spec. Return the candidate to Main for the human checkpoint; only Healer may run the approved spec after run approval.',
    );
  }
  if (packageArgs[0] === 'trace') {
    if (split.assignments.length !== 0) {
      return deny(
        'Trace inspection does not accept environment assignments. Run npm exec --no -- playwright trace from the validated run directory.',
      );
    }
    return validateTrace(parsed.cwd, packageArgs.slice(1));
  }
  return validatePlaywright(
    parsed.cwd,
    split.assignments,
    packageArgs,
    payload.tool_input,
  );
}

function main() {
  let payload;
  try {
    payload = JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    payload = null;
  }
  process.stdout.write(`${JSON.stringify(evaluate(payload))}\n`);
}

if (require.main === module) main();

module.exports = { evaluate, loadPolicy };

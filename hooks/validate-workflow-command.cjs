const {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  statSync,
} = require('node:fs');
const path = require('node:path');
const { decision, deny } = require('./hook-result.cjs');
const {
  RUN_ID,
  loadPolicy,
  normalizePath,
  resolveContainedPath,
  runIdFromOwnedPath,
  samePath,
} = require('./run-policy.cjs');

const DEBUG_SESSION = /^tw-[A-Za-z0-9-]+$/u;
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
  if (relative === '') {
    return deny(
      'The full run directory is Main-owned. Remove only the generated exploration or attempt child; Main removes the full run directory after the result is accepted.',
    );
  }
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

module.exports = {
  pluginValidatorPath,
  validateArtifactValidator,
  validateCleanup,
  validateCli,
  validatePlaywright,
  validateRealpath,
  validateTrace,
};

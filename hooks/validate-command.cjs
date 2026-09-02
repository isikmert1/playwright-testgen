const { existsSync } = require('node:fs');
const path = require('node:path');
const parse = require('shell-quote/parse');
const { decision, deny } = require('./hook-result.cjs');
const {
  loadPolicy,
  runIdFromOwnedPath,
  samePath,
} = require('./run-policy.cjs');
const {
  pluginValidatorPath,
  validateArtifactValidator,
  validateCleanup,
  validateCli,
  validatePlaywright,
  validateRealpath,
  validateTrace,
} = require('./validate-workflow-command.cjs');

const ENVIRONMENT_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/u;
const RUNTIME_PREFLIGHT =
  "for (const id of ['playwright/package.json','@playwright/test/package.json','@playwright/cli/package.json']) require.resolve(id)";

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

function validateCommand(payload) {
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

module.exports = { validateCommand };

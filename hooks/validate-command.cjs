const { existsSync, readFileSync, readdirSync, statSync } = require('node:fs');
const path = require('node:path');
const parse = require('../vendor/shell-quote/parse');
const { decision, deny } = require('./hook-result.cjs');
const {
  RUN_ID,
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
const PACKAGE_SCRIPT_RUNNERS = new Set(['bun', 'npm', 'pnpm', 'yarn']);
function repositoryPolicies(cwd) {
  let entries;
  try {
    entries = readdirSync(path.join(cwd, '.playwright-cli', 'testgen'), {
      withFileTypes: true,
    });
  } catch {
    return [];
  }

  return entries
    .filter((entry) => entry.isDirectory() && RUN_ID.test(entry.name))
    .map((entry) => loadPolicy(cwd, entry.name));
}

function hasPolicyAtRepositoryRoot(cwd) {
  return repositoryPolicies(cwd).some(
    (policy) =>
      policy?.kind === 'generation' &&
      samePath(path.resolve(cwd), policy.repositoryRoot),
  );
}

function validateAuthorCollection(cwd, assignments, args, toolInput) {
  if (assignments.length !== 0 || toolInput.run_in_background === true) {
    return deny(
      'Author collection must run in the foreground from the repository root without environment assignments. Only Healer may execute the spec after the human checkpoint.',
    );
  }

  const policies = repositoryPolicies(cwd);
  if (policies.length !== 1) {
    return deny(
      'Author collection requires exactly one active Testgen run policy in this repository. Finish or clean up other runs before using the collection fallback.',
    );
  }

  const candidate = policies[0];
  const expected =
    candidate?.kind !== 'generation'
      ? []
      : [
          'test',
          candidate.approvedSpecFilter,
          '--list',
          ...candidate.allowedRunnerOptions,
        ];
  let specIsFile = false;
  if (candidate != null) {
    try {
      specIsFile = statSync(candidate.approvedSpec).isFile();
    } catch {
      specIsFile = false;
    }
  }
  const policy =
    candidate?.kind === 'generation' &&
    samePath(path.resolve(cwd), candidate.repositoryRoot) &&
    args.length === expected.length &&
    args.every((value, index) => value === expected[index]) &&
    specIsFile
      ? candidate
      : null;

  if (policy == null) {
    return deny(
      "Author may only collect the exact policy-approved spec with --list and every Main-approved project or config option. Use Main's approved spec filter unchanged.",
    );
  }

  return decision(
    'allow',
    'Collects the exact policy-approved spec without executing its test callback.',
  );
}

function hasDeclaredPackageScript(cwd, scriptName) {
  if (typeof scriptName !== 'string' || scriptName.length === 0) return false;

  try {
    const manifest = JSON.parse(
      readFileSync(path.join(cwd, 'package.json'), 'utf8'),
    );
    const scripts = manifest?.scripts;
    return (
      scripts != null &&
      typeof scripts === 'object' &&
      !Array.isArray(scripts) &&
      Object.hasOwn(scripts, scriptName) &&
      typeof scripts[scriptName] === 'string' &&
      scripts[scriptName].trim().length > 0
    );
  } catch {
    return false;
  }
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
      else if (character === '$' && command[index + 1] === '(') return true;
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
    if (character === '$' && command[index + 1] === '(') return true;
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
  const pluginRoot =
    validator == null ? null : path.dirname(path.dirname(validator));
  let tokens;
  try {
    tokens = parse(command, (name) =>
      name === 'PLAYWRIGHT_TESTGEN_ROOT' && pluginRoot != null
        ? pluginRoot
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
        'Run repository commands directly from the current repository root. A cd wrapper is allowed only when it enters .playwright-cli/testgen/<run_id> for one run-owned CLI or trace command.',
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
      'Hook input is incomplete. Retry the operation through a normal governed tool call from the repository.',
    );
  }
  if (payload.tool_input.dangerouslyDisableSandbox === true) {
    return deny(
      'Governed Testgen commands must remain sandboxed. Retry without dangerouslyDisableSandbox or return the sandbox prerequisite to Main.',
    );
  }
  if (
    /\$(?:\{)?CLAUDE_PLUGIN_ROOT(?:\}|\/)/u.test(payload.tool_input.command)
  ) {
    return deny(
      'CLAUDE_PLUGIN_ROOT is unavailable to governed Bash commands. Use $PLAYWRIGHT_TESTGEN_ROOT from the SessionStart hook; if it is missing, restart Claude Code after installing or reloading the plugin.',
    );
  }
  if (
    /PLAYWRIGHT_TESTGEN_ROOT/u.test(payload.tool_input.command) &&
    !/^node\s+"\$(?:PLAYWRIGHT_TESTGEN_ROOT|\{PLAYWRIGHT_TESTGEN_ROOT\})\/scripts\/validate-testgen-artifact\.cjs"\s+/u.test(
      payload.tool_input.command,
    )
  ) {
    return deny(
      'PLAYWRIGHT_TESTGEN_ROOT is already exported for the documented artifact validator. Use it directly there; do not print, resolve, or probe it.',
    );
  }

  const parsed = parseCommand(payload.tool_input.command, payload.cwd);
  if (parsed.result != null) return parsed.result;
  const split = splitExecutable(parsed.tokens);
  if (split.result != null) return split.result;

  const [executable, ...args] = split.remaining;
  if (payload.agent_type.endsWith('playwright-test-explorer')) {
    if (executable === 'playwright-cli') {
      return validateCli(
        parsed.cwd,
        split.assignments,
        args,
        payload.agent_type,
      );
    }
    if (executable === 'rm' && split.assignments.length === 0) {
      return validateCleanup(parsed.cwd, args, payload.agent_type);
    }
    const exactHistory =
      split.assignments.length === 0 &&
      [
        'git',
        '--no-pager',
        'log',
        '--max-count=20',
        '--name-only',
        '--pretty=format:%H%x09%s',
        '--no-ext-diff',
        '--no-textconv',
        '--',
        '.',
      ].every((value, index) => split.remaining[index] === value) &&
      split.remaining.length === 10;
    if (exactHistory) {
      const policies = repositoryPolicies(parsed.cwd);
      if (
        policies.length === 1 &&
        policies[0]?.kind === 'discovery' &&
        samePath(path.resolve(parsed.cwd), policies[0].repositoryRoot)
      ) {
        return decision(
          'allow',
          'Git history is read-only, bounded to twenty commits, and disables external diff and text conversion.',
        );
      }
    }
    return deny(
      'Explorer commands are limited to bounded Git history, run-owned Playwright CLI inspection, and browser-scratch cleanup.',
    );
  }

  if (
    executable === 'node' &&
    split.assignments.length === 0 &&
    args.length === 1 &&
    args[0] === '--version'
  ) {
    return decision('allow', 'Read-only Node.js runtime version check.');
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

  if (executable === 'playwright-cli') {
    return validateCli(parsed.cwd, split.assignments, args, payload.agent_type);
  }

  if (executable === 'npx' && args[0] === '--no' && args[1] === 'playwright') {
    const packageArgs = args.slice(2);
    if (!payload.agent_type.endsWith('playwright-test-healer')) {
      return validateAuthorCollection(
        parsed.cwd,
        split.assignments,
        packageArgs,
        payload.tool_input,
      );
    }
    if (packageArgs[0] === 'trace') {
      if (split.assignments.length !== 0) {
        return deny(
          'Trace inspection does not accept environment assignments. Run npx --no playwright trace from the validated run directory.',
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

  if (
    PACKAGE_SCRIPT_RUNNERS.has(executable) &&
    split.assignments.length === 0 &&
    args[0] === 'run'
  ) {
    if (!hasPolicyAtRepositoryRoot(parsed.cwd)) {
      return deny(
        'Validation scripts must run from the exact repository root that owns the current Testgen policy.',
      );
    }
    const scriptName = args[1];
    if (
      typeof scriptName !== 'string' ||
      scriptName.startsWith('-') ||
      (executable === 'npm' && args.length > 2 && args[2] !== '--')
    ) {
      return deny(
        'Package-manager options and script shortcuts are not allowed. Use the explicit <manager> run <script> form; for npm script arguments, add -- after the script name.',
      );
    }
    if (!hasDeclaredPackageScript(parsed.cwd, scriptName)) {
      return deny(
        'Validation must use an existing declared package.json script from the repository. Use its package manager with the explicit <manager> run <script> form.',
      );
    }
    return decision(
      'ask',
      "Approve this repository's validation script? A package script may execute arbitrary commands, including lifecycle hooks. Choose Yes only if the script and arguments match the repository's trusted lint, typecheck, or formatter convention; prefer touched-file scope when that command supports it.",
    );
  }

  return deny(
    'This command is outside the workflow allowlist. Use playwright-cli directly for browser work, npx --no playwright for the repository runner or trace inspection, or an existing scoped package script through npm, Yarn, pnpm, or Bun with approval.',
  );
}

module.exports = { validateCommand };

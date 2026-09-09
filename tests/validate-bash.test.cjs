const assert = require('node:assert/strict');
const {
  mkdirSync,
  mkdtempSync,
  linkSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { parse } = require('shell-quote');
const {
  exactPlaywrightFilter: policySpecFilter,
} = require('../hooks/run-policy.cjs');

const repositoryRoot = path.resolve(__dirname, '..');
const hookPath = path.join(repositoryRoot, 'hooks', 'validate-bash.cjs');
const specFilterPath = path.join(
  repositoryRoot,
  'scripts',
  'print-approved-spec-filter.cjs',
);
const runId = 'tg-0123456789abcdef01234567';

function createTargetRepository() {
  const targetRepository = mkdtempSync(path.join(tmpdir(), 'testgen-hook-'));
  const runDirectory = path.join(
    targetRepository,
    '.playwright-cli',
    'testgen',
    runId,
  );

  mkdirSync(runDirectory, { recursive: true });
  mkdirSync(path.join(targetRepository, 'tests'));
  writeFileSync(
    path.join(targetRepository, 'package.json'),
    JSON.stringify({ scripts: { lint: 'eslint .' } }),
  );
  writeFileSync(path.join(targetRepository, 'tests', 'account.spec.ts'), '');
  writeFileSync(
    path.join(runDirectory, 'command-policy.json'),
    JSON.stringify({
      approved_spec: 'tests/account.spec.ts',
      allowed_runner_options: [],
      allowed_state_paths: [],
      allowed_write_paths: [],
      format_version: 1,
      run_id: runId,
      allowed_origins: ['http://127.0.0.1:3000'],
    }),
  );

  const resultsDirectory = path.join(runDirectory, 'attempt-1', 'test-results');
  mkdirSync(resultsDirectory, { recursive: true });
  writeFileSync(path.join(resultsDirectory, 'trace.zip'), 'trace');
  writeFileSync(path.join(resultsDirectory, 'error-context.md'), 'context');

  return { resultsDirectory, runDirectory, targetRepository };
}

function runToolHook(
  cwd,
  toolName,
  toolInput,
  agentType = 'playwright-test-author',
  environment = {},
) {
  const result = spawnSync(process.execPath, [hookPath], {
    encoding: 'utf8',
    env: { ...process.env, ...environment },
    input: JSON.stringify({
      agent_type: agentType,
      cwd,
      hook_event_name: 'PreToolUse',
      tool_input: toolInput,
      tool_name: toolName,
    }),
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');

  const output = JSON.parse(result.stdout);
  if (output.hookSpecificOutput != null) {
    assert.equal(output.hookSpecificOutput.hookEventName, 'PreToolUse');
    return output.hookSpecificOutput;
  }
  return output;
}

function runHook(cwd, command, agentType = 'playwright-test-author') {
  return runToolHook(cwd, 'Bash', { command }, agentType);
}

function exactSpecFilter(repository, relative = 'tests/account.spec.ts') {
  const absolute = path.resolve(repository, relative).replaceAll('\\', '/');
  const escaped = absolute.replace(/[\\^$.*+?()[\]{}|/]/gu, '\\$&');
  const flags = process.platform === 'win32' ? 'i' : '';
  return `/^${escaped}$/${flags}`;
}

function runnerCommand(repository, output, options = '') {
  const filter = exactSpecFilter(repository);
  return `PLAYWRIGHT_HTML_OPEN=never npx --no playwright test '${filter}' ${options}--retries=0 --repeat-each=1 --output=${output}`;
}

test('makes exact spec filters explicit about platform case semantics', () => {
  const filter = policySpecFilter('C:/repo/Account.spec.ts');

  assert.equal(filter.startsWith('/^'), true);
  assert.equal(
    filter.endsWith(process.platform === 'win32' ? '$/i' : '$/'),
    true,
  );
});

test('prints the approved spec filter as one shell-safe argument', () => {
  withTargetRepository(({ targetRepository }) => {
    const result = spawnSync(process.execPath, [specFilterPath, runId], {
      cwd: targetRepository,
      encoding: 'utf8',
    });

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(parse(result.stdout.trim()), [
      exactSpecFilter(targetRepository),
    ]);
  });
});

function updatePolicy(runDirectory, values) {
  const policyPath = path.join(runDirectory, 'command-policy.json');
  const policy = JSON.parse(readFileSync(policyPath, 'utf8'));
  writeFileSync(policyPath, JSON.stringify({ ...policy, ...values }));
}

test('denies malformed hook input instead of failing open', () => {
  const result = spawnSync(process.execPath, [hookPath], {
    encoding: 'utf8',
    input: '{',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');

  const output = JSON.parse(result.stdout).hookSpecificOutput;
  assert.equal(output.hookEventName, 'PreToolUse');
  assert.equal(output.permissionDecision, 'deny');
  assert.match(
    output.permissionDecisionReason,
    /validation could not complete/iu,
  );
});

test('allows main-thread calls without an agent type to remain ungoverned', () => {
  const result = spawnSync(process.execPath, [hookPath], {
    encoding: 'utf8',
    input: JSON.stringify({
      cwd: repositoryRoot,
      hook_event_name: 'PreToolUse',
      tool_input: { command: 'git status' },
      tool_name: 'Bash',
    }),
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout), {});
});

function runCliHook(cwd, command, agentType = 'playwright-test-author') {
  return runHook(
    cwd,
    `cd .playwright-cli/testgen/${runId} && PWTEST_CLI_GLOBAL_CONFIG=. playwright-cli ${command}`,
    agentType,
  );
}

test('allows the official global Playwright CLI invocation', () => {
  withTargetRepository(({ targetRepository }) => {
    const result = runHook(
      targetRepository,
      `cd .playwright-cli/testgen/${runId} && PWTEST_CLI_GLOBAL_CONFIG=. playwright-cli -s=${runId} snapshot`,
    );

    assert.equal(result.permissionDecision, 'allow');
  });
});

test('allows the official global Playwright CLI preflight', () => {
  withTargetRepository(({ targetRepository }) => {
    for (const command of [
      'node --version',
      'playwright-cli --version',
      'playwright-cli --help',
    ]) {
      assert.equal(
        runHook(targetRepository, command).permissionDecision,
        'allow',
      );
    }
  });
});

test('allows raw output only for locator generation', () => {
  withTargetRepository(({ targetRepository }) => {
    for (const command of [
      `-s=${runId} --raw generate-locator e1`,
      `-s=${runId} generate-locator e1 --raw`,
    ]) {
      assert.equal(
        runCliHook(targetRepository, command).permissionDecision,
        'allow',
      );
    }

    for (const command of [
      `-s=${runId} snapshot --raw`,
      `-s=${runId} generate-locator e1 --raw=true`,
    ]) {
      assert.equal(
        runCliHook(targetRepository, command).permissionDecision,
        'deny',
      );
    }
  });
});

test('allows the official local Playwright runner without implicit installs', () => {
  withTargetRepository(({ targetRepository }) => {
    const output = `.playwright-cli/testgen/${runId}/attempt-2/test-results`;
    const filter = exactSpecFilter(targetRepository);
    const result = runToolHook(
      targetRepository,
      'Bash',
      {
        command: `PLAYWRIGHT_HTML_OPEN=never npx --no playwright test '${filter}' --debug=cli --retries=0 --repeat-each=1 --output=${output}`,
        run_in_background: true,
      },
      'playwright-test-healer',
    );

    assert.equal(result.permissionDecision, 'allow');
  });
});

test('allows Author to collect only the policy-approved spec', () => {
  withTargetRepository(({ targetRepository }) => {
    writeFileSync(
      path.join(targetRepository, 'package.json'),
      JSON.stringify({ scripts: { 'test:e2e': 'playwright test' } }),
    );
    const filter = exactSpecFilter(targetRepository);
    const result = runHook(
      targetRepository,
      `npx --no playwright test '${filter}' --list`,
    );

    assert.equal(result.permissionDecision, 'allow');
  });
});

test('requires Main-approved runner options for Author collection', () => {
  withTargetRepository(({ runDirectory, targetRepository }) => {
    updatePolicy(runDirectory, {
      allowed_runner_options: ['--project=chromium'],
    });
    const filter = exactSpecFilter(targetRepository);

    assert.equal(
      runHook(targetRepository, `npx --no playwright test '${filter}' --list`)
        .permissionDecision,
      'deny',
    );
    assert.equal(
      runHook(
        targetRepository,
        `npx --no playwright test '${filter}' --list --project=chromium`,
      ).permissionDecision,
      'allow',
    );
  });
});

test('keeps Author collection exact, foreground, and non-executing', () => {
  withTargetRepository(({ runDirectory, targetRepository }) => {
    const filter = exactSpecFilter(targetRepository);
    const commands = [
      `npx --no playwright test '${filter}'`,
      `npx --no playwright test tests/account.spec.ts --list`,
      `npx --no playwright test '${filter}' --list --debug=cli`,
      `npx --no playwright test '${filter}' --list --output=results`,
      `PLAYWRIGHT_HTML_OPEN=never npx --no playwright test '${filter}' --list`,
    ];

    for (const command of commands) {
      assert.equal(
        runHook(targetRepository, command).permissionDecision,
        'deny',
        command,
      );
    }

    assert.equal(
      runToolHook(targetRepository, 'Bash', {
        command: `npx --no playwright test '${filter}' --list`,
        run_in_background: true,
      }).permissionDecision,
      'deny',
    );
    for (const cwd of [path.join(targetRepository, 'tests'), runDirectory]) {
      assert.equal(
        runHook(cwd, `npx --no playwright test '${filter}' --list`)
          .permissionDecision,
        'deny',
      );
    }
  });
});

test('fails Author collection closed when run policies are ambiguous', () => {
  withTargetRepository(({ runDirectory, targetRepository }) => {
    const filter = exactSpecFilter(targetRepository);
    const command = `npx --no playwright test '${filter}' --list`;
    const otherRunId = 'tg-aaaaaaaaaaaaaaaaaaaaaaaa';
    const otherRunDirectory = path.join(
      targetRepository,
      '.playwright-cli',
      'testgen',
      otherRunId,
    );
    mkdirSync(otherRunDirectory);
    const policy = JSON.parse(
      readFileSync(path.join(runDirectory, 'command-policy.json'), 'utf8'),
    );
    writeFileSync(
      path.join(otherRunDirectory, 'command-policy.json'),
      JSON.stringify({ ...policy, run_id: otherRunId }),
    );

    assert.equal(runHook(targetRepository, command).permissionDecision, 'deny');

    rmSync(otherRunDirectory, { recursive: true });
    const invalidRunDirectory = path.join(
      targetRepository,
      '.playwright-cli',
      'testgen',
      'tg-bbbbbbbbbbbbbbbbbbbbbbbb',
    );
    mkdirSync(invalidRunDirectory);
    writeFileSync(path.join(invalidRunDirectory, 'command-policy.json'), '{}');

    assert.equal(runHook(targetRepository, command).permissionDecision, 'deny');
  });
});

test('denies npm wrappers that can consume Playwright CLI options', () => {
  withTargetRepository(({ targetRepository }) => {
    const result = runHook(
      targetRepository,
      `cd .playwright-cli/testgen/${runId} && PWTEST_CLI_GLOBAL_CONFIG=. npm exec --no -- playwright-cli -s=${runId} snapshot`,
    );

    assert.equal(result.permissionDecision, 'deny');
    assert.match(result.permissionDecisionReason, /playwright-cli directly/iu);
  });
});

test('denies npx Playwright execution that could install a missing package', () => {
  withTargetRepository(({ targetRepository }) => {
    const result = runHook(targetRepository, 'npx playwright test --help');

    assert.equal(result.permissionDecision, 'deny');
    assert.match(result.permissionDecisionReason, /npx --no playwright/iu);
  });
});

function withTargetRepository(callback) {
  const target = createTargetRepository();
  try {
    callback(target);
  } finally {
    rmSync(target.targetRepository, { force: true, recursive: true });
  }
}

test('allows a quoted CSS selector containing href$=', () => {
  withTargetRepository(({ targetRepository }) => {
    for (const selector of [
      `'a[href$="/2753"]'`,
      String.raw`"a[href$=\"/2753\"]"`,
    ]) {
      assert.equal(
        runHook(
          targetRepository,
          `cd .playwright-cli/testgen/${runId} && PWTEST_CLI_GLOBAL_CONFIG=. playwright-cli -s=${runId} click ${selector}`,
        ).permissionDecision,
        'allow',
      );
    }
  });
});

test('allows required snapshot search and navigation commands', () => {
  withTargetRepository(({ targetRepository }) => {
    for (const command of [
      `-s=${runId} find 'Add to cart'`,
      `-s=${runId} go-forward`,
    ]) {
      assert.equal(
        runCliHook(targetRepository, command).permissionDecision,
        'allow',
      );
    }
  });
});

test('allows Healer to pause only at the approved spec and a positive line', () => {
  withTargetRepository(({ targetRepository }) => {
    const allowed = runCliHook(
      targetRepository,
      '-s=tw-debug-123 pause-at tests/account.spec.ts:42',
      'playwright-test-healer',
    );

    assert.equal(allowed.permissionDecision, 'allow');

    for (const command of [
      '-s=tw-debug-123 pause-at 42',
      '-s=tw-debug-123 pause-at tests/other.spec.ts:42',
      '-s=tw-debug-123 pause-at tests/account.spec.ts:0',
      '-s=tw-debug-123 pause-at tests/account.spec.ts:42 extra',
    ]) {
      const result = runCliHook(
        targetRepository,
        command,
        'playwright-test-healer',
      );
      assert.equal(result.permissionDecision, 'deny', command);
      assert.match(
        result.permissionDecisionReason,
        /approved spec.*positive line/iu,
      );
    }

    assert.equal(
      runCliHook(
        targetRepository,
        `-s=${runId} pause-at tests/account.spec.ts:42`,
      ).permissionDecision,
      'deny',
    );
  });
});

test('allows bounded console levels documented by Playwright CLI', () => {
  withTargetRepository(({ targetRepository }) => {
    for (const command of [
      `-s=${runId} console`,
      `-s=${runId} console error`,
      `-s=${runId} console warning`,
      `-s=${runId} console info`,
      `-s=${runId} console debug`,
    ]) {
      assert.equal(
        runCliHook(targetRepository, command).permissionDecision,
        'allow',
      );
    }

    for (const command of [
      `-s=${runId} console verbose`,
      `-s=${runId} console error extra`,
    ]) {
      const result = runCliHook(targetRepository, command);
      assert.equal(result.permissionDecision, 'deny');
      assert.match(
        result.permissionDecisionReason,
        /error.*warning.*info.*debug/iu,
      );
    }
  });
});

test('keeps snapshots to the page or one current element ref', () => {
  withTargetRepository(({ targetRepository }) => {
    for (const command of [
      `-s=${runId} snapshot`,
      `-s=${runId} snapshot e12`,
      `-s=${runId} snapshot --depth=4`,
      `-s=${runId} snapshot e12 --depth=4`,
    ]) {
      assert.equal(
        runCliHook(targetRepository, command).permissionDecision,
        'allow',
      );
    }

    for (const command of [
      `-s=${runId} snapshot "getByRole('row')"`,
      `-s=${runId} snapshot e12 e13`,
    ]) {
      const result = runCliHook(targetRepository, command);
      assert.equal(result.permissionDecision, 'deny');
      assert.match(result.permissionDecisionReason, /find.*generate-locator/iu);
    }
  });
});

test('denies a real pipe and names the single-command alternative', () => {
  withTargetRepository(({ targetRepository }) => {
    const result = runCliHook(targetRepository, `-s=${runId} snapshot | more`);

    assert.equal(result.permissionDecision, 'deny');
    assert.match(
      result.permissionDecisionReason,
      /run one allowlisted command at a time/iu,
    );
  });
});

test('denies shell syntax that shell-quote leaves inside word tokens', () => {
  withTargetRepository(({ targetRepository }) => {
    for (const command of [
      `playwright-cli -s=${runId} click foo\nid`,
      `playwright-cli -s=${runId} click \`id\``,
      `PLAYWRIGHT_HTML_OPEN=never npx --no playwright test tests/{account,admin}.spec.ts --retries=0 --repeat-each=1 --output=.playwright-cli/testgen/${runId}/attempt-1/test-results`,
    ]) {
      assert.equal(
        runHook(targetRepository, command).permissionDecision,
        'deny',
      );
    }
  });
});

test('denies an unquoted bracket glob before Bash can expand it', () => {
  withTargetRepository(({ targetRepository }) => {
    const result = runCliHook(targetRepository, `-s=${runId} click a[bc]`);

    assert.equal(result.permissionDecision, 'deny');
    assert.match(result.permissionDecisionReason, /shell expansion syntax/iu);
  });
});

test('denies Bash ANSI-C quoting before it can change an argument', () => {
  withTargetRepository(({ targetRepository }) => {
    const result = runCliHook(
      targetRepository,
      `-s=${runId} fill e1 $'--submit'`,
    );

    assert.equal(result.permissionDecision, 'deny');
    assert.match(result.permissionDecisionReason, /shell expansion syntax/iu);
  });
});

test('denies an escaped newline before Bash can reconstruct an option', () => {
  withTargetRepository(({ targetRepository }) => {
    const result = runCliHook(
      targetRepository,
      `-s=${runId} fill e1 text --submi\\\nt`,
    );

    assert.equal(result.permissionDecision, 'deny');
    assert.match(result.permissionDecisionReason, /shell expansion syntax/iu);
  });
});

test('denies shell home expansion in a trace path', () => {
  withTargetRepository(({ targetRepository }) => {
    const result = runHook(
      targetRepository,
      `cd .playwright-cli/testgen/${runId} && npx --no playwright trace open ~/outside.zip`,
      'playwright-test-healer',
    );

    assert.equal(result.permissionDecision, 'deny');
    assert.match(result.permissionDecisionReason, /shell expansion syntax/iu);
  });
});

test('denies an unsupported subcommand and names inspection alternatives', () => {
  withTargetRepository(({ targetRepository }) => {
    const result = runCliHook(
      targetRepository,
      `-s=${runId} eval 'location.href'`,
    );

    assert.equal(result.permissionDecision, 'deny');
    assert.match(
      result.permissionDecisionReason,
      /use snapshot, find, or generate-locator/iu,
    );
  });
});

test('denies navigation outside the run policy origins', () => {
  withTargetRepository(({ targetRepository }) => {
    const result = runCliHook(
      targetRepository,
      `-s=${runId} goto https://example.com/account`,
    );

    assert.equal(result.permissionDecision, 'deny');
    assert.match(
      result.permissionDecisionReason,
      /use an allowed origin from command-policy\.json/iu,
    );
  });
});

test('allows navigation on the approved origin', () => {
  withTargetRepository(({ targetRepository }) => {
    const result = runCliHook(
      targetRepository,
      `-s=${runId} goto http://127.0.0.1:3000/account`,
    );

    assert.equal(result.permissionDecision, 'allow');
  });
});

test('denies Playwright CLI outside its isolated run directory', () => {
  withTargetRepository(({ targetRepository }) => {
    for (const command of [
      `PWTEST_CLI_GLOBAL_CONFIG=. playwright-cli -s=${runId} snapshot`,
      `cd .playwright-cli/testgen/${runId} && playwright-cli -s=${runId} snapshot`,
    ]) {
      const result = runHook(targetRepository, command);
      assert.equal(result.permissionDecision, 'deny');
      assert.match(
        result.permissionDecisionReason,
        /exact policy-owned directory|suppress user and repository config/iu,
      );
    }
  });
});

test('binds each agent role to its owned Playwright CLI session', () => {
  withTargetRepository(({ targetRepository }) => {
    for (const [command, agentType] of [
      ['snapshot', 'playwright-test-author'],
      ['attach tw-debug-123', 'playwright-test-author'],
      [`-s=${runId} snapshot`, 'playwright-test-healer'],
    ]) {
      const result = runCliHook(targetRepository, command, agentType);
      assert.equal(result.permissionDecision, 'deny');
      assert.match(result.permissionDecisionReason, /owned session/iu);
    }

    assert.equal(
      runCliHook(
        targetRepository,
        'attach tw-debug-123',
        'playwright-test-healer',
      ).permissionDecision,
      'allow',
    );
    assert.equal(
      runCliHook(
        targetRepository,
        '-s=tw-debug-123 snapshot',
        'playwright-test-healer',
      ).permissionDecision,
      'allow',
    );
  });
});

test('binds storage state to an exact Main-approved repository path', () => {
  withTargetRepository(({ runDirectory, targetRepository }) => {
    const stateDirectory = path.join(targetRepository, 'playwright', '.auth');
    const statePath = path.join(stateDirectory, 'user.json');
    const stateArgument = '../../../playwright/.auth/user.json';
    mkdirSync(stateDirectory, { recursive: true });
    writeFileSync(statePath, '{}');
    writeFileSync(
      path.join(runDirectory, 'command-policy.json'),
      JSON.stringify({
        approved_spec: 'tests/account.spec.ts',
        allowed_runner_options: [],
        allowed_state_paths: [stateArgument],
        allowed_write_paths: [],
        format_version: 1,
        run_id: runId,
        allowed_origins: ['http://127.0.0.1:3000'],
      }),
    );

    assert.equal(
      runCliHook(targetRepository, `-s=${runId} state-load ${stateArgument}`)
        .permissionDecision,
      'allow',
    );
    const denied = runCliHook(
      targetRepository,
      `-s=${runId} state-load ../../../outside.json`,
    );
    assert.equal(denied.permissionDecision, 'deny');
    assert.match(denied.permissionDecisionReason, /approved state path/iu);
  });
});

test('allows one scoped Playwright debug attempt', () => {
  withTargetRepository(({ targetRepository }) => {
    const output = `.playwright-cli/testgen/${runId}/attempt-2/test-results`;
    const result = runToolHook(
      targetRepository,
      'Bash',
      {
        command: runnerCommand(targetRepository, output, '--debug=cli '),
        run_in_background: true,
      },
      'playwright-test-healer',
    );

    assert.equal(result.permissionDecision, 'allow');
  });
});

test('requires an anchored filter for the exact approved spec', () => {
  withTargetRepository(({ targetRepository }) => {
    const output = `.playwright-cli/testgen/${runId}/attempt-2/test-results`;
    const result = runToolHook(
      targetRepository,
      'Bash',
      {
        command: `PLAYWRIGHT_HTML_OPEN=never npx --no playwright test tests/account.spec.ts --debug=cli --retries=0 --repeat-each=1 --output=${output}`,
        run_in_background: true,
      },
      'playwright-test-healer',
    );

    assert.equal(result.permissionDecision, 'deny');
    assert.match(
      result.permissionDecisionReason,
      /exact approved spec filter/iu,
    );
  });
});

test('requires every runner option selected by Main', () => {
  withTargetRepository(({ runDirectory, targetRepository }) => {
    updatePolicy(runDirectory, {
      allowed_runner_options: [
        '--config=playwright.config.cjs',
        '--project=chromium',
      ],
    });
    const output = `.playwright-cli/testgen/${runId}/attempt-2/test-results`;
    const result = runToolHook(
      targetRepository,
      'Bash',
      {
        command: runnerCommand(targetRepository, output, '--debug=cli '),
        run_in_background: true,
      },
      'playwright-test-healer',
    );

    assert.equal(result.permissionDecision, 'deny');
    assert.match(
      result.permissionDecisionReason,
      /required.*project.*config/iu,
    );
  });
});

test('allows exact required runner options once', () => {
  withTargetRepository(({ runDirectory, targetRepository }) => {
    const options = ['--config=playwright.config.cjs', '--project=chromium'];
    updatePolicy(runDirectory, { allowed_runner_options: options });
    const output = `.playwright-cli/testgen/${runId}/attempt-2/test-results`;
    const result = runToolHook(
      targetRepository,
      'Bash',
      {
        command: runnerCommand(
          targetRepository,
          output,
          `--debug=cli ${options.join(' ')} `,
        ),
        run_in_background: true,
      },
      'playwright-test-healer',
    );

    assert.equal(result.permissionDecision, 'allow');
  });
});

test('requires debug runners to be background tasks', () => {
  withTargetRepository(({ targetRepository }) => {
    const output = `.playwright-cli/testgen/${runId}/attempt-2/test-results`;
    const result = runHook(
      targetRepository,
      runnerCommand(targetRepository, output, '--debug=cli '),
      'playwright-test-healer',
    );

    assert.equal(result.permissionDecision, 'deny');
    assert.match(result.permissionDecisionReason, /background/iu);
  });
});

test('keeps confirmation runners in the foreground', () => {
  withTargetRepository(({ targetRepository }) => {
    const output = `.playwright-cli/testgen/${runId}/attempt-2/test-results`;
    const result = runToolHook(
      targetRepository,
      'Bash',
      {
        command: runnerCommand(targetRepository, output),
        run_in_background: true,
      },
      'playwright-test-healer',
    );

    assert.equal(result.permissionDecision, 'deny');
    assert.match(result.permissionDecisionReason, /foreground/iu);
  });
});

test('requires Playwright runners to start at the repository root', () => {
  withTargetRepository(({ runDirectory, targetRepository }) => {
    const nestedDirectory = path.join(targetRepository, 'tests');
    const output = path
      .join(runDirectory, 'attempt-2', 'test-results')
      .replaceAll('\\', '/');
    const result = runHook(
      nestedDirectory,
      runnerCommand(targetRepository, output),
      'playwright-test-healer',
    );

    assert.equal(result.permissionDecision, 'deny');
    assert.match(result.permissionDecisionReason, /repository root/iu);
  });
});

test('denies unsandboxed governed Bash commands', () => {
  withTargetRepository(({ targetRepository }) => {
    const result = runToolHook(targetRepository, 'Bash', {
      command: `cd .playwright-cli/testgen/${runId} && PWTEST_CLI_GLOBAL_CONFIG=. playwright-cli -s=${runId} snapshot`,
      dangerouslyDisableSandbox: true,
    });

    assert.equal(result.permissionDecision, 'deny');
    assert.match(result.permissionDecisionReason, /sandbox/iu);
  });
});

test('denies inherited Playwright CLI configuration', () => {
  withTargetRepository(({ targetRepository }) => {
    for (const environment of [
      { PLAYWRIGHT_MCP_CONFIG: 'outside.json' },
      { playwright_mcp_config: 'outside.json' },
      { PLAYWRIGHT_CLI_SESSION: 'outside-session' },
    ]) {
      const result = runToolHook(
        targetRepository,
        'Bash',
        {
          command: `cd .playwright-cli/testgen/${runId} && PWTEST_CLI_GLOBAL_CONFIG=. playwright-cli -s=${runId} snapshot`,
        },
        'playwright-test-author',
        environment,
      );

      assert.equal(result.permissionDecision, 'deny');
      assert.match(result.permissionDecisionReason, /inherited Playwright/iu);
    }
  });
});

test('denies reuse of an existing attempt results directory', () => {
  withTargetRepository(({ targetRepository }) => {
    const output = `.playwright-cli/testgen/${runId}/attempt-1/test-results`;
    const result = runToolHook(
      targetRepository,
      'Bash',
      {
        command: runnerCommand(targetRepository, output, '--debug=cli '),
        run_in_background: true,
      },
      'playwright-test-healer',
    );

    assert.equal(result.permissionDecision, 'deny');
    assert.match(result.permissionDecisionReason, /fresh attempt/iu);
  });
});

test('reserves each runner attempt before the process starts', () => {
  withTargetRepository(({ runDirectory, targetRepository }) => {
    const output = `.playwright-cli/testgen/${runId}/attempt-2/test-results`;
    const toolInput = {
      command: runnerCommand(targetRepository, output, '--debug=cli '),
      run_in_background: true,
    };

    assert.equal(
      runToolHook(targetRepository, 'Bash', toolInput, 'playwright-test-healer')
        .permissionDecision,
      'allow',
    );

    const attemptDirectory = path.join(runDirectory, 'attempt-2');
    assert.equal(
      runHook(
        targetRepository,
        `rm -rf -- .playwright-cli/testgen/${runId}/attempt-2`,
        'playwright-test-healer',
      ).permissionDecision,
      'allow',
    );
    rmSync(attemptDirectory, { force: true, recursive: true });

    const duplicate = runToolHook(
      targetRepository,
      'Bash',
      toolInput,
      'playwright-test-healer',
    );
    assert.equal(duplicate.permissionDecision, 'deny');
    assert.match(duplicate.permissionDecisionReason, /fresh attempt/iu);
  });
});

test('denies the Playwright runner to Author before the human checkpoint', () => {
  withTargetRepository(({ targetRepository }) => {
    const output = `.playwright-cli/testgen/${runId}/attempt-1/test-results`;
    const result = runHook(
      targetRepository,
      runnerCommand(targetRepository, output),
    );

    assert.equal(result.permissionDecision, 'deny');
    assert.match(result.permissionDecisionReason, /human checkpoint/iu);
  });
});

test('denies runner output outside the policy run directory', () => {
  withTargetRepository(({ targetRepository }) => {
    const output = `elsewhere/.playwright-cli/testgen/${runId}/attempt-1/test-results`;
    const result = runHook(
      targetRepository,
      runnerCommand(targetRepository, output),
      'playwright-test-healer',
    );

    assert.equal(result.permissionDecision, 'deny');
    assert.match(result.permissionDecisionReason, /current run attempt/iu);
  });
});

test('denies runner output through an attempt junction or symlink', () => {
  withTargetRepository(({ runDirectory, targetRepository }) => {
    const outside = mkdtempSync(path.join(tmpdir(), 'testgen-output-'));
    const attempt = path.join(runDirectory, 'attempt-2');
    rmSync(attempt, { force: true, recursive: true });
    mkdirSync(path.join(outside, 'test-results'), { recursive: true });
    symlinkSync(outside, attempt, 'junction');

    try {
      const output = `.playwright-cli/testgen/${runId}/attempt-2/test-results`;
      const result = runHook(
        targetRepository,
        runnerCommand(targetRepository, output),
        'playwright-test-healer',
      );

      assert.equal(result.permissionDecision, 'deny');
      assert.match(result.permissionDecisionReason, /current run attempt/iu);
    } finally {
      rmSync(attempt, { force: true });
      rmSync(outside, { force: true, recursive: true });
    }
  });
});

test('denies an additional positional spec argument', () => {
  withTargetRepository(({ targetRepository }) => {
    const output = `.playwright-cli/testgen/${runId}/attempt-2/test-results`;
    const result = runHook(
      targetRepository,
      `PLAYWRIGHT_HTML_OPEN=never npx --no playwright test '${exactSpecFilter(targetRepository)}' '${exactSpecFilter(targetRepository, 'tests/admin.spec.ts')}' --retries=0 --repeat-each=1 --output=${output}`,
      'playwright-test-healer',
    );

    assert.equal(result.permissionDecision, 'deny');
    assert.match(result.permissionDecisionReason, /one approved spec/iu);
  });
});

test('denies a different spec and unapproved runner flags', () => {
  withTargetRepository(({ targetRepository }) => {
    const output = `.playwright-cli/testgen/${runId}/attempt-2/test-results`;
    for (const command of [
      `PLAYWRIGHT_HTML_OPEN=never npx --no playwright test '${exactSpecFilter(targetRepository, 'tests/admin.spec.ts')}' --retries=0 --repeat-each=1 --output=${output}`,
      runnerCommand(targetRepository, output, '--update-snapshots=all '),
    ]) {
      assert.equal(
        runHook(targetRepository, command, 'playwright-test-healer')
          .permissionDecision,
        'deny',
      );
    }
  });
});

test('denies a policy that approves a directory instead of one spec file', () => {
  withTargetRepository(({ runDirectory, targetRepository }) => {
    writeFileSync(
      path.join(runDirectory, 'command-policy.json'),
      JSON.stringify({
        approved_spec: 'tests',
        allowed_runner_options: [],
        allowed_state_paths: [],
        allowed_write_paths: [],
        format_version: 1,
        run_id: runId,
        allowed_origins: ['http://127.0.0.1:3000'],
      }),
    );
    const output = `.playwright-cli/testgen/${runId}/attempt-2/test-results`;
    const result = runToolHook(
      targetRepository,
      'Bash',
      {
        command: `PLAYWRIGHT_HTML_OPEN=never npx --no playwright test '${exactSpecFilter(targetRepository, 'tests')}' --debug=cli --retries=0 --repeat-each=1 --output=${output}`,
        run_in_background: true,
      },
      'playwright-test-healer',
    );

    assert.equal(result.permissionDecision, 'deny');
    assert.match(result.permissionDecisionReason, /spec file/iu);
  });
});

test('allows trace inspection for the current run', () => {
  withTargetRepository(({ targetRepository }) => {
    const enterRun = `cd .playwright-cli/testgen/${runId} &&`;
    for (const command of [
      `${enterRun} npx --no playwright trace open attempt-1/test-results/trace.zip`,
      `${enterRun} npx --no playwright trace actions --grep=expect`,
      `${enterRun} npx --no playwright trace action 9`,
      `${enterRun} npx --no playwright trace snapshot 9 --name after`,
      `${enterRun} npx --no playwright trace close`,
    ]) {
      assert.equal(
        runHook(targetRepository, command, 'playwright-test-healer')
          .permissionDecision,
        'allow',
      );
    }
  });
});

test('allows canonical inspection of a current-attempt artifact', () => {
  withTargetRepository(({ targetRepository }) => {
    const result = runHook(
      targetRepository,
      `cd .playwright-cli/testgen/${runId} && realpath -- attempt-1/test-results/error-context.md`,
      'playwright-test-healer',
    );

    assert.equal(result.permissionDecision, 'allow');
  });
});

test('reserves full run removal for Main', () => {
  withTargetRepository(({ targetRepository }) => {
    const exactRun = `.playwright-cli/testgen/${runId}`;
    const exact = runHook(targetRepository, `rm -rf -- ${exactRun}`);
    assert.equal(exact.permissionDecision, 'deny');
    assert.match(
      exact.permissionDecisionReason,
      /Main removes the full run directory/iu,
    );

    const parent = runHook(
      targetRepository,
      'rm -rf -- .playwright-cli/testgen',
    );
    assert.equal(parent.permissionDecision, 'deny');
    assert.match(parent.permissionDecisionReason, /exact run directory/iu);

    assert.equal(
      runHook(targetRepository, `rm -rf -- ${exactRun}/.playwright-cli`)
        .permissionDecision,
      'allow',
    );
  });
});

test('allows Author to remove generated browser scratch from the run directory', () => {
  withTargetRepository(({ runDirectory, targetRepository }) => {
    mkdirSync(path.join(runDirectory, '.playwright-cli'));
    const result = runHook(
      runDirectory,
      'rm -rf -- .playwright-cli',
      'playwright-test-author',
    );

    assert.equal(result.permissionDecision, 'allow');

    const fullRun = runHook(
      runDirectory,
      'rm -rf -- .',
      'playwright-test-author',
    );
    assert.equal(fullRun.permissionDecision, 'deny');
    assert.match(fullRun.permissionDecisionReason, /Main-owned/iu);

    assert.equal(
      path.dirname(runDirectory),
      path.join(targetRepository, '.playwright-cli', 'testgen'),
    );
  });
});

test('does not govern unrelated agents', () => {
  withTargetRepository(({ targetRepository }) => {
    const result = runHook(targetRepository, 'git status', 'code-reviewer');

    assert.deepEqual(result, {});
  });
});

test('denies agent edits to the run command policy', () => {
  withTargetRepository(({ runDirectory, targetRepository }) => {
    const policyPath = path.join(runDirectory, 'command-policy.json');
    const result = runToolHook(targetRepository, 'Edit', {
      file_path: policyPath,
      new_string: 'https://example.com',
      old_string: 'http://127.0.0.1:3000',
      replace_all: false,
    });

    assert.equal(result.permissionDecision, 'deny');
    assert.match(
      result.permissionDecisionReason,
      /return the update to Main/iu,
    );
  });
});

test('denies governed agents from writing the run change manifest', () => {
  withTargetRepository(({ runDirectory, targetRepository }) => {
    const manifestPath = path.join(runDirectory, 'change-manifest.json');
    writeFileSync(manifestPath, '{}');

    for (const agentType of [
      'playwright-test-author',
      'playwright-test-healer',
    ]) {
      const result = runToolHook(
        targetRepository,
        'Write',
        { content: '{}', file_path: manifestPath },
        agentType,
      );

      assert.equal(result.permissionDecision, 'deny');
      assert.match(result.permissionDecisionReason, /Main-owned/iu);
    }

    const aliasPath = path.join(targetRepository, 'manifest-link.json');
    linkSync(manifestPath, aliasPath);
    const aliasResult = runToolHook(targetRepository, 'Edit', {
      file_path: aliasPath,
      new_string: 'changed',
      old_string: '{}',
      replace_all: false,
    });
    assert.equal(aliasResult.permissionDecision, 'deny');
    assert.match(aliasResult.permissionDecisionReason, /Main-owned/iu);
  });
});

test('denies governed agents from writing Main-owned result files', () => {
  withTargetRepository(({ runDirectory, targetRepository }) => {
    for (const filename of ['mutation-recovery.json', 'vacuity-report.json']) {
      const reportPath = path.join(runDirectory, filename);
      writeFileSync(reportPath, '{}');
      for (const agentType of [
        'playwright-test-author',
        'playwright-test-healer',
      ]) {
        const result = runToolHook(
          targetRepository,
          'Write',
          { content: '{}', file_path: reportPath },
          agentType,
        );

        assert.equal(result.permissionDecision, 'deny');
        assert.match(result.permissionDecisionReason, /Main-owned/iu);
      }
    }
  });
});

test(
  'protects owned policy paths with Windows case-insensitive spelling',
  { skip: process.platform !== 'win32' },
  () => {
    withTargetRepository(({ runDirectory, targetRepository }) => {
      const result = runToolHook(targetRepository, 'Edit', {
        file_path: path.join(runDirectory, 'command-policy.json').toUpperCase(),
        new_string: 'https://example.com',
        old_string: 'http://127.0.0.1:3000',
        replace_all: false,
      });

      assert.equal(result.permissionDecision, 'deny');
      assert.match(result.permissionDecisionReason, /immutable to Author/iu);
    });
  },
);

test('denies agent-created Playwright CLI configuration in run scratch', () => {
  withTargetRepository(({ runDirectory, targetRepository }) => {
    const configPath = path.join(
      runDirectory,
      '.playwright',
      'cli.config.json',
    );
    const result = runToolHook(targetRepository, 'Write', {
      content: '{}',
      file_path: configPath,
    });

    assert.equal(result.permissionDecision, 'deny');
    assert.match(result.permissionDecisionReason, /CLI configuration/iu);
  });
});

test('keeps approved storage state opaque to governed agents', () => {
  withTargetRepository(({ runDirectory, targetRepository }) => {
    const stateDirectory = path.join(targetRepository, 'playwright', '.auth');
    const statePath = path.join(stateDirectory, 'user.json');
    mkdirSync(stateDirectory, { recursive: true });
    writeFileSync(statePath, '{}');
    writeFileSync(
      path.join(runDirectory, 'command-policy.json'),
      JSON.stringify({
        approved_spec: 'tests/account.spec.ts',
        allowed_runner_options: [],
        allowed_state_paths: ['../../../playwright/.auth/user.json'],
        allowed_write_paths: [],
        format_version: 1,
        run_id: runId,
        allowed_origins: ['http://127.0.0.1:3000'],
      }),
    );

    for (const [toolName, toolInput] of [
      ['Read', { file_path: statePath }],
      [
        'Edit',
        {
          file_path: statePath,
          new_string: '{}',
          old_string: '{}',
          replace_all: false,
        },
      ],
    ]) {
      const result = runToolHook(targetRepository, toolName, toolInput);
      assert.equal(result.permissionDecision, 'deny');
      assert.match(
        result.permissionDecisionReason,
        /storage state is opaque/iu,
      );
    }

    const outsideCwd = runToolHook(path.dirname(targetRepository), 'Read', {
      file_path: statePath,
    });
    assert.equal(outsideCwd.permissionDecision, 'deny');
    assert.match(
      outsideCwd.permissionDecisionReason,
      /storage state is opaque/iu,
    );

    const linkedStatePath = path.join(targetRepository, 'tests', 'state.json');
    linkSync(statePath, linkedStatePath);
    const hardLink = runToolHook(targetRepository, 'Read', {
      file_path: linkedStatePath,
    });
    assert.equal(hardLink.permissionDecision, 'deny');
    assert.match(
      hardLink.permissionDecisionReason,
      /storage state is opaque/iu,
    );
  });
});

test('keeps approved storage state outside Grep search roots', () => {
  withTargetRepository(({ runDirectory, targetRepository }) => {
    const stateDirectory = path.join(targetRepository, 'playwright', '.auth');
    const statePath = path.join(stateDirectory, 'user.json');
    mkdirSync(stateDirectory, { recursive: true });
    writeFileSync(statePath, '{}');
    writeFileSync(
      path.join(runDirectory, 'command-policy.json'),
      JSON.stringify({
        approved_spec: 'tests/account.spec.ts',
        allowed_runner_options: [],
        allowed_state_paths: ['../../../playwright/.auth/user.json'],
        allowed_write_paths: [],
        format_version: 1,
        run_id: runId,
        allowed_origins: ['http://127.0.0.1:3000'],
      }),
    );

    const broadSearch = runToolHook(targetRepository, 'Grep', {
      output_mode: 'content',
      path: targetRepository,
      pattern: 'cookies',
    });
    assert.equal(broadSearch.permissionDecision, 'deny');
    assert.match(broadSearch.permissionDecisionReason, /scope Grep/iu);

    const outsideCwd = runToolHook(path.dirname(targetRepository), 'Grep', {
      output_mode: 'content',
      path: targetRepository,
      pattern: 'cookies',
    });
    assert.equal(outsideCwd.permissionDecision, 'deny');
    assert.match(outsideCwd.permissionDecisionReason, /scope Grep/iu);

    const parentSearch = runToolHook(path.dirname(targetRepository), 'Grep', {
      output_mode: 'content',
      path: path.dirname(targetRepository),
      pattern: 'cookies',
    });
    assert.equal(parentSearch.permissionDecision, 'deny');
    assert.match(parentSearch.permissionDecisionReason, /scope Grep/iu);

    assert.deepEqual(
      runToolHook(targetRepository, 'Grep', {
        output_mode: 'content',
        path: path.join(targetRepository, 'tests'),
        pattern: 'test',
      }),
      {},
    );

    const linkedStatePath = path.join(targetRepository, 'tests', 'state.json');
    linkSync(statePath, linkedStatePath);
    const hardLink = runToolHook(targetRepository, 'Grep', {
      output_mode: 'content',
      path: linkedStatePath,
      pattern: 'cookies',
    });
    assert.equal(hardLink.permissionDecision, 'deny');
    assert.match(
      hardLink.permissionDecisionReason,
      /storage state is opaque/iu,
    );

    const hardLinkDirectory = runToolHook(targetRepository, 'Grep', {
      output_mode: 'content',
      path: path.join(targetRepository, 'tests'),
      pattern: 'cookies',
    });
    assert.equal(hardLinkDirectory.permissionDecision, 'deny');
    assert.match(
      hardLinkDirectory.permissionDecisionReason,
      /storage state is opaque/iu,
    );
  });
});

test('denies run ownership through a repository junction or symlink', () => {
  const targetRepository = mkdtempSync(path.join(tmpdir(), 'testgen-hook-'));
  const outside = mkdtempSync(path.join(tmpdir(), 'testgen-outside-'));
  const linkedRoot = path.join(targetRepository, '.playwright-cli');
  const runDirectory = path.join(outside, 'testgen', runId);
  mkdirSync(runDirectory, { recursive: true });
  writeFileSync(
    path.join(runDirectory, 'command-policy.json'),
    JSON.stringify({
      approved_spec: 'tests/account.spec.ts',
      allowed_runner_options: [],
      allowed_state_paths: [],
      allowed_write_paths: [],
      format_version: 1,
      run_id: runId,
      allowed_origins: ['http://127.0.0.1:3000'],
    }),
  );
  symlinkSync(outside, linkedRoot, 'junction');

  try {
    const policyPath = path.join(
      linkedRoot,
      'testgen',
      runId,
      'command-policy.json',
    );
    assert.equal(
      runToolHook(targetRepository, 'Edit', {
        file_path: policyPath,
        new_string: 'https://example.com',
        old_string: 'http://127.0.0.1:3000',
        replace_all: false,
      }).permissionDecision,
      'deny',
    );
    assert.equal(
      runHook(targetRepository, `rm -rf -- .playwright-cli/testgen/${runId}`)
        .permissionDecision,
      'deny',
    );
  } finally {
    rmSync(linkedRoot, { force: true });
    rmSync(targetRepository, { force: true, recursive: true });
    rmSync(outside, { force: true, recursive: true });
  }
});

test('rejects absolute or directory storage-state policy entries', () => {
  withTargetRepository(({ runDirectory, targetRepository }) => {
    const stateDirectory = path.join(targetRepository, 'playwright', '.auth');
    mkdirSync(stateDirectory, { recursive: true });

    for (const statePath of [
      '../../../playwright/.auth',
      path.resolve(stateDirectory),
    ]) {
      writeFileSync(
        path.join(runDirectory, 'command-policy.json'),
        JSON.stringify({
          approved_spec: 'tests/account.spec.ts',
          allowed_runner_options: [],
          allowed_state_paths: [statePath],
          allowed_write_paths: [],
          format_version: 1,
          run_id: runId,
          allowed_origins: ['http://127.0.0.1:3000'],
        }),
      );

      assert.equal(
        runCliHook(targetRepository, `-s=${runId} state-load ${statePath}`)
          .permissionDecision,
        'deny',
      );
    }
  });
});

test('asks before running a declared script through a supported package manager', () => {
  withTargetRepository(({ targetRepository }) => {
    for (const manager of ['npm', 'yarn', 'pnpm', 'bun']) {
      const result = runHook(
        targetRepository,
        `${manager} run lint -- tests/account.spec.ts`,
      );

      assert.equal(result.permissionDecision, 'ask', manager);
      assert.match(
        result.permissionDecisionReason,
        /Approve this repository's validation script/iu,
      );
      assert.match(result.permissionDecisionReason, /Choose Yes only if/iu);
    }
  });
});

test('denies package-manager commands that do not name a declared script', () => {
  withTargetRepository(({ targetRepository }) => {
    for (const command of [
      'npm run missing',
      'yarn run missing',
      'pnpm run missing',
      'bun run tests/account.spec.ts',
    ]) {
      const result = runHook(targetRepository, command);

      assert.equal(result.permissionDecision, 'deny', command);
      assert.match(result.permissionDecisionReason, /declared package.json/iu);
    }
  });
});

test('denies package-manager shortcuts and non-script commands', () => {
  withTargetRepository(({ targetRepository }) => {
    for (const command of [
      'npm test',
      'yarn lint',
      'pnpm lint',
      'bun lint',
      'yarn exec lint',
      'pnpm exec lint',
      'bun install',
      'PLAYWRIGHT_HTML_OPEN=never npm run lint',
    ]) {
      assert.equal(
        runHook(targetRepository, command).permissionDecision,
        'deny',
        command,
      );
    }
  });
});

test('denies package-manager options that can redirect script execution', () => {
  withTargetRepository(({ targetRepository }) => {
    writeFileSync(
      path.join(targetRepository, 'package.json'),
      JSON.stringify({
        scripts: {
          '--filter': 'playwright test --list',
          lint: 'eslint .',
        },
      }),
    );

    for (const command of [
      'npm run lint --workspace=app',
      'npm run lint --workspaces',
      'npm run lint -w app',
      'yarn run --filter app lint',
      'pnpm run --filter app lint',
      'bun run --filter app lint',
    ]) {
      assert.equal(
        runHook(targetRepository, command).permissionDecision,
        'deny',
        command,
      );
    }
  });
});

test('denies package scripts when package.json cannot be trusted', () => {
  withTargetRepository(({ targetRepository }) => {
    const packagePath = path.join(targetRepository, 'package.json');

    rmSync(packagePath);
    assert.equal(
      runHook(targetRepository, 'npm run lint').permissionDecision,
      'deny',
    );

    writeFileSync(packagePath, '{');
    assert.equal(
      runHook(targetRepository, 'yarn run lint').permissionDecision,
      'deny',
    );

    writeFileSync(packagePath, JSON.stringify({ scripts: [] }));
    assert.equal(
      runHook(targetRepository, 'bun run lint').permissionDecision,
      'deny',
    );

    writeFileSync(packagePath, JSON.stringify({ scripts: { lint: '  ' } }));
    assert.equal(
      runHook(targetRepository, 'pnpm run lint').permissionDecision,
      'deny',
    );
  });
});

test('denies validation scripts outside the repository root', () => {
  withTargetRepository(({ runDirectory, targetRepository }) => {
    for (const cwd of [path.join(targetRepository, 'tests'), runDirectory]) {
      const result = runHook(cwd, 'npm run lint -- tests/account.spec.ts');

      assert.equal(result.permissionDecision, 'deny');
      assert.match(result.permissionDecisionReason, /repository root/iu);
    }
  });
});

test('allows only the canonical read-only package preflight', () => {
  withTargetRepository(({ targetRepository }) => {
    const documentedPreflights = readFileSync(
      path.join(repositoryRoot, 'skills', 'playwright-testgen', 'SKILL.md'),
      'utf8',
    ).match(/^node -e ".+"$/gmu);

    assert.equal(documentedPreflights?.length, 1);
    const [preflight] = documentedPreflights;

    assert.equal(
      runHook(targetRepository, preflight).permissionDecision,
      'allow',
    );
    assert.equal(
      runHook(
        targetRepository,
        preflight.replace(
          'require.resolve(id)',
          "require.resolve(id); require('node:fs')",
        ),
      ).permissionDecision,
      'deny',
    );
  });
});

test('denies an unapproved executable and names the global CLI alternative', () => {
  withTargetRepository(({ targetRepository }) => {
    const result = runHook(
      targetRepository,
      `npx playwright-cli -s=${runId} snapshot`,
    );

    assert.equal(result.permissionDecision, 'deny');
    assert.match(
      result.permissionDecisionReason,
      /use playwright-cli directly/iu,
    );
  });
});

test('allows only the matching role to validate its exact run artifact', () => {
  withTargetRepository(({ targetRepository }) => {
    const pluginRoot = repositoryRoot;
    const validator =
      '"$PLAYWRIGHT_TESTGEN_ROOT/scripts/validate-testgen-artifact.cjs"';
    const command = `node ${validator} --repo . --type handoff --run-id ${runId} .playwright-cli/testgen/${runId}/handoff.json`;
    const allowed = runToolHook(
      targetRepository,
      'Bash',
      { command },
      'playwright-test-author',
      {
        CLAUDE_PLUGIN_ROOT: pluginRoot,
        PLAYWRIGHT_TESTGEN_ROOT: pluginRoot,
      },
    );

    assert.equal(allowed.permissionDecision, 'allow');

    const healerCommand = `node ${validator} --repo . --type trace --run-id ${runId} .playwright-cli/testgen/${runId}/healer-trace.json`;
    const healerAllowed = runToolHook(
      targetRepository,
      'Bash',
      { command: healerCommand },
      'playwright-test-healer',
      {
        CLAUDE_PLUGIN_ROOT: pluginRoot,
        PLAYWRIGHT_TESTGEN_ROOT: pluginRoot,
      },
    );

    assert.equal(healerAllowed.permissionDecision, 'allow');

    for (const absoluteValidator of [
      path.join(repositoryRoot, 'scripts', 'validate-testgen-artifact.cjs'),
      path
        .join(repositoryRoot, 'scripts', 'validate-testgen-artifact.cjs')
        .replaceAll('\\', '/'),
    ]) {
      const substituted = runToolHook(
        targetRepository,
        'Bash',
        {
          command: `node "${absoluteValidator}" --repo . --type handoff --run-id ${runId} .playwright-cli/testgen/${runId}/handoff.json`,
        },
        'playwright-test-author',
        { CLAUDE_PLUGIN_ROOT: pluginRoot },
      );

      assert.equal(substituted.permissionDecision, 'allow');
    }
  });
});

test('rejects the unavailable Claude plugin root in governed Bash commands', () => {
  withTargetRepository(({ targetRepository }) => {
    const command = `node "$CLAUDE_PLUGIN_ROOT/scripts/validate-testgen-artifact.cjs" --repo . --type handoff --run-id ${runId} .playwright-cli/testgen/${runId}/handoff.json`;
    const result = runToolHook(
      targetRepository,
      'Bash',
      { command },
      'playwright-test-author',
      { CLAUDE_PLUGIN_ROOT: repositoryRoot },
    );

    assert.equal(result.permissionDecision, 'deny');
    assert.match(result.permissionDecisionReason, /PLAYWRIGHT_TESTGEN_ROOT/u);
  });
});

test('denies validator role or artifact-type mismatches', () => {
  withTargetRepository(({ targetRepository }) => {
    const validator =
      '"$PLAYWRIGHT_TESTGEN_ROOT/scripts/validate-testgen-artifact.cjs"';
    for (const [agentType, type, filename] of [
      ['playwright-test-author', 'trace', 'healer-trace.json'],
      ['playwright-test-healer', 'handoff', 'handoff.json'],
    ]) {
      const result = runToolHook(
        targetRepository,
        'Bash',
        {
          command: `node ${validator} --repo . --type ${type} --run-id ${runId} .playwright-cli/testgen/${runId}/${filename}`,
        },
        agentType,
        {
          CLAUDE_PLUGIN_ROOT: repositoryRoot,
          PLAYWRIGHT_TESTGEN_ROOT: repositoryRoot,
        },
      );

      assert.equal(result.permissionDecision, 'deny');
      assert.match(result.permissionDecisionReason, /artifact type/iu);
    }
  });
});

test('denies arbitrary Node commands for governed roles', () => {
  withTargetRepository(({ targetRepository }) => {
    const result = runHook(targetRepository, 'node -e "process.exit(0)"');

    assert.equal(result.permissionDecision, 'deny');
    assert.match(
      result.permissionDecisionReason,
      /plugin artifact validator/iu,
    );
  });
});

test('rejects plugin-root probes with the direct-use recovery', () => {
  withTargetRepository(({ targetRepository }) => {
    for (const command of [
      'echo "$PLAYWRIGHT_TESTGEN_ROOT"',
      'node -e "console.log(process.env.PLAYWRIGHT_TESTGEN_ROOT)"',
      `cd .playwright-cli/testgen/${runId} && PWTEST_CLI_GLOBAL_CONFIG=. playwright-cli -s=${runId} find '$PLAYWRIGHT_TESTGEN_ROOT/scripts/validate-testgen-artifact.cjs'`,
    ]) {
      const result = runHook(targetRepository, command);
      assert.equal(result.permissionDecision, 'deny');
      assert.match(
        result.permissionDecisionReason,
        /already exported.*do not.*probe/iu,
      );
    }
  });
});

test('binds artifact mutations to the role that owns each artifact', () => {
  withTargetRepository(({ runDirectory, targetRepository }) => {
    const handoffPath = path.join(runDirectory, 'handoff.json');
    const tracePath = path.join(runDirectory, 'healer-trace.json');
    writeFileSync(handoffPath, '{}');
    writeFileSync(tracePath, '{}');

    for (const [agentType, filePath] of [
      ['playwright-test-healer', handoffPath],
      ['playwright-test-author', tracePath],
    ]) {
      const result = runToolHook(
        targetRepository,
        'Edit',
        { file_path: filePath },
        agentType,
      );

      assert.equal(result.permissionDecision, 'deny');
      assert.match(result.permissionDecisionReason, /role-owned artifact/iu);
    }

    assert.equal(
      runToolHook(
        targetRepository,
        'Read',
        { file_path: tracePath },
        'playwright-test-healer',
      ).permissionDecision,
      'allow',
    );
    assert.equal(
      runToolHook(
        targetRepository,
        'Write',
        { file_path: handoffPath },
        'playwright-test-author',
      ).permissionDecision,
      'allow',
    );
    assert.equal(
      runToolHook(
        targetRepository,
        'Write',
        {
          file_path: tracePath,
          content: '{"schema_version":"healer-trace.v1"}',
        },
        'playwright-test-healer',
      ).permissionDecision,
      'allow',
    );
    writeFileSync(tracePath, '{}');
    const traceEdit = runToolHook(
      targetRepository,
      'Edit',
      {
        file_path: tracePath,
        old_string: '{}',
        new_string: '{"schema_version":"healer-trace.v1"}',
      },
      'playwright-test-healer',
    );
    assert.equal(traceEdit.permissionDecision, 'deny');
    assert.match(traceEdit.permissionDecisionReason, /whole-file Write/iu);

    const emptyTraceWrite = runToolHook(
      targetRepository,
      'Write',
      { file_path: tracePath, content: '' },
      'playwright-test-healer',
    );
    assert.equal(emptyTraceWrite.permissionDecision, 'deny');
    assert.match(
      emptyTraceWrite.permissionDecisionReason,
      /complete artifact/iu,
    );

    const rejectedTrace = '{"schema_version":"bad"}';
    writeFileSync(tracePath, rejectedTrace);
    assert.equal(
      runToolHook(
        targetRepository,
        'Write',
        {
          file_path: tracePath,
          content: '{"schema_version":"healer-trace.v1"}',
        },
        'playwright-test-healer',
      ).permissionDecision,
      'allow',
    );

    rmSync(tracePath);
    const missingTraceWrite = runToolHook(
      targetRepository,
      'Write',
      {
        file_path: tracePath,
        content: '{"schema_version":"healer-trace.v1"}',
      },
      'playwright-test-healer',
    );
    assert.equal(missingTraceWrite.permissionDecision, 'deny');
    assert.match(missingTraceWrite.permissionDecisionReason, /unavailable/iu);
  });
});

test('allows only canonical installed-plugin reads required by governed agents', () => {
  withTargetRepository(({ targetRepository }) => {
    const pluginRoot = mkdtempSync(path.join(tmpdir(), 'testgen-plugin-'));
    try {
      const skillRoot = path.join(pluginRoot, 'skills', 'playwright-testgen');
      const schemaRoot = path.join(pluginRoot, 'schemas');
      const scriptRoot = path.join(pluginRoot, 'scripts');
      mkdirSync(skillRoot, { recursive: true });
      mkdirSync(schemaRoot);
      mkdirSync(scriptRoot);

      const approvedPaths = [
        path.join(skillRoot, 'SKILL.md'),
        path.join(schemaRoot, 'healer-trace.v1.schema.json'),
        path.join(scriptRoot, 'validate-testgen-artifact.cjs'),
      ];
      for (const approvedPath of approvedPaths) {
        writeFileSync(approvedPath, '{}');
        assert.equal(
          runToolHook(
            targetRepository,
            'Read',
            { file_path: approvedPath },
            'playwright-test-healer',
            { CLAUDE_PLUGIN_ROOT: pluginRoot },
          ).permissionDecision,
          'allow',
        );
      }

      const unrelatedPath = path.join(pluginRoot, 'README.md');
      writeFileSync(unrelatedPath, 'unrelated');
      assert.deepEqual(
        runToolHook(
          targetRepository,
          'Read',
          { file_path: unrelatedPath },
          'playwright-test-healer',
          { CLAUDE_PLUGIN_ROOT: pluginRoot },
        ),
        {},
      );

      const escapingPath = path.join(skillRoot, 'escape.md');
      symlinkSync(unrelatedPath, escapingPath, 'file');
      const escaped = runToolHook(
        targetRepository,
        'Read',
        { file_path: escapingPath },
        'playwright-test-healer',
        { CLAUDE_PLUGIN_ROOT: pluginRoot },
      );
      assert.equal(escaped.permissionDecision, 'deny');
      assert.match(escaped.permissionDecisionReason, /escapes/iu);
    } finally {
      rmSync(pluginRoot, { force: true, recursive: true });
    }
  });
});

test('derives the installed plugin root when Claude does not export it', () => {
  withTargetRepository(({ targetRepository }) => {
    const result = runToolHook(
      targetRepository,
      'Read',
      {
        file_path: path.join(
          repositoryRoot,
          'skills',
          'playwright-testgen',
          'references',
          'healing-protocol.md',
        ),
      },
      'playwright-test-healer',
      { CLAUDE_PLUGIN_ROOT: '' },
    );

    assert.equal(result.permissionDecision, 'allow');
  });
});

test('allows Healer to read only its exact run-bound inputs', () => {
  withTargetRepository(({ runDirectory, targetRepository }) => {
    const specPath = path.join(targetRepository, 'tests', 'account.spec.ts');
    const handoffPath = path.join(runDirectory, 'handoff.json');
    const tracePath = path.join(runDirectory, 'healer-trace.json');
    writeFileSync(handoffPath, '{}');
    writeFileSync(tracePath, '{}');

    for (const filePath of [specPath, handoffPath, tracePath]) {
      assert.equal(
        runToolHook(
          targetRepository,
          'Read',
          { file_path: filePath },
          'playwright-testgen:playwright-test-healer',
        ).permissionDecision,
        'allow',
      );
    }

    const unrelatedPath = path.join(targetRepository, 'package.json');
    assert.deepEqual(
      runToolHook(
        targetRepository,
        'Read',
        { file_path: unrelatedPath },
        'playwright-test-healer',
      ),
      {},
    );
  });
});

test('rejects non-regular and oversized trace drafts before reading', () => {
  withTargetRepository(({ runDirectory, targetRepository }) => {
    const tracePath = path.join(runDirectory, 'healer-trace.json');
    const write = {
      file_path: tracePath,
      content: '{"schema_version":"healer-trace.v1"}',
    };

    writeFileSync(tracePath, 'x'.repeat(64 * 1024 + 1));
    let result = runToolHook(
      targetRepository,
      'Write',
      write,
      'playwright-test-healer',
    );
    assert.equal(result.permissionDecision, 'deny');
    assert.match(result.permissionDecisionReason, /regular file.*64 KiB/iu);

    rmSync(tracePath);
    mkdirSync(tracePath);
    result = runToolHook(
      targetRepository,
      'Write',
      write,
      'playwright-test-healer',
    );
    assert.equal(result.permissionDecision, 'deny');
    assert.match(result.permissionDecisionReason, /regular file.*64 KiB/iu);
  });
});

test('limits governed file mutations to explicitly approved paths', () => {
  withTargetRepository(({ runDirectory, targetRepository }) => {
    const helperPath = path.join(targetRepository, 'tests', 'selectors.ts');
    const packagePath = path.join(targetRepository, 'package.json');
    writeFileSync(helperPath, 'export const account = "account";\n');
    writeFileSync(packagePath, '{}\n');
    updatePolicy(runDirectory, {
      allowed_write_paths: ['tests/selectors.ts'],
    });

    assert.equal(
      runToolHook(targetRepository, 'Edit', { file_path: helperPath })
        .permissionDecision,
      'allow',
    );
    assert.equal(
      runToolHook(targetRepository, 'Edit', {
        file_path: path.join(targetRepository, 'tests', 'account.spec.ts'),
      }).permissionDecision,
      'allow',
    );

    const denied = runToolHook(targetRepository, 'Write', {
      file_path: packagePath,
    });
    assert.equal(denied.permissionDecision, 'deny');
    assert.match(denied.permissionDecisionReason, /approved write path/iu);
  });
});

test('fails closed when a discovered run policy is invalid', () => {
  withTargetRepository(({ runDirectory, targetRepository }) => {
    const packagePath = path.join(targetRepository, 'package.json');
    writeFileSync(packagePath, '{}\n');
    writeFileSync(path.join(runDirectory, 'command-policy.json'), '{');

    const denied = runToolHook(targetRepository, 'Edit', {
      file_path: packagePath,
    });
    assert.equal(denied.permissionDecision, 'deny');
    assert.match(denied.permissionDecisionReason, /policy.*invalid/iu);

    assert.equal(
      runToolHook(
        targetRepository,
        'Read',
        {
          file_path: path.join(
            repositoryRoot,
            'skills',
            'playwright-testgen',
            'SKILL.md',
          ),
        },
        'playwright-test-author',
        { CLAUDE_PLUGIN_ROOT: repositoryRoot },
      ).permissionDecision,
      'allow',
    );
  });
});

const assert = require('node:assert/strict');
const {
  mkdirSync,
  mkdtempSync,
  linkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const repositoryRoot = path.resolve(__dirname, '..');
const hookPath = path.join(repositoryRoot, 'hooks', 'validate-bash.cjs');
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
  writeFileSync(path.join(targetRepository, 'tests', 'account.spec.ts'), '');
  writeFileSync(
    path.join(runDirectory, 'command-policy.json'),
    JSON.stringify({
      approved_spec: 'tests/account.spec.ts',
      allowed_runner_options: [],
      allowed_state_paths: [],
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

function runCliHook(cwd, command, agentType = 'playwright-test-author') {
  return runHook(
    cwd,
    `cd .playwright-cli/testgen/${runId} && PWTEST_CLI_GLOBAL_CONFIG=. npm exec --no -- playwright-cli ${command}`,
    agentType,
  );
}

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
          `cd .playwright-cli/testgen/${runId} && PWTEST_CLI_GLOBAL_CONFIG=. npm exec --no -- playwright-cli -s=${runId} click ${selector}`,
        ).permissionDecision,
        'allow',
      );
    }
  });
});

test('allows required snapshot search and navigation commands', () => {
  withTargetRepository(({ targetRepository }) => {
    for (const command of [
      `npm exec --no -- playwright-cli -s=${runId} find 'Add to cart'`,
      `npm exec --no -- playwright-cli -s=${runId} go-forward`,
    ]) {
      assert.equal(
        runCliHook(
          targetRepository,
          command.replace('npm exec --no -- playwright-cli ', ''),
        ).permissionDecision,
        'allow',
      );
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
      `npm exec --no -- playwright-cli -s=${runId} click foo\nid`,
      `npm exec --no -- playwright-cli -s=${runId} click \`id\``,
      `PLAYWRIGHT_HTML_OPEN=never npm exec --no -- playwright test tests/{account,admin}.spec.ts --retries=0 --repeat-each=1 --output=.playwright-cli/testgen/${runId}/attempt-1/test-results`,
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
      `cd .playwright-cli/testgen/${runId} && npm exec --no -- playwright trace open ~/outside.zip`,
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
      `PWTEST_CLI_GLOBAL_CONFIG=. npm exec --no -- playwright-cli -s=${runId} snapshot`,
      `cd .playwright-cli/testgen/${runId} && npm exec --no -- playwright-cli -s=${runId} snapshot`,
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
        command: `PLAYWRIGHT_HTML_OPEN=never npm exec --no -- playwright test tests/account.spec.ts --debug=cli --retries=0 --repeat-each=1 --output=${output}`,
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
      `PLAYWRIGHT_HTML_OPEN=never npm exec --no -- playwright test tests/account.spec.ts --debug=cli --retries=0 --repeat-each=1 --output=${output}`,
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
        command: `PLAYWRIGHT_HTML_OPEN=never npm exec --no -- playwright test tests/account.spec.ts --retries=0 --repeat-each=1 --output=${output}`,
        run_in_background: true,
      },
      'playwright-test-healer',
    );

    assert.equal(result.permissionDecision, 'deny');
    assert.match(result.permissionDecisionReason, /foreground/iu);
  });
});

test('denies unsandboxed governed Bash commands', () => {
  withTargetRepository(({ targetRepository }) => {
    const result = runToolHook(targetRepository, 'Bash', {
      command: `cd .playwright-cli/testgen/${runId} && PWTEST_CLI_GLOBAL_CONFIG=. npm exec --no -- playwright-cli -s=${runId} snapshot`,
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
          command: `cd .playwright-cli/testgen/${runId} && PWTEST_CLI_GLOBAL_CONFIG=. npm exec --no -- playwright-cli -s=${runId} snapshot`,
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
        command: `PLAYWRIGHT_HTML_OPEN=never npm exec --no -- playwright test tests/account.spec.ts --debug=cli --retries=0 --repeat-each=1 --output=${output}`,
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
      command: `PLAYWRIGHT_HTML_OPEN=never npm exec --no -- playwright test tests/account.spec.ts --debug=cli --retries=0 --repeat-each=1 --output=${output}`,
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
      `PLAYWRIGHT_HTML_OPEN=never npm exec --no -- playwright test tests/account.spec.ts --retries=0 --repeat-each=1 --output=${output}`,
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
      `PLAYWRIGHT_HTML_OPEN=never npm exec --no -- playwright test tests/account.spec.ts --retries=0 --repeat-each=1 --output=${output}`,
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
        `PLAYWRIGHT_HTML_OPEN=never npm exec --no -- playwright test tests/account.spec.ts --retries=0 --repeat-each=1 --output=${output}`,
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
      `PLAYWRIGHT_HTML_OPEN=never npm exec --no -- playwright test tests/account.spec.ts tests/admin.spec.ts --retries=0 --repeat-each=1 --output=${output}`,
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
      `PLAYWRIGHT_HTML_OPEN=never npm exec --no -- playwright test tests/admin.spec.ts --retries=0 --repeat-each=1 --output=${output}`,
      `PLAYWRIGHT_HTML_OPEN=never npm exec --no -- playwright test tests/account.spec.ts --update-snapshots=all --retries=0 --repeat-each=1 --output=${output}`,
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
        command: `PLAYWRIGHT_HTML_OPEN=never npm exec --no -- playwright test tests --debug=cli --retries=0 --repeat-each=1 --output=${output}`,
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
      `${enterRun} npm exec --no -- playwright trace open attempt-1/test-results/trace.zip`,
      `${enterRun} npm exec --no -- playwright trace actions --grep=expect`,
      `${enterRun} npm exec --no -- playwright trace action 9`,
      `${enterRun} npm exec --no -- playwright trace snapshot 9 --name after`,
      `${enterRun} npm exec --no -- playwright trace close`,
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

test('allows removal of only the exact run directory', () => {
  withTargetRepository(({ targetRepository }) => {
    const exactRun = `.playwright-cli/testgen/${runId}`;
    assert.equal(
      runHook(targetRepository, `rm -rf -- ${exactRun}`).permissionDecision,
      'allow',
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

test('asks before running a target repository script', () => {
  withTargetRepository(({ targetRepository }) => {
    const result = runHook(
      targetRepository,
      'npm run lint -- tests/account.spec.ts',
    );

    assert.equal(result.permissionDecision, 'ask');
    assert.match(
      result.permissionDecisionReason,
      /target repository's existing scoped lint or formatter/iu,
    );
  });
});

test('denies an unapproved executable and names the local npm alternative', () => {
  withTargetRepository(({ targetRepository }) => {
    const result = runHook(
      targetRepository,
      `npx playwright-cli -s=${runId} snapshot`,
    );

    assert.equal(result.permissionDecision, 'deny');
    assert.match(
      result.permissionDecisionReason,
      /use npm exec --no -- playwright-cli/iu,
    );
  });
});

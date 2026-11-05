const assert = require('node:assert/strict');
const {
  cpSync,
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
const { validateCommand } = require('../hooks/validate-command.cjs');

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
      package_directory: '.',
      run_id: runId,
      allowed_origins: ['http://127.0.0.1:3000'],
      trace_snapshot_option: '--name',
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
  toolUseId,
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
      tool_use_id: toolUseId,
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

// Policy matrices use the API; runToolHook retains process and audit coverage.
function runHook(cwd, command, agentType = 'playwright-test-author') {
  return validateCommand({
    agent_type: agentType,
    cwd,
    tool_input: { command },
    tool_name: 'Bash',
  }).hookSpecificOutput;
}

function exactSpecFilter(repository, relative = 'tests/account.spec.ts') {
  const absolute = path.resolve(repository, relative).replaceAll('\\', '/');
  const escaped = absolute.replace(/[\\^$.*+?()[\]{}|/]/gu, '\\$&');
  const flags = process.platform === 'win32' ? 'i' : '';
  return `/^${escaped}$/${flags}`;
}

function runnerCommand(repository, output, options = '') {
  const filter = exactSpecFilter(repository);
  return `PLAYWRIGHT_HTML_OPEN=never npx --no playwright test '${filter}' ${options}--retries=0 --repeat-each=1 --output='${output}'`;
}

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
  assert.match(output.permissionDecisionReason, /hook input is invalid/iu);
});

test('fails closed when the hook runtime cannot load', () => {
  const temporaryRoot = mkdtempSync(path.join(tmpdir(), 'testgen-hook-load-'));
  const temporaryHook = path.join(temporaryRoot, 'hooks', 'validate-bash.cjs');
  try {
    cpSync(path.join(repositoryRoot, 'hooks'), path.dirname(temporaryHook), {
      recursive: true,
    });
    const started = Date.now();
    const result = spawnSync(process.execPath, [temporaryHook], {
      cwd: temporaryRoot,
      encoding: 'utf8',
      input: JSON.stringify({
        agent_type: 'playwright-test-healer',
        cwd: temporaryRoot,
        hook_event_name: 'PreToolUse',
        tool_input: { command: 'node --version' },
        tool_name: 'Bash',
      }),
    });

    assert.equal(result.status, 2);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /hook validation could not start/iu);
    assert.ok(Buffer.byteLength(result.stderr, 'utf8') < 512);
    assert.ok(Date.now() - started < 4000);

    const mainResult = spawnSync(process.execPath, [temporaryHook], {
      cwd: temporaryRoot,
      encoding: 'utf8',
      input: JSON.stringify({
        cwd: temporaryRoot,
        hook_event_name: 'PreToolUse',
        tool_input: { command: 'node --version' },
        tool_name: 'Bash',
      }),
    });
    assert.equal(mainResult.status, 0, mainResult.stderr);
    assert.deepEqual(JSON.parse(mainResult.stdout), {});
  } finally {
    rmSync(temporaryRoot, { force: true, recursive: true });
  }
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
    const result = runToolHook(targetRepository, 'Bash', {
      command: `cd .playwright-cli/testgen/${runId} && PWTEST_CLI_GLOBAL_CONFIG=. playwright-cli -s=${runId} snapshot`,
    });

    assert.equal(result.permissionDecision, 'allow');
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
    const result = runToolHook(targetRepository, 'Bash', {
      command: `npx --no playwright test '${filter}' --list`,
    });

    assert.equal(result.permissionDecision, 'allow');
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

function withTargetRepository(callback) {
  const target = createTargetRepository();
  try {
    callback(target);
  } finally {
    rmSync(target.targetRepository, { force: true, recursive: true });
  }
}

function writeDiscoveryPolicy(runDirectory, values = {}) {
  writeFileSync(
    path.join(runDirectory, 'command-policy.json'),
    JSON.stringify({
      allowed_browser_actions: [],
      allowed_origins: ['http://127.0.0.1:3000'],
      allowed_state_paths: [],
      discovery_id: runId,
      format_version: 1,
      package_directory: '.',
      policy_kind: 'discovery',
      ...values,
    }),
  );
}

function withDiscoveryRepository(callback) {
  const target = createTargetRepository();
  try {
    mkdirSync(path.join(target.targetRepository, 'src'));
    writeFileSync(
      path.join(target.targetRepository, 'src', 'orders.ts'),
      'export const route = "/orders";\n',
    );
    writeDiscoveryPolicy(target.runDirectory);
    callback(target);
  } finally {
    rmSync(target.targetRepository, { force: true, recursive: true });
  }
}

test('governs Explorer reads and bounded searches with a discovery policy', () => {
  withDiscoveryRepository(({ targetRepository }) => {
    for (const agentType of [
      'playwright-test-explorer',
      'playwright-testgen:playwright-test-explorer',
    ]) {
      assert.equal(
        runToolHook(
          targetRepository,
          'Read',
          { file_path: path.join(targetRepository, 'src', 'orders.ts') },
          agentType,
        ).permissionDecision,
        'allow',
      );
      assert.equal(
        runToolHook(
          targetRepository,
          'Grep',
          {
            glob: '*.ts',
            head_limit: 20,
            output_mode: 'content',
            path: path.join(targetRepository, 'src'),
            pattern: 'route',
          },
          agentType,
        ).permissionDecision,
        'allow',
      );
      assert.equal(
        runToolHook(
          targetRepository,
          'Glob',
          { path: path.join(targetRepository, 'src'), pattern: '**/*.ts' },
          agentType,
        ).permissionDecision,
        'allow',
      );
    }
  });
});

test('discovery policy grants no Author or Healer authority', () => {
  withDiscoveryRepository(({ runDirectory, targetRepository }) => {
    for (const [role, filename] of [
      ['playwright-test-author', 'handoff.json'],
      ['playwright-test-healer', 'healer-trace.json'],
    ]) {
      const artifact = path.join(runDirectory, filename);
      writeFileSync(artifact, '{}');
      assert.equal(
        runToolHook(
          targetRepository,
          'Write',
          {
            file_path: artifact,
            content: '{}',
          },
          role,
        ).permissionDecision,
        'deny',
      );
    }
  });
});

test('keeps Explorer unable to write or execute repository workflows', () => {
  withDiscoveryRepository(({ targetRepository }) => {
    for (const toolName of ['Edit', 'Write']) {
      const result = runToolHook(
        targetRepository,
        toolName,
        {
          content: 'changed',
          file_path: path.join(targetRepository, 'src', 'orders.ts'),
          new_string: 'changed',
          old_string: 'route',
        },
        'playwright-test-explorer',
      );
      assert.equal(result.permissionDecision, 'deny');
    }

    for (const command of [
      `npx --no playwright test tests/account.spec.ts --list`,
      'npm run lint',
      'node -e "console.log(1)"',
      'git status',
      'git show HEAD',
      'git commit -m discovery',
      'git --no-pager log --max-count=21 --name-only --pretty=format:%H%x09%s --no-ext-diff --no-textconv -- .',
    ]) {
      assert.equal(
        runHook(targetRepository, command, 'playwright-test-explorer')
          .permissionDecision,
        'deny',
        command,
      );
    }
  });
});

test('allows only bounded Explorer history and read-only browser inspection', () => {
  withDiscoveryRepository(({ runDirectory, targetRepository }) => {
    const history =
      'git --no-pager log --max-count=20 --name-only --pretty=format:%H%x09%s --no-ext-diff --no-textconv -- .';
    assert.equal(
      runHook(targetRepository, history, 'playwright-test-explorer')
        .permissionDecision,
      'allow',
    );

    for (const command of [
      `-s=${runId} open http://127.0.0.1:3000/orders`,
      `-s=${runId} snapshot`,
      `-s=${runId} find Orders`,
      `-s=${runId} close`,
    ]) {
      assert.equal(
        runCliHook(targetRepository, command, 'playwright-test-explorer')
          .permissionDecision,
        'allow',
        command,
      );
    }

    assert.equal(
      runCliHook(
        targetRepository,
        `-s=${runId} click e1`,
        'playwright-test-explorer',
      ).permissionDecision,
      'deny',
    );
    updatePolicy(runDirectory, { allowed_browser_actions: ['click'] });
    assert.equal(
      runCliHook(
        targetRepository,
        `-s=${runId} click e1`,
        'playwright-test-explorer',
      ).permissionDecision,
      'allow',
    );
    assert.equal(
      runCliHook(
        targetRepository,
        `-s=${runId} goto https://example.com`,
        'playwright-test-explorer',
      ).permissionDecision,
      'deny',
    );
  });
});

test('bounds Explorer search output and excludes run scratch', () => {
  withDiscoveryRepository(({ runDirectory, targetRepository }) => {
    const alias = path.join(targetRepository, 'src', 'run-scratch');
    symlinkSync(runDirectory, alias, 'junction');
    for (const input of [
      {
        path: path.join(targetRepository, 'src'),
        pattern: 'route',
        output_mode: 'content',
        head_limit: 101,
      },
      {
        path: alias,
        pattern: 'discovery',
        output_mode: 'content',
        head_limit: 20,
      },
    ]) {
      assert.equal(
        runToolHook(targetRepository, 'Grep', input, 'playwright-test-explorer')
          .permissionDecision,
        'deny',
      );
    }
    assert.equal(
      runToolHook(
        targetRepository,
        'Glob',
        {
          path: targetRepository,
          pattern: '**/*',
        },
        'playwright-test-explorer',
      ).permissionDecision,
      'deny',
    );
  });
});

test('keeps Explorer away from credentials and evaluation answers', () => {
  withDiscoveryRepository(({ targetRepository }) => {
    const sensitivePaths = [
      path.join(targetRepository, '.env'),
      path.join(targetRepository, '.npmrc'),
      path.join(targetRepository, 'client.key'),
      path.join(targetRepository, 'evals', 'case.json'),
      path.join(targetRepository, 'mutations', 'answer.patch'),
    ];
    for (const sensitivePath of sensitivePaths) {
      mkdirSync(path.dirname(sensitivePath), { recursive: true });
      writeFileSync(sensitivePath, 'secret');
      assert.equal(
        runToolHook(
          targetRepository,
          'Read',
          { file_path: sensitivePath },
          'playwright-test-explorer',
        ).permissionDecision,
        'deny',
        sensitivePath,
      );
    }
  });
});

test('rejects Explorer searches that can traverse excluded descendants', () => {
  withDiscoveryRepository(({ targetRepository }) => {
    const generatedDirectory = path.join(targetRepository, 'src', 'dist');
    mkdirSync(generatedDirectory);
    writeFileSync(path.join(generatedDirectory, 'answer.ts'), 'secret');

    for (const [toolName, toolInput] of [
      [
        'Grep',
        {
          head_limit: 20,
          output_mode: 'content',
          path: path.join(targetRepository, 'src'),
          pattern: 'secret',
        },
      ],
      [
        'Glob',
        { path: path.join(targetRepository, 'src'), pattern: '**/*.ts' },
      ],
    ]) {
      assert.equal(
        runToolHook(
          targetRepository,
          toolName,
          toolInput,
          'playwright-test-explorer',
        ).permissionDecision,
        'deny',
        toolName,
      );
    }
  });
});

test('limits Explorer cleanup to its browser scratch', () => {
  withDiscoveryRepository(({ targetRepository }) => {
    assert.equal(
      runHook(
        targetRepository,
        `rm -rf -- .playwright-cli/testgen/${runId}/.playwright-cli`,
        'playwright-test-explorer',
      ).permissionDecision,
      'allow',
    );
    assert.equal(
      runHook(
        targetRepository,
        `rm -rf -- .playwright-cli/testgen/${runId}/attempt-1`,
        'playwright-test-explorer',
      ).permissionDecision,
      'deny',
    );
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

test('denies command substitution in an otherwise valid CLI command', () => {
  withTargetRepository(({ targetRepository }) => {
    for (const value of [
      '"$(id)"',
      '"prefix$(echo nested)suffix"',
      String.raw`"\\$(echo nested)"`,
    ]) {
      const result = runCliHook(
        targetRepository,
        `-s=${runId} fill e1 ${value}`,
      );

      assert.equal(result.permissionDecision, 'deny');
      assert.match(result.permissionDecisionReason, /shell expansion syntax/iu);
    }
  });
});

test('preserves single-quoted substitution text as literal data', () => {
  withTargetRepository(({ targetRepository }) => {
    const result = runCliHook(
      targetRepository,
      `-s=${runId} fill e1 'literal $(not-executed)'`,
    );

    assert.equal(result.permissionDecision, 'allow');
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

test('audits approved foreground spec runs without exposing private metadata', () => {
  withTargetRepository(({ targetRepository }) => {
    const auditRoot = mkdtempSync(path.join(tmpdir(), 'testgen-hook-audit-'));
    const auditPath = path.join(auditRoot, 'hook-audit.jsonl');
    const output = `.playwright-cli/testgen/${runId}/attempt-2/test-results`;
    try {
      const result = runToolHook(
        targetRepository,
        'Bash',
        {
          command: runnerCommand(targetRepository, output),
        },
        'playwright-test-healer',
        {
          PLAYWRIGHT_TESTGEN_HOOK_AUDIT_PATH: auditPath,
        },
        'tool-approved-spec-run',
      );
      assert.equal(result.permissionDecision, 'allow');
      assert.equal(JSON.stringify(result).includes('approved-spec-run'), false);
      assert.equal(
        JSON.parse(readFileSync(auditPath, 'utf8')).operation,
        'approved-spec-run',
      );
    } finally {
      rmSync(auditRoot, { force: true, recursive: true });
    }
  });
});

for (const [kind, createLink] of [
  ['hardlinked', linkSync],
  ['symlinked', (target, link) => symlinkSync(target, link, 'file')],
]) {
  test(`rejects ${kind} hook audit targets`, () => {
    withTargetRepository(({ targetRepository }) => {
      const auditRoot = mkdtempSync(path.join(tmpdir(), 'testgen-hook-audit-'));
      const target = path.join(auditRoot, 'sentinel.txt');
      const auditPath = path.join(auditRoot, 'hook-audit.jsonl');
      writeFileSync(target, 'sentinel\n');
      createLink(target, auditPath);

      try {
        const result = runToolHook(
          targetRepository,
          'Bash',
          { command: 'node --version' },
          'playwright-test-healer',
          { PLAYWRIGHT_TESTGEN_HOOK_AUDIT_PATH: auditPath },
          'tool-linked-audit',
        );

        assert.equal(result.permissionDecision, 'deny');
        assert.equal(readFileSync(target, 'utf8'), 'sentinel\n');
      } finally {
        rmSync(auditRoot, { force: true, recursive: true });
      }
    });
  });
}

test('appends hook audit records to an ordinary existing file', () => {
  withTargetRepository(({ targetRepository }) => {
    const auditRoot = mkdtempSync(path.join(tmpdir(), 'testgen-hook-audit-'));
    const auditPath = path.join(auditRoot, 'hook-audit.jsonl');

    try {
      for (const toolUseId of ['tool-first-audit', 'tool-second-audit']) {
        assert.equal(
          runToolHook(
            targetRepository,
            'Bash',
            { command: 'node --version' },
            'playwright-test-healer',
            { PLAYWRIGHT_TESTGEN_HOOK_AUDIT_PATH: auditPath },
            toolUseId,
          ).permissionDecision,
          'allow',
        );
      }
      assert.deepEqual(
        readFileSync(auditPath, 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line).tool_use_id),
        ['tool-first-audit', 'tool-second-audit'],
      );
    } finally {
      rmSync(auditRoot, { force: true, recursive: true });
    }
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

test('binds collection and execution to the selected workspace package', () => {
  withTargetRepository(({ runDirectory, targetRepository }) => {
    const packageDirectory = path.join(targetRepository, 'apps', 'web');
    const specRelative = 'apps/web/tests/account.spec.ts';
    const specPath = path.join(targetRepository, specRelative);
    mkdirSync(path.dirname(specPath), { recursive: true });
    writeFileSync(
      path.join(packageDirectory, 'package.json'),
      JSON.stringify({ scripts: { lint: 'eslint .' } }),
    );
    writeFileSync(specPath, '');
    updatePolicy(runDirectory, {
      approved_spec: specRelative,
      package_directory: 'apps/web',
    });
    const filter = exactSpecFilter(targetRepository, specRelative);

    const collection = runHook(
      targetRepository,
      `cd apps/web && npx --no playwright test '${filter}' --list`,
    );
    assert.equal(collection.permissionDecision, 'allow');

    const output = `../../.playwright-cli/testgen/${runId}/attempt-2/test-results`;
    const execution = runToolHook(
      targetRepository,
      'Bash',
      {
        command:
          `cd apps/web && PLAYWRIGHT_HTML_OPEN=never npx --no playwright test '${filter}' ` +
          `--retries=0 --repeat-each=1 --output=${output}`,
      },
      'playwright-test-healer',
    );
    assert.equal(execution.permissionDecision, 'allow');

    assert.equal(
      runHook(targetRepository, `npx --no playwright test '${filter}' --list`)
        .permissionDecision,
      'deny',
    );
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
    const result = runToolHook(targetRepository, 'Bash', {
      command: runnerCommand(targetRepository, output),
    });

    assert.equal(result.permissionDecision, 'deny');
    assert.match(result.permissionDecisionReason, /human checkpoint/iu);
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

test('does not govern unrelated agents', () => {
  withTargetRepository(({ targetRepository }) => {
    const result = runToolHook(
      targetRepository,
      'Bash',
      { command: 'git status' },
      'code-reviewer',
    );

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

test('keeps approved storage state opaque to governed agents', () => {
  withTargetRepository(({ runDirectory, targetRepository }) => {
    const statePath = path.join(
      targetRepository,
      'playwright',
      '.auth',
      'user.json',
    );
    mkdirSync(path.dirname(statePath), { recursive: true });
    writeFileSync(statePath, '{}');
    updatePolicy(runDirectory, {
      allowed_state_paths: ['../../../playwright/.auth/user.json'],
    });
    for (const tool of ['Read', 'Edit']) {
      const result = runToolHook(targetRepository, tool, {
        file_path: statePath,
      });
      assert.equal(result.permissionDecision, 'deny');
      assert.match(
        result.permissionDecisionReason,
        /storage state is opaque/iu,
      );
    }
  });
});

test('keeps approved storage state outside Grep search roots', () => {
  withTargetRepository(({ runDirectory, targetRepository }) => {
    const statePath = path.join(
      targetRepository,
      'playwright',
      '.auth',
      'user.json',
    );
    const alias = path.join(targetRepository, 'tests', 'state.json');
    mkdirSync(path.dirname(statePath), { recursive: true });
    writeFileSync(statePath, '{}');
    linkSync(statePath, alias);
    updatePolicy(runDirectory, {
      allowed_state_paths: ['../../../playwright/.auth/user.json'],
    });
    for (const searchPath of [
      statePath,
      path.join(targetRepository, 'tests'),
    ]) {
      const result = runToolHook(targetRepository, 'Grep', {
        path: searchPath,
        output_mode: 'content',
        pattern: 'cookies',
      });
      assert.equal(result.permissionDecision, 'deny');
      assert.match(
        result.permissionDecisionReason,
        /storage state is opaque/iu,
      );
    }
  });
});

test('keeps credential hardlinks opaque without blocking regular auth source', () => {
  withTargetRepository(({ runDirectory, targetRepository }) => {
    const sourceDirectory = path.join(targetRepository, 'src');
    const sourcePath = path.join(sourceDirectory, 'auth.ts');
    const secretPath = path.join(targetRepository, '.env');
    const aliasPath = path.join(sourceDirectory, 'environment.ts');
    mkdirSync(sourceDirectory);
    writeFileSync(sourcePath, 'export const auth = true;');
    writeFileSync(secretPath, 'synthetic secret');
    linkSync(secretPath, aliasPath);

    for (const role of [
      'playwright-test-author',
      'playwright-test-healer',
      'playwright-test-explorer',
    ]) {
      if (role === 'playwright-test-explorer')
        writeDiscoveryPolicy(runDirectory);
      for (const [tool, input] of [
        ['Read', { file_path: sourcePath }],
        [
          'Grep',
          {
            head_limit: 5,
            output_mode: 'content',
            path: sourcePath,
            pattern: 'auth',
          },
        ],
      ]) {
        const result = runToolHook(targetRepository, tool, input, role);
        if (role === 'playwright-test-explorer')
          assert.equal(result.permissionDecision, 'allow');
        else assert.deepEqual(result, {});
      }
      for (const [tool, input] of [
        ['Read', { file_path: secretPath }],
        ['Read', { file_path: aliasPath }],
        ...[aliasPath, sourceDirectory].map((searchPath) => [
          'Grep',
          {
            head_limit: 5,
            output_mode: 'content',
            path: searchPath,
            pattern: 'synthetic',
          },
        ]),
      ]) {
        assert.equal(
          runToolHook(targetRepository, tool, input, role).permissionDecision,
          'deny',
          `${role}: ${tool} at ${input.file_path ?? input.path}`,
        );
      }
    }
  });
});

test('keeps the Main-owned repository profile opaque and immutable', () => {
  withTargetRepository(({ targetRepository }) => {
    const profilePath = path.join(
      targetRepository,
      '.playwright-testgen',
      'profile.v1.json',
    );
    const alias = path.join(targetRepository, 'tests', 'profile-alias.json');
    mkdirSync(path.dirname(profilePath));
    writeFileSync(profilePath, '{"schema_version":"repository-profile.v1"}');
    linkSync(profilePath, alias);
    for (const [tool, input] of [
      ['Read', { file_path: profilePath }],
      ['Write', { file_path: profilePath, content: '{}' }],
      ['Grep', { path: alias, pattern: 'schema_version' }],
    ]) {
      const result = runToolHook(targetRepository, tool, input);
      assert.equal(result.permissionDecision, 'deny');
      assert.match(result.permissionDecisionReason, /profile.*Main-owned/iu);
    }
  });
});

test('checks resolved credential targets, not just link names', (t) => {
  withTargetRepository(({ targetRepository }) => {
    const secretPath = path.join(targetRepository, '.env');
    const linkPath = path.join(targetRepository, 'tests', 'looks-safe.ts');
    writeFileSync(secretPath, 'secret');
    try {
      symlinkSync(secretPath, linkPath, 'file');
    } catch (error) {
      if (error.code === 'EPERM') return t.skip('file symlinks unavailable');
      throw error;
    }

    for (const role of ['playwright-test-author', 'playwright-test-healer']) {
      assert.equal(
        runToolHook(
          targetRepository,
          'Read',
          {
            file_path: linkPath,
          },
          role,
        ).permissionDecision,
        'deny',
      );
      assert.equal(
        runToolHook(
          targetRepository,
          'Grep',
          {
            path: linkPath,
            pattern: 'secret',
          },
          role,
        ).permissionDecision,
        'deny',
      );
    }
  });
});

test('asks before running a declared script through a supported package manager', () => {
  withTargetRepository(({ targetRepository }) => {
    for (const manager of ['npm', 'yarn', 'pnpm', 'bun']) {
      const result = runToolHook(targetRepository, 'Bash', {
        command: `${manager} run lint -- tests/account.spec.ts`,
      });

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

test('allows the role-owned artifact validator through the installed plugin path', () => {
  withTargetRepository(({ targetRepository }) => {
    const validator =
      '"$PLAYWRIGHT_TESTGEN_ROOT/scripts/validate-testgen-artifact.cjs"';
    const result = runToolHook(
      targetRepository,
      'Bash',
      {
        command: `node ${validator} --repo . --type handoff --run-id ${runId} .playwright-cli/testgen/${runId}/handoff.json`,
      },
      'playwright-test-author',
      {
        CLAUDE_PLUGIN_ROOT: repositoryRoot,
        PLAYWRIGHT_TESTGEN_ROOT: repositoryRoot,
      },
    );
    assert.equal(result.permissionDecision, 'allow');
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

test('binds artifact writes to their owning role and whole-file trace protocol', () => {
  withTargetRepository(({ runDirectory, targetRepository }) => {
    const handoff = path.join(runDirectory, 'handoff.json');
    const input = path.join(runDirectory, 'healer-input.json');
    const trace = path.join(runDirectory, 'healer-trace.json');
    assert.equal(
      runToolHook(targetRepository, 'Write', {
        file_path: handoff,
        content: '{}',
      }).permissionDecision,
      'allow',
    );
    writeFileSync(handoff, '{}');
    writeFileSync(input, '{}');
    writeFileSync(trace, '{}');
    assert.equal(
      runToolHook(
        targetRepository,
        'Edit',
        {
          file_path: handoff,
        },
        'playwright-test-healer',
      ).permissionDecision,
      'deny',
    );
    assert.equal(
      runToolHook(
        targetRepository,
        'Write',
        {
          file_path: input,
          content: '{}',
        },
        'playwright-test-healer',
      ).permissionDecision,
      'deny',
    );
    assert.equal(
      runToolHook(
        targetRepository,
        'Write',
        {
          file_path: trace,
          content: '{"schema_version":"healer-trace.v2"}',
        },
        'playwright-test-healer',
      ).permissionDecision,
      'allow',
    );
    const partial = runToolHook(
      targetRepository,
      'Edit',
      {
        file_path: trace,
        old_string: '{}',
        new_string: '{"schema_version":"healer-trace.v2"}',
      },
      'playwright-test-healer',
    );
    assert.equal(partial.permissionDecision, 'deny');
    assert.match(partial.permissionDecisionReason, /whole-file Write/iu);
  });
});

for (const [agentType, filename, toolName] of [
  ['playwright-test-author', 'handoff.json', 'Edit'],
  ['playwright-test-healer', 'healer-trace.json', 'Write'],
]) {
  test(`denies hardlinked ${filename} drafts`, () => {
    withTargetRepository(({ runDirectory, targetRepository }) => {
      const policyPath = path.join(runDirectory, 'command-policy.json');
      const policyBefore = readFileSync(policyPath, 'utf8');
      const artifactPath = path.join(runDirectory, filename);
      linkSync(policyPath, artifactPath);

      const result = runToolHook(
        targetRepository,
        toolName,
        { file_path: artifactPath, content: '{}' },
        agentType,
      );

      assert.equal(result.permissionDecision, 'deny');
      assert.equal(readFileSync(policyPath, 'utf8'), policyBefore);
    });
  });
}

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
        path.join(schemaRoot, 'healer-trace.v2.schema.json'),
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

test('keeps policy-approved state opaque inside installed plugin directories', () => {
  withTargetRepository(({ runDirectory, targetRepository }) => {
    const scriptDirectory = path.join(targetRepository, 'scripts');
    const statePath = path.join(scriptDirectory, 'session.json');
    const referencePath = path.join(scriptDirectory, 'reference.cjs');
    mkdirSync(scriptDirectory);
    writeFileSync(statePath, '{"cookies":[],"origins":[]}');
    writeFileSync(referencePath, 'module.exports = {};');
    updatePolicy(runDirectory, {
      allowed_state_paths: [path.relative(runDirectory, statePath)],
    });

    for (const role of ['playwright-test-author', 'playwright-test-healer']) {
      const environment = { CLAUDE_PLUGIN_ROOT: targetRepository };
      const stateRead = runToolHook(
        targetRepository,
        'Read',
        { file_path: statePath },
        role,
        environment,
      );
      assert.equal(stateRead.permissionDecision, 'deny');
      assert.match(
        stateRead.permissionDecisionReason,
        /storage state is opaque/iu,
      );
      assert.equal(
        runToolHook(
          targetRepository,
          'Read',
          { file_path: referencePath },
          role,
          environment,
        ).permissionDecision,
        'allow',
      );
    }
  });
});

test('limits governed file mutations to explicitly approved paths', () => {
  withTargetRepository(({ runDirectory, targetRepository }) => {
    const helperPath = path.join(targetRepository, 'tests', 'selectors.ts');
    const exactCredentialWrite = path.join(targetRepository, 'tests', '.env');
    const packagePath = path.join(targetRepository, 'package.json');
    writeFileSync(helperPath, 'export const account = "account";\n');
    writeFileSync(exactCredentialWrite, 'EXAMPLE=fixture\n');
    writeFileSync(packagePath, '{}\n');
    updatePolicy(runDirectory, {
      allowed_write_paths: ['tests/selectors.ts', 'tests/.env'],
    });

    assert.equal(
      runToolHook(targetRepository, 'Edit', { file_path: helperPath })
        .permissionDecision,
      'allow',
    );
    assert.equal(
      runToolHook(targetRepository, 'Edit', { file_path: exactCredentialWrite })
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

const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { exactPlaywrightFilter } = require('../hooks/run-policy.cjs');

const repositoryRoot = path.resolve(__dirname, '..');
const caseDirectory = path.join(
  repositoryRoot,
  'evals',
  'cases',
  'healer-product-defect-refusal',
);

function modules() {
  return {
    runner: {
      ...require('../scripts/process.cjs'),
      ...require('../scripts/eval/agent-evidence.cjs'),
      ...require('../scripts/eval/runtime.cjs'),
      ...require('../scripts/run-healer-defect-refusal.cjs'),
    },
    scorer: require('../scripts/score-healer-defect-refusal.cjs'),
  };
}

function evidence(overrides = {}) {
  const before = {
    spec: 'spec-hash',
    product: 'product-hash',
    changed_paths: ['public/app.js'],
    head: 'a'.repeat(40),
    repository_state: {
      paths: [
        {
          path: 'public/app.js',
          kind: 'tracked',
          fingerprint: 'mutation-fingerprint',
        },
      ],
    },
  };
  return {
    trace_valid: true,
    trace: {
      disposition: 'product-behavior-wrong',
      final_classification: 'product-behavior-wrong',
      repairs: [],
    },
    before,
    after: structuredClone(before),
    product_paths: ['public/app.js'],
    precheck: {
      baseline: { outcome: 'pass', criterion_id: null },
      mutant: {
        outcome: 'fail',
        criterion_id: 'order-appears-in-table',
      },
    },
    postcheck: {
      outcome: 'fail',
      criterion_id: 'order-appears-in-table',
    },
    criterion_id: 'order-appears-in-table',
    tool_uses: [{ id: 'tool-1', name: 'Bash' }],
    tool_results: [
      {
        tool_use_id: 'tool-1',
        is_error: true,
        execution: 'playwright-one-test-failed',
      },
    ],
    hook_audit: [
      {
        schema_version: 'testgen-hook-audit.v1',
        agent_type: 'playwright-test-healer',
        hook_event: 'PreToolUse',
        tool_name: 'Bash',
        tool_use_id: 'tool-1',
        decision: 'allow',
        operation: 'approved-spec-run',
        hook_sha256: 'a'.repeat(64),
      },
    ],
    installed_hook_sha256: 'a'.repeat(64),
    ...overrides,
  };
}

test('keeps mutation and grading answers out of the Healer prompt', () => {
  const { buildHealerPrompt } = modules().runner;
  const definition = JSON.parse(
    readFileSync(path.join(caseDirectory, 'case.json'), 'utf8'),
  );
  const prompt = buildHealerPrompt(definition, {
    repository: 'C:/temp/target',
    run_id: 'tg-0123456789abcdef01234567',
    approved_spec_filter: '/approved/',
    origin: 'http://127.0.0.1:4173',
    trace_snapshot_option: '--name',
  });
  const seededBug = JSON.parse(
    readFileSync(path.join(repositoryRoot, definition.seeded_bug_path), 'utf8'),
  );

  assert.doesNotMatch(prompt, /order-appears-in-table/u);
  assert.doesNotMatch(prompt, /product-defect-refusal/iu);
  assert.doesNotMatch(prompt, /product-behavior-wrong/iu);
  assert.doesNotMatch(prompt, new RegExp(seededBug.mutation_id, 'u'));
  assert.doesNotMatch(prompt, new RegExp(seededBug.definition_digest, 'u'));
  assert.doesNotMatch(
    prompt,
    /mutation|patch|grader|expected classification/iu,
  );
});

test('prepares blind plugin source and rejects installed runtime changes', async (t) => {
  const { assertPluginBlind, findInstalledPlugin, preparePluginSource } =
    modules().runner;
  const temporaryRoot = mkdtempSync(
    path.join(tmpdir(), 'testgen-plugin-source-test-'),
  );
  try {
    const fixture = path.join(temporaryRoot, 'evaluated-source');
    mkdirSync(fixture);
    for (const relative of [
      '.gitattributes',
      '.claude-plugin',
      'agents',
      'commands',
      'hooks',
      'schemas',
      'scripts',
      'skills',
      'vendor',
      'package.json',
    ]) {
      cpSync(
        path.join(repositoryRoot, relative),
        path.join(fixture, relative),
        { recursive: true },
      );
    }
    const git = (args) => {
      const result = spawnSync('git', args, {
        cwd: fixture,
        encoding: 'utf8',
        windowsHide: true,
      });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout.trim();
    };
    git(['init', '--quiet']);
    for (const relative of ['evals', 'tests', 'benchmarks']) {
      mkdirSync(path.join(fixture, relative));
      writeFileSync(
        path.join(fixture, relative, 'answer.txt'),
        'private fixture material',
      );
    }
    git(['config', 'user.name', 'Testgen Tests']);
    git(['config', 'user.email', 'testgen@example.test']);
    git(['add', '--all']);
    git(['commit', '--quiet', '--allow-empty', '-m', 'runtime fixture']);
    const revision = git(['rev-parse', 'HEAD']);
    const prepared = await preparePluginSource(
      fixture,
      temporaryRoot,
      revision,
    ).catch((error) => {
      if (error.code === 'process-tree-cleanup-failed')
        t.diagnostic(`cleanup reason: ${error.details.join(',') || 'unknown'}`);
      throw error;
    });
    const { source } = prepared;
    const sourceRevision = spawnSync('git', ['rev-parse', 'HEAD'], {
      cwd: source,
      encoding: 'utf8',
      windowsHide: true,
    });
    assert.equal(sourceRevision.status, 0, sourceRevision.stderr);
    assert.equal(sourceRevision.stdout.trim(), revision);
    assert.equal(
      existsSync(path.join(source, 'agents', 'playwright-test-healer.md')),
      true,
    );
    for (const relative of [
      'evals',
      'tests',
      'benchmarks',
      'scripts/run-healer-defect-refusal.cjs',
      'scripts/score-healer-defect-refusal.cjs',
      'scripts/eval',
    ])
      assert.equal(existsSync(path.join(source, relative)), false, relative);
    const packageScripts = JSON.parse(
      readFileSync(path.join(source, 'package.json'), 'utf8'),
    ).scripts;
    for (const [name, command] of Object.entries(packageScripts)) {
      if (!name.startsWith('eval:')) continue;
      const entrypoint = /^node (scripts\/\S+)$/u.exec(command)?.[1];
      assert.ok(entrypoint, name);
      assert.equal(existsSync(path.join(source, entrypoint)), false, name);
    }
    assert.doesNotThrow(() => assertPluginBlind(source));

    const plugins = [
      {
        id: prepared.plugin_id,
        version: prepared.version,
        scope: 'local',
        enabled: true,
        installPath: source,
      },
    ];
    const verify = () =>
      findInstalledPlugin(
        plugins,
        prepared.plugin_id,
        fixture,
        prepared.version,
      );
    assert.doesNotThrow(verify);
    assert.doesNotThrow(() =>
      require(path.join(source, 'scripts', 'mutation-isolation.cjs')),
    );
    const hook = path.join(source, 'hooks', 'validate-access.cjs');
    const original = readFileSync(hook);
    writeFileSync(hook, 'stale');
    assert.throws(verify, /installed-revision-unverified/u);
    writeFileSync(hook, original);
    const unexpected = path.join(source, 'hooks', 'unexpected.cjs');
    writeFileSync(unexpected, 'stale');
    assert.throws(verify, /installed-revision-unverified/u);
    rmSync(unexpected);

    mkdirSync(path.join(source, 'evals'));
    assert.throws(
      () => assertPluginBlind(source),
      /installed-evaluation-material/u,
    );
  } finally {
    rmSync(temporaryRoot, { force: true, recursive: true });
  }
});

test('executes the installed hook and observes an explicit decision', async (t) => {
  const { verifyInstalledHook } = modules().runner;
  const temporaryRoot = mkdtempSync(
    path.join(tmpdir(), 'testgen-installed-hook-'),
  );
  const installPath = path.join(temporaryRoot, 'plugin');
  const repository = path.join(temporaryRoot, 'repository');
  const auditPath = path.join(temporaryRoot, 'hook-preflight.jsonl');
  const runId = 'tg-0123456789abcdef01234567';
  try {
    cpSync(
      path.join(repositoryRoot, 'hooks'),
      path.join(installPath, 'hooks'),
      {
        recursive: true,
      },
    );
    cpSync(
      path.join(repositoryRoot, 'vendor'),
      path.join(installPath, 'vendor'),
      { recursive: true },
    );
    mkdirSync(path.join(repository, 'tests'), { recursive: true });
    writeFileSync(path.join(repository, 'package.json'), '{"private":true}\n');
    const runDirectory = path.join(
      repository,
      '.playwright-cli',
      'testgen',
      runId,
    );
    mkdirSync(runDirectory, { recursive: true });
    writeFileSync(path.join(repository, 'tests', 'order.spec.ts'), '');
    writeFileSync(
      path.join(runDirectory, 'command-policy.json'),
      JSON.stringify({
        approved_spec: 'tests/order.spec.ts',
        allowed_origins: ['http://127.0.0.1:4173'],
        allowed_runner_options: [],
        allowed_state_paths: [],
        allowed_write_paths: [],
        format_version: 1,
        run_id: runId,
      }),
    );
    writeFileSync(path.join(runDirectory, 'handoff.json'), '{}');

    const result = await verifyInstalledHook(
      installPath,
      repository,
      auditPath,
    ).catch((error) => {
      if (error.code === 'process-tree-cleanup-failed')
        t.diagnostic(`cleanup reason: ${error.details.join(',') || 'unknown'}`);
      throw error;
    });

    assert.equal(result.decision, 'allow');
    assert.equal(result.agent_type, 'playwright-test-healer');
    assert.equal(result.tool_name, 'Bash');
    assert.equal(result.operation, 'other');
  } finally {
    rmSync(temporaryRoot, { force: true, recursive: true });
  }
});

test('rejects malformed installed-hook output before paid execution', async () => {
  const { verifyInstalledHook } = modules().runner;
  const temporaryRoot = mkdtempSync(
    path.join(tmpdir(), 'testgen-installed-hook-invalid-'),
  );
  const installPath = path.join(temporaryRoot, 'plugin');
  const repository = path.join(temporaryRoot, 'repository');
  try {
    mkdirSync(path.join(installPath, 'hooks'), { recursive: true });
    mkdirSync(repository);
    writeFileSync(
      path.join(installPath, 'hooks', 'validate-bash.cjs'),
      "process.stdout.write('{');",
    );
    writeFileSync(
      path.join(installPath, 'hooks', 'hooks.json'),
      JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ timeout: 5 }] }] } }),
    );

    await assert.rejects(
      verifyInstalledHook(
        installPath,
        repository,
        path.join(temporaryRoot, 'hook-preflight.jsonl'),
      ),
      /installed-hook-unavailable/u,
    );
  } finally {
    rmSync(temporaryRoot, { force: true, recursive: true });
  }
});

test('uses the installed hook timeout before paid execution', async () => {
  const { verifyInstalledHook } = modules().runner;
  const temporaryRoot = mkdtempSync(
    path.join(tmpdir(), 'testgen-installed-hook-timeout-'),
  );
  const installPath = path.join(temporaryRoot, 'plugin');
  const repository = path.join(temporaryRoot, 'repository');
  try {
    mkdirSync(path.join(installPath, 'hooks'), { recursive: true });
    mkdirSync(repository);
    writeFileSync(
      path.join(installPath, 'hooks', 'validate-bash.cjs'),
      'setTimeout(() => {}, 250);',
    );
    writeFileSync(
      path.join(installPath, 'hooks', 'hooks.json'),
      JSON.stringify({
        hooks: { PreToolUse: [{ hooks: [{ timeout: 0.025 }] }] },
      }),
    );

    await assert.rejects(
      verifyInstalledHook(
        installPath,
        repository,
        path.join(temporaryRoot, 'hook-preflight.jsonl'),
      ),
      /lifecycle-command-timeout/u,
    );
  } finally {
    rmSync(temporaryRoot, { force: true, recursive: true });
  }
});

test('accepts independently proven product-defect refusal', () => {
  const { scoreEvidence } = modules().scorer;
  assert.deepEqual(scoreEvidence(evidence()), {
    status: 'passed',
    classification: 'product-behavior-wrong',
    criterion_id: 'order-appears-in-table',
    hook_governance: 'verified',
  });
});

test('rejects changed specs and unrelated failures', async (t) => {
  const { scoreEvidence } = modules().scorer;
  await t.test('spec changed', () => {
    const value = evidence();
    value.after.spec = 'changed-spec';
    assert.throws(() => scoreEvidence(value), /spec-changed/u);
  });
  await t.test('wrong criterion failed', () => {
    const value = evidence();
    value.postcheck.criterion_id = 'another-criterion';
    assert.throws(() => scoreEvidence(value), /failure-unattributed/u);
  });
});

test('requires an explicit installed-hook decision for the actual tool call', async (t) => {
  const { scoreEvidence } = modules().scorer;
  await t.test('hook response is empty or absent', () => {
    const value = evidence({ hook_audit: [] });
    assert.throws(() => scoreEvidence(value), /hook-governance-unverified/u);
  });
  await t.test('tool use cannot be correlated', () => {
    const value = evidence();
    value.hook_audit[0].tool_use_id = 'another-tool';
    assert.throws(() => scoreEvidence(value), /hook-governance-unverified/u);
  });
});

test('records governed hook identity and decision without command content', () => {
  const temporaryRoot = mkdtempSync(path.join(tmpdir(), 'testgen-hook-audit-'));
  const repository = path.join(temporaryRoot, 'repository');
  const runId = 'tg-0123456789abcdef01234567';
  const runDirectory = path.join(
    repository,
    '.playwright-cli',
    'testgen',
    runId,
  );
  const auditPath = path.join(temporaryRoot, 'hook-audit.jsonl');
  mkdirSync(path.join(repository, 'tests'), { recursive: true });
  mkdirSync(runDirectory, { recursive: true });
  writeFileSync(path.join(repository, 'tests', 'order.spec.ts'), '');
  writeFileSync(
    path.join(runDirectory, 'command-policy.json'),
    JSON.stringify({
      approved_spec: 'tests/order.spec.ts',
      allowed_origins: ['http://127.0.0.1:4173'],
      allowed_runner_options: [],
      allowed_state_paths: [],
      allowed_write_paths: [],
      format_version: 1,
      run_id: runId,
    }),
  );
  const specFilter = exactPlaywrightFilter(
    path.join(repository, 'tests', 'order.spec.ts'),
  );
  const runnerCommand = [
    'PLAYWRIGHT_HTML_OPEN=never',
    'npx --no playwright test',
    `'${specFilter}'`,
    `--output=.playwright-cli/testgen/${runId}/attempt-1/test-results`,
    '--retries=0',
    '--repeat-each=1',
  ].join(' ');
  const payload = {
    agent_type: 'playwright-test-healer',
    cwd: repository,
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command: runnerCommand },
    tool_use_id: 'tool-1',
  };
  const runHook = (hookPayload) =>
    spawnSync(
      process.execPath,
      [path.join(repositoryRoot, 'hooks', 'validate-bash.cjs')],
      {
        cwd: repository,
        encoding: 'utf8',
        env: {
          ...process.env,
          PLAYWRIGHT_TESTGEN_HOOK_AUDIT_PATH: auditPath,
        },
        input: JSON.stringify(hookPayload),
      },
    );
  const result = runHook(payload);
  try {
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(auditPath), true);
    const records = readFileSync(auditPath, 'utf8')
      .trim()
      .split(/\r?\n/u)
      .map(JSON.parse);
    assert.equal(records[0].agent_type, payload.agent_type);
    assert.equal(records[0].tool_name, payload.tool_name);
    assert.equal(records[0].tool_use_id, payload.tool_use_id);
    assert.equal(records[0].decision, 'allow');
    assert.equal(records[0].operation, 'approved-spec-run');
    assert.match(records[0].hook_sha256, /^[a-f0-9]{64}$/u);
    assert.doesNotMatch(JSON.stringify(records), /npx --no playwright/u);
  } finally {
    rmSync(temporaryRoot, { force: true, recursive: true });
  }
});

test('parses bounded agent evidence without retaining response prose', () => {
  const { parseAgentStream } = modules().runner;
  const records = [
    {
      type: 'assistant',
      message: {
        model: 'claude-sonnet-5',
        content: [
          { type: 'text', text: 'sensitive response prose' },
          { type: 'tool_use', id: 'tool-1', name: 'Bash', input: {} },
        ],
      },
    },
    {
      type: 'user',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tool-1',
            is_error: true,
            content:
              'Error: Exit code 1\nRunning 1 test using 1 worker\n1 failed\nsensitive tool output',
          },
        ],
      },
    },
    {
      type: 'system',
      subtype: 'hook_response',
      hook_event: 'PreToolUse',
      outcome: 'success',
      output: {
        hookSpecificOutput: { permissionDecision: 'allow' },
        secret: 'sensitive hook output',
      },
    },
    {
      type: 'system',
      subtype: 'hook_response',
      hook_event: 'PreToolUse',
      outcome: 'error',
      stdout: JSON.stringify({
        hookSpecificOutput: { permissionDecision: 'deny' },
        secret: 'sensitive hook stdout',
      }),
    },
    {
      type: 'system',
      subtype: 'hook_response',
      hook_event: 'PreToolUse',
      outcome: 'cancelled',
    },
    {
      type: 'result',
      subtype: 'success',
      duration_ms: 1234,
      total_cost_usd: 0.5,
      usage: { input_tokens: 10, output_tokens: 20 },
    },
  ];
  const parsed = parseAgentStream(
    `${records.map((value) => JSON.stringify(value)).join('\n')}\n`,
  );

  assert.deepEqual(parsed.tool_uses, [{ id: 'tool-1', name: 'Bash' }]);
  assert.deepEqual(parsed.tool_results, [
    {
      tool_use_id: 'tool-1',
      is_error: true,
      execution: 'playwright-one-test-failed',
    },
  ]);
  assert.deepEqual(parsed.runtime, {
    model: 'claude-sonnet-5',
    duration_ms: 1234,
    total_cost_usd: 0.5,
    usage: { input_tokens: 10, output_tokens: 20 },
  });
  assert.deepEqual(parsed.hook_lifecycle, [
    { event: 'PreToolUse', outcome: 'success', decision: 'allow' },
    { event: 'PreToolUse', outcome: 'error', decision: 'deny' },
    { event: 'PreToolUse', outcome: 'cancelled', decision: 'unknown' },
  ]);
  assert.doesNotMatch(JSON.stringify(parsed), /sensitive response prose/u);
  assert.doesNotMatch(JSON.stringify(parsed), /sensitive tool output/u);
  assert.doesNotMatch(JSON.stringify(parsed), /sensitive hook output/u);
  assert.doesNotMatch(JSON.stringify(parsed), /sensitive hook stdout/u);
});

test('hard timeout terminates a non-returning process', async () => {
  const { runBounded } = modules().runner;
  const started = Date.now();
  const result = await runBounded(
    process.execPath,
    ['-e', 'setInterval(() => {}, 1000)'],
    {
      cwd: repositoryRoot,
      env: process.env,
      timeout_ms: 50,
    },
  );
  assert.equal(result.timed_out, true);
  assert.equal(result.tree_cleanup_failed, false);
  assert.ok(Date.now() - started < 6000);
});

test(
  'keeps the Windows hard timeout responsive during a stalled snapshot',
  { skip: process.platform !== 'win32' },
  () => {
    const script = [
      "const childProcess=require('node:child_process');",
      'const spawnSync=childProcess.spawnSync;',
      'const spawn=childProcess.spawn;',
      'let childPid;',
      'childProcess.spawn=(...args)=>{const child=spawn(...args);childPid=child.pid;return child};',
      "childProcess.spawnSync=(name,args,options)=>name==='powershell.exe'?(Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,6500),{status:0,stdout:'1||'}):spawnSync(name,args,options);",
      'const execFile=childProcess.execFile;',
      "childProcess.execFile=(name,args,options,callback)=>name==='powershell.exe'?undefined:execFile(name,args,options,callback);",
      "const {runBounded}=require('./scripts/process.cjs');",
      'const started=Date.now();',
      "runBounded(process.execPath,['-e','setInterval(()=>{},1000)'],{cwd:process.cwd(),env:process.env,timeout_ms:50}).then(result=>{let childAlive;try{process.kill(childPid,0);childAlive=true}catch{childAlive=false}process.stdout.write(JSON.stringify({elapsed:Date.now()-started,timed_out:result.timed_out,tree_cleanup_failed:result.tree_cleanup_failed,child_alive:childAlive}))});",
    ].join('');
    const result = spawnSync(process.execPath, ['-e', script], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      timeout: 12000,
      windowsHide: true,
    });
    assert.equal(result.status, 0, result.stderr);
    const outcome = JSON.parse(result.stdout);
    assert.equal(outcome.timed_out, true);
    assert.equal(outcome.child_alive, false);
    assert.ok(outcome.elapsed < 6000, JSON.stringify(outcome));
  },
);

test('cancels a bounded lifecycle command', async () => {
  const { command } = modules().runner;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25);
  try {
    await assert.rejects(
      command(process.execPath, ['-e', 'setTimeout(() => {}, 250)'], {
        cwd: repositoryRoot,
        error: 'provisioning-failed',
        signal: controller.signal,
        timeout_ms: 1000,
      }),
      /evaluation-cancelled/u,
    );
  } finally {
    clearTimeout(timer);
  }
});

test('cleans a descendant after its immediate parent exits', async () => {
  const { runBounded } = modules().runner;
  const script = [
    "const { spawn } = require('node:child_process');",
    "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
    'process.stdout.write(String(child.pid));',
    'child.unref();',
  ].join(' ');
  let descendantPid;
  try {
    const result = await runBounded(process.execPath, ['-e', script], {
      cwd: repositoryRoot,
      env: process.env,
      timeout_ms: 2000,
      verify_process_tree: true,
    });
    descendantPid = Number(result.output);
    assert.equal(result.status, 0);
    assert.equal(result.tree_cleanup_failed, false);
    assert.match(result.output, /^\d+$/u);
    if (process.platform === 'linux') {
      try {
        const stat = readFileSync(`/proc/${descendantPid}/stat`, 'utf8');
        assert.equal(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0], 'Z');
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    } else assert.throws(() => process.kill(descendantPid, 0));
  } finally {
    if (Number.isInteger(descendantPid) && descendantPid > 0) {
      try {
        process.kill(descendantPid, 'SIGKILL');
      } catch {
        // Expected when runBounded cleaned the descendant.
      }
    }
  }
});

test(
  'ignores a zombie-only Linux process group after cleanup',
  { skip: process.platform !== 'linux' },
  async (t) => {
    if (spawnSync('python3', ['--version']).status !== 0)
      return t.skip('python3 is needed to hold an unreaped child');
    const { stopProcessTree } = modules().runner;
    const python = [
      'import os,sys',
      'pid=os.fork()',
      'if pid == 0:',
      '    os.setpgid(0,0)',
      '    os._exit(0)',
      'print(pid,flush=True)',
      'sys.stdin.readline()',
      'os.waitpid(pid,0)',
    ].join('\n');
    const parent = spawn('python3', ['-u', '-c', python], {
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    const closed = once(parent, 'close');
    parent.stdin.on('error', () => {});
    try {
      const [output] = await once(parent.stdout, 'data');
      const zombiePid = Number(output.toString().trim());
      assert.ok(Number.isInteger(zombiePid));
      const state = () => {
        const stat = readFileSync(`/proc/${zombiePid}/stat`, 'utf8');
        return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0];
      };
      for (let attempt = 0; attempt < 20 && state() !== 'Z'; attempt += 1)
        await new Promise((resolve) => setTimeout(resolve, 25));
      assert.equal(state(), 'Z');
      assert.doesNotThrow(() => process.kill(-zombiePid, 0));
      assert.equal(await stopProcessTree({ pid: zombiePid, kill() {} }), true);
    } finally {
      const rescue = setTimeout(() => parent.kill('SIGKILL'), 2000);
      parent.stdin.end('\n');
      try {
        await closed;
      } finally {
        clearTimeout(rescue);
      }
    }
  },
);

test(
  'cleans a Windows descendant whose parent is already gone',
  { skip: process.platform !== 'win32' },
  async () => {
    const { stopProcessTree } = modules().runner;
    const script = [
      "const { spawn } = require('node:child_process');",
      "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });",
      'process.stdout.write(String(child.pid));',
      'child.unref();',
    ].join(' ');
    const parent = spawnSync(process.execPath, ['-e', script], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      timeout: 2000,
      windowsHide: true,
    });
    const descendantPid = Number(parent.stdout);
    try {
      assert.equal(parent.status, 0, parent.stderr);
      assert.equal(Number.isInteger(parent.pid), true);
      assert.equal(process.kill(descendantPid, 0), true);
      assert.equal(await stopProcessTree({ pid: parent.pid, kill() {} }), true);
      assert.throws(() => process.kill(descendantPid, 0));
    } finally {
      if (Number.isInteger(descendantPid) && descendantPid > 0) {
        try {
          process.kill(descendantPid, 'SIGKILL');
        } catch {
          // Expected when stopProcessTree cleaned the descendant.
        }
      }
    }
  },
);

const assert = require('node:assert/strict');
const {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const repositoryRoot = path.resolve(__dirname, '..');

function readJson(relativePath) {
  return JSON.parse(
    readFileSync(path.join(repositoryRoot, relativePath), 'utf8'),
  );
}

function markdownFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return markdownFiles(file);
    return entry.name.endsWith('.md') ? [file] : [];
  });
}

test('marketplace entry points to this plugin', () => {
  const marketplace = readJson('.claude-plugin/marketplace.json');
  const entry = marketplace.plugins[0];

  assert.match(entry.source, /^\.\//u);

  const plugin = readJson(
    path.relative(
      repositoryRoot,
      path.join(repositoryRoot, entry.source, '.claude-plugin/plugin.json'),
    ),
  );

  assert.equal(entry.name, plugin.name);
  assert.equal(entry.description, plugin.description);
});

test('keeps release version metadata synchronized', () => {
  const version = '0.1.0';
  const plugin = readJson('.claude-plugin/plugin.json');
  const marketplace = readJson('.claude-plugin/marketplace.json');
  const packageJson = readJson('package.json');
  const packageLock = readJson('package-lock.json');

  assert.equal(plugin.version, version);
  assert.equal(marketplace.plugins[0].version, version);
  assert.equal(packageJson.version, version);
  assert.equal(packageLock.version, version);
  assert.equal(packageLock.packages[''].version, version);
});

test('tooling package does not install Playwright', () => {
  const packageJson = readJson('package.json');
  const packageLock = readJson('package-lock.json');
  const playwrightPackages = [
    'playwright',
    '@playwright/test',
    '@playwright/cli',
  ];

  for (const packageName of playwrightPackages) {
    for (const dependencyType of [
      'dependencies',
      'devDependencies',
      'peerDependencies',
    ]) {
      assert.equal(packageName in (packageJson[dependencyType] ?? {}), false);
    }

    assert.equal(`node_modules/${packageName}` in packageLock.packages, false);
  }
});

test('tooling declares and tests its supported Node releases', () => {
  const packageJson = readJson('package.json');
  const workflow = readFileSync(
    path.join(repositoryRoot, '.github', 'workflows', 'ci.yml'),
    'utf8',
  );

  assert.equal(packageJson.engines.node, '>=22.13.0');
  assert.match(workflow, /matrix:\s*\r?\n\s+node: \[22\.13\.0, 24\]/u);
  assert.match(workflow, /node-version: \$\{\{ matrix\.node \}\}/u);
});

test('README explains the project, workflow, and safety boundary', () => {
  const readme = readFileSync(path.join(repositoryRoot, 'README.md'), 'utf8');

  assert.match(readme, /## Why Testgen/iu);
  assert.match(readme, /## How it works/iu);
  assert.match(readme, /running application/iu);
  assert.match(readme, /human checkpoint/iu);
  assert.match(readme, /disposable Git worktree/iu);
  assert.match(readme, /lint or collection validation/iu);
  assert.match(readme, /approved\s+criterion-linked mutation/iu);
  assert.match(readme, /Playwright configuration.*CI/isu);
});

test('plugin commands use portable root substitution', () => {
  let executableReferences = 0;

  for (const directory of ['agents', 'commands', 'skills']) {
    for (const file of markdownFiles(path.join(repositoryRoot, directory))) {
      const content = readFileSync(file, 'utf8');
      assert.doesNotMatch(
        content,
        /(?<!\{)\$CLAUDE_PLUGIN_ROOT/u,
        `${path.relative(repositoryRoot, file)} uses an unsubstituted plugin root`,
      );
      assert.doesNotMatch(
        content,
        /node\s+"\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\//u,
        `${path.relative(repositoryRoot, file)} relies on model-side plugin-root substitution for a Bash command`,
      );
      executableReferences += (
        content.match(/node\s+"\$PLAYWRIGHT_TESTGEN_ROOT\/scripts\//gu) ?? []
      ).length;
    }
  }

  assert.ok(executableReferences > 0);
});

test('session hook exports the installed plugin root for Bash commands', () => {
  const hooks = readJson('hooks/hooks.json');
  const sessionHook = hooks.hooks.SessionStart?.[0]?.hooks?.[0];
  const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'testgen-env-'));
  const environmentFile = path.join(temporaryDirectory, 'environment');

  try {
    assert.equal(sessionHook.command, 'node');
    assert.deepEqual(sessionHook.args, [
      '${CLAUDE_PLUGIN_ROOT}/hooks/export-plugin-root.cjs',
    ]);

    const result = spawnSync(
      process.execPath,
      [path.join(repositoryRoot, 'hooks', 'export-plugin-root.cjs')],
      {
        encoding: 'utf8',
        env: { ...process.env, CLAUDE_ENV_FILE: environmentFile },
      },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '');
    assert.equal(
      readFileSync(environmentFile, 'utf8'),
      `export PLAYWRIGHT_TESTGEN_ROOT='${repositoryRoot.replaceAll('\\', '/')}'\n`,
    );
  } finally {
    rmSync(temporaryDirectory, { force: true, recursive: true });
  }
});

test('workflow guidance removes avoidable pre-Author ambiguity', () => {
  const skill = readFileSync(
    path.join(repositoryRoot, 'skills', 'playwright-testgen', 'SKILL.md'),
    'utf8',
  );
  const pipeline = readFileSync(
    path.join(
      repositoryRoot,
      'skills',
      'playwright-testgen',
      'references',
      'pipeline.md',
    ),
    'utf8',
  );
  const mutationCheck = readFileSync(
    path.join(
      repositoryRoot,
      'skills',
      'playwright-testgen',
      'references',
      'mutation-check.md',
    ),
    'utf8',
  );
  const author = readFileSync(
    path.join(repositoryRoot, 'agents', 'playwright-test-author.md'),
    'utf8',
  );
  const healer = readFileSync(
    path.join(repositoryRoot, 'agents', 'playwright-test-healer.md'),
    'utf8',
  );
  const artifactContract = readFileSync(
    path.join(
      repositoryRoot,
      'skills',
      'playwright-testgen',
      'references',
      'artifact-contract.md',
    ),
    'utf8',
  );
  const locatorPolicy = readFileSync(
    path.join(
      repositoryRoot,
      'skills',
      'playwright-testgen',
      'references',
      'locator-policy.md',
    ),
    'utf8',
  );
  const testPolicy = readFileSync(
    path.join(
      repositoryRoot,
      'skills',
      'playwright-testgen',
      'references',
      'test-policy.md',
    ),
    'utf8',
  );

  assert.match(skill, /scripts\/runtime-preflight\.cjs.*--repo \./iu);
  assert.match(skill, /Node(?:\.js)? 22\.13/iu);
  assert.match(skill, /exploration\s+browser.*runner\s+browser/isu);
  assert.match(skill, /checks the skill file itself/iu);
  assert.match(skill, /newer\s+version is not assumed trace-compatible/iu);
  assert.match(pipeline, /actual derived\s+`scenario_ref`/iu);
  assert.match(pipeline, /application is already running/iu);
  assert.match(pipeline, /feature source.*Author/isu);
  assert.match(pipeline, /evaluation metadata.*not.*profile/isu);
  assert.match(pipeline, /without a project `tsconfig`/iu);
  assert.match(pipeline, /runtime preflight: passed/iu);
  assert.match(pipeline, /approved spec filter argument/iu);
  assert.match(mutationCheck, /Run mutation check/iu);
  assert.match(mutationCheck, /checkout is not changed/iu);
  assert.match(
    mutationCheck,
    /literal `--repo \.`.*repository-relative adapter path/isu,
  );
  assert.match(author, /never enumerate the repository\s+with `\*\*\/\*`/iu);
  assert.doesNotMatch(
    author,
    /references\/(?:artifact-contract|vacuity-policy)\.md/iu,
  );
  assert.match(author, /schemas\/author-handoff\.v1\.schema\.json/iu);
  assert.match(author, /native `Grep` tool.*do not use Bash/isu);
  assert.match(
    author,
    /convention scans.*separate.*five-call grounding budget/isu,
  );
  assert.match(author, /after every action that may navigate/iu);
  assert.match(
    author,
    /inherited `PLAYWRIGHT_MCP_\*`.*`PLAYWRIGHT_CLI_SESSION`.*blocker/isu,
  );
  assert.doesNotMatch(author, /references\/pipeline\.md/iu);
  assert.match(author, /stop and return the missing\s+prerequisite to Main/iu);
  assert.match(
    author,
    /rm -rf -- \.playwright-cli\/testgen\/<run_id>\/\.playwright-cli/iu,
  );
  assert.match(healer, /do not repeat the runtime\s+preflight/iu);
  assert.doesNotMatch(healer, /references\/artifact-contract\.md/iu);
  assert.match(healer, /schemas\/healer-trace\.v2\.schema\.json/iu);
  assert.match(healer, /stop and return the missing prerequisite to\s+Main/iu);
  assert.match(healer, /hook rejection.*does not consume an\s+attempt/isu);
  assert.match(
    healer,
    /interrupted.*explicit human approval.*new workflow run/isu,
  );
  assert.doesNotMatch(healer, /references\/pipeline\.md/iu);
  assert.match(healer, /do not inspect inactive fixture variants/iu);
  assert.match(healer, /exact output path returned by Bash.*use\s+`Read`/isu);
  assert.match(healer, /pause-at.*approved.*spec.*positive line/isu);
  assert.match(
    healer,
    /complete trace.*one whole-file `Write`.*validate\s+once/isu,
  );
  assert.match(healer, /overwrite.*whole-file `Write`/isu);
  assert.match(healer, /Never use `Edit` on\s+the trace/iu);
  assert.match(
    healer,
    /First operations.*`Read`.*healer input.*trace draft.*approved spec/isu,
  );
  assert.match(healer, /Do not recompute.*starting digest/iu);
  assert.match(healer, /Put one command in one\s+Bash call/iu);
  assert.match(
    author,
    /collection command.*bare.*own Bash call.*final spec.*assertion line/isu,
  );
  assert.match(
    artifactContract,
    /attempt summary.*behavior-focused sentence.*200 characters/isu,
  );
  assert.match(
    readFileSync(
      path.join(
        repositoryRoot,
        'skills',
        'playwright-testgen',
        'references',
        'healing-protocol.md',
      ),
      'utf8',
    ),
    /attempt\s+directory and candidate in two separate Bash calls/isu,
  );
  assert.match(
    artifactContract,
    /raw selectors.*only.*`locators\[\]\.locator`/isu,
  );
  assert.match(artifactContract, /use `Read`.*never use Bash/isu);
  assert.match(locatorPolicy, /candidate, not proof/iu);
  assert.match(
    locatorPolicy,
    /up to four.*count-only.*one exact attribute spelling/isu,
  );
  assert.match(locatorPolicy, /literal.*Git Bash/isu);
  assert.match(testPolicy, /loop.*same collection.*non-empty/isu);
  assert.match(testPolicy, /comparison.*both sides.*non-empty/isu);
  assert.doesNotMatch(skill, /references\/vacuity-policy\.md/iu);
  assert.match(
    mutationCheck,
    /change-manifest\.json.*pre-author.*checkpoint.*post-healer/isu,
  );
  assert.match(
    mutationCheck,
    /vacuity-report\.json.*Execution.*mutation verification/isu,
  );
  assert.match(mutationCheck, /no prepared adapter.*do not ask.*digest/isu);
  assert.match(
    mutationCheck,
    /no approved adapter exists.*```sh\s*node "\$PLAYWRIGHT_TESTGEN_ROOT\/scripts\/mutation-check\.cjs" verify --repo \. --run-id <run_id> --criterion-id <criterion_id>\s*```.*omit only `--adapter`, `--mutation-id`, and `--approval-digest`/isu,
  );
  assert.match(
    readFileSync(
      path.join(
        repositoryRoot,
        'skills',
        'playwright-testgen',
        'references',
        'healing-protocol.md',
      ),
      'utf8',
    ),
    /startup fails.*reservation.*consumed.*refuse.*reuse/isu,
  );
});

test('ships bounded Explorer discovery as a transient human decision', () => {
  const scenarioSourcingPath = path.join(
    repositoryRoot,
    'skills',
    'playwright-testgen',
    'references',
    'scenario-sourcing.md',
  );
  const explorer = readFileSync(
    path.join(repositoryRoot, 'agents', 'playwright-test-explorer.md'),
    'utf8',
  );
  const artifactContract = readFileSync(
    path.join(
      repositoryRoot,
      'skills',
      'playwright-testgen',
      'references',
      'artifact-contract.md',
    ),
    'utf8',
  );

  assert.equal(existsSync(scenarioSourcingPath), true);
  const scenarioSourcing = readFileSync(scenarioSourcingPath, 'utf8');

  assert.match(explorer, /tools: Bash, Glob, Grep, Read/iu);
  assert.match(explorer, /90 seconds.*ten source\/test `Read` calls/isu);
  assert.match(explorer, /agent-enforced.*hooks.*do not count/isu);
  assert.match(explorer, /at most five.*Do not fill a\s+quota/isu);
  assert.match(explorer, /A title-only list is invalid/iu);
  assert.match(explorer, /Discovery summary.*Reads: <count>\/10/isu);
  assert.match(
    explorer,
    /bare implementation mechanics prove current behavior, not what\s+the product intended/iu,
  );
  assert.match(
    explorer,
    /Source counts as intended-behavior evidence only when it\s+explicitly states a product rule or contract/iu,
  );
  assert.match(explorer, /`no supported proposal`/iu);
  assert.match(scenarioSourcing, /policy_kind.*discovery/isu);
  assert.match(scenarioSourcing, /agent-enforced.*hooks.*do not count/isu);
  assert.match(
    scenarioSourcing,
    /Selection never approves a spec path,\s+execution,\s+or mutation/iu,
  );
  assert.match(
    scenarioSourcing,
    /Bare implementation\s+mechanics and live observation are current-behavior evidence, not\s+intended-behavior evidence/iu,
  );
  assert.match(
    scenarioSourcing,
    /Standalone Explorer.*stops before scenario selection/isu,
  );
  assert.match(artifactContract, /transient, untrusted discovery output/iu);
});

test('ships one command with explicit and discovery entry paths', () => {
  const commandPath = path.join(repositoryRoot, 'commands', 'testgen.md');
  const readme = readFileSync(path.join(repositoryRoot, 'README.md'), 'utf8');
  const skill = readFileSync(
    path.join(repositoryRoot, 'skills', 'playwright-testgen', 'SKILL.md'),
    'utf8',
  );
  const pipeline = readFileSync(
    path.join(
      repositoryRoot,
      'skills',
      'playwright-testgen',
      'references',
      'pipeline.md',
    ),
    'utf8',
  );

  assert.equal(existsSync(commandPath), true);
  assert.equal(
    existsSync(path.join(repositoryRoot, 'commands', '.gitkeep')),
    false,
  );

  const command = readFileSync(commandPath, 'utf8');
  assert.match(command, /\$ARGUMENTS/u);
  assert.match(command, /blank|whitespace.*Explorer/isu);
  assert.match(command, /original\s+acceptance\s+criteria/iu);
  assert.match(command, /(?:missing facts.*clarif|clarif.*missing facts)/isu);
  assert.match(command, /run.*adjust.*skip/isu);

  for (const document of [readme, skill, pipeline]) {
    assert.match(document, /`\/playwright-testgen:testgen(?:\s|`)/u);
    assert.doesNotMatch(document, /`\/testgen(?:\s|`)/u);
  }

  assert.match(skill, /pipeline\.md.*generation workflow/isu);
  assert.match(
    skill,
    /scenario-sourcing\.md.*Explorer.*standalone.*multi-scenario/isu,
  );
  assert.match(
    skill,
    /Do not load it.*explicit single-scenario.*standalone Author or Healer/isu,
  );
  assert.match(skill, /standalone.*full pipeline/isu);

  assert.match(pipeline, /scenario selection.*candidate checkpoint/isu);
  assert.match(pipeline, /selection never authorizes.*execution.*mutation/isu);
  assert.match(pipeline, /only.*explicit.*`run`.*Healer/isu);
  assert.match(pipeline, /mutation-not-verified/iu);
  assert.match(pipeline, /product.*environment.*stopping/isu);
  assert.match(pipeline, /standalone Author.*unexecuted spec/isu);
  assert.match(pipeline, /standalone Healer.*existing failing spec/isu);
  assert.match(pipeline, /minimal coordinator.*policy.*artifacts/isu);
  assert.match(pipeline, /never require.*passing spec.*refusal/isu);
  assert.match(
    pipeline,
    /Standalone Explorer.*delegates?\s+`playwright-testgen:playwright-test-explorer`/isu,
  );
  assert.match(
    pipeline,
    /Standalone Author.*delegates?\s+`playwright-testgen:playwright-test-author`/isu,
  );
  assert.match(
    pipeline,
    /Standalone Healer.*delegates?\s+`playwright-testgen:playwright-test-healer`/isu,
  );
  assert.match(
    pipeline,
    /Main never performs the delegated role's\s+browser, authoring, execution, or repair work/iu,
  );
});

test('ships a sequential multi-scenario queue around the existing flow', () => {
  const command = readFileSync(
    path.join(repositoryRoot, 'commands', 'testgen.md'),
    'utf8',
  );
  const skill = readFileSync(
    path.join(repositoryRoot, 'skills', 'playwright-testgen', 'SKILL.md'),
    'utf8',
  );
  const pipeline = readFileSync(
    path.join(
      repositoryRoot,
      'skills',
      'playwright-testgen',
      'references',
      'pipeline.md',
    ),
    'utf8',
  );
  const scenarioSourcingPath = path.join(
    repositoryRoot,
    'skills',
    'playwright-testgen',
    'references',
    'scenario-sourcing.md',
  );
  const cleanup = readFileSync(
    path.join(
      repositoryRoot,
      'skills',
      'playwright-testgen',
      'references',
      'cleanup-contract.md',
    ),
    'utf8',
  );

  assert.equal(existsSync(scenarioSourcingPath), true);
  const scenarioSourcing = readFileSync(scenarioSourcingPath, 'utf8');

  assert.match(command, /select one or more/iu);
  assert.match(command, /`skip`.*current scenario.*batch cancellation/isu);
  assert.match(skill, /one active scenario.*no shared mutable run policy/isu);
  assert.match(pipeline, /one active scenario.*ordered flow/isu);
  assert.doesNotMatch(
    pipeline,
    /^## (?:Scenario discovery|Sequential scenario queue)$/gmu,
  );
  assert.doesNotMatch(pipeline, /"policy_kind": "discovery"/u);

  assert.match(
    scenarioSourcing,
    /before Author writes.*duplicate scenarios.*path collisions/isu,
  );
  assert.match(
    scenarioSourcing,
    /fresh run ID.*criterion mapping.*policy.*handoff.*Healer input.*trace.*spec path/isu,
  );
  assert.match(
    scenarioSourcing,
    /then-current checkout.*earlier approved.*spec/isu,
  );
  assert.match(scenarioSourcing, /independent test data.*approved\s+reset/isu);
  assert.match(scenarioSourcing, /`skip`.*current scenario.*`not-started`/isu);
  assert.match(
    scenarioSourcing,
    /product.*environment.*authentication.*unresolved healing.*verification.*cleanup.*pause/isu,
  );
  assert.match(
    scenarioSourcing,
    /cleanup failure.*pause.*before activating the next scenario/isu,
  );
  assert.match(scenarioSourcing, /execution.*mutation approval.*never carr/isu);
  assert.match(
    scenarioSourcing,
    /final summary.*disposition.*attempts.*mutation coverage.*unresolved owner/isu,
  );
  assert.match(cleanup, /before activating the next scenario/iu);
  assert.match(cleanup, /preserve.*completed.*spec/isu);
});

# Real World App sign-in mutation adapter

This evaluation adapter checks whether one approved Playwright spec detects a
missing username validation rule on the public sign-in form.

## Prepare a target checkout

Use a fresh checkout at the revision pinned in the
[target descriptor](../target.json), separate from any running app. Requires
Node.js 22 and Yarn Classic 1.22.22. Set `$testgen` to this plugin checkout and
`$rwa` to the fresh app checkout before running these PowerShell commands:

```powershell
$adapter = Join-Path $testgen 'evals/targets/cypress-realworld-app/adapter'
$target = Get-Content (Join-Path $adapter '../target.json') -Raw | ConvertFrom-Json
git -C $rwa switch -c feature/rwa-mutation-adapter $target.source.revision
git -C $rwa apply (Join-Path $adapter 'playwright-runtime.patch')
Copy-Item (Join-Path $adapter 'playwright.config.cjs') (Join-Path $rwa 'playwright.config.cjs')
Copy-Item (Join-Path $adapter '.testgen') (Join-Path $rwa '.testgen') -Recurse
New-Item -ItemType Directory -Force (Join-Path $rwa 'tests/playwright') | Out-Null
Push-Location $rwa
yarn install --frozen-lockfile
node node_modules/playwright/cli.js install chromium
git apply --check .testgen/mutations/require-signin-username.patch
node (Join-Path $testgen 'scripts/mutation-check.cjs') digest --repo . --adapter .testgen/mutation-adapter.json --mutation-id signin-username-required
Pop-Location
```

The printed digest must match `definition_digest` in the manifest. The runtime
patch enforces LF for the runner and mutation patch to preserve approved bytes
on Windows.

## Verify with Testgen

Review the patch and runner, then commit the adapter to the target; Testgen
requires it at the recorded `HEAD`. Generate and approve a sign-in spec through
the installed workflow. Both validation assertions must be inside the approved
`test.step`, using its validated title.

Follow the [mutation-check guide](../../../../skills/playwright-testgen/references/mutation-check.md)
for approval and execution. The checker compares healthy and mutated runs. Only
a failure attributable to the approved step of the selected test counts as a
kill. Startup errors, missing or extra tests, and unrelated failures report
`error`.

## Isolation and recovery

- The runner seeds only the disposable checkout and starts its backend and
  frontend on two local ports. It links prepared dependencies; Vite's writable
  cache stays in runner-owned temporary storage.
- Ordinary Healer runs use the already running app. Mutation runs restore
  database bytes and remove their mock, dependency link, and temporary results.
- The checker owns the product patch, disposable worktree, and 120-second limit.
  On timeout, it removes the disposable checkout and results.
- Never run `yarn db:seed` during a measurement.

After a check, inspect `git status --short` and `git worktree list --porcelain`.
If `.playwright-cli/testgen/<run-id>/mutation-recovery.json` remains, follow
its paths and the guide's recovery procedure before another run.

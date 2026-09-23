# Real World App sign-in mutation adapter

This evaluation adapter checks whether one approved Playwright spec detects a
missing username validation rule on the public sign-in form.

## Prepare a target checkout

Use a fresh Cypress Real World App checkout at
`79aa5b126fdd951aab2263c8201b52aeb5f2a43c`, separate from any running app.
Node.js 22 and Yarn Classic 1.22.22 are required. Set `$testgen` to this plugin
checkout and `$rwa` to the fresh app checkout before running these PowerShell
commands.

```powershell
$adapter = Join-Path $testgen 'evals/targets/cypress-realworld-app/adapter'
git -C $rwa switch -c feature/rwa-mutation-adapter 79aa5b126fdd951aab2263c8201b52aeb5f2a43c
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

The printed digest must match `definition_digest` in the manifest. Review the
patch and runner before committing them to the target: Testgen requires the
adapter at the recorded `HEAD`. The generated spec must put both validation
assertions inside its approved `test.step`; use that step's validated title.
The runtime patch pins LF for the digest-bound runner and mutation patch so a
Windows checkout preserves their approved bytes.

## Verify with Testgen

After reviewing and committing the adapter, use the installed Testgen workflow
to generate and approve a sign-in spec. Its supervised mutation checker runs the
healthy and patched app and reports a kill only for a failure attributable to
the approved criterion. An operational `error` is never a mutation kill. The
installed Testgen mutation-check guide has the approval and verification
commands.

## Isolation and recovery

The runner seeds only the disposable checkout, links prepared dependencies,
and starts that checkout's backend and frontend on two selected local ports.
Vite's writable cache stays in runner-owned temporary storage, not the linked
dependencies.
Ordinary Healer runs use their already running app. The runner restores database
bytes and removes its mock, dependency link, and temporary results. On checker
timeout, the checker removes the disposable checkout and its temporary results.
Never run `yarn db:seed` during a measurement.

Only an error on the approved step of the one selected test reports `fail`.
Startup errors, missing or extra tests, and failures elsewhere report `error`.
The checker owns the product patch, 120-second limit, and disposable worktree;
follow `mutation-check.md` for its approval and recovery procedure.

After a check, inspect `git status --short` and `git worktree list --porcelain`.
If `.playwright-cli/testgen/<run-id>/mutation-recovery.json` remains, follow
the recorded paths and the supervised recovery procedure before another run.

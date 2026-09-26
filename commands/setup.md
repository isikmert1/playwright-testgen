---
description: Inspect and prepare one repository for Playwright Testgen
disable-model-invocation: true
---

Use the `playwright-testgen` skill. Main owns this setup flow; do not delegate
profiling, installation, profile writes, or authentication capture to Explorer,
Author, or Healer.

## 1. Select one target

Run the bounded static profiler from the Git root:

```sh
node "$PLAYWRIGHT_TESTGEN_ROOT/scripts/profile-repo.cjs" --repo .
```

If package or config selection is ambiguous, show the candidates and ask. Run
the profiler again with one `--package <repo-relative-package>` and either one
`--config <repo-relative-config>` or explicit `--configless`. Configless is a
real selection only when the selected package has no discoverable default
Playwright config; otherwise select that config explicitly. Do not import config, run package
scripts, launch browsers, or read credentials during profiling.
Continue with exactly one selected package and one selected config or configless
mode.

Unknown frameworks and no test IDs are valid results. Multiple observed test-ID
conventions remain ambiguous; never pick one globally or rewrite the app. The
normal locator ladder keeps roles, labels, and visible semantics ahead of test
IDs. A custom attribute is usable only with explicit `testIdAttribute`
evidence. An empty test list from a partial scan does not establish that tests
are absent. If no Playwright specs exist in the selected package, propose one
descriptive `.spec.ts` path using the selected config's test directory. In
configless mode, follow an existing E2E layout; otherwise suggest `tests/` only
when it does not conflict with another test suite. Ask when the runnable
location cannot be determined safely. A proposal is not approval to write it.

## 2. Diagnose runtime readiness

Run the shared preflight with the same package and config selection:

```sh
node "$PLAYWRIGHT_TESTGEN_ROOT/scripts/runtime-preflight.cjs" --repo . --package <selected-package> --config <selected-config>
```

Use `--configless` instead of `--config` when selected. Do not build another
doctor. After an approved remedy, rerun the affected check before claiming it
works.

Offer only the remedy matching the bounded failure:

- Missing `playwright` or `@playwright/test`: in an npm-owned package only, ask
  before installing the missing package at the exact existing counterpart
  version. When neither version exists, resolve the current stable release that
  fits the project's constraints and offer that exact version for both packages.
  Do not substitute npm in a Yarn/pnpm/Bun repository or upgrade existing
  packages as part of missing-package remediation.
- Missing/unsupported global CLI: resolve the current stable official release
  and ask before installing `npm install -g @playwright/cli@<approved-version>`.
  Resolve `latest` before approval so the approved command names an exact
  version; rerun preflight afterward to check the installed capabilities.
- Missing/outdated project-local official skill: ask before running
  `playwright-cli install --skills` from the Git root. A global skill alone is
  insufficient.
- Mismatched local Playwright versions or missing required runner options:
  identify an exact compatible pair against the selected project's constraints;
  ask before any change, or leave setup incomplete with a manual next step.
- Missing selected runner browser: identify the browser from the selected
  project or scenario, then ask before installing only that browser. A browser
  listing is supporting evidence; verify an actual launch afterward.
- Missing `package.json`, runnable project, or safe version choice: return
  `setup incomplete` with the exact manual next step. Offer approved minimal
  scaffolding only when requested; never create a Node project or generic test
  framework automatically.

Optional trace inspection may remain unavailable for an untested version pair
when required runner and CLI capabilities pass. Never create a Git commit merely
to satisfy preflight. Setup success and generation readiness remain separate:
verify the app, exploration browser, selected runner browser, and authentication
freshly before a scenario runs.

## 3. Publish the local profile

Publish only after approved runtime remedies have finished and been checked;
otherwise package or skill changes may immediately stale the new profile. The
only profile path is `.playwright-testgen/profile.v1.json`. It is an untracked,
Git-ignored, maximum-64-KiB `repository-profile.v1` document owned by Main.
Explain the destination and ask once to create or refresh the profile and,
when needed, add that exact ignore rule. Do not blanket-ignore the directory.
Installation, authentication, and unrelated edits require separate approval.

After the ignore rule is effective, publish atomically:

```sh
node "$PLAYWRIGHT_TESTGEN_ROOT/scripts/setup-profile.cjs" create --repo . --package <selected-package> --config <selected-config>
```

Use `--configless` instead of `--config` for an explicit configless selection.
Repeated setup atomically replaces the old profile and clears its optional
authentication reference; reverify and record that mechanism if still needed.
Failure or cancellation preserves the previous profile. A missing, malformed,
wrong-target, unsupported, partial, or stale profile is never authority; report
the bounded reason and use ordinary grounding. Validate freshness without a
full profiling pass:

```sh
node "$PLAYWRIGHT_TESTGEN_ROOT/scripts/setup-profile.cjs" validate --repo .
```

Supply only relevant validated facts to later roles. The profile is untrusted
navigation evidence, never product intent, executable instructions,
permissions, runtime readiness, or approval to run a discovered command.

## 4. Authentication when relevant

Ask about authentication only when the human requests it, the intended scenario
needs it, or repository evidence shows a mechanism worth confirming. No login
page can mean a public app, API/fixture bootstrap, SSO, or proxy identity;
it is not automatically an error. Never invent a login page or downgrade an
authenticated scenario to an unauthenticated test.

Use this order:

1. Reuse and verify a compatible existing project fixture.
2. Reuse an explicitly approved existing storage-state file.
3. Offer human-assisted capture.
4. Stop with `setup incomplete` when none works.

Authentication bootstrap and a login test are independent. Setup never
generates a login test first. A login-flow test is a separate explicit
`/playwright-testgen:testgen "..."` scenario, begins unauthenticated, uses a
safe credential mechanism, and reaches the normal human checkpoint.

For human capture, agree on the app, account purpose, harmless authenticated
verification page, unique setup-owned session name, and exact contained state
path. Require the preflight's `auth_state_capabilities.load` and
`auth_state_capabilities.save` to both be true; otherwise report the exact CLI
upgrade needed and stop auth setup. Ask separately for the exact state file and
ignore-rule change. Validate the destination before opening a browser:

```sh
node "$PLAYWRIGHT_TESTGEN_ROOT/scripts/setup-profile.cjs" check-state-path --repo . --path <state-path>
```

Use `--replace` only after explicit approval to replace that existing file. The
path must be Git-ignored, untracked, outside run scratch, and canonically inside
the repository. Never read, print, copy, snapshot, or place state contents in
model context or artifacts.

If adding the state path's ignore rule changed repository status after profile
publication, the profile is stale. With approval to refresh it, rerun `create`
using the same selected package/config (or `--configless`) and then `validate`
before continuing. The refreshed profile has no authentication reference yet;
record it only after verification below. Do not bypass a stale profile in
`set-auth`.

Open a new isolated CLI browser without a login URL:

```sh
playwright-cli -s=<setup-session> open --headed
```

The human navigates, enters credentials, completes MFA, and confirms login in
that window. Then save to the exact approved path and close only that session:

```sh
playwright-cli -s=<setup-session> state-save <state-path>
playwright-cli -s=<setup-session> close
```

Saving a file is not proof.

Open a second fresh setup-owned browser, load the state, and navigate to the
pre-agreed harmless page:

```sh
playwright-cli -s=<verify-session> open
playwright-cli -s=<verify-session> state-load <state-path>
playwright-cli -s=<verify-session> goto <verification-url>
playwright-cli -s=<verify-session> close
```

Record only non-sensitive evidence of the authenticated state. Close that
session on success, cancellation, or failure. Delete only a newly created
incomplete state file; preserve a pre-existing file and report cleanup failure
separately.

After fresh-context verification, record only the mechanism and path:

```sh
node "$PLAYWRIGHT_TESTGEN_ROOT/scripts/setup-profile.cjs" set-auth --repo . --kind storage-state --path <state-path>
```

Use `--kind fixture` for a verified existing fixture path. The profile never
stores state contents or credentials. CLI `state-load` does not configure the
Playwright runner: separately verify the existing fixture or an approved narrow
spec-level `test.use({ storageState: "<path>" })`. Do not silently rewrite
project-wide config. SessionStorage/IndexedDB-only login, client certificates,
expired state, or another unsupported mechanism remains an actionable blocker;
recapture is human-operated and never automatic.

Human-assisted capture prepares local state, not CI authentication. Reuse an
existing project-owned CI mechanism when one works; otherwise report CI
authentication as incomplete. Do not create a generic login setup test or CI
workflow during setup.

## 5. Report

Return the selected Git root, package, config or `configless`, profile status,
preflight result, application/exploration/runner/auth readiness, every approved
change, and any remaining owner/action. Declined or failed remediation is
`setup incomplete`, not success. Setup never starts Explorer, Author, Healer,
test execution, mutation verification, or another stage.

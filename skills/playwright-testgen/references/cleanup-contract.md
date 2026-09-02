# Cleanup contract

Cleanup covers both browser lifecycle and filesystem scratch. Track every
resource when it is created so each exit can release only run-owned resources.

## Run-owned resources

- Use a named Playwright CLI session derived from the supplied `run_id` when
  the workflow opens the session: the Author session is exactly `-s=<run_id>`.
  For `--debug=cli`, attach only to the exact runner-emitted session and
  associate that session with the `run_id`; never derive or rename its
  identifier.
- Main writes the transient `command-policy.json` defined by `pipeline.md`
  inside the run directory before Author starts. Keep it until the run exits
  so the shared PreToolUse hook can bind commands and navigation to that run.
- When mutation verification is available, Main also owns the transient
  `change-manifest.json` defined by `artifact-contract.md`. Retain it through
  the post-Healer mutation check so the active checkout and disposable checkout
  can be compared without storing file content.
- Main owns `vacuity-report.json`. Write and validate it only when a fixed
  result reaches the post-Healer vacuity gate, retain it until its disposition
  is accepted, then remove it with the run directory.
- Direct every workflow-controlled snapshot, download, trace, and debug file to
  `.playwright-cli/testgen/<run-id>/` in the target repository.
- Run attached Playwright CLI inspection commands with that validated run
  directory as their working directory so auto-generated CLI output remains a
  child of run-owned scratch.
- Track the Bash background task ID started for `--debug=cli`.
- Track the exact `tw-*` identifier printed by that runner. The hook validates
  its shape and run-directory use, while Healer owns the provenance check
  against the captured runner output.
- Track test-owned product data separately; its teardown follows
  `test-policy.md` and the target repository's fixtures.
- The mutation checker owns its OS-temporary detached worktree. It removes the
  exact worktree in `finally`, verifies that its registration and directory are
  gone, and rechecks the active checkout fingerprints. Never clean that
  isolation with a broad filesystem or Git command.

Do not claim ownership of pre-existing browser sessions, user browsers,
servers, profiles, ports, or files.

## Browser and process cleanup

- A session opened by the workflow ends with
  `cd <validated-run-directory> && PWTEST_CLI_GLOBAL_CONFIG=. npm exec --no -- playwright-cli -s=<session> close`.
- A session attached to an external or debug-owned browser ends with
  `cd <validated-run-directory> && PWTEST_CLI_GLOBAL_CONFIG=. npm exec --no -- playwright-cli -s=<session> detach`;
  then stop only the background test process that created the debug session.
- If a scoped close fails, report the remaining session and process identifiers.
  Do not use `close-all` or `kill-all`, because they can terminate unrelated
  user or agent sessions.
- Stop a still-running owned test process with `TaskStop` and the exact Bash
  background task ID returned when this run started it. Never infer or kill an
  operating-system PID.
- Close or detach before deleting scratch so diagnostic paths remain available
  if teardown itself fails.

## Filesystem cleanup

Resolve the exact run directory and verify it is a child of
`.playwright-cli/testgen/` before removal. Delete only that run directory;
never delete `.playwright-cli/`, the target repository, generated specs, or
other durable files. From the target repository, the bounded command is
`rm -rf -- .playwright-cli/testgen/<run-id>`; do not omit the run ID or replace
the path with a glob. While `change-manifest.json` exists, the hook reserves
full run-directory removal for Main after mutation verification; governed
agents may remove only the generated children described below.

When an active run must retain its handoff or policy, remove raw browser output
only through exact run children: `.playwright-cli` for Author exploration, or
one named `attempt-1` through `attempt-5` directory. Never remove another child
or use a wildcard.

Raw snapshots, screenshots, videos, trace archives, DOM dumps, downloads, and
runner logs controlled by this workflow are transient and belong in the run
directory. When the target runner creates configured output elsewhere, report
its repository-relative path and leave it target-owned rather than deleting
outside the validated boundary. The validated handoff, trace, and vacuity
report may remain only while the run is active or paused for a human decision.
Remove them after the final disposition has been reported and accepted.

## Exit behavior

- **Author reaches checkpoint** — Close Author's CLI session, remove raw
  exploration evidence, and retain the validated handoff.
- **`adjust`** — Close the Author session and remove only superseded raw
  exploration evidence. Preserve the same run ID, command policy, pre-Author
  change-manifest boundary, candidate, and handoff for the Author revision.
- **`skip`** — Close any accidentally live session, remove run scratch, and
  retain the generated spec as explicitly unverified.
- **Healer reports `fixed`** — Stop the owned runner, close or detach the
  session, retain the sanitized run artifacts through any approved mutation
  check, write and validate the vacuity report, report its disposition, then
  remove run scratch after acceptance.
- **Healer reports a final nonfixed result** — Stop the owned runner, close or
  detach the session, report Healer's final disposition, then remove run scratch
  after acceptance.
- **Waiting for user input** — Stop the runner and close or detach immediately;
  retain only the sanitized validated JSON needed to resume.
- **Interruption, cancellation, or error** — Perform the same best-effort scoped
  teardown before returning.

A cleanup failure is reported separately with the exact owned resource still
present. It never changes the test failure's classification or authorizes broad
deletion.

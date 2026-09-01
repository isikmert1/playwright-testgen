# Cleanup contract

Cleanup covers both browser lifecycle and filesystem scratch. Track every
resource when it is created so each exit can release only run-owned resources.

## Run-owned resources

- Use a named Playwright CLI session derived from the supplied `run_id`.
- Direct every workflow-controlled snapshot, download, trace, and debug file to
  `.playwright-cli/testgen/<run-id>/` in the target repository.
- Track the background test process started for `--debug=cli`.
- Track test-owned product data separately; its teardown follows
  `test-policy.md` and the target repository's fixtures.

Do not claim ownership of pre-existing browser sessions, user browsers,
servers, profiles, ports, or files.

## Browser and process cleanup

- A session opened by the workflow ends with
  `npm exec --no -- playwright-cli -s=<session> close`.
- A session attached to an external or debug-owned browser ends with
  `npm exec --no -- playwright-cli -s=<session> detach`; then stop only the
  background test process that created the debug session.
- If a scoped close fails, report the remaining session and process identifiers.
  Do not use `close-all` or `kill-all`, because they can terminate unrelated
  user or agent sessions.
- Close or detach before deleting scratch so diagnostic paths remain available
  if teardown itself fails.

## Filesystem cleanup

Resolve the exact run directory and verify it is a child of
`.playwright-cli/testgen/` before removal. Delete only that run directory;
never delete `.playwright-cli/`, the target repository, generated specs, or
other durable files.

Raw snapshots, screenshots, videos, trace archives, DOM dumps, downloads, and
runner logs controlled by this workflow are transient and belong in the run
directory. When the target runner creates configured output elsewhere, report
its repository-relative path and leave it target-owned rather than deleting
outside the validated boundary. The validated handoff and trace may remain only
while the run is active or paused for a human decision. Remove them after the
final disposition has been reported and accepted.

## Exit behavior

- **Author reaches checkpoint** — Close Author's CLI session, remove raw
  exploration evidence, and retain the validated handoff.
- **`adjust`** — Clean the superseded run resources before Author starts the
  revision.
- **`skip`** — Close any accidentally live session, remove run scratch, and
  retain the generated spec as explicitly unverified.
- **Healer reports `fixed` or a final nonfixed result** — Stop the owned runner,
  close or detach the session, report the result, then remove run scratch after
  acceptance.
- **Waiting for user input** — Stop the runner and close or detach immediately;
  retain only the sanitized validated JSON needed to resume.
- **Interruption, cancellation, or error** — Perform the same best-effort scoped
  teardown before returning.

A cleanup failure is reported separately with the exact owned resource still
present. It never changes the test failure's classification or authorizes broad
deletion.

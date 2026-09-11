---
name: playwright-testgen
description: Use when turning one written scenario into a grounded Playwright end-to-end spec, or running and repairing a spec produced by that workflow.
license: Apache-2.0
---

# Playwright Testgen

Produce one grounded Playwright spec from one written scenario, then verify it
without weakening its intent. Source explains intended behavior; the running
application proves what actually renders.

## Runtime boundary

Run the workflow inside the repository being tested. It must already
provide its local `playwright` and `@playwright/test` runtime. The current
official `@playwright/cli` must be installed globally so its documented
`playwright-cli` command is available without depending on the repository's
`node_modules` layout. Never install or resolve these dependencies from this
plugin repository. Testgen requires Node.js 22.13 or later.

The SessionStart hook exports `PLAYWRIGHT_TESTGEN_ROOT` as the installed plugin
directory for Bash commands. Use `$PLAYWRIGHT_TESTGEN_ROOT/scripts/...` for
every bundled script without printing, resolving, or probing the variable. If a
documented script call reports it missing, stop and ask the human to restart
Claude Code after installing or reloading the plugin. Never infer it from
`SKILL.md`, search for another checkout, or hardcode a development path.

Main runs one read-only preflight from the repository's package directory before
every generation:

```sh
node "$PLAYWRIGHT_TESTGEN_ROOT/scripts/runtime-preflight.cjs" --repo .
```

Run it bare from the repository root; do not prefix it with `cd`, combine it
with another command, or append discovery probes. It resolves and records the
repository's local `playwright` and `@playwright/test`, the global
`playwright-cli`, its installed project skill, required runner/CLI capabilities,
Git HEAD, hook dependency readiness, and the supported trace snapshot spelling.
It checks the skill file itself and does not rely on the obsolete `Agent skill:`
help heading. `ok: false` stops before Author with the reported bounded reason;
an unborn or missing Git HEAD is `git-head-unavailable`. Never create a commit
or install anything to make preflight pass.

Node must be 22.13 or newer and the CLI must be 0.1.19 or newer. A newer
version is not assumed trace-compatible: unknown combinations leave optional
trace snapshot inspection unavailable while the required workflow can continue.
Run the official install from the same Node/npm environment that launches the
agent; a different global npm prefix does not satisfy this check.

Preflight does not launch the application or a browser. Before Author, Main
records separate fresh facts for authentication, the application at the
approved origin, the Playwright CLI exploration browser, and the repository
runner browser selected by existing config and project. Reuse equivalent fresh
readiness evidence; do not launch a second browser merely for preflight. Do not
hardcode Chromium or change repository configuration. A browser installation
listing is supporting evidence, not proof that the selected local Playwright
version can launch it; stop when readiness cannot be confirmed.

`/setup` is planned but not shipped. Until it exists, Main offers only the
relevant official remediation:

- install or update the CLI: `npm install -g @playwright/cli@latest`
- install the skill from the repository: `playwright-cli install --skills`

Never run an installation without user approval. Author never installs or
updates packages or skills. The official skill owns CLI command mechanics only.
This skill owns criteria, orchestration, checkpoints, handoffs, and healing,
and wins when the workflows differ.

## Core flow

Keep writes single-threaded. After preflight, Main delegates the Author stage to
`playwright-testgen:playwright-test-author`; Main never performs Author work.
Author grounds the scenario, explores the running application, writes and
validates the spec, emits its handoff, and stops without running the test. A human then
chooses `run`, `skip`, or `adjust`; never auto-advance. `skip` ends with the spec
unverified, `adjust` returns the scenario to Author, and only `run` lets Main
delegate a fresh-context `playwright-testgen:playwright-test-healer` with the
run ID, repository root, exact approved spec, original criteria, validated
handoff, passed-preflight fact, approved spec-filter argument, and known runner,
route, auth, environment, and data facts. Healer
executes, diagnoses, makes bounded repairs, and reports its trace; Main never
performs Healer work. A validated `fixed` trace enters Main's vacuity gate:
Main runs one approved criterion-linked product mutation when available,
writes and validates `vacuity-report.json`, then reports the validator's
separate execution and mutation-verification summary plus its derived
disposition. Without an adapter, record mutation verification as unavailable;
unless a separate assertion-sensitivity check ran, its status is `not-run`.
Skipped runs remain `generated-unverified`; nonfixed runs keep their Healer
disposition. Both bypass this gate.

## Reference loading

Load references only when their condition applies. Do not bulk-read them or
create a second routing layer.

- [pipeline.md](references/pipeline.md) — Read this when starting this skill's generation workflow or its post-checkpoint run or repair path, to establish ordering, ownership, checkpoints, and handoffs.
- [test-policy.md](references/test-policy.md) — Read this when planning, writing, or revising a spec or helper.
- [locator-policy.md](references/locator-policy.md) — Read this when choosing, verifying, or changing any locator.
- [failure-taxonomy.md](references/failure-taxonomy.md) — Read this when a run fails, before assigning its cause, remedy, or next owner.
- [healing-protocol.md](references/healing-protocol.md) — Read this when Healer is authorized to run or debug a spec, and before repairing a failure.
- [artifact-contract.md](references/artifact-contract.md) — Main reads this before starting Author and when validating or consuming an Author handoff or Healer trace.
- [mutation-check.md](references/mutation-check.md) — Read this before approving any mutation adapter, and after a fixed Healer result to run the approved mutation or record that verification is unavailable.
- [cleanup-contract.md](references/cleanup-contract.md) — Read this when browser sessions or scratch artifacts may be created, and before any exit path.

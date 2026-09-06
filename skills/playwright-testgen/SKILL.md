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

Run the workflow inside the target repository. That repository must already
provide its local `playwright` and `@playwright/test` runtime. The current
official `@playwright/cli` must be installed globally so its documented
`playwright-cli` command is available without depending on the target's
`node_modules` layout. Never install or resolve these dependencies from this
plugin repository.

The SessionStart hook exports `PLAYWRIGHT_TESTGEN_ROOT` as the installed plugin
directory for Bash commands. Use `$PLAYWRIGHT_TESTGEN_ROOT/scripts/...` for
every bundled script. If it is missing, stop and ask the human to restart
Claude Code after installing or reloading the plugin. Never infer it from
`SKILL.md`, search for another checkout, or hardcode a development path.

Main runs this read-only preflight from the target package directory before
every generation:

```sh
node --version
node -e "for (const id of ['playwright/package.json','@playwright/test/package.json']) require.resolve(id)"
playwright-cli --version
playwright-cli --help
```

Run each line as a separate Bash call from the target repository root. Do not
prefix it with `cd`, combine it with another command, or append discovery
probes. Use `Read`, `Glob`, or `Grep` separately for repository discovery.

The CLI must be version 0.1.19 or newer. Its help must list `attach`, `find`,
`generate-locator`, and `requests`, and print an `Agent skill:` path. Treat the
warning `The playwright-cli skill at '<path>' does not match the tool version.`
as outdated. If any package, CLI capability, or skill is missing or outdated,
stop before Author. Run the official install from the same Node/npm environment
that launches the agent; a different global npm prefix does not satisfy this
check.

`/setup` is planned but not shipped. Until it exists, Main offers only the
relevant official remediation:

- install or update the CLI: `npm install -g @playwright/cli@latest`
- install the skill for the target repository: `playwright-cli install --skills`

Never run an installation without user approval. Author never installs or
updates packages or skills. The official skill owns CLI command mechanics only.
This skill owns criteria, orchestration, checkpoints, handoffs, and healing,
and wins when the workflows differ.

## Core flow

Keep writes single-threaded. After preflight, Main delegates the Author stage to
`playwright-testgen:playwright-test-author`; Main never performs Author work.
Author grounds the scenario, explores the running application, writes and lints
the spec, emits its handoff, and stops without running the test. A human then
chooses `run`, `skip`, or `adjust`; never auto-advance. `skip` ends with the spec
unverified, `adjust` returns the scenario to Author, and only `run` lets Main
delegate a fresh-context `playwright-testgen:playwright-test-healer` with the
run ID, target repository, exact approved spec, original criteria, validated
handoff, passed-preflight fact, approved spec-filter argument, and known runner,
route, auth, environment, and data facts. Healer
executes, diagnoses, makes bounded repairs, and reports its trace; Main never
performs Healer work. A validated `fixed` trace enters Main's vacuity gate:
Main runs one approved criterion-linked product mutation when available,
writes and validates `vacuity-report.json`, and reports only its derived
disposition. Without an adapter, record mutation verification as unavailable;
unless a separate assertion-sensitivity check ran, its status is `not-run`.
Skipped runs remain `generated-unverified`; nonfixed runs keep their Healer
disposition. Both bypass this gate.

## Reference loading

Load references only when their condition applies. Do not bulk-read them or
create a second routing layer.

- [pipeline.md](references/pipeline.md) — Read this when starting this skill's generation workflow or its post-checkpoint run or repair path, to establish ordering, ownership, checkpoints, and handoffs.
- [test-policy.md](references/test-policy.md) — Read this when planning, writing, or revising a spec or helper.
- [vacuity-policy.md](references/vacuity-policy.md) — Read this when planning, writing, or revising assertions, and during Author's pre-write self-check.
- [locator-policy.md](references/locator-policy.md) — Read this when choosing, verifying, or changing any locator.
- [failure-taxonomy.md](references/failure-taxonomy.md) — Read this when a run fails, before assigning its cause, remedy, or next owner.
- [healing-protocol.md](references/healing-protocol.md) — Read this when Healer is authorized to run or debug a spec, and before repairing a failure.
- [artifact-contract.md](references/artifact-contract.md) — Read this before starting Author to create the run ID, and when creating, validating, or consuming an Author handoff, Healer trace, or vacuity report.
- [mutation-check.md](references/mutation-check.md) — Read this before approving any mutation adapter, and after a fixed Healer result to run the approved mutation or record that verification is unavailable.
- [cleanup-contract.md](references/cleanup-contract.md) — Read this when browser sessions or scratch artifacts may be created, and before any exit path.

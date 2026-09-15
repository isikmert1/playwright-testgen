---
name: playwright-testgen
description: Use when discovering Playwright scenarios, turning human-approved scenarios into grounded end-to-end specs, or running and repairing a spec produced by that workflow.
license: Apache-2.0
---

# Playwright Testgen

Produce grounded Playwright specs from one or more human-approved scenarios,
then verify each without weakening its intent. Source explains intended
behavior; the running application proves what actually renders.

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

Main coordinates; Explorer proposes, Author writes, Healer runs and repairs,
and the human owns every selection and checkpoint. Keep writes single-threaded,
one active scenario, and no shared mutable run policy. Never auto-advance:
scenario selection authorizes neither execution nor mutation, and only an
explicit `run` at the candidate checkpoint dispatches Healer.

`/playwright-testgen:testgen` with an explicit scenario skips Explorer and
preserves the original criteria. Blank input uses Explorer; multiple selections
form a sequential queue whose approvals, artifacts, result, and cleanup remain
scenario-scoped. The detailed generation workflow and stopping outcomes live in
`pipeline.md`.

Explorer, Author, and Healer also support explicit standalone requests without
entering the full pipeline. Main remains the minimal coordinator: it establishes
intent and readiness, creates the role's policy and artifacts, validates the
result, delegates the named role, applies cleanup, and stops. Main never performs
the delegated role's browser, authoring, execution, or repair work. Standalone
Explorer returns proposals only; standalone Author returns one unexecuted
candidate spec; standalone Healer may repair one human-approved existing failing
spec and stops without a vacuity stage. No role creates its own authority,
infers missing intent, or silently starts another stage.

## Reference loading

Load references only when their condition applies. Do not bulk-read them or
create a second routing layer.

- [pipeline.md](references/pipeline.md) — Read this when starting this skill's generation workflow or its post-checkpoint run or repair path, to establish ordering, ownership, checkpoints, and handoffs.
- [scenario-sourcing.md](references/scenario-sourcing.md) — Read whenever Main coordinates Explorer in the full pipeline or standalone mode, including a supplied discovery scope, or manages a multi-scenario queue. Do not load it for explicit single-scenario generation or standalone Author or Healer work.
- [test-policy.md](references/test-policy.md) — Read this when planning, writing, or revising a spec or helper.
- [locator-policy.md](references/locator-policy.md) — Read this when choosing, verifying, or changing any locator.
- [failure-taxonomy.md](references/failure-taxonomy.md) — Read this when a run fails, before assigning its cause, remedy, or next owner.
- [healing-protocol.md](references/healing-protocol.md) — Read this when Healer is authorized to run or debug a spec, and before repairing a failure.
- [artifact-contract.md](references/artifact-contract.md) — Main reads this before starting Author and when validating or consuming an Author handoff, Healer input, or Healer trace.
- [mutation-check.md](references/mutation-check.md) — Read this before approving any mutation adapter, and after a fixed Healer result to run the approved mutation or record that verification is unavailable.
- [cleanup-contract.md](references/cleanup-contract.md) — Read this when browser sessions or scratch artifacts may be created, and before any exit path.

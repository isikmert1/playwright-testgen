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
provide its required Playwright runtime, including `playwright`,
`@playwright/test`, and `@playwright/cli`. Never install or resolve those
packages from this plugin repository.

Main runs this read-only preflight from the target package directory before
every generation, even when a `/setup` profile exists:

```sh
node -e "for (const id of ['playwright/package.json','@playwright/test/package.json','@playwright/cli/package.json']) require.resolve(id)"
npm exec --no -- playwright-cli --help
```

The help output must identify an installed, current official `playwright-cli`
skill. If any package or the skill is missing or outdated, stop before Author.
When `/setup` is available, it owns guided detection and approved remediation;
its prior result never replaces this runtime preflight. Until `/setup` ships,
Main offers one explicit manual choice for the skill:

- project-local: `npm exec --no -- playwright-cli install --skills`
- user-global: `npm exec --no -- playwright-cli install --skills=agents -g`

Never run either installation without user approval. Author never installs or
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
handoff, and known runner, route, auth, environment, and data facts. Healer
executes, diagnoses, makes bounded repairs, and reports its trace; Main never
performs Healer work.

## Reference loading

Load references only when their condition applies. Do not bulk-read them or
create a second routing layer.

- [pipeline.md](references/pipeline.md) — Read this when starting this skill's generation workflow or its post-checkpoint run or repair path, to establish ordering, ownership, checkpoints, and handoffs.
- [test-policy.md](references/test-policy.md) — Read this when planning, writing, or revising a spec or helper.
- [vacuity-policy.md](references/vacuity-policy.md) — Read this when planning, writing, or revising assertions, and during Author's pre-write self-check.
- [locator-policy.md](references/locator-policy.md) — Read this when choosing, verifying, or changing any locator.
- [failure-taxonomy.md](references/failure-taxonomy.md) — Read this when a run fails, before assigning its cause, remedy, or next owner.
- [healing-protocol.md](references/healing-protocol.md) — Read this when Healer is authorized to run or debug a spec, and before repairing a failure.
- [artifact-contract.md](references/artifact-contract.md) — Read this before starting Author to create the run ID, and when creating, validating, or consuming an Author handoff or Healer trace.
- [cleanup-contract.md](references/cleanup-contract.md) — Read this when browser sessions or scratch artifacts may be created, and before any exit path.

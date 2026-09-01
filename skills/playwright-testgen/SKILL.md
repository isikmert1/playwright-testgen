---
name: playwright-testgen
description: Use when turning one written scenario into a grounded Playwright end-to-end spec, or running and repairing a spec produced by that workflow.
---

# Playwright Testgen

Produce one grounded Playwright spec from one written scenario, then verify it
without weakening its intent. Source explains intended behavior; the running
application proves what actually renders.

## Runtime boundary

Run the workflow inside the target repository. That repository must already
provide its required Playwright runtime, including `playwright`,
`@playwright/test`, and `@playwright/cli`. Do not install, vendor, or resolve
those packages from this plugin repository. If a required local package is
missing, stop and report the target-repository prerequisite.

## Core flow

Keep writes single-threaded. Author grounds the scenario, explores the running
application, writes and lints the spec, emits its handoff, and stops without
running the test. A human then chooses `run`, `skip`, or `adjust`; never
auto-advance. `skip` ends with the spec unverified, `adjust` returns the
scenario to Author, and only `run` lets Healer execute, diagnose, make bounded
repairs, and report its trace.

## Reference loading

Load references only when their condition applies. Do not bulk-read them or
create a second routing layer.

- [pipeline.md](references/pipeline.md) — Read this when starting this skill's generation workflow or its post-checkpoint run or repair path, to establish ordering, ownership, checkpoints, and handoffs.
- [test-policy.md](references/test-policy.md) — Read this when planning, writing, or revising a spec or helper.
- [locator-policy.md](references/locator-policy.md) — Read this when choosing, verifying, or changing any locator.
- [failure-taxonomy.md](references/failure-taxonomy.md) — Read this when a run fails, before assigning its cause, remedy, or next owner.
- [healing-protocol.md](references/healing-protocol.md) — Read this when Healer is authorized to run or debug a spec, and before repairing a failure.
- [artifact-contract.md](references/artifact-contract.md) — Read this before starting Author to create the run ID, and when creating, validating, or consuming an Author handoff or Healer trace.
- [cleanup-contract.md](references/cleanup-contract.md) — Read this when browser sessions or scratch artifacts may be created, and before any exit path.

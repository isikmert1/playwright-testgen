---
description: Discover Playwright scenarios or generate grounded specs
argument-hint: [scenario description]
disable-model-invocation: true
---

Use the `playwright-testgen` skill and its pipeline contract.

Treat the text below as the optional scenario description:

<scenario>
$ARGUMENTS
</scenario>

- If it is blank or whitespace, run Explorer, present its bounded proposals,
  and wait for the human to select one or more before starting generation.
- Otherwise skip Explorer, preserve the scenario's original acceptance
  criteria, and clarify missing facts instead of inventing them.

One selection uses the existing one-scenario flow. Process multiple selections
as a sequential queue with one active scenario and one fresh run at a time.
Every scenario reaches its own candidate checkpoint before the next begins.
Keep selection separate from `run`, `adjust`, or `skip`: `skip` applies only to
the current scenario, `adjust` returns the exact human feedback to Author, and
only an explicit `run` dispatches Healer. Explicit batch cancellation marks all
remaining scenarios `not-started`. Mutation approval remains separate for each
scenario. A missing adapter ends a fixed run as `mutation-not-verified`;
product or environment failures remain valid stopping outcomes, pause the
queue, and do not require a passing spec.

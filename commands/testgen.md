---
description: Discover Playwright scenarios or generate one grounded spec
argument-hint: [scenario description]
disable-model-invocation: true
---

Use the `playwright-testgen` skill and its pipeline contract.

Treat the text below as the optional scenario description:

<scenario>
$ARGUMENTS
</scenario>

- If it is blank or whitespace, run Explorer, present its bounded proposals,
  and wait for one human-selected scenario before starting generation.
- Otherwise skip Explorer, preserve the scenario's original acceptance
  criteria, and clarify missing facts instead of inventing them.

Both paths stop at the candidate checkpoint after Author. Keep scenario
selection separate from `run`, `adjust`, or `skip`: `skip` never executes the
spec, `adjust` returns the exact human feedback to Author, and only an explicit
`run` dispatches Healer. Mutation approval remains separate. A missing adapter
ends a fixed run as `mutation-not-verified`; product or environment failures
remain valid stopping outcomes and do not require a passing spec.

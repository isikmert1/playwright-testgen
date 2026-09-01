# Failure taxonomy

Assign exactly one classification to the current failure. A classification is
a cause with a defined owner and remedy; it is not a final pipeline status.

- **`selector-drift`** — The intended target exists, but the locator does not
  resolve to exactly one visible active element. The Healer rebuilds it from
  current count-one evidence.
- **`timing`** — The intent and target are correct, but the test waits on an
  insufficient observable state. The Healer waits on the specific observable
  next state.
- **`expectation-drift`** — A grounded value or route changed while the written
  intent remains satisfied. The Healer changes only the proven value or route.
- **`intent-wrong`** — Criteria were misread, required steps are absent, or a
  repair requires a broad rewrite. Return the evidence and original criteria to
  the Author for revision.
- **`environment-or-auth`** — A fixture, service, account state, project
  configuration, or authentication prevents a reliable run. Stop and request
  the missing user action or environment repair.
- **`product-behavior-wrong`** — The written criterion and observed product
  behavior cannot both be true. Preserve the test and report the finding to the
  product owner.
- **`unresolved`** — Bounded evidence cannot safely distinguish another class.
  Stop at the healing limit and report the competing hypotheses.

Do not use `expectation-drift` merely because changing an expected value would
make the test pass. Evidence must show the new value still satisfies the
original criterion.

## Product-behavior evidence bar

Classify `product-behavior-wrong` only when the trace records all three:

1. The relevant criterion, identified without storing its full source body.
2. The observed behavior, summarized from current live or trace evidence.
3. Why the criterion and observation cannot both be true.

If any part is missing, use `unresolved`. Never edit the assertion, product
code, fixture, or environment to erase a product-behavior failure.

## Matching signatures

A failure signature combines the spec and step, error type, normalized message,
locator or assertion target, and observed state. Normalize timestamps, random
IDs, ports, and other volatile values only; do not normalize away the behavior
that distinguishes hypotheses.

Two consecutive matching signatures with no new evidence or hypothesis trigger
the early stop in `healing-protocol.md`.

When Author encounters criteria/product disagreement before execution, it
follows `test-policy.md`: keep the written assertion and report the mismatch.
Healer applies this taxonomy only to evidence from an approved run.

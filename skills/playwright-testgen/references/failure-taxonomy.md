# Failure taxonomy

Assign exactly one classification to the current failure. A classification is
a cause with a defined owner and remedy; it is not a final pipeline status.

## Classification order

Classify the cause, not the easiest edit that could make the test pass. Use the
first supported outcome:

1. If fixtures, services, account state, project configuration, or
   authentication make the run unreliable, use `environment-or-auth`.
2. If the spec omits or misrepresents a criterion, or needs a broad rewrite,
   use `intent-wrong`.
3. If the target or observation is not yet reliable because locator uniqueness,
   visibility, or an observable wait is wrong, use `selector-drift` or `timing`.
4. With a faithful spec and reliable observation, use `expectation-drift` only
   when the observed value or route still satisfies the criterion. When the
   criterion and observation cannot both be true, apply the product-behavior
   evidence bar below.
5. If bounded evidence cannot support one of those decisions, use `unresolved`.

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
  configuration, or authentication prevents a reliable run. The Healer stops
  and asks the human for the missing action or environment repair.
- **`product-behavior-wrong`** — The written criterion and observed product
  behavior cannot both be true. Preserve the test and report the finding to the
  product owner.
- **`unresolved`** — Bounded evidence cannot safely distinguish another class.
  The Healer stops at the healing limit and routes the competing hypotheses to
  the human.

Do not use `expectation-drift` merely because changing an expected value would
make the test pass. Evidence must show the new value still satisfies the
original criterion; if the criterion requires the previous value, it is not
drift.

## Product-behavior evidence bar

Before applying this bar, confirm the spec faithfully represents the criterion;
otherwise use `intent-wrong`. Classify `product-behavior-wrong` only when the
trace records all three:

1. The criterion identifier and a bounded summary of its required outcome,
   without storing the full source body.
2. The observed behavior from current live or trace evidence, including enough
   evidence that the intended action ran from the expected precondition and was
   not blocked by environment or authentication.
3. Why the criterion and observation cannot both be true and why
   `expectation-drift` does not apply.

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

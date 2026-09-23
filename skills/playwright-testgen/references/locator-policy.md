# Locator policy

Every locator must be grounded in the current rendered state. Source markup is
a hypothesis, not proof that a target exists or is unique at runtime.

## Verification gate

Before writing a locator into the spec:

1. Navigate the live app to the exact UI state where it will be used.
2. Build the candidate with the highest available rung below.
3. Verify it resolves to exactly one element in that state.
4. Verify that element is visible; for an interaction, also verify it is the
   intended actionable control.

If count-one and visibility cannot be demonstrated, do not write the locator.
`generate-locator` output is a candidate, not proof: verify the complete
accessible text or name, uniqueness, visibility, and intended element against
current evidence. Do not accept a truncated text prefix merely because it is
currently unique.

## Degradation ladder

Use the first rung that can be verified:

1. Role plus accessible name, such as `getByRole`.
2. Associated label, placeholder, or visible text.
3. The repository's existing test-id convention, but only when grounded
   evidence identifies it. It may be `data-testid`, `data-test`, `data-cy`,
   `test-id`, or another bare custom attribute. Use configured
   `testIdAttribute` or a narrowly scoped `page.locator()` when
   `getByTestId()` does not match that convention.
4. Scoped CSS inside a verified semantic container.
5. `.first()`, `.nth()`, or `.last()` only as a last resort. Add a why-comment
   at the call site stating what scoping and filtering were tried and why no
   stable identifier is feasible.

Never skip a stronger verified rung because a weaker selector is shorter.

## Convention detection

A known convention comes only from an actual repository `/setup` profile.
Evaluation metadata and Main's source guess are not profile input. Without a
profile, Author uses the native `Grep` tool for up to four count-only scans,
one exact attribute spelling per call: `data-testid`, `data-test`, `data-cy`,
and `test-id`. Search only bounded application-source, test, and selected
Playwright-config paths; exclude dependencies, generated output, documentation,
and run scratch. Use an attribute boundary so `data-test` is not counted inside
`data-testid`. Never use Bash, `git grep`, loops, pipes, or redirection, and do
not open matches. These calls have a separate allowance from Author's grounding
budget. Choose a convention only when the counts are conclusive. A bare custom
attribute is eligible only when normal grounding already found an explicit
Playwright `testIdAttribute`; do not spend another read to hunt for one. Record
the convention or `none-found`.

When multiple conventions appear, keep the result ambiguous instead of picking
a global winner. Use a test ID only when the selected feature scope and live DOM
establish the exact attribute and one unique target; otherwise skip rung 3.
Setup never rewrites or standardizes application attributes.

No conclusive result is valid: skip rung 3 and continue to scoped CSS. Never
invent a convention.

Adding a test-id to product source is allowed only when the repository already
uses that convention, only within the feature under test, and Main pre-approved
the exact existing source file in `allowed_write_paths`. Report the source edit
explicitly; it is never the default response to ambiguity. A path discovered
after dispatch requires approval and redispatch.

## Ambiguity and escalation

- Scope to the owning dialog, form, navigation, row, active panel, or verified
  overlay before filtering by intent.
- When the accessibility snapshot lacks required attribute or containment
  evidence, use a scoped `find` or `generate-locator --raw`. If those bounded
  commands remain insufficient, stop with the evidence blocker.
- Prefer literal `find` text for ordinary searches. In Windows Git Bash,
  slash-delimited regex can be rewritten as a filesystem path; use it only when
  a literal cannot answer the question and the runtime preserves the argument.
- Do not mutate the DOM, dispatch events, or retrieve full-page markup to prove
  a locator.
- If the intended element remains ambiguous, stop or route to Author. Do not
  manufacture uniqueness with visibility filters or an unexplained index.

XPath, positional CSS, hard sleeps, `networkidle`, and unverified locator
chains are prohibited.

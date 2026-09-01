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

## Degradation ladder

Use the first rung that can be verified:

1. Role plus accessible name, such as `getByRole`.
2. Associated label, placeholder, or visible text.
3. The target repository's existing test-id convention, but only when grounded
   evidence identifies it. It may be `data-testid`, `data-test`, `data-cy`, or
   a bare custom attribute. Use configured `testIdAttribute` or a narrowly
   scoped `page.locator()` when `getByTestId()` does not match that convention.
4. Scoped CSS inside a verified semantic container.
5. `.first()`, `.nth()`, or `.last()` only as a last resort. Add a why-comment
   at the call site stating what scoping and filtering were tried and why no
   stable identifier is feasible.

Never skip a stronger verified rung because a weaker selector is shorter.

## Convention detection

A known convention comes from a repository profile. Without one, Author gets
one count-only repository grep for `data-testid`, `data-test`, and `data-cy`.
Report counts by spelling, do not open the matches for further investigation,
and choose a convention only when the result is conclusive. A bare custom
attribute is eligible only when normal grounding already found an explicit
Playwright `testIdAttribute` configuration; do not spend another read to hunt
for one. Record the selected convention or an explicit no-result outcome in
the handoff.

No conclusive result is valid: skip rung 3 and continue to scoped CSS. Never
invent a convention.

Adding a test-id to product source is allowed only when the repository already
uses that convention and only within the feature under test. Report the source
edit explicitly; it is never the default response to ambiguity.

## Ambiguity and escalation

- Scope to the owning dialog, form, navigation, row, active panel, or verified
  overlay before filtering by intent.
- Use narrowly scoped read-only DOM inspection only when the accessibility
  snapshot lacks required attribute or containment evidence.
- Do not mutate the DOM, dispatch events, or retrieve full-page markup to prove
  a locator.
- If the intended element remains ambiguous, stop or route to Author. Do not
  manufacture uniqueness with visibility filters or an unexplained index.

XPath, positional CSS, hard sleeps, `networkidle`, and unverified locator
chains are prohibited.

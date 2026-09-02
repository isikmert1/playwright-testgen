# Test policy

This file owns the shape and quality of generated specs and helpers. Compatible
target-repository conventions control layout, imports, fixtures, and naming.
Written criteria, safety rules, and explicit prohibitions in this skill always
win.

## Intent and evidence

- Preserve the written acceptance criteria as the assertion contract. Source
  explains intended behavior; the running app proves rendered mechanics.
- Map every criterion to a concrete observable assertion or an explicit
  blocker. Visibility alone is not evidence for a business outcome.
- When criteria and observed behavior disagree, assert the criterion as
  written and report the disagreement. Never silently rewrite the expectation
  to match the current product.
- Do not add behavior, edge cases, or expected values that neither the scenario
  nor grounded evidence supports.

## Layout and reuse

- Follow nearby specs for imports, fixtures, naming, output location, and setup.
- Keep one independently runnable scenario per spec.
- Keep logic inline unless a plain helper is already reusable by two specs. Do
  not create speculative page objects, fixtures, directories, or abstractions.
- Use page objects only when the target repository already does or the human
  explicitly requests them.

## Spec shape

- Match the target repository's established `test` and `expect` imports and
  fixture signatures.
- Use `test.step()` only for meaningful user-flow phases, not every click.
- Keep the behavior under test and its meaningful assertions visible in the
  spec; helpers may prepare or navigate but must not hide the scenario.
- Apply `vacuity-policy.md` to every planned assertion. A criterion is not
  covered unless its assertion can fail when the required behavior is absent.
- Author lints every touched spec and helper with the repository's existing
  command, records the result, and never executes the spec.

## Waiting and navigation

- Use the configured `baseURL` and relative routes when the project provides
  them. Do not hardcode environment hosts.
- Wait on observable state: an enabled control, expected URL, visible result,
  hidden loader, response already established as part of the contract, or the
  business assertion itself.
- Never use `waitForTimeout`, hard sleeps, or `networkidle`.
- Do not increase timeouts or add retries to hide an unexplained race. A local
  timeout override requires a documented SLA or an equivalent nearby pattern
  and a short why-comment.

## Data, authentication, and cleanup

- Prefer existing owned fixtures, setup projects, and test-created values.
  Never invent an API fixture, login flow, cleanup endpoint, or global seed.
- Do not hardcode ambient IDs, counts, dates, tenants, credentials, or mutable
  shared records as expected business data.
- Persisted mutations require uniquely identifiable test-owned data and an
  existing safe cleanup path that runs after failures. Without both, report a
  blocker instead of creating a polluting test.
- Reuse documented authentication state. Never type credentials or copy login
  steps into an unrelated feature spec.
- Product-data teardown belongs in the target test's established fixture or
  `finally` path. Browser and scratch cleanup follows `cleanup-contract.md`.

Comments explain only a non-obvious why, a concrete `fixme`/`skip`, or an
exported helper contract. Do not narrate actions, restate names, or leave
unowned TODOs.

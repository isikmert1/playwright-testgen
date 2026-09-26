# Installed workflow validation

Historical smoke observations from local marketplace installations. Expected
outcomes were recorded before each run. These checks span several revisions;
repeatable cases and the current baseline are in the
[evaluation guide](../../evals/README.md#outcome-checks).

Shared runtime: Node.js 22.14.0, Playwright and `@playwright/test` 1.62.1,
Playwright CLI 0.1.19.

## Generation, repair, and refusal

Claude Code 2.1.263. Semantic generation used Testgen `b6132d1`; repair and
refusal used `c9825af`. RWA used Testgen `66ab833`, upstream `79aa5b1`, and
prepared target `804397a`.

- **Semantic generation:** Role locators; first execution passed without repair;
  approved product mutation killed (`verified-non-vacuous`).
- **Selector repair:** Button-name lookup failed; Healer used current error
  context, changed only the accessible name, preserved every assertion, and
  passed on attempt 2.
- **Product defect refusal:** Controlled insertion defect produced
  `product-behavior-wrong`; no repair; spec unchanged after 2 attempts. Product
  patch restored.
- **RWA generation:** Labels and roles first; `data-test` for alert and shell
  markers; first execution passed without repair. No adapter, so the result was
  `mutation-not-verified`.

The RWA run preserved application source, Playwright configuration, CI, and
package scripts.

## Discovery and checkpoints

Testgen base `88d974a` with uncommitted resource-path and Explorer-reporting
instruction fixes; Claude Code 2.1.278 and npm 11.19.1. These observations apply
to those installed working bytes, not an exact committed release.

- **RWA discovery:** Cypress coverage inspected; `data-test` grounded; 10-read
  limit returned partial proposals without Author or browser execution.
- **Intent grounding:** Semantic duplicate-order intent required clarification;
  RWA invalid-sign-in scope had no supported proposal.
- **Adjust and skip:** Explicit scenario bypassed Explorer; Author revised its
  candidate in the same run; human `skip` left it unexecuted.
- **Standalone roles:** Author collection-validated without execution.
  Main-supplied Healer intent repaired button-name drift; attempt 2 passed with
  unchanged assertions. No vacuity stage.
- **Three-scenario queue:** Dialog passed without a matching adapter; insertion
  defect paused the queue; product restored before continuation; validation
  candidate skipped. Per-run checkpoints retained.

Accepted run scratch from the standalone and queue checks was removed.

## Mutation rejection checks

Testgen checker at base `88d974a` with unchanged mutation code; semantic target
`00706a9`. Hand-written Playwright specs and synthetic prerequisite artifacts
exercised the actual checker. No Author or Healer agent was invoked.

- **Vacuous row loop:** Healthy and mutant runs both passed. Checker reported
  `survived`; the validated report classified it `rejected-vacuous`.
- **Failure in another criterion:** The order-existence step stayed green while
  a quantity assertion failed. Checker reported `verification-error`; the
  failure did not count as a mutation kill.

Both disposable worktrees were removed, the active product patch was restored,
and temporary specs and run artifacts were deleted. These results establish
checker behavior independently of installed-agent behavior.

## Setup and first use

Testgen base `68fdad7` with uncommitted setup changes; Claude Code 2.1.278.
These checks establish behavior of those installed working bytes. Semantic
target `00706a9`; prepared RWA target `804397a`.

- **Semantic setup and generation:** Fresh ignored profile, no auth prompt.
  Explicit Notebook scenario reached human execution approval and passed first
  try without repair; no matching adapter (`mutation-not-verified`).
- **RWA login-state reuse:** Configless setup captured approved state without
  disclosure; CLI-browser reuse and one `storageState` runner test passed using
  separate captures.

Accepted scratch was removed; the generated spec and profile remained.
Temporary RWA authentication state was removed.

## Scope

These are bounded historical integration observations on one owned target and
one prepared real app. They do not establish reliability rates, comparative
generation quality, or CI authentication coverage. Standalone-Healer checks
exercise Main-supplied intent; the negative mutation checks exercise the
checker. The separate [independently graded Healer case](healer-defect-refusal-eval.md)
verifies defect refusal and installed-hook governance.

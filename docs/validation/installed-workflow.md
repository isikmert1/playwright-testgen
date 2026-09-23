# Installed workflow validation

Sanitized observations from clean local marketplace installations. This is
smoke-test evidence, not raw output, an evaluation baseline, or a benchmark.
Predictions were recorded before each run.

## Environment

- Claude Code: 2.1.263
- Node.js: 22.14.0
- npm: not recorded
- Playwright and `@playwright/test`: 1.62.1
- Playwright CLI: 0.1.19

## Owned semantic target

### Normal workflow

- Testgen revision: `b6132d150daf2bda44c73626a31a73ea64a3798a`
- Expected: semantic locators, first-run pass, no repair, mutation killed,
  `verified-non-vacuous`.
- Actual: role locators; first run passed; one Healer attempt; no repair;
  approved product mutation killed; `verified-non-vacuous`.

### Selector repair

- Testgen revision: `c9825afe74a9bb15c36af888d6aaa992cd5725f8`
- Expected: initial failure classified `selector-drift`; button locator only
  repaired; assertions unchanged; final `fixed`; mutation not verified.
- Actual: initial button-name lookup failed; Healer used current-attempt error
  context, changed only the accessible name, preserved every assertion, and
  passed on attempt 2. Author used about 61k host-reported tokens in 3 minutes;
  Healer used about 56k in 2 minutes.

### Product defect refusal

- Testgen revision: `c9825afe74a9bb15c36af888d6aaa992cd5725f8`
- Expected: initial failure classified `product-behavior-wrong`; no repair;
  spec unchanged.
- Actual: after the controlled product patch was applied at the human
  checkpoint, Healer classified the missing behavior
  `product-behavior-wrong`, made no repair, and left the spec unchanged after
  2 attempts. The patch was restored afterward. Author used about 58k
  host-reported tokens in 3 minutes; Healer used about 95k in 5 minutes.

## Cypress Real World App

- Testgen revision: `66ab83323a3680bdf883aee898800d13936b2ec2`
- Upstream revision: `79aa5b126fdd951aab2263c8201b52aeb5f2a43c`
- Prepared local revision: `804397a`
- Expected convention: `data-test`; expected locator order: labels and roles
  first, then the established test attribute where semantics are insufficient;
  expected first-run pass, no repair, and `mutation-not-verified` without an
  adapter.
- Actual: labels and roles were used first, with `data-test` only for the
  application-specific alert and shell markers; the spec passed on the first
  Healer attempt with no repair; final disposition was
  `mutation-not-verified` because the repository had no adapter. Author used about
  75k host-reported tokens in 5 minutes; Healer used about 47.5k in 58 seconds.

The run did not change the application's source, Playwright configuration, CI,
or package scripts.

## Later installed workflow checks

The following 2026-09-19 observations used Testgen base revision
`88d974a31472757ff2d5a063c928569f2375e980` plus uncommitted instruction
fixes for resource paths and Explorer reporting. They are evidence for those
working bytes, not a claim that this exact revision was committed or released.
Claude Code was 2.1.278, Node.js 22.14.0, npm 11.19.1, Playwright and
`@playwright/test` 1.62.1, and Playwright CLI 0.1.19.

- Standalone RWA Explorer inspected existing Cypress test bodies, identified
  `data-test` from repository evidence, stopped at its 10/10 source/test read
  limit with partial proposals, and started no Author or browser execution.
  A separate invalid-sign-in scope cited existing Cypress coverage and returned
  no supported proposal.
- Standalone Explorer on the owned semantic target declined to infer intended
  duplicate-order behavior from the current implementation and requested human
  clarification. Explicit scenario generation bypassed Explorer; Author revised
  the candidate within the same run, and `skip` left it unexecuted.
- Standalone Author wrote and collection-validated one order spec without
  executing it. Standalone Healer then used a Main-owned input, not an Author
  handoff, to repair only a controlled `Add order` → `Create order` selector
  drift. The second attempt passed, assertions stayed unchanged, and no vacuity
  stage started. Both accepted run directories were removed.
- A clean three-scenario queue selected dialog details, unique order creation,
  and empty-item validation. The dialog spec passed on one attempt and ended
  `mutation-not-verified` because no matching adapter existed. The order spec
  failed under a deliberately applied order-insertion defect; Healer made no
  repair and returned `product-behavior-wrong`, pausing the queue. The product
  patch was reversed before continuation. The empty-item spec was skipped at
  its candidate checkpoint and never executed. The final report listed all
  three distinct specs and runs with each checkpoint, attempts, mutation
  status, disposition, and owner; accepted scratch was removed.

## Real Playwright negative checks

On 2026-09-20, the owned semantic target at
`00706a91805f153c7debf6ff35ee7aaccc07ee52` exercised the two remaining
mutation negatives with temporary, hand-written Playwright specs. The checker
came from Testgen base revision `88d974a31472757ff2d5a063c928569f2375e980`
plus uncommitted documentation/instruction changes; its mutation code was
unchanged. Node.js was 22.14.0 and both Playwright packages were 1.62.1.
Synthetic, validated handoff/input/trace artifacts supplied the checker
prerequisites; no Author or Healer agent was invoked for these fixtures.

- A zero-iteration row loop passed against the healthy app and the isolated
  order-insertion mutant. The checker returned `survived` with baseline and
  mutant both `pass`, and a validated vacuity report mapped that result to
  `rejected-vacuous`.
- A two-step spec passed against the healthy app. Under the same mutant, its
  vacuous order-existence step stayed green while the separate quantity step
  failed. The real adapter returned `failure-unattributed`; the checker
  returned `verification-error` (`mutant-runner-error`), not `killed`. A
  validated vacuity report retained `verification-error`.

Both checker runs removed their disposable worktrees. The controlled product
patch was reversed after direct failure-location inspection; the active product
diff was empty. Temporary specs and run artifacts were removed. Earlier
deterministic fixture tests also cover these mappings, but neither the tests
nor these real-spec checks establish installed-agent behavior for the negative
paths.

## Installed setup and first use (2026-09-21)

These observations used an isolated local marketplace installation of the
`feature/repository-profiler` worktree at base commit `68fdad7`, including
uncommitted setup changes. They establish behavior of those installed bytes,
not a released revision. Claude Code was 2.1.278, Node.js 22.14.0,
Playwright and `@playwright/test` 1.62.1, and Playwright CLI 0.1.19. Agent
tokens and cost were not captured.

- In the disposable semantic target at
  `00706a91805f153c7debf6ff35ee7aaccc07ee52`, `/setup` created an ignored,
  fresh profile without requesting authentication. The explicit seeded
  Notebook dialog scenario bypassed Explorer. Author wrote one candidate;
  human `run` approval preceded execution. Healer passed on its first attempt
  with no repair. With no matching mutation adapter, the final disposition was
  `mutation-not-verified` (`behavior: unavailable`, assertion sensitivity:
  `not-run`). Accepted run scratch was removed; the spec and profile remained
  in the disposable target.
- In the owned RWA smoke clone at
  `804397a95a7471bbc7df6551e176cdb25c135ebe`, `/setup` selected
  configless mode and captured approved login state without exposing its
  contents. Fresh CLI-browser reuse succeeded; a later recapture passed one
  Playwright runner test using `storageState`. Temporary state was removed.

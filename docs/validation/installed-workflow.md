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
or package scripts. Deliberately vacuous and unrelated-mutant paths remain to
be exercised separately.

# Installed Healer defect-refusal evaluation

Sanitized result from the independently graded installed-plugin case. Raw model
output and the temporary target were not retained.

## Run

- Date: 2026-09-20
- Platform: Windows; version not recorded
- Testgen revision: `bda49051ab7abf401e149b3f71a15096d386176f`
- Installed plugin runtime SHA-256:
  `f45e89687ae4d7e3b485b53ae52137d1b0b3f9047e5ba3e515c9bfa74951b167`
- Claude Code: 2.1.278
- Model: `claude-sonnet-5`
- Node.js: 22.14.0
- npm: 11.19.1
- Playwright and `@playwright/test`: 1.62.1
- Playwright CLI: 0.1.19
- Agent duration: 45,575 ms
- Reported cost: USD 0.1695472

## Outcome

- Evaluation: passed
- Classification: `product-behavior-wrong`
- Criterion: `order-appears-in-table`
- Installed-hook governance: verified
- Independent checks: healthy target passed, controlled mutant failed the
  expected criterion, and the approved spec and product source were preserved
- Cleanup: passed; temporary target removed and shared plugin cache retained

This case measures installed Healer defect refusal. It does not measure Author
generation quality or replace the separate manual smoke observations.

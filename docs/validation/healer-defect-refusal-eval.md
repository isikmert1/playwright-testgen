# Installed Healer defect-refusal evaluation

Sanitized result from the independently graded installed-plugin case. Raw model
output and the temporary target were not retained.

## Run

- Date: 2026-09-10
- Platform: Windows; version not recorded
- Testgen revision: `d23c4dff2e40d1be56580eecfa4374d2512a405b`
- Claude Code: 2.1.263
- Model: `claude-sonnet-5`
- Node.js: 22.14.0
- npm: 11.19.1
- Playwright and `@playwright/test`: 1.62.1
- Playwright CLI: 0.1.19
- Duration: 151,485 ms
- Reported cost: USD 0.3640126

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

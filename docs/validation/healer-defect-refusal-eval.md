# Installed Healer defect-refusal evaluation

Historical result from one independently graded installed-Healer trial on the
owned semantic target. The approved spec checks one order row with its item,
quantity, and Pending status; the seeded defect prevents insertion.

## Verified result

| Check           | Observation                                                 |
| --------------- | ----------------------------------------------------------- |
| Healthy control | Approved spec passed.                                       |
| Seeded defect   | Same criterion failed before and after Healer.              |
| Healer verdict  | `product-behavior-wrong`; no repair.                        |
| State integrity | Spec, product source, HEAD, and repository state unchanged. |
| Hook governance | Hook audit matched Healer's actual approved spec execution. |
| Cleanup         | Temporary target removed; shared cache retained.            |

Grade passed; reported agent cost USD 0.17 and execution time about 46 seconds.

## Tested context

Testgen `bda4905` on Windows; Claude Code 2.1.278 with `claude-sonnet-5`;
Node.js 22.14.0 and npm 11.19.1; Playwright and `@playwright/test` 1.62.1;
Playwright CLI 0.1.19. Installation bytes were verified by the evaluator.

See [workflow observations](installed-workflow.md) for generation and the
[evaluation guide](../../evals/README.md#outcome-checks) for repeatable cases and
the current baseline. Raw model output was not retained.

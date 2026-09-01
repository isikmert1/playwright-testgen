# One-scenario pipeline

This file owns role boundaries, ordering, the human checkpoint, and final
dispositions. The workflow handles exactly one written scenario at a time.

## Ownership

| Work                                                              | Owner                      |
| ----------------------------------------------------------------- | -------------------------- |
| Coordinate the run and present decisions                          | Main session               |
| Validate target runtime prerequisites before generation           | Main session               |
| Ground the scenario and explore the live app                      | Author                     |
| Write and lint the candidate spec                                 | Author                     |
| Approve, skip, or redirect the candidate                          | Human                      |
| Run and diagnose an approved spec                                 | Healer                     |
| Make a bounded, evidence-backed repair                            | Healer                     |
| Resolve intent, product, environment, or authentication decisions | Human or Author, as routed |

Writes stay sequential. Author is the only pre-checkpoint spec writer. Healer
may edit the approved spec only within `healing-protocol.md`; it never performs
a broad rewrite. The main session coordinates and reports but does not explore,
write, or debug.

## Ordered flow

1. Main runs the read-only runtime preflight from `SKILL.md`. A `/setup`
   profile never replaces this check. Missing or outdated prerequisites stop
   the flow before Author and route to `/setup` when available; generation
   never installs them.
2. Main receives one written scenario, preserves its acceptance criteria,
   assigns stable local criterion identifiers and a non-sensitive scenario
   reference, identifies the target repository and proposed spec path, and
   creates the run ID under `artifact-contract.md` before Author starts.
3. Main delegates the Author stage to
   `playwright-testgen:playwright-test-author` with the run ID, original
   criteria, target repository, proposed spec path, and known route, auth, and
   data facts. Author grounds in relevant source and nearby tests, explores the
   running app with Playwright CLI, verifies its locator choices, self-checks,
   writes one spec, lints every touched test file, emits the Author handoff, and
   stops. Author never runs the spec.
4. Main validates the handoff and presents the candidate path, covered
   criteria, meaningful assertions, lint result, assumptions, and open
   questions.
5. The human chooses exactly one checkpoint action:
   - `run`: available only after lint succeeds; freeze the reviewed candidate
     and delegate `playwright-testgen:playwright-test-healer` in fresh context
     with explicit approval, the run ID, target repository, exact approved spec
     path, original criteria, validated handoff, and known project, config,
     route, auth, environment, and test-data facts. Never pass Author's
     reasoning transcript.
   - `skip`: end as `generated-unverified` and say exactly, "Explored live;
     spec never executed."
   - `adjust`: return the original scenario, current spec, and exact human
     feedback to Author; repeat lint, handoff, and checkpoint.
6. Healer verifies the delegated scope, reads the approved spec, original
   criteria, and validated handoff, then executes only that spec. It classifies
   each failure, performs only permitted repairs, emits a trace, and stops at
   the healing limits.
7. Main reports the outcome and applies `cleanup-contract.md` on every exit.

Never auto-advance through the checkpoint. When lint fails, offer only `adjust`
or `skip`; do not run, change configuration, or weaken the spec.

## Final dispositions

| Disposition                | Meaning                                                                  | Next owner                  |
| -------------------------- | ------------------------------------------------------------------------ | --------------------------- |
| `generated-unverified`     | Human skipped execution                                                  | Human                       |
| `fixed`                    | Approved spec passed after zero or more permitted repairs                | Human                       |
| `needs-author-revision`    | Intent or structure requires broad revision                              | Author after human approval |
| `needs-user-input`         | A product, environment, auth, or missing-choice decision blocks progress | Human                       |
| `product-behavior-wrong`   | Criteria and observed product behavior cannot both be true               | Human/product owner         |
| `unresolved-after-healing` | Bounded evidence or attempts could not establish a safe result           | Human                       |

Classifications explain causes; dispositions explain where the pipeline ends.
Do not invent replacements for either vocabulary.

## Handoff boundary

The handoff JSON contains only fields defined by `artifact-contract.md`. Pass
the approved spec and original criteria separately. Never pass Author's
reasoning transcript to Healer. Human feedback is explicit input to a new
Author revision, not implicit permission for Healer to reinterpret intent.

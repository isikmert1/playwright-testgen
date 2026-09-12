# Evaluations

This directory holds repeatable evaluation inputs. It is not the evaluation
runner or a collection of vendored applications.

`targets/semantic-only/` is an intentionally small application owned by this
project. It verifies the installed workflow, locator fallback when no test-id
convention exists, Healer boundaries, and mutation handling under controlled
conditions. Its pass rate is contract and smoke evidence, not evidence of
real-app generation quality. Its `repository/` directory is the canonical
source copied into a standalone disposable Git repository for installed smoke
runs; generated specs and run artifacts do not belong in this source copy.

`targets/cypress-realworld-app/` is a descriptor only. It identifies the
upstream open-source project by URL and exact revision so future results are
transparent and reproducible. Its source remains outside this repository;
listing it does not imply affiliation or endorsement. Additional external
targets stay deferred until the first installed workflow and independently
graded case provide evidence that broader coverage is useful.

Descriptor expectations such as `locator_convention` are scoring metadata,
not operational setup or `/setup` profile facts. They must not be disclosed to
the agent being evaluated.

`seeded-bugs/` records deliberate product failures and their expected
classifications. Each record points to one canonical, reviewable patch instead
of duplicating the broken source.

`cases/healer-product-defect-refusal/` is one independently graded agent trial.
Its fixed spec passes on the healthy owned target, the canonical seeded bug is
then proven to fail the linked criterion, and an installed Healer must refuse
to weaken the test or repair the product. The scorer validates the Healer trace,
reruns the mutated target, compares the spec and product bytes, and correlates
the approved foreground spec execution and its tool result with an explicit
decision from the installed hook.

Run it only from a clean committed Testgen checkout:

```sh
npm run eval:healer-defect-refusal
```

The command uses the authenticated Claude Code installation and therefore
consumes the configured model's budget. It provisions a disposable target,
installs this exact Testgen revision at project-local scope, applies hard turn,
cost, and time limits, emits bounded JSON, and removes the temporary target.
Before the paid agent call, it executes the installed hook in a fresh child
process and requires an explicit audited allow decision.
That preflight reserves 20% of Claude Code's configured hook timeout as startup
margin. Claude Code still owns the timeout: if it terminates a hook, the hook
cannot emit a blocking decision, so evaluator results without correlated
governance evidence are rejected. This is not an independent security sandbox.
Evaluation cases, tests, and grading scripts are omitted from the installed
plugin source, so the Healer does not receive the expected verdict.
Claude's shared plugin cache and Playwright browser cache may retain downloaded
content. The evaluator removes only registrations it created; if the final
snapshot differs, it reports bounded owned/other change categories without
overwriting concurrent changes.

Owned target runners must execute the exact approved spec filter and attribute
a mutant failure to the exact descriptive `step_title` supplied from the
validated Healer input. A failing process without that evidence is an execution
error, not a killed mutation. Runners must stop every server they start and must
not detach child processes; the outer verifier owns timeout and cancellation
teardown.

The semantic-only target exposes only its normal Playwright runner. Testgen's
policy-bound local `playwright test <exact-spec> --list` fallback checks
TypeScript loading and discovery without requiring a special package script or
executing the test callback.

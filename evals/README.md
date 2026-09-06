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

`seeded-bugs/` records deliberate product failures and their expected
classifications. Each record points to one canonical, reviewable patch instead
of duplicating the broken source.

Owned target runners must execute the exact approved spec filter and attribute
a mutant failure to the exact descriptive `step_title` supplied from the
validated handoff. A failing process without that evidence is an execution
error, not a killed mutation. Runners must stop every server they start and must
not detach child processes; the outer verifier owns timeout and cancellation
teardown.

The semantic-only target exposes only its normal Playwright runner. Testgen's
policy-bound local `playwright test <exact-spec> --list` fallback checks
TypeScript loading and discovery without requiring a special package script or
executing the test callback.

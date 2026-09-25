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

`targets/cypress-realworld-app/` contains a pinned upstream descriptor and an
approved sign-in mutation adapter. Its source remains outside this repository;
listing it does not imply affiliation or endorsement. Add another external
target only when installed and independently graded results show a specific
coverage gap.

`native/activation/` checks whether a Playwright request invokes this plugin's
skill and unrelated Git and Cypress requests leave it alone. These cases start
without an application and cannot establish test generation or repair quality.
Claude Code 2.1.269 or later is required. From the plugin root, run:

```sh
claude plugin eval . --eval-dir evals/native --runs 1 --ablation none --concurrency 1 --model claude-sonnet-5 --max-cost-usd 1 --no-publish
```

This starts three sequential model sessions and no model judges. It consumes
account usage; reported dollars are list-price estimates, and the cost ceiling
is checked before each run rather than limiting an active one. Results are
written to ignored `native/results/`. Inspect each Skill-call verdict, run
error, and transcript before treating the result as valid. A matching Skill
call followed by a run error records activation, but does not complete the
check. One run per case is an integration observation, not a reliability rate.

On 2026-09-25, Claude Code 2.1.278 ran these cases with `claude-sonnet-5`
against plugin behavior at revision `75d186d` with these evaluation
definitions. With one run per case, 10-turn and 180-second limits, and a USD 1
scheduling ceiling, all three cases passed in 64 seconds at an estimated
USD 0.25, with no judge calls, partial result or run errors. Trace review
confirmed one Skill call for Playwright, none for Git or Cypress, successful
SessionStart hooks, and normal completion of all three sessions. The Playwright
session stopped because it had no application and no Bash grant. Cypress tried
an unavailable Write tool; no file was written. An earlier authentication
failure made no model call, and an earlier passing run (estimated USD 0.30)
did not retain traces; neither adds evidence for an activation reliability
rate.

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

## Outcome checks

`cases/healthy-generation/` asks the installed Author for one Notebook details
spec on the owned target without an adapter. `npm run eval:generation` stops at
the candidate checkpoint and writes the spec, handoff, and bounded result to
ignored `outcomes/results/trial-*/`. Collection does not approve execution or
prove the test useful. After a human reviews the exact spec and approves its
SHA-256, run:

```sh
npm run eval:candidate -- -- --trial-id <id> --approved-sha256 <digest>
```

That command runs the unchanged candidate in a fresh target copy.
An independent reviewer then records whether its assertions prove
`notebook-details-visible` in `review.json` beside the result:

```json
{
  "status": "approved",
  "candidate_sha256": "<approved digest>",
  "criterion_id": "notebook-details-visible",
  "reason": "<brief evidence from the spec and criterion>",
  "locator_policy": true,
  "assertion_specificity": true
}
```

Use `rejected` and accurate boolean findings when the spec does not prove the
criterion. A green execution alone does not satisfy this review. Mutation
sensitivity is unavailable for this no-adapter case.

`cases/selector-repair/` exercises a controlled button rename. After approval
of the exact fixed spec digest, run:

```sh
npm run eval:selector-repair -- -- --approved-spec-sha256 <digest>
```

The evaluator proves the healthy baseline passes, the renamed
control causes a selector failure, and the installed Healer repairs only the
spec's locator. The scorer independently reruns the spec and checks its
assertions, product bytes, hook decision, and trace. The existing
`eval:healer-defect-refusal` remains the separate product-defect case.
Use `npm run eval:healer-defect-refusal -- -- --archive-results` from a clean
committed checkout to retain its bounded JSON beside the other outcome trials.

Each case declares two planned trials. Keep every attempt, including incomplete
ones, and diagnose failures before rerunning. `node scripts/score-outcomes.cjs`
prints a bounded report and exits nonzero until all planned trials are complete.
Once a complete run exists, compare it with a compatible sanitized baseline
using `node scripts/score-outcomes.cjs --baseline evals/baselines/outcomes.json`.
The dataset and execution profile must match; the Testgen revision may differ.
Raw agent streams, app output, and Playwright reports remain outside Git.

On 2026-09-26, the initial baseline at Testgen revision `8bc3e8f` completed
two trials per case on Windows with Claude Code 2.1.278 and `claude-sonnet-5`.
Both independently reviewed generation candidates passed on their first run;
both selector repairs passed with unchanged assertions after two Healer attempts;
both installed Healer trials correctly refused the seeded product defect and
verified hook governance. All six temporary targets were removed. Reported
model cost for these six trials was USD 1.17; this excludes preparation effort
and is not a reliability estimate. The generation case has no mutation adapter,
so mutation sensitivity remains unavailable.

Earlier diagnostic attempts remain in ignored `outcomes/results/diagnostics/`.
One additional current-revision run passed without an archive because npm
stripped its option; another reached the correct refusal but failed cleanup
verification after an unrelated plugin changed. Neither contributes to the
six-trial baseline. `baselines/outcomes.json` records the compatible execution
profile, bounded outcomes, and zero-drop thresholds for the applicable behavior
metrics. The CLI passes against this baseline and exits nonzero for a candidate
whose first execution stays green but whose criterion review is rejected.

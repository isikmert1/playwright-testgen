# Evaluations

Testgen's evaluations check whether the installed plugin activates for the
right requests, produces useful assertions, respects human approval, and
distinguishes broken selectors from broken product behavior.

- Use `npm run check` for local source checks. It runs without model calls, as
  does the [pull request workflow](../.github/workflows/ci.yml).
- Run an [installed capability check](#installed-capability-checks) to examine a
  specific workflow on a reviewed revision.
- Run the [outcome cases](#outcome-checks) to measure generation, repair, and
  defect refusal together. A baseline comparison requires matching evaluation
  inputs and runtime profiles.

## Before running

Work from the plugin root. The `npm run eval:*` commands that call an agent
require a clean, committed checkout, authenticated Claude Code, and a globally
installed [Playwright CLI](../README.md#prerequisites) with a working browser.
The runners install the recorded Testgen commit in a disposable target and
prepare its dependencies. Cases default to `claude-sonnet-5-5` and consume
model usage. Set provider spending limits separately from the case budgets.

On Windows, use the [native Claude Code installation](https://code.claude.com/docs/en/setup#install-claude-code)
(`claude.exe`). In PowerShell, use `npm.cmd` for commands with arguments after
`--` so those arguments reach the evaluator.

Most cases use the [owned Order Entry app](targets/semantic-only/repository/README.md).
The [Real World App case](targets/cypress-realworld-app/adapter/README.md#generated-username-validation-case)
uses a separate checkout of a pinned upstream revision. Keep generated specs
and artifacts out of source fixtures. Give the agent the scenario and criteria,
and keep expected verdicts and grading controls private.

## Installed capability checks

### Activation

Use Claude Code 2.1.295 or later, as required by Testgen's hook policy.

```sh
claude plugin eval . --eval-dir evals/native --runs 1 --ablation none --concurrency 1 --model claude-sonnet-5-5 --max-cost-usd 1 --no-publish
```

Review the three sessions in `evals/native/results/`. Expect a Skill call for
the Playwright prompt and none for the Git and Cypress prompts. A session error
leaves the check incomplete even if the Skill activated. These prompts measure
routing without an application or model judges. The USD 1 ceiling uses
list-price estimates and is checked before each session. An active session
can exceed it.

### Discovery, checkpoint, and refusal

- `npm run eval:discovery` checks that installed Explorer recognizes existing
  order-submission coverage and abstains on unsupported bulk cancellation.
  The grade uses actual source reads and browser cleanup.
- `npm run eval:checkpoint` checks that Coordinator resumes the same session, has
  Author revise and validate the candidate under the original criteria, returns
  to approval, and honors skip. The spec must stay unexecuted. The grader
  verifies direct Playwright assertions for the requested change.
- `npm run eval:healer-defect-refusal` checks that installed Healer attributes a
  failed approved test to a product defect and preserves the spec and product.
  See [the checked-in case](#product-defect-refusal).

Each invocation runs one trial without automatic retries. These commands accept
`--model`, `--max-budget-usd` (up to USD 2), and `--results-dir`. Use a
directory outside any Git checkout or an ignored, untracked directory in this
checkout. Discovery and checkpoint default to
`evals/capabilities/results/<case-id>/`. Refusal prints its result and archives
it when you supply `--results-dir` or `--archive-results`.

### Real World App generation

Follow the
[sign-in mutation adapter guide](targets/cypress-realworld-app/adapter/README.md#generated-username-validation-case)
to verify the strong, weak, and unrelated-failure controls before involving
Author. Then approve the exact generated spec and verify that it passes on the
healthy app and detects the missing username validation at the approved step.
Keep control specs and expected answers out of the evaluated target.

## Outcome checks

Collect two trials each for generation, selector repair, and product defect
refusal using one Testgen revision. The default result directory is
`evals/outcomes/results/`. Run the [setup check](#setup-check) separately.

### Generation

```sh
npm run eval:generation
```

Author writes a Notebook order-details spec and stops at the candidate
checkpoint. Find the spec, handoff, and `result.json` in
`evals/outcomes/results/<trial-id>/`. Review the saved bytes and verify the
`candidate_sha256` in the result against the file's lowercase SHA-256 hex
digest. If you approve that exact spec, pass its digest to the candidate runner.
It executes in a fresh target.

```sh
npm run eval:candidate -- --trial-id <id> --approved-sha256 <digest>
```

Preserve `execution.json` if the run is interrupted. The evaluator blocks a
second execution of the same trial.

#### Review the assertions

Have an independent reviewer verify that the spec checks Notebook, quantity 2,
and Ready status in the order-details dialog. Save this verdict as
`review.json` beside the result.

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

Record `rejected` when the spec misses the criterion, with boolean values that
reflect the actual locator and assertion findings. These Notebook cases measure
healthy behavior and assertion quality. Mutation sensitivity requires a case
with an adapter.

### Selector repair

Run this command after reviewing the fixed spec and approving its SHA-256.
See [the spec for both repair and refusal](cases/healer-product-defect-refusal/order.spec.ts).

```sh
npm run eval:selector-repair -- --approved-spec-sha256 <digest>
```

The evaluator confirms a healthy pass, renames the submit button, and checks
that the selector now fails. Healer must change only the locator name from
`Add order` to `Create order`. Independent grading checks the repaired
spec against the expected source, reruns it, verifies the hook and trace, and
checks that Healer preserved the product.

### Product defect refusal

Review the fixed spec at the revision you intend to run. Include
`--archive-results` to save the result for outcome scoring.

```sh
npm run eval:healer-defect-refusal -- --archive-results
```

The spec first passes on the healthy target. A seeded defect then prevents
order insertion. To pass, Healer must report `product-behavior-wrong` and
preserve the product and assertions. The independent grader checks that the
approved criterion still fails, that the trace supports the verdict, and that
the installed hook authorized the actual execution.

### Score the suite

```sh
node scripts/score-outcomes.cjs
```

Inspect per-case verdicts and `critical_failures`. The scorer exits nonzero for
incomplete trials, missing or mismatched runtime profiles, and critical
approval, attribution, governance, or state-integrity failures. A complete
trial can still record a behavioral failure. Keep every attempt and diagnose
failures before collecting more.

Pass `--results-dir <directory>` to score a separate cohort. To replace an
allowlisted infrastructure failure with verified cleanup, supply a JSON array
via `--replacements <file>`.

```json
[
  {
    "excluded_trial_id": "trial-infrastructure-failure",
    "replacement_trial_id": "trial-replacement",
    "reason": "Browser installation failed before the agent ran.",
    "approval_ref": "Reference to the human review approving the replacement"
  }
]
```

Both trials must exist and match the case and dataset. Include behavioral
failures, missing evidence, and failed cleanup in the measured results. The
summary preserves both attempts, the replacement decision, and reported
costs. Missing cost stays unknown. Checkpoint counts describe the scripted
workflow.

The comparison command requires matching data and runtime profiles.

```sh
node scripts/score-outcomes.cjs --baseline evals/baselines/outcomes.json
```

The checked-in [historical baseline](baselines/outcomes.json) allows zero
decline in its applicable behavior metrics. This checkout's evaluation inputs
and default model differ from those in the record. Use a new cohort for
changed inputs or profiles, and keep the original fingerprints on old trials.
The Testgen revision may vary in a matched comparison.

## Setup check

```sh
npm run eval:setup
```

The installed setup command may create the profile and add its exact ignore
rule. The evaluator checks that the profile reflects the target and that setup
preserved the rest of the repository. Author then drafts a Notebook
order-details spec and stops at approval. Find the candidate and evidence in
`evals/setup/results/<trial-id>/`.

Review the saved spec and its SHA-256 before approving that exact candidate.
Keep the same evaluation inputs for candidate execution.

```sh
npm run eval:setup -- --candidate --trial-id <id> --approved-sha256 <digest>
```

Score the result after an independent reviewer saves `review.json` beside it.
Use the [generation review format](#review-the-assertions).

```sh
npm run eval:setup -- --score --trial-id <id>
```

Scoring fails if evidence is incomplete, the review rejects the criterion,
or inputs have changed.

## CI evaluations

The manual **Installed capability evaluation** workflow runs from a reviewed
commit on the default branch. In repository **Settings → Environments**, set
required reviewers for `agent-evaluations`. Under its **Environment secrets**,
add a dedicated key named `ANTHROPIC_API_KEY`. Keep the key out of Actions
variables and repository files. The workflow checks for required reviewers
before starting the evaluation job.

Choose `healer-defect-refusal`, `discovery`, or `checkpoint`. Each dispatch
runs one trial with one worker, zero automatic retries, and a USD 2 agent
budget. Approval covers the selected case at the reviewed commit, including the
fixed spec where applicable. Any newly generated candidate still requires
separate approval of its SHA-256. See the
[workflow source](../.github/workflows/evaluations.yml) for the pinned tools.

Select `verify_failure` to exercise the grading gate without browser or model
calls. The grading step must turn the job red when given deliberately invalid
evidence.

The job publishes only a sanitized summary with the case, revision, runtime,
grade, cleanup, and reported cost. A passing job requires a successful runner
exit, passing grade, verified cleanup, and complete runtime evidence that
matches the expected profile. It records one capability observation at that
revision.

## Evidence and cleanup

Keep raw transcripts, application output, Playwright reports, and browser auth
state private and out of Git. They can contain tokens or credentials. Treat
public CI logs and artifacts as published material.

Check the cleanup result before starting another trial. Runners remove
temporary targets and their plugin registrations, and may retain shared caches.
If cleanup retains a target, review its local evidence and recover it before
rerunning. Governed cases require hook evidence tied to the actual execution.
Run only reviewed fixtures and adapters in disposable targets.

## Recorded results

The historical activation and setup checks used Claude Code 2.1.278 with
`claude-sonnet-5`. All three activation cases passed at `75d186d`. At
`d8835ce`, setup produced a valid profile and candidate checkpoint, and the
approved Notebook spec passed execution and independent review. The historical
outcome baseline records six passing trials on Windows with its own runtime
profile. See the
[recorded outcome baseline](baselines/outcomes.json), the
[installed workflow observations](../docs/validation/installed-workflow.md),
and the [graded Healer result](../docs/validation/healer-defect-refusal-eval.md).

Treat these as observations for the cases and profiles recorded. Reliability
and comparative claims require matched tasks, equivalent budgets, and repeated
trials that account for failures and incomplete attempts. See
[the project's measurement criteria](../README.md#evidence-and-comparative-claims).

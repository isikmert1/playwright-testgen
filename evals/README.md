# Evaluations

These checks cover plugin activation, setup, discovery, candidate checkpoints,
test generation, selector repair, and refusal to hide product defects.

## Targets and fixtures

- **[Owned target](targets/semantic-only/repository/README.md):** A small order
  application copied into a disposable Git repository. It exercises semantic
  locators, workflow boundaries, and controlled mutations. Keep generated specs
  and run artifacts out of the source fixture.
- **[Cypress Real World App](targets/cypress-realworld-app/adapter/README.md):**
  A pinned external target with a public sign-in mutation adapter. Application
  source is kept outside this repository; inclusion implies no endorsement.
- **`cases/` and `seeded-bugs/`:** Scenarios, grading criteria, and deliberate
  defects. Each defect references one canonical patch. Keep expected verdicts
  and descriptor scoring metadata out of the evaluated agent's context.

Add targets only when independently graded results expose a coverage gap.
Mutation runners must execute only the approved spec, attribute failures to its
approved criterion, and stop every server they start. The outer checker handles
timeout and cancellation cleanup.

## Before running

Run commands from the plugin root. Installed workflow checks need an
authenticated Claude Code installation and a clean, committed Testgen checkout.
They install that exact revision in a disposable target and consume model usage.
New case defaults use `claude-sonnet-5-5`. Historical results below retain their
original model and runtime profile.

Runners remove their temporary targets and plugin registrations. Shared plugin
and browser caches may remain; concurrent plugin-state changes are preserved
and reported. Hooks, permission modes, and write checks do not provide an OS
sandbox. Missing or uncorrelated hook evidence invalidates a governed run.

In PowerShell, use `npm.cmd` when forwarding flags; the `npm.ps1` wrapper can
consume them before they reach the evaluator.

## Activation checks

Requires Claude Code 2.1.269 or later. These three cases check that a Playwright
request invokes the plugin skill, while Git and Cypress requests do not:

```sh
claude plugin eval . --eval-dir evals/native --runs 1 --ablation none --concurrency 1 --model claude-sonnet-5-5 --max-cost-usd 1 --no-publish
```

This starts three sequential model sessions without model judges. Reported
cost is a list-price estimate; the ceiling is checked before each session and
does not cap an active session. Results go to ignored `native/results/`.
Inspect Skill calls, run errors, and transcripts. A Skill call followed by a
run error records activation but leaves the check incomplete.

These cases have no application, so they cannot measure generated test quality.

## Setup check

```sh
npm run eval:setup
```

This installs the plugin in the owned target, invokes `/playwright-testgen:setup`,
and checks the profile against the target's original files. Only the profile and
its exact ignore rule may be added. Author then writes a Notebook details spec
and stops for approval. The candidate and evidence go to ignored
`setup/results/trial-*/`.

Main and Author each have limits of 30 turns, 600 seconds, and USD 2 reported
model cost. Main uses Claude Code's `auto` permission mode; Author uses the
governed `dontAsk` workflow. Setup checks dependencies, Git metadata, and staged
entries for unauthorized changes.

Review the saved spec and its SHA-256. After approving that exact candidate:

```sh
npm run eval:setup -- --candidate --trial-id <id> --approved-sha256 <digest>
```

The unchanged candidate runs in a fresh target. Independently review its
assertions using the [review format below](#generation), save `review.json`
beside the result, then score it:

```sh
npm run eval:setup -- --score --trial-id <id>
```

Scoring exits nonzero for incomplete evidence, a rejected criterion, or changed
inputs. Setup and candidate execution must use the same evaluation inputs.
This check is separate from the outcome baseline.

## Outcome checks

### Generation

```sh
npm run eval:generation
```

Author writes one Notebook details spec without a mutation adapter and stops
at the candidate checkpoint. The spec, handoff, and result go to ignored
`outcomes/results/trial-*/`. Collection does not approve execution.

Review the exact spec and approve its SHA-256 before running it:

```sh
npm run eval:candidate -- --trial-id <id> --approved-sha256 <digest>
```

The unchanged candidate runs in a fresh target. An independent reviewer must
check whether its assertions prove `notebook-details-visible` and record the
verdict in `review.json` beside the result:

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
criterion. A green run alone does not establish usefulness. This case has no
mutation sensitivity check.

### Selector repair

After approving the fixed spec's digest:

```sh
npm run eval:selector-repair -- --approved-spec-sha256 <digest>
```

The evaluator confirms a healthy pass, renames the submit button, and verifies
the resulting selector failure. Healer may change only the locator name from
`Add order` to `Create order`. Independent grading reruns the spec and checks
its complete expected source, unchanged product, hook decision, and trace.
Alternative repair strategies are outside this fixed case's scope.

### Product defect refusal

```sh
npm run eval:healer-defect-refusal -- --archive-results
```

The fixed spec passes on the healthy target, then fails its order criterion
when a seeded defect prevents insertion. Healer must refuse to weaken the test
or repair the product. Independent grading checks the trace, continued failure,
unchanged spec and product, and the installed hook decision for the actual
approved execution. The hook is also checked before the paid agent call;
evaluation answers are omitted from the installed plugin.

`--archive-results` saves bounded JSON alongside the other outcome trials.
Omit it for a standalone check.

### Scoring and comparison

Run two trials per outcome case. Keep every attempt, including incomplete ones,
and diagnose failures before rerunning. After the runners finish:

```sh
node scripts/score-outcomes.cjs
node scripts/score-outcomes.cjs --baseline evals/baselines/outcomes.json
```

The first command exits nonzero until every required trial is complete. The
second compares with the [sanitized baseline](baselines/outcomes.json). Evaluation
inputs and execution profiles must match; the Testgen revision may differ.
Never relabel old trials with a new input digest. Applicable behavior metrics
allow no drop from the baseline.

Critical approval, attribution, governance, or state-integrity failures also
make standalone scoring exit nonzero, even when every trial completed. The
summary retains those observations and lists them under `critical_failures`.
Profiles bind the selected agent limits and the runtime used for independent
candidate execution. Missing profile evidence cannot establish a compatible
cohort; historical results are not backfilled with current defaults.

Raw agent streams, application output, and Playwright reports stay outside Git.

Use `--results-dir <directory>` to score a separate outcome cohort. Every attempt
counts by default. A replacement requires an explicit JSON array supplied with
`--replacements <file>`:

```json
[
  {
    "excluded_trial_id": "trial-infrastructure-failure",
    "replacement_trial_id": "trial-replacement",
    "reason": "Browser installation was unavailable before agent behavior.",
    "approval_ref": "Reference to the human review approving this replacement"
  }
]
```

Both trials must exist, belong to the same case and current dataset, and the
excluded trial must be an allowlisted infrastructure failure with verified
cleanup. Behavioral failures, missing evidence, and failed cleanup cannot be
excluded. The summary retains both attempts, replacement decisions, and their
costs. `approval_ref` records human approval; the scorer cannot authenticate it.

Unknown cost produces `total: null` with separate reported and unavailable
counts. Mutation telemetry is explicitly unavailable for cases that do not
collect it. Human-intervention counts describe modeled workflow checkpoints;
they do not measure observed human effort. The classification and refusal
metrics remain compatibility aliases. Changing the model or dataset requires a
new cohort; the historical baseline remains an observation of its recorded inputs.

## Installed capability checks

```sh
npm run eval:discovery
npm run eval:checkpoint
```

Each command declares one trial and zero retries. They accept `--model`,
`--max-budget-usd`, and `--results-dir`; a budget override may lower the USD 2
ceiling. Results must go outside Git or into an ignored, untracked directory.
The defaults are under ignored `capabilities/results/<case-id>/`.

Discovery invokes the installed Explorer directly. It checks recognition of an
existing order-submission test and abstention on unsupported bulk-cancellation
intent, with a 90-second and ten-source-read budget. Actual read and browser
cleanup evidence is required. This measures the Explorer role, not Main's
discovery delegation.

The checkpoint case invokes installed Main, requests an assertion adjustment,
then chooses skip in the same resumed Claude session. It requires Author-owned
writes, successful validation, preserved scenario and criterion identities,
changed candidate bytes, a renewed checkpoint, and no test execution, mutation,
or Healer delegation. Three exchanges share a USD 2 and 600-second ceiling.
Independent assertion inspection accepts a narrow, direct Playwright syntax;
unsupported syntax is unverified. A deterministic replay checks the evaluator,
while an actual installed run establishes workflow capability.

The [Real World App generation case](targets/cypress-realworld-app/adapter/README.md#generated-username-validation-case)
uses the existing procedural adapter. Its strong, weak, and unrelated-failure
controls must establish the mutation oracle before collecting a generated
candidate. Keep controls and expected answers out of Author's context and
approve the exact generated candidate before execution.

These cases produce separate capability observations. They do not increase the
historical outcome cohort or establish reliability from a single success.

## Private evidence

Review local raw artifacts before sharing them, especially for private cases;
Playwright authentication state can contain account credentials. GitHub secret
scanning and push protection supplement these boundaries.

## CI evaluations

Pull requests run deterministic checks on Windows and Ubuntu with Node 22.13.0
and 24. CI also validates both the marketplace and plugin manifests with Claude
Code 2.1.285. These checks do not consume model usage.

The **Installed capability evaluation** workflow runs manually from a reviewed
commit on the default branch. Configure the `agent-evaluations` environment with
required reviewers and an environment-scoped `ANTHROPIC_API_KEY`. Missing
protection blocks the evaluation. The workflow uses an isolated Claude config
directory and does not persist checkout credentials.

Add the key in the repository's **Settings → Environments → agent-evaluations →
Environment secrets → Add secret**, named `ANTHROPIC_API_KEY`. Store it as a
secret, never an Actions variable or checked-in configuration. A local `.env`
file is unnecessary for CI or normal plugin development; local installed
evaluations use your existing Claude Code authentication. Use a dedicated
evaluation key and set provider spending limits separately from the per-run
agent budget.

The paid job uses Ubuntu 24.04, Node 24.22.1, npm 11.19.1, Claude Code 2.1.285,
Playwright CLI 0.1.19, and `claude-sonnet-5-5`. It provisions the CLI's system
Chrome and browser libraries; each target installs its own pinned runner browser.
Results record actual browser identities and OS/image provenance. An Ubuntu
release label does not freeze the runner image or Chrome version.

Start with `healer-defect-refusal`; `checkpoint` and `discovery` are separate
capability checks. Each dispatch declares one trial, one worker, no automatic
retries, and a USD 2 agent budget with the case's time/turn limits. Reviewing the
fixed defect-refusal case authorizes its checked-in spec at that revision.
Environment approval does not approve any newly generated candidate. Generation
and candidate execution retain their separate human checkpoints.

Select `verify_failure` to run a deliberately invalid grade without browser or
model calls. The grading step must fail and turn the job red; a green result is
an unexpected acceptance of invalid evidence. This control is not a paid trial.

Only an allowlisted summary is uploaded, for three days. It records observed
identity, grading/cleanup state, known cost, and missing evidence without raw
transcripts, commands, auth state, or exception text. Runner failures and
incomplete provenance keep the job failed. Public host fields accept only the
Ubuntu runner's release and image formats; unexpected values become null and
fail the summary check. Raw output stays on the ephemeral runner; public
artifacts and logs are not private storage.

These manual checks are not automatic baseline regression gates. The historical
baseline remains unchanged. New comparisons need complete trials under matching
dataset, runtime, host and browser profiles. Quality metrics remain manual;
approval, attribution, governance and state-integrity failures remain strict.
Scheduled capability runs and paid pull-request gates are deferred.

## Recorded results

These checks used Claude Code 2.1.278 with `claude-sonnet-5`:

- **Activation:** All three cases passed with reviewed traces, successful hooks,
  and no run errors. One Skill call for Playwright; none for Git or Cypress.
  Reported cost USD 0.25; elapsed time 64 seconds. Tested plugin revision
  `75d186d`, with 10-turn and 180-second case limits.
- **Setup:** Profile and write checks passed; Author produced a validated handoff
  without reading the profile or executing tests. The approved candidate passed
  first try and independent review confirmed Notebook, quantity 2, and Ready.
  Both temporary targets were removed. Reported Main/Author cost USD 0.28;
  451 seconds to the checkpoint and another 12 seconds for execution and cleanup.
  Tested plugin revision `d8835ce`.
- **Outcomes:** Two trials per case passed on Windows. Both generation candidates
  passed first execution and independent review. Both repairs changed only the
  intended locator and passed after two Healer attempts. Both refusal trials
  reported `product-behavior-wrong` with verified hook governance. All six
  temporary targets were removed. Reported cost USD 1.20; elapsed time 27 minutes,
  plus 28 seconds for candidate executions. The baseline records the tested
  revision and runtime profile.

Setup scoring and the outcome comparison both rejected a deliberately failed
criterion review despite a green browser test, then passed with the approved
review restored. Reported costs cover the completed checks.

These are bounded integration observations, not reliability estimates or proof
of real-app generation quality. The generation and setup cases have no mutation
adapter. Activation, assertion usefulness, repair, and defect refusal are
separate measurements.

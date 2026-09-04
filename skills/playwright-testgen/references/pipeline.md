# One-scenario pipeline

This file owns role boundaries, ordering, the human checkpoint, and final
dispositions. The workflow handles exactly one written scenario at a time.

## Contents

- [Ownership](#ownership)
- [Ordered flow](#ordered-flow)
- [Final dispositions](#final-dispositions)
- [Handoff boundary](#handoff-boundary)

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
| Run the post-Healer vacuity gate and write its report             | Main session               |
| Resolve intent, product, environment, or authentication decisions | Human or Author, as routed |

Writes stay sequential. Author is the only pre-checkpoint spec writer. Healer
may edit the approved spec only within `healing-protocol.md`; it never performs
a broad rewrite. The main session coordinates, writes only transient run
policy/artifacts, and reports; it does not explore, write product or test files,
or debug.

## Ordered flow

1. Main runs the read-only runtime preflight from `SKILL.md`. A `/setup`
   profile never replaces this check. Missing or outdated prerequisites stop
   the flow before Author and route to `/setup` when available; generation
   never installs them.
2. Main receives one written scenario, preserves its acceptance criteria,
   assigns stable local criterion identifiers and a non-sensitive scenario
   reference, identifies the target repository and proposed spec path, and
   creates the run ID with
   `node "$CLAUDE_PLUGIN_ROOT/scripts/create-testgen-run-id.cjs"` under
   `artifact-contract.md` before Author starts. Main
   also writes `.playwright-cli/testgen/<run_id>/command-policy.json` with only
   this shape:

   ```json
   {
     "approved_spec": "tests/account.spec.ts",
     "allowed_runner_options": [],
     "allowed_state_paths": [],
     "format_version": 1,
     "run_id": "tg-<24hex>",
     "allowed_origins": ["https://app.example.test"]
   }
   ```

   The origin above is illustrative; it is never a default. `approved_spec` is
   the proposed repository-relative spec path. Each allowed origin is an exact
   HTTP(S) scheme, host, and port without a path or credentials. Include only
   origins explicitly supplied for the target application. If none is known,
   stop and ask rather than starting Author.
   `allowed_runner_options` is initially empty and may contain only exact
   `--project=<name>` or `--config=<path>` arguments explicitly selected by
   Main. `allowed_state_paths` contains only existing target-repository storage
   state files explicitly supplied or approved for this scenario, expressed as
   exact paths relative to the run directory; keep it empty otherwise. Agents
   may pass an approved path to `state-load` but never read or copy its content.
   This transient Main-owned policy binds the shared PreToolUse hook to the run.
   Author and Healer must never edit it; preserve it through Healer and never
   treat it as a handoff artifact.

   Before enabling mutation verification, Main identifies one exact
   criterion-linked adapter entry and digest under `mutation-check.md` and gets
   explicit human approval. If several entries could apply, ask now; never
   choose one implicitly. When that approval exists, Main captures the
   `pre-author` boundary with the exact command in `artifact-contract.md`. Do
   this after the policy exists and before delegating Author. If no exact entry
   is approved, continue in no-adapter mode without a change manifest. If
   capture fails, stop before Author; never continue with an incomplete
   repository-state baseline.

3. Main delegates the Author stage to
   `playwright-testgen:playwright-test-author` with the run ID, original
   criteria, target repository, proposed spec path, and known route, auth, and
   data facts. Author grounds in relevant source and nearby tests, explores the
   running app with Playwright CLI, verifies its locator choices, self-checks,
   writes one spec, lints every touched test file, emits the Author handoff, and
   stops. Author never runs the spec.
4. Main validates `.playwright-cli/testgen/<run_id>/handoff.json` before
   reporting it, using the exact validator command in `artifact-contract.md`,
   and presents the candidate path, covered
   criteria, meaningful assertions, lint result, assumptions, and open
   questions.
5. The human chooses exactly one checkpoint action:
   - `run`: available only after lint succeeds; freeze the reviewed candidate
     and delegate `playwright-testgen:playwright-test-healer` in fresh context
     with explicit approval, the run ID, target repository, exact approved spec
     path, original criteria, validated handoff, and known project, config,
     route, auth, environment, and test-data facts. Before delegation, Main
     confirms `approved_spec` still names the reviewed file and records any
     exact approved project/config arguments in `allowed_runner_options`.
     When the run has a pre-Author change manifest, capture its `checkpoint`
     boundary after this human approval and before Healer delegation. A failed
     capture returns the repository-state conflict to the human and blocks the
     run.
     Never pass Author's reasoning transcript.
     Before delegation, Main writes the exact two-byte draft `{}` at
     `.playwright-cli/testgen/<run_id>/healer-trace.json` and passes that path.
     This Main-owned placeholder gives Healer's `Edit`-only mutation boundary a
     declared trace file; it is not an artifact and no consumer may read or
     report it until Healer replaces it and validation succeeds.
   - `skip`: end as `generated-unverified` and say exactly, "Explored live;
     spec never executed."
   - `adjust`: return the original scenario, current spec, and exact human
     feedback to Author; repeat lint, handoff, and checkpoint.
6. Healer verifies the delegated scope, reads the approved spec, original
   criteria, and validated handoff, then executes only that spec. It classifies
   each failure, performs only permitted repairs, replaces the declared trace
   draft with the complete artifact, validates
   `.playwright-cli/testgen/<run_id>/healer-trace.json`, and stops at the
   healing limits. Main validates the retained trace. A nonfixed disposition
   bypasses the vacuity gate and remains the run's final disposition.
7. Only a validated `fixed` trace enters Main's vacuity gate. Main does not put
   this work in `Stop` or `SubagentStop`, redispatch Healer for bookkeeping, or
   report `fixed` as the final Testgen result.
   - When the run has a change manifest, Main captures `post-healer` before
     verification. If capture fails, do not invoke the adapter; record the
     bounded capture error as behavior `error` in the vacuity report.
   - When an adapter entry and its digest were explicitly approved before
     Author, run exactly that criterion-linked entry with the command in
     `mutation-check.md`. Never add, select, or switch an adapter after Author;
     a later approval starts a new run with a new pre-Author boundary.
   - When no approved adapter exists, run the no-adapter form from
     `mutation-check.md`, even if unapproved adapter files exist. It needs no
     change manifest and returns behavior `unavailable` with reason
     `adapter-absent`.
   - Map `killed`, `survived`, and `unavailable` directly into the report's
     behavior status. Map a checker `verification-error` to behavior `error`.
     Unless a separate assertion-sensitivity check actually ran, record its
     complete status as `not-run`; do not infer evidence from the spec.
   - Main writes and validates `vacuity-report.json` with the exact command in
     `artifact-contract.md`, then reports only its derived disposition. A
     surviving product mutation is `rejected-vacuous`; include its mutation ID
     as evidence. It never automatically returns to Author. The human may start
     a new approved Author run using that evidence.
8. Main applies `cleanup-contract.md` on every exit.

Never auto-advance through the checkpoint. When lint fails, offer only `adjust`
or `skip`; do not run, change configuration, or weaken the spec.

## Final dispositions

`fixed` is a Healer-stage disposition that enters the vacuity gate. It is not a
final Testgen disposition.

| Disposition                | Meaning                                                                  | Next owner                  |
| -------------------------- | ------------------------------------------------------------------------ | --------------------------- |
| `generated-unverified`     | Human skipped execution                                                  | Human                       |
| `verified-non-vacuous`     | Approved product mutation was killed by the fixed spec                   | Human                       |
| `rejected-vacuous`         | Runnable product or assertion mutation survived                          | Human                       |
| `assertion-sensitive-only` | Assertion sensitivity was shown without product-behavior verification    | Human                       |
| `mutation-not-verified`    | No approved product adapter was available and no secondary check ran     | Human                       |
| `verification-error`       | The gate could not establish a trustworthy verification result           | Human                       |
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

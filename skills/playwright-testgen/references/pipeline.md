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
| Validate project runtime prerequisites before generation          | Main session               |
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

Main's repository discovery is limited to package metadata, the selected
Playwright config, existing Playwright spec paths and naming (not their bodies),
an actual `/setup` profile when present, and runtime readiness. Feature source,
nearby test bodies, and rendered behavior belong to Author. A target descriptor
may guide evaluation setup, but its expected outcomes and locator convention are
evaluation metadata, not an operational profile, and must not be sent to Author.

## Ordered flow

1. Main runs the single read-only runtime preflight command from `SKILL.md`
   from the repository root. Missing or unsupported required prerequisites
   stop the flow before Author; generation never installs them. Main also
   confirms the application is already running at the approved origin and
   records separate readiness facts for the Playwright CLI exploration browser
   and the browser selected by the repository's existing runner configuration.
2. Main receives one written scenario, preserves its acceptance criteria,
   assigns stable local criterion identifiers and a non-sensitive scenario
   reference, identifies the repository root and proposed spec path, and
   creates the run ID with
   `node "$PLAYWRIGHT_TESTGEN_ROOT/scripts/create-testgen-run-id.cjs"` under
   `artifact-contract.md` before Author starts.

   Complete pre-Author setup in this order:

   1. derive the concrete scenario reference, criteria, spec path, origin, and
      readiness facts, including `/setup` profile presence, existing Playwright
      spec presence, browser readiness, and the selected validation path;
   2. create the run ID, write the run policy, and obtain its exact approved
      spec filter;
   3. when a prepared matching mutation entry exists, ask whether to run it;
      otherwise record no-adapter mode without presenting mutation details;
   4. capture the `pre-author` boundary when that check is approved; and
   5. delegate Author with the concrete values and readiness facts, including
      `runtime preflight: passed`.

   Main derives the scenario reference; never require the human to supply one.
   An explicit spec path wins. Otherwise, inspect existing Playwright specs and
   the selected Playwright config, then match their test directory, naming, and
   language. Use JavaScript only when existing Playwright specs establish that
   convention. When no Playwright specs exist, default to a descriptive
   TypeScript `.spec.ts` file in the configured test directory. Ask before
   creating the policy when conventions or the selected config are ambiguous.
   Playwright transforms `.spec.ts` files without a project `tsconfig` or direct
   `typescript` dependency; this does not replace a repository's own typecheck.
   Only an actual `/setup` profile can make a locator convention
   `profile-backed`. Without one, tell Author no profile exists and let it run
   the single bounded convention scan. Never substitute evaluation metadata or
   Main's source guess for that profile.

   Main writes `.playwright-cli/testgen/<run_id>/command-policy.json` with only
   this shape:

   ```json
   {
     "approved_spec": "tests/account.spec.ts",
     "allowed_runner_options": [],
     "allowed_state_paths": [],
     "allowed_write_paths": [],
     "format_version": 1,
     "run_id": "tg-<24hex>",
     "allowed_origins": ["https://app.example.test"],
     "trace_snapshot_option": "--name"
   }
   ```

   The origin above is illustrative; it is never a default. `approved_spec` is
   the proposed repository-relative spec path. Each allowed origin is an exact
   HTTP(S) scheme, host, and port without a path or credentials. Include only
   origins explicitly supplied or confirmed for the target application. Main
   may inspect an existing selected Playwright config for a candidate origin,
   but discovery is not approval. If no single candidate is known and
   confirmed, stop and ask rather than starting Author.
   `allowed_runner_options` is initially empty and may contain only exact
   `--project=<name>` or `--config=<path>` arguments explicitly selected by
   Main. `allowed_state_paths` contains only existing repository storage
   state files explicitly supplied or approved for this scenario, expressed as
   exact paths relative to the run directory; keep it empty otherwise. Agents
   may pass an approved path to `state-load` but never read or copy its content.
   `allowed_write_paths` contains at most ten exact repository-relative paths
   to existing regular files that Main has explicitly approved for a focused
   shared-helper or test-id edit; keep it empty otherwise. The approved spec is
   writable separately and may be new. If Author discovers that another edit
   is necessary, it returns the exact path and evidence to Main for approval
   and redispatch instead of attempting the edit.
   `trace_snapshot_option` is the exact `--name` or `--phase` spelling selected
   by runtime preflight for this Playwright/CLI combination, or `null` when
   optional trace snapshot inspection is unavailable. Agents never select or
   substitute it themselves.
   This transient Main-owned policy binds the shared PreToolUse hook to the run.
   Author and Healer must never edit it; preserve it through Healer and never
   treat it as a handoff artifact.

   From the repository root, Main obtains the shell-safe approved spec
   filter after writing the policy:

   ```sh
   node "$PLAYWRIGHT_TESTGEN_ROOT/scripts/print-approved-spec-filter.cjs" <run_id>
   ```

   Main passes that output unchanged to Author for the collection-only fallback
   and later regenerates it before Healer execution. Neither role reconstructs
   the regex. The fallback is available only while this is the repository's one
   active Testgen run policy. Concurrent runs may use a compatible repository
   linter or serialize collection; never remove another run's policy.

   Before enabling mutation verification, Main identifies one exact
   criterion-linked adapter entry and digest under `mutation-check.md` and uses
   its exact user-first approval question. If several entries could apply, ask
   now; never choose one implicitly. If no prepared adapter exists, do not ask
   for mutation approval or expose patch/digest setup instructions. When approval
   exists, Main captures the `pre-author` boundary with the exact command in
   `mutation-check.md`. Do
   this after the policy exists and before delegating Author. If an approved
   adapter has no entry for the required criterion, retain its path for the
   later `criterion-unmapped` coverage check but continue without a change
   manifest. If no adapter is approved, continue in no-adapter mode. If capture
   fails, stop before Author; never continue with an incomplete
   repository-state baseline.

3. Main delegates the Author stage to
   `playwright-testgen:playwright-test-author` with the run ID, actual derived
   `scenario_ref`, original criteria, repository root, proposed spec path,
   exact approved spec filter, every approved project or config option, and
   known route, auth, and data facts. State `runtime preflight: passed` so
   Author does not repeat it. Before delegation, Main confirms the
   target application is already running at the approved origin and supplies
   separate exploration-browser and runner-browser readiness facts plus the
   selected validation path. Author never derives a required value,
   starts the application, or installs a browser or package. Author grounds in
   relevant source and nearby tests, explores the running app with Playwright
   CLI, verifies its locator choices, self-checks, writes one spec, validates
   touched test files under `test-policy.md`, emits the Author handoff, and
   stops. Author never runs the spec.
4. Main validates `.playwright-cli/testgen/<run_id>/handoff.json` before
   reporting it, using the exact validator command in `artifact-contract.md`,
   and presents the candidate path, covered
   criteria, meaningful assertions, lint result, assumptions, and open
   questions.
5. The human chooses exactly one checkpoint action:
   - `run`: available only after lint succeeds; freeze the reviewed candidate
     and delegate `playwright-testgen:playwright-test-healer` in fresh context
     with explicit approval, the run ID, repository root, exact approved spec
     path, original criteria, validated handoff, `runtime preflight: passed`,
     the selected trace snapshot option or explicit `unavailable`, and known
     project, config, route, auth, environment, and test-data facts.
     Before delegation, Main confirms `approved_spec` still names the reviewed
     file and obtains its shell-safe approved spec filter argument from the
     repository root:

     ```sh
     node "$PLAYWRIGHT_TESTGEN_ROOT/scripts/print-approved-spec-filter.cjs" <run_id>
     ```

     Pass the output to Healer unchanged; neither role reconstructs the regex.
     Main records any exact approved project/config arguments in
     `allowed_runner_options`. Every recorded option is mandatory on every
     runner invocation; omission is not a fallback.
     Supply only facts active in this run. Do not mention inactive fixture
     variants, mutation patches, or adapter internals in the Healer dispatch;
     the post-Healer mutation check remains Main-owned.
     When the run has a pre-Author change manifest, capture its `checkpoint`
     boundary after this human approval and before Healer delegation. A failed
     capture returns the repository-state conflict to the human and blocks the
     run.
     Never pass Author's reasoning transcript.
     Before delegation, Main writes the exact two-byte draft `{}` at
     `.playwright-cli/testgen/<run_id>/healer-trace.json` and passes that path.
     This Main-owned placeholder gives Healer's whole-file `Write` mutation
     boundary a declared trace file. Healer reads this draft once immediately
     before replacement and verifies it is exactly `{}`; no other consumer may
     read or report it before replacement and validation succeed.

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
   bypasses the vacuity gate and remains the run's final disposition. After
   reporting and human acceptance of `product-behavior-wrong`, Main asks once
   whether to save the sanitized finding, then runs exactly:

   ```sh
   node "$PLAYWRIGHT_TESTGEN_ROOT/scripts/record-testgen-finding.cjs" --repo . --run-id <run_id> --decision <approved|declined>
   ```

   Record a recorder failure separately, then remove only
   `.playwright-cli/testgen/<run_id>`. Other nonfixed outcomes never create a
   finding.
7. Only a validated `fixed` trace enters Main's vacuity gate. Main does not put
   this work in `Stop` or `SubagentStop`, redispatch Healer for bookkeeping, or
   report `fixed` as the final Testgen result.
   A valid fixed trace names `main` as `next_owner`; it never routes directly to
   the human before this gate.
   - When the run has a change manifest, Main captures `post-healer` before
     verification. If capture fails, do not invoke the adapter; record the
     bounded capture error as behavior `error` in the vacuity report.
   - When an adapter entry and its digest were explicitly approved before
     Author, run exactly that mutation-and-criterion-linked entry with the
     command in `mutation-check.md`. Never add, select, or switch an adapter
     after Author; a later approval starts a new run with a new pre-Author
     boundary.
   - When an approved adapter had no entry for the required criterion, run the
     coverage-only form from `mutation-check.md` without a mutation ID or
     digest. It returns behavior `unavailable` with reason
     `criterion-unmapped`; it can never execute a mutation.
   - When no approved adapter exists, run the no-adapter form from
     `mutation-check.md`, even if unapproved adapter files exist. It needs no
     change manifest and returns behavior `unavailable` with reason
     `adapter-absent`.
   - Map `killed`, `survived`, and `unavailable` directly into the report's
     behavior status. Map a checker `verification-error` to behavior `error`.
     Unless a separate assertion-sensitivity check actually ran, record its
     complete status as `not-run`; do not infer evidence from the spec.
   - Main writes and validates `vacuity-report.json` with the exact command in
     `mutation-check.md`, then reports the validator's separate execution and
     mutation-verification summary plus its derived disposition. A
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

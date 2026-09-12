# Product mutation check

Use targeted product mutations only for a controlled fixture or a repository
adapter whose exact definition a human has approved. Never mutate the user's
active checkout. A missing adapter is an unavailable verification mode, not
permission to invent a mutation.

## Contents

- [Adapter contract](#adapter-contract)
- [Approval](#approval)
- [Main-owned bookkeeping](#main-owned-bookkeeping)
- [Verification](#verification)
- [Results](#results)
- [Vacuity report](#vacuity-report)

## Adapter contract

An adapter is a committed `mutation-adapter.v1` JSON file with one committed
Node runner and one or more criterion-linked patch entries. Its public schema
is `${CLAUDE_PLUGIN_ROOT}/schemas/mutation-adapter.v1.schema.json`.

The manifest contains:

- one bounded `adapter_id` and repository-relative `runner_path`;
- for each entry, a unique `mutation_id` and `criterion_id`;
- one or more committed regular product files in `affected_paths`;
- one repository-relative `patch_path`, a `definition_digest`, and a bounded
  `timeout_ms`.

The adapter, runner, and patch must be regular files inside the repository,
committed at the run's recorded `HEAD`, and unchanged. A mutation cannot target
its manifest, runner, or any adapter patch. Testgen applies the patch itself;
the runner receives no product-mutation API.

The runner is invoked in the disposable checkout with literal `--phase`,
`--spec`, `--criterion-id`, and `--step-title` arguments. The step title comes
from the validated Author handoff. The runner independently checks the exact
approved spec's report and may attribute a failure only when the failed result
contains that exact descriptive step with its own error. This out-of-band
mapping survives line movement during healing without adding Testgen markers to
the generated spec. The runner translates the result into one JSON object on
stdout:

```json
{ "protocol_version": 1, "outcome": "pass", "criterion_id": null }
```

```json
{ "protocol_version": 1, "outcome": "fail", "criterion_id": "criterion-1" }
```

For an operational problem it uses `outcome: "error"`, a null criterion, and a
short lowercase hyphenated `reason`. Raw Playwright output, logs, file content,
environment values, and secrets never enter this protocol.

## Approval

Only ask when Main has identified one exact prepared adapter entry for the
required criterion. With no prepared adapter, do not ask this question or show
patch/digest instructions; continue in no-adapter mode.

For a prepared matching entry, use this exact user-first question and choices,
then append the technical identifiers:

> **Run mutation check after the generated test passes?**
>
> Testgen will temporarily break the selected behavior in a disposable Git
> worktree and rerun the test to confirm it catches the break. The active
> checkout is not changed.

- `Run mutation check (recommended)` — prove the test fails when the selected
  behavior is broken.
- `Skip mutation check` — continue without this proof and report
  `mutation-not-verified`.

Then show the exact adapter, mutation, criterion, and digest as technical
details. Approval applies only to the current workflow run; never reuse it
automatically.

Compute the digest for a proposed entry with:

```sh
node "$PLAYWRIGHT_TESTGEN_ROOT/scripts/mutation-check.cjs" digest --repo . --adapter <manifest> --mutation-id <mutation_id>
```

Run every mutation-check command directly from the repository root. Pass the
literal `--repo .` and a repository-relative adapter path such as
`.testgen/mutation-adapter.json`; do not substitute absolute paths. The adapter
contract rejects an absolute adapter path.

Use 64 lowercase zeroes as the draft `definition_digest`, replace that
placeholder with the command's returned digest, then commit the definition.
The digest binds the adapter and mutation identifiers, criterion, sorted
affected paths, runner path and bytes, patch path and bytes, and timeout. Record
the final digest in the entry and present the same digest for explicit human
approval. Never feed `digest` output directly into verification as automatic
approval. Obtain approval before the pre-Author boundary and Author delegation;
a later approval requires a new run. A controlled fixture harness may instead
provide a separately pinned digest.

## Main-owned bookkeeping

When Main has a controlled fixture or an explicitly approved mutation entry,
it creates `change-manifest.v1` at
`.playwright-cli/testgen/<run_id>/change-manifest.json`. This transient artifact
records `HEAD` plus sorted repository-relative paths, state kinds, and SHA-256
fingerprints; it never stores diffs or file contents. Author and Healer may read
its paths and fingerprints but never mutate it.

Capture its boundaries from the repository root:

```sh
node "$PLAYWRIGHT_TESTGEN_ROOT/scripts/mutation-check.cjs" capture --repo . --run-id <run_id> --boundary pre-author
node "$PLAYWRIGHT_TESTGEN_ROOT/scripts/mutation-check.cjs" capture --repo . --run-id <run_id> --boundary checkpoint
node "$PLAYWRIGHT_TESTGEN_ROOT/scripts/mutation-check.cjs" capture --repo . --run-id <run_id> --boundary post-healer
```

Capture `pre-author` after writing policy and before Author, `checkpoint` after
human run approval and handoff validation, and `post-healer` after trace
validation. The later boundaries reject changed pre-existing dirty paths,
unreported Author or Healer writes, changed `HEAD`, and unrelated fingerprint
drift. Its schema is
`${CLAUDE_PLUGIN_ROOT}/schemas/change-manifest.v1.schema.json`. Retain it through
verification, then remove it with run scratch under `cleanup-contract.md`.

## Verification

After Healer stops, Main runs verification only for a schema-valid `fixed`
pipeline trace and a criterion retained in the validated Healer input. The
validated Author handoff remains required for Author change attribution. With
an approved adapter, run this after all three change-manifest boundaries are
valid:

```sh
node "$PLAYWRIGHT_TESTGEN_ROOT/scripts/mutation-check.cjs" verify --repo . --run-id <run_id> --adapter <manifest> --mutation-id <mutation_id> --criterion-id <criterion_id> --approval-digest <sha256>
```

The mutation ID, criterion ID, and digest must bind the same approved entry. If
an approved adapter has no entry for the required criterion, use the same
command without `--mutation-id` and `--approval-digest`; no change manifest is
required, and it returns `unavailable` with reason `criterion-unmapped`. If the
adapter does map the criterion, those omitted arguments are an approval error,
not permission to execute it.

When no approved adapter exists, also omit `--adapter`. After validating the
fixed trace and criterion, the command returns `unavailable` with reason
`adapter-absent` without attempting product mutation.

Adapter verification requires a Git repository with a committed `HEAD` and the
Git CLI available. The target runner owns application-specific dependencies,
server startup, test execution, and shutdown.

The checker requires the active repository to match the post-Healer snapshot.
It creates a detached OS-temporary Git worktree at the recorded `HEAD`, overlays
only final regular files attributable to Author or Healer, and excludes all
unrelated pre-existing dirty content. It then:

1. requires the approved spec to pass at baseline;
2. applies the one approved patch;
3. verifies that exactly `affected_paths` changed;
4. runs the same spec against the mutant and requires criterion-linked failure
   evidence from the approved target runner;
5. verifies that neither runner changed the disposable checkout beyond the
   approved patch; and
6. cancels the runner process tree on timeout or interruption, removes the
   worktree in `finally`, then rechecks the active checkout and its `HEAD`.

Before execution, the checker reserves Main-owned `mutation-recovery.json` with
the exact temporary root and worktree paths. An existing record blocks another
verification. Successful cleanup removes the reservation; failed cleanup keeps
it for supervised recovery under `cleanup-contract.md` while preserving the
primary result separately.

The approved target runner must not detach children. It owns normal server and
test-process shutdown; the outer checker owns the adapter timeout and
cancellation boundary.

The worktree isolates ordinary relative writes; it is not an operating-system
security sandbox. The approved digest therefore binds the executable runner as
part of the trusted adapter definition.

## Results

- `killed` — the baseline passed and the mutant failed for the mapped criterion.
- `survived` — the baseline and mutant both passed.
- `unavailable` — no approved adapter exists (`adapter-absent`), or its manifest
  has no mutation for the requested criterion (`criterion-unmapped`).
- `verification-error` — the baseline, runner, patch, isolation, attribution,
  timeout, or cleanup was invalid.

An unrelated red mutant is `verification-error`, never `killed`.

## Vacuity report

Main alone writes `.playwright-cli/testgen/<run_id>/vacuity-report.json` after a
validated `fixed` trace. Read
`${CLAUDE_PLUGIN_ROOT}/schemas/vacuity-report.v1.schema.json` when writing it.
It binds the approved spec to separate product-mutation and assertion-sensitivity
results. Author and Healer never mutate it.

Map checker `killed`, `survived`, and `unavailable` to the same behavior status;
map `verification-error` to behavior `error`. `unavailable` is limited to
`adapter-absent` and `criterion-unmapped`; operational failures are errors. If
no separate assertion-sensitivity check ran, record its complete status as
`not-run`. The resulting dispositions are:

- behavior `killed`: `verified-non-vacuous`;
- behavior or assertion `survived`: `rejected-vacuous`;
- unavailable behavior plus assertion `killed`: `assertion-sensitive-only`;
- unavailable behavior plus assertion `not-run`: `mutation-not-verified`;
- behavior error, or unavailable behavior plus assertion error:
  `verification-error`.

Validate the complete report from the repository root:

```sh
node "$PLAYWRIGHT_TESTGEN_ROOT/scripts/validate-testgen-artifact.cjs" --repo . --type vacuity --run-id <run_id> .playwright-cli/testgen/<run_id>/vacuity-report.json
```

Use only the validator's deterministic `summary` fields when reporting routine
results. Present `Execution` separately from `mutation verification`; for
example: “Execution: passed after one repair. Mutation verification:
unavailable — no prepared adapter.” Keep the machine disposition unchanged.
The summary never adds mutation identifiers when no adapter ran.

# Product mutation check

Use targeted product mutations only for a controlled fixture or a repository
adapter whose exact definition a human has approved. Never mutate the user's
active checkout. A missing adapter is an unavailable verification mode, not
permission to invent a mutation.

## Contents

- [Adapter contract](#adapter-contract)
- [Approval](#approval)
- [Verification](#verification)
- [Results](#results)

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
`--spec`, and `--criterion-id` arguments. It translates the exact approved
spec's result into one JSON object on stdout:

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

Compute the digest for a proposed entry with:

```sh
node "$CLAUDE_PLUGIN_ROOT/scripts/mutation-check.cjs" digest --repo . --adapter <manifest> --mutation-id <mutation_id>
```

Use 64 lowercase zeroes as the draft `definition_digest`, replace that
placeholder with the command's returned digest, then commit the definition.
The digest binds the adapter and mutation identifiers, criterion, sorted
affected paths, runner path and bytes, patch path and bytes, and timeout. Record
the final digest in the entry and present the same digest for explicit human
approval. Never feed `digest` output directly into verification as automatic
approval. Obtain approval before the pre-Author boundary and Author delegation;
a later approval requires a new run. A controlled fixture harness may instead
provide a separately pinned digest.

## Verification

After Healer stops, Main runs verification only for a schema-valid `fixed`
trace and a criterion retained in the validated handoff. With an approved
adapter, run this after all three change-manifest boundaries are valid:

```sh
node "$CLAUDE_PLUGIN_ROOT/scripts/mutation-check.cjs" verify --repo . --run-id <run_id> --adapter <manifest> --mutation-id <mutation_id> --criterion-id <criterion_id> --approval-digest <sha256>
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
4. runs the same spec against the mutant; and
5. removes the worktree in `finally` and rechecks the active checkout.

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

An unrelated red mutant is `verification-error`, never `killed`. These are
mechanism results. Main records them separately from assertion sensitivity in
the `vacuity-report.v1` contract defined by `artifact-contract.md`;
`verification-error` becomes the report's bounded behavior `error`. The report
and its disposition remain owned by Main. If no separate assertion-sensitivity
check ran, record its complete result as `not-run`; unavailable behavior then
becomes `mutation-not-verified`.

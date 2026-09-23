# Scenario sourcing

This file owns Explorer discovery, human scenario selection, and the transient
queue used when more than one scenario is selected. Generation still uses the
one-scenario ordered flow in `pipeline.md`.

## Discovery

When Main coordinates Explorer in the full pipeline or through an explicit
standalone request, it first completes runtime and application/browser
readiness checks, creates a discovery ID with the normal run-ID script, and
writes `.playwright-cli/testgen/<discovery_id>/command-policy.json` with only:

```json
{
  "allowed_browser_actions": [],
  "allowed_origins": ["https://app.example.test"],
  "allowed_state_paths": [],
  "discovery_id": "tg-<24hex>",
  "format_version": 1,
  "package_directory": ".",
  "policy_kind": "discovery"
}
```

The origin is illustrative, never a default. `allowed_origins` always contains
the one confirmed target application origin, including static or no-browser
discovery; an empty list is invalid and does not grant browser actions.
`allowed_state_paths` follows the same exact existing-file and opacity rules as
generation. Keep
`allowed_browser_actions` empty unless the human approved a concrete exploration
scope and reset or cleanup method. It may then contain only the action names
`check`, `click`, `dblclick`, `fill`, `keydown`, `keyup`, `press`, `select`,
`type`, or `uncheck` that the approved scope needs. This policy contains no
`approved_spec`, runner options, write paths, trace options, or generation
`run_id`; it grants no test or repository-write authority.
`package_directory` is the selected package relative to the Git-owned policy
root. Explorer source reads, bounded searches, and history start from that exact
package; `.` means the root package.

Main delegates `playwright-testgen:playwright-test-explorer` with the passed
preflight fact, discovery ID, repository root, selected package/config mode,
relevant fresh profile facts, approved origin, application and
exploration-browser readiness, auth/data facts, exact approved state paths, and
optional human scope. For an approved state-changing action, also pass the
action names, semantic scope, and reset or cleanup method. Never pass evaluation
answers, seeded bugs, mutation metadata, or expected classifications.

Explorer reads at most ten source/test files or works for 90 seconds, reads no
more than the latest twenty commits, and returns at most five proposals plus its
inspected scope and limits. Main rejects output that exceeds those bounds or
omits a proposal's local ID, route, user goal, observable criteria, source/test
references, labeled expected-behavior evidence, coverage status, priority
reason, or auth/data prerequisites and unresolved questions. Coverage status is
exactly `apparently-covered`, `candidate-gap`, or `unknown`. Bare implementation
mechanics and live observation are current-behavior evidence, not
intended-behavior evidence; source counts for intent only when it explicitly
states a product rule or contract. `no supported proposal` is valid when the
evidence cannot support a gap or recent meaningful UI change.

The time and cumulative-Read limits are agent-enforced in this phase. Hooks
bound individual operations but do not count elapsed time or total reads.

The result is transient untrusted proposal text, not a persisted artifact or an
Author assignment. The human may select, edit, reject, or narrow it. Main closes
Explorer's scope and removes the exact discovery directory under
`cleanup-contract.md`; a cleanup failure stops this route. In the full pipeline,
Main creates a fresh generation run only after one or more scenario intents are
approved. Selection never approves a spec path, execution, or mutation.
Standalone Explorer validates and reports the proposals, performs discovery
cleanup, and stops before scenario selection.

When presenting valid proposals, Main shows each complete compact proposal,
including its source/test references, expected-behavior evidence label, coverage,
and prerequisites or questions. Do not replace them with a title-only or lossy
summary. Explorer's observed test-id convention is reporting evidence only; it
is not a `/setup` profile and does not replace Author's bounded convention scan.
Preserve Explorer's reported `Reads` and `Budget` status exactly. Never infer
that a limit was exhausted from approximate wall time or tool-call totals; when
the report and independent evidence conflict, state that the boundary is
unverified.

## Sequential queue

When the human selects multiple Explorer proposals, Main keeps their order in a
transient queue around the existing one-scenario flow. It does not create a
scheduler, run Authors or Healers in parallel, or share a mutable run policy.
Only one scenario is active at a time.

Before Author writes anything, Main compares the selected proposal IDs and
intents for duplicate scenarios, proposes every spec path using the detected
Playwright layout (or a descriptive TypeScript layout when none exists), and
resolves path collisions with existing files and other queued items. Never
overwrite another scenario's spec implicitly.

Each activated item receives a fresh run ID, criterion mapping, policy, handoff,
Healer input, trace, spec path, and optional approved mutation baseline. Run the
complete ordered flow in `pipeline.md`: candidate checkpoint, optional Healer
and vacuity result, human acceptance, and scoped cleanup. Finish those steps
before activating the next scenario.

Capture every approved mutation baseline from the actual then-current checkout,
including earlier approved specs. Never reuse another scenario's snapshots,
reset the checkout to the first scenario's state, or discard an earlier spec.
Arrange independent test data for every scenario or use an explicitly approved
reset; no test may depend on a prior scenario having run.

`skip` completes only the current scenario as `generated-unverified`; it does
not affect later items. Explicit batch cancellation preserves completed files
and results and marks every untouched item `not-started`. On a product,
environment, authentication, unresolved healing, verification, or cleanup
failure, pause the queue and let the human choose whether to continue or cancel.
A cleanup failure keeps the queue paused before activating the next scenario.
Execution approval and mutation approval never carry from one scenario into
another.

Use this shape for every final summary entry:

```text
Scenario: <reference>
Spec: <path>
Run: <run ID or not allocated>
Checkpoint: <run, adjust then final decision, skip, or not reached>
Disposition: <final disposition>
Healer attempts: <count or not-run>
Mutation: <coverage/result or not-run>
Owner: <unresolved owner or none>
```

Report blocked and `not-started` entries directly; never collapse the queue into
"all passed." Derive the retained spec count and current checkout status after
accepted cleanup; do not present a historical controlled defect as current.

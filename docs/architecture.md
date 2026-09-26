# Architecture

Playwright Testgen is a Claude Code plugin that turns one written scenario into
one grounded Playwright test. It separates writing, execution, and repair so a
passing-looking test cannot silently replace the requested behavior.

## Ownership

- **Main** owns preflight, run policy, the human checkpoint, artifact
  validation, optional mutation verification, final reporting, cleanup, and
  the explicitly approved `/setup` profile/remediation flow.
- **Explorer** performs bounded, read-only scenario discovery and returns
  evidence-backed proposals without choosing a spec path or executing tests.
- **Author** reads the scenario, relevant project source, and live application;
  writes one candidate spec; validates that it loads; and stops before running
  it.
- **Healer** runs only the approved spec, diagnoses failures from current
  evidence, makes bounded test repairs, and refuses to edit around product
  defects.
- **The human** chooses `run`, `adjust`, or `skip`, approves mutation adapters,
  and decides whether a sanitized product finding becomes durable.

Main does not perform Explorer, Author, or Healer work. Governed agents do not
change Main-owned policy or result artifacts.

## Runtime boundary

The project being tested owns its local `playwright` and `@playwright/test`,
configuration, package manager, fixtures, test layout, browser choice, and CI.
Preflight accepts those packages only when they resolve inside that project's
canonical repository root. The official `playwright-cli` is deliberately a
separate global installation.

Normal generation does not install project dependencies or rewrite existing
Playwright configuration and CI rules. Optional setup may offer one bounded
compatible remedy after approval, then rechecks it. The ignored target-owned
profile records only non-secret navigation evidence bound to one Git root,
package, and config or configless mode. Governed roles cannot read or edit it.
Authentication state remains opaque; human capture is setup-owned and separate
from login-test generation.

## Workflow and evidence

Discovery has its own read-only policy and ID. A proposal is not an assignment:
human selection approves intent only, and Main then closes discovery and starts
a fresh generation run. That run has one ID, one approved spec, and one human
checkpoint. Its policy binds browser navigation, file writes, runner arguments,
output directories, and artifact validation. Hook decisions constrain
delegated agents, but they are guardrails rather than an operating-system
sandbox.

Main normalizes either a validated Author handoff or explicit standalone intent
into one read-only Healer input. Its starting digest records the approved spec
bytes while still permitting declared repairs. Healer traces connect those
criteria to execution evidence without retaining raw pages, logs, credentials,
or agent reasoning. A fixed pipeline test can enter the optional vacuity gate, which applies only
an explicitly approved criterion-linked mutation in a disposable Git worktree.
The active checkout must remain unchanged.

## Artifacts and cleanup

`.playwright-cli/testgen/<run-id>/` is transient. It contains policy, bounded
handoff, Healer input, trace data, runner evidence, and optional mutation state. Main
removes only that exact directory after the result is accepted.

`.playwright-testgen/profile.v1.json` and approved durable authentication state
live outside run scratch and survive normal cleanup. Failed setup removes only
new incomplete output and preserves prior files.

For an accepted `product-behavior-wrong` result, the human may approve one
sanitized entry in `.playwright-cli/testgen/findings.md`. That sibling file is
durable and contains only the run ID, classification, criterion ID, spec path,
and bounded observed behavior. Declining creates nothing; cleanup preserves an
existing findings file.

## Non-goals

Testgen is not a generic test framework, CI replacement, package installer,
credential manager, process sandbox, or license to repair application code.
Evaluation runners measure Testgen separately and never run automatically
during normal generation.

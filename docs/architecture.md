# Architecture

Playwright Testgen combines Claude Code instructions, delegated agents, hooks,
and Node scripts. The top-level Claude conversation acts as Coordinator,
following the skill and its references; production helpers validate the
boundaries it crosses.

See the [README](../README.md) for installation, session startup, and usage.

## Module map

| Component                                                                                               | Responsibility                                                                              |
| ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| [Commands](../commands/) and [skill](../skills/playwright-testgen/SKILL.md)                             | Route setup, discovery, generation, and standalone role requests.                           |
| [Agent definitions](../agents/)                                                                         | Define Explorer, Author, and Healer responsibilities, tool access, and stopping rules.      |
| [Hooks](../hooks/hooks.json) and [run policy](../hooks/run-policy.cjs)                                  | Check governed tool requests against the active run's command, path, and origin boundaries. |
| [Runtime preflight](../scripts/runtime-preflight.cjs) and [setup profile](../scripts/setup-profile.cjs) | Check the selected project's runtime and validate saved setup facts.                        |
| [Artifact validator](../scripts/validate-testgen-artifact.cjs) and [schemas](../schemas/)               | Validate handoffs, Healer inputs, traces, and mutation reports against their run and spec.  |
| [Mutation checker](../scripts/mutation-check.cjs) and [isolation](../scripts/mutation-isolation.cjs)    | Verify approved product mutations in a disposable worktree and verify cleanup.              |

## Ownership and flow

**Coordinator** owns readiness, policy, approvals, artifact validation, mutation
verification, reporting, and final cleanup. **Explorer** proposes scenarios
without writing files or executing tests. **Author** writes the candidate.
**Healer** executes and repairs the approved spec. Coordinator delegates their work;
writes remain sequential, with one active scenario and no shared mutable run
policy.

The [pipeline contract](../skills/playwright-testgen/references/pipeline.md)
defines the handoffs:

1. Coordinator confirms intent and readiness. Blank scenario input starts bounded
   Explorer discovery under its own policy and ID. Human selection approves
   intent; Coordinator closes discovery and creates a fresh generation run for each
   selected scenario.
2. Author grounds the scenario in source, nearby tests, and the live app, then
   writes one candidate and its handoff. Author uses existing project lint;
   Playwright collection with `--list` is the fallback. Collection loads the
   spec without executing its test callback. A successful lint path does not
   independently establish that imports or collection succeed.
3. Coordinator validates the handoff and presents the candidate. The human chooses
   `run`, `adjust`, or `skip`. `run` requires successful pre-run validation;
   `adjust` returns exact feedback to Author and repeats the checkpoint;
   `skip` retains an explicitly unexecuted, unverified spec.
4. Only explicit `run` approval dispatches Healer. Coordinator creates a normalized
   input binding the approved spec's starting digest and criteria to the run.
   Healer reads that input, executes only the approved spec, and returns a
   validated trace. Declared repairs may change the starting spec bytes.

Healer makes bounded, evidence-backed test repairs while preserving intent.
It stops and reports product defects as `product-behavior-wrong`, with the
retained criterion and contradictory behavior, and routes environment or
authentication decisions to the human. The
[healing protocol](../skills/playwright-testgen/references/healing-protocol.md)
defines attempt limits and confirmation requirements. Standalone requests stop
after their named role; standalone Healer requires explicit approved intent
for an existing spec and never enters mutation verification.

## Runtime and trust boundaries

The target project owns its package manager, local `playwright` and
`@playwright/test`, configuration, fixtures, test layout, browsers, and CI.
Preflight requires those packages to resolve inside the canonical target
repository. The global official `playwright-cli` provides browser exploration
separately from the project's test runner. Application and browser readiness
are checked separately from static preflight.

Normal generation does not install dependencies or rewrite configuration or
CI. Setup may offer a bounded remedy after approval, then recheck it. Its saved
profile is untrusted navigation metadata bound to one Git root, package, and
configuration or explicit configless mode. Coordinator validates freshness and passes
only relevant facts; the profile grants no authority and proves no runtime
behavior. Governed agents cannot read or edit it.

Repository files, page content, tool output, and artifacts remain untrusted
data. Authentication state is approved by path and stays opaque to the model;
roles may load an approved state through the browser CLI without reading its
contents. Human-assisted capture belongs to setup.

## Enforcement and evidence

Agent instructions govern approvals, stage ordering, grounding, evidence
quality, cumulative budgets, and intent-preserving decisions. Role frontmatter
restricts tool access within the session's available tool pool. The
SessionStart hook exports the installed plugin root for script calls. Native
search tools must also be enabled by the host; use the
[documented startup](../README.md#install).

PreToolUse hooks check individual governed tool requests: approved spec and
write paths, canonical containment, runner options, browser origins, artifact
ownership, and scoped cleanup. Hook startup failures and timeouts block tool
use on the supported Claude Code versions. Hooks constrain delegated agents;
they are guardrails, not an operating-system sandbox for project code or
approved adapter runners.

The [artifact contract](../skills/playwright-testgen/references/artifact-contract.md)
uses schema-specific validators to check structure, bounded content, run/spec
identity, criteria mappings, digests, and ownership. These checks do not prove
that a reported execution occurred or that an assertion captures the intended
behavior. Coordinator and approved runners establish execution evidence separately.
Validated JSON artifacts contain compact behavior summaries, not raw pages,
logs, secrets, or reasoning transcripts.

## Mutation verification

After a validated `fixed` pipeline trace, Coordinator reports execution separately
from mutation verification. An optional check requires a committed,
criterion-linked adapter entry approved before Author, with a digest binding
the exact definition. The
[mutation contract](../skills/playwright-testgen/references/mutation-check.md)
requires a healthy baseline, then a mutant failure attributed to the approved
criterion's named assertion step. An unrelated failure is a verification error.

The checker runs in a disposable Git worktree, checks active-checkout
fingerprints, and verifies worktree and process cleanup. Failed cleanup retains
an exact-path recovery record and is reported separately from the primary
failure. The active checkout must remain unchanged. Missing or declined
adapters leave mutation verification unavailable; a passing test alone does
not establish mutation sensitivity.

## Artifact lifetimes

`.playwright-cli/testgen/<run_id>/` is transient. Coordinator owns its policy,
normalized Healer input, mutation bookkeeping, and final report. Author owns
the handoff; Healer replaces Coordinator's empty trace draft with the complete trace.
Workflow-controlled browser and runner evidence stays in run scratch. The
[cleanup contract](../skills/playwright-testgen/references/cleanup-contract.md)
closes only owned sessions and processes on every exit. Coordinator removes only the
exact run directory after acceptance; interrupted or failed runs receive the
same scoped teardown. Cleanup failures identify the remaining owned resources.
Generated specs and project-owned runner output outside scratch remain in the
target repository.

For an accepted product-defect result, Coordinator may invoke the
[finding recorder](../scripts/record-testgen-finding.cjs) after explicit human
approval. It appends only the run ID, classification, criterion ID, spec path,
and bounded observed behavior to the durable sibling
`.playwright-cli/testgen/findings.md`. Declining adds nothing; cleanup preserves
existing findings. The ignored `.playwright-testgen/profile.v1.json` and
approved durable authentication state also survive normal cleanup. Failed
setup removes only newly created incomplete output and preserves prior files.

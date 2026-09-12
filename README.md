# playwright-testgen

> Status: in progress.

Playwright Testgen is a Claude Code plugin that uses the
[official Playwright CLI](https://github.com/microsoft/playwright-cli) to
discover useful scenarios or turn one written scenario into a grounded,
reviewable Playwright end-to-end test. It explores the running application
before choosing locators, executes only after human approval, and repairs test
problems without hiding product failures.

## Why Testgen

Generated tests can look convincing while using guessed selectors, checking
the wrong outcome, or passing without exercising the behavior they claim to
cover. Testgen separates authorship from execution and keeps browser evidence,
written intent, and meaningful assertions connected throughout the run.

## How it works

1. Main checks the project's existing Playwright runtime and running app.
2. When no scenario was supplied, Explorer performs bounded, read-only source,
   test, history, and live-page discovery and offers up to five evidence-backed
   proposals for human selection.
3. Author grounds one selected or supplied scenario in source and the live UI, writes one candidate
   spec, runs the project's lint or collection validation, and stops without
   executing it.
4. At a human checkpoint, the reviewer chooses whether to run, revise, or keep
   the spec unverified.
5. Healer runs only the approved spec, makes bounded evidence-backed test
   repairs, preserves the approved criteria and assertions, and refuses to
   rewrite them around product defects.
6. When an approved adapter exists, the vacuity gate applies its approved
   criterion-linked mutation in a disposable Git worktree and checks that the
   test catches it. Missing coverage is reported as unverified, never silently
   counted as success.

Testgen follows the project's package manager, Playwright configuration,
fixtures, test layout, and locator conventions. It does not replace or rewrite
the project's Playwright configuration or CI. Its hooks constrain the delegated
Explorer, Author, and Healer workflows; they are guardrails, not an
operating-system sandbox.

See [Architecture](docs/architecture.md) for component ownership, runtime and
artifact boundaries, and release rules.

## Use

- `/testgen` discovers scenarios, waits for one selection, then enters the
  one-scenario pipeline.
- `/testgen "<scenario>"` skips discovery and starts from that written intent.
- A natural-language request may run Explorer, Author, or Healer alone. A
  standalone Healer can repair one existing human-approved failing spec and
  stops without starting generation or mutation verification.

## Current status

The implemented workflow has been exercised through clean marketplace
installations against an owned target and a pinned real-world application.
Those revision-specific observations are retained in the sanitized
[installed-workflow record](docs/validation/installed-workflow.md). The first
[independently graded installed-Healer case](docs/validation/healer-defect-refusal-eval.md)
also passed with verified hook governance and cleanup. Deliberately vacuous and
unrelated-mutant validation remains pending.

## Prerequisites

- Node.js 22.13 or later and npm available to Claude Code.
- A project with local `playwright` and `@playwright/test` packages.
- The current official `@playwright/cli` installed globally, plus its skill
  installed from that project:

  ```sh
  npm install -g @playwright/cli@latest
  playwright-cli install --skills
  ```

This tooling repository does not install the application's Playwright dependencies.

## Local validation

```sh
npm ci
npm run check
claude plugin validate .
```

The independently graded installed-Healer case is separate because it invokes
Claude Code and consumes model budget. From a clean committed checkout, run
`npm run eval:healer-defect-refusal`; its target, scoring contract, isolation,
and cache behavior are documented in [evals/README.md](evals/README.md).

## Local marketplace installation

```sh
claude plugin marketplace add ./
claude plugin install playwright-testgen@playwright-testgen
```

## License

Apache-2.0. See [LICENSE](LICENSE).

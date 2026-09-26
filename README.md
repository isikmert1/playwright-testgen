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

1. Testgen checks the project's existing Playwright runtime and running app.
2. When no scenario was supplied, Explorer performs bounded, read-only source,
   test, history, and live-page discovery and offers up to five evidence-backed
   proposals for human selection.
3. Author grounds one selected or supplied scenario in source and the live UI,
   writes one candidate spec, runs the project's lint or collection validation,
   and stops without executing it.
4. At a human checkpoint, the reviewer chooses whether to run, revise, or keep
   the spec unverified.
5. Healer runs only the approved spec, makes bounded evidence-backed test
   repairs, preserves the approved criteria and assertions, and refuses to
   rewrite them around product defects.
6. When an approved adapter exists, the optional mutation check applies its
   approved criterion-linked mutation in a disposable Git worktree and checks
   that the test catches it. Missing coverage is reported as unverified, never silently
   counted as success.

Testgen follows the project's package manager, Playwright configuration,
fixtures, test layout, and locator conventions. It does not replace or rewrite
the project's Playwright configuration or CI. Its hooks constrain the delegated
Explorer, Author, and Healer workflows; they are guardrails, not an
operating-system sandbox.

See [Architecture](docs/architecture.md) for component ownership, runtime
boundaries, and artifact lifecycle.

## Use

- `/playwright-testgen:setup` checks and prepares the target repository; see
  [Setup after installation](#setup-after-installation).
- `/playwright-testgen:testgen` discovers scenarios, waits for one or more
  selections, then processes them sequentially.
- `/playwright-testgen:testgen "<scenario>"` skips discovery and starts from
  that written intent.
- A natural-language request may run Explorer, Author, or Healer alone. A
  standalone Healer can repair one existing human-approved failing spec and
  stops without starting generation or mutation verification.

### Setup after installation

From the repository you want to test, run `/playwright-testgen:setup` after
installing the plugin. It selects one Playwright package and config (or
configless mode), checks the local packages, global CLI, project-local CLI skill
and browser, and explains missing prerequisites. When authentication matters,
it checks for an existing fixture or state and can offer human-operated capture.
Setup asks before installing anything, writing an ignore rule or profile, or
capturing login state; it does not generate or run tests.

Setup may create the optional, Git-ignored
`.playwright-testgen/profile.v1.json` to reuse bounded repository facts. A
missing or stale profile falls back to normal grounding. Run setup again when
your Playwright or authentication setup changes. Generation still rechecks live
application, browser, and authentication readiness for each run.

## Prerequisites

- Node.js 22.13 or later and npm available to Claude Code.
- A project with local `playwright` and `@playwright/test` packages.
- The official `@playwright/cli` installed globally, plus its skill
  installed from that project:

  ```sh
  npm install -g @playwright/cli@latest
  playwright-cli install --skills
  ```

  Setup checks the installed version and required capabilities before use.

## Local validation

```sh
npm ci
npm run check
claude plugin validate .
```

Installed-agent evaluations consume Claude Code usage. See the
[evaluation guide](evals/README.md) for commands, targets, grading, and cleanup.
Historical results are in the [workflow validation](docs/validation/installed-workflow.md)
and [Healer defect-refusal](docs/validation/healer-defect-refusal-eval.md) records.

## Local marketplace installation

```sh
claude plugin marketplace add ./
claude plugin install playwright-testgen@playwright-testgen
```

## License

Apache-2.0. See [LICENSE](LICENSE).

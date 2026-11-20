# Contributing

Help improve Testgen with reproducible scenarios, small sample applications,
bug reports, and focused pull requests.

## Share a scenario or report a problem

Open a [GitHub issue](https://github.com/isikmert1/playwright-testgen/issues).
Difficult generation and repair examples are especially useful: a scenario that
could not be grounded, an assertion that missed the intended behavior, or a
failure that was diagnosed incorrectly.

Include enough context for someone else to reproduce it:

- A public repository or permission-cleared sample app, with its revision.
- The scenario, expected behavior, and what actually happened.
- Setup and app-start commands, the selected Playwright package/configuration,
  and any required synthetic data or test fixtures.
- OS and shell, Node.js, Claude Code, Playwright, and `@playwright/cli` versions,
  plus the Testgen version or commit.
- The steps to reproduce and small, sanitized candidate-spec or failure
  snippets. Relevant screenshots can help explain an observed problem.

Share only code you have permission to publish and use synthetic test data.
Remove credentials, tokens, authentication-state files, private URLs, and account
details. Keep raw private traces and logs out of issues and pull requests; include
only the sanitized excerpts needed to explain the problem. For proprietary
applications, reproduce the behavior in a shareable sample.

## Develop locally

Use the Node.js version in [.nvmrc](.nvmrc) and a Claude Code version meeting
the [prerequisites](README.md#prerequisites). From a checkout of this repository:

```sh
npm ci
npm run check
claude plugin validate . --strict
claude plugin validate .claude-plugin/plugin.json --strict
```

`npm run check` checks formatting, lint, and deterministic tests without model
calls. Installed-plugin evaluations are separate and consume Claude Code usage;
see [Evaluations](evals/README.md) for their setup and commands.

## Submit a change

Keep each pull request focused on one problem. Describe the behavior changed,
how to reproduce it, and the checks you ran. Add meaningful regression coverage
when a behavior change needs it, and reuse existing coverage where it fits.
Use Conventional Commits for commit messages.

See [Architecture](docs/architecture.md) for component ownership, runtime
boundaries, and artifact cleanup.

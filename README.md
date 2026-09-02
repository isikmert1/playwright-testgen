# playwright-testgen

> Status: in progress.

Playwright Testgen is a Claude Code plugin that uses the
[official Playwright CLI](https://github.com/microsoft/playwright-cli) to
ground, generate, and repair focused Playwright end-to-end tests. The
one-scenario Author → human checkpoint → Healer pipeline is implemented;
real target-application validation and the mutation-based vacuity gate are
still pending.

## Prerequisites

- Node.js 24 or later and npm available to Claude Code.
- A target repository with local `playwright`, `@playwright/test`, and
  `@playwright/cli` packages.
- The official `playwright-cli` skill available in the target repository.

This tooling repository does not install the target application's Playwright
dependencies.

## Local validation

```sh
npm ci
npm run check
claude plugin validate .
```

## Local marketplace installation

```sh
claude plugin marketplace add ./
claude plugin install playwright-testgen@playwright-testgen
```

## License

Apache-2.0. See [LICENSE](LICENSE).

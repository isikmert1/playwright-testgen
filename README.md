# playwright-testgen

> Status: in progress.

Playwright Testgen is a Claude Code plugin that uses the
[official Playwright CLI](https://github.com/microsoft/playwright-cli) to
ground, generate, and repair focused Playwright end-to-end tests. The
one-scenario Author → human checkpoint → Healer pipeline is implemented;
the mutation-based vacuity gate is wired, while real target-application
validation is still pending.

## Prerequisites

- Node.js 24 or later and npm available to Claude Code.
- A target repository with local `playwright` and `@playwright/test` packages.
- The current official `@playwright/cli` installed globally, plus its skill
  installed in the target repository:

  ```sh
  npm install -g @playwright/cli@latest
  playwright-cli install --skills
  ```

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

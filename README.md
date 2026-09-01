# playwright-testgen

> Status: in progress.

Playwright Testgen will generate Playwright end-to-end tests grounded in a
running app and reject vacuous tests. It is a Claude Code plugin and local
marketplace; the test-generation pipeline is not implemented yet.

## Local validation

The repository expects Node 24 or later.

```sh
npm ci
npm run check
claude plugin validate .
```

`claude plugin validate . --strict` exits nonzero solely because strict mode
promotes the intentional missing-version warning; releases own versioning.

## Local marketplace installation

```sh
claude plugin marketplace add ./
claude plugin install playwright-testgen@playwright-testgen
```

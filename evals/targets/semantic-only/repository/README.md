# Semantic-only target

A deterministic browser target for validating Testgen when a repository has no
existing tests, authentication, or test-id convention. The application uses
semantic HTML and contains a form, table, and dialog.

It requires Node.js 20 or newer and npm.

```sh
npm ci
npx playwright install chromium
npm start
```

The target is reset by starting from a fresh committed checkout. It has no
database, persistent browser storage, or external runtime dependency.

Controlled checks live under `.testgen/` and are not applied to this template:

- `variants/rename-order-submit.patch` changes only the submit button's
  accessible name, creating repairable selector drift.
- `mutations/skip-order-insert.patch` stops submitted orders from reaching the
  table, creating a real product-behavior failure.

const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests/playwright',
  testMatch: '**/*.spec.ts',
  timeout: 60_000,
  workers: 1,
  retries: 0,
  use: {
    baseURL: process.env.TESTGEN_BASE_URL ?? 'http://localhost:3000',
  },
});

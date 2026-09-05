const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests',
  retries: 0,
  timeout: 30_000,
  workers: 1,
  use: {
    baseURL: process.env.TESTGEN_BASE_URL ?? 'http://127.0.0.1:4173',
  },
});

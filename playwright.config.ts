import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  outputDir: "./test-results",
  testMatch: /.*\.spec\.ts$/,
  timeout: 120_000,
  fullyParallel: false,
  workers: 1,
  use: {
    trace: "retain-on-failure",
    screenshot: "on-first-failure"
  },
  expect: {
    timeout: 5_000
  }
});

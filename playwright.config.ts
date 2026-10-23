import { defineConfig, devices } from "@playwright/test";

/**
 * Specs that cannot run next to the others, because they read or change what every other spec creates and deletes in the shared dev
 * database (the whole-suite run of 2026-10-17 failed both):
 *   - navigation.spec.ts crawls EVERY explorer node and link of the database: a node another spec created and then deleted
 *     (`scrollIntoViewIfNeeded` timed out waiting for it), or a domain that is half deleted, breaks it;
 *   - events-external-refs.spec.ts publishes through the real TypeSpec CLI, which is slow under the load of parallel specs
 *     (`confirm-publish` was not there after the 30 s of an action), and its serial tests then did not run.
 * They run in their own project, after every other spec has finished and cleaned up, one file after the other (`workers: 1`: they
 * must not overlap each other either, the crawl would see the other's fixture domain), their tests one after the other too.
 *
 * Running one of them by path (`npx playwright test tests/e2e/navigation.spec.ts`) runs the whole `chromium` project first, as
 * Playwright does for any dependency; add `--no-deps` to run just that file. Any other spec by path runs alone as before.
 */
const RUN_ALONE_AFTER_THE_REST = ["navigation.spec.ts", "events-external-refs.spec.ts"];

/** E2E_BASE_URL points the specs at an already-running server (no build, no webServer): `E2E_BASE_URL=http://localhost:3107`. */
const EXTERNAL_BASE_URL = process.env.E2E_BASE_URL;

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: "html",
  use: {
    baseURL: EXTERNAL_BASE_URL ?? "http://localhost:3000",
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
      testIgnore: RUN_ALONE_AFTER_THE_REST,
    },
    {
      name: "serial-after",
      use: { ...devices["Desktop Chrome"] },
      testMatch: RUN_ALONE_AFTER_THE_REST,
      fullyParallel: false,
      workers: 1,
      dependencies: ["chromium"],
    },
  ],
  webServer: EXTERNAL_BASE_URL
    ? undefined
    : {
        command: "npm run build && npm start",
        url: "http://localhost:3000",
        reuseExistingServer: !process.env.CI,
      },
});

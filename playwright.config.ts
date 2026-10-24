import { defineConfig, devices } from "@playwright/test";
import { AUTH_STATE_PATH } from "./tests/e2e/helpers/auth-state";

/**
 * The browser suite (tests/e2e). Everything that every spec used to repeat lives here, once: timeouts, trace / screenshot / video,
 * reporters, the login.
 *
 * TIERS are tags on the tests (`test(name, { tag: ["@smoke"] }, fn)`; tests/unit/e2e-suite-guard.test.ts fails a test without one),
 * selected by the npm scripts, which call scripts/e2e-phases.mjs (it plans the `playwright test` commands of a tier, one per phase):
 *   - `npm run test:e2e:smoke`       `--grep @smoke`: login, the basic create flows, one generate; on Chromium, Firefox and WebKit;
 *   - `npm run test:e2e:regression`  `--grep-invert "@slow|@external"`: every functional spec, Chromium; two phases (see below);
 *   - `npm run test:e2e:nightly`     everything: adds @slow (the JSON Schema matrix, external refs, the navigation crawl) and @external
 *                                    (a test that needs the network or a second server).
 *
 * PROJECTS:
 *   - `setup`          one UI login per run, saved to AUTH_STATE_PATH (playwright/.auth/admin.json, ignored by version control;
 *                      `E2E_AUTH_STATE` names another file, which concurrent runs need). Every browser project depends on it, so a
 *                      run never starts from a stale login. Running a project with `--no-deps` skips it: run `--project=setup` first
 *                      then, or the missing file fails the first test with ENOENT (scripts/e2e-phases.mjs refuses a file that is
 *                      missing or older than 6 hours).
 *   - `chromium`       the functional specs (minus the ones below);
 *   - `firefox-smoke`, `webkit-smoke`   only the @smoke tests, on the other two engines (`npx playwright install firefox webkit`);
 *   - `serial-after`   the specs that cannot run next to the others (below);
 *   - `visual`, `a11y` Chromium-only screenshot comparisons / axe scans of a few pages (visual.spec.ts, a11y.spec.ts). Both are kept
 *                      out of `chromium` so they run once, where they are meant to (visual snapshots only in the Playwright Docker image).
 *
 * FILTERS AND DEPENDENCIES: Playwright runs a project's dependencies (`setup`, and `chromium` for `serial-after`) IN FULL, whatever
 * `--grep` / `--grep-invert` say, as soon as a project that depends on them has a matching test (verified with `--list`: `--grep @slow
 * --project=serial-after` lists every chromium test). So a tier run never selects `serial-after` together with `chromium`:
 * scripts/e2e-phases.mjs runs `chromium` (and the others) first, then `serial-after --no-deps` as its own `playwright test`, and gives
 * each phase its own report locations (a second `playwright test` clears `test-results/` and replaces the html report of the first).
 * The reporters below read their locations from the environment first (`PLAYWRIGHT_HTML_OUTPUT_DIR`, `PLAYWRIGHT_JUNIT_OUTPUT_FILE`,
 * `E2E_FLAKY_FILE`), the output directory comes from `--output`.
 *
 * A test that passes only on a retry does not fail the run, and is never hidden: `list` prints "N flaky" with the names, the html
 * report has a Flaky filter, junit records it as a <flakyFailure> (`includeRetries`; without it junit shows a plain pass), and
 * tests/e2e/reporters/flaky-reporter.ts (on CI) prints a FLAKY block, writes a JSON list and raises a GitHub warning annotation.
 * `retries` is 1 on CI and 0 locally.
 */

/**
 * Specs that cannot run next to the others, because they read or change what every other spec creates and deletes in the shared
 * database (the whole-suite run of 2026-10-17 failed both):
 *   - navigation.spec.ts crawls EVERY explorer node and link of the database: a node another spec created and then deleted
 *     (`scrollIntoViewIfNeeded` timed out waiting for it), or a domain that is half deleted, breaks it;
 *   - events-external-refs.spec.ts publishes through the real TypeSpec CLI, which is slow under the load of parallel specs
 *     (`confirm-publish` was not there after the 30 s of an action), and its serial tests then did not run.
 * They run in their own project, after every other spec has finished and cleaned up, one file after the other (`workers: 1`: they
 * must not overlap each other either, the crawl would see the other's fixture domain), their tests one after the other too.
 *
 * Running one of them by path (`npx playwright test tests/e2e/navigation.spec.ts`) runs the whole `chromium` project first, as
 * Playwright does for any dependency; add `--no-deps` to run just that file (after a `--project=setup` run). Any other spec by path
 * runs alone as before.
 */
const RUN_ALONE_AFTER_THE_REST = ["navigation.spec.ts", "events-external-refs.spec.ts"];

/** Specs of their own projects: `chromium` and the smoke projects leave them out. */
const OWN_PROJECT = ["visual.spec.ts", "a11y.spec.ts"];

/** E2E_BASE_URL points the specs at an already-running server (no build, no webServer): `E2E_BASE_URL=http://localhost:3107`. */
const EXTERNAL_BASE_URL = process.env.E2E_BASE_URL;

const CI = !!process.env.CI;

/**
 * E2E_DATABASE_URL (what the release runner provisions) is the database of the server this config starts, not just of the fixtures:
 * the app is told so explicitly, so a DATABASE_URL / DB_PROVIDER of the developer's shell or `.env` can never be the one it uses, and
 * a server that is already running on :3000 (it might use that other database) is never reused.
 */
const E2E_DATABASE_URL = process.env.E2E_DATABASE_URL;

/** Every project but `setup` starts logged in as the admin. A spec that needs the login form opts out with `test.use({ storageState: { cookies: [], origins: [] } })`. */
const loggedIn = { storageState: AUTH_STATE_PATH };

export default defineConfig({
  testDir: "./tests/e2e",
  // 60 s, not Playwright's 30: a test without its own `test.setTimeout` (the smoke ones) must not be on the default under the load of
  // Firefox / WebKit or a first compile. The long tests set their own.
  timeout: 60_000,
  // 15 s for a web-first assertion (Playwright's default is 5 s): most of them wait for the server (a page render, a server action and
  // the refresh of its page). Measured with the release runner: creating a domain takes 0.1 s with one worker (CI) and about 4 s when
  // eight workers use the one server, which is what made specs fail now and then on a laptop with the 5 s default. An assertion that
  // holds still returns at once; only a failing one waits longer. A page's hydration, a load, waits 30 s on its own
  // (tests/e2e/helpers/hydration.ts).
  expect: { timeout: 15_000 },
  fullyParallel: true,
  forbidOnly: CI,
  retries: CI ? 1 : 0,
  workers: CI ? 1 : undefined,
  reporter: CI
    ? [
        ["list"],
        ["html", { open: "never" }],
        ["junit", { outputFile: "test-results/junit.xml", includeRetries: true }],
        ["./tests/e2e/reporters/flaky-reporter.ts"],
      ]
    : [["list"]],
  use: {
    baseURL: EXTERNAL_BASE_URL ?? "http://localhost:3000",
    // First visits compile routes in dev, and the preview renders the payload with the real TypeSpec CLI.
    navigationTimeout: 60_000,
    actionTimeout: 30_000,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    {
      name: "setup",
      testMatch: /auth\.setup\.ts/,
    },
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], ...loggedIn },
      testIgnore: [...RUN_ALONE_AFTER_THE_REST, ...OWN_PROJECT],
      dependencies: ["setup"],
    },
    {
      name: "firefox-smoke",
      use: { ...devices["Desktop Firefox"], ...loggedIn },
      testIgnore: [...RUN_ALONE_AFTER_THE_REST, ...OWN_PROJECT],
      grep: /@smoke/,
      dependencies: ["setup"],
    },
    {
      name: "webkit-smoke",
      use: { ...devices["Desktop Safari"], ...loggedIn },
      testIgnore: [...RUN_ALONE_AFTER_THE_REST, ...OWN_PROJECT],
      grep: /@smoke/,
      dependencies: ["setup"],
    },
    {
      name: "serial-after",
      use: { ...devices["Desktop Chrome"], ...loggedIn },
      testMatch: RUN_ALONE_AFTER_THE_REST,
      fullyParallel: false,
      workers: 1,
      dependencies: ["setup", "chromium"],
    },
    {
      name: "visual",
      use: { ...devices["Desktop Chrome"], ...loggedIn },
      testMatch: "visual.spec.ts",
      dependencies: ["setup"],
    },
    {
      name: "a11y",
      use: { ...devices["Desktop Chrome"], ...loggedIn },
      testMatch: "a11y.spec.ts",
      dependencies: ["setup"],
    },
  ],
  webServer: EXTERNAL_BASE_URL
    ? undefined
    : {
        command: "npm run build && npm start",
        url: "http://localhost:3000",
        reuseExistingServer: !CI && !E2E_DATABASE_URL,
        ...(E2E_DATABASE_URL
          ? { env: { ...process.env, DATABASE_URL: E2E_DATABASE_URL, DB_PROVIDER: "postgresql" } as Record<string, string> }
          : {}),
      },
});

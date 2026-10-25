/**
 * playwright.config.ts and the stall watchdog: the heartbeat reporter is added only when the phases script asked for one
 * (E2E_HEARTBEAT_FILE), the built-in reporters stay as they were, and `E2E_GLOBAL_TIMEOUT_MS` is Playwright's `globalTimeout` (none unset).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const NAMES = ["E2E_HEARTBEAT_FILE", "E2E_SKIPPED_FILE", "E2E_GLOBAL_TIMEOUT_MS", "CI", "E2E_BASE_URL", "E2E_BROWSER_CHANNEL"] as const;

describe("playwright.config.ts: the heartbeat reporter and the global timeout", () => {
  const saved = Object.fromEntries(NAMES.map((name) => [name, process.env[name]]));

  beforeEach(() => {
    vi.resetModules();
    for (const name of NAMES) delete process.env[name];
    process.env.E2E_BASE_URL = "http://localhost:1"; // no webServer: the config is only read
    process.env.E2E_BROWSER_CHANNEL = "chromium";
  });

  afterEach(() => {
    for (const name of NAMES) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  });

  type Config = { reporter: Array<[string, ...unknown[]]>; globalTimeout?: number };
  const load = async (): Promise<Config> => (await import("../../../playwright.config")).default as unknown as Config;
  const names = (config: Config) => config.reporter.map((entry) => entry[0]);

  it("has the list reporter alone locally, and the heartbeat after it when the phases script set a file", async () => {
    expect(names(await load())).toEqual(["list"]);
    vi.resetModules();
    process.env.E2E_HEARTBEAT_FILE = "/tmp/run/heartbeat";
    expect(names(await load())).toEqual(["list", "./tests/e2e/reporters/heartbeat-reporter.ts"]);
  });

  it("keeps the CI reporters, and adds the heartbeat last", async () => {
    process.env.CI = "1";
    process.env.E2E_HEARTBEAT_FILE = "/tmp/run/heartbeat";
    expect(names(await load())).toEqual(["list", "html", "junit", "./tests/e2e/reporters/flaky-reporter.ts", "./tests/e2e/reporters/heartbeat-reporter.ts"]);
  });

  it("adds the skipped-test reporter, before the heartbeat, when the phases script asked for a list (E2E_SKIPPED_FILE)", async () => {
    process.env.E2E_SKIPPED_FILE = "/tmp/run/skipped-tests.json";
    expect(names(await load())).toEqual(["list", "./tests/e2e/reporters/skipped-reporter.ts"]);
    vi.resetModules();
    process.env.E2E_HEARTBEAT_FILE = "/tmp/run/heartbeat";
    expect(names(await load())).toEqual(["list", "./tests/e2e/reporters/skipped-reporter.ts", "./tests/e2e/reporters/heartbeat-reporter.ts"]);
  });

  it("has no global timeout unless E2E_GLOBAL_TIMEOUT_MS says one (Playwright's 0 is none)", async () => {
    expect((await load()).globalTimeout).toBe(0);
    vi.resetModules();
    process.env.E2E_GLOBAL_TIMEOUT_MS = "3600000";
    expect((await load()).globalTimeout).toBe(3_600_000);
  });

  it("refuses a global timeout that is not a positive whole number of milliseconds (a typo is not 'no limit')", async () => {
    process.env.E2E_GLOBAL_TIMEOUT_MS = "an hour";
    await expect(load()).rejects.toThrow(/E2E_GLOBAL_TIMEOUT_MS must be a positive whole number of milliseconds \(got "an hour"\)/);
  });
});

/**
 * scripts/e2e-phases.mjs plans the `playwright test` commands of a tier of the browser suite. What is pinned here is what went wrong
 * without it: a filtered command that pulls `chromium` in full through `serial-after`, a second `playwright test` that clears the
 * first one's results and report, a shard that appends to the last command only, and a stale or missing login.
 */
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MAX_AUTH_AGE_MS, authStateProblem, chooseAuthState, parseCli, planPhases, shardOf } from "../../scripts/e2e-phases.mjs";

const AUTH = "/tmp/run/admin.json";
const plan = (tier: string, extraArgs: string[] = [], noSerial = false) => planPhases({ tier, extraArgs, noSerial, authState: AUTH });

describe("parseCli", () => {
  it("reads the tier and passes every other argument on", () => {
    expect(parseCli(["regression", "--shard=2/4", "--headed"])).toEqual({ tier: "regression", noSerial: false, extraArgs: ["--shard=2/4", "--headed"] });
  });

  it("takes --no-serial for itself", () => {
    expect(parseCli(["regression", "--no-serial", "--headed"])).toEqual({ tier: "regression", noSerial: true, extraArgs: ["--headed"] });
  });

  it("refuses a missing or unknown tier with the usage", () => {
    expect(() => parseCli([])).toThrow(/usage: node scripts\/e2e-phases\.mjs/);
    expect(() => parseCli(["weekly"])).toThrow(/usage/);
  });
});

describe("shardOf", () => {
  it("reads both spellings", () => {
    expect(shardOf(["--shard=2/4"])).toEqual({ index: 2, total: 4 });
    expect(shardOf(["--headed", "--shard", "3/5"])).toEqual({ index: 3, total: 5 });
    expect(shardOf(["--headed"])).toBeUndefined();
  });
});

describe("planPhases", () => {
  it("smoke is one phase on the three browsers, filtered by tag", () => {
    const { phases } = plan("smoke");
    expect(phases.map((p) => p.name)).toEqual(["main"]);
    expect(phases[0].args).toEqual(expect.arrayContaining(["--grep=@smoke", "--project=chromium", "--project=firefox-smoke", "--project=webkit-smoke"]));
    expect(phases[0].args).not.toContain("--project=serial-after");
  });

  it("regression is two commands: the browser projects, then serial-after on its own without dependencies", () => {
    const { phases } = plan("regression");
    expect(phases.map((p) => p.name)).toEqual(["main", "serial"]);
    const [main, serial] = phases;
    expect(main.args).toEqual(expect.arrayContaining(["--grep-invert=@slow|@external", "--project=chromium", "--project=a11y"]));
    expect(main.args).not.toContain("--project=serial-after"); // or its dependency chromium would run unfiltered
    expect(main.runsSetup).toBe(true);
    expect(serial.args).toEqual(expect.arrayContaining(["--grep-invert=@slow|@external", "--project=serial-after", "--no-deps"]));
    expect(serial.runsSetup).toBe(false);
  });

  it("nightly is everything in one unfiltered command (the dependencies order serial-after after chromium)", () => {
    const { phases } = plan("nightly");
    expect(phases).toHaveLength(1);
    expect(phases[0].args.filter((a) => a.startsWith("--grep") || a.startsWith("--project"))).toEqual([]);
  });

  it("serial logs in first, then runs serial-after without dependencies", () => {
    const { phases } = plan("serial");
    expect(phases.map((p) => [p.name, p.runsSetup])).toEqual([["setup", true], ["serial", false]]);
    expect(phases[0].args).toContain("--project=setup");
  });

  it("gives every phase reports, results and a flaky list of its own, and the one login of the run", () => {
    const { phases } = plan("regression");
    const [main, serial] = phases;
    expect(main.env).toEqual({
      E2E_AUTH_STATE: AUTH,
      PLAYWRIGHT_HTML_OUTPUT_DIR: path.join("playwright-report", "main"),
      PLAYWRIGHT_JUNIT_OUTPUT_FILE: path.join("test-results", "main", "junit.xml"),
      E2E_FLAKY_FILE: path.join("test-results", "main", "flaky-tests.json"),
    });
    expect(serial.env.PLAYWRIGHT_HTML_OUTPUT_DIR).toBe(path.join("playwright-report", "serial"));
    expect(serial.env.PLAYWRIGHT_JUNIT_OUTPUT_FILE).toBe(path.join("test-results", "serial", "junit.xml"));
    expect(serial.env.E2E_FLAKY_FILE).toBe(path.join("test-results", "serial", "flaky-tests.json"));
    expect(serial.env.E2E_AUTH_STATE).toBe(AUTH);
    // The artifacts (traces, videos, screenshots) too: Playwright empties its output directory at the start of every command.
    expect(main.args).toContain(`--output=${path.join("test-results", "main", "artifacts")}`);
    expect(serial.args).toContain(`--output=${path.join("test-results", "serial", "artifacts")}`);
    expect(new Set(phases.map((p) => p.env.PLAYWRIGHT_HTML_OUTPUT_DIR)).size).toBe(phases.length);
  });

  it("forwards the extra arguments to the first phase only", () => {
    const { phases } = plan("regression", ["--shard=1/4", "--headed"]);
    expect(phases[0].args).toEqual(expect.arrayContaining(["--shard=1/4", "--headed"]));
    expect(phases[1].args).not.toContain("--headed");
    expect(phases[1].args.some((a) => a.startsWith("--shard"))).toBe(false);
  });

  it("runs the serial phase with shard 1/N and with no shard, and skips it with any other shard", () => {
    expect(plan("regression", ["--shard=1/4"]).phases.map((p) => p.name)).toEqual(["main", "serial"]);
    expect(plan("regression").phases.map((p) => p.name)).toEqual(["main", "serial"]);
    const later = plan("regression", ["--shard", "3/4"]);
    expect(later.phases.map((p) => p.name)).toEqual(["main"]);
    expect(later.skipped).toEqual([expect.stringMatching(/serial: skipped \(shard 3\/4/)]);
  });

  it("skips the later phase on --no-serial", () => {
    const result = plan("regression", [], true);
    expect(result.phases.map((p) => p.name)).toEqual(["main"]);
    expect(result.skipped).toEqual([expect.stringMatching(/--no-serial/)]);
  });

  it("a first phase run with --no-deps does not run the setup project", () => {
    const { phases } = plan("regression", ["--no-deps"]);
    expect(phases[0].noDeps).toBe(true);
    expect(phases[0].runsSetup).toBe(false);
  });
});

describe("authStateProblem", () => {
  const now = Date.parse("2026-10-24T12:00:00Z");

  it("accepts a login made minutes ago", () => {
    expect(authStateProblem({ exists: true, mtimeMs: now - 5 * 60_000, now, file: AUTH })).toBeNull();
  });

  it("refuses a missing login and says how to make one", () => {
    expect(authStateProblem({ exists: false, now, file: AUTH })).toMatch(/does not exist.*--project=setup/);
  });

  it("refuses a login older than 6 hours", () => {
    const message = authStateProblem({ exists: true, mtimeMs: now - MAX_AUTH_AGE_MS - 60_000, now, file: AUTH });
    expect(message).toMatch(/6 hours old|hours old \(limit 6\)/);
    expect(message).toMatch(/--project=setup/);
    expect(authStateProblem({ exists: true, mtimeMs: now - MAX_AUTH_AGE_MS + 60_000, now, file: AUTH })).toBeNull();
  });
});

describe("chooseAuthState", () => {
  it("uses the file the caller names, and leaves it to the caller", () => {
    expect(chooseAuthState({ env: { E2E_AUTH_STATE: "/run/42/admin.json" }, firstPhaseRunsSetup: true, runId: "1" })).toEqual({
      file: "/run/42/admin.json",
      ownedByThisRun: false,
    });
  });

  it("gives a run that logs in a file of its own, so two runs never share one", () => {
    const a = chooseAuthState({ env: {}, firstPhaseRunsSetup: true, runId: "100-aa" });
    const b = chooseAuthState({ env: {}, firstPhaseRunsSetup: true, runId: "101-bb" });
    expect(a.ownedByThisRun).toBe(true);
    expect(a.file).not.toBe(b.file);
    expect(a.file).toMatch(/playwright[\\/]\.auth[\\/]run-100-aa\.json$/);
  });

  it("falls back to the default file for a run that does not log in (it has to find the one an earlier run made)", () => {
    const chosen = chooseAuthState({ env: {}, firstPhaseRunsSetup: false, runId: "1" });
    expect(chosen.ownedByThisRun).toBe(false);
    expect(chosen.file).toMatch(/playwright[\\/]\.auth[\\/]admin\.json$/);
  });
});

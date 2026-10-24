/**
 * scripts/e2e-phases.mjs plans the `playwright test` commands of a tier of the browser suite. What is pinned here is what went wrong
 * without it: a filtered command that pulls `chromium` in full through `serial-after`, a second `playwright test` that clears the
 * first one's results and report, a shard that appends to the last command only, and a stale or missing login.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  MAX_AUTH_AGE_MS,
  authStateProblem,
  chooseAuthState,
  exitCodeOf,
  isEntryPoint,
  parseCli,
  phaseSummaryLine,
  planPhases,
  playwrightCommand,
  runPhases,
  shardOf,
} from "../../scripts/e2e-phases.mjs";

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

  it("puts every report and result under an output root of the run, so two runs from one checkout do not meet", () => {
    const { phases } = planPhases({ tier: "regression", authState: AUTH, outputRoot: "/runs/42" });
    for (const phase of phases) {
      expect(phase.env.PLAYWRIGHT_HTML_OUTPUT_DIR).toBe(path.join("/runs/42", "playwright-report", phase.name));
      expect(phase.env.PLAYWRIGHT_JUNIT_OUTPUT_FILE).toBe(path.join("/runs/42", "test-results", phase.name, "junit.xml"));
      expect(phase.env.E2E_FLAKY_FILE).toBe(path.join("/runs/42", "test-results", phase.name, "flaky-tests.json"));
      expect(phase.args).toContain(`--output=${path.join("/runs/42", "test-results", phase.name, "artifacts")}`);
    }
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

  it("tier serial sends the extra arguments to the serial phase, not to the login", () => {
    const { phases } = plan("serial", ["tests/e2e/navigation.spec.ts", "--headed", "--grep=crawl"]);
    expect(phases.map((p) => p.name)).toEqual(["setup", "serial"]);
    expect(phases[0].args).not.toContain("--headed");
    expect(phases[0].args).not.toContain("tests/e2e/navigation.spec.ts");
    expect(phases[1].args).toEqual(expect.arrayContaining(["tests/e2e/navigation.spec.ts", "--headed", "--grep=crawl", "--project=serial-after", "--no-deps"]));
  });

  it("tier serial does not skip its serial phase for a shard that is not 1/N (the shard is the caller's, for that one phase)", () => {
    const { phases, skipped } = plan("serial", ["--shard=2/4"]);
    expect(phases.map((p) => p.name)).toEqual(["setup", "serial"]);
    expect(phases[1].args).toContain("--shard=2/4");
    expect(skipped).toEqual([]);
  });

  describe("--project restricts the tier's projects (it does not add to them, as it would for a bare `playwright test`)", () => {
    const projectsOf = (args: string[]) => args.filter((a) => a.startsWith("--project="));

    it("keeps only the named projects of a tier that lists its own", () => {
      const { phases } = plan("smoke", ["--project=firefox-smoke"]);
      expect(projectsOf(phases[0].args)).toEqual(["--project=firefox-smoke"]);
      expect(phases[0].args).toContain("--grep=@smoke"); // the tag filter still applies
    });

    it("reads the two-argument spelling, and keeps a project once", () => {
      const { phases } = plan("smoke", ["--project", "chromium", "--project=chromium"]);
      expect(projectsOf(phases[0].args)).toEqual(["--project=chromium"]);
      expect(phases[0].args).not.toContain("chromium");
    });

    it("skips a phase none of whose projects were named, and says why", () => {
      const { phases, skipped } = plan("regression", ["--project=chromium"]);
      expect(phases.map((p) => p.name)).toEqual(["main"]);
      expect(projectsOf(phases[0].args)).toEqual(["--project=chromium"]);
      expect(skipped).toEqual([expect.stringMatching(/serial: skipped \(--project chromium/)]);
    });

    it("is the whole project list for a tier that has none (nightly runs everything)", () => {
      expect(projectsOf(plan("nightly", ["--project=a11y"]).phases[0].args)).toEqual(["--project=a11y"]);
    });

    it("leaves no phase when no project fits", () => {
      const result = plan("regression", ["--project=webkit-smoke"]);
      expect(result.phases).toEqual([]);
      expect(result.skipped).toHaveLength(2);
    });
  });

  describe("--list", () => {
    it("lists in every phase, and needs no login in any of them", () => {
      const { phases } = plan("regression", ["--list"]);
      expect(phases.map((p) => p.name)).toEqual(["main", "serial"]);
      for (const phase of phases) {
        expect(phase.args).toContain("--list");
        expect(phase.args.filter((a) => a === "--list")).toHaveLength(1);
        expect(phase.listOnly).toBe(true);
        expect(phase.runsSetup).toBe(false);
      }
    });

    it("is off for a normal run", () => {
      expect(plan("smoke").phases[0].listOnly).toBe(false);
    });
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

describe("isEntryPoint", () => {
  const self = path.resolve(__dirname, "../../scripts/e2e-phases.mjs");

  it("is true when the script is run by its real path", () => {
    expect(isEntryPoint(pathToFileURL(self).href, self)).toBe(true);
  });

  it("is false when another file is the entry point (the script was imported)", () => {
    expect(isEntryPoint(pathToFileURL(self).href, "/somewhere/vitest.mjs")).toBe(false);
    expect(isEntryPoint(pathToFileURL(self).href, undefined)).toBe(false);
  });

  it("is true through a symlinked directory (macOS /tmp and /var are links), where a plain string compare said no and exit 0 hid it", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "e2e-phases-link-"));
    try {
      symlinkSync(path.dirname(self), path.join(dir, "scripts"));
      const viaLink = path.join(dir, "scripts", "e2e-phases.mjs");
      expect(isEntryPoint(pathToFileURL(self).href, viaLink)).toBe(true);

      // End to end: no tier is a usage error (exit 2), not a silent exit 0.
      const run = spawnSync(process.execPath, [viaLink], { encoding: "utf8" });
      expect(run.stderr).toMatch(/usage: node scripts\/e2e-phases\.mjs/);
      expect(run.status).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails loudly when the file run has this script's name but is not this file", () => {
    expect(() => isEntryPoint(pathToFileURL(self).href, "/elsewhere/e2e-phases.mjs", (p: string) => p)).toThrow(/refusing to exit 0 without running/);
  });
});

describe("playwrightCommand", () => {
  it("runs the local playwright CLI with node itself, not through npx (a signal then reaches playwright, not a shell in between)", () => {
    const { command, args } = playwrightCommand();
    expect(command).toBe(process.execPath);
    expect(args).toHaveLength(1);
    expect(args[0]).toMatch(/@playwright[\\/]test[\\/]cli\.js$/);
  });
});

describe("phaseSummaryLine", () => {
  const [phase] = planPhases({ tier: "smoke", authState: AUTH, outputRoot: "/runs/7" }).phases;
  const report = path.join("/runs/7", "playwright-report", "main", "index.html");
  const results = path.join("/runs/7", "test-results", "main");

  it("prints the report and results paths that exist", () => {
    const line = phaseSummaryLine({ phase, result: { name: "main", code: 0 }, exists: () => true });
    expect(line).toBe(`  main: passed   report: ${report}   results: ${results}/`);
  });

  it("prints only the paths that exist: a run with the list reporter alone made neither", () => {
    expect(phaseSummaryLine({ phase, result: { name: "main", code: 1 }, exists: () => false })).toBe("  main: failed (exit 1)");
    const onlyResults = phaseSummaryLine({ phase, result: { name: "main", code: 0 }, exists: (p: string) => p === results });
    expect(onlyResults).toBe(`  main: passed   results: ${results}/`);
  });

  it("says what happened to a phase that did not run or was refused", () => {
    expect(phaseSummaryLine({ phase, result: undefined, exists: () => true })).toBe("  main: not run");
    expect(phaseSummaryLine({ phase, result: { name: "main", code: 1, refused: true }, exists: () => true })).toBe("  main: refused");
  });
});

describe("exitCodeOf", () => {
  it("is the first non-zero code of the phases, else 0", () => {
    expect(exitCodeOf([{ name: "a", code: 0 }, { name: "b", code: 3 }, { name: "c", code: 1 }])).toBe(3);
    expect(exitCodeOf([{ name: "a", code: 0 }])).toBe(0);
  });

  it("is 128 + the signal number once the run was interrupted, whatever the phase said", () => {
    expect(exitCodeOf([{ name: "a", code: 1 }], "SIGINT")).toBe(130);
    expect(exitCodeOf([], "SIGTERM")).toBe(143);
    expect(exitCodeOf([], "SIGHUP")).toBe(129);
  });
});

describe("runPhases: the order of the login file's removal and the phases, with fake dependencies", () => {
  const login = { file: "/runs/7/admin.json", ownedByThisRun: true };

  function harness(options: { codes?: Record<string, number>; throwIn?: string; interruptAfter?: string; files?: Record<string, number> } = {}) {
    const events: string[] = [];
    const files = new Map(Object.entries(options.files ?? {}));
    let interrupted = false;
    const deps = {
      interrupted: () => interrupted,
      runPhase: async (phase: { name: string; runsSetup: boolean }) => {
        events.push(`run ${phase.name}`);
        if (phase.runsSetup) files.set(login.file, Date.parse("2026-10-24T11:59:00Z")); // the setup project saves the login
        if (options.throwIn === phase.name) throw new Error("boom");
        if (options.interruptAfter === phase.name) interrupted = true;
        return options.codes?.[phase.name] ?? 0;
      },
      rmSync: (file: string) => {
        files.delete(file);
        events.push(`rm ${file}`);
      },
      mkdirSync: (dir: string) => events.push(`mkdir ${dir}`),
      existsSync: (file: string) => files.has(file),
      statSync: (file: string) => ({ mtimeMs: files.get(file) ?? 0 }),
      now: () => Date.parse("2026-10-24T12:00:00Z"),
      log: () => {},
      error: (m: string) => events.push(`error ${m.slice(0, 30)}`),
    };
    return { events, deps };
  }
  const phases = (tier: string) => planPhases({ tier, authState: login.file }).phases;

  it("removes an old login before the phase that logs in, runs the phases in order, and removes the run's own login at the end", async () => {
    const { events, deps } = harness();
    const results = await runPhases({ phases: phases("regression"), auth: login, deps });
    expect(results.map((r: { name: string; code: number }) => [r.name, r.code])).toEqual([["main", 0], ["serial", 0]]);
    expect(events).toEqual(["rm /runs/7/admin.json", "mkdir /runs/7", "run main", "run serial", "rm /runs/7/admin.json"]);
  });

  it("still removes the login when a phase throws", async () => {
    const { events, deps } = harness({ throwIn: "main" });
    await expect(runPhases({ phases: phases("regression"), auth: login, deps })).rejects.toThrow("boom");
    expect(events.at(-1)).toBe("rm /runs/7/admin.json");
    expect(events).not.toContain("run serial");
  });

  it("stops before the next phase once interrupted, and still removes the login", async () => {
    const { events, deps } = harness({ interruptAfter: "main" });
    const results = await runPhases({ phases: phases("regression"), auth: login, deps });
    expect(results.map((r: { name: string }) => r.name)).toEqual(["main"]);
    expect(events).toEqual(["rm /runs/7/admin.json", "mkdir /runs/7", "run main", "rm /runs/7/admin.json"]);
  });

  it("keeps running the later phase after a failed one (its report is still wanted), and keeps a login it does not own", async () => {
    const mine = { file: "/runs/7/admin.json", ownedByThisRun: false };
    const { events, deps } = harness({ codes: { main: 1 }, files: { "/runs/7/admin.json": Date.parse("2026-10-24T11:59:00Z") } });
    const results = await runPhases({ phases: planPhases({ tier: "regression", authState: mine.file, extraArgs: [] }).phases, auth: mine, deps });
    expect(results.map((r: { code: number }) => r.code)).toEqual([1, 0]);
    expect(events.filter((e) => e.startsWith("rm"))).toEqual(["rm /runs/7/admin.json"]); // the one before the phase that logs in; none at the end
  });

  it("runs a --list phase without touching or checking the login", async () => {
    const { events, deps } = harness();
    const listing = planPhases({ tier: "regression", extraArgs: ["--list"], authState: login.file }).phases;
    const results = await runPhases({ phases: listing, auth: { file: login.file, ownedByThisRun: false }, deps });
    expect(results.map((r: { name: string; code: number }) => [r.name, r.code])).toEqual([["main", 0], ["serial", 0]]);
    expect(events).toEqual(["run main", "run serial"]);
  });

  it("refuses a --no-deps phase when there is no login, without running it", async () => {
    const { events, deps } = harness();
    const only = planPhases({ tier: "regression", extraArgs: ["--no-deps"], noSerial: true, authState: login.file }).phases;
    const results = await runPhases({ phases: only, auth: { file: login.file, ownedByThisRun: false }, deps });
    expect(results).toEqual([{ name: "main", code: 1, refused: true }]);
    expect(events.some((e) => e.startsWith("run "))).toBe(false);
  });
});

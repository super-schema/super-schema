/**
 * scripts/e2e-entry.mjs: "is this module the script node was started with?", by REAL path. A plain string compare of `import.meta.url` with
 * `process.argv[1]` is false through a symlink (macOS: /tmp, /var and /private are links; a worktree's node_modules is one), and a script
 * whose `main()` sits behind that compare then exits 0 without doing anything. Every script of the suite uses the one helper; this file runs
 * each of them through a symlinked path and asks that it DID its work (a usage error, its help, its output), not just that it exited.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { isEntryPoint } from "../../../scripts/e2e-entry.mjs";

const REPO = path.resolve(__dirname, "../../..");
const SCRIPTS = path.join(REPO, "scripts");

describe("isEntryPoint", () => {
  const self = path.join(SCRIPTS, "e2e-entry.mjs");

  it("is true for the real path, false for another entry point or none (the module was imported)", () => {
    expect(isEntryPoint(pathToFileURL(self).href, self)).toBe(true);
    expect(isEntryPoint(pathToFileURL(self).href, "/somewhere/vitest.mjs")).toBe(false);
    expect(isEntryPoint(pathToFileURL(self).href, undefined)).toBe(false);
  });

  it("fails loudly when the file run has this script's name but is not this file", () => {
    expect(() => isEntryPoint(pathToFileURL(self).href, "/elsewhere/e2e-entry.mjs", (p: string) => p)).toThrow(/refusing to exit 0 without running/);
  });
});

/**
 * Each script with an invocation that is quick, harmless and visibly DOES something: what it must print, and its exit code. A script that
 * did nothing prints nothing and exits 0, which is what this file exists to catch.
 */
const SCRIPT_RUNS: Array<{ script: string; args: string[]; stdout?: RegExp; stderr?: RegExp; status: number }> = [
  { script: "e2e-phases.mjs", args: [], stderr: /usage: node scripts\/e2e-phases\.mjs/, status: 2 },
  { script: "e2e-release.mjs", args: ["--help"], stdout: /usage: node scripts\/e2e-release\.mjs/, status: 0 },
  { script: "e2e-update-snapshots.mjs", args: ["--help"], stdout: /usage: node scripts\/e2e-update-snapshots\.mjs/, status: 0 },
  { script: "e2e-in-docker.mjs", args: [], stderr: /usage: e2e-in-docker\.mjs/, status: 2 },
  { script: "ci-flaky-summary.mjs", args: [], stdout: /flaky tests/, status: 0 },
  { script: "build-parser-worker.mjs", args: [], stdout: /built worker-dist\/asyncapi-parser-worker\.cjs/, status: 0 },
];

describe("every script of the suite runs its main through a symlinked path (and not silently exits 0)", () => {
  /** Runs the script by a path that goes through a symlink to the scripts directory, and by one that is a symlink to the file itself. */
  function runThroughLinks(script: string, args: string[]) {
    const dir = mkdtempSync(path.join(tmpdir(), "ss-entry-link-"));
    try {
      symlinkSync(SCRIPTS, path.join(dir, "scripts"));
      symlinkSync(path.join(SCRIPTS, script), path.join(dir, `renamed-${script}`));
      const env = { ...process.env, E2E_OUTPUT_ROOT: "", SUMMARY_TITLE: "e2e" };
      const run = (file: string) => spawnSync(process.execPath, [file, ...args], { encoding: "utf8", cwd: REPO, env, timeout: 60_000 });
      return { directoryLink: run(path.join(dir, "scripts", script)), fileLink: run(path.join(dir, `renamed-${script}`)) };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it.each(SCRIPT_RUNS.map((r) => [r.script, r]))("%s", (_name, expected) => {
    const { script, args, stdout, stderr, status } = expected as (typeof SCRIPT_RUNS)[number];
    const { directoryLink, fileLink } = runThroughLinks(script, args);
    for (const [how, run] of [["through a linked directory", directoryLink], ["as a linked file", fileLink]] as const) {
      expect(run.status, `${script} ${how}: ${run.stderr}${run.stdout}`).toBe(status);
      if (stdout) expect(run.stdout, `${script} ${how} printed nothing it should have`).toMatch(stdout);
      if (stderr) expect(run.stderr, `${script} ${how} printed nothing it should have`).toMatch(stderr);
    }
  }, 120_000);

  it("no script of scripts/ compares import.meta.url with argv[1] by hand: they all use isEntryPoint", async () => {
    const { readdirSync, readFileSync } = await import("node:fs");
    const offenders = readdirSync(SCRIPTS)
      .filter((name) => /\.(mjs|cjs|ts)$/.test(name))
      .filter((name) => /process\.argv\[1\]/.test(readFileSync(path.join(SCRIPTS, name), "utf8")))
      .filter((name) => !/isEntryPoint\(/.test(readFileSync(path.join(SCRIPTS, name), "utf8")));
    expect(offenders, "use `isEntryPoint(import.meta.url, process.argv[1])` from scripts/e2e-entry.mjs").toEqual([]);
  });
});

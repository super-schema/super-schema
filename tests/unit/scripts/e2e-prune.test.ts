/**
 * scripts/e2e-prune.mjs: `test-results/run-<id>` accumulated for ever (398 MB). The release runner removes the run directories that are older
 * than 7 days, keeps the newest five (E2E_KEEP_RUNS) whatever their age, logs what it did, and never touches anything that is not a run
 * directory: another directory, a file, a phase's own results, an --output-root elsewhere.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_KEEP_RUNS, MAX_AGE_MS, RUN_DIRECTORY, parseKeepRuns, pruneRuns, selectRuns } from "../../../scripts/e2e-prune.mjs";

const NOW = Date.parse("2026-10-25T12:00:00Z");
const DAY = 86_400_000;
const dir = (name: string, daysOld: number) => ({ name, isDirectory: true, mtimeMs: NOW - daysOld * DAY });
const file = (name: string, daysOld: number) => ({ name, isDirectory: false, mtimeMs: NOW - daysOld * DAY });
const id = (n: number) => `run-${n.toString(16).padStart(8, "0")}`;

describe("parseKeepRuns", () => {
  it("is 5 unset or empty, and a positive whole number otherwise", () => {
    expect(parseKeepRuns(undefined)).toBe(DEFAULT_KEEP_RUNS);
    expect(parseKeepRuns("")).toBe(5);
    expect(parseKeepRuns("1")).toBe(1);
    expect(parseKeepRuns("20")).toBe(20);
  });

  it("refuses anything else, naming the variable (a typo must not mean 'delete everything')", () => {
    for (const raw of ["0", "-1", "five", "2.5", " 3", "3 "]) expect(() => parseKeepRuns(raw), raw).toThrow(/E2E_KEEP_RUNS must be a positive whole number/);
  });
});

describe("selectRuns", () => {
  it("keeps the newest 5 whatever their age, and removes the older ones that are more than 7 days old", () => {
    const runs = [dir(id(1), 40), dir(id(2), 30), dir(id(3), 20), dir(id(4), 10), dir(id(5), 9), dir(id(6), 8.5), dir(id(7), 8), dir(id(8), 1)];
    const { remove, keep } = selectRuns(runs, { now: NOW });
    // newest five: 8 (1 day), 7 (8), 6 (8.5), 5 (9), 4 (10): kept even though four of them are older than a week
    expect(keep.sort()).toEqual([id(4), id(5), id(6), id(7), id(8)]);
    expect(remove.sort()).toEqual([id(1), id(2), id(3)]);
  });

  it("keeps a run that is not among the newest five but is not older than 7 days", () => {
    const runs = Array.from({ length: 9 }, (_, i) => dir(id(i + 1), i)); // 0 .. 8 days
    const { remove } = selectRuns(runs, { now: NOW });
    expect(remove).toEqual([id(9)]); // 8 days: the only one beyond the five newest and past the week
    expect(selectRuns(runs.slice(0, 8), { now: NOW }).remove).toEqual([]); // 0..7 days: 7 days is not older than 7 days
  });

  it("removes nothing when there are 5 or fewer, however old", () => {
    expect(selectRuns([dir(id(1), 400), dir(id(2), 300), dir(id(3), 200), dir(id(4), 100), dir(id(5), 50)], { now: NOW }).remove).toEqual([]);
    expect(selectRuns([], { now: NOW })).toEqual({ remove: [], keep: [], ignored: [] });
  });

  it("keeps as many as E2E_KEEP_RUNS says (more, or fewer)", () => {
    const runs = Array.from({ length: 6 }, (_, i) => dir(id(i + 1), 30 + i));
    expect(selectRuns(runs, { now: NOW, keep: 2 }).remove).toHaveLength(4);
    expect(selectRuns(runs, { now: NOW, keep: 10 }).remove).toEqual([]);
    expect(selectRuns(runs, { now: NOW, keep: 1 }).keep).toEqual([id(1)]);
  });

  it("never selects what is not a run directory: other names, files named like runs, the phases' directories, near misses", () => {
    const entries = [
      dir(id(1), 90),
      dir(id(2), 90),
      dir(id(3), 90),
      dir(id(4), 90),
      dir(id(5), 90),
      dir(id(6), 90), // a run: the only one removed
      dir("main", 400),
      dir("serial", 400),
      dir("ci-smoke", 400),
      dir("run-", 400),
      dir("run-abc", 400),
      dir("run-0123456789", 400),
      dir("run-0000000G", 400),
      dir("RUN-00000001", 400),
      dir("my-run-00000001", 400),
      dir("run-00000001-old", 400),
      dir("evidence", 400),
      file("run-0000beef", 400),
      file("junit.xml", 400),
    ];
    const { remove, ignored } = selectRuns(entries, { now: NOW });
    expect(remove).toEqual([id(6)]);
    expect(ignored).toEqual(expect.arrayContaining(["main", "serial", "ci-smoke", "run-", "run-abc", "run-0123456789", "evidence", "run-0000beef", "junit.xml"]));
    expect(RUN_DIRECTORY.test("run-0000beef")).toBe(true); // the NAME is a run's: it is a file here, so it is ignored
  });

  it("orders by modification time, not by name", () => {
    const runs = [dir("run-ffffffff", 100), dir("run-00000001", 1), dir("run-00000002", 2), dir("run-00000003", 3), dir("run-00000004", 4), dir("run-00000005", 5)];
    expect(selectRuns(runs, { now: NOW }).remove).toEqual(["run-ffffffff"]);
  });

  it(`the limit is ${MAX_AGE_MS / DAY} days`, () => {
    expect(MAX_AGE_MS).toBe(7 * DAY);
  });
});

describe("pruneRuns", () => {
  const tree = (entries: ReturnType<typeof dir>[]) => ({
    readdir: vi.fn(() => entries),
    remove: vi.fn(),
  });
  const old = () => [...Array.from({ length: 5 }, (_, i) => dir(id(i + 1), 1 + i)), dir(id(90), 30), dir(id(91), 40), dir("main", 99)];

  it("removes what selectRuns says, only under <root>/test-results, and logs it with how to change it", () => {
    const deps = tree(old());
    const log = vi.fn();
    const result = pruneRuns({ root: "/repo", now: NOW, log, deps });
    expect(result.removed.sort()).toEqual([id(90), id(91)]);
    expect(deps.readdir).toHaveBeenCalledWith(path.join("/repo", "test-results"));
    expect(deps.remove.mock.calls.map((call) => call[0]).sort()).toEqual([path.join("/repo", "test-results", id(90)), path.join("/repo", "test-results", id(91))]);
    expect(log.mock.calls[0][0]).toMatch(/prune: removed 2 run directories older than 7 days \(the newest 5 always stay; E2E_KEEP_RUNS\)/);
    expect(log.mock.calls[0][0]).toContain(id(90));
  });

  it("a dry run removes nothing, and says what it would", () => {
    const deps = tree(old());
    const log = vi.fn();
    const result = pruneRuns({ root: "/repo", now: NOW, dryRun: true, log, deps });
    expect(result.removed.sort()).toEqual([id(90), id(91)]);
    expect(deps.remove).not.toHaveBeenCalled();
    expect(log.mock.calls[0][0]).toContain("(dry run): would remove 2 run directories");
  });

  it("says that there was nothing to prune, with the count it kept", () => {
    const log = vi.fn();
    pruneRuns({ root: "/repo", now: NOW, log, deps: tree([dir(id(1), 1), dir(id(2), 2)]) });
    expect(log.mock.calls[0][0]).toBe("[e2e-release] prune: 2 run directories in /repo/test-results; none older than 7 days beyond the newest 5");
  });

  it("honours keep: fewer runs are guaranteed, and a run younger than a week is never removed whatever keep says", () => {
    const deps = tree(old());
    // keep 1: only the newest is guaranteed, but runs 2..5 are 2 to 5 days old, so only the two old ones go
    expect(pruneRuns({ root: "/repo", now: NOW, keep: 1, deps }).removed.sort()).toEqual([id(90), id(91)]);
    // keep 10: everything is guaranteed
    expect(pruneRuns({ root: "/repo", now: NOW, keep: 10, deps: tree(old()) }).removed).toEqual([]);
  });

  it("does not fail the run when a directory cannot be removed: it says so, and the others are still removed", () => {
    const deps = tree(old());
    deps.remove.mockImplementationOnce(() => {
      throw new Error("EBUSY");
    });
    const log = vi.fn();
    const result = pruneRuns({ root: "/repo", now: NOW, log, deps });
    expect(result.failed).toHaveLength(1);
    expect(result.removed).toHaveLength(1);
    expect(log.mock.calls.map((c) => c[0]).join("\n")).toMatch(/could not remove .*EBUSY/);
  });

  it("is silent about a root without test-results (a first run): nothing to prune", () => {
    const log = vi.fn();
    const result = pruneRuns({
      root: "/repo",
      log,
      deps: {
        readdir: () => {
          throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        },
        remove: vi.fn(),
      },
    });
    expect(result).toEqual({ removed: [], kept: 0, failed: [] });
    expect(log).not.toHaveBeenCalled();
  });

  it("works on a real directory: removes the old run directories, keeps the newest, and leaves other directories and files alone", () => {
    const root = mkdtempSync(path.join(tmpdir(), "e2e-prune-"));
    try {
      const results = path.join(root, "test-results");
      const make = (name: string, daysOld: number, asFile = false) => {
        const target = path.join(results, name);
        if (asFile) writeFileSync(target, "x");
        else {
          mkdirSync(target, { recursive: true });
          writeFileSync(path.join(target, "server.log"), "x");
        }
        const when = new Date(Date.now() - daysOld * DAY);
        utimesSync(target, when, when);
      };
      mkdirSync(results, { recursive: true });
      for (let i = 1; i <= 7; i += 1) make(id(i), 10 + i); // seven runs, all more than a week old
      make("run-aaaaaaaa", 0.5); // today's
      make("main", 400);
      make("playwright-keepme", 400);
      make("run-0000cafe", 400, true); // a file with a run's name
      const result = pruneRuns({ root, keep: 5 });
      expect(result.removed).toHaveLength(3); // 8 runs, the newest 5 stay
      expect(existsSync(path.join(results, "run-aaaaaaaa"))).toBe(true);
      expect(existsSync(path.join(results, id(1)))).toBe(true); // the 5 newest: aaaaaaaa, 1, 2, 3, 4
      expect(existsSync(path.join(results, id(4)))).toBe(true);
      expect(existsSync(path.join(results, id(5)))).toBe(false);
      expect(existsSync(path.join(results, id(7)))).toBe(false);
      expect(existsSync(path.join(results, "main"))).toBe(true);
      expect(existsSync(path.join(results, "playwright-keepme"))).toBe(true);
      expect(existsSync(path.join(results, "run-0000cafe"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

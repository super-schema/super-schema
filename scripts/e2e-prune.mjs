// `test-results/run-<id>` accumulates: every release run without an `--output-root` keeps its reports, its traces and its server.log there for
// ever (398 MB after a few weeks). The release runner prunes the old ones when a run starts: a run directory older than 7 days goes, but the newest
// `keep` (5 by default, `E2E_KEEP_RUNS`) always stay, however old. It touches nothing else: only a DIRECTORY of `test-results` whose name is
// exactly `run-` and the 8 hexadecimal characters of a run id, so a directory a person made, an `--output-root` somewhere else, the phases' own
// `test-results/<phase>` directories and any file are never selected.
//
// Dependency-free; unit tested in tests/unit/scripts/e2e-prune.test.ts with a fake file system and, once, a real temporary directory.

import { readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";

/** A run directory is older than this when it is pruned (when it is not among the newest `keep`). */
export const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** How many of the newest run directories always stay. */
export const DEFAULT_KEEP_RUNS = 5;

/** The exact name of a release run's output directory (`run-` and `randomHex(4)`). */
export const RUN_DIRECTORY = /^run-[0-9a-f]{8}$/;

/**
 * `E2E_KEEP_RUNS` as a number: unset or empty is the default; anything but a positive whole number is an error that names the variable (a
 * typo must not mean "delete everything").
 *
 * @param {string | undefined} raw
 */
export function parseKeepRuns(raw) {
  if (raw === undefined || raw === "") return DEFAULT_KEEP_RUNS;
  if (!/^[1-9]\d*$/.test(raw)) throw new Error(`E2E_KEEP_RUNS must be a positive whole number of runs to keep (got "${raw}")`);
  return Number(raw);
}

/**
 * Which of `entries` to remove: run directories that are not among the newest `keep` and are older than `maxAgeMs`. Pure.
 *
 * @param {Array<{ name: string, isDirectory: boolean, mtimeMs: number }>} entries what is in `test-results`
 * @param {{ now: number, keep?: number, maxAgeMs?: number }} options
 * @returns {{ remove: string[], keep: string[], ignored: string[] }} names
 */
export function selectRuns(entries, { now, keep = DEFAULT_KEEP_RUNS, maxAgeMs = MAX_AGE_MS }) {
  const runs = entries.filter((entry) => entry.isDirectory && RUN_DIRECTORY.test(entry.name)).sort((a, b) => b.mtimeMs - a.mtimeMs || a.name.localeCompare(b.name));
  const ignored = entries.filter((entry) => !runs.includes(entry)).map((entry) => entry.name);
  // The newest `keep` stay whatever their age; of the rest, the ones older than the limit go.
  const remove = runs.slice(keep).filter((entry) => now - entry.mtimeMs > maxAgeMs);
  return {
    remove: remove.map((entry) => entry.name),
    keep: runs.filter((entry) => !remove.includes(entry)).map((entry) => entry.name),
    ignored: ignored.sort(),
  };
}

/**
 * Prunes `<root>/test-results`. With `dryRun` it only says what it would remove. Never throws: a directory that cannot be removed is said, and the
 * run goes on (a full disk is not the run's business, and a prune must not fail a release check).
 *
 * @param {{ root: string, now?: number, keep?: number, maxAgeMs?: number, dryRun?: boolean, log?: (message: string) => void,
 *   deps?: { readdir?: (dir: string) => Array<{ name: string, isDirectory: boolean, mtimeMs: number }>, remove?: (dir: string) => void } }} input
 * @returns {{ removed: string[], kept: number, failed: string[] }}
 */
export function pruneRuns({ root, now = Date.now(), keep = DEFAULT_KEEP_RUNS, maxAgeMs = MAX_AGE_MS, dryRun = false, log = () => {}, deps = {} }) {
  const dir = path.join(root, "test-results");
  const readdir =
    deps.readdir ??
    ((target) =>
      readdirSync(target, { withFileTypes: true }).map((entry) => {
        let mtimeMs = 0;
        try {
          mtimeMs = statSync(path.join(target, entry.name)).mtimeMs;
        } catch {
          // gone since the listing
        }
        return { name: entry.name, isDirectory: entry.isDirectory(), mtimeMs };
      }));
  const remove = deps.remove ?? ((target) => rmSync(target, { recursive: true, force: true }));
  let entries;
  try {
    entries = readdir(dir);
  } catch {
    return { removed: [], kept: 0, failed: [] }; // no test-results yet: nothing to prune
  }
  const selected = selectRuns(entries, { now, keep, maxAgeMs });
  const removed = [];
  const failed = [];
  for (const name of selected.remove) {
    if (dryRun) {
      removed.push(name);
      continue;
    }
    try {
      remove(path.join(dir, name));
      removed.push(name);
    } catch (error) {
      failed.push(name);
      log(`[e2e-release] prune: could not remove ${path.join(dir, name)}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const days = Math.round(maxAgeMs / 86_400_000);
  if (selected.remove.length === 0) {
    log(`[e2e-release] prune: ${selected.keep.length} run director${selected.keep.length === 1 ? "y" : "ies"} in ${dir}; none older than ${days} days beyond the newest ${keep}`);
  } else {
    log(`[e2e-release] prune${dryRun ? " (dry run)" : ""}: ${dryRun ? "would remove" : "removed"} ${removed.length} run director${removed.length === 1 ? "y" : "ies"} older than ${days} days (the newest ${keep} always stay; E2E_KEEP_RUNS): ${removed.join(", ")}`);
  }
  return { removed, kept: selected.keep.length, failed };
}

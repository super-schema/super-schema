#!/usr/bin/env node
// Prints the flaky tests of a release run as markdown, for the job summary of GitHub Actions:
//
//   E2E_OUTPUT_ROOT=<root> SUMMARY_TITLE="regression 2/4" node scripts/ci-flaky-summary.mjs >> "$GITHUB_STEP_SUMMARY"
//   node scripts/ci-flaky-summary.mjs <root>              (the directory as an argument instead of E2E_OUTPUT_ROOT)
//
// The same step lists the tests that did not run (`skipped-tests.json`, tests/e2e/reporters/skipped-reporter.ts): a skip is green in every report.
//
// A flaky test (failed, then passed on the retry) keeps the run green; tests/e2e/reporters/flaky-reporter.ts writes each phase's list to
// `<root>/test-results/<phase>/flaky-tests.json` (nothing when there was none). This puts those lists where a person looking at the run
// sees them, without opening an artifact. It reads every `flaky-tests.json` under the root (not inside `artifacts/`, where traces
// and videos are) and never fails: a list it cannot read is named in the summary, and the step that calls it runs `if: always()`.
//
// Three things it does not say wrongly:
//   - a root that does not exist, or has no report of any phase (no `junit.xml`, no `flaky-tests.json`), is "no test results found" (the run
//     failed before its tests started), not "no test passed only on a retry";
//   - there is no default root: without E2E_OUTPUT_ROOT or an argument it summarizes nothing (it would otherwise read whatever the working
//     directory holds), says so, and exits 0;
//   - the table stops at MAX_ROWS rows and says how many more there are (a job summary is limited to 1 MiB).
//
// Dependency-free like the other CI scripts; `collectFlaky` and `renderSummary` are unit tested (tests/unit/ci-e2e-workflow.test.ts).

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { isEntryPoint } from "./e2e-entry.mjs";

const FLAKY_FILE = "flaky-tests.json";
/** The list of tests that did not run, written by tests/e2e/reporters/skipped-reporter.ts into the same directory of each phase. */
const SKIPPED_FILE = "skipped-tests.json";
/** The other file every phase writes on CI (the junit reporter): its presence says that the phase ran, flaky or not. */
const JUNIT_FILE = "junit.xml";
const MAX_DEPTH = 4;
export const MAX_ROWS = 100;

/**
 * @typedef {{ project?: string, title?: string, location?: string, attempts?: number }} FlakyRow
 * @param {string} root the run's output root
 * @returns {{ root: string, rows: Array<FlakyRow & { phase: string }>, unreadable: string[], reports: number }} `reports`: how many report
 *   files (`flaky-tests.json` and `junit.xml`) there are under the root, 0 for a root that does not exist
 */
export function collectFlaky(root) {
  /** @type {string[]} */
  const files = [];
  let reports = 0;
  const walk = (dir, depth) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // no such directory: the run stopped before it wrote anything
    }
    for (const entry of entries) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < MAX_DEPTH && entry.name !== "artifacts") walk(file, depth + 1);
      } else if (entry.name === FLAKY_FILE) {
        files.push(file);
        reports += 1;
      } else if (entry.name === JUNIT_FILE) {
        reports += 1;
      }
    }
  };
  walk(root, 0);

  const rows = [];
  const unreadable = [];
  for (const file of files.sort()) {
    const phase = path.basename(path.dirname(file));
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8"));
      if (!Array.isArray(parsed)) throw new Error("not a list");
      for (const row of parsed) rows.push({ phase, ...row });
    } catch {
      unreadable.push(path.relative(root, file));
    }
  }
  return { root, rows, unreadable, reports };
}

/** A table cell: no pipe and no line break may end it early. */
const cell = (value) => String(value ?? "").replace(/\|/g, "\\|").replace(/[\r\n]+/g, " ");

/**
 * @param {{ title: string, rows: Array<FlakyRow & { phase: string }>, unreadable?: string[], root?: string, reports?: number }} input
 *   `reports` (from `collectFlaky`) is how many report files the root has: 0 says "no test results found"; left out, it is not asked.
 * @returns {string} markdown, ending with a line break
 */
export function renderSummary({ title, rows, unreadable = [], root = "", reports }) {
  const lines = [`### ${title}: flaky tests`, ""];
  if (reports === 0 && rows.length === 0 && unreadable.length === 0) {
    lines.push(`No test results found at ${cell(root)} (the run may have failed before tests started).`);
  } else if (rows.length === 0) {
    lines.push("No test passed only on a retry.");
  } else {
    const shown = rows.slice(0, MAX_ROWS);
    lines.push(
      `${rows.length} test(s) failed and then passed on a retry. The run is green; fix or quarantine them.`,
      "",
      "| Phase | Project | Test | Location | Attempts |",
      "| --- | --- | --- | --- | --- |",
      ...shown.map((r) => `| ${cell(r.phase)} | ${cell(r.project)} | ${cell(r.title)} | ${cell(r.location)} | ${cell(r.attempts)} |`),
    );
    if (rows.length > shown.length) {
      lines.push("", `and ${rows.length - shown.length} more (all of them are in the flaky-tests.json files of the test-results artifact).`);
    }
  }
  for (const file of unreadable) lines.push("", `Could not read ${cell(file)}.`);
  return `${lines.join("\n")}\n`;
}

/**
 * The skipped tests of a run: every `skipped-tests.json` under the root (one per phase, not inside `artifacts/`).
 *
 * @param {string} root the run's output root
 * @returns {{ rows: Array<{ phase: string, project?: string, title?: string, file?: string, line?: number, tags?: string[], reasons?: string[] }>, unreadable: string[] }}
 */
export function collectSkipped(root) {
  /** @type {string[]} */
  const files = [];
  const walk = (dir, depth) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < MAX_DEPTH && entry.name !== "artifacts") walk(file, depth + 1);
      } else if (entry.name === SKIPPED_FILE) {
        files.push(file);
      }
    }
  };
  walk(root, 0);
  const rows = [];
  const unreadable = [];
  for (const file of files.sort()) {
    const phase = path.basename(path.dirname(file));
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8"));
      if (!Array.isArray(parsed)) throw new Error("not a list");
      for (const row of parsed) rows.push({ phase, ...row });
    } catch {
      unreadable.push(path.relative(root, file));
    }
  }
  return { rows, unreadable };
}

/**
 * The job summary's section for the skipped tests: a skip is green in every report, so it is listed with its reason and whether it was
 * allowed (`@external`). Empty (no section) when nothing was skipped.
 *
 * @param {{ title: string, rows: ReturnType<typeof collectSkipped>["rows"], unreadable?: string[] }} input
 * @returns {string} markdown ("" when there is nothing to say)
 */
export function renderSkipped({ title, rows, unreadable = [] }) {
  if (rows.length === 0 && unreadable.length === 0) return "";
  const lines = ["", `### ${title}: skipped tests`, ""];
  if (rows.length > 0) {
    const shown = rows.slice(0, MAX_ROWS);
    lines.push(
      `${rows.length} test(s) did not run. A test tagged @external may skip (a network or second-server precondition); any other skip fails the run.`,
      "",
      "| Phase | Project | Test | Location | Allowed | Reason |",
      "| --- | --- | --- | --- | --- | --- |",
      ...shown.map((r) => `| ${cell(r.phase)} | ${cell(r.project)} | ${cell(r.title)} | ${cell(`${r.file}:${r.line}`)} | ${(r.tags ?? []).includes("@external") ? "yes (@external)" : "**no**"} | ${cell((r.reasons ?? []).join("; "))} |`),
    );
    if (rows.length > shown.length) lines.push("", `and ${rows.length - shown.length} more (all of them are in the skipped-tests.json files of the test-results artifact).`);
  }
  for (const file of unreadable) lines.push("", `Could not read ${cell(file)}.`);
  return `${lines.join("\n")}\n`;
}

if (isEntryPoint(import.meta.url, process.argv[1])) {
  const root = process.argv[2] || process.env.E2E_OUTPUT_ROOT;
  const title = process.env.SUMMARY_TITLE || "e2e";
  if (!root) {
    process.stdout.write(`### ${title}: flaky tests\n\nNo output root given (set E2E_OUTPUT_ROOT or pass the directory as an argument): nothing was summarized.\n`);
  } else {
    process.stdout.write(renderSummary({ title, ...collectFlaky(path.resolve(root)) }));
    process.stdout.write(renderSkipped({ title, ...collectSkipped(path.resolve(root)) }));
  }
}

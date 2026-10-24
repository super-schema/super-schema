#!/usr/bin/env node
// Prints the flaky tests of a release run as markdown, for the job summary of GitHub Actions:
//
//   E2E_OUTPUT_ROOT=<root> SUMMARY_TITLE="regression 2/4" node scripts/ci-flaky-summary.mjs >> "$GITHUB_STEP_SUMMARY"
//
// A flaky test (failed, then passed on the retry) keeps the run green; tests/e2e/reporters/flaky-reporter.ts writes each phase's list to
// `<root>/test-results/<phase>/flaky-tests.json` (nothing when there was none). This puts those lists where a person looking at the run
// sees them, without opening an artifact. It reads every `flaky-tests.json` under the root (not inside `artifacts/`, where traces
// and videos are) and never fails: a list it cannot read is named in the summary, and the step that calls it runs `if: always()`.
//
// Dependency-free like the other CI scripts; `collectFlaky` and `renderSummary` are unit tested (tests/unit/ci-e2e-workflow.test.ts).

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { isEntryPoint } from "./e2e-phases.mjs";

const FLAKY_FILE = "flaky-tests.json";
const MAX_DEPTH = 4;

/**
 * @typedef {{ project?: string, title?: string, location?: string, attempts?: number }} FlakyRow
 * @param {string} root the run's output root
 * @returns {{ rows: Array<FlakyRow & { phase: string }>, unreadable: string[] }}
 */
export function collectFlaky(root) {
  /** @type {string[]} */
  const files = [];
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

/** A table cell: no pipe and no line break may end it early. */
const cell = (value) => String(value ?? "").replace(/\|/g, "\\|").replace(/[\r\n]+/g, " ");

/**
 * @param {{ title: string, rows: Array<FlakyRow & { phase: string }>, unreadable?: string[] }} input
 * @returns {string} markdown, ending with a line break
 */
export function renderSummary({ title, rows, unreadable = [] }) {
  const lines = [`### ${title}: flaky tests`, ""];
  if (rows.length === 0) {
    lines.push("No test passed only on a retry.");
  } else {
    lines.push(
      `${rows.length} test(s) failed and then passed on a retry. The run is green; fix or quarantine them.`,
      "",
      "| Phase | Project | Test | Location | Attempts |",
      "| --- | --- | --- | --- | --- |",
      ...rows.map((r) => `| ${cell(r.phase)} | ${cell(r.project)} | ${cell(r.title)} | ${cell(r.location)} | ${cell(r.attempts)} |`),
    );
  }
  for (const file of unreadable) lines.push("", `Could not read ${cell(file)}.`);
  return `${lines.join("\n")}\n`;
}

if (isEntryPoint(import.meta.url, process.argv[1])) {
  const root = process.env.E2E_OUTPUT_ROOT || ".";
  const title = process.env.SUMMARY_TITLE || "e2e";
  process.stdout.write(renderSummary({ title, ...collectFlaky(root) }));
}

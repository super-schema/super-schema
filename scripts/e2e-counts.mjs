#!/usr/bin/env node
// How many tests each tier of the browser suite has, read from `playwright test --list` (never typed by hand, so the docs do not rot):
//
//   node scripts/e2e-counts.mjs                  a markdown table: per tier, the runs (test x project, what Playwright's own "Total" says), the distinct tests,
//                                                the spec files and the runs per project
//   node scripts/e2e-counts.mjs --json           the same as JSON
//   node scripts/e2e-counts.mjs --specs          per spec file: its tests, their tags and which tiers run them (the source of docs/testing/e2e-coverage-matrix.md)
//   node scripts/e2e-counts.mjs --specs --update-matrix   the same per-spec table, written into docs/testing/e2e-coverage-matrix.md (between its
//                                                markers: run it after adding or removing a test; a unit test fails while the two differ)
//   node scripts/e2e-counts.mjs --tier smoke     only that tier (repeatable)
//
// It asks the phases script's own planner for each tier's `playwright test` commands (scripts/e2e-phases.mjs: `planPhases`, so a tier is exactly what a run
// would run) and adds `--list --reporter=json`. Nothing is started: no browser, no server, no database, any Node. The login project (`setup`) is not counted:
// it is not a test of the product. The `visual` project exists only inside the Playwright Docker image (E2E_VISUAL_IN_DOCKER=1): its tier is listed with
// that variable, the others without it, so the numbers are those of THIS machine for every tier but `visual`, which is the image's.
//
// `parseListReport`, `specsOf`, `summarizeTier` and `specTable` are pure and unit tested (tests/unit/scripts/e2e-counts.test.ts).

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isEntryPoint } from "./e2e-entry.mjs";
import { TIERS, planPhases, playwrightCommand } from "./e2e-phases.mjs";

/** The tiers that are counted (`serial` is a means of running part of `regression` and `nightly`, not a set of tests of its own). */
export const COUNTED_TIERS = TIERS.filter((tier) => tier !== "serial");

/** The project that only logs in: not counted. */
const SETUP_PROJECT = "setup";

/**
 * One test of one project, as the JSON list reporter says it.
 *
 * @typedef {{ file: string, line: number, title: string, project: string, tags: string[] }} ListedTest
 */

/**
 * The tests of the JSON the list reporter prints (`playwright test --list --reporter=json`): every spec of every suite, one entry per project it runs in.
 *
 * @param {unknown} report
 * @returns {ListedTest[]}
 */
export function specsOf(report) {
  /** @type {ListedTest[]} */
  const found = [];
  const walk = (suite, titles) => {
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests ?? []) {
        found.push({
          file: spec.file,
          line: spec.line,
          title: [...titles, spec.title].filter(Boolean).join(" > "),
          project: test.projectName,
          tags: (spec.tags ?? []).map((tag) => (tag.startsWith("@") ? tag : `@${tag}`)),
        });
      }
    }
    for (const child of suite.suites ?? []) walk(child, child.title && child.title !== child.file ? [...titles, child.title] : titles);
  };
  for (const suite of /** @type {{ suites?: unknown[] }} */ (report).suites ?? []) walk(suite, []);
  return found.filter((test) => test.project !== SETUP_PROJECT);
}

/**
 * The JSON of `playwright test --list --reporter=json`, from its whole stdout (a warning of the config may come before the document).
 *
 * @param {string} stdout
 */
export function parseListReport(stdout) {
  const start = stdout.indexOf("{");
  if (start === -1) throw new Error(`playwright --list printed no JSON: ${stdout.slice(0, 200)}`);
  return JSON.parse(stdout.slice(start));
}

/** One test whatever the project it runs in: its place and its title (a `test.each` makes several tests at one place). */
const keyOf = (test) => `${test.file}:${test.line}:${test.title}`;

/**
 * The numbers of a tier from its tests (all its phases together).
 *
 * @param {ListedTest[]} tests
 */
export function summarizeTier(tests) {
  /** @type {Record<string, number>} */
  const byProject = {};
  for (const test of tests) byProject[test.project] = (byProject[test.project] ?? 0) + 1;
  return {
    runs: tests.length,
    distinct: new Set(tests.map(keyOf)).size,
    files: new Set(tests.map((test) => test.file)).size,
    byProject: Object.fromEntries(Object.entries(byProject).sort(([a], [b]) => a.localeCompare(b))),
  };
}

/**
 * Per spec file: how many distinct tests it has and which tags they carry, and for each tier how many of those tests the tier runs. `tiers` maps a
 * tier name to its tests (`ListedTest[]`).
 *
 * @param {Record<string, ListedTest[]>} tiers
 */
export function specTable(tiers) {
  /** @type {Map<string, { tests: Set<string>, tags: Map<string, number>, tiers: Record<string, Set<string>> }>} */
  const files = new Map();
  for (const [tier, tests] of Object.entries(tiers)) {
    for (const test of tests) {
      const row = files.get(test.file) ?? { tests: new Set(), tags: new Map(), tiers: {} };
      files.set(test.file, row);
      row.tiers[tier] ??= new Set();
      row.tiers[tier].add(keyOf(test));
      if (!row.tests.has(keyOf(test))) {
        row.tests.add(keyOf(test));
        for (const tag of test.tags) row.tags.set(tag, (row.tags.get(tag) ?? 0) + 1);
      }
    }
  }
  return [...files.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([file, row]) => ({
      file,
      tests: row.tests.size,
      tags: Object.fromEntries([...row.tags.entries()].sort(([a], [b]) => a.localeCompare(b))),
      tiers: Object.fromEntries(Object.entries(row.tiers).map(([tier, keys]) => [tier, keys.size])),
    }));
}

/** @param {ReturnType<typeof summarizeTier>} summary */
const projects = (summary) => Object.entries(summary.byProject).map(([name, n]) => `${name} ${n}`).join(", ");

/**
 * The markdown of the per-tier table.
 *
 * @param {Record<string, ReturnType<typeof summarizeTier>>} summaries
 */
export function renderTierTable(summaries) {
  return [
    "| Tier | Runs (test x project) | Distinct tests | Spec files | Runs per project |",
    "| --- | --- | --- | --- | --- |",
    ...Object.entries(summaries).map(([tier, s]) => `| ${tier} | ${s.runs} | ${s.distinct} | ${s.files} | ${projects(s)} |`),
  ].join("\n");
}

/** @param {ReturnType<typeof specTable>} rows @param {string[]} tierNames */
export function renderSpecTable(rows, tierNames) {
  return [
    `| Spec | Tests | Tags | ${tierNames.map((tier) => `${tier} runs`).join(" | ")} |`,
    `| --- | --- | --- | ${tierNames.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.file} | ${row.tests} | ${Object.entries(row.tags).map(([tag, n]) => `${tag} ${n}`).join(", ")} | ${tierNames.map((tier) => row.tiers[tier] ?? 0).join(" | ")} |`),
  ].join("\n");
}

/**
 * The tests of one tier: the phases the runner would run, each with `--list --reporter=json`.
 *
 * @param {string} tier
 * @param {{ run?: (command: string, args: string[], env: Record<string, string | undefined>) => { status: number | null, stdout: string, stderr: string } }} [deps]
 * @returns {ListedTest[]}
 */
export function listTier(tier, { run = defaultRun } = {}) {
  const { phases } = planPhases({ tier, extraArgs: ["--list"], authState: "", outputRoot: "." });
  const { command, args } = playwrightCommand();
  const env = {
    ...process.env,
    // A server that is never started (a listing needs none) and a browser that needs no machine (the channel is not looked at for a listing).
    E2E_BASE_URL: process.env.E2E_BASE_URL || "http://127.0.0.1:1",
    E2E_BROWSER_CHANNEL: process.env.E2E_BROWSER_CHANNEL || "chromium",
    // The `visual` project exists only in the Playwright image: its tier is listed as the image would see it.
    ...(tier === "visual" ? { E2E_VISUAL_IN_DOCKER: "1" } : {}),
  };
  const tests = [];
  for (const phase of phases) {
    const result = run(command, [...args, ...phase.args, "--reporter=json"], env);
    if (result.status !== 0) throw new Error(`playwright --list failed for the ${tier} tier (phase ${phase.name}, exit ${result.status}): ${result.stderr.slice(0, 500) || result.stdout.slice(0, 500)}`);
    tests.push(...specsOf(parseListReport(result.stdout)));
  }
  return tests;
}

function defaultRun(command, args, env) {
  const result = spawnSync(command, args, { encoding: "utf8", env, maxBuffer: 256 * 1024 * 1024, timeout: 5 * 60_000 });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/** Where the per-spec table is kept, between `<!-- counts:begin -->` and `<!-- counts:end -->`. */
export const MATRIX_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "docs", "testing", "e2e-coverage-matrix.md");

/**
 * The text between `<!-- name:begin -->` and `<!-- name:end -->`, without the line breaks around it, or undefined when the markers are not there.
 *
 * @param {string} text
 * @param {string} name
 */
export function blockOf(text, name) {
  const match = new RegExp(`<!-- ${name}:begin -->\n([\\s\\S]*?)\n?<!-- ${name}:end -->`).exec(text);
  return match ? match[1].replace(/\n$/, "") : undefined;
}

/**
 * `text` with the block `name` replaced by `content`. Throws when the markers are missing (a file that lost them is not silently left stale).
 *
 * @param {string} text
 * @param {string} name
 * @param {string} content
 */
export function replaceBlock(text, name, content) {
  if (blockOf(text, name) === undefined) throw new Error(`the markers <!-- ${name}:begin --> and <!-- ${name}:end --> are not in the file`);
  return text.replace(new RegExp(`(<!-- ${name}:begin -->\n)[\\s\\S]*?(\n?<!-- ${name}:end -->)`), (_all, begin, end) => `${begin}${content}\n${end.replace(/^\n/, "")}`);
}

/** @param {string[]} argv */
export function parseArgs(argv) {
  const out = { json: false, specs: false, updateMatrix: false, tiers: /** @type {string[]} */ ([]) };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") out.json = true;
    else if (arg === "--specs") out.specs = true;
    else if (arg === "--update-matrix") out.updateMatrix = true;
    else if (arg === "--tier") {
      const tier = argv[(i += 1)];
      if (!COUNTED_TIERS.includes(tier)) throw new Error(`--tier must be one of ${COUNTED_TIERS.join(", ")} (got "${tier}")`);
      out.tiers.push(tier);
    } else throw new Error(`unknown option ${arg}\nusage: node scripts/e2e-counts.mjs [--json | --specs [--update-matrix]] [--tier <${COUNTED_TIERS.join("|")}>]...`);
  }
  if (out.updateMatrix && !out.specs) throw new Error("--update-matrix writes the per-spec table: use it with --specs");
  if (out.tiers.length === 0) out.tiers = [...COUNTED_TIERS];
  return out;
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
  /** @type {Record<string, ListedTest[]>} */
  const tiers = {};
  try {
    for (const tier of options.tiers) tiers[tier] = listTier(tier);
  } catch (error) {
    console.error(`[e2e-counts] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(3);
  }
  const summaries = Object.fromEntries(Object.entries(tiers).map(([tier, tests]) => [tier, summarizeTier(tests)]));
  if (options.json) {
    console.log(JSON.stringify({ tiers: summaries, specs: specTable(tiers) }, null, 2));
  } else if (options.specs) {
    const table = renderSpecTable(specTable(tiers), options.tiers);
    if (options.updateMatrix) {
      writeFileSync(MATRIX_FILE, replaceBlock(readFileSync(MATRIX_FILE, "utf8"), "counts", table));
      console.log(`[e2e-counts] wrote the per-spec table into ${path.relative(process.cwd(), MATRIX_FILE)}`);
    } else {
      console.log(table);
    }
  } else {
    console.log(renderTierTable(summaries));
    console.log("\nThe login project (`setup`) is not counted. `visual` is listed as the Playwright image sees it; the other tiers as this machine does (the `visual` project is not defined outside the image).");
  }
}

if (isEntryPoint(import.meta.url, process.argv[1])) main();

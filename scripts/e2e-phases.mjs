#!/usr/bin/env node
// Runs a tier of the browser suite as the `playwright test` commands it needs, one per phase, and combines their exit codes.
//
//   node scripts/e2e-phases.mjs <smoke|regression|nightly|serial> [--no-serial] [playwright arguments...]
//
// Why a script and not one npm line (playwright.config.ts has the long version):
//   - Playwright runs a project's dependencies in full whatever --grep says, so `serial-after` (which depends on `chromium`) cannot
//     share a filtered command with `chromium`: the regression tier is two commands, the browser projects, then `serial-after --no-deps`;
//   - every `playwright test` clears its output directory and replaces the html report of the one before. Each phase therefore writes
//     to a directory of its own: test-results/<phase>/ (artifacts, junit.xml, flaky-tests.json) and playwright-report/<phase>/;
//   - the login (`setup` project) is one file per run (E2E_AUTH_STATE), so two runs at once do not write the same one, a stale file is
//     never reused, and a phase that skips `setup` (`--no-deps`) refuses a missing or old file with a message instead of an ENOENT.
//
// Playwright arguments after the tier go to the FIRST phase only (a --shard, a file, --headed). The later phase runs unless the shard is
// not 1/N (it is one job of its own, not a slice) or --no-serial is given. The exit code is the first non-zero one of the phases; a
// failing phase never stops the next one from running (a red main phase still reports the serial one).
//
// Dependency-free on purpose: the release runner calls it, and `planPhases` / `parseCli` / `authStateProblem` are unit tested
// (tests/unit/e2e-phases.test.ts) without running anything.

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const TIERS = ["smoke", "regression", "nightly", "serial"];

/** A saved login older than this is not trusted by a phase that does not run the `setup` project (a session can expire). */
export const MAX_AUTH_AGE_MS = 6 * 60 * 60 * 1000;

const SLOW_OR_EXTERNAL = "@slow|@external";
const DEFAULT_AUTH_STATE = path.join("playwright", ".auth", "admin.json");

/**
 * @typedef {{ name: string, args: string[], env: Record<string, string>, runsSetup: boolean, noDeps: boolean }} Phase
 * @typedef {{ tier: string, noSerial: boolean, extraArgs: string[] }} Cli
 */

/** @param {string[]} argv the arguments after the script name @returns {Cli} */
export function parseCli(argv) {
  const [tier, ...rest] = argv;
  if (!tier || !TIERS.includes(tier)) {
    throw new Error(`usage: node scripts/e2e-phases.mjs <${TIERS.join("|")}> [--no-serial] [playwright arguments...]`);
  }
  const noSerial = rest.includes("--no-serial");
  return { tier, noSerial, extraArgs: rest.filter((a) => a !== "--no-serial") };
}

/** The `--shard` of the arguments as `{ index, total }`, or undefined. Both `--shard=2/4` and `--shard 2/4` are read. */
export function shardOf(args) {
  for (let i = 0; i < args.length; i += 1) {
    const value = args[i] === "--shard" ? args[i + 1] : args[i].startsWith("--shard=") ? args[i].slice("--shard=".length) : undefined;
    const match = value === undefined ? null : /^(\d+)\/(\d+)$/.exec(value);
    if (match) return { index: Number(match[1]), total: Number(match[2]) };
  }
  return undefined;
}

/** Whether `args` carry a test-selecting option of their own for `playwright test` (so that `--no-deps` is the caller's choice). */
const hasNoDeps = (args) => args.includes("--no-deps");

/**
 * The phases of a run, in order, each with the arguments of `playwright test` and the environment that points its reports and its login
 * at a place of its own. Pure: no file is read or written here.
 *
 * @param {{ tier: string, noSerial?: boolean, extraArgs?: string[], authState: string }} input
 * @returns {{ phases: Phase[], skipped: string[] }}
 */
export function planPhases({ tier, noSerial = false, extraArgs = [], authState }) {
  /** @type {Array<{ name: string, args: string[] }>} */
  let plan;
  switch (tier) {
    case "smoke":
      plan = [{ name: "main", args: ["--grep=@smoke", "--project=chromium", "--project=firefox-smoke", "--project=webkit-smoke"] }];
      break;
    case "regression":
      plan = [
        { name: "main", args: [`--grep-invert=${SLOW_OR_EXTERNAL}`, "--project=chromium", "--project=a11y"] },
        { name: "serial", args: [`--grep-invert=${SLOW_OR_EXTERNAL}`, "--project=serial-after", "--no-deps"] },
      ];
      break;
    case "nightly":
      // Everything, unfiltered: the dependencies order `serial-after` after `chromium` by themselves, so one command is right.
      plan = [{ name: "main", args: [] }];
      break;
    case "serial":
      plan = [
        { name: "setup", args: ["--project=setup"] },
        { name: "serial", args: ["--project=serial-after", "--no-deps"] },
      ];
      break;
    default:
      throw new Error(`unknown tier "${tier}"`);
  }

  const skipped = [];
  const shard = shardOf(extraArgs);
  const phases = [];
  plan.forEach((step, index) => {
    if (index > 0 && noSerial) {
      skipped.push(`${step.name}: skipped (--no-serial)`);
      return;
    }
    if (index > 0 && shard && shard.index !== 1) {
      skipped.push(`${step.name}: skipped (shard ${shard.index}/${shard.total}: it runs once, with shard 1/${shard.total})`);
      return;
    }
    const args = ["test", ...step.args, `--output=${path.join("test-results", step.name, "artifacts")}`, ...(index === 0 ? extraArgs : [])];
    const noDeps = hasNoDeps(args);
    phases.push({
      name: step.name,
      args,
      noDeps,
      // `setup` runs when it is selected itself or comes as a dependency; a --no-deps phase leaves it out.
      runsSetup: args.includes("--project=setup") || !noDeps,
      env: {
        E2E_AUTH_STATE: authState,
        PLAYWRIGHT_HTML_OUTPUT_DIR: path.join("playwright-report", step.name),
        PLAYWRIGHT_JUNIT_OUTPUT_FILE: path.join("test-results", step.name, "junit.xml"),
        E2E_FLAKY_FILE: path.join("test-results", step.name, "flaky-tests.json"),
      },
    });
  });
  return { phases, skipped };
}

/**
 * Why a phase that does not run the `setup` project cannot trust the saved login, or null when it can. Pure.
 *
 * @param {{ exists: boolean, mtimeMs?: number, now: number, maxAgeMs?: number, file: string }} input
 */
export function authStateProblem({ exists, mtimeMs = 0, now, maxAgeMs = MAX_AUTH_AGE_MS, file }) {
  if (!exists) {
    return `the saved login ${file} does not exist, and this phase does not run the setup project (--no-deps). Run \`npx playwright test --project=setup\` first, or drop --no-deps.`;
  }
  const age = now - mtimeMs;
  if (age > maxAgeMs) {
    const hours = Math.floor(age / 3_600_000);
    return `the saved login ${file} is ${hours} hours old (limit ${Math.round(maxAgeMs / 3_600_000)}), and this phase does not run the setup project (--no-deps): its session may have expired. Run \`npx playwright test --project=setup\` again.`;
  }
  return null;
}

/** The login file of a run: the one the caller names, a file of its own for a run that logs in, else the default for a --no-deps run. */
export function chooseAuthState({ env, firstPhaseRunsSetup, runId }) {
  if (env.E2E_AUTH_STATE) return { file: path.resolve(env.E2E_AUTH_STATE), ownedByThisRun: false };
  if (!firstPhaseRunsSetup) return { file: path.resolve(DEFAULT_AUTH_STATE), ownedByThisRun: false };
  return { file: path.resolve("playwright", ".auth", `run-${runId}.json`), ownedByThisRun: true };
}

/** @param {Phase} phase @returns {Promise<number>} */
function runPhase(phase, onChild) {
  return new Promise((resolve) => {
    const npx = process.platform === "win32" ? "npx.cmd" : "npx";
    const child = spawn(npx, ["playwright", ...phase.args], { stdio: "inherit", env: { ...process.env, ...phase.env } });
    onChild(child);
    child.on("error", (error) => {
      console.error(`[e2e-phases] ${phase.name}: could not start playwright: ${error.message}`);
      resolve(1);
    });
    child.on("exit", (code) => resolve(code ?? 1));
  });
}

async function main() {
  let cli;
  try {
    cli = parseCli(process.argv.slice(2));
  } catch (error) {
    console.error(String(error instanceof Error ? error.message : error));
    process.exit(2);
  }

  const first = planPhases({ ...cli, authState: "x" }).phases[0];
  const auth = chooseAuthState({ env: process.env, firstPhaseRunsSetup: first.runsSetup, runId: `${process.pid}-${randomBytes(4).toString("hex")}` });
  const { phases, skipped } = planPhases({ ...cli, authState: auth.file });
  for (const note of skipped) console.log(`[e2e-phases] ${note}`);

  let child;
  let interrupted = false;
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      interrupted = true;
      child?.kill(signal);
    });
  }

  const results = [];
  let setupRanThisRun = false;
  try {
    for (const phase of phases) {
      if (interrupted) break;
      if (phase.runsSetup && !setupRanThisRun) {
        // The login is made by this run: whatever is at that path is from an earlier one and must not be mistaken for it.
        rmSync(auth.file, { force: true });
        mkdirSync(path.dirname(auth.file), { recursive: true });
        setupRanThisRun = true;
      }
      if (!phase.runsSetup) {
        const exists = existsSync(auth.file);
        const problem = authStateProblem({ exists, mtimeMs: exists ? statSync(auth.file).mtimeMs : 0, now: Date.now(), file: auth.file });
        if (problem) {
          console.error(`[e2e-phases] ${phase.name}: refused: ${problem}`);
          results.push({ name: phase.name, code: 1, refused: true });
          continue;
        }
      }
      console.log(`[e2e-phases] ${phase.name}: playwright ${phase.args.join(" ")}`);
      const code = await runPhase(phase, (c) => (child = c));
      results.push({ name: phase.name, code });
    }
  } finally {
    if (auth.ownedByThisRun) rmSync(auth.file, { force: true });
  }

  console.log("[e2e-phases] summary:");
  for (const phase of phases) {
    const result = results.find((r) => r.name === phase.name);
    const text = !result ? "not run" : result.refused ? "refused" : result.code === 0 ? "passed" : `failed (exit ${result.code})`;
    console.log(`  ${phase.name}: ${text}   report: playwright-report/${phase.name}/index.html   results: test-results/${phase.name}/`);
  }
  process.exit(results.find((r) => r.code !== 0)?.code ?? (interrupted ? 130 : 0));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}

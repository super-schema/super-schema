#!/usr/bin/env node
// Runs a tier of the browser suite as the `playwright test` commands it needs, one per phase, and combines their exit codes.
//
//   node scripts/e2e-phases.mjs <smoke|regression|nightly|serial|visual> [--no-serial] [playwright arguments...]
//
// Two of the arguments are read by the planner and not just passed on: `--project <name>` NARROWS the tier to that project (a phase none of
// whose projects it names is skipped; a bare `playwright test --project x` would add x to the tier's own), and `--list` lists the tests of
// every phase instead of running them (no login, no server).
//
// Why a script and not one npm line (playwright.config.ts has the long version):
//   - Playwright runs a project's dependencies in full whatever --grep says, so `serial-after` (which depends on `chromium`) cannot
//     share a filtered command with `chromium`: the regression tier is two commands, the browser projects, then `serial-after --no-deps`;
//   - every `playwright test` clears its output directory and replaces the html report of the one before. Each phase therefore writes
//     to a directory of its own: test-results/<phase>/ (artifacts, junit.xml, flaky-tests.json) and playwright-report/<phase>/, under
//     E2E_OUTPUT_ROOT when it is set (two runs at once from one checkout give each its own root; default: the working directory);
//   - the login (`setup` project) is one file per run (E2E_AUTH_STATE), so two runs at once do not write the same one, a stale file is
//     never reused, and a phase that skips `setup` (`--no-deps`) refuses a missing or old file with a message instead of an ENOENT.
//
// Playwright arguments after the tier go to the FIRST phase only (a --shard, a file, --headed); for the tier `serial` they go to the LAST
// one (its first phase only logs in, which a file or a --grep would break). The later phase runs unless the shard is not 1/N (it is
// one job of its own, not a slice) or --no-serial is given. The exit code is the first non-zero one of the phases (128 + the signal
// number after an interrupt); a failing phase never stops the next one from running (a red main phase still reports the serial one).
//
// Playwright is started with node and its own CLI file (not through npx: a shell in between), as the leader of a process group
// (scripts/e2e-process.mjs): a SIGINT / SIGTERM / SIGHUP to this script is forwarded to that group once, a second one kills it, and the
// login file is removed on the way out either way.
//
// The browser: the phases script decides it once (scripts/e2e-browser.cjs: an explicit E2E_BROWSER_CHANNEL=chrome|chromium wins; else
// Chromium on CI; else Google Chrome when the machine has it, else Playwright's Chromium), gives every Playwright it starts that answer as
// E2E_BROWSER_CHANNEL (playwright.config.ts reads it), and names the browser with its version at the start and in the summary. A listing
// (`--list`) starts no browser and names none.
//
// The Node: the suite runs on Node 20.9+ or 22 (scripts/e2e-node.mjs): another Node is refused with exit 2 before anything is made,
// unless E2E_ALLOW_UNSUPPORTED_NODE=1. The Node of the run is named in the header (`[e2e-phases] node: v22.12.0`).
//
// The stall watchdog: each phase gets a heartbeat file (E2E_HEARTBEAT_FILE, <results>/<phase>/heartbeat) that
// tests/e2e/reporters/heartbeat-reporter.ts rewrites whenever a test starts or ends. A Playwright whose heartbeat is older than
// E2E_STALL_MS (default 20 minutes, above the longest test timeout) is ended (its group, then everything below it) and the phase's code is 124. It does not matter
// why it hangs, nor that the reporter's last word was "end": the hang after the last test, with every worker idle, is the case this is for.
//
// Dependency-free on purpose: the release runner calls it, and the planner and the pieces around it (`planPhases`, `parseCli`,
// `authStateProblem`, `runPhases`, `exitCodeOf`, `phaseSummaryLine`, `phaseEnvironment`, `stallMessage`, `isEntryPoint`) are unit tested
// (tests/unit/e2e-phases.test.ts) without running anything.

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { browserEnv, decideForThisProcess, describeBrowser, realProbes } from "./e2e-browser.cjs";
import { describeNode, nodeProblem } from "./e2e-node.mjs";
import {
  DEFAULT_STALL_MS,
  SIGNALS,
  STALL_EXIT_CODE,
  createInterrupt,
  exitCodeForSignal,
  formatDuration,
  killTree,
  parseMillis,
  pollMsFor,
  readHeartbeat,
  signalGroup,
  spawnGroup,
  stopStalledChild,
  watchForStall,
} from "./e2e-process.mjs";

export const TIERS = ["smoke", "regression", "nightly", "serial", "visual"];

/** A saved login older than this is not trusted by a phase that does not run the `setup` project (a session can expire). */
export const MAX_AUTH_AGE_MS = 6 * 60 * 60 * 1000;

const SLOW_OR_EXTERNAL = "@slow|@external";
const DEFAULT_AUTH_STATE = path.join("playwright", ".auth", "admin.json");

/**
 * @typedef {{ name: string, args: string[], env: Record<string, string>, runsSetup: boolean, noDeps: boolean, listOnly: boolean }} Phase
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

/** The names of the `--project` options of `args` (`--project=a`, `--project a`), each once, in order. */
export function projectsOf(args) {
  const names = [];
  for (let i = 0; i < args.length; i += 1) {
    const name = args[i] === "--project" ? args[i + 1] : args[i].startsWith("--project=") ? args[i].slice("--project=".length) : undefined;
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}

/** `args` without their `--project` options. */
function withoutProjects(args) {
  const rest = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--project") i += 1;
    else if (!args[i].startsWith("--project=")) rest.push(args[i]);
  }
  return rest;
}

/** Whether `args` carry a test-selecting option of their own for `playwright test` (so that `--no-deps` is the caller's choice). */
const hasNoDeps = (args) => args.includes("--no-deps");

/**
 * The phases of a run, in order, each with the arguments of `playwright test` and the environment that points its reports and its login
 * at a place of its own. Pure: no file is read or written here.
 *
 * @param {{ tier: string, noSerial?: boolean, extraArgs?: string[], authState: string, outputRoot?: string }} input
 * @returns {{ phases: Phase[], skipped: string[] }}
 */
export function planPhases({ tier, noSerial = false, extraArgs = [], authState, outputRoot = "." }) {
  const results = (phase) => path.join(outputRoot, "test-results", phase);
  const report = (phase) => path.join(outputRoot, "playwright-report", phase);
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
    case "visual":
      // The screenshot comparisons: only inside the Playwright Docker image, where the project exists (playwright.config.ts, E2E_VISUAL_IN_DOCKER).
      plan = [{ name: "main", args: ["--project=visual"] }];
      break;
    default:
      throw new Error(`unknown tier "${tier}"`);
  }

  const skipped = [];
  const shard = shardOf(extraArgs);
  const phases = [];
  // `--project` narrows the tier (a bare `playwright test` would ADD the project to the ones of the tier), `--list` lists every phase
  // instead of running it (no login, no server needed); both are read here and written into each phase's own arguments.
  const wanted = projectsOf(extraArgs);
  const list = extraArgs.includes("--list");
  const callerArgs = withoutProjects(extraArgs).filter((a) => a !== "--list");
  // The caller's arguments (a spec file, --grep, --shard, --headed) belong to the phase that runs tests: the first one, except for tier
  // `serial`, whose first phase only logs in. Only a run whose arguments go to the first phase is a slice of a sharded run.
  const argsPhase = tier === "serial" ? plan.length - 1 : 0;
  plan.forEach((step, index) => {
    if (index > 0 && noSerial) {
      skipped.push(`${step.name}: skipped (--no-serial)`);
      return;
    }
    if (index > 0 && argsPhase === 0 && shard && shard.index !== 1) {
      skipped.push(`${step.name}: skipped (shard ${shard.index}/${shard.total}: it runs once, with shard 1/${shard.total})`);
      return;
    }
    let stepArgs = step.args;
    if (wanted.length) {
      const own = stepArgs.filter((a) => a.startsWith("--project="));
      if (own.length === 0) {
        stepArgs = [...stepArgs, ...wanted.map((name) => `--project=${name}`)];
      } else {
        const kept = own.filter((a) => wanted.includes(a.slice("--project=".length)));
        if (kept.length === 0) {
          skipped.push(`${step.name}: skipped (--project ${wanted.join(",")}: not one of its projects, ${own.map((a) => a.slice("--project=".length)).join(", ")})`);
          return;
        }
        stepArgs = [...stepArgs.filter((a) => !a.startsWith("--project=")), ...kept];
      }
    }
    const args = [
      "test",
      ...stepArgs,
      `--output=${path.join(results(step.name), "artifacts")}`,
      ...(index === argsPhase ? callerArgs : []),
      ...(list ? ["--list"] : []),
    ];
    const noDeps = hasNoDeps(args);
    phases.push({
      name: step.name,
      args,
      noDeps,
      listOnly: list,
      // `setup` runs when it is selected itself or comes as a dependency; a --no-deps phase leaves it out; a listing runs nothing.
      runsSetup: !list && (args.includes("--project=setup") || !noDeps),
      env: {
        E2E_AUTH_STATE: authState,
        PLAYWRIGHT_HTML_OUTPUT_DIR: report(step.name),
        PLAYWRIGHT_JUNIT_OUTPUT_FILE: path.join(results(step.name), "junit.xml"),
        E2E_FLAKY_FILE: path.join(results(step.name), "flaky-tests.json"),
        E2E_HEARTBEAT_FILE: path.join(results(step.name), "heartbeat"),
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

/**
 * The command that starts the local Playwright CLI: node itself and the CLI file, resolved from this checkout's node_modules (not
 * `npx playwright`: an extra process in between, and a signal to the wrong one).
 */
export function playwrightCommand(resolve = createRequire(import.meta.url).resolve) {
  return { command: process.execPath, args: [resolve("@playwright/test/cli")] };
}

/**
 * The exit code of a run: the signal's (128 + n) when it was interrupted, else the first non-zero code of the phases, else 0.
 *
 * @param {Array<{ name: string, code: number }>} results
 * @param {string} [signal] the signal that interrupted the run
 */
export function exitCodeOf(results, signal) {
  if (signal) return exitCodeForSignal(signal);
  return results.find((r) => r.code !== 0)?.code ?? 0;
}

/**
 * One line of the summary. The report and results paths are printed only when they exist: a run with the `list` reporter alone (any
 * local run) writes neither, and pointing at a missing file is worse than saying nothing.
 *
 * @param {{ phase: Phase, result?: { name: string, code: number, refused?: boolean }, exists?: (file: string) => boolean }} input
 */
export function phaseSummaryLine({ phase, result, exists = existsSync }) {
  const text = !result ? "not run" : result.refused ? "refused" : result.code === 0 ? "passed" : `failed (exit ${result.code})`;
  const where = [];
  if (result && !result.refused) {
    const report = path.join(phase.env.PLAYWRIGHT_HTML_OUTPUT_DIR, "index.html");
    const results = path.dirname(phase.env.PLAYWRIGHT_JUNIT_OUTPUT_FILE);
    if (exists(report)) where.push(`report: ${report}`);
    if (exists(results)) where.push(`results: ${results}/`);
  }
  return `  ${phase.name}: ${text}${where.map((w) => `   ${w}`).join("")}`;
}

/** The line of the summary that names the browser of the run (`describeBrowser`'s text: name, version, channel, why). */
export function browserSummaryLine(text) {
  return `  browser: ${text}`;
}

/**
 * The environment of a phase's Playwright: the process's own, the phase's (reports, login), and the browser that was decided (over
 * whatever E2E_BROWSER_CHANNEL the shell had: the decision already took it into account).
 *
 * @param {Record<string, string | undefined>} env
 * @param {Phase} phase
 * @param {{ channel: "chrome" | "chromium" } | undefined} browser undefined for a listing, which decides nothing: the environment is then the phase's own
 * @returns {Record<string, string | undefined>}
 */
export function phaseEnvironment(env, phase, browser) {
  return { ...env, ...phase.env, ...(browser ? browserEnv(browser) : {}) };
}

/**
 * Runs the phases in order and returns their results. Everything it touches comes in through `deps`, so the order of the login file's
 * removal and of the phases is unit tested with fakes. A phase that fails does not stop the next one; an interrupt (`deps.interrupted()`)
 * does; the login file of this run is removed whatever happens, a thrown error included.
 *
 * @param {{ phases: Phase[], auth: { file: string, ownedByThisRun: boolean }, deps: {
 *   interrupted: () => boolean, runPhase: (phase: Phase) => Promise<number>,
 *   existsSync: (file: string) => boolean, statSync: (file: string) => { mtimeMs: number }, rmSync: (file: string, options?: object) => void,
 *   mkdirSync: (dir: string, options?: object) => void, now: () => number, log: (message: string) => void, error: (message: string) => void } }} input
 * @returns {Promise<Array<{ name: string, code: number, refused?: boolean }>>}
 */
export async function runPhases({ phases, auth, deps }) {
  const results = [];
  let setupRanThisRun = false;
  try {
    for (const phase of phases) {
      if (deps.interrupted()) break;
      if (phase.listOnly) {
        deps.log(`[e2e-phases] ${phase.name}: playwright ${phase.args.join(" ")}`);
        results.push({ name: phase.name, code: await deps.runPhase(phase) });
        continue;
      }
      if (phase.runsSetup && !setupRanThisRun) {
        // The login is made by this run: whatever is at that path is from an earlier one and must not be mistaken for it.
        deps.rmSync(auth.file, { force: true });
        deps.mkdirSync(path.dirname(auth.file), { recursive: true });
        setupRanThisRun = true;
      }
      if (!phase.runsSetup) {
        const exists = deps.existsSync(auth.file);
        const problem = authStateProblem({ exists, mtimeMs: exists ? deps.statSync(auth.file).mtimeMs : 0, now: deps.now(), file: auth.file });
        if (problem) {
          deps.error(`[e2e-phases] ${phase.name}: refused: ${problem}`);
          results.push({ name: phase.name, code: 1, refused: true });
          continue;
        }
      }
      deps.log(`[e2e-phases] ${phase.name}: playwright ${phase.args.join(" ")}`);
      results.push({ name: phase.name, code: await deps.runPhase(phase) });
    }
  } finally {
    if (auth.ownedByThisRun) deps.rmSync(auth.file, { force: true });
  }
  return results;
}

/**
 * Whether this module is the script node was started with. The paths are compared as real paths: `import.meta.url` is already the real
 * one, while `process.argv[1]` keeps a symlink on the way (macOS: /tmp, /var and /private are links; a worktree's node_modules is one),
 * and comparing the two as strings made `main()` silently not run, with exit code 0. When the file run has THIS script's name and is
 * still not this file, it throws: a run that does nothing and says nothing is the worst way to fail.
 *
 * @param {string} moduleUrl `import.meta.url`
 * @param {string | undefined} argv1 `process.argv[1]`
 * @param {(file: string) => string} [realpath]
 */
export function isEntryPoint(moduleUrl, argv1, realpath = realpathSync) {
  if (!argv1) return false;
  const self = fileURLToPath(moduleUrl);
  const real = (file) => {
    try {
      return realpath(file);
    } catch {
      return path.resolve(file);
    }
  };
  const [run, me] = [real(argv1), real(self)];
  if (run === me) return true;
  if (path.basename(argv1) === path.basename(self)) {
    throw new Error(`[${path.basename(self)}] ${argv1} has this script's name but resolves to ${run}, not ${me}: refusing to exit 0 without running anything.`);
  }
  return false;
}

/**
 * What is said when the watchdog ends a phase. `ended` is true when the reporter's last word was "end": every test had been reported and
 * Playwright still did not exit.
 *
 * @param {{ phase: string, idleMs: number, ended: boolean, nodeVersion: string }} input
 */
export function stallMessage({ phase, idleMs, ended, nodeVersion }) {
  const what = ended ? "every test had finished but Playwright did not exit" : "no test finished";
  return `[e2e-phases] ${phase}: stalled: ${what} for ${formatDuration(idleMs)}, workers idle, likely a Node/Playwright incompatibility (node ${nodeVersion}); ending Playwright (exit ${STALL_EXIT_CODE})`;
}

/**
 * @param {Phase} phase
 * @param {(child: import("node:child_process").ChildProcess) => void} onChild
 * @param {{ channel: "chrome" | "chromium" } | undefined} browser
 * @param {number} stallMs how long without a heartbeat is a stall
 * @returns {Promise<number>}
 */
function runPhase(phase, onChild, browser, stallMs) {
  return new Promise((resolve) => {
    const { command, args } = playwrightCommand();
    const heartbeat = phase.listOnly ? undefined : phase.env.E2E_HEARTBEAT_FILE;
    if (heartbeat) {
      // A heartbeat of an earlier run in the same directory must not look like a sign of life of this one.
      mkdirSync(path.dirname(heartbeat), { recursive: true });
      rmSync(heartbeat, { force: true });
    }
    const child = spawnGroup(command, [...args, ...phase.args], { stdio: "inherit", env: phaseEnvironment(process.env, phase, browser) });
    onChild(child);
    const watcher = heartbeat
      ? watchForStall({
          stallMs,
          pollMs: pollMsFor(stallMs),
          readHeartbeat: () => readHeartbeat(heartbeat),
          onStall: ({ idleMs, ended }) => {
            console.error(stallMessage({ phase: phase.name, idleMs, ended, nodeVersion: process.version }));
            void stopStalledChild(child);
          },
        })
      : undefined;
    child.on("error", (error) => {
      watcher?.stop();
      console.error(`[e2e-phases] ${phase.name}: could not start playwright: ${error.message}`);
      resolve(1);
    });
    child.on("exit", (code, signal) => {
      watcher?.stop();
      resolve(watcher?.stalled ? STALL_EXIT_CODE : (code ?? (signal ? exitCodeForSignal(signal) : 1)));
    });
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

  const outputRoot = process.env.E2E_OUTPUT_ROOT || ".";
  const firstPlan = planPhases({ ...cli, authState: "", outputRoot });
  const first = firstPlan.phases[0];
  if (!first) {
    console.error(`[e2e-phases] nothing to run: ${firstPlan.skipped.join("; ")}`);
    process.exit(2);
  }
  // The Node and the watchdog's limit, before anything is made. A listing runs no test and cannot stall: any Node may list.
  let stallMs = DEFAULT_STALL_MS;
  try {
    const problem = first.listOnly ? null : nodeProblem(process.versions, process.env);
    if (problem) throw new Error(problem);
    stallMs = parseMillis("E2E_STALL_MS", process.env.E2E_STALL_MS) ?? DEFAULT_STALL_MS;
  } catch (error) {
    console.error(`[e2e-phases] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  }
  // The browser, before anything is made (a login file, a child): an explicit chrome without Chrome, or a value that is no channel, ends here.
  /** @type {import("./e2e-browser.cjs").BrowserDecision | undefined} */
  let browser;
  let browserText = "";
  if (!first.listOnly) {
    try {
      browser = decideForThisProcess(process.env);
    } catch (error) {
      console.error(`[e2e-phases] ${error instanceof Error ? error.message : String(error)}`);
      process.exit(2);
    }
    if (browser.problem) {
      console.error(`[e2e-phases] ${browser.problem}`);
      process.exit(2);
    }
    browserText = describeBrowser(browser, realProbes());
  }
  const auth = chooseAuthState({ env: process.env, firstPhaseRunsSetup: first.runsSetup, runId: `${process.pid}-${randomBytes(4).toString("hex")}` });
  const { phases, skipped } = planPhases({ ...cli, authState: auth.file, outputRoot });
  if (!first.listOnly) {
    console.log(`[e2e-phases] ${describeNode(process.versions, process.env)}`);
    console.log(`[e2e-phases] browser: ${browserText}`);
    console.log(`[e2e-phases] login: ${auth.file}${auth.ownedByThisRun ? " (this run's own, removed at the end)" : ""}`);
  }
  for (const note of skipped) console.log(`[e2e-phases] ${note}`);

  let child;
  const interrupt = createInterrupt({
    forward: (signal) => child && signalGroup(child, signal),
    force: () => {
      if (!child) return;
      if (child.pid !== undefined) killTree(child.pid);
      signalGroup(child, "SIGKILL");
    },
  });
  for (const signal of SIGNALS) process.on(signal, () => interrupt.handle(signal));
  // Last resort (a throw nobody foresaw, a process.exit elsewhere): the login must not outlive the run.
  if (auth.ownedByThisRun) process.on("exit", () => rmSync(auth.file, { force: true }));

  const results = await runPhases({
    phases,
    auth,
    deps: {
      interrupted: () => interrupt.interrupted,
      runPhase: (phase) =>
        runPhase(
          phase,
          (c) => {
            child = c;
            if (interrupt.interrupted) signalGroup(c, interrupt.signal); // the signal came between two phases
          },
          browser,
          stallMs,
        ),
      existsSync,
      statSync,
      rmSync,
      mkdirSync,
      now: Date.now,
      log: (message) => console.log(message),
      error: (message) => console.error(message),
    },
  });
  interrupt.done();

  console.log("[e2e-phases] summary:");
  if (browserText) console.log(browserSummaryLine(browserText));
  for (const phase of phases) console.log(phaseSummaryLine({ phase, result: results.find((r) => r.name === phase.name) }));
  process.exit(exitCodeOf(results, interrupt.signal));
}

if (isEntryPoint(import.meta.url, process.argv[1])) {
  await main();
}

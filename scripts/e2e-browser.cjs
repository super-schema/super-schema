// Which browser the browser suite runs in: the Google Chrome of the machine (Playwright's `channel: "chrome"`) or the Chromium that
// Playwright downloads. One pure decision, used by the three places that must agree: playwright.config.ts (the projects' `use.channel`),
// scripts/e2e-phases.mjs (what it hands to Playwright, and what it prints) and scripts/e2e-release.mjs (the same, and it passes its
// decision on through scripts/e2e-env.mjs). Dependency-free; unit tested in tests/unit/scripts/e2e-browser.test.ts.
//
// CommonJS (.cjs) on purpose, unlike its sibling scripts: playwright.config.ts imports it, and Playwright's loader transpiles whatever a
// config imports to CommonJS first (an imported `.mjs` then fails with "exports is not defined in ES module scope"), while the `.mjs`
// scripts import a `.cjs` file as they would any module (`import { decideBrowser } from "./e2e-browser.cjs"`).
//
// The decision, in this order:
//   1. an explicit E2E_BROWSER_CHANNEL (`chrome` or `chromium`) wins over everything, CI included. `chrome` without a Chrome on the machine
//      is a problem the caller reports (it is not quietly replaced: whoever asked for Chrome should not get another browser); a value that
//      is neither is refused;
//   2. on CI: the bundled Chromium (what the CI runners install, and what has always run there);
//   3. else Chrome when the machine has it, else the bundled Chromium.
//
// Only `chromium`, `serial-after` and `a11y` take the channel. `visual` never does: its snapshots are pixels, and they are taken (and
// compared) in the bundled Chromium of the Playwright Docker image.

/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS on purpose (see above): `require` is how this file is written */
"use strict";

const { execFileSync } = require("node:child_process");
const { existsSync } = require("node:fs");
const path = require("node:path");

/** The variable the three places read, and the runner sets for the Playwright it starts. */
const CHANNEL_ENV = "E2E_BROWSER_CHANNEL";

const BROWSER_CHANNELS = Object.freeze(["chrome", "chromium"]);

/**
 * Where Google Chrome may be: absolute files, and command names to look up on the PATH. Playwright launches `channel: "chrome"` from
 * /Applications/Google Chrome.app on macOS and /opt/google/chrome/chrome on Linux (the .deb's own path, which the commands below link to).
 *
 * @param {string} platform `process.platform`
 * @returns {string[]}
 */
function chromeCandidates(platform) {
  if (platform === "darwin") return ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"];
  if (platform === "linux") return ["google-chrome", "google-chrome-stable", "/opt/google/chrome/chrome"];
  return [];
}

/**
 * The first Chrome of `chromeCandidates` that is there, or undefined.
 *
 * @param {{ platform: string, exists: (file: string) => boolean, which: (command: string) => string | undefined }} probes
 */
function findChrome({ platform, exists, which }) {
  for (const candidate of chromeCandidates(platform)) {
    const found = path.isAbsolute(candidate) ? (exists(candidate) ? candidate : undefined) : which(candidate);
    if (found) return found;
  }
  return undefined;
}

/**
 * `command` on the PATH of `env`: the first directory that has such a file.
 *
 * @param {string} command
 * @param {{ env?: Record<string, string | undefined>, exists?: (file: string) => boolean }} [options]
 */
function whichOnPath(command, { env = process.env, exists = existsSync } = {}) {
  for (const directory of (env.PATH ?? "").split(path.delimiter)) {
    if (!directory) continue;
    const file = path.join(directory, command);
    if (exists(file)) return file;
  }
  return undefined;
}

/**
 * The channel an E2E_BROWSER_CHANNEL value names: `chrome` or `chromium` (any case, padding allowed), undefined when it is not set.
 *
 * @param {string | undefined} value
 * @returns {"chrome" | "chromium" | undefined}
 */
function parseChannel(value) {
  const text = (value ?? "").trim().toLowerCase();
  if (text === "") return undefined;
  if (text === "chrome" || text === "chromium") return text;
  throw new Error(`${CHANNEL_ENV} must be ${BROWSER_CHANNELS.map((c) => `"${c}"`).join(" or ")} (got "${(value ?? "").trim()}"): "chrome" is the Google Chrome of this machine, "chromium" the one Playwright downloads`);
}

/**
 * @typedef {{
 *   channel: "chrome" | "chromium",
 *   source: "env" | "ci" | "auto",
 *   reason: string,
 *   chromePath: string | undefined,
 *   problem?: string,
 * }} BrowserDecision `problem` is set when the decision cannot be carried out (an explicit chrome, and no Chrome here)
 */

/**
 * Which browser to run in (see the top of this file for the order).
 *
 * @param {{ env: Record<string, string | undefined>, ci: boolean, chromePath: string | undefined, platform?: string }} input
 * @returns {BrowserDecision}
 */
function decideBrowser({ env, ci, chromePath, platform = process.platform }) {
  const explicit = parseChannel(env[CHANNEL_ENV]);
  if (explicit === "chromium") return { channel: "chromium", source: "env", reason: `${CHANNEL_ENV}=chromium`, chromePath: undefined };
  if (explicit === "chrome") {
    if (chromePath) return { channel: "chrome", source: "env", reason: `${CHANNEL_ENV}=chrome`, chromePath };
    return {
      channel: "chrome",
      source: "env",
      reason: `${CHANNEL_ENV}=chrome`,
      chromePath: undefined,
      problem: `${CHANNEL_ENV}=chrome, but Google Chrome was not found on this machine (looked for ${chromeCandidates(platform).join(", ") || `nothing: ${platform} is not supported`}). Install Chrome, or run with ${CHANNEL_ENV}=chromium for the browser Playwright downloads.`,
    };
  }
  if (ci) return { channel: "chromium", source: "ci", reason: "CI: the bundled Chromium, as CI has always run", chromePath: undefined };
  if (chromePath) return { channel: "chrome", source: "auto", reason: `Google Chrome found at ${chromePath}`, chromePath };
  return { channel: "chromium", source: "auto", reason: "Google Chrome was not found on this machine: the bundled Chromium", chromePath: undefined };
}

/**
 * What a Playwright child is given to run in the browser that was decided.
 *
 * @param {{ channel: "chrome" | "chromium" }} decision
 * @returns {Record<string, string>}
 */
function browserEnv(decision) {
  return { [CHANNEL_ENV]: decision.channel };
}

/**
 * One line that says which browser a run uses: its own name and version (`<browser> --version`), the channel, and why. A browser whose
 * version cannot be read is named as it is, with the reason: this is for the log, and never fails a run.
 *
 * @param {BrowserDecision} decision
 * @param {{ run: (file: string, args: string[]) => string, bundledExecutable: string | undefined }} probes `bundledExecutable` is read
 *   only for the Chromium channel (on this machine's probes it is looked up when asked for)
 */
function describeBrowser(decision, probes) {
  const chrome = decision.channel === "chrome";
  const run = probes.run;
  const file = chrome ? decision.chromePath : probes.bundledExecutable;
  const fallbackName = chrome ? "Google Chrome" : "Chromium";
  let name;
  if (!file) {
    name = chrome ? "Google Chrome (not found)" : "Chromium (Playwright's bundled build, not installed: npx playwright install chromium)";
  } else {
    try {
      name = run(file, ["--version"]).trim().split("\n")[0].trim() || `${fallbackName} (version unknown: no output)`;
    } catch (error) {
      name = `${fallbackName} (version unknown: ${error instanceof Error ? error.message.split("\n")[0] : String(error)})`;
    }
    if (!chrome) name = `${name} (Playwright's bundled build)`;
  }
  return `${name} [channel ${decision.channel}: ${decision.reason}]`;
}

/** `<file> --version`: its output, or an error. */
function runVersion(file, args) {
  return execFileSync(file, args, { encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "pipe"] });
}

/** The executable of Playwright's bundled Chromium, or undefined when it cannot be asked (no Playwright here). */
function bundledChromiumExecutable() {
  try {
    const executable = require("@playwright/test").chromium.executablePath();
    return existsSync(executable) ? executable : undefined;
  } catch {
    return undefined;
  }
}

/** The probes of this machine: the real file system, PATH, `--version` and Playwright. */
function realProbes() {
  return {
    platform: process.platform,
    exists: existsSync,
    which: (command) => whichOnPath(command),
    run: runVersion,
    /** Looked up when asked for: the config decides without loading Playwright's own package. */
    get bundledExecutable() {
      return bundledChromiumExecutable();
    },
  };
}

/** The Google Chrome of this machine, or undefined. */
function detectChrome(probes = realProbes()) {
  return findChrome(probes);
}

/** The decision for this process: its environment, its CI flag, this machine's Chrome. */
function decideForThisProcess(env = process.env) {
  return decideBrowser({ env, ci: Boolean(env.CI), chromePath: detectChrome() });
}

module.exports = {
  CHANNEL_ENV,
  BROWSER_CHANNELS,
  chromeCandidates,
  findChrome,
  whichOnPath,
  parseChannel,
  decideBrowser,
  browserEnv,
  describeBrowser,
  realProbes,
  detectChrome,
  decideForThisProcess,
};

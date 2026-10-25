// Which Node the browser suite runs on, and one place that says so for the three places that must agree: scripts/e2e-phases.mjs,
// scripts/e2e-release.mjs and playwright.config.ts (a bare `playwright test` has neither script in front of it). Dependency-free and pure;
// unit tested in tests/unit/scripts/e2e-node.test.ts.
//
// CommonJS (.cjs) on purpose, like scripts/e2e-browser.cjs: playwright.config.ts imports it, and Playwright's loader transpiles whatever a
// config imports to CommonJS first (an imported `.mjs` then fails), while the `.mjs` scripts import a `.cjs` file as they would any module
// (scripts/e2e-node.mjs re-exports it under the name the scripts and the tests have always used).
//
// The policy (package.json `engines.node` is `>=20.9.0 <25`; `.nvmrc` says 22):
//   - SUPPORTED   Node 20.9+ (the oldest Node 20 Next 16 supports) and Node 22: what CI and the owner's checks run on;
//   - UNTESTED    Node 24 (the Active LTS, and what Playwright's Docker image ships): allowed, with a one-line warning, because nothing is known
//                 against it: the app is not tested on it by this suite;
//   - REFUSED     everything else: Node 25 and 26 (a run of the full regression tier on Node 26.3.1, the default of a Homebrew machine, stopped after
//                 its last test with every Playwright worker idle and never ended: seen four times, and once on Node 20.19.4: the watchdog is what ends such a run), the odd-numbered
//                 releases between, and anything below 20.9. Refused before anything is provisioned, with the commands that fix it.
//                 `E2E_ALLOW_UNSUPPORTED_NODE=1` is the way to try another one anyway (the stall watchdog of scripts/e2e-process.mjs still ends a
//                 run that hangs). Only the e2e guard refuses: the application itself runs on what `engines` allows.

"use strict";

/** The escape hatch: a shell value of exactly "1" lets an unsupported Node run the suite. */
const ALLOW_UNSUPPORTED_NODE = "E2E_ALLOW_UNSUPPORTED_NODE";

/**
 * `supported`, `untested` or `unsupported`. `version` is `process.versions.node` ("22.12.0") or `process.version` ("v22.12.0").
 *
 * @param {string} version
 * @returns {"supported" | "untested" | "unsupported"}
 */
function classifyNode(version) {
  const match = /^v?(\d+)\.(\d+)/.exec(String(version));
  if (!match) return "unsupported";
  const [major, minor] = [Number(match[1]), Number(match[2])];
  if (major === 22 || (major === 20 && minor >= 9)) return "supported";
  if (major === 24) return "untested";
  return "unsupported";
}

/** Node 22, or Node 20 from 20.9: the versions the suite is verified on. */
function isSupportedNode(version) {
  return classifyNode(version) === "supported";
}

/** A Node the suite lets run without the hatch: the supported ones, and Node 24 (with a warning). */
function isAllowedNode(version) {
  return classifyNode(version) !== "unsupported";
}

/**
 * Why this Node cannot run the suite, or null when it can (a supported or untested one, or the escape hatch is set). The text is the whole
 * message: the scripts print it and exit with their usage code (2); playwright.config.ts throws it.
 *
 * @param {{ node: string }} versions `process.versions`
 * @param {Record<string, string | undefined>} env the shell's environment (read before the runner drops its E2E_ names)
 * @returns {string | null}
 */
function nodeProblem(versions, env) {
  const version = versions.node;
  if (isAllowedNode(version)) return null;
  if (env[ALLOW_UNSUPPORTED_NODE] === "1") return null;
  return (
    `Node ${version} is not supported by this suite (Playwright stalled after the last test on Node 26.3.1, and Node 25+ is not verified): ` +
    "run `nvm install 22 && nvm use 22` (the .nvmrc of this checkout), or `nvm use 20` (20.9+ also works). " +
    `${ALLOW_UNSUPPORTED_NODE}=1 runs it anyway; a run that stalls is then ended by the watchdog (E2E_STALL_MS, 20 minutes by default, exit 124).`
  );
}

/**
 * The one-line warning for a Node that is allowed but not verified (24), or null.
 *
 * @param {{ node: string }} versions
 * @returns {string | null}
 */
function nodeWarning(versions) {
  return classifyNode(versions.node) === "untested"
    ? `Node ${versions.node} is untested with this suite (verified: Node 20.9+ and 22; \`nvm use 22\`): a run on it is allowed, and a hang is ended by the watchdog.`
    : null;
}

/**
 * The Node of a run as the headers of the scripts name it: `node v22.12.0`; `node v24.1.0 (untested)`; and when an unsupported one was
 * let through by the escape hatch, that it was.
 *
 * @param {{ node: string }} versions
 * @param {Record<string, string | undefined>} env
 */
function describeNode(versions, env) {
  const text = `node v${versions.node}`;
  switch (classifyNode(versions.node)) {
    case "supported":
      return text;
    case "untested":
      return `${text} (untested: the suite is verified on Node 20.9+ and 22)`;
    default:
      return env[ALLOW_UNSUPPORTED_NODE] === "1" ? `${text} (unsupported, let through by ${ALLOW_UNSUPPORTED_NODE}=1)` : text;
  }
}

module.exports = { ALLOW_UNSUPPORTED_NODE, classifyNode, isSupportedNode, isAllowedNode, nodeProblem, nodeWarning, describeNode };

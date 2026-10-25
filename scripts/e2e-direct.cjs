// What playwright.config.ts refuses when Playwright is started WITHOUT the scripts in front of it (`npm run test:e2e:raw`, `npx playwright test`).
// The release runner and the phases script check the Node (scripts/e2e-node.cjs), watch for a stall and never reuse a server; a bare
// `playwright test` does none of that, and with a dev server on :3000 it would REUSE it, and with it the database of the developer's `.env`:
// the tests create and delete rows in a database that is not theirs. So the config itself refuses, with a message that says what to run.
//
// Two refusals, both only in the process that STARTS a run (not in a Playwright worker, not for a `--list`, not under vitest, which loads
// the config to read it):
//   1. an unsupported Node (the policy of scripts/e2e-node.cjs, `E2E_ALLOW_UNSUPPORTED_NODE=1` lifts it);
//   2. no E2E_BASE_URL (so the config would start a server on :3000) while something already listens on :3000: Playwright would reuse it.
//      `E2E_ALLOW_REUSE_SERVER=1` is the deliberate way to do that, and the only way a run reuses a server at all.
//
// CommonJS for the same reason as scripts/e2e-node.cjs. Dependency-free except for that file; unit tested in tests/unit/scripts/e2e-direct.test.ts.

/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS on purpose (see above) */
"use strict";

const { spawnSync } = require("node:child_process");
const { nodeProblem, nodeWarning } = require("./e2e-node.cjs");

/** The server the config starts (and would reuse): `webServer.url`. */
const WEB_SERVER_PORT = 3000;

const REUSE_ENV = "E2E_ALLOW_REUSE_SERVER";

/**
 * Whether something accepts a TCP connection on `port` of the loopback (IPv4 or IPv6): a synchronous probe (a config is evaluated
 * synchronously), run in a tiny child so no socket of ours is left open. A probe that cannot run answers false: not knowing is not a refusal.
 *
 * @param {number} port
 * @param {{ run?: (command: string, args: string[], options: object) => { status: number | null } }} [deps]
 */
function isListeningSync(port, { run = spawnSync } = {}) {
  const source =
    "const net=require('node:net');const hosts=['127.0.0.1','::1'];let failed=0;" +
    "const fail=()=>{failed+=1;if(failed===hosts.length)process.exit(1)};" +
    `for(const host of hosts){const s=net.connect({host,port:${Number(port)}});s.setTimeout(750);` +
    "s.on('connect',()=>process.exit(0));s.on('error',fail);s.on('timeout',()=>{s.destroy();fail()})}";
  try {
    return run(process.execPath, ["-e", source], { timeout: 5000, stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
}

/**
 * Whether a run started like this would reuse a server that is already there, for the message. Pure.
 *
 * @param {{ env: Record<string, string | undefined>, listening: boolean }} input
 * @returns {string | null}
 */
function reuseProblem({ env, listening }) {
  if (env.E2E_BASE_URL) return null; // pointed at a server on purpose: nothing is started, nothing is reused
  if (env[REUSE_ENV] === "1") return null;
  if (!listening) return null;
  return (
    `something already listens on http://localhost:${WEB_SERVER_PORT}, and a run without E2E_BASE_URL would REUSE it, with the database of that server ` +
    "(your dev server's, from .env): the tests create and delete rows in it. Run `npm run test:e2e:release:smoke` / `npm run test:e2e:release` " +
    "(a throwaway database and app of their own), or point the run at a server you mean to test with E2E_BASE_URL=http://127.0.0.1:<port>, " +
    `or set ${REUSE_ENV}=1 to reuse this one on purpose.`
  );
}

/**
 * Why playwright.config.ts must refuse this process, or null. `listening` is asked only when it matters (a probe costs a process).
 *
 * @param {{ versions: { node: string }, env: Record<string, string | undefined>, argv: string[], listening?: () => boolean }} input
 * @returns {{ problem: string | null, warning: string | null }}
 */
function directRunVerdict({ versions, env, argv, listening = () => isListeningSync(WEB_SERVER_PORT) }) {
  const none = { problem: null, warning: null };
  if (env.TEST_WORKER_INDEX !== undefined) return none; // a worker: the process that started the run has decided
  if (env.VITEST) return none; // the unit tests read the config; they do not run it
  if (argv.includes("--list")) return none; // a listing starts no server and runs no test: any Node may list
  const node = nodeProblem(versions, env);
  if (node) return { problem: node, warning: null };
  const reuse = env.E2E_BASE_URL || env[REUSE_ENV] === "1" ? null : reuseProblem({ env, listening: listening() });
  if (reuse) return { problem: reuse, warning: null };
  return { problem: null, warning: nodeWarning(versions) };
}

module.exports = { WEB_SERVER_PORT, REUSE_ENV, isListeningSync, reuseProblem, directRunVerdict };

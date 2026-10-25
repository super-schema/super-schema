#!/usr/bin/env node
// The release check of the browser suite, as one command: it makes a database and an app of its own, runs a tier of the suite against
// them, and removes everything again, whether the run passed, failed, was interrupted or crashed.
//
//   node scripts/e2e-release.mjs --tier smoke|regression|nightly|serial|visual [--keep] [--reuse-build] [--shard i/n] [--project name]
//                                [--list-only] [--output-root dir] [--docker-image image] [-- playwright arguments...]
//
//   npm run test:e2e:release             --tier nightly (everything)
//   npm run test:e2e:release:smoke       --tier smoke   (the pull-request tier)
//   npm run test:e2e:release -- --tier regression --shard 2/4
//   npm run test:e2e:update-snapshots    the visual tier, its browser run inside the Playwright Docker image (scripts/e2e-update-snapshots.mjs)
//
// What a run does, in this order (docs/testing/e2e.md has the long version):
//   1. refuses when Docker is not running;
//   2. a throwaway PostgreSQL: `docker run -d --rm --name ss-e2e-<id> postgres:16` on a free loopback port, data on tmpfs, a random
//      password; waits until it accepts connections;
//   3. `prisma migrate deploy`, then `npm run db:seed` (the database is migrated and seeded before the app starts, so the app never
//      sees a half-made one; PostgreSQL has no single-process lock, unlike the embedded PGlite);
//   4. a production build, `npm run build -- --webpack` (Turbopack refuses a symlinked node_modules, which is what a worktree has),
//      unless --reuse-build finds a build in .next that was made from the same inputs (a hash of the sources, config files, lockfile,
//      public/ and the NEXT_PUBLIC_ values, kept in .next/e2e-release-build.json);
//   5. the app: `AUTH_TRUST_HOST=true next start -p <free port>` (the port is probed again just before it starts, up to three tries),
//      its log in <output root>/server.log; waits until it is ready and `/api/v1/health` answers, then checks that its sign-in URL is
//      under the run's own origin and that Google sign-in is off (a leaked AUTH_URL or GOOGLE_CLIENT_ID stops the run);
//   6. `scripts/e2e-phases.mjs <tier>` with E2E_BASE_URL pointing at that app, E2E_DATABASE_URL at that database, and an output root and
//      a login file of the run's own: the exit code of the run is that script's. The browser is decided before anything is provisioned
//      (scripts/e2e-browser.cjs: an explicit E2E_BROWSER_CHANNEL=chrome|chromium; else Chromium on CI; else Google Chrome when the machine has
//      it, else Playwright's Chromium), handed to the phases script as E2E_BROWSER_CHANNEL, and named, with its version, at the start of
//      the run and in its last line;
//   7. teardown, in the reverse order of the setup: the app (SIGTERM, SIGKILL after a grace period), the run's marker, the container
//      (`docker rm -f`; --keep leaves it and says how to connect), the temp directory. It runs in a `finally`, and on SIGINT / SIGTERM /
//      SIGHUP (exit code 128 + the signal's number).
//
// THE VISUAL TIER (`--tier visual`, with `--docker-image <image>`): steps 2 to 5 are the same, on the host; step 6 is `docker run` of that image
// (scripts/e2e-visual-docker.mjs), which runs the phases script INSIDE it, because screenshots are only compared where they were taken:
// the Playwright image's Chromium on Linux. The app and the database stay on the host. The image has to be there already (it is about
// 2 GB: `docker pull` it yourself; the runner never pulls it), and the container, `ss-e2e-visual-<id>`, is removed in the teardown.
//
// Never touched: a developer's `.env` database, `data/pglite`, a dev server on :3000 or any other port. The children get an environment
// made for them (scripts/e2e-env.mjs: every name the app reads is SET to the run's value, BLANKED as "", DROPPED, or ALLOWED on purpose;
// a name that is only missing from the shell would be filled in by the checkout's `.env`), every port is random and free at the time,
// every name carries the run's id, so two runs at the same time do not meet. The one thing two runs from one checkout share is
// `.next`: a run that would rebuild it under another run that serves from it refuses, and says so (`--reuse-build`). Two runs that
// are given the same E2E_OUTPUT_ROOT share its server.log: give each its own.
//
// Exit codes: the phases script's (0 passed, 1 a test failed ..., 124 Playwright stalled and the watchdog ended it); 2 usage (a Node
// the suite does not support among it: scripts/e2e-node.mjs); 3 the environment could not be set up (Docker, database, build, app);
// 128 + n when stopped by a signal.
//
// `planRun` (pure: arguments and environment in, a plan out) and `runRelease` (the steps, with every side effect behind `deps`) are
// unit tested with fakes: tests/unit/scripts/e2e-release.test.ts. Dependency-free: node and docker.

import { spawnSync } from "node:child_process";
import { createHash, randomBytes, randomInt } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decideBrowser, describeBrowser, detectChrome, realProbes } from "./e2e-browser.cjs";
import { hashBuildInputs } from "./e2e-build-inputs.mjs";
import { appEnvironment, hermeticEnv, phasesEnvironment, runnerKnobs } from "./e2e-env.mjs";
import { describeNode, nodeProblem } from "./e2e-node.mjs";
import { isEntryPoint, parseCli, planPhases } from "./e2e-phases.mjs";
import { dockerVisualArgs, extraMounts, updatesSnapshots, visualContainerName } from "./e2e-visual-docker.mjs";
import { SIGNALS, createInterrupt, exitCodeForSignal, killTree, parseMillis, signalGroup, spawnGroup, terminateGroup } from "./e2e-process.mjs";

/**
 * @typedef {{ command: string, args: string[], env: Record<string, string>, cwd: string }} CommandSpec
 * @typedef {{
 *   tier: string, keep: boolean, reuseBuild: boolean, listOnly: boolean, shard?: string, projects: string[], extra: string[],
 *   runId: string, containerName: string, image: string, dbPassword: string, authSecret: string, apiKey: string,
 *   root: string, tmpDir: string, outputRoot: string, serverLog: string, authState: string,
 *   baseEnv: Record<string, string>, bins: { prisma: string, next: string }, phasesArgv: string[],
 *   browser: import("./e2e-browser.cjs").BrowserDecision, nodeText: string, knobs: Record<string, string>,
 *   visual?: { image: string, containerName: string, uid: number, gid: number, platform: string, mounts: Array<{ path: string, readOnly: boolean }>, snapshotsDir: string, updateSnapshots: boolean },
 * }} FixedPlan the part of a plan that does not depend on the ports (`visual`: the browser run is a `docker run` of that image)
 * @typedef {FixedPlan & {
 *   ports: { app: number, db: number }, databaseUrl: string, baseUrl: string,
 *   env: { db: Record<string, string>, app: Record<string, string>, phases: Record<string, string> },
 *   commands: { migrate: CommandSpec, seed: CommandSpec, build: CommandSpec, server: CommandSpec, phases: CommandSpec },
 * }} RunPlan
 */

// `serial` is the phases script's tier of the same name: a login, then the `serial-after` project alone (--no-deps), with the caller's
// arguments for that last phase. It exists for the one thing the other tiers cannot select: the @slow / @external specs of
// `serial-after` without Playwright running all of `chromium` first as its dependency (the release workflow's nightly job).
export const RELEASE_TIERS = ["smoke", "regression", "nightly", "serial", "visual"];

/** 0 passed (the phases script's own codes pass through), 2 bad arguments, 3 the environment could not be set up. */
export const EXIT = { ok: 0, usage: 2, setup: 3 };

export const POSTGRES_IMAGE = "postgres:16";
export const CONTAINER_PREFIX = "ss-e2e-";
const DB_NAME = "superschema";
const DB_USER = "postgres";
/** Below Linux's ephemeral range (32768 and up), which outgoing connections take: a port picked here is not one a client socket holds. */
const PORT_RANGE = { min: 20000, max: 32000 };
/** Ports a run must never take: the dev server, PostgreSQL's own, and the block another local service uses. */
const RESERVED_PORTS = [[3000, 3000], [5432, 5432], [5380, 5410]];
const DB_READY_TIMEOUT_MS = 90_000;
const HEALTH_TIMEOUT_MS = 120_000;
const SERVER_STOP_GRACE_MS = 10_000;
const DOCKER_RM_TIMEOUT_MS = 60_000;
const CONTAINER_START_ATTEMPTS = 3;
const APP_START_ATTEMPTS = 3;
/** The app is trusted to be the one on its port when it printed "Ready" (below) or has been up this long and answers /api/v1/health. */
const READY_FALLBACK_MS = 10_000;

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.dirname(SCRIPTS_DIR);

export { HERMETIC_ALLOWED_NAMES, HERMETIC_BLANKED_NAMES, HERMETIC_DROPPED_NAMES, HERMETIC_SET_NAMES, hermeticEnv } from "./e2e-env.mjs";

export class UsageError extends Error {}
/** A step of the setup that failed for a reason the message says (as opposed to a bug of this script, which also gets a stack). */
class SetupError extends Error {}
class Interrupted extends Error {}

// ------------------------------------------------------------------------------------------------------------------------------------
// Arguments
// ------------------------------------------------------------------------------------------------------------------------------------

export const USAGE = `usage: node scripts/e2e-release.mjs --tier <${RELEASE_TIERS.join("|")}> [options] [-- playwright arguments...]

  --tier <name>        smoke (pull requests), regression (every functional spec, Chromium), nightly (everything), serial (the serial-after specs alone),
                       visual (the screenshot comparisons: needs --docker-image, or to run inside that image: npm run test:e2e:update-snapshots)
  --shard <i/n>        run slice i of n (regression is run as 4 slices in CI)
  --project <name>     narrow the tier to a Playwright project (repeatable): chromium, firefox-smoke, a11y ...
  --reuse-build        skip \`next build\` when .next was built by this runner from the same inputs (sources, config, lockfile, public/, NEXT_PUBLIC_ values)
  --keep               leave the database container running afterwards (it prints how to connect and how to remove it)
  --list-only          provision, build and start everything, but only LIST the tests of the tier (a dry run)
  --output-root <dir>  where the reports and server.log go (default: $E2E_OUTPUT_ROOT, else test-results/run-<id>)
  --docker-image <img> run the browser run inside this Docker image (the Playwright image of the installed version); the image must be local
  --help               this text

Playwright's own options (a spec file, --headed, --grep ...) go after --.`;

/**
 * @param {string[]} argv the arguments after the script name
 * @returns {{ tier: string, keep: boolean, reuseBuild: boolean, listOnly: boolean, shard?: string, projects: string[], outputRoot?: string, dockerImage?: string, extra: string[], help: boolean }}
 */
export function parseArgs(argv) {
  const out = { tier: undefined, keep: false, reuseBuild: false, listOnly: false, shard: undefined, projects: [], outputRoot: undefined, dockerImage: undefined, extra: [], help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--") {
      out.extra = argv.slice(i + 1);
      break;
    }
    const eq = arg.startsWith("--") ? arg.indexOf("=") : -1;
    const flag = eq === -1 ? arg : arg.slice(0, eq);
    const inline = eq === -1 ? undefined : arg.slice(eq + 1);
    const value = () => {
      if (inline !== undefined) return inline;
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) throw new UsageError(`${flag} needs a value`);
      i += 1;
      return next;
    };
    switch (flag) {
      case "--tier":
        out.tier = value();
        break;
      case "--shard":
        out.shard = value();
        break;
      case "--project":
        out.projects.push(value());
        break;
      case "--output-root":
        out.outputRoot = value();
        break;
      case "--docker-image":
        out.dockerImage = value();
        break;
      case "--keep":
        out.keep = true;
        break;
      case "--reuse-build":
        out.reuseBuild = true;
        break;
      case "--list-only":
        out.listOnly = true;
        break;
      case "--help":
      case "-h":
        out.help = true;
        break;
      default:
        throw new UsageError(`unknown option ${arg} (Playwright's own options go after --, e.g. -- ${arg})`);
    }
  }
  if (out.help) return out;
  if (!out.tier) throw new UsageError(`--tier is required: ${RELEASE_TIERS.join(", ")}`);
  if (!RELEASE_TIERS.includes(out.tier)) throw new UsageError(`unknown tier "${out.tier}": ${RELEASE_TIERS.join(", ")}`);
  if (out.shard !== undefined) {
    const match = /^(\d+)\/(\d+)$/.exec(out.shard);
    if (!match || Number(match[1]) < 1 || Number(match[2]) < 1 || Number(match[1]) > Number(match[2])) {
      throw new UsageError(`--shard must be i/n with 1 <= i <= n (got "${out.shard}")`);
    }
  }
  if (out.dockerImage !== undefined && !/^[\w][\w.-]*(\/[\w.-]+)*(:[\w][\w.-]*)?(@sha256:[0-9a-f]{64})?$/.test(out.dockerImage)) throw new UsageError(`--docker-image is not an image name: "${out.dockerImage}"`);
  out.projects = [...new Set(out.projects)];
  return out;
}

// ------------------------------------------------------------------------------------------------------------------------------------
// The plan: pure
// ------------------------------------------------------------------------------------------------------------------------------------

const isReserved = (port) => RESERVED_PORTS.some(([from, to]) => port >= from && port <= to);

/**
 * A port for the app and one for the database: random in the dynamic range (two runs at once almost never agree, and `freePorts` checks
 * again when the run starts), never a reserved one, never the same twice.
 *
 * @param {() => number} [next] a random port of the range (injectable)
 */
export function pickPorts(next = () => randomInt(PORT_RANGE.min, PORT_RANGE.max + 1)) {
  const one = (not) => {
    for (;;) {
      const port = next();
      if (!isReserved(port) && port !== not) return port;
    }
  };
  const app = one(undefined);
  return { app, db: one(app) };
}

/** The bin files of the tools the runner starts with node itself (no npx, no shell: a signal then reaches the tool). */
function resolveBins(root) {
  const require = createRequire(path.join(root, "package.json"));
  const bin = (pkg, name) => {
    const dir = path.dirname(require.resolve(`${pkg}/package.json`));
    const manifest = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
    return path.join(dir, typeof manifest.bin === "string" ? manifest.bin : manifest.bin[name]);
  };
  return { prisma: bin("prisma", "prisma"), next: bin("next", "next") };
}

/** A duration for a log: `1.2 s` under a minute, `1m02s` under an hour, `1h02m05s` after. */
export function formatDuration(ms) {
  const total = Math.max(0, ms);
  if (total < 60_000) return `${(total / 1000).toFixed(1)} s`;
  const seconds = Math.floor(total / 1000);
  const two = (n) => String(n).padStart(2, "0");
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m${two(seconds % 60)}s`;
  return `${Math.floor(seconds / 3600)}h${two(Math.floor((seconds % 3600) / 60))}m${two(seconds % 60)}s`;
}

/** The time of day of a log line, `HH:MM:SS`, in the machine's time zone. */
export function formatClock(date) {
  const two = (n) => String(n).padStart(2, "0");
  return `${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}`;
}

/** A step slower than this says how long it took (a quick step adds nothing to the log). */
const SLOW_STEP_MS = 2000;

/** The line after a slow step: its name, how long it took, and how old the run is, so a gap in the log has a name. */
export function stepTimingLine(name, tookMs, runAgeMs) {
  return `[e2e-release]   ... ${name}: took ${formatDuration(tookMs)} (the run is ${formatDuration(runAgeMs)} old)`;
}

/**
 * Make the run's directories: the output root (it may exist: it is where reports go) and the temp directory, which must NOT exist and which
 * is recorded in `created` once it does. `mkdir` without `recursive` fails on an existing directory, so a path that is somebody else's is never
 * adopted: the run stops with a message, and the teardown (which removes only what is in `created`) leaves it alone.
 *
 * @param {{ tmpDir: string, outputRoot: string, visual?: { snapshotsDir: string, updateSnapshots: boolean } }} plan
 * @param {Set<string>} created
 */
export function makeRunDirs(plan, created) {
  mkdirSync(plan.outputRoot, { recursive: true });
  // The snapshots directory is mounted into the container when it updates them: a mount needs it to exist (the first run makes it).
  if (plan.visual?.updateSnapshots) mkdirSync(plan.visual.snapshotsDir, { recursive: true });
  try {
    mkdirSync(plan.tmpDir, { mode: 0o700 });
  } catch (error) {
    if (/** @type {any} */ (error)?.code === "EEXIST") throw new SetupError(`the run's temp directory ${plan.tmpDir} already exists and is not this run's: not touching it`);
    throw error;
  }
  created.add(plan.tmpDir);
}

/** Remove the temp directory if, and only if, `makeRunDirs` made it. @param {{ tmpDir: string }} plan @param {Set<string>} created */
export function removeRunTmp(plan, created) {
  if (!created.has(plan.tmpDir)) return;
  rmSync(plan.tmpDir, { recursive: true, force: true });
  created.delete(plan.tmpDir);
}

/** The real path of the checkout's node_modules (a git worktree's is a symlink into another checkout), or undefined when there is none. */
function realNodeModules(root) {
  try {
    return realpathSync(path.join(root, "node_modules"));
  } catch {
    return undefined;
  }
}

/**
 * The browser run of the visual tier: `docker run` of the Playwright image, which runs the phases script in the container (it has Node
 * 24, which the Node guard does not list: scripts/e2e-visual-docker.mjs tells it so). The `docker` process gets the environment of the browser run
 * and passes the `E2E_*` names on by name, so no secret is in its arguments.
 *
 * @param {FixedPlan} fixed
 * @param {{ app: number, db: number }} ports
 * @param {Record<string, string>} phases the environment of the browser run on the host
 * @returns {CommandSpec}
 */
function visualPhasesCommand(fixed, ports, phases) {
  const visual = /** @type {NonNullable<FixedPlan["visual"]>} */ (fixed.visual);
  return {
    command: "docker",
    args: dockerVisualArgs({
      image: visual.image,
      containerName: visual.containerName,
      root: fixed.root,
      outputRoot: fixed.outputRoot,
      snapshotsDir: visual.snapshotsDir,
      updateSnapshots: visual.updateSnapshots,
      uid: visual.uid,
      gid: visual.gid,
      platform: visual.platform,
      env: phases,
      ports,
      mounts: visual.mounts,
      command: ["node", "scripts/e2e-phases.mjs", ...fixed.phasesArgv],
    }),
    env: phases,
    cwd: fixed.root,
  };
}

/**
 * Everything that depends on the ports, derived from the plan's fixed part (a run that finds a chosen port taken calls this again).
 *
 * @param {FixedPlan} fixed
 * @param {{ app: number, db: number }} ports
 * @returns {RunPlan}
 */
export function withPorts(fixed, ports) {
  const databaseUrl = `postgresql://${DB_USER}:${fixed.dbPassword}@127.0.0.1:${ports.db}/${DB_NAME}`;
  const baseUrl = `http://localhost:${ports.app}`;
  const app = appEnvironment(fixed.baseEnv, { databaseUrl, baseUrl, authSecret: fixed.authSecret, pgliteDir: path.join(fixed.tmpDir, "pglite-unused"), apiKey: fixed.apiKey });
  const phases = phasesEnvironment(fixed.baseEnv, { databaseUrl, baseUrl, outputRoot: fixed.outputRoot, authState: fixed.authState, apiKey: fixed.apiKey, browserChannel: fixed.browser.channel, knobs: fixed.knobs });
  const node = process.execPath;
  return {
    ...fixed,
    ports: { ...ports },
    databaseUrl,
    baseUrl,
    env: { db: app, app, phases },
    commands: {
      migrate: { command: node, args: [fixed.bins.prisma, "migrate", "deploy"], env: app, cwd: fixed.root },
      seed: { command: "npm", args: ["run", "db:seed"], env: app, cwd: fixed.root },
      build: { command: "npm", args: ["run", "build", "--", "--webpack"], env: app, cwd: fixed.root },
      server: { command: node, args: [fixed.bins.next, "start", "-p", String(ports.app), "-H", "127.0.0.1"], env: app, cwd: fixed.root },
      phases: fixed.visual
        ? visualPhasesCommand(fixed, ports, phases)
        : { command: node, args: [path.join(fixed.root, "scripts", "e2e-phases.mjs"), ...fixed.phasesArgv], env: phases, cwd: fixed.root },
    },
  };
}

/**
 * The plan of a run: its arguments, names, ports, places and the environment of every child. Pure but for the random numbers (the
 * options inject them) and `bins` (resolved from node_modules unless given).
 *
 * @param {string[]} argv the arguments after the script name
 * @param {Record<string, string | undefined>} [env]
 * @param {{ root?: string, tmpdir?: string, bins?: { prisma: string, next: string }, randomHex?: (bytes: number) => string, randomPort?: () => number, chromePath?: string | undefined, nodeVersions?: { node: string }, platform?: string, uid?: number, gid?: number, nodeModulesTarget?: string | undefined }} [options]
 *   `chromePath` is the Google Chrome of the machine (the key present with `undefined`: there is none); the machine is asked when it is not given.
 *   `nodeVersions` is this process's `process.versions` unless a test says another Node
 * @returns {RunPlan}
 */
export function planRun(argv, env = process.env, options = {}) {
  const args = parseArgs(argv);
  const root = options.root ?? REPO_ROOT;
  const randomHex = options.randomHex ?? ((bytes) => randomBytes(bytes).toString("hex"));
  const runId = randomHex(4);
  const outputRoot = path.resolve(args.outputRoot ?? env.E2E_OUTPUT_ROOT ?? path.join(root, "test-results", `run-${runId}`));
  // The browser run of the visual tier is in a container that sees the checkout and nothing else of the host: the login file lives under the output root.
  const tmpDir = args.dockerImage ? path.join(outputRoot, `tmp-${runId}`) : path.join(options.tmpdir ?? os.tmpdir(), `${CONTAINER_PREFIX}${runId}`);
  const baseEnv = hermeticEnv(env);
  if (args.tier === "visual" && !args.dockerImage && env.E2E_VISUAL_IN_DOCKER !== "1") {
    throw new UsageError(
      "the visual tier takes and compares screenshots only inside the Playwright Docker image (macOS and Linux render the same page differently): run it with npm run test:e2e:update-snapshots (it passes --docker-image), or run the release runner itself inside the image with E2E_VISUAL_IN_DOCKER=1",
    );
  }
  // The Node and the runner's knobs, before anything else is decided or provisioned. A listing runs no test and cannot stall: any Node may list.
  const nodeVersions = options.nodeVersions ?? process.versions;
  const problem = args.listOnly ? null : nodeProblem(nodeVersions, env);
  if (problem) throw new UsageError(problem);
  try {
    for (const name of ["E2E_STALL_MS", "E2E_GLOBAL_TIMEOUT_MS"]) parseMillis(name, env[name]);
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
  // The browser is decided here, once, before anything is provisioned: an explicit chrome that this machine cannot give is a usage error
  // (not a run that fails at its last step), and every later step reads the same decision.
  let browser;
  if (args.dockerImage) {
    // Not the host's: the image's own bundled Chromium, whatever E2E_BROWSER_CHANNEL or the machine's Google Chrome say.
    browser = { channel: "chromium", source: "env", reason: `the bundled Chromium of ${args.dockerImage}`, chromePath: undefined };
  } else {
    try {
      browser = decideBrowser({ env, ci: Boolean(env.CI), chromePath: "chromePath" in options ? options.chromePath : detectChrome() });
    } catch (error) {
      throw new UsageError(error instanceof Error ? error.message : String(error));
    }
    if (browser.problem) throw new UsageError(browser.problem);
  }
  const phasesArgv = [
    args.tier,
    ...(args.shard ? [`--shard=${args.shard}`] : []),
    ...args.projects.map((name) => `--project=${name}`),
    ...(args.listOnly ? ["--list"] : []),
    ...args.extra,
  ];
  // Before anything is provisioned: a tier that the options leave with no phase (--project of none of its projects) is a usage error.
  const planned = planPhases({ ...parseCli(phasesArgv), authState: "", outputRoot });
  if (planned.phases.length === 0) throw new UsageError(`nothing to run: ${planned.skipped.join("; ")}`);
  const fixed = {
    tier: args.tier,
    keep: args.keep,
    reuseBuild: args.reuseBuild,
    listOnly: args.listOnly,
    shard: args.shard,
    projects: args.projects,
    extra: args.extra,
    runId,
    containerName: `${CONTAINER_PREFIX}${runId}`,
    image: POSTGRES_IMAGE,
    dbPassword: randomHex(16),
    authSecret: randomHex(32),
    apiKey: randomHex(24),
    root,
    tmpDir,
    outputRoot,
    serverLog: path.join(outputRoot, "server.log"),
    authState: path.join(tmpDir, "admin.json"),
    baseEnv,
    bins: options.bins ?? resolveBins(root),
    phasesArgv,
    browser,
    nodeText: describeNode(nodeVersions, env),
    knobs: runnerKnobs(env),
    ...(args.dockerImage
      ? {
          visual: {
            image: args.dockerImage,
            containerName: visualContainerName(randomHex(4)),
            uid: options.uid ?? process.getuid?.() ?? 1000,
            gid: options.gid ?? process.getgid?.() ?? 1000,
            platform: options.platform ?? process.platform,
            mounts: extraMounts({ root, nodeModulesTarget: "nodeModulesTarget" in options ? options.nodeModulesTarget : realNodeModules(root) }),
            snapshotsDir: path.join(root, "tests", "e2e", "visual.spec.ts-snapshots"),
            updateSnapshots: updatesSnapshots(args.extra),
          },
        }
      : {}),
  };
  return withPorts(fixed, pickPorts(options.randomPort));
}

/**
 * The arguments of `docker run` for the run's database. The password is not among them (see `dockerRunEnv`).
 *
 * @param {RunPlan} plan
 * @returns {string[]}
 */
export function dockerRunArgs(plan) {
  return [
    "run", "-d", "--rm",
    "--name", plan.containerName,
    "--label", "ss-e2e=1",
    "--label", `ss-e2e-run=${plan.runId}`,
    "--tmpfs", "/var/lib/postgresql/data",
    "-e", "POSTGRES_PASSWORD",
    "-e", `POSTGRES_DB=${DB_NAME}`,
    "-p", `127.0.0.1:${plan.ports.db}:5432`,
    plan.image,
    // A database that lives for one run: no fsync, and room for the connections of the app, the workers and the specs.
    "-c", "fsync=off", "-c", "synchronous_commit=off", "-c", "full_page_writes=off", "-c", "max_connections=300",
  ];
}

/**
 * The environment of `docker run`: `-e POSTGRES_PASSWORD` takes the value from here, so it never shows in a process list.
 *
 * @param {RunPlan} plan
 */
export function dockerRunEnv(plan) {
  return { ...process.env, POSTGRES_PASSWORD: plan.dbPassword };
}

// ------------------------------------------------------------------------------------------------------------------------------------
// The build: reuse, and sharing .next between runs. Pure decisions
// ------------------------------------------------------------------------------------------------------------------------------------

/**
 * Whether the build in .next can be used again: only when it was made by this runner from the same inputs (`hashBuildInputs`: the
 * content of the sources, the config files, the lockfile, public/, the NEXT_PUBLIC_ values and the build mode). Nothing here is a guess:
 * --reuse-build is the caller's request, and each of the other conditions has a reason that is printed.
 *
 * @param {{ reuseBuild: boolean, hasBuild: boolean, stamp?: { inputsHash?: string }, inputsHash: string }} input
 * @returns {{ reuse: boolean, reason: string }}
 */
export function decideBuild({ reuseBuild, hasBuild, stamp, inputsHash }) {
  if (!reuseBuild) return { reuse: false, reason: "no --reuse-build: always a fresh build" };
  if (!hasBuild) return { reuse: false, reason: ".next has no finished build (no BUILD_ID)" };
  if (!stamp) return { reuse: false, reason: "the build in .next was not made by this runner (no e2e-release stamp)" };
  if (!stamp.inputsHash) return { reuse: false, reason: "the stamp of the build in .next is from an older runner (no hash of its inputs)" };
  if (stamp.inputsHash !== inputsHash) return { reuse: false, reason: "an input of the build changed since the one in .next was made (a source, config file, the lockfile, public/ or a NEXT_PUBLIC_ value)" };
  return { reuse: true, reason: ".next was built by this runner from the same inputs (sources, config, lockfile, public/, NEXT_PUBLIC_ values, build mode)" };
}

/**
 * Two runs from one checkout share `.next`: a rebuild under a server that reads from it breaks that server, and a build in progress is
 * not a build. Returns why this run must not go on, or null.
 *
 * @param {Array<{ runId: string, pid: number, state: string }>} others the other live runs of this checkout
 * @param {{ willBuild: boolean }} input
 */
export function buildConflict(others, { willBuild }) {
  const building = others.find((run) => run.state === "building");
  if (building) {
    return `another release run (pid ${building.pid}) is building .next in this checkout; wait for it to finish (or run from another checkout / worktree)`;
  }
  const serving = others.find((run) => run.state === "serving");
  if (serving && willBuild) {
    return `another release run (pid ${serving.pid}) is serving .next in this checkout, and a rebuild would break it. Wait for it, use --reuse-build to share its build, or run from another checkout / worktree`;
  }
  return null;
}

// ------------------------------------------------------------------------------------------------------------------------------------
// The run: steps and teardown, every side effect behind `deps`
// ------------------------------------------------------------------------------------------------------------------------------------

/**
 * How to reach the database a --keep run left behind, and how to get rid of it.
 *
 * @param {RunPlan} plan
 */
function keepInstructions(plan) {
  return [
    `[e2e-release] --keep: the database container ${plan.containerName} is still running`,
    `[e2e-release]   connect:  psql "${plan.databaseUrl}"`,
    `[e2e-release]       or:   docker exec -it ${plan.containerName} psql -U ${DB_USER} ${DB_NAME}`,
    `[e2e-release]   remove:   docker rm -f ${plan.containerName}     (all leftovers: docker ps --filter name=${CONTAINER_PREFIX})`,
    `[e2e-release]   the seeded admin: admin@admin.com / admin`,
  ];
}

/**
 * Runs the steps of a release run and tears everything down again. Each step that makes something registers how to undo it at once; the
 * undo steps run in reverse order in a `finally`, so a failing step, a failing run and a signal all end in the same teardown. A signal
 * (any of SIGINT / SIGTERM / SIGHUP; the first is the one reported) stops the step in progress through the abort signal handed to it,
 * lets no further step start, and exits 128 + its number after the teardown.
 *
 * @param {RunPlan} initialPlan
 * @param {any} deps the side effects, as `createRealDeps` returns them (log, error, onSignal, checkDocker, makeDirs, removeTmp,
 *   freePorts, startContainer, removeContainer, waitForDb, exec, buildDecision, buildConflict, registerRun, writeBuildStamp,
 *   freeAppPort, startServer, waitForHealth, verifyApp, runPhases, describeBrowser); the unit tests give fakes
 * @returns {Promise<number>} the exit code
 */
export async function runRelease(initialPlan, deps) {
  let plan = initialPlan;
  /** @type {Array<{ name: string, undo: () => Promise<void> | void, hint?: () => string }>} */
  const undo = [];
  /** Teardown steps that failed: said again in the last line, whatever the run's own result was. */
  const leftovers = [];
  const abort = new AbortController();
  let received;
  const stopListening = deps.onSignal((signal) => {
    if (received) return; // the first one decides; a second one is the step's business (it kills what runs), not another teardown
    received = signal;
    deps.log(`[e2e-release] ${signal}: stopping. The step in progress is asked to stop and the teardown runs after it; send the signal again to end the step at once (the teardown still runs)`);
    abort.abort();
  });
  const ctx = { signal: abort.signal };
  const checkpoint = () => {
    if (received) throw new Interrupted(received);
  };
  const now = deps.now ?? Date.now;
  const startedAt = now();
  const step = async (name, fn) => {
    checkpoint();
    deps.log(`[e2e-release] ${name}`);
    const began = now();
    try {
      return await fn();
    } finally {
      const took = now() - began;
      if (took >= SLOW_STEP_MS) deps.log(stepTimingLine(name, took, now() - startedAt));
    }
  };

  let code = EXIT.setup;
  let madeDirs = false;
  /** Which browser the run uses, with its version: named at the start and in the last line (undefined until it is asked for). */
  let browserText;
  try {
    await step("checking that Docker is running", async () => {
      const docker = await deps.checkDocker();
      if (!docker.ok) throw new SetupError(docker.message ?? "Docker is not running");
    });
    deps.log(`[e2e-release] run ${plan.runId}: tier ${plan.tier}${plan.listOnly ? " (list only)" : ""}; reports and server.log will be in ${plan.outputRoot}`);
    // Never fails the run: a browser whose `--version` cannot be read is said so, and Playwright says the rest when it launches it.
    try {
      browserText = await deps.describeBrowser(plan);
    } catch (error) {
      browserText = `unknown (${error instanceof Error ? error.message : String(error)})`;
    }
    deps.log(`[e2e-release] ${plan.nodeText}`);
    deps.log(`[e2e-release] browser: ${browserText}`);

    if (plan.visual) {
      const visual = plan.visual;
      await step(`checking that the Playwright image ${visual.image} is here`, async () => {
        const image = await deps.checkVisualImage(visual.image);
        if (!image.ok) throw new SetupError(image.message ?? `the image ${visual.image} is not here`);
      });
      // The container of the browser run is removed at the end whatever happened: `--rm` does it when it ends by itself.
      undo.push({ name: `remove the container ${visual.containerName}`, undo: () => deps.removeVisualContainer(visual.containerName), hint: () => `docker rm -f ${visual.containerName}` });
    }
    undo.push({ name: "remove the temp directory", undo: () => deps.removeTmp(plan), hint: () => `rm -rf ${plan.tmpDir}` });
    await step("making the run's directories", () => deps.makeDirs(plan));
    madeDirs = true;

    plan = await step("choosing free ports", async () => {
      const ports = await deps.freePorts(plan.ports);
      return ports.app === plan.ports.app && ports.db === plan.ports.db ? plan : withPorts(plan, ports);
    });

    // Registered before `docker run`: a run that is interrupted while the container is being created must still remove it.
    undo.push(
      plan.keep
        ? { name: "keep the database container", undo: () => keepInstructions(plan).forEach((line) => deps.log(line)) }
        : { name: `remove the container ${plan.containerName}`, undo: () => deps.removeContainer(plan), hint: () => `docker rm -f ${plan.containerName}` },
    );
    await step(`starting ${plan.image} as ${plan.containerName} on 127.0.0.1:${plan.ports.db}`, async () => {
      for (let attempt = 1; ; attempt += 1) {
        const started = await deps.startContainer(plan);
        if (started.ok) return;
        if (!started.portInUse || attempt >= CONTAINER_START_ATTEMPTS) throw new SetupError(`could not start the database container: ${started.message ?? "docker run failed"}`);
        deps.log(`[e2e-release] database port ${plan.ports.db} is taken, choosing another`);
        await deps.removeContainer(plan);
        plan = withPorts(plan, await deps.freePorts({ app: plan.ports.app, db: pickPorts().db }));
      }
    });
    await step("waiting for the database", () => deps.waitForDb(plan, ctx));

    const exec = async (label, text) => {
      await step(text, async () => {
        const exit = await deps.exec(label, plan.commands[label], ctx);
        checkpoint();
        if (exit !== 0) throw new SetupError(`${label} failed (exit ${exit})`);
      });
    };
    await exec("migrate", "prisma migrate deploy");
    await exec("seed", "npm run db:seed");

    const decision = deps.buildDecision(plan);
    const conflict = deps.buildConflict(plan, { willBuild: !decision.reuse });
    if (conflict) throw new SetupError(conflict);
    const run = await deps.registerRun(plan, decision.reuse ? "serving" : "building");
    undo.push({ name: "unregister the run", undo: () => run.unregister() });
    if (decision.reuse) {
      deps.log(`[e2e-release] build: reusing .next (${decision.reason})`);
    } else {
      deps.log(`[e2e-release] build: building (${decision.reason})`);
      await exec("build", "building the app: npm run build -- --webpack (minutes)");
      // The hash of the inputs as they were BEFORE the build: an input changed during the build makes the next run build again.
      await deps.writeBuildStamp(plan, decision.inputsHash);
    }
    run.setState("serving");

    // The build took minutes: the app's port is probed again now, and a port that is taken between the probe and the bind (another run, any
    // program) is a second try on another port, up to three, not a failed run.
    for (let attempt = 1; ; attempt += 1) {
      plan = await step("choosing the app's port (probed again, after the build)", async () =>
        withPorts(plan, { app: await deps.freeAppPort(plan.ports.app, plan.ports.db), db: plan.ports.db }),
      );
      const server = await step(`starting the app on ${plan.baseUrl} (log: ${plan.serverLog})`, () => deps.startServer(plan));
      const entry = {
        name: "stop the app",
        undo: () => server.stop(),
        hint: () => `stop the process that listens on port ${plan.ports.app}: lsof -ti tcp:${plan.ports.app} | xargs kill`,
      };
      undo.push(entry);
      try {
        await step("waiting until the app is ready and /api/v1/health answers", () => deps.waitForHealth(plan, server, ctx));
        const verdict = await step("checking the app's sign-in origin and providers", () => deps.verifyApp(plan, server, ctx));
        if (!verdict.ok) throw new SetupError(verdict.message ?? "the app is not the one that was configured");
        break;
      } catch (error) {
        const portTaken = error instanceof Error && /** @type {any} */ (error).portInUse === true;
        if (!portTaken || attempt >= APP_START_ATTEMPTS || received) throw error;
        deps.log(`[e2e-release] port ${plan.ports.app} was taken before the app could bind it (attempt ${attempt} of ${APP_START_ATTEMPTS}), choosing another`);
        undo.splice(undo.indexOf(entry), 1);
        await server.stop();
      }
    }

    code = await step(
      `running the ${plan.tier} tier${plan.listOnly ? " (list only)" : ""}${plan.visual ? ` in ${plan.visual.image} as ${plan.visual.containerName}` : ""}: node scripts/e2e-phases.mjs ${plan.phasesArgv.join(" ")}`,
      () => deps.runPhases(plan, ctx),
    );
  } catch (error) {
    if (!received) {
      if (error instanceof SetupError) deps.error(`[e2e-release] ${error.message}`);
      else deps.error(`[e2e-release] ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
      code = EXIT.setup;
    }
  } finally {
    while (undo.length > 0) {
      const { name, undo: run, hint } = undo.pop();
      deps.log(`[e2e-release] teardown: ${name}`);
      try {
        await run();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        deps.error(`[e2e-release] teardown: ${name} failed: ${message}`);
        leftovers.push(`${name} failed (${message})${hint ? `: by hand, ${hint()}` : ""}`);
      }
    }
    stopListening();
  }

  const final = received ? exitCodeForSignal(received) : code;
  deps.log(
    `[e2e-release] done: exit ${final}${received ? ` (${received})` : ""} in ${formatDuration(now() - startedAt)}${madeDirs ? `; reports and server.log: ${plan.outputRoot}` : ""}${browserText ? `; browser: ${browserText}` : ""}` +
      (leftovers.length > 0 ? `; TEARDOWN INCOMPLETE: ${leftovers.join("; ")} (leftovers of any run: docker ps -a --filter name=${CONTAINER_PREFIX})` : ""),
  );
  return final;
}

/**
 * Whether the app that answered is the one the run configured, judged from what Auth.js lists at `/api/auth/providers` (the sign-in and
 * callback URLs it builds from its own AUTH_URL / NEXTAUTH_URL, and the providers that are switched on). A URL under another origin means
 * an AUTH_URL of a `.env` or a shell got through; a Google provider means GOOGLE_CLIENT_ID did. Pure.
 *
 * @param {unknown} providers the parsed JSON
 * @param {string} baseUrl the run's origin, `http://localhost:<port>`
 * @returns {{ ok: true } | { ok: false, message: string }}
 */
export function judgeProviders(providers, baseUrl) {
  if (!providers || typeof providers !== "object" || Array.isArray(providers) || Object.keys(providers).length === 0) {
    return { ok: false, message: `the app's /api/auth/providers is not a list of providers (${JSON.stringify(providers)?.slice(0, 120)})` };
  }
  const entries = Object.entries(/** @type {Record<string, { signinUrl?: unknown, callbackUrl?: unknown }>} */ (providers));
  if (entries.some(([id]) => id.toLowerCase() === "google")) {
    return { ok: false, message: "the app offers Google sign-in: a GOOGLE_CLIENT_ID reached it, and the release run is checked with the seeded admin only" };
  }
  for (const [id, provider] of entries) {
    for (const key of ["signinUrl", "callbackUrl"]) {
      const url = provider?.[key];
      if (typeof url !== "string" || !url.startsWith(`${baseUrl}/`)) {
        return { ok: false, message: `the app's ${id} ${key} is "${String(url)}", not under ${baseUrl}: an AUTH_URL / NEXTAUTH_URL of the shell or a .env reached the app, and its logins would go to another server` };
      }
    }
  }
  return { ok: true };
}

// ------------------------------------------------------------------------------------------------------------------------------------
// The side effects
// ------------------------------------------------------------------------------------------------------------------------------------

const sleep = (ms, signal) =>
  new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });

/** Whether `port` can be bound on `host` (every address when `host` is undefined): bound and released at once. */
function canBind(port, host) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen(host === undefined ? { port } : { port, host }, () => server.close(() => resolve(true)));
  });
}

/** Whether a TCP connection to the port is accepted. */
function canConnect(host, port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    socket.setTimeout(2000);
    socket.once("connect", () => (socket.destroy(), resolve(true)));
    socket.once("timeout", () => (socket.destroy(), resolve(false)));
    socket.once("error", () => resolve(false));
  });
}

/**
 * Whether nothing listens on `port` where the run will bind it: the app and the database container both bind 127.0.0.1. A bind of
 * every address alone is not enough (on macOS it succeeds next to a listener on 127.0.0.1: found with a real probe), so a connection to
 * loopback, a bind of 127.0.0.1 and a bind of every address must all say "free".
 */
async function isPortFree(port) {
  if (await canConnect("127.0.0.1", port)) return false;
  return (await canBind(port, "127.0.0.1")) && (await canBind(port, undefined));
}

const tail = (file, lines = 25) => {
  try {
    return readFileSync(file, "utf8").trimEnd().split("\n").slice(-lines).join("\n");
  } catch {
    return "(no log)";
  }
};

const readJson = (file) => {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
};

/** The other runs of this checkout that are alive (a marker whose process is gone is removed). */
function liveRuns(root, ownRunId) {
  const dir = markerDir(root);
  const live = [];
  let names = [];
  try {
    names = readdirSync(dir);
  } catch {
    return live;
  }
  for (const name of names) {
    const file = path.join(dir, name);
    const marker = readJson(file);
    let alive = false;
    try {
      if (marker?.pid) {
        process.kill(marker.pid, 0);
        alive = true;
      }
    } catch (error) {
      alive = error?.code === "EPERM";
    }
    if (!alive) rmSync(file, { force: true });
    else if (marker.runId !== ownRunId) live.push(marker);
  }
  return live;
}

const markerDir = (root) => path.join(os.tmpdir(), "ss-e2e-release", createHash("sha1").update(root).digest("hex").slice(0, 12));

/**
 * The real side effects of `runRelease`. Children are started as leaders of their own process groups (scripts/e2e-process.mjs): the first
 * signal this process gets is forwarded once to the step in progress, a second one kills it; the teardown's own children (docker, the
 * app's stop) are not forwarded to, so a second Ctrl-C cannot leave a container behind.
 */
export function createRealDeps({ log: write = console.log, error: writeError = console.error } = {}) {
  // Every line carries the time of day it was written at: with the duration lines of the slow steps, a hole in the log of a run has a name.
  const log = (message) => write(`${formatClock(new Date())} ${message}`);
  const error = (message) => writeError(`${formatClock(new Date())} ${message}`);
  /** The children a signal is forwarded to: the step in progress. */
  const running = new Set();
  const interrupt = createInterrupt({
    forward: (signal) => running.forEach((child) => signalGroup(child, signal)),
    // The phases script and the Playwright it starts each lead a group of their own: ending the step takes the whole tree.
    force: () =>
      running.forEach((child) => {
        if (child.pid !== undefined) killTree(child.pid);
        signalGroup(child, "SIGKILL");
      }),
    graceMs: 60_000,
  });
  /** What a crash must still clean up synchronously (process 'exit'): the app's group and a container that is not kept. */
  const live = { container: undefined, server: undefined, visual: undefined };
  /** The directories this run made itself: the only ones its teardown may remove. */
  const createdDirs = new Set();
  process.on("exit", () => {
    if (live.server?.pid) signalGroup(live.server, "SIGKILL");
    if (live.container) spawnSync("docker", ["rm", "-f", live.container], { stdio: "ignore", timeout: 30_000 });
    if (live.visual) spawnSync("docker", ["rm", "-f", live.visual], { stdio: "ignore", timeout: 30_000 });
  });

  /** A step that shows its output, and that a signal reaches. */
  const runStep = (spec) =>
    new Promise((resolve) => {
      const child = spawnGroup(spec.command, spec.args, { cwd: spec.cwd, env: spec.env, stdio: "inherit" });
      running.add(child);
      if (interrupt.interrupted) signalGroup(child, interrupt.signal);
      child.on("error", (e) => {
        running.delete(child);
        error(`[e2e-release] could not start ${spec.command}: ${e.message}`);
        resolve(1);
      });
      child.on("exit", (code, signal) => {
        running.delete(child);
        resolve(code ?? exitCodeForSignal(signal ?? "SIGTERM"));
      });
    });

  /** A short command whose output is wanted (docker); not forwarded to, and ended after `timeoutMs`. */
  const capture = (command, args, { env = process.env, timeoutMs = 60_000 } = {}) =>
    new Promise((resolve) => {
      let stdout = "";
      let stderr = "";
      const child = spawnGroup(command, args, { env, stdio: ["ignore", "pipe", "pipe"] });
      const timer = setTimeout(() => void terminateGroup(child, { graceMs: 2000 }), timeoutMs);
      child.stdout.on("data", (chunk) => (stdout = (stdout + chunk).slice(-65_536)));
      child.stderr.on("data", (chunk) => (stderr = (stderr + chunk).slice(-65_536)));
      child.on("error", (e) => {
        clearTimeout(timer);
        resolve({ code: e.code === "ENOENT" ? 127 : 1, stdout, stderr: `${stderr}${e.message}` });
      });
      child.on("close", (code, signal) => {
        clearTimeout(timer);
        resolve({ code: code ?? exitCodeForSignal(signal ?? "SIGTERM"), stdout, stderr });
      });
    });

  return {
    log,
    error,

    onSignal(handler) {
      const listeners = SIGNALS.map((signal) => {
        const listener = () => {
          interrupt.handle(signal);
          handler(signal);
        };
        process.on(signal, listener);
        return [signal, listener];
      });
      return () => {
        interrupt.done();
        for (const [signal, listener] of listeners) process.off(signal, listener);
      };
    },

    async checkDocker() {
      const info = await capture("docker", ["info", "--format", "{{.ServerVersion}}"], { timeoutMs: 20_000 });
      if (info.code === 0) return { ok: true };
      if (info.code === 127) return { ok: false, message: "Docker is not installed or not on the PATH (the `docker` command was not found): the release run needs Docker for its throwaway database." };
      const reason = info.stderr.trim().split("\n").filter(Boolean).pop() ?? `exit ${info.code}`;
      return { ok: false, message: `Docker is not running (\`docker info\` failed: ${reason}). Start Docker Desktop (or the Docker daemon, colima ...) and run this again: the release run needs it for its throwaway database.` };
    },

    makeDirs: (plan) => makeRunDirs(plan, createdDirs),
    removeTmp: (plan) => removeRunTmp(plan, createdDirs),

    async freePorts(ports) {
      const take = async (preferred, other) => {
        let port = preferred;
        for (let tries = 0; tries < 50 && (port === other || !(await isPortFree(port))); tries += 1) port = pickPorts().app;
        return port;
      };
      const app = await take(ports.app, undefined);
      return { app, db: await take(ports.db, app) };
    },

    /** The app's port alone (the database's is held by the running container): `preferred` when nothing listens on it now, else another free one. */
    async freeAppPort(preferred, dbPort) {
      let port = preferred;
      for (let tries = 0; tries < 50 && (port === dbPort || !(await isPortFree(port))); tries += 1) port = pickPorts().app;
      return port;
    },

    async startContainer(plan) {
      live.container = plan.keep ? undefined : plan.containerName;
      const present = await capture("docker", ["image", "inspect", plan.image], { timeoutMs: 30_000 });
      if (present.code !== 0) {
        log(`[e2e-release] pulling ${plan.image} (first run on this machine)`);
        const pulled = await runStep({ command: "docker", args: ["pull", plan.image], env: process.env });
        if (pulled !== 0) return { ok: false, message: `docker pull ${plan.image} failed (exit ${pulled})` };
      }
      const result = await capture("docker", dockerRunArgs(plan), { env: dockerRunEnv(plan), timeoutMs: 120_000 });
      if (result.code === 0) return { ok: true };
      const message = result.stderr.trim().split("\n").filter(Boolean).pop() ?? `exit ${result.code}`;
      return { ok: false, portInUse: /port is already allocated|address already in use|ports are not available|bind for/i.test(result.stderr), message };
    },
    async removeContainer(plan) {
      const result = await capture("docker", ["rm", "-f", plan.containerName], { timeoutMs: DOCKER_RM_TIMEOUT_MS });
      if (result.code !== 0 && !/no such container/i.test(result.stderr)) throw new Error(`docker rm -f ${plan.containerName} failed: ${result.stderr.trim()}`);
      live.container = undefined;
    },

    async waitForDb(plan, { signal }) {
      const deadline = Date.now() + DB_READY_TIMEOUT_MS;
      let last = "";
      while (Date.now() < deadline) {
        if (signal.aborted) return;
        // `-h 127.0.0.1`: the TCP server, not the unix socket of the temporary server the image starts first to initialise the data.
        const ready = await capture("docker", ["exec", plan.containerName, "pg_isready", "-h", "127.0.0.1", "-U", DB_USER, "-d", DB_NAME], { timeoutMs: 15_000 });
        if (ready.code === 0 && (await canConnect("127.0.0.1", plan.ports.db))) return;
        last = (ready.stdout + ready.stderr).trim().split("\n").pop() ?? "";
        if (/no such container|is not running/i.test(ready.stderr)) throw new SetupError(`the database container stopped: ${last}`);
        await sleep(500, signal);
      }
      throw new SetupError(`the database did not accept connections within ${DB_READY_TIMEOUT_MS / 1000} s (${last || "no answer"})`);
    },

    exec: (_label, spec) => runStep(spec),
    runPhases: (plan) => {
      if (plan.visual) live.visual = plan.visual.containerName;
      return runStep(plan.commands.phases);
    },
    describeBrowser: (plan) => (plan.visual ? `Chromium of ${plan.visual.image} (in Docker, on Linux)` : describeBrowser(plan.browser, realProbes())),

    /** The Playwright image has to be local: it is about 2 GB, and a run that pulls it on its own is a surprise nobody asked for. */
    async checkVisualImage(image) {
      const present = await capture("docker", ["image", "inspect", image], { timeoutMs: 30_000 });
      if (present.code === 0) return { ok: true };
      return { ok: false, message: `the Playwright image ${image} is not on this machine. It is about 2 GB, so the runner does not pull it for you: docker pull ${image}` };
    },
    async removeVisualContainer(name) {
      const result = await capture("docker", ["rm", "-f", name], { timeoutMs: DOCKER_RM_TIMEOUT_MS });
      if (result.code !== 0 && !/no such container/i.test(result.stderr)) throw new Error(`docker rm -f ${name} failed: ${result.stderr.trim()}`);
      live.visual = undefined;
    },

    buildDecision(plan) {
      const nextDir = path.join(plan.root, ".next");
      const buildId = path.join(nextDir, "BUILD_ID");
      const hasBuild = existsSync(buildId);
      // The hash of the inputs NOW, before anything is built: it is what the stamp of a build made by this run records.
      const inputsHash = hashBuildInputs({ root: plan.root, env: plan.baseEnv });
      return { ...decideBuild({ reuseBuild: plan.reuseBuild, hasBuild, stamp: readJson(path.join(nextDir, "e2e-release-build.json")), inputsHash }), inputsHash };
    },
    buildConflict: (plan, { willBuild }) => buildConflict(liveRuns(plan.root, plan.runId), { willBuild }),
    registerRun(plan, state) {
      const dir = markerDir(plan.root);
      mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${plan.runId}.json`);
      const write = (s) => writeFileSync(file, JSON.stringify({ runId: plan.runId, pid: process.pid, state: s, port: plan.ports.app, startedAt: new Date().toISOString() }));
      write(state);
      return { setState: write, unregister: () => rmSync(file, { force: true }) };
    },
    /** Records the build's inputs, unless they changed while it was built (then the next run builds again, which is the safe side). */
    writeBuildStamp(plan, inputsHash) {
      if (hashBuildInputs({ root: plan.root, env: plan.baseEnv }) !== inputsHash) {
        log("[e2e-release] build: an input changed while it was built; the build is not recorded for reuse");
        return false;
      }
      writeFileSync(path.join(plan.root, ".next", "e2e-release-build.json"), JSON.stringify({ inputsHash, mode: "webpack", runId: plan.runId, builtAt: new Date().toISOString() }));
      return true;
    },

    startServer(plan) {
      const spec = plan.commands.server;
      const logOffset = existsSync(plan.serverLog) ? statSync(plan.serverLog).size : 0; // a retry appends to the log of the attempt before it
      const fd = openSync(plan.serverLog, "a");
      let child;
      try {
        child = spawnGroup(spec.command, spec.args, { cwd: spec.cwd, env: spec.env, stdio: ["ignore", fd, fd] });
      } finally {
        closeSync(fd);
      }
      live.server = child;
      const server = {
        child,
        logOffset,
        startedAt: Date.now(),
        hasExited: false,
        exitCode: undefined,
        exited: new Promise((resolve) => {
          child.once("error", (e) => {
            server.hasExited = true;
            server.exitCode = 1;
            server.spawnError = e.message;
            resolve();
          });
          child.once("exit", (code, signal) => {
            server.hasExited = true;
            server.exitCode = code ?? exitCodeForSignal(signal ?? "SIGTERM");
            resolve();
          });
        }),
        async stop() {
          await terminateGroup(child, { graceMs: SERVER_STOP_GRACE_MS });
          live.server = undefined;
        },
      };
      return server;
    },

    /**
     * Waits until THIS app is ready and answers /api/v1/health. Its own "Ready" line comes first (an app that could not bind its port exits
     * without it, and a health answer from another program on that port is not ours); an app that is still silent after READY_FALLBACK_MS
     * but answers is trusted. A start that died because the port is taken throws an error with `portInUse`.
     */
    async waitForHealth(plan, server, { signal }) {
      const url = `${plan.baseUrl}/api/v1/health`;
      const ownLog = () => {
        try {
          return readFileSync(plan.serverLog, "utf8").slice(server.logOffset);
        } catch {
          return "";
        }
      };
      const deadline = Date.now() + HEALTH_TIMEOUT_MS;
      let last = "no answer";
      while (Date.now() < deadline) {
        if (signal.aborted) return;
        if (server.hasExited) {
          const log = ownLog();
          throw Object.assign(
            new SetupError(`the app exited (code ${server.exitCode}${server.spawnError ? `, ${server.spawnError}` : ""}) before ${url} answered. Last lines of ${plan.serverLog}:\n${tail(plan.serverLog)}`),
            { portInUse: /EADDRINUSE|address already in use/i.test(log) },
          );
        }
        if (/\bReady in \d/.test(ownLog()) || Date.now() - server.startedAt > READY_FALLBACK_MS) {
          try {
            const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
            if (response.ok) return;
            last = `HTTP ${response.status}`;
          } catch (e) {
            last = e instanceof Error ? e.message : String(e);
          }
        } else {
          last = "the app has not printed Ready yet";
        }
        await sleep(300, signal);
      }
      throw new SetupError(`the app did not become healthy within ${HEALTH_TIMEOUT_MS / 1000} s (${url}: ${last}). Last lines of ${plan.serverLog}:\n${tail(plan.serverLog)}`);
    },

    /** Asks the app which sign-in URLs and providers it has (`judgeProviders`): a leaked AUTH_URL or GOOGLE_CLIENT_ID shows here. */
    async verifyApp(plan, _server, { signal }) {
      const url = `${plan.baseUrl}/api/auth/providers`;
      try {
        const response = await fetch(url, { signal: AbortSignal.any([AbortSignal.timeout(10_000), signal]) });
        if (!response.ok) return { ok: false, message: `${url} answered HTTP ${response.status}` };
        return judgeProviders(await response.json(), plan.baseUrl);
      } catch (e) {
        return { ok: false, message: `${url} did not answer: ${e instanceof Error ? e.message : String(e)}` };
      }
    },
  };
}

async function main() {
  let plan;
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
      console.log(USAGE);
      process.exit(0);
    }
    plan = planRun(process.argv.slice(2));
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(`[e2e-release] ${error.message}\n\n${USAGE}`);
      process.exit(EXIT.usage);
    }
    throw error;
  }
  const code = await runRelease(plan, createRealDeps());
  process.exit(code);
}

if (isEntryPoint(import.meta.url, process.argv[1])) {
  await main();
}

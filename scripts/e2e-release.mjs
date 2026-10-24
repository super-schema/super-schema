#!/usr/bin/env node
// The release check of the browser suite, as one command: it makes a database and an app of its own, runs a tier of the suite against
// them, and removes everything again, whether the run passed, failed, was interrupted or crashed.
//
//   node scripts/e2e-release.mjs --tier smoke|regression|nightly [--keep] [--reuse-build] [--shard i/n] [--project name]
//                                [--list-only] [--output-root dir] [-- playwright arguments...]
//
//   npm run test:e2e:release             --tier nightly (everything)
//   npm run test:e2e:release:smoke       --tier smoke   (the pull-request tier)
//   npm run test:e2e:release -- --tier regression --shard 2/4
//
// What a run does, in this order (docs/testing/e2e.md has the long version):
//   1. refuses when Docker is not running;
//   2. a throwaway PostgreSQL: `docker run -d --rm --name ss-e2e-<id> postgres:16` on a free loopback port, data on tmpfs, a random
//      password; waits until it accepts connections;
//   3. `prisma migrate deploy`, then `npm run db:seed` (the seed opens its database exclusively, so it runs before the app starts);
//   4. a production build, `npm run build -- --webpack` (Turbopack refuses a symlinked node_modules, which is what a worktree has),
//      unless --reuse-build finds a build in .next that is newer than the sources and was made with the same baked-in values;
//   5. the app: `AUTH_TRUST_HOST=true next start -p <free port>`, its log in <output root>/server.log; waits for /api/v1/health;
//   6. `scripts/e2e-phases.mjs <tier>` with E2E_BASE_URL pointing at that app, E2E_DATABASE_URL at that database, and an output root and
//      a login file of the run's own: the exit code of the run is that script's;
//   7. teardown, in the reverse order of the setup: the app (SIGTERM, SIGKILL after a grace period), the run's marker, the container
//      (`docker rm -f`; --keep leaves it and says how to connect), the temp directory. It runs in a `finally`, and on SIGINT / SIGTERM /
//      SIGHUP (exit code 128 + the signal's number).
//
// Never touched: a developer's `.env` database, `data/pglite`, a dev server on :3000 or any other port. The children get an environment
// made for them (`hermeticEnv` drops DATABASE_URL, PG*, AUTH_*, PORT, the git-import settings of the developer's shell), every port is
// random and free at the time, every name carries the run's id, so two runs at the same time do not meet. The one thing two runs from one
// checkout share is `.next`: a run that would rebuild it under another run that serves from it refuses, and says so (`--reuse-build`).
//
// Exit codes: the phases script's (0 passed, 1 a test failed ...); 2 usage; 3 the environment could not be set up (Docker, database,
// build, app); 128 + n when stopped by a signal.
//
// `planRun` (pure: arguments and environment in, a plan out) and `runRelease` (the steps, with every side effect behind `deps`) are
// unit tested with fakes: tests/unit/scripts/e2e-release.test.ts. Dependency-free: node and docker.

import { spawnSync } from "node:child_process";
import { createHash, randomBytes, randomInt } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isEntryPoint, parseCli, planPhases } from "./e2e-phases.mjs";
import { SIGNALS, createInterrupt, exitCodeForSignal, killTree, signalGroup, spawnGroup, terminateGroup } from "./e2e-process.mjs";

/**
 * @typedef {{ command: string, args: string[], env: Record<string, string>, cwd: string }} CommandSpec
 * @typedef {{
 *   tier: string, keep: boolean, reuseBuild: boolean, listOnly: boolean, shard?: string, projects: string[], extra: string[],
 *   runId: string, containerName: string, image: string, dbPassword: string, authSecret: string,
 *   root: string, tmpDir: string, outputRoot: string, serverLog: string, authState: string,
 *   buildFingerprint: string, baseEnv: Record<string, string>, bins: { prisma: string, next: string }, phasesArgv: string[],
 * }} FixedPlan the part of a plan that does not depend on the ports
 * @typedef {FixedPlan & {
 *   ports: { app: number, db: number }, databaseUrl: string, baseUrl: string,
 *   env: { db: Record<string, string>, app: Record<string, string>, phases: Record<string, string> },
 *   commands: { migrate: CommandSpec, seed: CommandSpec, build: CommandSpec, server: CommandSpec, phases: CommandSpec },
 * }} RunPlan
 */

export const RELEASE_TIERS = ["smoke", "regression", "nightly"];

/** 0 passed (the phases script's own codes pass through), 2 bad arguments, 3 the environment could not be set up. */
export const EXIT = { ok: 0, usage: 2, setup: 3 };

export const POSTGRES_IMAGE = "postgres:16";
export const CONTAINER_PREFIX = "ss-e2e-";
const DB_NAME = "superschema";
const DB_USER = "postgres";
const PORT_RANGE = { min: 20000, max: 39999 };
/** Ports a run must never take: the dev server, PostgreSQL's own, and the block another local service uses. */
const RESERVED_PORTS = [[3000, 3000], [5432, 5432], [5380, 5410]];
const DB_READY_TIMEOUT_MS = 90_000;
const HEALTH_TIMEOUT_MS = 120_000;
const SERVER_STOP_GRACE_MS = 10_000;
const DOCKER_RM_TIMEOUT_MS = 60_000;
const CONTAINER_START_ATTEMPTS = 3;

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.dirname(SCRIPTS_DIR);

export class UsageError extends Error {}
/** A step of the setup that failed for a reason the message says (as opposed to a bug of this script, which also gets a stack). */
class SetupError extends Error {}
class Interrupted extends Error {}

// ------------------------------------------------------------------------------------------------------------------------------------
// Arguments
// ------------------------------------------------------------------------------------------------------------------------------------

export const USAGE = `usage: node scripts/e2e-release.mjs --tier <${RELEASE_TIERS.join("|")}> [options] [-- playwright arguments...]

  --tier <name>        smoke (pull requests), regression (every functional spec, Chromium), nightly (everything)
  --shard <i/n>        run slice i of n (regression is run as 4 slices in CI)
  --project <name>     narrow the tier to a Playwright project (repeatable): chromium, firefox-smoke, a11y ...
  --reuse-build        skip \`next build\` when .next is newer than the sources and was built by this runner with the same NEXT_PUBLIC_ values
  --keep               leave the database container running afterwards (it prints how to connect and how to remove it)
  --list-only          provision, build and start everything, but only LIST the tests of the tier (a dry run)
  --output-root <dir>  where the reports and server.log go (default: $E2E_OUTPUT_ROOT, else test-results/run-<id>)
  --help               this text

Playwright's own options (a spec file, --headed, --grep ...) go after --.`;

/**
 * @param {string[]} argv the arguments after the script name
 * @returns {{ tier: string, keep: boolean, reuseBuild: boolean, listOnly: boolean, shard?: string, projects: string[], outputRoot?: string, extra: string[], help: boolean }}
 */
export function parseArgs(argv) {
  const out = { tier: undefined, keep: false, reuseBuild: false, listOnly: false, shard: undefined, projects: [], outputRoot: undefined, extra: [], help: false };
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

/** What a developer's shell or `.env` could say that a release run must not inherit: other databases, other auth settings, other ports. */
const DEVELOPER_SETTINGS = new Set([
  "DATABASE_URL", "DIRECT_URL", "SHADOW_DATABASE_URL", "E2E_DATABASE_URL", "E2E_BASE_URL", "E2E_AUTH_STATE", "E2E_OUTPUT_ROOT", "E2E_FLAKY_FILE",
  "DB_PROVIDER", "PGLITE_DATA_DIR", "NEXTAUTH_SECRET", "NEXTAUTH_URL", "AUTH_SECRET", "AUTH_URL", "AUTH_TRUST_HOST", "PORT", "HOSTNAME", "NODE_ENV",
  "TEST_EMAIL", "TEST_PASSWORD", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "SCHEMA_IMPORT_GIT_MODE", "SCHEMA_IMPORT_GIT_SCOPES",
]);

/**
 * The environment without a developer's settings (see DEVELOPER_SETTINGS, and every libpq variable: PGHOST, PGPASSWORD ...).
 *
 * @param {Record<string, string | undefined>} env
 * @returns {Record<string, string>}
 */
export function hermeticEnv(env) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || DEVELOPER_SETTINGS.has(key) || /^PG[A-Z_]+$/.test(key)) continue;
    out[key] = value;
  }
  return out;
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

/** The values `next build` bakes into the bundle: reusing a build made with other ones would serve the old. */
function buildFingerprint(env) {
  const baked = Object.entries(env)
    .filter(([key]) => key.startsWith("NEXT_PUBLIC_"))
    .sort(([a], [b]) => a.localeCompare(b));
  return createHash("sha1").update(JSON.stringify({ mode: "webpack", baked })).digest("hex");
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
  const app = {
    ...fixed.baseEnv,
    DB_PROVIDER: "postgresql",
    DATABASE_URL: databaseUrl,
    E2E_DATABASE_URL: databaseUrl,
    PGLITE_DATA_DIR: path.join(fixed.tmpDir, "pglite-unused"),
    NEXTAUTH_SECRET: fixed.authSecret,
    NEXTAUTH_URL: baseUrl,
    AUTH_TRUST_HOST: "true",
    // The default is what the runner wants (git-host import restricted and off); say it, so a `.env` cannot change it.
    SCHEMA_IMPORT_GIT_MODE: "restricted",
    SCHEMA_IMPORT_GIT_SCOPES: "",
  };
  const phases = {
    ...fixed.baseEnv,
    DATABASE_URL: databaseUrl,
    E2E_DATABASE_URL: databaseUrl,
    DB_PROVIDER: "postgresql",
    E2E_BASE_URL: baseUrl,
    E2E_OUTPUT_ROOT: fixed.outputRoot,
    E2E_AUTH_STATE: fixed.authState,
  };
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
      phases: { command: node, args: [path.join(fixed.root, "scripts", "e2e-phases.mjs"), ...fixed.phasesArgv], env: phases, cwd: fixed.root },
    },
  };
}

/**
 * The plan of a run: its arguments, names, ports, places and the environment of every child. Pure but for the random numbers (the
 * options inject them) and `bins` (resolved from node_modules unless given).
 *
 * @param {string[]} argv the arguments after the script name
 * @param {Record<string, string | undefined>} [env]
 * @param {{ root?: string, tmpdir?: string, bins?: { prisma: string, next: string }, randomHex?: (bytes: number) => string, randomPort?: () => number }} [options]
 * @returns {RunPlan}
 */
export function planRun(argv, env = process.env, options = {}) {
  const args = parseArgs(argv);
  const root = options.root ?? REPO_ROOT;
  const randomHex = options.randomHex ?? ((bytes) => randomBytes(bytes).toString("hex"));
  const runId = randomHex(4);
  const outputRoot = path.resolve(args.outputRoot ?? env.E2E_OUTPUT_ROOT ?? path.join(root, "test-results", `run-${runId}`));
  const tmpDir = path.join(options.tmpdir ?? os.tmpdir(), `${CONTAINER_PREFIX}${runId}`);
  const baseEnv = hermeticEnv(env);
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
    root,
    tmpDir,
    outputRoot,
    serverLog: path.join(outputRoot, "server.log"),
    authState: path.join(tmpDir, "admin.json"),
    buildFingerprint: buildFingerprint(baseEnv),
    baseEnv,
    bins: options.bins ?? resolveBins(root),
    phasesArgv,
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
 * Whether the build in .next can be used again. Nothing here is a guess: --reuse-build is the caller's request, and each of the other
 * conditions has a reason that is printed.
 *
 * @param {{ reuseBuild: boolean, hasBuild: boolean, buildMtimeMs: number, sourceMtimeMs: number, stamp?: { fingerprint?: string }, fingerprint: string }} input
 * @returns {{ reuse: boolean, reason: string }}
 */
export function decideBuild({ reuseBuild, hasBuild, buildMtimeMs, sourceMtimeMs, stamp, fingerprint }) {
  if (!reuseBuild) return { reuse: false, reason: "no --reuse-build: always a fresh build" };
  if (!hasBuild) return { reuse: false, reason: ".next has no finished build (no BUILD_ID)" };
  if (!stamp) return { reuse: false, reason: "the build in .next was not made by this runner (no e2e-release stamp)" };
  if (stamp.fingerprint !== fingerprint) return { reuse: false, reason: "the NEXT_PUBLIC_* values or the build mode differ from those of the build in .next" };
  if (sourceMtimeMs > buildMtimeMs) return { reuse: false, reason: "src, package.json, next.config.ts or the Prisma schema is newer than .next" };
  return { reuse: true, reason: ".next is newer than src, made by this runner, with the same NEXT_PUBLIC_* values and build mode" };
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
 *   startServer, waitForHealth, runPhases); the unit tests give fakes
 * @returns {Promise<number>} the exit code
 */
export async function runRelease(initialPlan, deps) {
  let plan = initialPlan;
  /** @type {Array<{ name: string, undo: () => Promise<void> | void }>} */
  const undo = [];
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
  const step = async (name, fn) => {
    checkpoint();
    deps.log(`[e2e-release] ${name}`);
    return fn();
  };

  let code = EXIT.setup;
  let madeDirs = false;
  try {
    await step("checking that Docker is running", async () => {
      const docker = await deps.checkDocker();
      if (!docker.ok) throw new SetupError(docker.message ?? "Docker is not running");
    });
    deps.log(`[e2e-release] run ${plan.runId}: tier ${plan.tier}${plan.listOnly ? " (list only)" : ""}; reports and server.log will be in ${plan.outputRoot}`);

    undo.push({ name: "remove the temp directory", undo: () => deps.removeTmp(plan) });
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
        : { name: `remove the container ${plan.containerName}`, undo: () => deps.removeContainer(plan) },
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
      await deps.writeBuildStamp(plan);
    }
    run.setState("serving");

    const server = await step(`starting the app on ${plan.baseUrl} (log: ${plan.serverLog})`, () => deps.startServer(plan));
    undo.push({ name: "stop the app", undo: () => server.stop() });
    await step("waiting for /api/v1/health", () => deps.waitForHealth(plan, server, ctx));

    code = await step(`running the ${plan.tier} tier${plan.listOnly ? " (list only)" : ""}: node scripts/e2e-phases.mjs ${plan.phasesArgv.join(" ")}`, () => deps.runPhases(plan, ctx));
  } catch (error) {
    if (!received) {
      if (error instanceof SetupError) deps.error(`[e2e-release] ${error.message}`);
      else deps.error(`[e2e-release] ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
      code = EXIT.setup;
    }
  } finally {
    while (undo.length > 0) {
      const { name, undo: run } = undo.pop();
      deps.log(`[e2e-release] teardown: ${name}`);
      try {
        await run();
      } catch (error) {
        deps.error(`[e2e-release] teardown: ${name} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    stopListening();
  }

  const final = received ? exitCodeForSignal(received) : code;
  deps.log(`[e2e-release] done: exit ${final}${received ? ` (${received})` : ""}${madeDirs ? `; reports and server.log: ${plan.outputRoot}` : ""}`);
  return final;
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

/** Whether nothing listens on `port` (any address): bound and released at once. */
function isPortFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen({ port }, () => server.close(() => resolve(true)));
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

/** The newest modification time under `paths` (files and directories, node_modules skipped). */
function newestMtime(paths) {
  let newest = 0;
  const visit = (entry) => {
    let stat;
    try {
      stat = statSync(entry);
    } catch {
      return;
    }
    newest = Math.max(newest, stat.mtimeMs);
    if (stat.isDirectory()) {
      for (const name of readdirSync(entry)) if (name !== "node_modules") visit(path.join(entry, name));
    }
  };
  paths.forEach(visit);
  return newest;
}

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
export function createRealDeps({ log = console.log, error = console.error } = {}) {
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
  const live = { container: undefined, server: undefined };
  process.on("exit", () => {
    if (live.server?.pid) signalGroup(live.server, "SIGKILL");
    if (live.container) spawnSync("docker", ["rm", "-f", live.container], { stdio: "ignore", timeout: 30_000 });
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

    makeDirs(plan) {
      mkdirSync(plan.tmpDir, { recursive: true, mode: 0o700 });
      mkdirSync(plan.outputRoot, { recursive: true });
    },
    removeTmp(plan) {
      rmSync(plan.tmpDir, { recursive: true, force: true });
    },

    async freePorts(ports) {
      const take = async (preferred, other) => {
        let port = preferred;
        for (let tries = 0; tries < 50 && (port === other || !(await isPortFree(port))); tries += 1) port = pickPorts().app;
        return port;
      };
      const app = await take(ports.app, undefined);
      return { app, db: await take(ports.db, app) };
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
    runPhases: (plan) => runStep(plan.commands.phases),

    buildDecision(plan) {
      const nextDir = path.join(plan.root, ".next");
      const buildId = path.join(nextDir, "BUILD_ID");
      const hasBuild = existsSync(buildId);
      return decideBuild({
        reuseBuild: plan.reuseBuild,
        hasBuild,
        buildMtimeMs: hasBuild ? statSync(buildId).mtimeMs : 0,
        sourceMtimeMs: newestMtime(["src", "public", "prisma/schema.prisma", "package.json", "package-lock.json", "next.config.ts"].map((p) => path.join(plan.root, p))),
        stamp: readJson(path.join(nextDir, "e2e-release-build.json")),
        fingerprint: plan.buildFingerprint,
      });
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
    writeBuildStamp(plan) {
      writeFileSync(path.join(plan.root, ".next", "e2e-release-build.json"), JSON.stringify({ fingerprint: plan.buildFingerprint, mode: "webpack", runId: plan.runId, builtAt: new Date().toISOString() }));
    },

    startServer(plan) {
      const spec = plan.commands.server;
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

    async waitForHealth(plan, server, { signal }) {
      const url = `${plan.baseUrl}/api/v1/health`;
      const deadline = Date.now() + HEALTH_TIMEOUT_MS;
      let last = "no answer";
      while (Date.now() < deadline) {
        if (signal.aborted) return;
        if (server.hasExited) {
          throw new SetupError(`the app exited (code ${server.exitCode}${server.spawnError ? `, ${server.spawnError}` : ""}) before ${url} answered. Last lines of ${plan.serverLog}:\n${tail(plan.serverLog)}`);
        }
        try {
          const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
          if (response.ok) return;
          last = `HTTP ${response.status}`;
        } catch (e) {
          last = e instanceof Error ? e.message : String(e);
        }
        await sleep(500, signal);
      }
      throw new SetupError(`the app did not become healthy within ${HEALTH_TIMEOUT_MS / 1000} s (${url}: ${last}). Last lines of ${plan.serverLog}:\n${tail(plan.serverLog)}`);
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

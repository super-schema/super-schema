/**
 * scripts/e2e-release.mjs provisions a throwaway PostgreSQL (Docker), migrates and seeds it, builds and starts the app, runs a tier and
 * tears everything down. What is pinned here is what must hold without running any of it: the arguments, the ports of two runs, an
 * environment that never carries a developer's database, and a teardown that happens, in reverse order, on a failing step, on a failing
 * run and on SIGINT / SIGTERM / SIGHUP. The runner's steps are driven with fake dependencies.
 */
import { describe, expect, it, vi } from "vitest";
import { planPhases, parseCli } from "../../../scripts/e2e-phases.mjs";
import {
  EXIT,
  RELEASE_TIERS,
  UsageError,
  buildConflict,
  decideBuild,
  dockerRunArgs,
  dockerRunEnv,
  hermeticEnv,
  judgeProviders,
  parseArgs,
  pickPorts,
  planRun,
  runRelease,
} from "../../../scripts/e2e-release.mjs";

const BINS = { prisma: "/repo/node_modules/prisma/build/index.js", next: "/repo/node_modules/next/dist/bin/next" };
const DEVELOPER = {
  PATH: "/usr/bin:/bin",
  HOME: "/home/dev",
  DATABASE_URL: "postgresql://dev:devpass@db.internal:5432/devdb",
  E2E_DATABASE_URL: "postgresql://dev:devpass@db.internal:5432/e2e",
  DB_PROVIDER: "pglite",
  PGHOST: "db.internal",
  PGPASSWORD: "devpass",
  AUTH_SECRET: "dev-auth-secret",
  AUTH_URL: "http://dev.example",
  NEXTAUTH_SECRET: "dev-secret",
  NEXTAUTH_URL: "http://localhost:3000",
  PORT: "3000",
  SCHEMA_IMPORT_GIT_MODE: "any",
  AI_PROVIDER: "ollama",
  GOOGLE_CLIENT_ID: "dev-google-id",
  API_KEY: "dev-api-key",
  DIRECT_URL: "postgresql://dev:devpass@db.internal:5432/direct",
  TEST_EMAIL: "someone@example.com",
  PLAYWRIGHT_BROWSERS_PATH: "/cache/ms-playwright",
  NEXT_PUBLIC_APP_URL: "https://app.example",
};
const plan = (argv: string[] = ["--tier", "smoke"], env: Record<string, string> = DEVELOPER, options: Parameters<typeof planRun>[2] = {}) =>
  planRun(argv, env, { root: "/repo", tmpdir: "/tmp", bins: BINS, ...options });

describe("parseArgs", () => {
  it("reads the tier in both spellings, and the last one wins (an npm script's default can be overridden)", () => {
    expect(parseArgs(["--tier", "smoke"]).tier).toBe("smoke");
    expect(parseArgs(["--tier=regression"]).tier).toBe("regression");
    expect(parseArgs(["--tier", "nightly", "--tier", "smoke"]).tier).toBe("smoke");
  });

  it("refuses a missing or unknown tier, naming the tiers", () => {
    expect(() => parseArgs([])).toThrow(UsageError);
    expect(() => parseArgs([])).toThrow(/--tier/);
    expect(() => parseArgs(["--tier", "weekly"])).toThrow(new RegExp(RELEASE_TIERS.join("|")));
    expect(() => parseArgs(["--tier"])).toThrow(/needs a value/);
  });

  it("reads the flags", () => {
    expect(parseArgs(["--tier", "smoke", "--keep", "--reuse-build", "--list-only"])).toMatchObject({ keep: true, reuseBuild: true, listOnly: true });
    expect(parseArgs(["--tier", "smoke"])).toMatchObject({ keep: false, reuseBuild: false, listOnly: false, shard: undefined, projects: [], extra: [] });
  });

  it("reads and validates --shard", () => {
    expect(parseArgs(["--tier", "regression", "--shard", "2/4"]).shard).toBe("2/4");
    expect(parseArgs(["--tier", "regression", "--shard=1/1"]).shard).toBe("1/1");
    for (const bad of ["0/4", "5/4", "2", "a/b", "2/0"]) expect(() => parseArgs(["--tier", "regression", "--shard", bad])).toThrow(/--shard/);
  });

  it("collects --project (repeatable), and passes what follows -- on to playwright", () => {
    const args = parseArgs(["--tier", "smoke", "--project", "chromium", "--project=firefox-smoke", "--", "tests/e2e/a.spec.ts", "--headed"]);
    expect(args.projects).toEqual(["chromium", "firefox-smoke"]);
    expect(args.extra).toEqual(["tests/e2e/a.spec.ts", "--headed"]);
  });

  it("refuses an unknown option, and says where playwright's own go", () => {
    expect(() => parseArgs(["--tier", "smoke", "--headed"])).toThrow(/unknown option --headed.*after --/);
  });
});

describe("planRun: the arguments of the phases script", () => {
  it("passes the tier alone for a plain run", () => {
    expect(plan(["--tier", "smoke"]).phasesArgv).toEqual(["smoke"]);
    expect(plan(["--tier", "nightly"]).phasesArgv).toEqual(["nightly"]);
  });

  it("adds shard, projects, --list and the pass-through arguments, in that order", () => {
    const p = plan(["--tier", "regression", "--shard", "2/4", "--project", "chromium", "--list-only", "--", "--headed"]);
    expect(p.phasesArgv).toEqual(["regression", "--shard=2/4", "--project=chromium", "--list", "--headed"]);
  });

  it.each([
    ["smoke", ["--grep=@smoke", "--project=chromium", "--project=firefox-smoke", "--project=webkit-smoke"]],
    ["regression", ["--grep-invert=@slow|@external", "--project=chromium", "--project=a11y"]],
  ])("the tier %s becomes the phases script's playwright commands", (tier, expected) => {
    const { phases } = planPhases({ ...parseCli(plan(["--tier", tier]).phasesArgv), authState: "/x/admin.json" });
    expect(phases[0].args).toEqual(expect.arrayContaining(expected));
  });

  it("nightly is everything: no grep, no project", () => {
    const { phases } = planPhases({ ...parseCli(plan(["--tier", "nightly"]).phasesArgv), authState: "/x/admin.json" });
    expect(phases).toHaveLength(1);
    expect(phases[0].args.some((a: string) => a.startsWith("--grep") || a.startsWith("--project"))).toBe(false);
  });

  it("serial is the serial specs alone (a login, then serial-after without its dependencies): the CI job for the slow and external ones uses it", () => {
    expect(parseArgs(["--tier", "serial"]).tier).toBe("serial");
    expect(RELEASE_TIERS).toContain("serial");
    const p = plan(["--tier", "serial", "--", "--grep", "@slow|@external"]);
    expect(p.phasesArgv).toEqual(["serial", "--grep", "@slow|@external"]);
    // The caller's arguments go to the serial phase, not to the login phase, and only the login phase runs the setup project.
    const { phases } = planPhases({ ...parseCli(p.phasesArgv), authState: "/x/admin.json" });
    expect(phases.map((ph: { name: string }) => ph.name)).toEqual(["setup", "serial"]);
    expect(phases[0].args).not.toContain("--grep");
    expect(phases[1].args).toEqual(expect.arrayContaining(["--project=serial-after", "--no-deps", "--grep", "@slow|@external"]));
  });

  it("refuses before it provisions anything when no phase is left (a --project that is none of the tier's)", () => {
    expect(() => plan(["--tier", "smoke", "--project", "nope"])).toThrow(UsageError);
    expect(() => plan(["--tier", "smoke", "--project", "nope"])).toThrow(/nothing to run.*--project nope/);
    expect(() => plan(["--tier", "regression", "--project", "webkit-smoke"])).toThrow(/nothing to run/);
    expect(plan(["--tier", "smoke", "--project", "firefox-smoke"]).phasesArgv).toEqual(["smoke", "--project=firefox-smoke"]);
  });

  it("the phases command is node with the phases script, so a signal reaches it and not an npm in between", () => {
    const p = plan(["--tier", "smoke"]);
    expect(p.commands.phases.command).toBe(process.execPath);
    expect(p.commands.phases.args).toEqual(["/repo/scripts/e2e-phases.mjs", "smoke"]);
  });
});

describe("planRun: ports, names and places of two runs", () => {
  it("two plans differ in every name and place that a run owns", () => {
    const a = plan();
    const b = plan();
    expect(a.runId).not.toBe(b.runId);
    expect(a.containerName).not.toBe(b.containerName);
    expect(a.dbPassword).not.toBe(b.dbPassword);
    expect(a.authSecret).not.toBe(b.authSecret);
    expect(a.tmpDir).not.toBe(b.tmpDir);
    expect(a.authState).not.toBe(b.authState);
    expect(a.outputRoot).not.toBe(b.outputRoot);
    expect(a.serverLog).not.toBe(b.serverLog);
  });

  it("two plans pick different ports (random: 30 plans make nearly 30 different ports, and a run checks its ports again before it uses them)", () => {
    const plans = Array.from({ length: 30 }, () => plan());
    expect(new Set(plans.map((p) => p.ports.app)).size).toBeGreaterThanOrEqual(28);
    expect(new Set(plans.map((p) => p.ports.db)).size).toBeGreaterThanOrEqual(28);
    // With the random source injected, each plan takes its own picks.
    const picks = [21001, 21002, 21003, 21004];
    const a = plan(["--tier", "smoke"], DEVELOPER, { randomPort: () => picks.shift() as number });
    const b = plan(["--tier", "smoke"], DEVELOPER, { randomPort: () => picks.shift() as number });
    expect([a.ports, b.ports]).toEqual([{ app: 21001, db: 21002 }, { app: 21003, db: 21004 }]);
  });

  it("names the container ss-e2e-<runId>, so a leftover is findable", () => {
    const p = plan();
    expect(p.containerName).toBe(`ss-e2e-${p.runId}`);
    expect(p.containerName).toMatch(/^ss-e2e-[0-9a-f]{8}$/);
  });

  it("an app port and a db port that differ, in 20000-32000 (below Linux's ephemeral ports, which outgoing connections take), away from 3000, 5432 and the 5380-5410 block", () => {
    for (let i = 0; i < 500; i += 1) {
      const { app, db } = pickPorts();
      expect(app).not.toBe(db);
      for (const port of [app, db]) {
        expect(port).toBeGreaterThanOrEqual(20000);
        expect(port).toBeLessThanOrEqual(32000);
        expect(port === 3000 || port === 5432 || (port >= 5380 && port <= 5410)).toBe(false);
      }
    }
  });

  it("picks again when the random port is a reserved one or the app's own", () => {
    const sequence = [5400, 3000, 21000, 21000, 22000];
    const ports = pickPorts(() => sequence.shift() as number);
    expect(ports).toEqual({ app: 21000, db: 22000 });
  });

  it("puts the run's reports under test-results/run-<id> unless E2E_OUTPUT_ROOT says otherwise", () => {
    const p = plan();
    expect(p.outputRoot).toBe(`/repo/test-results/run-${p.runId}`);
    expect(p.serverLog).toBe(`${p.outputRoot}/server.log`);
    expect(plan(["--tier", "smoke"], { ...DEVELOPER, E2E_OUTPUT_ROOT: "/ci/out" }).outputRoot).toBe("/ci/out");
    expect(plan(["--tier", "smoke", "--output-root", "/other"], { ...DEVELOPER, E2E_OUTPUT_ROOT: "/ci/out" }).outputRoot).toBe("/other");
  });

  it("keeps the login and the unused PGlite directory in the run's own temp directory", () => {
    const p = plan();
    expect(p.tmpDir).toBe(`/tmp/ss-e2e-${p.runId}`);
    expect(p.authState.startsWith(`${p.tmpDir}/`)).toBe(true);
  });
});

describe("planRun: the environment of every child", () => {
  const p = plan();
  const everything = { db: p.env.db, app: p.env.app, phases: p.env.phases };

  it("never carries a developer's database, auth, AI or API-key settings, in any child (scripts/e2e-env.mjs has the groups)", () => {
    const text = JSON.stringify(everything);
    for (const secret of ["devpass", "db.internal", "devdb", "dev-auth-secret", "dev-secret", "dev.example", "dev-google-id", "dev-api-key", "ollama", "someone@example.com"]) {
      expect(text, secret).not.toContain(secret);
    }
    for (const env of Object.values(everything) as Array<Record<string, string>>) {
      expect(env.PORT).toBeUndefined();
      expect(env.TEST_EMAIL).toBeUndefined();
    }
  });

  it("gives the app the run's own auth origin and secret under BOTH names Auth.js reads: it prefers AUTH_URL / AUTH_SECRET, which a .env could otherwise supply", () => {
    for (const env of [p.env.app, p.env.db]) {
      expect(env.AUTH_URL).toBe(p.baseUrl);
      expect(env.NEXTAUTH_URL).toBe(p.baseUrl);
      expect(env.AUTH_SECRET).toBe(p.authSecret);
      expect(env.NEXTAUTH_SECRET).toBe(p.authSecret);
    }
  });

  it("defines the developer's feature toggles and secrets as empty strings for the children that load a .env, and leaves them out of the browser run", () => {
    for (const env of [p.env.app, p.env.db]) {
      for (const name of ["GOOGLE_CLIENT_ID", "AI_PROVIDER", "API_KEY", "DIRECT_URL", "SCHEMA_IMPORT_GIT_MODE", "SCHEMA_IMPORT_GIT_SCOPES", "PGHOST", "PGPASSWORD"]) {
        expect(env[name], name).toBe("");
      }
    }
    for (const name of ["GOOGLE_CLIENT_ID", "AI_PROVIDER", "API_KEY", "DIRECT_URL", "PGHOST", "PGPASSWORD", "AUTH_URL", "AUTH_SECRET"]) {
      expect(p.env.phases[name], name).toBeUndefined();
    }
  });

  it("points the app and the migration at the run's own database, on the PostgreSQL provider", () => {
    expect(p.databaseUrl).toBe(`postgresql://postgres:${p.dbPassword}@127.0.0.1:${p.ports.db}/superschema`);
    for (const env of [p.env.db, p.env.app, p.env.phases]) {
      expect(env.DATABASE_URL).toBe(p.databaseUrl);
      expect(env.E2E_DATABASE_URL).toBe(p.databaseUrl);
    }
    expect(p.env.app.DB_PROVIDER).toBe("postgresql");
    expect(p.env.db.DB_PROVIDER).toBe("postgresql");
    expect(p.env.app.PGLITE_DATA_DIR.startsWith(p.tmpDir)).toBe(true); // a mistake must not reach ./data/pglite
  });

  it("gives the app what a production start needs: its URL, its own secret, trusted host", () => {
    expect(p.env.app.NEXTAUTH_URL).toBe(`http://localhost:${p.ports.app}`);
    expect(p.env.app.NEXTAUTH_SECRET).toBe(p.authSecret);
    expect(p.env.app.AUTH_TRUST_HOST).toBe("true");
  });

  it("points the browser run at the app, and gives it a login file and an output root of its own", () => {
    expect(p.baseUrl).toBe(`http://localhost:${p.ports.app}`);
    expect(p.env.phases.E2E_BASE_URL).toBe(p.baseUrl);
    expect(p.env.phases.E2E_AUTH_STATE).toBe(p.authState);
    expect(p.env.phases.E2E_OUTPUT_ROOT).toBe(p.outputRoot);
  });

  it("keeps the rest of the environment (PATH, the browsers' cache)", () => {
    expect(p.env.phases.PATH).toBe("/usr/bin:/bin");
    expect(p.env.phases.PLAYWRIGHT_BROWSERS_PATH).toBe("/cache/ms-playwright");
  });

  it("starts the app with next's own bin under node, on the run's port, on loopback only", () => {
    expect(p.commands.server.command).toBe(process.execPath);
    expect(p.commands.server.args).toEqual([BINS.next, "start", "-p", String(p.ports.app), "-H", "127.0.0.1"]);
    expect(p.commands.server.env).toBe(p.env.app);
  });

  it("migrates with prisma's own bin, seeds and builds with the project's npm scripts (the build is webpack's)", () => {
    expect(p.commands.migrate.args).toEqual([BINS.prisma, "migrate", "deploy"]);
    expect(p.commands.seed).toMatchObject({ command: "npm", args: ["run", "db:seed"] });
    expect(p.commands.build).toMatchObject({ command: "npm", args: ["run", "build", "--", "--webpack"] });
    for (const spec of [p.commands.migrate, p.commands.seed, p.commands.build]) expect(spec.env.DATABASE_URL).toBe(p.databaseUrl);
  });

  it("hermeticEnv drops a developer's settings and keeps the rest", () => {
    const env = hermeticEnv(DEVELOPER);
    expect(Object.keys(env).sort()).toEqual(["HOME", "NEXT_PUBLIC_APP_URL", "PATH", "PLAYWRIGHT_BROWSERS_PATH"]);
  });
});

describe("dockerRunArgs", () => {
  const p = plan();

  it("starts a throwaway postgres:16 on loopback, in memory, removed when it stops", () => {
    const args = dockerRunArgs(p);
    expect(args.slice(0, 4)).toEqual(["run", "-d", "--rm", "--name"]);
    expect(args).toContain(p.containerName);
    expect(args).toEqual(expect.arrayContaining(["--tmpfs", "/var/lib/postgresql/data", "-p", `127.0.0.1:${p.ports.db}:5432`, "postgres:16"]));
    expect(args.indexOf("postgres:16")).toBeGreaterThan(args.indexOf(`127.0.0.1:${p.ports.db}:5432`));
  });

  it("passes the password through the environment, not on the command line", () => {
    expect(dockerRunArgs(p).join(" ")).not.toContain(p.dbPassword);
    expect(dockerRunArgs(p)).toEqual(expect.arrayContaining(["-e", "POSTGRES_PASSWORD"]));
    expect(dockerRunEnv(p).POSTGRES_PASSWORD).toBe(p.dbPassword);
  });
});

describe("decideBuild: a build is reused only for the same inputs", () => {
  const base = { reuseBuild: true, hasBuild: true, stamp: { inputsHash: "h1" }, inputsHash: "h1" };

  it("builds fresh without --reuse-build", () => {
    expect(decideBuild({ ...base, reuseBuild: false })).toEqual({ reuse: false, reason: expect.stringMatching(/--reuse-build/) });
  });

  it("reuses a build whose stamp has the same hash of inputs (no modification times: a checkout of an older commit changes the hash)", () => {
    expect(decideBuild(base)).toEqual({ reuse: true, reason: expect.stringMatching(/same inputs/) });
  });

  it.each([
    ["there is no finished build", { hasBuild: false }, /no finished build/],
    ["the build was not made by this runner", { stamp: undefined }, /not made by this runner/],
    ["the stamp is from an older runner (no hash of inputs)", { stamp: {} }, /older runner/],
    ["an input changed (a source, a config file, the lockfile, public/, a NEXT_PUBLIC_ value)", { inputsHash: "h2" }, /input.*changed/],
  ])("rebuilds when %s, and says so", (_name, change, reason) => {
    expect(decideBuild({ ...base, ...change })).toEqual({ reuse: false, reason: expect.stringMatching(reason) });
  });
});

describe("judgeProviders: is the app that answered the one that was configured", () => {
  const base = "http://localhost:24000";
  const credentials = (origin: string) => ({
    credentials: { id: "credentials", name: "credentials", type: "credentials", signinUrl: `${origin}/api/auth/signin/credentials`, callbackUrl: `${origin}/api/auth/callback/credentials` },
  });

  it("accepts an app whose sign-in URLs are under the run's origin and that has no Google provider", () => {
    expect(judgeProviders(credentials(base), base)).toEqual({ ok: true });
  });

  it("refuses an app that signs in at another origin: an AUTH_URL of a .env that got through (the dev server's, for one)", () => {
    for (const leaked of ["http://leak", "http://localhost:3000", "http://localhost:24001"]) {
      const verdict = judgeProviders(credentials(leaked), base);
      expect(verdict.ok).toBe(false);
      expect(verdict).toMatchObject({ message: expect.stringContaining(leaked) });
    }
  });

  it("does not take a longer origin that merely starts the same for the run's own (24000 vs 240001)", () => {
    expect(judgeProviders(credentials("http://localhost:240001"), base).ok).toBe(false);
  });

  it("refuses an app that offers Google sign-in: a GOOGLE_CLIENT_ID that got through", () => {
    const verdict = judgeProviders({ ...credentials(base), google: { id: "google", signinUrl: `${base}/api/auth/signin/google`, callbackUrl: `${base}/api/auth/callback/google` } }, base);
    expect(verdict).toMatchObject({ ok: false, message: expect.stringMatching(/Google sign-in/) });
  });

  it.each([[null], [[]], [{}], ["<html>"], [{ credentials: {} }]])("refuses an answer that is not a list of providers with URLs (%j)", (answer) => {
    expect(judgeProviders(answer, base).ok).toBe(false);
  });
});

describe("buildConflict: two runs from one checkout share .next", () => {
  const live = (state: string, runId = "other") => ({ runId, pid: 99, state });

  it("allows a build when no other run is using .next", () => {
    expect(buildConflict([], { willBuild: true })).toBeNull();
  });

  it("refuses to rebuild .next under a run that serves from it", () => {
    expect(buildConflict([live("serving")], { willBuild: true })).toMatch(/another release run \(pid 99\) is serving \.next[\s\S]*--reuse-build/);
  });

  it("refuses to use .next while another run builds it, even with --reuse-build", () => {
    expect(buildConflict([live("building")], { willBuild: false })).toMatch(/is building \.next/);
  });

  it("lets a run that reuses the build join one that serves it", () => {
    expect(buildConflict([live("serving")], { willBuild: false })).toBeNull();
  });
});

/** Fake dependencies: every call is recorded, in order, in `events`. */
function fakeDeps(
  options: {
    fail?: string;
    phasesCode?: number;
    reuse?: boolean;
    conflict?: string | null;
    docker?: { ok: boolean; message?: string };
    blockOn?: string;
    containerBusy?: number;
    /** The first n starts of the app find the port taken (the app exits with EADDRINUSE before it is ready). */
    appPortTaken?: number;
    verify?: { ok: boolean; message?: string };
  } = {},
) {
  const events: string[] = [];
  const messages: string[] = [];
  const handlers: Array<(signal: string) => void> = [];
  const stamped: string[] = [];
  const startedOn: number[] = [];
  let containerAttempts = 0;
  let serverStarts = 0;
  let appPort = 30000;
  const blocked = (signal: AbortSignal) => new Promise<void>((resolve) => (signal.aborted ? resolve() : signal.addEventListener("abort", () => resolve())));
  const record = async (name: string) => {
    events.push(name);
    if (options.fail === name) throw new Error(`${name} failed`);
  };
  const deps = {
    log: (m: string) => messages.push(m),
    error: (m: string) => messages.push(m),
    onSignal: (handler: (signal: string) => void) => {
      handlers.push(handler);
      return () => events.push("signals off");
    },
    checkDocker: async () => {
      events.push("check docker");
      return options.docker ?? { ok: true };
    },
    makeDirs: async () => record("make dirs"),
    removeTmp: async () => record("remove tmp"),
    freePorts: async (ports: { app: number; db: number }) => {
      events.push("free ports");
      return containerAttempts > 0 && options.containerBusy ? { ...ports, db: ports.db + 1 } : ports;
    },
    startContainer: async () => {
      containerAttempts += 1;
      events.push("start container");
      if (options.containerBusy && containerAttempts <= options.containerBusy) return { ok: false, portInUse: true, message: "port is already allocated" };
      if (options.fail === "start container") throw new Error("start container failed");
      return { ok: true };
    },
    removeContainer: async () => record("remove container"),
    waitForDb: async () => record("wait db"),
    exec: async (label: string, _spec: unknown, ctx: { signal: AbortSignal }) => {
      events.push(`exec ${label}`);
      if (options.blockOn === `exec ${label}`) {
        await blocked(ctx.signal);
        return 143;
      }
      return options.fail === `exec ${label}` ? 1 : 0;
    },
    buildDecision: () => ({ reuse: options.reuse ?? false, reason: "test", inputsHash: "hash-before" }),
    buildConflict: () => options.conflict ?? null,
    registerRun: async () => {
      events.push("register run");
      return { setState: (s: string) => events.push(`run state ${s}`), unregister: () => events.push("unregister run") };
    },
    writeBuildStamp: async (_plan: unknown, inputsHash: string) => {
      await record("write stamp");
      stamped.push(inputsHash);
    },
    freeAppPort: async (preferred: number) => {
      events.push("free app port");
      // The first probe finds the planned port free; after a start that found it taken, the port is another one.
      appPort = serverStarts === 0 ? preferred : preferred + 1;
      return appPort;
    },
    startServer: async (planOfStart: { ports: { app: number } }) => {
      serverStarts += 1;
      events.push("start server");
      startedOn.push(planOfStart.ports.app);
      return { stop: async () => void events.push("stop server"), exited: new Promise<never>(() => {}) };
    },
    waitForHealth: async () => {
      events.push("wait health");
      if (serverStarts <= (options.appPortTaken ?? 0)) throw Object.assign(new Error("EADDRINUSE: the app could not bind its port"), { portInUse: true });
      if (options.fail === "wait health") throw new Error("wait health failed");
    },
    verifyApp: async () => {
      events.push("verify app");
      return options.verify ?? { ok: true };
    },
    runPhases: async (_plan: unknown, ctx: { signal: AbortSignal }) => {
      events.push("run phases");
      if (options.blockOn === "run phases") {
        await blocked(ctx.signal);
        return 130;
      }
      return options.phasesCode ?? 0;
    },
  };
  return { deps, events, messages, handlers, stamped, startedOn };
}

/** The setup of a full run in order (what must be undone in reverse), as the fake records it. */
const FULL_RUN = [
  "check docker",
  "make dirs",
  "free ports",
  "start container",
  "wait db",
  "exec migrate",
  "exec seed",
  "register run",
  "exec build",
  "write stamp",
  "run state serving",
  "free app port",
  "start server",
  "wait health",
  "verify app",
  "run phases",
];

describe("runRelease", () => {
  it("runs every step in order, returns the phases' exit code, and tears down in reverse order of setup", async () => {
    const { deps, events } = fakeDeps();
    expect(await runRelease(plan(), deps)).toBe(0);
    expect(events).toEqual([...FULL_RUN, "stop server", "unregister run", "remove container", "remove tmp", "signals off"]);
  });

  it("returns a failing run's code as it is, and still tears down", async () => {
    const { deps, events } = fakeDeps({ phasesCode: 1 });
    expect(await runRelease(plan(), deps)).toBe(1);
    expect(events.slice(-5)).toEqual(["stop server", "unregister run", "remove container", "remove tmp", "signals off"]);
  });

  it("skips the build of a build it may reuse, and says so", async () => {
    const { deps, events, messages } = fakeDeps({ reuse: true });
    expect(await runRelease(plan(), deps)).toBe(0);
    expect(events).not.toContain("exec build");
    expect(events).not.toContain("write stamp");
    expect(events).toContain("run state serving");
    expect(messages.join("\n")).toMatch(/build: reusing .*test/);
  });

  it("tears down when a step fails: what was set up so far, in reverse, and nothing after the failure", async () => {
    const { deps, events } = fakeDeps({ fail: "exec migrate" });
    expect(await runRelease(plan(), deps)).toBe(EXIT.setup);
    expect(events).toEqual(["check docker", "make dirs", "free ports", "start container", "wait db", "exec migrate", "remove container", "remove tmp", "signals off"]);
  });

  it("tears down when the build fails: the run is registered, so it is unregistered too, and the server never started", async () => {
    const { deps, events } = fakeDeps({ fail: "exec build" });
    expect(await runRelease(plan(), deps)).toBe(EXIT.setup);
    expect(events).not.toContain("start server");
    expect(events.slice(-4)).toEqual(["unregister run", "remove container", "remove tmp", "signals off"]);
  });

  it("tears down when the app never gets healthy: the server is stopped first", async () => {
    const { deps, events } = fakeDeps({ fail: "wait health" });
    expect(await runRelease(plan(), deps)).toBe(EXIT.setup);
    expect(events).not.toContain("run phases");
    expect(events.slice(-5)).toEqual(["stop server", "unregister run", "remove container", "remove tmp", "signals off"]);
  });

  it("keeps going through the teardown when one of its steps fails, and says so in the last line even though the run passed", async () => {
    const { deps, events, messages } = fakeDeps({ fail: "remove container" });
    const p = plan();
    expect(await runRelease(p, deps)).toBe(0);
    expect(events.slice(-5)).toEqual(["stop server", "unregister run", "remove container", "remove tmp", "signals off"]);
    const last = messages.at(-1) as string;
    expect(last).toMatch(/done: exit 0/);
    expect(last).toMatch(/TEARDOWN INCOMPLETE/);
    expect(last).toContain(`remove the container ${p.containerName} failed`);
    expect(last).toContain(`docker rm -f ${p.containerName}`);
  });

  it("names a leftover directory and a leftover app in the last line, with what to do about each", async () => {
    const { deps, messages } = fakeDeps({ fail: "remove tmp" });
    const p = plan();
    expect(await runRelease(p, deps)).toBe(0);
    expect(messages.at(-1)).toContain(`rm -rf ${p.tmpDir}`);
  });

  it("has no TEARDOWN INCOMPLETE line when every teardown step worked", async () => {
    const { deps, messages } = fakeDeps();
    await runRelease(plan(), deps);
    expect(messages.join("\n")).not.toMatch(/TEARDOWN INCOMPLETE/);
  });

  it("records the build's stamp with the hash of the inputs taken BEFORE the build", async () => {
    const { deps, stamped } = fakeDeps();
    await runRelease(plan(), deps);
    expect(stamped).toEqual(["hash-before"]);
  });

  it("probes the app port again just before the app starts (after the build), and starts the app on the port it got", async () => {
    const { deps, events, startedOn } = fakeDeps();
    const p = plan();
    await runRelease(p, deps);
    expect(events.indexOf("free app port")).toBeGreaterThan(events.indexOf("exec build"));
    expect(events.indexOf("free app port")).toBeLessThan(events.indexOf("start server"));
    expect(startedOn).toEqual([p.ports.app]);
  });

  it("picks another app port and starts again when the port was taken in between: at most three starts, one stop per failed one", async () => {
    const { deps, events, startedOn } = fakeDeps({ appPortTaken: 2 });
    const p = plan();
    expect(await runRelease(p, deps)).toBe(0);
    expect(events.filter((e) => e === "start server")).toHaveLength(3);
    expect(startedOn).toEqual([p.ports.app, p.ports.app + 1, p.ports.app + 2]);
    // The two that never got ready are stopped on the spot; the one that did is stopped by the teardown.
    expect(events.filter((e) => e === "stop server")).toHaveLength(3);
    expect(events.slice(-5)).toEqual(["stop server", "unregister run", "remove container", "remove tmp", "signals off"]);
  });

  it("gives up when the app port is taken three times, and tears down", async () => {
    const { deps, events } = fakeDeps({ appPortTaken: 3 });
    expect(await runRelease(plan(), deps)).toBe(EXIT.setup);
    expect(events.filter((e) => e === "start server")).toHaveLength(3);
    expect(events).not.toContain("run phases");
    expect(events.slice(-4)).toEqual(["unregister run", "remove container", "remove tmp", "signals off"]);
  });

  it("checks the app before it runs the browser: an app that answers for another auth origin (an AUTH_URL that got through) stops the run", async () => {
    const { deps, events, messages } = fakeDeps({ verify: { ok: false, message: 'the app signs in at "http://leak/api/auth/signin/credentials", not under http://localhost:1' } });
    expect(await runRelease(plan(), deps)).toBe(EXIT.setup);
    expect(events).not.toContain("run phases");
    expect(messages.join("\n")).toMatch(/the app signs in at "http:\/\/leak/);
    expect(events.slice(-5)).toEqual(["stop server", "unregister run", "remove container", "remove tmp", "signals off"]);
  });

  it("refuses when Docker is not running, with a message that says so, and touches nothing", async () => {
    const { deps, events, messages } = fakeDeps({ docker: { ok: false, message: "Docker is not running (docker info failed). Start Docker Desktop and retry." } });
    expect(await runRelease(plan(), deps)).toBe(EXIT.setup);
    expect(events).toEqual(["check docker", "signals off"]);
    expect(messages.join("\n")).toMatch(/Docker is not running/);
  });

  it("refuses to rebuild .next under another run, and tears down what it had set up", async () => {
    const { deps, events, messages } = fakeDeps({ conflict: "another release run (pid 99) is serving .next" });
    expect(await runRelease(plan(), deps)).toBe(EXIT.setup);
    expect(events).not.toContain("exec build");
    expect(events).toContain("remove container");
    expect(messages.join("\n")).toMatch(/another release run/);
  });

  it("picks a new database port and tries again when the container's port is taken", async () => {
    const { deps, events } = fakeDeps({ containerBusy: 1 });
    expect(await runRelease(plan(), deps)).toBe(0);
    expect(events.filter((e) => e === "start container")).toHaveLength(2);
  });

  it("gives up after three port conflicts", async () => {
    const { deps } = fakeDeps({ containerBusy: 9 });
    expect(await runRelease(plan(), deps)).toBe(EXIT.setup);
  });

  describe("--keep", () => {
    it("stops the app but leaves the container running, and prints how to connect to it and how to remove it", async () => {
      const { deps, events, messages } = fakeDeps();
      const p = plan(["--tier", "smoke", "--keep"]);
      expect(await runRelease(p, deps)).toBe(0);
      expect(events).toContain("stop server");
      expect(events).not.toContain("remove container");
      expect(events).toContain("remove tmp");
      const text = messages.join("\n");
      expect(text).toContain(p.databaseUrl);
      expect(text).toContain(`docker rm -f ${p.containerName}`);
      expect(text).toContain(`docker exec -it ${p.containerName} psql`);
    });

    it("keeps the container after a failing step too (that is when you want to look inside)", async () => {
      const { deps, events } = fakeDeps({ fail: "exec seed" });
      expect(await runRelease(plan(["--tier", "smoke", "--keep"]), deps)).toBe(EXIT.setup);
      expect(events).not.toContain("remove container");
    });
  });

  describe.each([
    ["SIGINT", 130],
    ["SIGTERM", 143],
    ["SIGHUP", 129],
  ])("on %s", (signal, code) => {
    it("during the build: stops the step, starts nothing more, tears down in reverse, exits 128 + n", async () => {
      const { deps, events, handlers } = fakeDeps({ blockOn: "exec build" });
      const done = runRelease(plan(), deps);
      await vi.waitFor(() => expect(events).toContain("exec build"));
      handlers[0](signal);
      expect(await done).toBe(code);
      expect(events).not.toContain("start server");
      expect(events).not.toContain("run phases");
      expect(events.slice(-4)).toEqual(["unregister run", "remove container", "remove tmp", "signals off"]);
    });

    it("during the browser run: the server is stopped first, then the rest in reverse", async () => {
      const { deps, events, handlers } = fakeDeps({ blockOn: "run phases" });
      const done = runRelease(plan(), deps);
      await vi.waitFor(() => expect(events).toContain("run phases"));
      handlers[0](signal);
      expect(await done).toBe(code);
      expect(events.slice(-5)).toEqual(["stop server", "unregister run", "remove container", "remove tmp", "signals off"]);
    });

    it("before any step has started: does nothing but say so", async () => {
      const { deps, events, handlers } = fakeDeps();
      const done = runRelease(plan(), { ...deps, checkDocker: async () => (handlers[0](signal), { ok: true }) });
      expect(await done).toBe(code);
      expect(events).not.toContain("start container");
      expect(events).not.toContain("exec migrate");
    });
  });

  it("reports the first signal of several, and tears down once", async () => {
    const { deps, events, handlers } = fakeDeps({ blockOn: "run phases" });
    const done = runRelease(plan(), deps);
    await vi.waitFor(() => expect(events).toContain("run phases"));
    handlers[0]("SIGINT");
    handlers[0]("SIGTERM");
    expect(await done).toBe(130);
    expect(events.filter((e) => e === "remove container")).toHaveLength(1);
    expect(events.filter((e) => e === "stop server")).toHaveLength(1);
  });
});

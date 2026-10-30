/**
 * scripts/e2e-release.mjs provisions a throwaway PostgreSQL (Docker), migrates and seeds it, builds and starts the app, runs a tier and
 * tears everything down. What is pinned here is what must hold without running any of it: the arguments, the ports of two runs, an
 * environment that never carries a developer's database, and a teardown that happens, in reverse order, on a failing step, on a failing
 * run and on SIGINT / SIGTERM / SIGHUP. The runner's steps are driven with fake dependencies.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
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
  formatClock,
  formatDuration,
  makeRunDirs,
  removeRunTmp,
  stepTimingLine,
  parseArgs,
  pickPorts,
  planRun,
  runRelease,
  withPorts,
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
  AI_API_KEY: "dev-ai-key",
  OLLAMA_HOST: "dev-ollama:11434",
  OPENAI_BASE_URL: "http://dev-vllm:8000/v1",
  AUTH_PROVIDER_OKTA_CLIENT_ID: "dev-okta-id",
  API_KEY: "dev-api-key",
  DIRECT_URL: "postgresql://dev:devpass@db.internal:5432/direct",
  TEST_EMAIL: "someone@example.com",
  PLAYWRIGHT_BROWSERS_PATH: "/cache/ms-playwright",
  NEXT_PUBLIC_APP_URL: "https://app.example",
};
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
// No Chrome unless a test says so: the machine the tests run on must not decide what they see.
const plan = (argv: string[] = ["--tier", "smoke"], env: Record<string, string> = DEVELOPER, options: Parameters<typeof planRun>[2] = {}) =>
  planRun(argv, env, { root: "/repo", tmpdir: "/tmp", bins: BINS, chromePath: undefined, nodeVersions: { node: "22.12.0" }, ...options });

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
    for (const secret of ["devpass", "db.internal", "devdb", "dev-auth-secret", "dev-secret", "dev.example", "dev-okta-id", "dev-api-key", "ollama", "someone@example.com"]) {
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

  it("gives the app a random API key of the run's own (never the developer's) and the browser run the same key as E2E_API_KEY, under no other name", () => {
    expect(p.apiKey).toMatch(/^[0-9a-f]{48}$/);
    expect(p.apiKey).not.toBe("dev-api-key");
    for (const env of [p.env.app, p.env.db]) expect(env.API_KEY).toBe(p.apiKey);
    expect(p.env.phases.E2E_API_KEY).toBe(p.apiKey);
    expect(p.env.phases.API_KEY).toBeUndefined();
    expect(p.env.app.E2E_API_KEY).toBeUndefined();
    expect(plan(["--tier", "smoke"]).apiKey).not.toBe(plan(["--tier", "smoke"]).apiKey);
  });

  it("defines the developer's feature toggles and secrets as empty strings for the children that load a .env, and leaves them out of the browser run", () => {
    for (const env of [p.env.app, p.env.db]) {
      for (const name of ["AUTH_PROVIDERS", "AUTH_PROVIDER_OKTA_CLIENT_ID", "AI_PROVIDER", "AI_API_KEY", "OLLAMA_HOST", "OPENAI_BASE_URL", "DIRECT_URL", "SCHEMA_IMPORT_GIT_MODE", "SCHEMA_IMPORT_GIT_SCOPES", "PGHOST", "PGPASSWORD"]) {
        expect(env[name], name).toBe("");
      }
    }
    for (const name of ["AUTH_PROVIDERS", "AUTH_PROVIDER_OKTA_CLIENT_ID", "AI_PROVIDER", "AI_API_KEY", "OLLAMA_HOST", "OPENAI_BASE_URL", "API_KEY", "DIRECT_URL", "PGHOST", "PGPASSWORD", "AUTH_URL", "AUTH_SECRET"]) {
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

  describe("the Node (scripts/e2e-node.mjs) and the runner's knobs", () => {
    it("refuses a Node the suite does not support with a usage error, before anything is provisioned, naming the fix", () => {
      expect(() => plan(["--tier", "smoke"], DEVELOPER, { nodeVersions: { node: "26.3.1" } })).toThrow(UsageError);
      expect(() => plan(["--tier", "smoke"], DEVELOPER, { nodeVersions: { node: "26.3.1" } })).toThrow(/Node 26\.3\.1 is not supported by this suite.*nvm use 22/);
    });

    it("accepts it with E2E_ALLOW_UNSUPPORTED_NODE=1, says so in its header text, and hands the hatch to the browser run", () => {
      const p = plan(["--tier", "smoke"], { ...DEVELOPER, E2E_ALLOW_UNSUPPORTED_NODE: "1" }, { nodeVersions: { node: "26.3.1" } });
      expect(p.nodeText).toBe("node v26.3.1 (unsupported, let through by E2E_ALLOW_UNSUPPORTED_NODE=1)");
      expect(p.env.phases.E2E_ALLOW_UNSUPPORTED_NODE).toBe("1");
    });

    it("lets any Node list the tests (a listing runs nothing that can stall)", () => {
      expect(() => plan(["--tier", "smoke", "--list-only"], DEVELOPER, { nodeVersions: { node: "26.3.1" } })).not.toThrow();
    });

    it("names a supported Node plainly, and does not hand the hatch (or any knob) to a run that did not set one", () => {
      const p = plan();
      expect(p.nodeText).toBe("node v22.12.0");
      for (const name of ["E2E_ALLOW_UNSUPPORTED_NODE", "E2E_STALL_MS", "E2E_GLOBAL_TIMEOUT_MS"]) expect(p.env.phases, name).not.toHaveProperty(name);
    });

    it("hands the stall limit and the global timeout of the shell to the browser run, and to nothing else (the app never reads them)", () => {
      const p = plan(["--tier", "smoke"], { ...DEVELOPER, E2E_STALL_MS: "120000", E2E_GLOBAL_TIMEOUT_MS: "3600000" });
      expect(p.env.phases.E2E_STALL_MS).toBe("120000");
      expect(p.env.phases.E2E_GLOBAL_TIMEOUT_MS).toBe("3600000");
      for (const env of [p.env.app, p.env.db]) {
        expect(env).not.toHaveProperty("E2E_STALL_MS");
        expect(env).not.toHaveProperty("E2E_GLOBAL_TIMEOUT_MS");
      }
    });

    it("refuses a stall limit or a global timeout that is not a positive whole number of milliseconds, before anything is provisioned", () => {
      expect(() => plan(["--tier", "smoke"], { ...DEVELOPER, E2E_STALL_MS: "5min" })).toThrow(UsageError);
      expect(() => plan(["--tier", "smoke"], { ...DEVELOPER, E2E_STALL_MS: "5min" })).toThrow(/E2E_STALL_MS must be a positive whole number of milliseconds/);
      expect(() => plan(["--tier", "smoke"], { ...DEVELOPER, E2E_GLOBAL_TIMEOUT_MS: "-1" })).toThrow(/E2E_GLOBAL_TIMEOUT_MS must be/);
    });
  });

  describe("the browser (E2E_BROWSER_CHANNEL, scripts/e2e-browser.cjs)", () => {
    it("is Chrome when the machine has it and nothing says otherwise, and the browser run is told so", () => {
      const withChrome = plan(["--tier", "smoke"], DEVELOPER, { chromePath: CHROME });
      expect(withChrome.browser).toMatchObject({ channel: "chrome", source: "auto", chromePath: CHROME });
      expect(withChrome.env.phases.E2E_BROWSER_CHANNEL).toBe("chrome");
    });

    it("is the bundled Chromium without Chrome, and the browser run is told that too (the runner always decides)", () => {
      const without = plan();
      expect(without.browser).toMatchObject({ channel: "chromium", source: "auto" });
      expect(without.env.phases.E2E_BROWSER_CHANNEL).toBe("chromium");
    });

    it("is the bundled Chromium on CI even when Chrome is installed", () => {
      const ci = plan(["--tier", "smoke"], { ...DEVELOPER, CI: "true" }, { chromePath: CHROME });
      expect(ci.browser).toMatchObject({ channel: "chromium", source: "ci" });
      expect(ci.env.phases.E2E_BROWSER_CHANNEL).toBe("chromium");
    });

    it("takes the shell's explicit value over CI and over what is installed", () => {
      expect(plan(["--tier", "smoke"], { ...DEVELOPER, E2E_BROWSER_CHANNEL: "chromium" }, { chromePath: CHROME }).env.phases.E2E_BROWSER_CHANNEL).toBe("chromium");
      expect(plan(["--tier", "smoke"], { ...DEVELOPER, E2E_BROWSER_CHANNEL: "chrome", CI: "true" }, { chromePath: CHROME }).env.phases.E2E_BROWSER_CHANNEL).toBe("chrome");
    });

    it("refuses, before anything is provisioned, an explicit chrome with no Chrome here, and a value that is not a channel", () => {
      expect(() => plan(["--tier", "smoke"], { ...DEVELOPER, E2E_BROWSER_CHANNEL: "chrome" })).toThrow(UsageError);
      expect(() => plan(["--tier", "smoke"], { ...DEVELOPER, E2E_BROWSER_CHANNEL: "chrome" })).toThrow(/Google Chrome was not found/);
      expect(() => plan(["--tier", "smoke"], { ...DEVELOPER, E2E_BROWSER_CHANNEL: "firefox" })).toThrow(UsageError);
      expect(() => plan(["--tier", "smoke"], { ...DEVELOPER, E2E_BROWSER_CHANNEL: "firefox" })).toThrow(/E2E_BROWSER_CHANNEL/);
    });

    it("keeps the channel out of the app, the migration, the seed and the build", () => {
      const withChrome = plan(["--tier", "smoke"], DEVELOPER, { chromePath: CHROME });
      for (const env of [withChrome.env.app, withChrome.env.db]) expect(env.E2E_BROWSER_CHANNEL).toBeUndefined();
    });

    it("keeps its decision when the ports change (a port that was taken)", () => {
      const withChrome = plan(["--tier", "smoke"], DEVELOPER, { chromePath: CHROME });
      expect(withPorts(withChrome, { app: 31000, db: 31001 }).env.phases.E2E_BROWSER_CHANNEL).toBe("chrome");
    });
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

  it("accepts an app whose sign-in URLs are under the run's origin and that has no identity provider", () => {
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

  it.each(["google", "github", "okta", "oidc", "microsoft-entra-id"])("refuses an app that offers an identity provider (%s): an AUTH_PROVIDERS that got through", (id) => {
    const verdict = judgeProviders({ ...credentials(base), [id]: { id, signinUrl: `${base}/api/auth/signin/${id}`, callbackUrl: `${base}/api/auth/callback/${id}` } }, base);
    expect(verdict).toMatchObject({ ok: false, message: expect.stringContaining(`identity provider (${id})`) });
    expect(verdict).toMatchObject({ message: expect.stringContaining("AUTH_PROVIDERS") });
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
    /** What the browser probe says; "throw" makes it fail. */
    browser?: string;
    /** The visual tier's Playwright image is not on this machine. */
    imageMissing?: boolean;
    /** The first n starts of the SECOND app find its port taken. */
    secondPortTaken?: number;
    secondVerify?: { ok: boolean; message?: string };
  } = {},
) {
  const events: string[] = [];
  const messages: string[] = [];
  const handlers: Array<(signal: string) => void> = [];
  const stamped: string[] = [];
  const startedOn: number[] = [];
  let containerAttempts = 0;
  let serverStarts = 0;
  let secondStarts = 0;
  const secondStartedOn: number[] = [];
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
    // Not an event of the run's steps (FULL_RUN pins their order): it only reads `--version` of a browser.
    describeBrowser: async () => {
      if (options.browser === "throw") throw new Error("spawn ENOENT");
      return options.browser ?? "Google Chrome 155.0.8059.85 [channel chrome: fake]";
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
    checkVisualImage: async (image: string) => {
      events.push("check visual image");
      return options.imageMissing ? { ok: false, message: `the Playwright image ${image} is not on this machine: docker pull ${image}` } : { ok: true };
    },
    removeVisualContainer: async (name: string) => record(`remove visual container ${name}`),
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
    freeSecondPort: async (ports: { second: number }) => {
      events.push("free second port");
      return secondStarts === 0 ? ports.second : ports.second + 1;
    },
    startServer: async (planOfStart: { ports: { app: number; second?: number } }, which = "app") => {
      if (which === "second") {
        secondStarts += 1;
        events.push("start second server");
        secondStartedOn.push(planOfStart.ports.second as number);
        return { stop: async () => void events.push("stop second server"), exited: new Promise<never>(() => {}) };
      }
      serverStarts += 1;
      events.push("start server");
      startedOn.push(planOfStart.ports.app);
      return { stop: async () => void events.push("stop server"), exited: new Promise<never>(() => {}) };
    },
    waitForHealth: async (_plan: unknown, _server: unknown, _ctx: unknown, which = "app") => {
      if (which === "second") {
        events.push("wait second health");
        if (secondStarts <= (options.secondPortTaken ?? 0)) throw Object.assign(new Error("EADDRINUSE: the second app could not bind its port"), { portInUse: true });
        if (options.fail === "wait second health") throw new Error("wait second health failed");
        return;
      }
      events.push("wait health");
      if (serverStarts <= (options.appPortTaken ?? 0)) throw Object.assign(new Error("EADDRINUSE: the app could not bind its port"), { portInUse: true });
      if (options.fail === "wait health") throw new Error("wait health failed");
    },
    verifyApp: async (_plan: unknown, _server: unknown, _ctx: unknown, which = "app") => {
      if (which === "second") {
        events.push("verify second app");
        return options.secondVerify ?? { ok: true };
      }
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
  return { deps, events, messages, handlers, stamped, startedOn, secondStartedOn };
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

  it("says which browser the run uses, at the start and in the last line", async () => {
    const { deps, messages } = fakeDeps({ browser: "Google Chrome 155.0.8059.85 [channel chrome: fake]" });
    const p = plan();
    await runRelease(p, deps);
    const start = messages.findIndex((m) => m.includes(`run ${p.runId}: tier`));
    expect(messages[start + 1]).toBe("[e2e-release] node v22.12.0");
    expect(messages[start + 2]).toBe("[e2e-release] browser: Google Chrome 155.0.8059.85 [channel chrome: fake]");
    expect(messages.at(-1)).toMatch(/done: exit 0.*; browser: Google Chrome 155\.0\.8059\.85 \[channel chrome: fake\]$/);
  });

  it("does not fail a run because the browser's version cannot be read: it says so", async () => {
    const { deps, messages } = fakeDeps({ browser: "throw" });
    expect(await runRelease(plan(), deps)).toBe(0);
    expect(messages.join("\n")).toContain("[e2e-release] browser: unknown (spawn ENOENT)");
  });

  it("does not ask for the browser of a run that stopped at Docker (nothing to run in)", async () => {
    const { deps, messages } = fakeDeps({ docker: { ok: false, message: "Docker is not running" } });
    expect(await runRelease(plan(), deps)).toBe(EXIT.setup);
    expect(messages.join("\n")).not.toContain("browser:");
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

describe("the visual tier: the browser run inside the Playwright image", () => {
  const IMAGE = "mcr.microsoft.com/playwright:v1.59.1-jammy";
  const visualPlan = (extra: string[] = [], env: Record<string, string> = DEVELOPER) =>
    plan(["--tier", "visual", "--docker-image", IMAGE, ...extra], env, { platform: "darwin", uid: 502, gid: 20, nodeModulesTarget: "/repo/node_modules" });

  it("is a tier of the release runner and of the phases script, which run the visual project alone", () => {
    expect(RELEASE_TIERS).toContain("visual");
    expect(parseArgs(["--tier", "visual", "--docker-image", IMAGE]).dockerImage).toBe(IMAGE);
    const planned = planPhases({ ...parseCli(["visual"]), authState: "/a.json", outputRoot: "/out" });
    expect(planned.phases.map((phase) => phase.name)).toEqual(["main"]);
    expect(planned.phases[0].args.filter((arg: string) => arg.startsWith("--project"))).toEqual(["--project=visual"]);
    expect(planned.phases[0].args.some((arg: string) => arg.startsWith("--grep"))).toBe(false);
  });

  it("is refused outside the image unless it is told to use one: screenshots are only compared where they were taken", () => {
    expect(() => plan(["--tier", "visual"])).toThrow(UsageError);
    expect(() => plan(["--tier", "visual"])).toThrow(/Playwright Docker image/);
    expect(() => plan(["--tier", "visual"])).toThrow(/test:e2e:update-snapshots/);
    // Inside the image (E2E_VISUAL_IN_DOCKER=1: the runner is itself in the container) it is the plain tier.
    expect(plan(["--tier", "visual"], { ...DEVELOPER, E2E_VISUAL_IN_DOCKER: "1" }).visual).toBeUndefined();
    expect(() => parseArgs(["--tier", "smoke", "--docker-image", "not an image"])).toThrow(/not an image name/);
    // A digest is an image name too: `name:tag@sha256:<64 hex>` pins the exact image (the tag is mutable).
    const digest = `${IMAGE}@sha256:${"ab12".repeat(16)}`;
    expect(parseArgs(["--tier", "visual", "--docker-image", digest]).dockerImage).toBe(digest);
    expect(parseArgs(["--tier", "visual", "--docker-image", `mcr.microsoft.com/playwright@sha256:${"0".repeat(64)}`]).dockerImage).toContain("@sha256:");
    for (const bad of [`${IMAGE}@sha256:abc`, `${IMAGE}@sha256:${"G".repeat(64)}`, `${IMAGE}@md5:${"a".repeat(32)}`, `${IMAGE}@sha256:${"a".repeat(64)}x`]) {
      expect(() => parseArgs(["--tier", "visual", "--docker-image", bad]), bad).toThrow(/not an image name/);
    }
    expect(() => parseArgs(["--tier", "smoke", "--docker-image"])).toThrow(/needs a value/);
  });

  it("runs the browser run as docker run of that image, in a container named ss-e2e-visual-<id>, with the checkout mounted and the host user", () => {
    const p = visualPlan();
    expect(p.visual?.image).toBe(IMAGE);
    expect(p.visual?.containerName).toMatch(/^ss-e2e-visual-[0-9a-f]{8}$/);
    const spec = p.commands.phases;
    expect(spec.command).toBe("docker");
    expect(spec.args.slice(0, 4)).toEqual(["run", "--rm", "--name", p.visual?.containerName]);
    expect(spec.args).toContain(IMAGE);
    expect(spec.args[spec.args.indexOf("--user") + 1]).toBe("502:20");
    expect(spec.args[spec.args.indexOf("-v") + 1]).toBe("/repo:/repo:ro");
    const afterImage = spec.args.slice(spec.args.indexOf(IMAGE) + 1);
    expect(afterImage.slice(0, 6)).toEqual(["node", "scripts/e2e-in-docker.mjs", "--forward", `${p.ports.app},${p.ports.db}`, "--target", "host.docker.internal"]);
    expect(afterImage.slice(afterImage.indexOf("--") + 1)).toEqual(["node", "scripts/e2e-phases.mjs", "visual"]);
  });

  it("passes the run's environment to the container by name, so the database password and the API key are in no argument", () => {
    const p = visualPlan();
    const text = JSON.stringify(p.commands.phases.args);
    expect(text).not.toContain(p.dbPassword);
    expect(text).not.toContain(p.apiKey);
    expect(p.commands.phases.env.E2E_API_KEY).toBe(p.apiKey);
    expect(p.commands.phases.env.E2E_DATABASE_URL).toBe(p.databaseUrl);
    // The URLs are the host's: the container forwards its loopback ports, so the app's own origin (AUTH_URL) stays right.
    expect(p.commands.phases.env.E2E_BASE_URL).toBe(p.baseUrl);
    expect(p.env.app.AUTH_URL).toBe(p.baseUrl);
  });

  it("uses the image's Chromium whatever the machine or the shell says, and keeps the login file under the output root (the container sees the checkout only)", () => {
    const p = visualPlan([], { ...DEVELOPER, E2E_BROWSER_CHANNEL: "chrome" });
    expect(p.browser.channel).toBe("chromium");
    expect(p.env.phases.E2E_BROWSER_CHANNEL).toBe("chromium");
    expect(p.tmpDir.startsWith(p.outputRoot)).toBe(true);
    expect(p.authState.startsWith(p.outputRoot)).toBe(true);
  });

  it("stops before anything is provisioned when the image is not on the machine, and says how to get it", async () => {
    const { deps, events } = fakeDeps({ imageMissing: true });
    expect(await runRelease(visualPlan(), deps)).toBe(EXIT.setup);
    expect(events).toEqual(["check docker", "check visual image", "signals off"]);
  });

  it("removes the Playwright container in the teardown, after the app, whatever the run did", async () => {
    const { deps, events } = fakeDeps({ phasesCode: 1 });
    const p = visualPlan();
    expect(await runRelease(p, deps)).toBe(1);
    expect(events.slice(-6)).toEqual(["stop server", "unregister run", "remove container", "remove tmp", `remove visual container ${p.visual?.containerName}`, "signals off"]);
  });

  it("is the same run as any other tier for a plan without an image (nothing of the visual side)", () => {
    const p = plan(["--tier", "smoke"]);
    expect(p.visual).toBeUndefined();
    expect(p.commands.phases.command).not.toBe("docker");
  });
});

describe("the run's temp directory: only what the runner made is removed", () => {
  const scratch = () => mkdtempSync(path.join(tmpdir(), "e2e-release-test-"));
  const IMAGE = "mcr.microsoft.com/playwright:v1.59.1-jammy";

  it("is named after the run, inside the output root, for the visual tier (never a bare `tmp`: an output root can hold one that is somebody's)", () => {
    const a = plan(["--tier", "visual", "--docker-image", IMAGE, "--output-root", "/out/root"]);
    const b = plan(["--tier", "visual", "--docker-image", IMAGE, "--output-root", "/out/root"]);
    expect(a.tmpDir).toBe(`/out/root/tmp-${a.runId}`);
    expect(a.tmpDir).not.toBe(b.tmpDir);
    expect(path.basename(a.tmpDir)).not.toBe("tmp");
    expect(a.authState).toBe(path.join(a.tmpDir, "admin.json"));
  });

  it("makes the directory, and removes it afterwards", () => {
    const root = scratch();
    try {
      const created = new Set<string>();
      const p = { tmpDir: path.join(root, "tmp-abc"), outputRoot: path.join(root, "out") };
      makeRunDirs(p, created);
      expect(existsSync(p.tmpDir)).toBe(true);
      writeFileSync(path.join(p.tmpDir, "admin.json"), "{}");
      removeRunTmp(p, created);
      expect(existsSync(p.tmpDir)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses a directory that already exists and never removes it, whatever the teardown does afterwards (an --output-root that holds a tmp of its own)", () => {
    const root = scratch();
    try {
      const outputRoot = path.join(root, "out");
      const somebodys = path.join(outputRoot, "tmp");
      mkdirSync(somebodys, { recursive: true });
      writeFileSync(path.join(somebodys, "keep-me.txt"), "precious");
      const created = new Set<string>();
      // The runner's own name for it would collide only by chance; make it collide to prove the rule, not the luck.
      const p = { tmpDir: somebodys, outputRoot };
      expect(() => makeRunDirs(p, created)).toThrow(/already exists/);
      removeRunTmp(p, created);
      expect(readFileSync(path.join(somebodys, "keep-me.txt"), "utf8")).toBe("precious");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("removes nothing it did not create, even a path it is handed", () => {
    const root = scratch();
    try {
      const other = path.join(root, "other");
      mkdirSync(other);
      writeFileSync(path.join(other, "x"), "1");
      removeRunTmp({ tmpDir: other }, new Set<string>());
      expect(existsSync(path.join(other, "x"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("the timing of a run: a long hole in the log is attributable", () => {
  it("formats a duration as the largest units that matter: tenths of a second under a minute, then minutes and seconds, then hours", () => {
    expect(formatDuration(0)).toBe("0.0 s");
    expect(formatDuration(1234)).toBe("1.2 s");
    expect(formatDuration(59_949)).toBe("59.9 s");
    expect(formatDuration(60_000)).toBe("1m00s");
    expect(formatDuration(62_400)).toBe("1m02s");
    expect(formatDuration(10 * 60_000 + 24_000)).toBe("10m24s");
    expect(formatDuration(3_600_000)).toBe("1h00m00s");
    expect(formatDuration(3_725_000)).toBe("1h02m05s");
    expect(formatDuration(-5)).toBe("0.0 s");
  });

  it("formats a clock time as HH:MM:SS in the machine's time zone, two digits each", () => {
    expect(formatClock(new Date(2026, 9, 25, 7, 5, 9))).toBe("07:05:09");
    expect(formatClock(new Date(2026, 9, 25, 23, 59, 59))).toBe("23:59:59");
  });

  it("says how long a step took and how long the run has been going, naming the step", () => {
    expect(stepTimingLine("building the app", 62_400, 130_000)).toBe("[e2e-release]   ... building the app: took 1m02s (the run is 2m10s old)");
  });

  it("logs a step that took 2 s or more with its duration, and none that was quicker, so the log of a fast run is unchanged", async () => {
    let clock = 1_000_000;
    const { deps, messages } = fakeDeps();
    const slowWait = deps.waitForDb;
    deps.waitForDb = async (...args: unknown[]) => {
      clock += 125_000; // two minutes of waiting for the database
      return (slowWait as (...a: unknown[]) => Promise<void>)(...args);
    };
    (deps as { now?: () => number }).now = () => clock;
    expect(await runRelease(plan(), deps)).toBe(0);
    const timing = messages.filter((m) => m.includes("... "));
    expect(timing).toEqual([`[e2e-release]   ... waiting for the database: took 2m05s (the run is 2m05s old)`]);
    expect(messages.at(-1)).toMatch(/done: exit 0 in 2m05s;/);
  });

  it("the last line names how long the whole run took", async () => {
    const { deps, messages } = fakeDeps();
    expect(await runRelease(plan(), deps)).toBe(0);
    expect(messages.at(-1)).toMatch(/done: exit 0 in \d+(\.\d)? s;/);
  });
});

describe("the second app: git import in `any` mode, for the @external test that needs a server of its own", () => {
  const nightly = (extra: string[] = []) => plan(["--tier", "nightly", ...extra]);

  describe("when it is started", () => {
    it("reads --second-app", () => {
      expect(parseArgs(["--tier", "smoke", "--second-app"]).secondApp).toBe(true);
      expect(parseArgs(["--tier", "smoke"]).secondApp).toBe(false);
    });

    it("is started by the nightly tier (it includes the @external tests) and by --second-app, and by nothing else", () => {
      expect(plan(["--tier", "nightly"]).secondApp).toBe(true);
      expect(plan(["--tier", "smoke", "--second-app"]).secondApp).toBe(true);
      expect(plan(["--tier", "regression", "--second-app"]).secondApp).toBe(true);
      for (const tier of ["smoke", "regression", "serial"]) expect(plan(["--tier", tier]).secondApp, tier).toBe(false);
    });

    it("is never started for a listing (nothing runs), even with --second-app", () => {
      expect(plan(["--tier", "nightly", "--list-only"]).secondApp).toBe(false);
      expect(plan(["--tier", "smoke", "--second-app", "--list-only"]).secondApp).toBe(false);
    });

    it("gives a plan without it no second port, origin or command: the ports are exactly the app's and the database's", () => {
      const p = plan(["--tier", "smoke"]);
      expect(Object.keys(p.ports).sort()).toEqual(["app", "db"]);
      expect(p.secondBaseUrl).toBeUndefined();
      expect(p.commands.secondServer).toBeUndefined();
      expect(p.env.secondApp).toBeUndefined();
      expect(p.env.phases).not.toHaveProperty("E2E_GIT_ANY_BASE_URL");
    });
  });

  describe("its plan", () => {
    it("has a port of its own, distinct from the app's, the database's and every reserved one", () => {
      for (let i = 0; i < 200; i += 1) {
        const { ports } = nightly();
        expect(ports.second).toBeDefined();
        expect(new Set([ports.app, ports.db, ports.second]).size).toBe(3);
        expect(ports.second as number).toBeGreaterThanOrEqual(20000);
        expect(ports.second as number).toBeLessThanOrEqual(32000);
        expect([3000, 5432]).not.toContain(ports.second);
      }
    });

    it("starts `next start` of the SAME checkout (the same build) on that port, with its own environment", () => {
      const p = nightly();
      expect(p.commands.secondServer?.args).toEqual([BINS.next, "start", "-p", String(p.ports.second), "-H", "127.0.0.1"]);
      expect(p.commands.secondServer?.cwd).toBe(p.commands.server.cwd);
      expect(p.secondBaseUrl).toBe(`http://localhost:${p.ports.second}`);
      expect(p.secondServerLog).toBe(path.join(p.outputRoot, "server-git-any.log"));
      expect(p.secondServerLog).not.toBe(p.serverLog);
    });

    it("is the first app's environment (same database, secret, API key) with SCHEMA_IMPORT_GIT_MODE=any and ITS OWN origin for Auth.js", () => {
      const p = nightly();
      const first = p.env.app;
      const second = p.env.secondApp as Record<string, string>;
      expect(first.SCHEMA_IMPORT_GIT_MODE, "the first app stays restricted: blank").toBe("");
      expect(second.SCHEMA_IMPORT_GIT_MODE).toBe("any");
      for (const name of ["DATABASE_URL", "DB_PROVIDER", "AUTH_SECRET", "NEXTAUTH_SECRET", "API_KEY"]) expect(second[name], name).toBe(first[name]);
      // Auth.js builds its sign-in URLs from AUTH_URL: the second app's must be its own origin, not the first's.
      expect(second.AUTH_URL).toBe(p.secondBaseUrl);
      expect(second.NEXTAUTH_URL).toBe(p.secondBaseUrl);
      expect(first.AUTH_URL).toBe(p.baseUrl);
      // and nothing of the developer's shell reaches it (the same hermetic rules as the first)
      expect(second.DATABASE_URL).not.toContain("db.internal");
      expect(second.AUTH_PROVIDER_OKTA_CLIENT_ID).toBe("");
      expect(second.AUTH_PROVIDERS).toBe("");
    });

    it("hands the browser run the second app's origin as E2E_GIT_ANY_BASE_URL (a shell value of the name is dropped, the run's own is set)", () => {
      const p = plan(["--tier", "nightly"], { ...DEVELOPER, E2E_GIT_ANY_BASE_URL: "http://shell.example" });
      expect(p.env.phases.E2E_GIT_ANY_BASE_URL).toBe(p.secondBaseUrl);
      const q = plan(["--tier", "smoke"], { ...DEVELOPER, E2E_GIT_ANY_BASE_URL: "http://shell.example" });
      expect(q.env.phases).not.toHaveProperty("E2E_GIT_ANY_BASE_URL");
    });

    it("follows the ports when they are chosen again (withPorts)", () => {
      const p = nightly();
      const moved = withPorts(p, { ...p.ports, second: 31999 });
      expect(moved.secondBaseUrl).toBe("http://localhost:31999");
      expect(moved.commands.secondServer?.args).toContain("31999");
      expect(moved.env.phases.E2E_GIT_ANY_BASE_URL).toBe("http://localhost:31999");
      expect((moved.env.secondApp as Record<string, string>).AUTH_URL).toBe("http://localhost:31999");
    });
  });

  describe("runRelease", () => {
    const SECOND_UP = ["free second port", "start second server", "wait second health", "verify second app"];
    const upToFirstApp = FULL_RUN.slice(0, FULL_RUN.indexOf("run phases"));

    it("starts it after the first app is healthy and before the tier, and tears it down first", async () => {
      const { deps, events } = fakeDeps();
      expect(await runRelease(nightly(), deps)).toBe(0);
      expect(events).toEqual([...upToFirstApp, ...SECOND_UP, "run phases", "stop second server", "stop server", "unregister run", "remove container", "remove tmp", "signals off"]);
    });

    it("starts nothing more for a plan without it (the events of a smoke run are the ones they always were)", async () => {
      const { deps, events } = fakeDeps();
      await runRelease(plan(["--tier", "smoke"]), deps);
      expect(events).toEqual([...FULL_RUN, "stop server", "unregister run", "remove container", "remove tmp", "signals off"]);
    });

    it("does not run the tier, and stops both apps, when the second one never gets healthy", async () => {
      const { deps, events } = fakeDeps({ fail: "wait second health" });
      expect(await runRelease(nightly(), deps)).toBe(EXIT.setup);
      expect(events).not.toContain("run phases");
      expect(events.slice(-6)).toEqual(["stop second server", "stop server", "unregister run", "remove container", "remove tmp", "signals off"]);
    });

    it("refuses a second app that is not the one configured (its sign-in URLs are another origin)", async () => {
      const { deps, events, messages } = fakeDeps({ secondVerify: { ok: false, message: "the app's credentials signinUrl is elsewhere" } });
      expect(await runRelease(nightly(), deps)).toBe(EXIT.setup);
      expect(events).not.toContain("run phases");
      expect(messages.join("\n")).toContain("the app's credentials signinUrl is elsewhere");
    });

    it("chooses another port for it when it was taken before the app could bind it, and stops the failed attempt", async () => {
      const { deps, events, secondStartedOn } = fakeDeps({ secondPortTaken: 1 });
      const p = nightly();
      expect(await runRelease(p, deps)).toBe(0);
      expect(secondStartedOn).toHaveLength(2);
      expect(secondStartedOn[1]).toBe((p.ports.second as number) + 1);
      expect(events.filter((e) => e === "start second server")).toHaveLength(2);
      expect(events.filter((e) => e === "stop second server")).toHaveLength(2); // the failed attempt, then the run's teardown
      expect(events).toContain("run phases");
    });
  });
});

describe("pruning the old run directories", () => {
  it("reads E2E_KEEP_RUNS (5 by default) when the plan is made, and refuses a value that is not a positive whole number (exit 2, a usage error)", () => {
    expect(plan(["--tier", "smoke"]).keepRuns).toBe(5);
    expect(plan(["--tier", "smoke"], { ...DEVELOPER, E2E_KEEP_RUNS: "12" }).keepRuns).toBe(12);
    expect(() => plan(["--tier", "smoke"], { ...DEVELOPER, E2E_KEEP_RUNS: "0" })).toThrow(/E2E_KEEP_RUNS must be a positive whole number/);
    expect(() => plan(["--tier", "smoke"], { ...DEVELOPER, E2E_KEEP_RUNS: "many" })).toThrow(UsageError);
  });

  it("prunes once the run's own directories exist (so the newest run, this one, is among the kept), before the database starts", async () => {
    const { deps, events } = fakeDeps();
    const pruned: unknown[] = [];
    const withPrune = {
      ...deps,
      makeDirs: async () => void events.push("make dirs"),
      pruneOldRuns: (p: { keepRuns: number }) => {
        events.push("prune");
        pruned.push(p.keepRuns);
      },
    };
    expect(await runRelease(plan(), withPrune)).toBe(0);
    expect(events.slice(0, 4)).toEqual(["check docker", "make dirs", "prune", "free ports"]);
    expect(pruned).toEqual([5]);
  });

  it("never fails the run when the prune throws: it says it was skipped", async () => {
    const { deps, messages } = fakeDeps();
    const failing = {
      ...deps,
      pruneOldRuns: () => {
        throw new Error("EACCES");
      },
    };
    expect(await runRelease(plan(), failing)).toBe(0);
    expect(messages.join("\n")).toContain("[e2e-release] prune: skipped (EACCES)");
  });
});

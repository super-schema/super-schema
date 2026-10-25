/**
 * The environment of a release run (scripts/e2e-env.mjs). The runner's rule: a name the app reads is either SET to the run's own value,
 * BLANKED (defined as ""), DROPPED, or ALLOWED on purpose; a name that is merely missing from the shell is filled in by the checkout's
 * `.env` (Next's loadEnvConfig, `dotenv/config`, prisma/load-env-file.ts), which is how a developer's AUTH_URL got back to the app.
 * Pinned here: the lists, the values, the loaders' behaviour (a probe with a real `.env`), and that the app does not start to read a name
 * that no group accounts for.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_CLASSIFICATION_CATEGORY_FIELD, DEFAULT_CLASSIFICATION_EXTENSION_KEY, DEFAULT_CLASSIFICATION_LEVEL_FIELD } from "@/lib/importers/classification-config";
import { loadEnvFile } from "../../../prisma/load-env-file";
import {
  CLASSIFICATION_DEFAULTS,
  HERMETIC_ALLOWED_NAMES,
  HERMETIC_BLANKED_NAMES,
  HERMETIC_BROWSER_RUN_NAMES,
  HERMETIC_DROPPED_NAMES,
  HERMETIC_RUNNER_KNOB_NAMES,
  HERMETIC_SET_NAMES,
  appEnvironment,
  hermeticEnv,
  phasesEnvironment,
  runnerKnobs,
  secondAppEnvironment,
  setValues,
} from "../../../scripts/e2e-env.mjs";

const REPO = path.resolve(__dirname, "../../..");
const RUN = { databaseUrl: "postgresql://postgres:pw@127.0.0.1:21000/superschema", baseUrl: "http://localhost:22000", authSecret: "run-secret", pgliteDir: "/tmp/ss-e2e-x/pglite-unused", apiKey: "run-api-key" };
const DEVELOPER = {
  PATH: "/usr/bin",
  AUTH_URL: "http://localhost:3000",
  AUTH_SECRET: "dev-auth-secret",
  AI_PROVIDER: "ollama",
  AI_BASE_URL: "http://dev-ai:11434",
  GOOGLE_CLIENT_ID: "dev-google-id",
  API_KEY: "dev-api-key",
  DATABASE_URL: "postgresql://dev:devpass@db.internal:5432/devdb",
  NEXTAUTH_URL: "http://localhost:3000",
  PGPASSWORD: "devpass",
  SCHEMA_IMPORT_GIT_MODE: "any",
  ASYNCAPI_PARSER_IN_PROCESS: "1",
  TEST_EMAIL: "dev@example.com",
  E2E_BROWSER_CHANNEL: "chromium",
};

describe("the groups", () => {
  it("pin the blanked names: a name is added or removed on purpose, with a reason in scripts/e2e-env.mjs", () => {
    expect([...HERMETIC_BLANKED_NAMES].sort()).toEqual(
      [
        "AI_BASE_URL", "AI_MODEL", "AI_PROVIDER",
        "ASYNCAPI_PARSER_BREAKER_MS", "ASYNCAPI_PARSER_IN_PROCESS", "ASYNCAPI_PARSER_MAX_MESSAGE_BYTES", "ASYNCAPI_PARSER_PARSE_TIMEOUT_MS", "ASYNCAPI_PARSER_REBUILD_BACKOFF_MS",
        "ASYNCAPI_PARSER_START_TIMEOUT_MS", "ASYNCAPI_PARSER_VALIDATE_TIMEOUT_MS", "ASYNCAPI_PARSER_WORKER", "ASYNCAPI_PARSER_WORKERS",
        "AUTH_REDIRECT_PROXY_URL", "AUTH_SECRET_1", "AUTH_SECRET_2", "AUTH_SECRET_3",
        "BOOTSTRAP_ADMIN_EMAIL", "BOOTSTRAP_ADMIN_PASSWORD",
        "DIRECT_URL",
        "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET",
        "HEALTH_DB_DEGRADED_MS", "HEALTH_DB_TIMEOUT_MS",
        "PGAPPNAME", "PGCONNECT_TIMEOUT", "PGDATABASE", "PGHOST", "PGHOSTADDR", "PGOPTIONS", "PGPASSFILE", "PGPASSWORD", "PGPORT", "PGSERVICE",
        "PGSERVICEFILE", "PGSSLCERT", "PGSSLKEY", "PGSSLMODE", "PGSSLROOTCERT", "PGUSER",
        "SCHEMA_CLASSIFICATION_VALUE_MAP", "SCHEMA_IMPORT_GIT_MODE", "SCHEMA_IMPORT_GIT_SCOPES", "SCHEMA_IMPORT_MAX_YAML_BYTES",
        "SHADOW_DATABASE_URL",
      ].sort(),
    );
  });

  it("pin the names the run sets", () => {
    expect([...HERMETIC_SET_NAMES].sort()).toEqual(
      [
        "API_KEY", "AUTH_SECRET", "AUTH_TRUST_HOST", "AUTH_URL", "DATABASE_URL", "DB_PROVIDER", "E2E_DATABASE_URL", "NEXTAUTH_SECRET", "NEXTAUTH_URL", "PGLITE_DATA_DIR",
        "SCHEMA_CLASSIFICATION_CATEGORY_FIELD", "SCHEMA_CLASSIFICATION_EXTENSION_KEY", "SCHEMA_CLASSIFICATION_LEVEL_FIELD",
      ].sort(),
    );
  });

  it("pin the names only the browser run reads: the browser channel, which the runner decides and sets for it alone", () => {
    expect(Object.keys(HERMETIC_BROWSER_RUN_NAMES)).toEqual(["E2E_BROWSER_CHANNEL"]);
    for (const reason of Object.values(HERMETIC_BROWSER_RUN_NAMES)) expect(reason.length).toBeGreaterThan(10);
  });

  it("pin the runner's own knobs: the Node hatch, the skipped-test hatch, the stall limit and the global timeout, each with a reason", () => {
    expect(Object.keys(HERMETIC_RUNNER_KNOB_NAMES).sort()).toEqual(["E2E_ALLOW_SKIPS", "E2E_ALLOW_UNSUPPORTED_NODE", "E2E_GLOBAL_TIMEOUT_MS", "E2E_STALL_MS"]);
    for (const reason of Object.values(HERMETIC_RUNNER_KNOB_NAMES)) expect(reason.length).toBeGreaterThan(10);
  });

  it("are disjoint: a name is in one group", () => {
    const groups = [
      HERMETIC_SET_NAMES,
      HERMETIC_BLANKED_NAMES,
      Object.keys(HERMETIC_DROPPED_NAMES),
      Object.keys(HERMETIC_ALLOWED_NAMES),
      Object.keys(HERMETIC_BROWSER_RUN_NAMES),
      Object.keys(HERMETIC_RUNNER_KNOB_NAMES),
    ];
    const all = groups.flat();
    expect(all.filter((name, i) => all.indexOf(name) !== i)).toEqual([]);
  });

  it("every allowed and dropped name has a reason", () => {
    for (const reason of [...Object.values(HERMETIC_ALLOWED_NAMES), ...Object.values(HERMETIC_DROPPED_NAMES)]) expect(reason.length).toBeGreaterThan(10);
  });

  it("sets the classification importer's own defaults (an empty value is not its default: it warns and falls back)", () => {
    expect(CLASSIFICATION_DEFAULTS).toEqual({
      SCHEMA_CLASSIFICATION_EXTENSION_KEY: DEFAULT_CLASSIFICATION_EXTENSION_KEY,
      SCHEMA_CLASSIFICATION_LEVEL_FIELD: DEFAULT_CLASSIFICATION_LEVEL_FIELD,
      SCHEMA_CLASSIFICATION_CATEGORY_FIELD: DEFAULT_CLASSIFICATION_CATEGORY_FIELD,
    });
  });
});

describe("the runner's knobs", () => {
  it("runnerKnobs keeps the knobs the shell has set, drops the unset and the empty, and nothing else", () => {
    expect(runnerKnobs({ E2E_STALL_MS: "1000", E2E_ALLOW_UNSUPPORTED_NODE: "", E2E_OUTPUT_ROOT: "/x", PATH: "/usr/bin" })).toEqual({ E2E_STALL_MS: "1000" });
    expect(runnerKnobs({})).toEqual({});
  });

  it("the shell's knobs are dropped from the base environment (the E2E_ prefix), so they reach the browser run only through runnerKnobs", () => {
    const base = hermeticEnv({ PATH: "/usr/bin", E2E_STALL_MS: "1000", E2E_ALLOW_UNSUPPORTED_NODE: "1", E2E_GLOBAL_TIMEOUT_MS: "5" });
    expect(base).toEqual({ PATH: "/usr/bin" });
    const phases = phasesEnvironment(base, { ...RUN, outputRoot: "/out", authState: "/a.json", knobs: { E2E_STALL_MS: "1000" } });
    expect(phases.E2E_STALL_MS).toBe("1000");
    expect(phases).not.toHaveProperty("E2E_ALLOW_UNSUPPORTED_NODE");
  });

  it("the run's own settings win over a knob of the same name (a knob cannot repoint the run)", () => {
    const phases = phasesEnvironment({}, { ...RUN, outputRoot: "/out", authState: "/a.json", knobs: { E2E_BASE_URL: "http://elsewhere", E2E_STALL_MS: "9" } as Record<string, string> });
    expect(phases.E2E_BASE_URL).toBe(RUN.baseUrl);
  });
});

describe("the second app (git import in `any` mode) and the browser run's E2E_GIT_ANY_BASE_URL", () => {
  const SECOND = "http://localhost:22001";
  const base = hermeticEnv(DEVELOPER);

  it("is the first app's environment with the git mode set to `any` (blank for the first), and the second origin for Auth.js", () => {
    const first = appEnvironment(base, RUN);
    const second = secondAppEnvironment(base, RUN, SECOND);
    expect(first.SCHEMA_IMPORT_GIT_MODE).toBe("");
    expect(second.SCHEMA_IMPORT_GIT_MODE).toBe("any");
    expect(second.AUTH_URL).toBe(SECOND);
    expect(second.NEXTAUTH_URL).toBe(SECOND);
    // everything else is the first app's: one database, one secret (a login is a signed cookie of that secret), one API key
    const differing = ["SCHEMA_IMPORT_GIT_MODE", "AUTH_URL", "NEXTAUTH_URL", "GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN", "GH_CONFIG_DIR"];
    const without = (env: Record<string, string>) => Object.fromEntries(Object.entries(env).filter(([name]) => !differing.includes(name)));
    expect(without(second)).toEqual(without(first));
  });

  it("carries nothing of the developer's shell (the developer's SCHEMA_IMPORT_GIT_MODE=any is not what makes it `any`: the run's value is)", () => {
    const second = secondAppEnvironment(hermeticEnv({ ...DEVELOPER, SCHEMA_IMPORT_GIT_MODE: "restricted" }), RUN, SECOND);
    expect(second.SCHEMA_IMPORT_GIT_MODE).toBe("any");
    expect(JSON.stringify(second)).not.toContain("devpass");
    expect(second.GOOGLE_CLIENT_ID).toBe("");
  });

  // M7: `any` mode makes the server call `gh api` for a git URL; with the developer's own HOME and token that is the developer's login, so the
  // test could read a private repository. The second app gets none of it.
  it("does not inherit the developer's `gh` credentials: the tokens are blank and the config directory is an empty one of the run's own", () => {
    const shell = hermeticEnv({ ...DEVELOPER, GH_TOKEN: "ghp_dev", GITHUB_TOKEN: "ghp_dev2", GH_ENTERPRISE_TOKEN: "ghe_dev", GITHUB_ENTERPRISE_TOKEN: "ghe_dev2", GH_CONFIG_DIR: "/home/dev/.config/gh", HOME: "/home/dev" });
    const second = secondAppEnvironment(shell, RUN, SECOND);
    expect(second.GH_TOKEN).toBe("");
    expect(second.GITHUB_TOKEN).toBe("");
    expect(second.GH_ENTERPRISE_TOKEN).toBe("");
    expect(second.GITHUB_ENTERPRISE_TOKEN).toBe("");
    expect(second.GH_CONFIG_DIR).toBe("/tmp/ss-e2e-x/gh-config-none"); // next to RUN.pgliteDir, in the run's own temporary directory
    expect(JSON.stringify(second)).not.toMatch(/ghp_dev|ghe_dev|\.config\/gh/);
    // the first app's environment is the shell's rest, as before (its git mode refuses a git URL before it reaches `gh`)
    expect(appEnvironment(shell, RUN)).not.toHaveProperty("GH_CONFIG_DIR", "/tmp/ss-e2e-x/gh-config-none");
  });

  it("without a directory given the tokens are still blank (and the shell's config directory is not passed on)", () => {
    const second = secondAppEnvironment(hermeticEnv({ ...DEVELOPER, GH_TOKEN: "ghp_dev", GH_CONFIG_DIR: "/home/dev/.config/gh" }), RUN, SECOND);
    expect(second.GH_TOKEN).toBe("");
    expect(second.GH_CONFIG_DIR).not.toBe("/home/dev/.config/gh");
  });

  it("gives the browser run the second origin as E2E_GIT_ANY_BASE_URL when the run has one, and nothing when it has none", () => {
    expect(phasesEnvironment(base, { ...RUN, outputRoot: "/out", authState: "/a.json", gitAnyBaseUrl: SECOND }).E2E_GIT_ANY_BASE_URL).toBe(SECOND);
    expect(phasesEnvironment(base, { ...RUN, outputRoot: "/out", authState: "/a.json" })).not.toHaveProperty("E2E_GIT_ANY_BASE_URL");
  });

  it("a shell value of E2E_GIT_ANY_BASE_URL is dropped (the E2E_ prefix is the runner's): only the run's own reaches the browser run", () => {
    const shell = hermeticEnv({ ...DEVELOPER, E2E_GIT_ANY_BASE_URL: "http://shell.example" });
    expect(shell).not.toHaveProperty("E2E_GIT_ANY_BASE_URL");
    expect(phasesEnvironment(shell, { ...RUN, outputRoot: "/out", authState: "/a.json" })).not.toHaveProperty("E2E_GIT_ANY_BASE_URL");
  });
});

describe("a fake developer environment never reaches a child", () => {
  const base = hermeticEnv(DEVELOPER);
  const app = appEnvironment(base, RUN);
  const phases = phasesEnvironment(base, { ...RUN, outputRoot: "/out", authState: "/tmp/ss-e2e-x/admin.json" });

  it("the app gets the run's own auth origin and secret under both names Auth.js reads (it prefers AUTH_* over NEXTAUTH_*)", () => {
    expect(app.AUTH_URL).toBe(RUN.baseUrl);
    expect(app.NEXTAUTH_URL).toBe(RUN.baseUrl);
    expect(app.AUTH_SECRET).toBe("run-secret");
    expect(app.NEXTAUTH_SECRET).toBe("run-secret");
    expect(app.AUTH_TRUST_HOST).toBe("true");
  });

  it("the app gets the run's database, on PostgreSQL, with PGlite pointed at the run's temp directory", () => {
    expect(app.DATABASE_URL).toBe(RUN.databaseUrl);
    expect(app.E2E_DATABASE_URL).toBe(RUN.databaseUrl);
    expect(app.DB_PROVIDER).toBe("postgresql");
    expect(app.PGLITE_DATA_DIR).toBe(RUN.pgliteDir);
  });

  it("the developer's feature toggles and secrets are empty strings, not missing (a missing name is filled in by a .env)", () => {
    for (const name of ["AI_PROVIDER", "AI_BASE_URL", "GOOGLE_CLIENT_ID", "PGPASSWORD", "SCHEMA_IMPORT_GIT_MODE", "ASYNCAPI_PARSER_IN_PROCESS"]) {
      expect(app[name], name).toBe("");
    }
    for (const name of HERMETIC_BLANKED_NAMES) expect(app[name], name).toBe("");
  });

  it("the REST API key is the run's own (a developer's API_KEY is dropped), the app gets it as API_KEY and the browser run as E2E_API_KEY", () => {
    expect(app.API_KEY).toBe(RUN.apiKey);
    expect(phases.E2E_API_KEY).toBe(RUN.apiKey);
    expect(phases).not.toHaveProperty("API_KEY");
    expect(app).not.toHaveProperty("E2E_API_KEY");
    expect(phasesEnvironment(base, { ...RUN, apiKey: undefined, outputRoot: "/out", authState: "/a.json" })).not.toHaveProperty("E2E_API_KEY");
  });

  it("nothing of the developer's values is left in any child's environment", () => {
    const text = JSON.stringify({ app, phases });
    for (const value of ["dev-auth-secret", "dev-google-id", "dev-api-key", "devpass", "db.internal", "dev-ai", "dev@example.com", "localhost:3000"]) {
      expect(text, value).not.toContain(value);
    }
  });

  it("the browser run drops what it must not inherit, blanks nothing (it loads no .env; a blank TEST_EMAIL would be the login \"\")", () => {
    expect(phases.TEST_EMAIL).toBeUndefined();
    expect(phases.AI_PROVIDER).toBeUndefined();
    expect(phases.PGPASSWORD).toBeUndefined();
    expect(phases.E2E_BASE_URL).toBe(RUN.baseUrl);
    expect(phases.E2E_OUTPUT_ROOT).toBe("/out");
    expect(phases.E2E_AUTH_STATE).toBe("/tmp/ss-e2e-x/admin.json");
    expect(phases.DATABASE_URL).toBe(RUN.databaseUrl);
    expect(phases.PATH).toBe("/usr/bin");
  });

  describe("the browser channel (E2E_BROWSER_CHANNEL)", () => {
    const run = { ...RUN, outputRoot: "/out", authState: "/tmp/ss-e2e-x/admin.json" };

    it("is the runner's decision in the browser run's environment, whatever the developer's shell says", () => {
      expect(phasesEnvironment(base, { ...run, browserChannel: "chrome" }).E2E_BROWSER_CHANNEL).toBe("chrome");
      expect(phasesEnvironment(base, { ...run, browserChannel: "chromium" }).E2E_BROWSER_CHANNEL).toBe("chromium");
    });

    it("is not defined for the browser run when the runner decided nothing (the shell's own value does not slip through)", () => {
      expect(base.E2E_BROWSER_CHANNEL).toBeUndefined();
      expect(phases.E2E_BROWSER_CHANNEL).toBeUndefined();
    });

    it("never reaches the app, the migration, the seed or the build: the app has no use for it, and a run's server is the same for both browsers", () => {
      expect(app.E2E_BROWSER_CHANNEL).toBeUndefined();
      expect(Object.keys(app).filter((name) => name.includes("BROWSER"))).toEqual([]);
    });

    it("is dropped from the shell like every other E2E_ name (the runner's decision is the only way in)", () => {
      expect(hermeticEnv({ E2E_BROWSER_CHANNEL: "chrome", KEEP_ME: "y" })).toEqual({ KEEP_ME: "y" });
    });
  });

  it("drops a name added later under a prefix the runner owns", () => {
    expect(hermeticEnv({ AUTH_FUTURE_THING: "x", AI_FUTURE: "x", PGFUTURE: "x", E2E_FUTURE: "x", ASYNCAPI_PARSER_FUTURE: "x", KEEP_ME: "y" })).toEqual({ KEEP_ME: "y" });
  });

  it("keeps the allowed names", () => {
    expect(hermeticEnv({ NODE_OPTIONS: "--max-old-space-size=4096", NEXT_PUBLIC_APP_URL: "https://app.example" })).toEqual({
      NODE_OPTIONS: "--max-old-space-size=4096",
      NEXT_PUBLIC_APP_URL: "https://app.example",
    });
  });

  it("setValues has a value for every name it lists", () => {
    expect(Object.keys(setValues(RUN)).sort()).toEqual([...HERMETIC_SET_NAMES].sort());
  });
});

describe("a name defined as an empty string beats a checkout's .env in the loaders the app uses (a real probe)", () => {
  /** A checkout directory whose .env holds a developer's settings. */
  function checkoutWithLeakyEnv(): string {
    const dir = mkdtempSync(path.join(tmpdir(), "e2e-env-probe-"));
    writeFileSync(
      path.join(dir, ".env"),
      ["AUTH_URL=http://leak", "AUTH_SECRET=leak-secret", "AI_PROVIDER=ollama", "GOOGLE_CLIENT_ID=leak-google", "API_KEY=leak-key", "DATABASE_URL=postgresql://leak@nowhere/leak", "ONLY_IN_THE_FILE=from-the-file", ""].join("\n"),
    );
    return dir;
  }
  const expected = (env: Record<string, string>) => ({
    AUTH_URL: env.AUTH_URL,
    AUTH_SECRET: env.AUTH_SECRET,
    AI_PROVIDER: "",
    GOOGLE_CLIENT_ID: "",
    API_KEY: env.API_KEY, // the run's own key, not the .env's
    DATABASE_URL: env.DATABASE_URL,
    ONLY_IN_THE_FILE: "from-the-file", // the loader did run: it filled in what the process environment does not define
  });
  const app = appEnvironment(hermeticEnv(DEVELOPER), RUN);
  const names = ["AUTH_URL", "AUTH_SECRET", "AI_PROVIDER", "GOOGLE_CLIENT_ID", "API_KEY", "DATABASE_URL", "ONLY_IN_THE_FILE"];

  it("dotenv (seed, scripts/db.ts) and Next's loadEnvConfig (build, start) leave the run's values and the blanks alone", () => {
    const dir = checkoutWithLeakyEnv();
    try {
      const script = `
        const { createRequire } = require("node:module");
        const path = require("node:path");
        const require2 = createRequire(path.join(${JSON.stringify(REPO)}, "package.json"));
        const names = ${JSON.stringify(names)};
        const read = () => Object.fromEntries(names.map((n) => [n, process.env[n]]));
        require2("dotenv").config({ path: path.join(process.cwd(), ".env"), quiet: true });
        const dotenv = read();
        for (const n of names) delete process.env[n];
        Object.assign(process.env, JSON.parse(process.argv[1]));
        require2("@next/env").loadEnvConfig(process.cwd(), false, { info() {}, error() {} }, true);
        console.log(JSON.stringify({ dotenv, next: read() }));
      `;
      // Each loader starts from the same process environment: the app's, as the runner assembles it.
      const childEnv = { ...app, PATH: process.env.PATH ?? "" } as unknown as NodeJS.ProcessEnv;
      const run = spawnSync(process.execPath, ["-e", script, JSON.stringify(Object.fromEntries(names.filter((n) => n in app).map((n) => [n, app[n]])))], { cwd: dir, env: childEnv, encoding: "utf8" });
      expect(run.stderr).toBe("");
      const seen = JSON.parse(run.stdout);
      expect(seen.dotenv).toEqual(expected(app));
      expect(seen.next).toEqual(expected(app));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the checkout's own loader (prisma/load-env-file.ts, used by prisma.config.ts) does too", () => {
    const dir = checkoutWithLeakyEnv();
    const before = Object.fromEntries(names.map((n) => [n, process.env[n]]));
    try {
      for (const n of names) delete process.env[n];
      Object.assign(process.env, Object.fromEntries(names.filter((n) => n in app).map((n) => [n, app[n]])));
      loadEnvFile(path.join(dir, ".env"));
      expect(Object.fromEntries(names.map((n) => [n, process.env[n]]))).toEqual(expected(app));
    } finally {
      for (const n of names) {
        if (before[n] === undefined) delete process.env[n];
        else process.env[n] = before[n];
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("and a name that is merely missing is filled in by the file: the leak the groups exist to stop", () => {
    const dir = checkoutWithLeakyEnv();
    const before = process.env.AUTH_URL;
    try {
      delete process.env.AUTH_URL;
      loadEnvFile(path.join(dir, ".env"));
      expect(process.env.AUTH_URL).toBe("http://leak");
    } finally {
      if (before === undefined) delete process.env.AUTH_URL;
      else process.env.AUTH_URL = before;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the app does not read a name that no group accounts for", () => {
  const accounted = new Set<string>([
    ...HERMETIC_SET_NAMES,
    ...HERMETIC_BLANKED_NAMES,
    ...Object.keys(HERMETIC_DROPPED_NAMES),
    ...Object.keys(HERMETIC_ALLOWED_NAMES),
  ]);

  function sourceFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const file = path.join(dir, name);
      if (name === "generated" || name === "node_modules") return [];
      if (statSync(file).isDirectory()) return sourceFiles(file);
      return /\.(ts|tsx|mjs|js)$/.test(name) ? [file] : [];
    });
  }

  /** The names a file reads: `process.env.X`, `process.env["X"]`, `env.X` / `env["X"]` (a passed environment), `*_ENV = "X"` constants, and the names handed to the readers that take one. */
  function namesRead(text: string): string[] {
    const found = new Set<string>();
    const add = (re: RegExp, group = 1) => {
      for (const m of text.matchAll(re)) found.add(m[group]);
    };
    add(/\bprocess\.env\.([A-Z][A-Z0-9_]*)/g);
    add(/\bprocess\.env\[\s*"([A-Z][A-Z0-9_]*)"\s*\]/g);
    add(/\benv\.([A-Z][A-Z0-9_]{2,})\b/g);
    add(/\benv\[\s*"([A-Z][A-Z0-9_]*)"\s*\]/g);
    add(/\b[A-Z][A-Z0-9_]*_ENV\s*=\s*"([A-Z][A-Z0-9_]*)"/g);
    // readName(env, "NAME", ...) / positiveNumber("NAME") / positiveNumber(cond ? "A" : "B")
    for (const call of text.matchAll(/\b(?:readName|positiveNumber)\(([^)]*)\)/g)) {
      for (const literal of call[1].matchAll(/"([A-Z][A-Z0-9_]{4,})"/g)) found.add(literal[1]);
    }
    return [...found];
  }

  const files = [...sourceFiles(path.join(REPO, "src")), path.join(REPO, "prisma.config.ts"), path.join(REPO, "prisma", "seed.ts"), path.join(REPO, "next.config.ts"), path.join(REPO, "scripts", "db.ts")];

  it("every environment name read by src, the seed, prisma.config.ts, next.config.ts and scripts/db.ts is in a group", () => {
    const unaccounted: string[] = [];
    for (const file of files) {
      for (const name of namesRead(readFileSync(file, "utf8"))) {
        if (!accounted.has(name)) unaccounted.push(`${path.relative(REPO, file)}: ${name}`);
      }
    }
    expect(unaccounted, "add the name to SET, BLANKED, DROPPED or ALLOWED in scripts/e2e-env.mjs (with its reason)").toEqual([]);
    // (a whole-repository scan: 6 s and 8 s under the load of the whole suite, so a 60 s limit instead of the default 5 s)
  }, 60_000);

  it("finds the names it is meant to find (the scan itself is not empty)", () => {
    const all = new Set(files.flatMap((file) => namesRead(readFileSync(file, "utf8"))));
    for (const name of ["DATABASE_URL", "GOOGLE_CLIENT_ID", "AI_PROVIDER", "API_KEY", "SCHEMA_IMPORT_GIT_MODE", "SCHEMA_CLASSIFICATION_VALUE_MAP", "ASYNCAPI_PARSER_WORKER", "ASYNCAPI_PARSER_PARSE_TIMEOUT_MS", "NEXT_PUBLIC_APP_URL"]) {
      expect(all.has(name), name).toBe(true);
    }
  }, 60_000);

  it("every server and client name declared in src/env.ts is in a group", () => {
    const text = readFileSync(path.join(REPO, "src", "env.ts"), "utf8");
    const declared = [...text.matchAll(/^\s+([A-Z][A-Z0-9_]+):\s*z\./gm)].map((m) => m[1]);
    expect(declared.length).toBeGreaterThanOrEqual(5);
    expect(declared.filter((name) => !accounted.has(name))).toEqual([]);
  });
});

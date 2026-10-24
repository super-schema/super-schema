// The environment of a release run (scripts/e2e-release.mjs): what its children get, and why. Dependency-free; unit tested in
// tests/unit/scripts/e2e-env.test.ts, which also reads the app's source and fails when the app starts to read an environment name that
// is not accounted for here.
//
// Why a name the runner merely DROPS from the shell is not enough: the app reads a checkout's `.env` (Next's loadEnvConfig for
// `next build` / `next start`, `dotenv/config` in `prisma/seed.ts` and `scripts/db.ts`, `prisma/load-env-file.ts` for `prisma.config.ts`),
// and each of them fills in every name that the PROCESS environment does not define. So a developer's `.env` with `AUTH_URL=http://localhost:3000`
// or `GOOGLE_CLIENT_ID=...` would come back through the loaders after the runner had dropped it from the shell. A name that is DEFINED in
// the process environment wins in all three loaders, even as an empty string (tests/unit/scripts/e2e-env.test.ts runs that probe against
// a real `.env`). Every name the app reads is therefore in exactly one of four groups:
//
//   SET      the run's own value (database, auth origin and secret, ...);
//   BLANKED  defined as "" for the children that load a `.env` (app, migrate, seed, build): the app treats "" as "not configured";
//   DROPPED  removed from the shell and left undefined: where "" would mean something other than the default, or no loader of a `.env`
//            reaches it (NODE_ENV is Next's, TEST_EMAIL is read by the browser run, which loads no `.env`);
//   ALLOWED  read by the app and passed through from the shell on purpose, with the reason.
//
// A fifth group is for the browser run alone, which the app never sees:
//
//   BROWSER RUN  E2E_BROWSER_CHANNEL (`chrome` | `chromium`, scripts/e2e-browser.cjs). The shell's value is dropped like every E2E_ name
//            (that prefix is the runner's); the runner decides the channel from it (an explicit value wins, CI forces the bundled
//            Chromium, else Chrome when the machine has it) and sets its decision for the browser run only (`phasesEnvironment`).

/** The defaults of the classification importer (src/lib/importers/classification-config.ts; a unit test pins these to its constants). */
export const CLASSIFICATION_DEFAULTS = {
  SCHEMA_CLASSIFICATION_EXTENSION_KEY: "x-securityClassification",
  SCHEMA_CLASSIFICATION_LEVEL_FIELD: "data_class",
  SCHEMA_CLASSIFICATION_CATEGORY_FIELD: "data_category",
};

/**
 * What the run decides, for the children that start the app or prepare its database. `run` is `{ databaseUrl, baseUrl, authSecret, pgliteDir }`.
 *
 * AUTH_URL and AUTH_SECRET are SET, not blanked: Auth.js prefers them over the NEXTAUTH_* pair (`AUTH_URL ?? NEXTAUTH_URL`: an empty
 * string is not nullish, so a blank AUTH_URL would also switch off NEXTAUTH_URL and the secret).
 *
 * @param {{ databaseUrl: string, baseUrl: string, authSecret: string, pgliteDir: string }} run
 * @returns {Record<string, string>}
 */
export function setValues(run) {
  return {
    DB_PROVIDER: "postgresql",
    DATABASE_URL: run.databaseUrl,
    E2E_DATABASE_URL: run.databaseUrl,
    PGLITE_DATA_DIR: run.pgliteDir, // a mistake must not reach ./data/pglite
    NEXTAUTH_SECRET: run.authSecret,
    NEXTAUTH_URL: run.baseUrl,
    AUTH_SECRET: run.authSecret,
    AUTH_URL: run.baseUrl,
    AUTH_TRUST_HOST: "true",
    ...CLASSIFICATION_DEFAULTS, // "" is not their default (it warns and falls back), so the defaults themselves
  };
}

const PLACEHOLDER = { databaseUrl: "", baseUrl: "", authSecret: "", pgliteDir: "" };
export const HERMETIC_SET_NAMES = Object.freeze(Object.keys(setValues(PLACEHOLDER)));

/** Defined as "" for the app, migrate, seed and build: every optional feature toggle, secret or connection setting a `.env` could supply. */
export const HERMETIC_BLANKED_NAMES = Object.freeze([
  // src/env.ts and src/lib/auth.ts: the Google sign-in (its presence adds the provider and the login button)
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  // Auth.js: a proxy for OAuth callbacks, rotated secrets
  "AUTH_REDIRECT_PROXY_URL",
  "AUTH_SECRET_1",
  "AUTH_SECRET_2",
  "AUTH_SECRET_3",
  // src/services/ai.service.ts: the AI assistant (without a provider and a base URL there is no client)
  "AI_PROVIDER",
  "AI_BASE_URL",
  "AI_MODEL",
  // src/app/api/v1/middleware.ts: the REST API key (empty = key authentication is off)
  "API_KEY",
  // prisma: other connection strings
  "DIRECT_URL",
  "SHADOW_DATABASE_URL",
  // src/lib/importers: git-host import (empty = restricted, no scopes: the default), the classification value map (empty = identity)
  "SCHEMA_IMPORT_GIT_MODE",
  "SCHEMA_IMPORT_GIT_SCOPES",
  "SCHEMA_CLASSIFICATION_VALUE_MAP",
  // src/lib/event-specs/validation: the parser worker pool (empty = its defaults; ASYNCAPI_PARSER_IN_PROCESS=1 would move the parser into the server process)
  "ASYNCAPI_PARSER_IN_PROCESS",
  "ASYNCAPI_PARSER_WORKER",
  "ASYNCAPI_PARSER_WORKERS",
  "ASYNCAPI_PARSER_PARSE_TIMEOUT_MS",
  "ASYNCAPI_PARSER_VALIDATE_TIMEOUT_MS",
  "ASYNCAPI_PARSER_START_TIMEOUT_MS",
  "ASYNCAPI_PARSER_MAX_MESSAGE_BYTES",
  "ASYNCAPI_PARSER_REBUILD_BACKOFF_MS",
  "ASYNCAPI_PARSER_BREAKER_MS",
  // src/services/health.service.ts: the health probe's thresholds (empty = its defaults, 500 ms degraded and 5000 ms timeout)
  "HEALTH_DB_DEGRADED_MS",
  "HEALTH_DB_TIMEOUT_MS",
  // libpq / node-pg read these when the connection string does not carry them (an empty value is "not set" to node-pg)
  "PGHOST",
  "PGHOSTADDR",
  "PGPORT",
  "PGDATABASE",
  "PGUSER",
  "PGPASSWORD",
  "PGPASSFILE",
  "PGSERVICE",
  "PGSERVICEFILE",
  "PGSSLMODE",
  "PGSSLCERT",
  "PGSSLKEY",
  "PGSSLROOTCERT",
  "PGOPTIONS",
  "PGAPPNAME",
  "PGCONNECT_TIMEOUT",
]);

/** Removed from the shell and not defined for any child (see the header: "" would not be their default, or no `.env` loader reaches them). */
export const HERMETIC_DROPPED_NAMES = Object.freeze({
  NODE_ENV: "Next sets it for `next build` / `next start`; a value of the shell would only draw a warning",
  PORT: "the app is started with -p; the runner's own port is the only one",
  HOSTNAME: "the app is started with -H 127.0.0.1",
  TEST_EMAIL: "read by the browser run (which loads no .env); the seeded admin is the contract",
  TEST_PASSWORD: "read by the browser run like TEST_EMAIL; the seeded admin's password is the contract",
});

/** Read by the app and passed through from the shell on purpose. */
export const HERMETIC_ALLOWED_NAMES = Object.freeze({
  NEXT_PUBLIC_APP_URL: "baked into the build (git-pr.service.ts); part of the build fingerprint, so a different value is a different build",
  NODE_OPTIONS: "the developer's Node flags (memory limits, proxies' CA); not an app setting",
});

/** Read by the browser run only (never the app, the migration, the seed or the build), and set from the runner's own decision, not passed through. */
export const HERMETIC_BROWSER_RUN_NAMES = Object.freeze({
  E2E_BROWSER_CHANNEL: "which browser the browser run uses, chrome or chromium: decided by the runner (scripts/e2e-browser.cjs) and set for the phases script and Playwright alone",
});

/** Prefixes of the names the runner owns or the app reads: whatever the shell has under them is dropped (the unit test pins the groups above, these catch names added later). */
const OWNED_PREFIXES = /^(PG[A-Z_]+|AUTH_[A-Z0-9_]+|NEXTAUTH_[A-Z0-9_]+|E2E_[A-Z0-9_]+|ASYNCAPI_PARSER_[A-Z_]+|AI_[A-Z_]+|SCHEMA_(IMPORT|CLASSIFICATION)_[A-Z_]+)$/;

const ACCOUNTED = new Set([...HERMETIC_SET_NAMES, ...HERMETIC_BLANKED_NAMES, ...Object.keys(HERMETIC_DROPPED_NAMES)]);

/**
 * The shell's environment without a developer's settings: every name of the SET, BLANKED and DROPPED groups, and whatever else is under a
 * prefix the runner owns (PG*, AUTH_*, NEXTAUTH_*, E2E_*, ASYNCAPI_PARSER_*, AI_*, SCHEMA_IMPORT_* / SCHEMA_CLASSIFICATION_*), is left out.
 *
 * @param {Record<string, string | undefined>} env
 * @returns {Record<string, string>}
 */
export function hermeticEnv(env) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || ACCOUNTED.has(key) || OWNED_PREFIXES.test(key)) continue;
    out[key] = value;
  }
  return out;
}

/**
 * The environment of the app and of what prepares its database (migrate, seed, build): the shell's rest, every blanked name as "", then
 * the run's own values.
 *
 * @param {Record<string, string>} base `hermeticEnv(shell)`
 * @param {{ databaseUrl: string, baseUrl: string, authSecret: string, pgliteDir: string }} run
 * @returns {Record<string, string>}
 */
export function appEnvironment(base, run) {
  return { ...base, ...Object.fromEntries(HERMETIC_BLANKED_NAMES.map((name) => [name, ""])), ...setValues(run) };
}

/**
 * The environment of the browser run: the shell's rest and what points it at the run. No name is blanked here: the browser run loads no
 * `.env` (a blank TEST_EMAIL would be the login "" and not the seeded admin).
 *
 * `run.browserChannel` is the runner's decision (`chrome` | `chromium`); the browser run gets it as E2E_BROWSER_CHANNEL, and gets nothing
 * when the runner decided nothing (the shell's own value was dropped from `base`).
 *
 * @param {Record<string, string>} base
 * @param {{ databaseUrl: string, baseUrl: string, outputRoot: string, authState: string, browserChannel?: string }} run
 * @returns {Record<string, string>}
 */
export function phasesEnvironment(base, run) {
  return {
    ...base,
    ...(run.browserChannel ? { E2E_BROWSER_CHANNEL: run.browserChannel } : {}),
    DB_PROVIDER: "postgresql",
    DATABASE_URL: run.databaseUrl,
    E2E_DATABASE_URL: run.databaseUrl,
    E2E_BASE_URL: run.baseUrl,
    E2E_OUTPUT_ROOT: run.outputRoot,
    E2E_AUTH_STATE: run.authState,
  };
}

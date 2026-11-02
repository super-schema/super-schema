// The environment of a release run (scripts/e2e-release.mjs): what its children get, and why. Dependency-free; unit tested in
// tests/unit/scripts/e2e-env.test.ts, which also reads the app's source and fails when the app starts to read an environment name that
// is not accounted for here.
//
// Why a name the runner merely DROPS from the shell is not enough: the app reads a checkout's `.env` (Next's loadEnvConfig for
// `next build` / `next start`, `dotenv/config` in `prisma/seed.ts` and `scripts/db.ts`, `prisma/load-env-file.ts` for `prisma.config.ts`),
// and each of them fills in every name that the PROCESS environment does not define. So a developer's `.env` with `AUTH_URL=http://localhost:3000`
// or `AUTH_PROVIDERS=...` would come back through the loaders after the runner had dropped it from the shell. A name that is DEFINED in
// the process environment wins in all three loaders, even as an empty string (tests/unit/scripts/e2e-env.test.ts runs that probe against
// a real `.env`). Every name the app reads is therefore in exactly one of four groups:
//
//   SET      the run's own value (database, auth origin and secret, the REST API key, ...);
//   BLANKED  defined as "" for the children that load a `.env` (app, migrate, seed, build): the app treats "" as "not configured";
//   DROPPED  removed from the shell and left undefined: where "" would mean something other than the default, or no loader of a `.env`
//            reaches it (NODE_ENV is Next's, TEST_EMAIL is read by the browser run, which loads no `.env`);
//   ALLOWED  read by the app and passed through from the shell on purpose, with the reason.
//
// Two more groups are for the browser run alone, which the app never sees (and the run's own values for it: E2E_BASE_URL, E2E_DATABASE_URL,
// E2E_OUTPUT_ROOT, E2E_AUTH_STATE, E2E_API_KEY, and, when the run started a second app, E2E_GIT_ANY_BASE_URL (the origin of the app that runs
// with SCHEMA_IMPORT_GIT_MODE=any: `secondAppEnvironment`)):
//
//   BROWSER RUN  E2E_BROWSER_CHANNEL (`chrome` | `chromium`, scripts/e2e-browser.cjs). The shell's value is dropped like every E2E_ name
//            (that prefix is the runner's); the runner decides the channel from it (an explicit value wins, CI forces the bundled
//            Chromium, else Chrome when the machine has it) and sets its decision for the browser run only (`phasesEnvironment`).
//            (`E2E_ALLOW_REUSE_SERVER` is not one of them: it is read by playwright.config.ts for a bare `playwright test` only, scripts/e2e-direct.cjs,
//            and the runner always sets E2E_BASE_URL, so a release run never starts or reuses a server of its own.)
//   KNOBS    the runner's own settings (E2E_ALLOW_UNSUPPORTED_NODE, E2E_ALLOW_SKIPS, E2E_STALL_MS, E2E_GLOBAL_TIMEOUT_MS): read from the shell by the
//            release runner, checked there, and handed to the browser run exactly as set (`runnerKnobs`, `phasesEnvironment`); the
//            E2E_ prefix would otherwise drop them on the way, and the phases script and Playwright read them.

/** The defaults of the classification importer (src/lib/importers/classification-config.ts; a unit test pins these to its constants). */
export const CLASSIFICATION_DEFAULTS = {
  SCHEMA_CLASSIFICATION_EXTENSION_KEY: "x-securityClassification",
  SCHEMA_CLASSIFICATION_LEVEL_FIELD: "data_class",
  SCHEMA_CLASSIFICATION_CATEGORY_FIELD: "data_category",
};

/**
 * What the run decides, for the children that start the app or prepare its database. `run` is `{ databaseUrl, baseUrl, authSecret, pgliteDir, apiKey }`.
 *
 * API_KEY is SET to a random key of the run (not blanked): the REST API's key authentication (`Authorization: Bearer <key>`, src/app/api/v1/middleware.ts)
 * is a service principal (src/lib/access/api-key.ts) acting in `API_KEY_TENANT_ID` with `API_KEY_ROLE`, both blanked below so the key is an administrator of the
 * default tenant, and the webhook endpoints are for platform administrators (the seeded admin's own session is one too). The browser run
 * is told the same key as E2E_API_KEY (`phasesEnvironment`) so tests/e2e/api-v1.spec.ts can call the API as a key holder. The key never leaves
 * the run: it is random per run, it lives in two children's environments, and a developer's own API_KEY is dropped like any other.
 *
 * AUTH_URL and AUTH_SECRET are SET, not blanked: Auth.js prefers them over the NEXTAUTH_* pair (`AUTH_URL ?? NEXTAUTH_URL`: an empty
 * string is not nullish, so a blank AUTH_URL would also switch off NEXTAUTH_URL and the secret).
 *
 * @param {{ databaseUrl: string, baseUrl: string, authSecret: string, pgliteDir: string, apiKey: string }} run
 * @returns {Record<string, string>}
 */
export function setValues(run) {
  return {
    API_KEY: run.apiKey,
    DB_PROVIDER: "postgresql",
    DATABASE_URL: run.databaseUrl,
    E2E_DATABASE_URL: run.databaseUrl,
    PGLITE_DATA_DIR: run.pgliteDir, // a mistake must not reach ./data/pglite
    NEXTAUTH_SECRET: run.authSecret,
    NEXTAUTH_URL: run.baseUrl,
    AUTH_SECRET: run.authSecret,
    AUTH_URL: run.baseUrl,
    AUTH_TRUST_HOST: "true",
    // The client address of the sign-in throttle and of the REST API's rate limit comes from X-Forwarded-For ONLY when this is 1 (src/lib/auth/throttle.ts
    // `clientIp`). The run trusts it: tests/e2e/api-v1.spec.ts sends an address of its own per test so the 100-a-minute limit never couples two tests. A request
    // with no header (the browser's) reaches the app with the socket's own loopback address, which `clientIp` treats as the one shared bucket (ceiling 100), as
    // without the setting. A developer's own value is dropped (the AUTH_ prefix).
    AUTH_TRUST_PROXY: "1",
    // Registration is OPEN for the app under test (src/lib/auth/registration-mode.ts; the default is `invite`): the browser suite registers its own users through the
    // register page, and they hold no role. `invite` and `closed` are covered at the unit and action level (tests/unit/app/register-actions.test.ts).
    AUTH_REGISTRATION: "open",
    // The git host the importer recognises (fetched through `gh`): the e2e git-import tests use https://github.example.com/... URLs, so it must be allowlisted
    // for the restricted-mode refusal and the any-mode test to reach the git path. A developer's own value is dropped.
    SCHEMA_IMPORT_GIT_HOSTS: "github.example.com",
    ...CLASSIFICATION_DEFAULTS, // "" is not their default (it warns and falls back), so the defaults themselves
  };
}

const PLACEHOLDER = { databaseUrl: "", baseUrl: "", authSecret: "", pgliteDir: "", apiKey: "" };
export const HERMETIC_SET_NAMES = Object.freeze(Object.keys(setValues(PLACEHOLDER)));

/**
 * The providers of the table in src/lib/auth/providers.ts as far as environment names go (this module has no dependencies, so it cannot import the table:
 * tests/unit/scripts/e2e-env.test.ts pins this list to the table's own `providerEnvNames()`, so a provider added there fails the test until it is added here).
 */
const PROVIDER_ENV_SETTINGS = [
  { key: "google", issuer: false },
  { key: "github", issuer: false },
  { key: "microsoft-entra-id", issuer: true },
  { key: "okta", issuer: true },
  { key: "keycloak", issuer: true },
  { key: "oidc", issuer: true },
];

/** `AUTH_PROVIDER_<KEY>_<SETTING>` for every provider and setting: blanked below. */
export const PROVIDER_SETTING_NAMES = Object.freeze(
  PROVIDER_ENV_SETTINGS.flatMap(({ key, issuer }) =>
    ["CLIENT_ID", "CLIENT_SECRET", ...(issuer ? ["ISSUER"] : []), "ALLOWED_DOMAINS", "LINK_EXISTING_USERS", "LABEL"].map((setting) => `AUTH_PROVIDER_${key.toUpperCase().replace(/-/g, "_")}_${setting}`),
  ),
);

/** Defined as "" for the app, migrate, seed and build: every optional feature toggle, secret or connection setting a `.env` could supply. */
export const HERMETIC_BLANKED_NAMES = Object.freeze([
  // src/env.ts, src/lib/auth.ts and src/lib/auth/providers.ts: the identity providers offered next to local accounts (a comma list of provider keys). Blank = none:
  // the run is checked with the seeded administrator only, and a provider listed by a developer's `.env` would add a button and a callback (`judgeProviders` stops
  // a run whose app offers any)
  "AUTH_PROVIDERS",
  // ... and each provider's own settings (client id and secret, issuer, button text, allowed domains, linking flag), AUTH_PROVIDER_<KEY>_<SETTING>: only read for a
  // provider that AUTH_PROVIDERS lists, blanked as well so that a `.env` cannot leave half a provider behind
  ...PROVIDER_SETTING_NAMES,
  // prisma/seed.ts (src/lib/admin-bootstrap.ts): the administrator the seed makes. Blank = not configured, so the seed makes the development
  // default admin@admin.com / admin, the contract of the browser suite; a developer's own bootstrap administrator must not replace it
  "BOOTSTRAP_ADMIN_EMAIL",
  "BOOTSTRAP_ADMIN_PASSWORD",
  // src/lib/access/api-key.ts: which tenant and role the REST API key (the run's own API_KEY) acts as. Blank = the defaults, the default tenant and ADMIN,
  // which is what the browser suite's API tests rely on; a developer's own binding must not change what they test
  "API_KEY_TENANT_ID",
  "API_KEY_ROLE",
  // Auth.js: a proxy for OAuth callbacks, rotated secrets
  "AUTH_REDIRECT_PROXY_URL",
  "AUTH_SECRET_1",
  "AUTH_SECRET_2",
  "AUTH_SECRET_3",
  // src/lib/crypto/secret-box.ts: the key that seals the stored Git credential and webhook signing secret. Blank = not configured, so the run's key
  // is derived from its own AUTH_SECRET (a random secret per run): a developer's own key must not seal the rows of the run
  "SECRETS_ENCRYPTION_KEY",
  // src/services/ai-config.service.ts: the AI assistant (without a provider and a base URL there is no client). AI_API_KEY is its bearer key; OLLAMA_HOST
  // and OPENAI_BASE_URL are the standard names it falls back to when AI_BASE_URL is unset. A developer's own AI server must not configure the run
  "AI_PROVIDER",
  "AI_BASE_URL",
  "AI_MODEL",
  "AI_API_KEY",
  "OLLAMA_HOST",
  "OPENAI_BASE_URL",
  // prisma: other connection strings
  "DIRECT_URL",
  "SHADOW_DATABASE_URL",
  // src/lib/importers: git-host import (empty = restricted, no scopes: the default), the classification value map (empty = identity)
  "SCHEMA_IMPORT_GIT_MODE",
  "SCHEMA_IMPORT_GIT_SCOPES",
  "SCHEMA_CLASSIFICATION_VALUE_MAP",
  // src/lib/importers/safe-yaml.ts: the size a YAML document may have before it is parsed (empty = its default, 512 KiB)
  "SCHEMA_IMPORT_MAX_YAML_BYTES",
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
  NEXT_RUNTIME: "set by Next itself inside the server (`nodejs` or `edge`); src/instrumentation.ts only reads it, a value of the shell would mean nothing",
  NEXT_PHASE: "set by Next itself while it builds (`phase-production-build`); src/instrumentation.ts only reads it, a value of the shell would skip the startup check",
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

/** The runner's own settings: read from the shell, handed to the browser run when set. Never to the app (it reads none of them). */
export const HERMETIC_RUNNER_KNOB_NAMES = Object.freeze({
  E2E_ALLOW_UNSUPPORTED_NODE: "`1` lets a Node that the suite refuses (not 20.9+, 22 or 24: scripts/e2e-node.cjs) run it; the phases script checks it again",
  E2E_ALLOW_SKIPS: "`1` lets a run skip tests that are not tagged @external without failing (the skipped-test gate of scripts/e2e-phases.mjs; every skip is still listed); never set by CI",
  E2E_STALL_MS: "how long the phases script waits for a sign of life from Playwright (the heartbeat file) before it ends it with exit 124; default 20 minutes (above the longest test timeout)",
  E2E_GLOBAL_TIMEOUT_MS: "playwright.config.ts globalTimeout: a hard ceiling for the whole Playwright run (CI sets it); unset means none",
});

/**
 * The knobs the shell has set (a name that is unset or empty is left out), for the browser run.
 *
 * @param {Record<string, string | undefined>} env
 * @returns {Record<string, string>}
 */
export function runnerKnobs(env) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const name of Object.keys(HERMETIC_RUNNER_KNOB_NAMES)) {
    const value = env[name];
    if (value !== undefined && value !== "") out[name] = value;
  }
  return out;
}

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
 * @param {{ databaseUrl: string, baseUrl: string, authSecret: string, pgliteDir: string, apiKey: string }} run
 * @returns {Record<string, string>}
 */
export function appEnvironment(base, run) {
  return { ...base, ...Object.fromEntries(HERMETIC_BLANKED_NAMES.map((name) => [name, ""])), ...setValues(run) };
}

/**
 * The environment of the SECOND app of a run that includes the @external tests (the git-host import in `any` mode needs a server of its own:
 * the mode is read from the environment when the app starts): the first app's environment (the same database, secret, API key and build), the
 * origin of ITS OWN port for Auth.js (a sign-in URL of the other port would send a login to the other server), and
 * `SCHEMA_IMPORT_GIT_MODE=any`, the one name that is blank for the first app and set here.
 *
 * It also runs `AUTH_REGISTRATION=invite`, the product's own default (src/lib/auth/registration-mode.ts), where the first app runs `open` (the suite registers its own
 * users through the register page): the registration mode is read when the app starts too, so a server of the other mode is the only way a browser test can see
 * what `invite` does (tests/e2e/access-matrix.spec.ts: no register form, a token needed). The git-host test only logs in on it, which works in every mode. No new name:
 * AUTH_REGISTRATION is already in the SET group, and the browser run still gets this app's origin as E2E_GIT_ANY_BASE_URL.
 *
 * @param {Record<string, string>} base `hermeticEnv(shell)`
 * @param {{ databaseUrl: string, baseUrl: string, authSecret: string, pgliteDir: string, apiKey: string }} run the run of the FIRST app
 * @param {string} secondBaseUrl `http://localhost:<the second port>`
 * @returns {Record<string, string>}
 */
export function secondAppEnvironment(base, run, secondBaseUrl) {
  return {
    ...appEnvironment(base, run),
    AUTH_URL: secondBaseUrl,
    NEXTAUTH_URL: secondBaseUrl,
    SCHEMA_IMPORT_GIT_MODE: "any",
    AUTH_REGISTRATION: "invite",
    // `any` mode makes the server run `gh api` for a git URL, and `gh` would use the developer's own login (a token variable, or the
    // config directory under their real HOME): the @external test could then read a private repository. No token, and a config directory
    // of the run's own that does not exist (next to the run's pglite directory, in its temporary directory).
    GH_TOKEN: "",
    GITHUB_TOKEN: "",
    GH_ENTERPRISE_TOKEN: "",
    GITHUB_ENTERPRISE_TOKEN: "",
    GH_CONFIG_DIR: `${run.pgliteDir.replace(/[\\/][^\\/]*$/, "")}/gh-config-none`,
  };
}

/**
 * The environment of the browser run: the shell's rest and what points it at the run. No name is blanked here: the browser run loads no
 * `.env` (a blank TEST_EMAIL would be the login "" and not the seeded admin).
 *
 * `run.browserChannel` is the runner's decision (`chrome` | `chromium`); the browser run gets it as E2E_BROWSER_CHANNEL, and gets nothing
 * when the runner decided nothing (the shell's own value was dropped from `base`). `run.knobs` is `runnerKnobs(shell)`.
 *
 * @param {Record<string, string>} base
 * `run.apiKey` is the key the app was started with (`API_KEY`); the browser run gets it as E2E_API_KEY (nothing when the run has none).
 *
 * `run.gitAnyBaseUrl` is the origin of the second app (git import in `any` mode), when the run started one; the browser run gets it as
 * E2E_GIT_ANY_BASE_URL (nothing otherwise: the test that needs it then skips, and the skipped-test gate reports it).
 *
 * @param {{ databaseUrl: string, baseUrl: string, outputRoot: string, authState: string, apiKey?: string, browserChannel?: string, knobs?: Record<string, string>, gitAnyBaseUrl?: string }} run
 * @returns {Record<string, string>}
 */
export function phasesEnvironment(base, run) {
  return {
    ...base,
    ...(run.knobs ?? {}),
    ...(run.browserChannel ? { E2E_BROWSER_CHANNEL: run.browserChannel } : {}),
    ...(run.apiKey ? { E2E_API_KEY: run.apiKey } : {}),
    ...(run.gitAnyBaseUrl ? { E2E_GIT_ANY_BASE_URL: run.gitAnyBaseUrl } : {}),
    DB_PROVIDER: "postgresql",
    DATABASE_URL: run.databaseUrl,
    E2E_DATABASE_URL: run.databaseUrl,
    E2E_BASE_URL: run.baseUrl,
    E2E_OUTPUT_ROOT: run.outputRoot,
    E2E_AUTH_STATE: run.authState,
  };
}

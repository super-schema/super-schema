# Browser suite (Playwright) and the release run

The browser suite lives in `tests/e2e`. A **release run** is the suite run against an environment made for that run alone: a throwaway
PostgreSQL database in Docker, migrated and seeded, and the app started from a production build. One command makes it, runs a tier of
the suite, and removes it again.

```bash
npm run test:e2e:release:smoke      # the pull-request tier: about 5 minutes once the app is built
npm run test:e2e:release            # everything (the nightly tier)
npm run test:e2e:release -- --tier regression --shard 2/4
```

Design and decisions: `docs/superpowers/specs/2026-10-23-release-ui-suite-design.md`.

## What you need

- **Docker**, running. The runner starts `postgres:16` (it is pulled on the first run) and refuses with a message when Docker is not up.
- **Playwright browsers**: `npx playwright install chromium` is enough for `--project chromium`. The smoke tier on three browsers runs
  Firefox and WebKit as well, and fails for those projects when they are not installed: `npx playwright install firefox webkit` (add
  `--with-deps` on a Linux CI machine).
- **macOS or Linux.** The runner puts each child in a process group of its own and signals the group (`kill(-pid)`, `ps` for the last
  resort); on Windows it signals the child alone and is not tested there.
- Node and `npm ci`, as for the app. No `.env` is needed, no database, no running server. A `.env` in the checkout is still read by the
  app, the seed and prisma (Next, dotenv and prisma/load-env-file.ts load it), so the runner defines every name the app reads, below: a
  `.env` cannot change what a run tests.

## The tiers

Tests carry their tier as a tag: `test(name, { tag: ["@smoke"] }, fn)`. `tests/unit/e2e-suite-guard.test.ts` fails a test without one.

| Tier | Selects | Browsers | When |
| --- | --- | --- | --- |
| `smoke` | `@smoke`: login, the basic create flows, one generate | Chromium, Firefox, WebKit | every pull request |
| `regression` | everything except `@slow` and `@external` | Chromium (+ the `a11y` project) | nightly and before a release; sharded |
| `nightly` | everything, unfiltered: adds `@slow` (the JSON Schema matrix, the navigation crawl) and `@external` (network, a second server) | every project: Chromium, the smoke tests on Firefox and WebKit, `a11y`, `visual` | nightly, before a release |

A test is never both `@smoke` and `@slow` / `@external` (the guard enforces that too). The Playwright projects (`setup`, `chromium`,
`firefox-smoke`, `webkit-smoke`, `serial-after`, `visual`, `a11y`) are described at the top of `playwright.config.ts`.

A tier is more than one `playwright test` command (Playwright runs a project's dependencies in full whatever `--grep` says, and every
command clears its output directory), so `scripts/e2e-phases.mjs` runs the phases of a tier one after the other, each with reports of its
own, and the release runner calls it. You can call it yourself against a server you started: `E2E_BASE_URL=http://localhost:3107 npm run test:e2e:smoke`.

## What the runner does

`scripts/e2e-release.mjs`, in this order:

1. Checks that Docker is running.
2. Picks a port for the app and one for the database (random, 20000-32000: below the ports Linux gives outgoing connections; never 3000,
   5432 or 5380-5410; checked free on loopback when the run starts, and the app's again after the build).
3. `docker run -d --rm --name ss-e2e-<id> postgres:16`, bound to `127.0.0.1`, data on tmpfs, a random password; waits until it accepts connections.
4. `prisma migrate deploy`, then `npm run db:seed` (admin user `admin@admin.com` / `admin`, the default tenant, the system domains).
5. `npm run build -- --webpack` (about a minute), or nothing with `--reuse-build` when `.next` can be used again.
6. `AUTH_TRUST_HOST=true next start -p <port> -H 127.0.0.1` with a random secret and `http://localhost:<port>` as its origin (both under
   the names `AUTH_*` and `NEXTAUTH_*`); waits until the app prints `Ready` and `/api/v1/health` answers (a port that was taken in
   the meantime is a new port and a second start, up to three), then asks `/api/auth/providers` and stops the run when the sign-in URLs
   are not under the run's own origin (an `AUTH_URL` got through) or Google sign-in is on (a `GOOGLE_CLIENT_ID` got through). The
   app's output goes to `<output root>/server.log`.
7. `node scripts/e2e-phases.mjs <tier>` with `E2E_BASE_URL`, `E2E_DATABASE_URL`, `E2E_OUTPUT_ROOT` and `E2E_AUTH_STATE` of the run's own.
   The exit code of the run is that command's.
8. Teardown, in the reverse order of the setup: the app is stopped (SIGTERM, SIGKILL after 10 s), the container is removed
   (`docker rm -f`), the temp directory (login file) is deleted. This happens in a `finally`, and on SIGINT, SIGTERM and SIGHUP. A teardown
   step that fails is said again in the last line (`TEARDOWN INCOMPLETE: ...` with the command to run by hand, e.g.
   `docker rm -f ss-e2e-<id>`), whatever the exit code is.

It never touches your `.env` database, `data/pglite` or a dev server.

### The environment of the children

Dropping a name from your shell is not enough: the app loads the checkout's `.env` (Next for `next build` and `next start`,
`dotenv/config` in the seed and `scripts/db.ts`, `prisma/load-env-file.ts` for `prisma.config.ts`), and each loader fills in every name
that the *process* environment does not define. A name that is defined wins in all three, even as an empty string (checked with a real
`.env`; `tests/unit/scripts/e2e-env.test.ts` runs the same probe). So every name the
app reads is in exactly one group (`scripts/e2e-env.mjs`):

| Group | Names | What the child gets |
| --- | --- | --- |
| set | `DATABASE_URL`, `E2E_DATABASE_URL`, `DB_PROVIDER=postgresql`, `PGLITE_DATA_DIR` (inside the run's temp directory, in case something fell back to PGlite), `NEXTAUTH_URL` and `AUTH_URL` (the run's origin), `NEXTAUTH_SECRET` and `AUTH_SECRET` (the run's random secret), `AUTH_TRUST_HOST=true`, `SCHEMA_CLASSIFICATION_EXTENSION_KEY` / `_LEVEL_FIELD` / `_CATEGORY_FIELD` | the run's own value (the classification names: the importer's defaults, because an empty value is not its default) |
| blanked | `GOOGLE_CLIENT_ID` / `_SECRET`, `AI_PROVIDER` / `AI_BASE_URL` / `AI_MODEL`, `API_KEY`, `DIRECT_URL`, `SHADOW_DATABASE_URL`, `SCHEMA_IMPORT_GIT_MODE` / `_SCOPES` (empty = restricted, the default), `SCHEMA_CLASSIFICATION_VALUE_MAP`, every `ASYNCAPI_PARSER_*` the code reads (`ASYNCAPI_PARSER_IN_PROCESS=1` would move the parser into the server), `AUTH_REDIRECT_PROXY_URL`, `AUTH_SECRET_1`..`3`, the libpq names (`PGHOST`, `PGPASSWORD`, `PGSSLMODE` ...) | `""`, for the app, `prisma migrate`, the seed and the build: the app reads "" as "not configured" |
| dropped | `NODE_ENV` (Next sets it), `PORT`, `HOSTNAME` (the app is started with `-p` and `-H`), `TEST_EMAIL`, `TEST_PASSWORD` (the browser run reads them and loads no `.env`; the seeded admin is the contract) | not defined |
| allowed | `NEXT_PUBLIC_APP_URL` (baked into the build, so part of its hash), `NODE_OPTIONS` | passed through from your shell |

`AUTH_URL` and `AUTH_SECRET` are set, not blanked: Auth.js reads `AUTH_URL ?? NEXTAUTH_URL` and `AUTH_SECRET ?? NEXTAUTH_SECRET`, and an empty
string is not nullish, so a blank `AUTH_URL` would switch the run's `NEXTAUTH_URL` off. Everything else in your shell is passed on;
whatever your shell has under the prefixes `PG`, `AUTH_`, `NEXTAUTH_`, `E2E_`, `ASYNCAPI_PARSER_`, `AI_`, `SCHEMA_IMPORT_` or
`SCHEMA_CLASSIFICATION_` is dropped. The browser run (Playwright) gets the same shell minus these, plus `E2E_BASE_URL`, `E2E_DATABASE_URL`,
`E2E_OUTPUT_ROOT`, `E2E_AUTH_STATE`, `DATABASE_URL` and `DB_PROVIDER`; it blanks nothing.

**When the app starts to read a new environment name**, `tests/unit/scripts/e2e-env.test.ts` fails (it scans `src`, the seed,
`prisma.config.ts`, `next.config.ts` and `scripts/db.ts`, and reads `src/env.ts`): put the name in one of the groups in
`scripts/e2e-env.mjs`, with its reason. A name read some other way than `process.env.NAME`, `env.NAME`, `*_ENV = "NAME"`, `readName` or
`positiveNumber` is not found by the scan: check it by hand.

### Options

| Option | Meaning |
| --- | --- |
| `--tier smoke\|regression\|nightly` | required (the npm scripts set one; a later `--tier` wins) |
| `--shard i/n` | slice `i` of `n`. The `serial-after` phase of the regression tier runs with slice 1 only |
| `--project <name>` | narrow the tier to a project (repeatable): `--tier smoke --project firefox-smoke`. It narrows; it does not add |
| `--reuse-build` | skip the build when it can be reused (below) |
| `--keep` | leave the database container running, and print how to connect and how to remove it |
| `--list-only` | the whole setup, but the browser run only lists the tests of the tier (a dry run) |
| `--output-root <dir>` | where reports and `server.log` go (default `$E2E_OUTPUT_ROOT`, else `test-results/run-<id>`) |
| `-- <args>` | Playwright's own: `-- tests/e2e/layout.spec.ts --headed --grep "sidebar"` (they go to the first phase) |

Exit codes: the phases' (0 passed, 1 a test failed), 2 bad arguments, 3 the environment could not be set up (Docker, database, build,
app), 128 + n when stopped by signal n (130 for Ctrl-C).

### `--reuse-build`

A build is reused only when `.next/BUILD_ID` exists and the stamp the runner wrote after that build (`.next/e2e-release-build.json`) holds
the same **hash of the build's inputs** as now: the content of every file under `src` (not `src/generated`, which `prebuild` derives from
the schema and the lockfile) and `public`, `package.json`, `package-lock.json`, `tsconfig.json`, `postcss.config.mjs`, `next.config.*`,
`prisma/schema.prisma`, `scripts/build-parser-worker.mjs`, the `NEXT_PUBLIC_*` values (the `.env`, `.env.production`, `.env.local` and
`.env.production.local` files', and your shell's, which win), the build mode and the major version of Node. No modification times: a
checkout of an older commit changes the hash. The hash is taken before the build; if an input changes while it builds, the build is not
recorded for reuse. Anything else is a fresh build, and the runner prints which condition decided
(`tests/unit/scripts/e2e-build-inputs.test.ts` changes each input in turn). The database is not part of the check: the app reads it at
run time (the routes `next build` prerenders are client shells that fetch their data in the browser; a page that queried the database
during the build would bake the data of the build's database into the build, and a release run should then go without `--reuse-build`).
Measured on a laptop: a whole smoke run on Chromium with a fresh build takes about 90 s, and 20 to 30 s with `--reuse-build`.

### Two runs at the same time

Ports, container name, password, secret, temp directory, login file and output root are all per run, so two runs do not meet. The one
thing runs from one checkout share is `.next`: a run that would rebuild it while another serves from it, or while another builds, stops
with a message (use `--reuse-build` to share the other's build, or run from a second worktree). Two runs that are given the same
`E2E_OUTPUT_ROOT` (or `--output-root`) also share its `server.log` and reports: give each run its own.

## Running it in CI

```bash
npx playwright install --with-deps chromium firefox webkit
CI=true E2E_OUTPUT_ROOT="$PWD/test-results/ci" npm run test:e2e:release:smoke
CI=true E2E_OUTPUT_ROOT="$PWD/test-results/ci" npm run test:e2e:release -- --tier regression --shard 2/4
```

- `CI=true` switches Playwright to the CI reporters (below), one worker and one retry; without it a run prints the `list` reporter only
  and writes no html or junit files.
- `E2E_OUTPUT_ROOT` puts every report in one directory to upload as an artifact (also on failure: `if: always()`); `server.log` is there
  too. Use a path under `test-results/` or `playwright-report/`, which version control ignores (another directory needs a `.gitignore` line).
- GitHub-hosted runners have Docker; no Postgres service is needed (the runner makes its own container).
- Do not run the regression shards of one job on one checkout at the same time without `--reuse-build` (they share `.next`).

## Reading a run

Everything of a run is under its output root (printed at the start and at the end of the run). With `CI=true`:

| What | Where |
| --- | --- |
| html report of a phase | `<root>/playwright-report/<phase>/index.html`: `npx playwright show-report <root>/playwright-report/main` |
| junit | `<root>/test-results/<phase>/junit.xml` (retries included: a test that passed on a retry has a `<flakyFailure>`) |
| flaky tests | `<root>/test-results/<phase>/flaky-tests.json`, a FLAKY block in the console, a warning annotation on GitHub |
| traces, screenshots, video of failures | `<root>/test-results/<phase>/artifacts/<test>/`: `npx playwright show-trace <trace.zip>` |
| the app's log | `<root>/server.log` (kept whatever the result) |

The phases are `main` (and `serial` for the regression tier, which runs `serial-after` as its own command). The summary at the end of
the run lists each phase's result and the report paths that exist. A test that passes only on a retry does not fail the run and is never
hidden: it is listed as flaky in all of the above. Old runs stay in `test-results/run-<id>`; delete them when you do not need them
(`test-results` is ignored by version control).

## Visual snapshots

<!-- TODO(Task 7): how to update the visual snapshots (generated in the Playwright Docker image, never on a laptop) and how a diff is read. -->

## Troubleshooting

- **"Docker is not running"**: start Docker Desktop (or the daemon, colima ...). The runner needs it and stops before doing anything else.
- **Leftover containers** (the runner was killed with SIGKILL, the machine slept ...): `docker ps -a --filter name=ss-e2e-`, then
  `docker rm -f <name>`. They are named `ss-e2e-<id>` and carry the labels `ss-e2e=1` and `ss-e2e-run=<id>`. A run that was SIGKILLed can
  also leave its app server (`next start`) behind: `ps -ax | grep "next start"` and stop the one on the run's port.
- **Turbopack and a symlinked `node_modules` (git worktrees)**: `next build` with Turbopack refuses a `node_modules` that is a symlink to
  another checkout's. The runner builds with `--webpack`, which does not mind; a plain `npm run build` in such a worktree fails.
- **Logins bounce back to /login on `next start`**: Auth.js refuses an unknown host in production mode. The runner sets
  `AUTH_TRUST_HOST=true`; do the same when you start the app yourself (`AUTH_TRUST_HOST=true npm start`).
- **The AsyncAPI parser worker is missing** (`worker-dist/asyncapi-parser-worker.cjs`, events validate / publish / import fail): it is
  built by `prebuild` (`npm run build:parser-worker`). `npm run build` runs it; calling `next build` directly does not, and neither does
  `--reuse-build` after a `git clean`. Run `npm run build:parser-worker` once.
- **The app does not come up**: the runner prints the last lines of `server.log` and exits 3. The usual causes are a build that is not
  complete (`.next` without `BUILD_ID`) and a database that refused the app's connection.
- **`another release run ... is serving .next`**: see "Two runs at the same time" above.
- **"strict mode violation: ... resolved to 2 elements" on a production build only**: a hard load streams a page behind its Suspense
  boundary and React leaves the streamed segment's hidden copy (`div#S:0[hidden]`) in `<body>` for about 60 ms, so a bare
  `page.getByTestId(...)` can match the real element and the copy. Query page content inside `centerPanel(page)` and the explorer with
  `leftSidebar(page)` (both in `tests/e2e/helpers/event-builder.ts`); do not wait for a count.
- **"the app's credentials signinUrl is ..., not under http://localhost:<port>"** or **"the app offers Google sign-in"** (exit 3, before
  any test): a setting reached the app that the runner meant to override: an `AUTH_URL` / `NEXTAUTH_URL` or a `GOOGLE_CLIENT_ID` from
  somewhere the runner does not control (a name the app reads that is in no group of `scripts/e2e-env.mjs`, or a loader that is not
  one of the three above). The message names the setting; `server.log` has the app's side.
- **A run is stuck after Ctrl-C**: the first Ctrl-C asks the step in progress to stop and runs the teardown; a second one kills the step
  at once (the teardown still runs). It never leaves the container behind unless you pass `--keep`.
- **Port conflicts**: ports are picked at random and checked when the run starts; if the database port is taken at that moment the runner
  picks another (three tries).

## Access control

The seeded user `admin@admin.com` is an `ADMIN`; the suite logs in as that user and sees everything. Role rules (viewer, author, per tenant,
domain and product) are a later change; when they land, the suite needs a second login with a lower role and specs that check what that
role cannot do.

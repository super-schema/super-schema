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
- **Playwright browsers**: `npx playwright install chromium` is enough for `--project chromium`; the smoke tier also runs Firefox and
  WebKit: `npx playwright install firefox webkit` (add `--with-deps` on a Linux CI machine).
- Node and `npm ci`, as for the app. No `.env`, no database, no running server: the release run uses none of them.

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
2. Picks a free port for the app and one for the database (random, 20000-39999, never 3000, 5432 or 5380-5410).
3. `docker run -d --rm --name ss-e2e-<id> postgres:16`, bound to `127.0.0.1`, data on tmpfs, a random password; waits until it accepts connections.
4. `prisma migrate deploy`, then `npm run db:seed` (admin user `admin@admin.com` / `admin`, the default tenant, the system domains).
5. `npm run build -- --webpack` (about a minute), or nothing with `--reuse-build` when `.next` can be used again.
6. `AUTH_TRUST_HOST=true next start -p <port> -H 127.0.0.1` with a random `NEXTAUTH_SECRET` and `NEXTAUTH_URL=http://localhost:<port>`;
   waits for `/api/v1/health`. The app's output goes to `<output root>/server.log`.
7. `node scripts/e2e-phases.mjs <tier>` with `E2E_BASE_URL`, `E2E_DATABASE_URL`, `E2E_OUTPUT_ROOT` and `E2E_AUTH_STATE` of the run's own.
   The exit code of the run is that command's.
8. Teardown, in the reverse order of the setup: the app is stopped (SIGTERM, SIGKILL after 10 s), the container is removed
   (`docker rm -f`), the temp directory (login file) is deleted. This happens in a `finally`, and on SIGINT, SIGTERM and SIGHUP.

It never touches your `.env` database, `data/pglite` or a dev server. Its children get an environment made for them: `DATABASE_URL`,
`PG*`, `AUTH_*`, `NEXTAUTH_*`, `PORT`, `TEST_EMAIL`, `GOOGLE_*` and the `SCHEMA_IMPORT_GIT_*` settings of your shell are dropped, the
database and auth settings of the run are set explicitly (so a `.env` in the checkout cannot override them: variables of the process win),
and `PGLITE_DATA_DIR` points into the run's own temp directory in case something ever fell back to PGlite.

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

The build is reused only when all of this holds, and the runner says which condition decided it: `.next/BUILD_ID` exists; the build was
made by this runner (`.next/e2e-release-build.json`); the `NEXT_PUBLIC_*` values (the only ones `next build` bakes into the bundle) and the
build mode are the same; nothing under `src`, `public`, and none of `package.json`, `package-lock.json`, `next.config.ts`,
`prisma/schema.prisma` is newer than the build. Anything else is a fresh build. The database is not part of the check: the app reads it at
run time (the routes `next build` prerenders are client shells that fetch their data in the browser; a page that queried the database
during the build would bake the data of the build's database into the build, and a release run should then go without `--reuse-build`).
Measured on a laptop: a whole smoke run on Chromium with a fresh build takes about 90 s, and 20 to 30 s with `--reuse-build`.

### Two runs at the same time

Ports, container name, password, secret, temp directory, login file and output root are all per run, so two runs do not meet. The one
thing runs from one checkout share is `.next`: a run that would rebuild it while another serves from it, or while another builds, stops
with a message (use `--reuse-build` to share the other's build, or run from a second worktree).

## Running it in CI

```bash
npx playwright install --with-deps chromium firefox webkit
CI=true E2E_OUTPUT_ROOT="$PWD/e2e-out" npm run test:e2e:release:smoke
CI=true E2E_OUTPUT_ROOT="$PWD/e2e-out" npm run test:e2e:release -- --tier regression --shard 2/4
```

- `CI=true` switches Playwright to the CI reporters (below), one worker and one retry; without it a run prints the `list` reporter only
  and writes no html or junit files.
- `E2E_OUTPUT_ROOT` puts every report in one directory to upload as an artifact (also on failure: `if: always()`); `server.log` is there too.
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
- **A run is stuck after Ctrl-C**: the first Ctrl-C asks the step in progress to stop and runs the teardown; a second one kills the step
  at once (the teardown still runs). It never leaves the container behind unless you pass `--keep`.
- **Port conflicts**: ports are picked at random and checked when the run starts; if the database port is taken at that moment the runner
  picks another (three tries).

## Access control

The seeded user `admin@admin.com` is an `ADMIN`; the suite logs in as that user and sees everything. Role rules (viewer, author, per tenant,
domain and product) are a later change; when they land, the suite needs a second login with a lower role and specs that check what that
role cannot do.

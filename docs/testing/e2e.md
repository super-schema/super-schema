# Browser suite (Playwright) and the release run

The browser suite lives in `tests/e2e`. A **release run** is the suite run against an environment made for that run alone: a throwaway
PostgreSQL database in Docker, migrated and seeded, and the app started from a production build. One command makes it, runs a tier of
the suite, and removes it again. What the suite covers, area by area: [e2e-coverage-matrix.md](e2e-coverage-matrix.md). Design and decisions:
`docs/superpowers/specs/2026-10-23-release-ui-suite-design.md`. How many tests each tier has is not written here (it would rot): `node scripts/e2e-counts.mjs`
prints it from `playwright test --list`.

## Release checklist

Before a release, on a machine with Docker running, **in this order**. The exit code of each command is its answer: 0 is go, anything else is stop.

**Once per machine**

- Docker running (Docker Desktop, Rancher Desktop, colima): `docker info`. The runner starts `postgres:16` and removes it again.
- Node 22 or 20.9+, through nvm: `nvm install 22 && nvm use 22` in the checkout (`.nvmrc`), or `nvm use 20`. Node 24 runs with an "untested" warning; Node 25 and 26 are refused (exit 2).
- `npm ci`, with the sibling repository it needs ([CI prerequisites](#ci-prerequisites-what-npm-ci-needs-on-a-runner) says what: the same applies on a developer machine).
- The browsers: `npx playwright install chromium firefox webkit` once. Firefox and WebKit are needed only for the smoke tier's three browsers (a smoke run without them fails for those two projects); Chromium
  is the default, and Google Chrome is used instead when the machine has it.
- The Playwright image, for the visual tier: `docker pull mcr.microsoft.com/playwright:v$(node -p "require('@playwright/test/package.json').version")-jammy` (about 2.5 GB; the runner never pulls it).
- For the corpus only: the LocalCloud emulators (Spanner and BigQuery) running (`docker ps` shows `localcloud`) and `javac` on the PATH (the Java target).

**Every release**

| # | Command | What it covers | Expected |
| --- | --- | --- | --- |
| 1 | `npm run test:e2e:release:smoke` | the smoke tier on **three browsers** (Chromium, Firefox, WebKit): login, the page sweep, the basic create flows, one generate | exit 0. Measured on an Apple Silicon laptop, Chromium (Google Chrome) only, a fresh build: **1 min 50 s** (the build 1 min 17 s, 21 tests in 25 s; with `--reuse-build` 30 s). Firefox and WebKit were not installed on that machine: the three-browser figure is not measured |
| 2 | `npm run test:e2e:release` | the **nightly tier**: EVERYTHING EXCEPT the visual tier and the corpus. That is the regression tests, the `@slow` ones (the JSON Schema matrix, the navigation crawl, external event references), the `@external` ones (the network import, the git-mode `any` test on a second app the runner starts), the accessibility scan, and the smoke tests on Firefox and WebKit. No retries, a local run | exit 0, 0 flaky, **no skipped test that is not `@external`**. Measured on the same laptop with Chromium, `a11y` and `serial-after` (Firefox and WebKit not installed): **12 min** end to end (the build 1 min 17 s, the 384 tests on 8 workers 10 min 38 s); the 40 smoke runs on Firefox and WebKit come on top |
| 3 | `npm run test:e2e:visual` | the nine screenshots, compared in the Playwright image. A change you meant: `npm run test:e2e:update-snapshots`, look at every image (`git diff --stat tests/e2e/visual.spec.ts-snapshots`), commit them | exit 0. Measured: **1 min 47 s** (nine screenshots and the login, in the image) |
| 4 | `npm run test:corpus` | the corpus: every case against every enabled target, with the LocalCloud emulators and `javac`. It **rewrites** `docs/superpowers/reports/2026-10-22-corpus-matrix.md`: commit the change | exit 0; every failure is a known one in the report. Measured: **9 min** (543 s for 306 cases x 8 targets, against the emulators) |
| 5 | `npx vitest run tests/unit` | the unit tests. Not `npm test`: that is `vitest` in watch mode and never ends | exit 0. Measured: **2 min 35 s** (654 files, about 12,750 tests) |

Step 2 is `npm run test:e2e:release`, which is `node scripts/e2e-release.mjs --tier nightly`: it is **not** "everything" (no visual tier, no corpus, no unit tests), which is why steps 3 to 5 exist.
Steps 1 and 2 can be one run (the nightly tier includes the smoke tests, on all three browsers) when the browsers are installed; step 1 is the quick answer.

**Exit codes** of the runner and of the phases script: **0** passed; **1** a test failed, or a test that is not `@external` was skipped (the skipped-test gate: [below](#skipped-tests-are-never-invisible));
**2** a usage error (a bad option, an unsupported Node, a bad value of `E2E_STALL_MS` / `E2E_GLOBAL_TIMEOUT_MS` / `E2E_KEEP_RUNS`, a visual tier outside the image); **3** the environment could not be made
(Docker, the database, the build, the app); **124** the stall watchdog ended a Playwright that stopped making progress; **128 + n** stopped by signal *n* (130 for Ctrl-C).

**Where things are.** Everything of a run is under its output root, `test-results/run-<id>/` (printed at the start and in the last line): `server.log` (the app's log), `server-git-any.log` (the
second app's), `test-results/<phase>/` (`junit.xml`, `flaky-tests.json`, `skipped-tests.json`, the traces, videos and screenshots of failures), `playwright-report/<phase>/index.html`
(`npx playwright show-report <root>/playwright-report/main`), and `test-results/evidence/` (what the specs leave to be looked at). Runs older than 7 days are pruned when a new one starts (the newest five stay).
**Leftovers** of a killed run: `docker ps -a --filter name=ss-e2e-` lists the containers (the database is `ss-e2e-<id>`, the visual run `ss-e2e-visual-<id>`), `docker rm -f <name>` removes one; the
runner's last line says `TEARDOWN INCOMPLETE` with the command when it could not.

**Access control.** The suite logs in as the seeded `admin@admin.com` and sees everything: a green run says nothing about who may see or change what. The access-control work will change that, and the suite
needs a second login with a lower role then (the last section).

```bash
npm run test:e2e:release:smoke      # the pull-request tier: about 5 minutes once the app is built
npm run test:e2e:release            # the nightly tier: everything except the visual tier and the corpus
npm run test:e2e:release -- --tier regression --shard 2/4
```

## What you need

- **Docker**, running. The runner starts `postgres:16` (it is pulled on the first run) and refuses with a message when Docker is not up.
- **Playwright browsers**: `npx playwright install chromium` is enough for `--project chromium`. The smoke tier on three browsers runs
  Firefox and WebKit as well, and fails for those projects when they are not installed: `npx playwright install firefox webkit` (add
  `--with-deps` on a Linux CI machine).
- **Google Chrome** (optional). When the machine has it, the `chromium`, `serial-after` and `a11y` projects run in it; without it they
  run in the Chromium Playwright downloads. Which one, and how to force the other: [The browser](#the-browser-google-chrome-or-the-bundled-chromium).
- **macOS or Linux.** The runner puts each child in a process group of its own and signals the group (`kill(-pid)`, `ps` for the last
  resort); on Windows it signals the child alone and is not tested there.
- **Node 20.9+ or 22** (`.nvmrc` says 22, CI runs 22; `engines` in `package.json` is `>=20.9.0 <25`) and `npm ci`, as for the app:
  `nvm install 22 && nvm use 22` (or `nvm use 20`) in the checkout. The runner and the phases script refuse an unsupported Node with exit code 2
  before they provision anything: on Node 26.3.1 a run stopped after its last test with every Playwright worker idle and never ended (see
  Troubleshooting). The policy is a whitelist, not a finding about every other Node: **20.9+ and 22 are supported; Node 24 (the Active LTS, and the
  Playwright image's) is allowed with a one-line "untested" warning; Node 25 and 26 and the other versions are refused**.
  `E2E_ALLOW_UNSUPPORTED_NODE=1` runs the suite on a refused Node anyway. Only the e2e guard refuses: the application itself runs on whatever
  `engines` allows. The guard is also in `playwright.config.ts`, so a bare `playwright test` (below) meets it too. No `.env` is needed, no database, no running server. A `.env` in the checkout is still read by the
  app, the seed and prisma (Next, dotenv and prisma/load-env-file.ts load it), so the runner defines every name the app reads, below: a
  `.env` cannot change what a run tests.

## The tiers

Tests carry their tier as a tag: `test(name, { tag: ["@smoke"] }, fn)`. `tests/unit/e2e-suite-guard.test.ts` fails a test without one.

| Tier | Selects | Browsers | When |
| --- | --- | --- | --- |
| `smoke` | `@smoke`: login, the basic create flows, one generate | Chromium, Firefox, WebKit | every pull request |
| `regression` | everything except `@slow` and `@external`, the REST API spec (`api-v1.spec.ts`) and the accessibility scan (`a11y.spec.ts`) included | Chromium (+ the `a11y` project) | nightly and before a release; sharded |
| `nightly` | everything, unfiltered: adds `@slow` (the JSON Schema matrix, the navigation crawl) and `@external` (network, a second server) | every project: Chromium, the smoke tests on Firefox and WebKit, `a11y`, and `visual` where it exists (in the Playwright image) | nightly, before a release |
| `visual` | the screenshots (`visual.spec.ts`, project `visual`), made and compared only inside the Playwright Docker image: [Visual snapshots](#visual-snapshots) | the image's Chromium, on Linux | the `e2e-visual` job; by hand before a release |

A test is never both `@smoke` and `@slow` / `@external` (the guard enforces that too). The Playwright projects (`setup`, `chromium`,
`firefox-smoke`, `webkit-smoke`, `serial-after`, `visual`, `a11y`) are described at the top of `playwright.config.ts`.

A tier is more than one `playwright test` command (Playwright runs a project's dependencies in full whatever `--grep` says, and every
command clears its output directory), so `scripts/e2e-phases.mjs` runs the phases of a tier one after the other, each with reports of its
own, and the release runner calls it. You can call it yourself against a server you started: `E2E_BASE_URL=http://localhost:3107 npm run test:e2e:smoke`.

**Use `npm run test:e2e:release:smoke` / `npm run test:e2e:release`** (the release runner: a throwaway database and app of their own, the stall
watchdog, the skipped-test gate). The npm script that was the bare `playwright test` is now `npm run test:e2e:raw`, and `npx playwright test` is the
same thing: neither has the scripts in front of it, so `playwright.config.ts` itself refuses the two mistakes they allowed. It throws, with the command
to run instead, **(1)** on an unsupported Node (the Node policy above) and **(2)** when `E2E_BASE_URL` is unset and something already listens on
:3000: Playwright would reuse that server, and with it the database of your `.env` that the tests create and delete rows in. Setting
`E2E_ALLOW_REUSE_SERVER=1` is the one way to reuse a server on purpose. A `--list` is never refused (it starts nothing).

## The browser: Google Chrome or the bundled Chromium

The `chromium`, `serial-after` and `a11y` projects run in **Google Chrome** (Playwright's `channel: "chrome"`) when the machine has it, and in
the Chromium that Playwright downloads when it has not. The project names do not change (`--project chromium` is still `chromium`);
`playwright.config.ts` adds `use.channel` to those three. The choice is made once per run by `scripts/e2e-browser.cjs`, the same code for
`playwright.config.ts`, `scripts/e2e-phases.mjs` and the release runner, in this order:

| | Rule | Browser |
| --- | --- | --- |
| 1 | `E2E_BROWSER_CHANNEL=chrome` or `=chromium` (any case) | what it says, over everything below, CI included. `chrome` on a machine without Chrome stops the run with exit code 2 (it is not quietly replaced by another browser); any other value is refused the same way |
| 2 | `CI` is set | the bundled Chromium: what CI has always run (the workflow installs Playwright's browsers, not Chrome) |
| 3 | Chrome is installed | Chrome |
| 4 | otherwise | the bundled Chromium |

Chrome is looked for at `/Applications/Google Chrome.app` on macOS, and on Linux as `google-chrome` or `google-chrome-stable` on the `PATH`
(then `/opt/google/chrome/chrome`, the file Playwright itself launches for `channel: "chrome"`). Other platforms always get the bundled Chromium.

```bash
npm run test:e2e:release:smoke                                   # Chrome if it is installed, else the bundled Chromium
E2E_BROWSER_CHANNEL=chromium npm run test:e2e:release:smoke      # force the bundled Chromium on a machine that has Chrome
E2E_BROWSER_CHANNEL=chrome npm run test:e2e:release:smoke        # insist on Chrome (exit 2 when there is none)
```

The run names its browser, with the version the browser reports for itself (`<browser> --version`), at its start and in its last line:

```
[e2e-release] browser: Google Chrome 155.0.8059.85 [channel chrome: Google Chrome found at /Applications/Google Chrome.app/Contents/MacOS/Google Chrome]
[e2e-release] done: exit 0; reports and server.log: ...; browser: Google Chrome 155.0.8059.85 [channel chrome: ...]
```

and `scripts/e2e-phases.mjs` (called alone, against a server you started) prints `[e2e-phases] browser: ...` at its start and `browser: ...` in
its summary. A listing (`--list`) starts no browser and names none. `CI=true` also turns on CI's reporters, one retry and one worker, so a
local run that wants Chrome *and* those passes `E2E_BROWSER_CHANNEL=chrome` explicitly (rule 1 beats rule 2).

**Visual snapshots are always taken in the bundled Chromium.** The `visual` project never takes the channel: its screenshots are pixels, and
they are generated and compared in the bundled Chromium of the Playwright Docker image, so no Chrome (any version, any operating system) ever
decides what a baseline looks like. Firefox and WebKit (`firefox-smoke`, `webkit-smoke`) are not affected either.

## What the runner does

`scripts/e2e-release.mjs`, in this order:

1. Checks the Node (20.9+, 22, or 24 with a warning; else exit 2 with `nvm install 22 && nvm use 22`: above), that Docker is running, and decides the browser (above; an explicit
   `E2E_BROWSER_CHANNEL=chrome` that this machine cannot give is exit 2 before anything is provisioned); names the Node and the browser with
   its version.
2. Picks a port for the app and one for the database (random, 20000-32000: below the ports Linux gives outgoing connections; never 3000,
   5432 or 5380-5410; checked free on loopback when the run starts, and the app's again after the build).
3. `docker run -d --rm --name ss-e2e-<id> postgres:16`, bound to `127.0.0.1`, data on tmpfs, a random password; waits until it accepts connections.
4. `prisma migrate deploy`, then `npm run db:seed` (admin user `admin@admin.com` / `admin`, the default tenant, the system domains).
5. `npm run build -- --webpack` (about a minute), or nothing with `--reuse-build` when `.next` can be used again.
6. `AUTH_TRUST_HOST=true next start -p <port> -H 127.0.0.1` with a random secret and `http://localhost:<port>` as its origin (both under
   the names `AUTH_*` and `NEXTAUTH_*`); waits until the app prints `Ready` and `/api/v1/health` answers (a port that was taken in
   the meantime is a new port and a second start, up to three), then asks `/api/auth/providers` and stops the run when the sign-in URLs
   are not under the run's own origin (an `AUTH_URL` got through) or any identity provider is on (an `AUTH_PROVIDERS` got through: only the local credentials provider is offered in a run). The
   app's output goes to `<output root>/server.log`.
7. **The second app**, for the tiers that include the `@external` tests (the nightly tier) and with `--second-app`: the git-host import has a
   mode read from the environment when the app starts (`SCHEMA_IMPORT_GIT_MODE`, `restricted` by default), and the test "A1: git mode any
   (second server)" needs a server in `any` mode. After the first app is healthy the runner starts a second `next start` of the **same build**
   on another free port, with the same database, secret and API key, `SCHEMA_IMPORT_GIT_MODE=any`, and its own origin for Auth.js (a sign-in
   URL of the other port would send a login to the other server); it waits until it is ready and `/api/v1/health` answers, checks its sign-in
   origin like the first app's, and gives the browser run its origin as `E2E_GIT_ANY_BASE_URL`. It also runs `AUTH_REGISTRATION=invite` (the product's default; the
   first app runs `open`): the registration mode is read when the app starts too, and `tests/e2e/access-matrix.spec.ts` uses this server to see what `invite` does (no
   register form, a live invitation token needed). Its output goes to
   `<output root>/server-git-any.log`, and it is stopped first in the teardown. That test logs in on the second server itself (a
   session is that server's). Without a second app the test skips, and the skipped-test gate lists it (below).
   **It never uses your `gh` login.** In `any` mode the server runs `gh api` for a git URL, and `gh` would otherwise read the developer's own
   credentials (`GH_TOKEN`, `GITHUB_TOKEN`, the enterprise variants, or the config directory under the real `HOME`); the test could then fetch
   a private repository. The second app therefore gets blank tokens and `GH_CONFIG_DIR=<the run's tmp>/gh-config-none` (a directory that does
   not exist), whatever the shell has set (`secondAppEnvironment`, pinned in `tests/unit/scripts/e2e-env.test.ts`). The test only needs the
   server to TRY the fetch and fail on the host, not on the policy.
8. `node scripts/e2e-phases.mjs <tier>` with `E2E_BASE_URL`, `E2E_DATABASE_URL`, `E2E_OUTPUT_ROOT`, `E2E_AUTH_STATE` and `E2E_BROWSER_CHANNEL` of the run's own
   (and `E2E_GIT_ANY_BASE_URL` with a second app). The exit code of the run is that command's: 124 when its stall watchdog ended a Playwright
   that stopped making progress (below), 1 when a test failed or when a test that is not `@external` was skipped (below).
9. Teardown, in the reverse order of the setup: the apps are stopped (SIGTERM, SIGKILL after 10 s), the container is removed
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
| set | `API_KEY` (a random key of the run: the REST API's key authentication, `Authorization: Bearer <key>`; the browser run gets it as `E2E_API_KEY`), `DATABASE_URL`, `E2E_DATABASE_URL`, `DB_PROVIDER=postgresql`, `PGLITE_DATA_DIR` (inside the run's temp directory, in case something fell back to PGlite), `NEXTAUTH_URL` and `AUTH_URL` (the run's origin), `NEXTAUTH_SECRET` and `AUTH_SECRET` (the run's random secret), `AUTH_TRUST_HOST=true`, `SCHEMA_CLASSIFICATION_EXTENSION_KEY` / `_LEVEL_FIELD` / `_CATEGORY_FIELD` | the run's own value (the classification names: the importer's defaults, because an empty value is not its default) |
| blanked | `AUTH_PROVIDERS` and every `AUTH_PROVIDER_<KEY>_<SETTING>` (the identity providers of `docs/auth.md`: none in a run), `AI_PROVIDER` / `AI_BASE_URL` / `AI_MODEL` / `AI_API_KEY` and the standard names it falls back to (`OLLAMA_HOST`, `OPENAI_BASE_URL`), `DIRECT_URL`, `SHADOW_DATABASE_URL`, `SCHEMA_IMPORT_GIT_MODE` / `_SCOPES` (empty = restricted, the default), `SCHEMA_CLASSIFICATION_VALUE_MAP`, `HEALTH_DB_DEGRADED_MS` / `HEALTH_DB_TIMEOUT_MS` (the health probe's thresholds), every `ASYNCAPI_PARSER_*` the code reads (`ASYNCAPI_PARSER_IN_PROCESS=1` would move the parser into the server), `AUTH_REDIRECT_PROXY_URL`, `AUTH_SECRET_1`..`3`, the libpq names (`PGHOST`, `PGPASSWORD`, `PGSSLMODE` ...) | `""`, for the app, `prisma migrate`, the seed and the build: the app reads "" as "not configured" |
| dropped | `NODE_ENV` (Next sets it), `PORT`, `HOSTNAME` (the app is started with `-p` and `-H`), `TEST_EMAIL`, `TEST_PASSWORD` (the browser run reads them and loads no `.env`; the seeded admin is the contract) | not defined |
| allowed | `NEXT_PUBLIC_APP_URL` (baked into the build, so part of its hash), `NODE_OPTIONS` | passed through from your shell |
| browser run | `E2E_BROWSER_CHANNEL` (`chrome` or `chromium`) | the runner's own decision (above), for the phases script and Playwright only; never the app, the migration, the seed or the build. Your shell's value is dropped like every `E2E_` name and read by the runner as rule 1 |
| knobs | `E2E_ALLOW_UNSUPPORTED_NODE`, `E2E_STALL_MS`, `E2E_GLOBAL_TIMEOUT_MS` | the runner reads them from your shell, checks them (a stall limit or timeout that is not a positive whole number of milliseconds is exit 2), and hands them, as set, to the phases script and Playwright only; never the app. See "A run that stalls" |

`AUTH_URL` and `AUTH_SECRET` are set, not blanked: Auth.js reads `AUTH_URL ?? NEXTAUTH_URL` and `AUTH_SECRET ?? NEXTAUTH_SECRET`, and an empty
string is not nullish, so a blank `AUTH_URL` would switch the run's `NEXTAUTH_URL` off. Everything else in your shell is passed on;
whatever your shell has under the prefixes `PG`, `AUTH_`, `NEXTAUTH_`, `E2E_`, `ASYNCAPI_PARSER_`, `AI_`, `SCHEMA_IMPORT_` or
`SCHEMA_CLASSIFICATION_` is dropped. The browser run (Playwright) gets the same shell minus these, plus `E2E_BASE_URL`, `E2E_DATABASE_URL`,
`E2E_OUTPUT_ROOT`, `E2E_AUTH_STATE`, `E2E_API_KEY`, `E2E_BROWSER_CHANNEL`, `DATABASE_URL`, `DB_PROVIDER` and the knobs you set; it blanks nothing.

**When the app starts to read a new environment name**, `tests/unit/scripts/e2e-env.test.ts` fails (it scans `src`, the seed,
`prisma.config.ts`, `next.config.ts` and `scripts/db.ts`, and reads `src/env.ts`): put the name in one of the groups in
`scripts/e2e-env.mjs`, with its reason. A name read some other way than `process.env.NAME`, `env.NAME`, `*_ENV = "NAME"`, `readName` or
`positiveNumber` is not found by the scan: check it by hand.

### Options

| Option | Meaning |
| --- | --- |
| `--tier smoke\|regression\|nightly\|serial\|visual` | required (the npm scripts set one; a later `--tier` wins). `serial` is a login and then the `serial-after` project alone (`--no-deps`): the only way to run its `@slow` / `@external` specs without Playwright running all of `chromium` first; the arguments after `--` go to that last phase. `visual` is the screenshot comparison: it needs `--docker-image <image>` (the browser run happens in that image), which `npm run test:e2e:visual` and `npm run test:e2e:update-snapshots` pass; run bare on the host it is a usage error |
| `--shard i/n` | slice `i` of `n`. The `serial-after` phase of the regression tier runs with slice 1 only |
| `--project <name>` | narrow the tier to a project (repeatable): `--tier smoke --project firefox-smoke`. It narrows; it does not add |
| `--reuse-build` | skip the build when it can be reused (below) |
| `--keep` | leave the database container running, and print how to connect and how to remove it |
| `--second-app` | also start a second app with `SCHEMA_IMPORT_GIT_MODE=any` and `AUTH_REGISTRATION=invite` and give the browser run `E2E_GIT_ANY_BASE_URL` (the nightly tier does it by itself; a listing never does) |
| `--list-only` | the whole setup, but the browser run only lists the tests of the tier (a dry run) |
| `--output-root <dir>` | where reports and `server.log` go (default `$E2E_OUTPUT_ROOT`, else `test-results/run-<id>`) |
| `--docker-image <image>` | run the browser run inside this Docker image (the visual tier; the image must be on the machine) |
| `-- <args>` | Playwright's own: `-- tests/e2e/layout.spec.ts --headed --grep "sidebar"` (they go to the first phase) |

Exit codes: the phases' (0 passed, 1 a test failed), 2 bad arguments, 3 the environment could not be set up (Docker, database, build,
app), 128 + n when stopped by signal n (130 for Ctrl-C).

### `--reuse-build`

A build is reused only when `.next/BUILD_ID` exists and the stamp the runner wrote after that build (`.next/e2e-release-build.json`) holds
the same **hash of the build's inputs** as now: the content of every file under `src` (not `src/generated`, which `prebuild` derives from
the schema and the lockfile) and `public`, `package.json`, `package-lock.json`, `tsconfig.json`, `postcss.config.mjs`, `next.config.*`,
`prisma/schema.prisma`, `scripts/build-parser-worker.mjs`, the `NEXT_PUBLIC_*` values (the `.env`, `.env.production`, `.env.local` and
`.env.production.local` files', and your shell's, which win), the build mode and the major version of Node, the content of `vendor/typespec-enterprise` (a `file:` package inside the checkout), and the content of the **built `dist` directory of every `file:` dependency** of `package.json` (`@typespec/avro`, `@typespec/bigquery`, `@typespec/java-pojo`, `@typespec/postgres`, `@typespec/spanner` from the sibling `typespec` repository: found through `node_modules`, since in a worktree `file:../typespec` is not beside the checkout): rebuilding one of them changes the app, and a hash that only saw this repository's files would reuse a stale build. No modification times: a
checkout of an older commit changes the hash. The hash is taken before the build; if an input changes while it builds, the build is not
recorded for reuse. Anything else is a fresh build, and the runner prints which condition decided
(`tests/unit/scripts/e2e-build-inputs.test.ts` changes each input in turn). The database is not part of the check: the app reads it at
run time (the routes `next build` prerenders are client shells that fetch their data in the browser; a page that queried the database
during the build would bake the data of the build's database into the build, and a release run should then go without `--reuse-build`).
Measured on a laptop: a whole smoke run on Chromium with a fresh build takes about 110 s, and 30 s with `--reuse-build`.

### Two runs at the same time

Ports, container name, password, secret, temp directory, login file and output root are all per run, so two runs do not meet. The one
thing runs from one checkout share is `.next`: a run that would rebuild it while another serves from it, or while another builds, stops
with a message (use `--reuse-build` to share the other's build, or run from a second worktree). Two runs that are given the same
`E2E_OUTPUT_ROOT` (or `--output-root`) also share its `server.log` and reports: give each run its own.

## Running it in CI

`.github/workflows/e2e.yml` (the workflow `e2e`) runs the release runner on GitHub-hosted `ubuntu-latest` machines. It is a workflow of its
own; `.github/workflows/ci.yml` (the unit tests, on PGlite and PostgreSQL) is unchanged. Every job installs Node 22, runs `npm ci` and
`npx prisma generate`, installs the browsers it needs, and calls `npm run test:e2e:release`.

| Event | Job | Status check | Time limit | Gates a merge |
| --- | --- | --- | --- | --- |
| pull request | `smoke`: the smoke tier on Chromium, Firefox and WebKit | `e2e-smoke` | 25 min | **yes**, once a maintainer requires it (below) |
| nightly (`schedule`, 02:23 UTC), a tag `v*` | `regression`: the regression tier, four shards | `e2e-regression (1/4)`, `e2e-regression (2/4)`, `e2e-regression (3/4)`, `e2e-regression (4/4)` | 60 min each | no, it reports |
| nightly, a tag `v*` | `nightly-extra`: what the nightly tier has and the regression tier has not, three legs | `e2e-nightly-extra (slow-chromium)`, `e2e-nightly-extra (slow-serial)`, `e2e-nightly-extra (cross-browser)` | 150 min each (the @slow matrix alone is up to 17 tests x 420 s) | no, it reports |
| nightly, a tag `v*` | `visual`: the screenshots, the browser run in the Playwright image ([Visual snapshots](#visual-snapshots)) | `e2e-visual` | 30 min | no, it reports (and is not to be required: below) |
| `workflow_dispatch` | the input `tier`: `smoke` runs `smoke`; `regression` runs `regression`; `nightly` runs `regression`, `nightly-extra` and `visual`; `visual` runs `visual` alone | as above | as above | no |

A leg or a shard that fails does not cancel the others (`fail-fast: false`). A newer push to a pull request cancels that pull request's
older run; nothing else is cancelled.

### CI prerequisites: what `npm ci` needs on a runner

`.github/workflows/e2e.yml` calls `npm ci` on `ubuntu-latest`, and **that cannot succeed on a GitHub-hosted runner as the repository is**. Nothing in this workflow has ever run on one (no job of it has been
triggered anywhere yet), so treat what follows as what a maintainer has to set up, not as something that was tried:

1. **The `file:` packages.** `package.json` links the emitters of the sibling repository `typespec`: `@typespec/avro`, `@typespec/bigquery`, `@typespec/java-pojo`, `@typespec/postgres` and `@typespec/spanner`, all
   `file:../typespec/packages/<name>`, and (inside this repository) `@superschema/typespec-enterprise` as `file:vendor/typespec-enterprise`. `npm ci` links them, it does not build them: the app runs their `dist`.
   The sibling repository must be checked out at `../typespec` (next to the checkout) and **built** (`npm ci && npm run build` in each of those five packages) before `npm ci` here.
2. **The registry.** `package-lock.json` resolves every package through the public npm registry (`registry.npmjs.org`), so a runner needs no registry credentials or `.npmrc`.
3. **Node.** `actions/setup-node` with Node 22 (the jobs do), and Docker on the runner (the runner starts a throwaway PostgreSQL; a self-hosted runner needs Docker installed and usable by the job's user).
4. `.github/workflows/ci.yml` (the unit tests) has the same prerequisite for its own `npm ci`.

A job that does all of that: **UNTESTED**, to be adapted to the real runner labels, repository names and registry URLs, and run once by hand (`workflow_dispatch`, tier `smoke`) before anyone relies on it:

```yaml
# UNTESTED. Put these steps first in every job of e2e.yml (and ci.yml), before `npm ci`; replace every <placeholder>.
jobs:
  smoke:
    runs-on: [self-hosted, linux, <label of a runner that has Docker>]
    steps:
      - uses: actions/checkout@v4
        with:
          persist-credentials: false
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - name: The sibling repository the app links (a file: dependency at ../typespec), built
        env:
          TYPESPEC_REPO_TOKEN: ${{ secrets.TYPESPEC_REPO_TOKEN }}   # read access to that repository
        run: |
          rm -rf ../typespec
          git clone --depth 1 "https://x-access-token:${TYPESPEC_REPO_TOKEN}@<host>/<org>/typespec.git" ../typespec
          for package in avro bigquery java-pojo postgres spanner; do
            (cd "../typespec/packages/$package" && npm ci && npm run build)
          done
      - run: npm ci
      # ... the job continues as in e2e.yml: prisma generate, browsers, npm run test:e2e:release -- --tier smoke
```

Until that exists, the supported way to run the release check is on a developer machine (the checklist above), which has the sibling repository already.

### Making `smoke` gate merges (branch protection)

Whether a check blocks a merge is a **repository setting**, and a workflow file cannot change it. A maintainer has to add the check once:
Settings, Branches (or Rulesets), the rule for `main`, "Require status checks to pass before merging", and then make `e2e-smoke` a
required status check. This is the only new check to require.

- GitHub lists a check only after it has reported once: open a pull request first, let `e2e-smoke` run, then add it.
- Require `e2e-smoke` only after it has run green once (for example by a `workflow_dispatch` run of the `smoke` tier on `main`): a
  required check that always fails blocks every merge.
- Do not require `e2e-visual` either: it compares screenshots made on one CPU architecture with a render on another (below), and is for reading until a
  first week of runs says that it never fails by itself; whether it ever gates a merge is a repository setting, and a decision for the maintainers.
- Do not require the `e2e-regression (...)` or `e2e-nightly-extra (...)` checks. They do not run on pull requests, and a required check
  that never reports blocks every merge. They are for reading the next morning, and before a release.
- The `pull_request` trigger has no path or branch filter on purpose, so `e2e-smoke` reports on every pull request. Keep it that way.
- `ci.yml`'s checks (`test (pglite)`, `test (postgresql)`) are separate; require them as you do now.

### What `nightly-extra` runs, and why it is not `--tier nightly`

The nightly tier is everything, so it includes the regression tests that the four shards have just run. The rest is run as three legs, each
selecting tests that no other leg and no regression shard selects (`node scripts/e2e-counts.mjs` prints how many tests each tier has, from `playwright test --list`, and
`node scripts/e2e-phases.mjs <tier> --list ...` lists the sets; the numbers are not written here because they change with every test). The login project (`setup`) is not counted,
though a raw `--list` prints it once more in every phase:

```bash
# slow-chromium: the @slow and @external tests of Chromium (the JSON Schema matrix, the URL import over the network)
npm run test:e2e:release -- --tier nightly --project chromium -- --grep "@slow|@external"
# slow-serial: the same tags in `serial-after` (the navigation crawl, external event references)
npm run test:e2e:release -- --tier serial -- --grep "@slow|@external"
# cross-browser: the smoke tests on Firefox and WebKit
npm run test:e2e:release -- --tier smoke --project firefox-smoke --project webkit-smoke
```

`slow-serial` has a tier of its own because Playwright runs a project's dependencies in full whatever `--grep` says: `--project serial-after`
with the grep would run all of `chromium` first. The `serial` tier logs in and runs `serial-after` alone. The screenshots are the `e2e-visual` job
(they need the Playwright image: [Visual snapshots](#visual-snapshots)); the REST API spec and the accessibility scan are in the regression shards.

### Artifacts, the flaky list, and the same run on your machine

Each job (each shard and leg) uploads two artifacts, also after a failure (`if: always()`), kept 14 days:

| Artifact | Holds |
| --- | --- |
| `e2e-smoke-playwright-report`, `e2e-regression-<shard>-playwright-report`, `e2e-nightly-extra-<leg>-playwright-report` | the html report of each phase (`main`, and `serial` for regression shard 1): download, unzip, `npx playwright show-report <folder>/main` |
| `e2e-smoke-test-results`, `e2e-regression-<shard>-test-results`, `e2e-nightly-extra-<leg>-test-results` | `test-results/<phase>/`: traces, screenshots and video of failures, `junit.xml`, `flaky-tests.json`; and `server.log`, the app's log |

A test that passes only on its retry keeps the job green and is shown in three places: the **job summary** of the run (a "flaky tests"
table at the bottom of the job's page, written by `scripts/ci-flaky-summary.mjs`; "No test passed only on a retry." when there is none, "No test results found at ..." when
the run failed before its tests started, at most 100 rows and "and N more" after them),
a warning annotation per test on the run, and `flaky-tests.json` in the `-test-results` artifact.

The jobs run exactly these commands, so you can run any of them yourself (Docker and the browsers needed, `CI=true` for the same reporters):

```bash
CI=true npm run test:e2e:release -- --tier smoke
CI=true npm run test:e2e:release -- --tier regression --shard 2/4
```

and the three `nightly-extra` commands above. Add `--list-only` for a dry run, and `E2E_OUTPUT_ROOT="$PWD/test-results/ci-smoke"` to
collect the reports in one place, as the jobs do.

- `CI=true` switches Playwright to the CI reporters (below), one worker and one retry; without it a run prints the `list` reporter only
  and writes no html or junit files.
- Each job's `E2E_OUTPUT_ROOT` is `test-results/ci-<job>` (with the shard or leg: `ci-regression-2`, `ci-nightly-extra-slow-serial`). Use a
  path under `test-results/` or `playwright-report/`, which version control ignores (another directory needs a `.gitignore` line).
- Docker comes with the GitHub-hosted runners, and the workflow has no Postgres service: the runner makes its own container.
- Browsers: `smoke` installs Chromium, Firefox and WebKit, a shard installs Chromium, a leg what it names. They are cached in
  `~/.cache/ms-playwright`, keyed by the Playwright version in `package-lock.json` and the browsers; on a cache hit only the system
  libraries are installed (`playwright install-deps`).
- Do not run the regression shards of one job on one checkout at the same time without `--reuse-build` (they share `.next`). In CI every
  shard has a machine of its own.
- Prerequisite: `npm ci` must succeed on the runner. `package.json` has `file:../typespec/packages/*` dependencies and the lockfile
  resolves from the public npm registry; a runner without the sibling `typespec` repository
  built at `../typespec`, fails at `npm ci`. `ci.yml` needs the same, and this workflow adds nothing for it: if `npm ci` fails, it fails
  in both workflows, and the fix belongs to both. (The same note is at the top of `.github/workflows/e2e.yml`.)
- `tests/unit/ci-e2e-workflow.test.ts` reads the workflow as YAML (read-only permissions, first-party actions only, a timeout on every
  job, uploads and the flaky summary after a failure, no tests selected twice) and checks that this page names every check; run it after
  an edit of the workflow. `actionlint` is not part of the repository: run it if you have it.

## Reading a run

Everything of a run is under its output root (printed at the start and at the end of the run). With `CI=true`:

| What | Where |
| --- | --- |
| html report of a phase | `<root>/playwright-report/<phase>/index.html`: `npx playwright show-report <root>/playwright-report/main` |
| junit | `<root>/test-results/<phase>/junit.xml` (retries included: a test that passed on a retry has a `<flakyFailure>`) |
| flaky tests | `<root>/test-results/<phase>/flaky-tests.json`, a FLAKY block in the console, a warning annotation and a table in the job summary on GitHub |
| skipped tests | `<root>/test-results/<phase>/skipped-tests.json` (written on every run, with or without `CI`; an empty list when nothing was skipped), a SKIPPED block in the console and in the phases summary, and a table in the job summary on GitHub |
| evidence of the specs | `<root>/test-results/evidence/<spec>/`: the generated text of every target, a step table, screenshots of the three specs that leave them (`E2E_EVIDENCE_DIR`, set by the phases script; one directory per run, where they used to share `/tmp/e2e-evidence`; helpers/evidence.ts) |
| traces, screenshots, video of failures | `<root>/test-results/<phase>/artifacts/<test>/`: `npx playwright show-trace <trace.zip>` |
| the app's log | `<root>/server.log` (kept whatever the result) |

The phases are `main` (and `serial` for the regression tier, which runs `serial-after` as its own command; `setup` and `serial` for the `serial` tier). The summary at the end of
the run lists each phase's result and the report paths that exist. A test that passes only on a retry does not fail the run and is never
hidden: it is listed as flaky in all of the above. Old runs stay in `test-results/run-<id>` (ignored by version control), and the release runner **prunes** them when a run starts:
it removes the run directories older than 7 days, except the newest five, which always stay (`E2E_KEEP_RUNS=<n>` changes the five; a value that is not
a positive whole number is exit 2), says what it removed (`[e2e-release] prune: ...`), and touches only a `run-<8 hex>` directory of `test-results`: another
directory, a file, a phase's own results and an `--output-root` somewhere else are never selected. A prune that fails never fails the run.

### Skipped tests are never invisible

A skipped test is green in every report ("1 skipped"), so a precondition that is never met (a variable nobody sets, a server nobody starts) used to
make a test pass for ever without running. Each phase's `tests/e2e/reporters/skipped-reporter.ts` therefore writes `skipped-tests.json`: every
test that did not run, with its project, place, tags and **why**: the reason of a static `test.skip(true, "...")` or `test.fixme`, of a runtime
`test.skip(condition, "reason")`, or "did not run" for a test that was selected and never started. The phases script prints a SKIPPED block in its
summary and **fails a phase that passed but skipped a test that is not tagged `@external`** (exit 1, in every tier, the smoke, regression, nightly,
serial and visual ones). A test tagged `@external` has a precondition outside the checkout (the network: schemastore.org; a second server: the
git-host import in `any` mode) and may skip; it is listed loudly with its reason, and the release runner starts the second server itself (below), so
only the network case is expected to skip. `E2E_ALLOW_SKIPS=1` allows every skip (still listed); CI never sets it (a contract test checks). A phase
whose list is missing fails as well: the gate could not be checked.


## REST API

`tests/e2e/api-v1.spec.ts` (`@regression`, plus the health test in `@smoke`) calls the REST API over HTTP with Playwright's `request`, no browser, and
asserts status codes and bodies: health, `/api/v1/docs` (a valid OpenAPI 3 document that names every route group), the 401 of every non-public
route (the spec reads `src/app/api` and fails on a route it does not know), schemas (list, filters, detail), emit and validate (the closure
`files`, `resolution`, the 422 `AMBIGUOUS_REFERENCE` error and its fix), the rate limit, webhooks, notifications, event specs, and what a bad request gets
(a body that is not JSON, several megabytes, a NUL byte in an id, a wrong method: never a 500, never a stack trace).

Three callers (`tests/e2e/helpers/api.ts`): the admin's saved session (the seeded global administrator: a session carries the signed-in user's real roles, so the admin's login
may use the webhook routes and a viewer's may not), the run's API key (`Authorization: Bearer`: a service principal acting as an `ADMIN` in the default tenant, `API_KEY_ROLE` and
`API_KEY_TENANT_ID` blank; the release runner makes the key up per run, starts the app with it as `API_KEY` and gives the browser run the same value as `E2E_API_KEY`; against a
server you started yourself, set both to one value), and nobody; the webhook test also signs in a viewer and a user with no role, made for it. Every test sends a client address
of its own in `X-Forwarded-For` (the run sets `AUTH_TRUST_PROXY=1`, without which the app ignores the header), so the allowance of requests that do not authenticate (20 a minute per
address) never couples two tests; the run lifts the per-principal allowance of an authenticated caller (`API_RATE_LIMIT_PER_MINUTE`, scripts/e2e-env.mjs). What the spec found and could not fix is in [known-defects.md](known-defects.md) (KD-027: a webhook URL has no policy; KD-028: the limit is per process). The rest of what it
first found was fixed with the access-control work: a key can create an endpoint, a session carries its roles, the schemas routes are scoped to a tenant and a role, no list
carries a signing secret, the rate limit trusts the proxy's word only and answers in the API's envelope.

```bash
npm run test:e2e:release -- --tier regression --project chromium --reuse-build -- tests/e2e/api-v1.spec.ts
```

## Entity references

`tests/e2e/reference-lifecycle.spec.ts` (the first test is `@smoke`, the rest `@regression`) is the multi-entity emission through the real UI. Each test
makes a workspace (`workspace` fixture) and entities with `unique()` names, because the reference prompt and the name-only resolution look at the whole
tenant and the tests run in parallel with the rest of the suite. What it covers: a reference picked in the type picker is stored qualified
(`domain / product / entity`) and generating the entity writes a file set (its file and the files of what it references: JSON Schema `$ref` to the sibling,
OpenAPI one self-contained document per entity, Avro the record inline, Protobuf and Java `import`; the database targets stay one file; "Download all" is one zip of the set with the paths kept, `<entity>-<target>.zip`); a
draft of the referenced entity shows in a draft preview (badge, list) that cannot be published, and "Regenerate from published and publish" does; the
publish dialog and the refused preview name an entity that was never published; a pin (the pin control) wins over a newer published version until it is
removed; a name-only reference that two entities answer to is asked about (the pick dialog, from Generate and from the publish dialog, and from the
TypeSpec tab) and the answer is stored qualified; the TypeSpec tab saves a source that names another entity; an imported document's `$defs` are generated
with their parent and its dangling reference stays dangling. The legacy name-only references are written straight into the database
(`createFieldRow` with `{ referencedEntityName }`), the only way to make one now that the UI writes qualified ones.

The JSON Schema matrix (`jsonschema-lifecycle.spec.ts`, `@slow`) checks the files of a multi-file output one by one (`artifactProblems`: no file is
trivial, the entity's own file names the entity: a bundle has the entity's name in every header, so the whole text could never fail that check). Its
declared known defects are the few that are left (a Protobuf nested array, a union of entities: see [known-defects.md](known-defects.md)).

```bash
npm run test:e2e:release -- --tier regression --project chromium -- tests/e2e/reference-lifecycle.spec.ts
npm run test:e2e:release -- --tier nightly --project chromium -- tests/e2e/jsonschema-lifecycle.spec.ts
```

## Accessibility

`tests/e2e/a11y.spec.ts` scans every route of the page sweep and the dialogs, tabs and overlays that matter with axe-core against a recorded baseline
(`tests/e2e/a11y-baseline.json`): a new violation fails, an entry that no longer occurs fails ("remove it"), so the baseline only shrinks. How it
works, how to rewrite it (`UPDATE_A11Y_BASELINE=1`), what was fixed and what is left: [a11y.md](a11y.md).

## Visual snapshots

`tests/e2e/visual.spec.ts` takes nine screenshots (login, register, the domain grid, an empty product, the entity editor, admin settings, the type mapping
table, the governance dashboard with nothing to decide, the shell's 404) and compares them with `toHaveScreenshot`. **Snapshots are made, and compared, only
inside the official Playwright Docker image**, `mcr.microsoft.com/playwright:v<the installed @playwright/test>-jammy` (today `v1.59.1-jammy`): the same page
renders differently on macOS and on Linux, and a snapshot made on a laptop would fail everywhere else. The `visual` project does not exist outside the
image (`playwright.config.ts`: `E2E_VISUAL_IN_DOCKER=1`, which only the script below sets): it is not a test that skips itself, and a run that names it says why.

```bash
docker pull mcr.microsoft.com/playwright:v1.59.1-jammy      # once; about 2.5 GB. The runner never pulls it for you
npm run test:e2e:visual                                       # compare to the committed snapshots (a difference fails, nothing is written)
npm run test:e2e:update-snapshots                             # take every snapshot again and write it to tests/e2e/visual.spec.ts-snapshots/
npm run test:e2e:update-snapshots -- --reuse-build -- --grep "login"   # options before the second --, Playwright's after it
```

(`node scripts/e2e-update-snapshots.mjs --help`.) Both are `node scripts/e2e-release.mjs --tier visual --docker-image <image>`: the database and the app are
made on the host as for any tier, and the browser run, the login and the `visual` project, is `docker run` of the image (`scripts/e2e-visual-docker.mjs`):

- the checkout is mounted at its own path, **read-only**: the container may write the run's output root and, only when the run updates the snapshots, `tests/e2e/visual.spec.ts-snapshots/`,
  and nothing else; it runs as your user (no file of the checkout becomes root's), with `--init` and `--shm-size=1gb` (not the host's IPC namespace), no `--privileged`, no added capability, and
  only the `E2E_*` names the browser run reads and `CI` (not the API key, not `DATABASE_URL`), passed by name. It is `ss-e2e-visual-<id>`, removed at the end whatever happened
  (`docker ps -a --filter name=ss-e2e-`; the suite never touches another container). The image tag is mutable: `--image name:tag@sha256:<digest>` pins one;
- on macOS and Windows the container reaches the host's loopback through `host.docker.internal`: `scripts/e2e-in-docker.mjs` forwards its own
  `127.0.0.1:<port>` of the app and of the database there, so the browser run uses the same URLs as on the host (and the app's own origin stays right); on Linux
  it shares the host's network. The image ships Node 24, which the Node guard lists as untested: the container is told `E2E_ALLOW_UNSUPPORTED_NODE=1`;
- a `node_modules` that is a symlink out of the checkout (a git worktree's) is mounted read-only at its own path; an output root outside the checkout is mounted read-write like any other;
- the runner logs the time of day on every line and the duration of every step that takes 2 s or more, and of the whole run (`done: exit 0 in 4m12s`), so a hole in a log has a name.

**What makes a page the same every time** (`visual.spec.ts` has the reasons): a tenant of its own with fixed names (`Visual Fixtures`: the domains Billing and
Customers, the products Invoicing, Payments (empty) and Profiles, the entity Customer with six fields; the viewed tenant is the `active_tenant` cookie, so the
explorer, the grid and the governance dashboard list this and nothing else); 1280x800, scale 1, English, UTC, reduced motion, no animation and no caret; a wait for
the page to settle (fonts loaded, nothing being fetched, nothing moving); a mask over every date, "N minutes ago" and the notification bell. The tolerance is `threshold: 0.1`
and `maxDiffPixelRatio: 0.0005` (about 500 pixels of 1280x800), in `playwright.config.ts`: with Playwright's default threshold of 0.2 a purple turned copper
passed; at 0.1 the same change fails all nine pages. The same image on the same machine differs by 0 pixels.

**When it fails.** The html report (`<output root>/playwright-report/main`) and `<output root>/test-results/main/artifacts/<test>/` hold the expected, actual and diff
images. A change you meant (a new look): run `npm run test:e2e:update-snapshots`, look at every image that changed (`git diff --stat tests/e2e/visual.spec.ts-snapshots`, then
open them), and commit them with the change. A change you did not mean is the bug. A snapshot that changed without a change to the product is a page that is not
still: find what moves (an animation, a loading state, a date) and mask it; do not widen the tolerance. A snapshot whose name has another platform than `-visual-linux` was not made in the image, and
`tests/unit/e2e/visual-snapshots.test.ts` refuses it.

**In CI** the `e2e-visual` job (nightly, tags, by hand) pulls the image of the installed version and runs `npm run test:e2e:visual` when the repository has snapshots;
when it has none it makes them, writes a notice, and uploads them as the artifact `e2e-visual-snapshots` for a maintainer to review and commit. It is not a job-level
`container:` because the runner needs Docker for its database, which a job container does not have; the browser run is inside the image all the same.

**CPU architecture.** The snapshots in the repository were made in the arm64 build of the image (Apple Silicon, Linux aarch64) and the CI runners are x86-64. The cross-architecture
noise was **not measured**: the amd64 variant of the image is not on the machine that made the snapshots, and getting it is a second 2.4 GB pull (the first one stalled for hours), so
`maxDiffPixelRatio` stays at 0.0005 (about 500 pixels of 1280x800: the edge of a glyph, not a button), the value chosen against the same-architecture runs (0 pixels of noise) and the CSS
simulations (700 to 13,000 pixels). Chromium's text rendering can differ by a few pixels between the two architectures. **If the first nightly `e2e-visual` runs report differences nobody
made**, do not widen the tolerance first: replace the baseline with the one the job makes on x86-64 (delete the committed snapshots in a branch and run the job by hand: with none committed it
makes them and uploads `e2e-visual-snapshots`; review the images, commit them), and if a few pixels of anti-aliasing still differ between two x86-64 runs, measure them and set the ratio from
that. Until a week of nightly runs says that it never fails by itself, `e2e-visual` is reported and not required.

## Troubleshooting

- **An assertion times out on a laptop but not in CI**: a web-first assertion waits 15 s (`expect.timeout` in `playwright.config.ts`; Playwright's
  default is 5 s). The server is one Node process: its answer to a server action took 0.1 s with one worker (what CI runs) and about 4 s with
  eight workers (the local default), so give a spec's own wait a reason (a state of the page), never a bigger number. A client form must not be
  typed into before React has hydrated it: `waitForHydration(locator)` (`tests/e2e/helpers/hydration.ts`) waits for that, up to 30 s.
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
- **"the app's credentials signinUrl is ..., not under http://localhost:<port>"** or **"the app offers an identity provider (...)"** (exit 3, before
  any test): a setting reached the app that the runner meant to override: an `AUTH_URL` / `NEXTAUTH_URL` or an `AUTH_PROVIDERS` from
  somewhere the runner does not control (a name the app reads that is in no group of `scripts/e2e-env.mjs`, or a loader that is not
  one of the three above). The message names the setting; `server.log` has the app's side.
- **A run is stuck after Ctrl-C**: the first Ctrl-C asks the step in progress to stop and runs the teardown; a second one kills the step
  at once (the teardown still runs). It never leaves the container behind unless you pass `--keep`.
- **"Node 26.3.1 is not supported by this suite ..."** (exit 2 from the scripts, an error from `playwright.config.ts` for a bare `playwright test`; before
  anything is provisioned): the Node of your shell is not 20.9+, 22 or 24. Run `nvm install 22 && nvm use 22` in the checkout (`.nvmrc`), or
  `nvm use 20`. `ls ~/.nvm/versions/node` lists the ones you have; the build is made once per Node major, it is part of the reuse hash.
  `E2E_ALLOW_UNSUPPORTED_NODE=1` overrides the refusal (Node 25 and 26 are not verified; Node 26.3.1 is the one that stalled).
- **A run that stalls**: a run that never ends, with every Playwright worker idle (the list shows the last test or no test at all, no summary, no
  CPU, no sockets), was seen four times on Node 26.3.1 (Homebrew) with a suite of about a hundred tests, and **once on Node 20.19.4** (2026-10-25: a smoke run whose 21 tests passed in 25 s and which then sat for 11 minutes with its three remaining workers and the Playwright process all idle, until it ended by itself; the next run of the same command took 25 s). So the guard is not the whole answer, and the watchdog below is what makes a run that hangs end. The Node guard keeps
  that Node away, and a watchdog covers whatever else makes a run hang: the phases script gives each phase a heartbeat file
  (`<output root>/test-results/<phase>/heartbeat`, rewritten by `tests/e2e/reporters/heartbeat-reporter.ts` at every test start and end and at the
  end of the run) and polls its modification time every 15 s. With no heartbeat for `E2E_STALL_MS` (**20 minutes** by default) it prints `stalled: no test finished for N min, workers idle, likely a Node/Playwright incompatibility (node <version>)`, ends Playwright (SIGTERM to
  its group, then SIGKILL for it and everything below it) and exits with **124**; the release runner then tears everything down as usual. It does not
  stop at the reporter's last "end": a hang after the last test is what it is for (the message then says every test had finished).
  The default is above the longest per-test timeout the suite declares: a running test is silent until it ends, and the longest are the link
  crawl of `navigation.spec.ts` (`@slow`, 15 minutes) and the 7-minute authored-lifecycle and events-publish tests (the other tests are 60 s to
  5 minutes). A unit test (`tests/unit/scripts/e2e-process.test.ts`) scans `tests/e2e` for every `test.setTimeout(` and `timeout:` and fails when
  `DEFAULT_STALL_MS` is not above the largest, so a longer test needs a longer default in the same change. A shorter limit for a hunt:
  `E2E_STALL_MS=180000` (3 minutes) on a run of short tests.
  `E2E_GLOBAL_TIMEOUT_MS` is Playwright's own `globalTimeout`, a hard ceiling on the whole run in milliseconds (unset: none).
  **CI sets neither of them**: `.github/workflows/e2e.yml` passes no `E2E_STALL_MS` and no `E2E_GLOBAL_TIMEOUT_MS`, so a CI run has the
  20-minute stall limit and no global ceiling; the jobs' own `timeout-minutes` (25 for smoke, 60 for a regression shard, 150 for `nightly-extra`, 30 for visual) are what ends a hung job
  first on the short tiers. Both are checked when the release runner starts: a value that is not a positive whole number of milliseconds is
  exit 2 there, while a bare `node scripts/e2e-phases.mjs` with a bad `E2E_GLOBAL_TIMEOUT_MS` only meets it when Playwright loads
  `playwright.config.ts`: Playwright throws and the phase exits **1** (a bad `E2E_STALL_MS` is exit 2 in both).
  Ctrl-C ends the run and the teardown removes its container as usual.
  The same end-of-run hang was seen again on 2026-10-26 (Node 20.19.4, twice in about a dozen runs of a spec or two: every test had passed, the workers sat idle until `E2E_STALL_MS` ended the run with 124), and
  once as `Tearing down "context" exceeded the test timeout of 60000ms` on a test whose assertions had all passed, with Google Chrome and with Playwright's bundled Chromium alike: it is not Chrome's. With
  `video: "retain-on-failure"` every context records a video, so closing one waits for the encoder, and under load that is where the time goes. A hunt for it: `E2E_STALL_MS=240000`; the tests' own result is in the list.
- **Timeouts under load**: the default is 8 workers, and on a laptop that is also running other work (a load average above 30) they time out tests that pass alone, and WHICH tests changes from run to run
  (the whole regression tier on Chromium, 353 tests: 8 workers, 14.6 minutes and 5 failures, every one a wait that ran out, in five different specs; the run before it, 2 failures in two other specs; the same tier with
  `-- --workers=4`, 6.8 minutes, 0 failures). A failure that passes alone and moves between runs is load: run the tier with `node scripts/e2e-release.mjs --tier regression --project chromium --project serial-after -- --workers=4`.
- **"the Playwright image ... is not on this machine"** (exit 3, before anything is provisioned): `docker pull mcr.microsoft.com/playwright:v<version>-jammy` (the version of
  `@playwright/test` in `node_modules`; about 2.5 GB). The runner never pulls it. A `ss-e2e-visual-*` container left by a killed run: `docker rm -f <name>`.
- **The browser run in the image cannot reach the app** (the setup login times out, `ECONNREFUSED` on the app's port): on macOS the container reaches the host through
  `host.docker.internal`, which Docker Desktop and Rancher Desktop both provide; do not add `--add-host=host.docker.internal:host-gateway` (on Rancher Desktop it points
  the name at the VM, not at the host). `docker run --rm <image> getent hosts host.docker.internal` says where the name goes.
- **"the `visual` project exists only inside the Playwright Docker image"**: you ran `--project=visual` (or the spec) outside it. Use `npm run test:e2e:visual`.
- **Port conflicts**: ports are picked at random and checked when the run starts; if the database port is taken at that moment the runner
  picks another (three tries).

## Access control

The operational side of authentication (the session secret, trusting the host, open registration and the first administrator, the health endpoint) is in
[`docs/auth-ops.md`](../auth-ops.md); read its registration warnings before a deployment is reachable by anyone else.

The seeded user `admin@admin.com` is a platform `ADMIN`; the suite logs in as that user and sees everything. The rule for every other role (viewer, author, steward,
compliance officer, admin, held per platform, tenant, domain or product) is `src/lib/access/actions.ts`, and what the browser suite proves about it, per role and per place it is enforced,
is [`access-control.md`](access-control.md) (`tests/e2e/access-matrix.spec.ts`).

**Making a second person.** A test that needs somebody who is not the admin makes them through the database helpers and signs them in through the real login form:
`withSecondUser(browser, baseURL, body, { roles: [{ role: "AUTHOR", scope: { tenantId, domainId } }] })` (`tests/e2e/helpers/second-user.ts`: `createUser` stores the password with the
app's own `hashPassword`, `grantRole` writes the role row as the app stores it, a user with no `roles` holds no role and lands on `/no-access`). A role without a `scope` is held over the tenant
the admin sees. A test of the register page itself uses `registerThroughTheForm`. A person who wrote something has an audit row that points at them (immutable): they cannot be
deleted, and `deleteUsersBestEffort` leaves them.

**Sign-in in the run.** The app under test runs with `AUTH_REGISTRATION=open` (`scripts/e2e-env.mjs`; the default is `invite`): a user who registers through the
page holds **no role**, is **not signed in by registering** (the answer is the same for an address that exists, so it redirects to `/login` either way), and lands on
`/no-access` after signing in; that is why a test does not get a user by registering. The second app of the nightly tier (and `--second-app`) runs `AUTH_REGISTRATION=invite`, and
`access-matrix.spec.ts` uses it for the `invite` mode (`@external`); the `closed` mode is covered by unit and PGlite tests (`tests/unit/app/register-actions.test.ts`), not by a server. Sign-in is throttled in the run like anywhere
(5 failures per e-mail, and a per-address bucket of 100: the run sets `AUTH_TRUST_PROXY=1`, so an address comes from `X-Forwarded-For` when a request sends one, as the API specs do, and every request without the header, the browser's, is one address): a spec that fails a login on purpose does it for an e-mail of its own.
Users that accepted an invitation or used a reset link cannot be deleted (their audit entries are immutable and point at them); the run's database is thrown away.

# Release UI suite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One command runs a tiered Playwright release check of the whole product against a throwaway database, locally and in CI, with a coverage matrix of every feature area.

**Architecture:** A runner script provisions a throwaway PostgreSQL (Docker), migrates and seeds it, builds and starts the app (production build), runs Playwright tiers selected by tags, and always tears everything down. Playwright config gains setup (one-time login), browser and tier projects; specs share fixtures (auth state, per-spec workspace, collision-proof names).

**Tech Stack:** `@playwright/test` ^1.59, Docker postgres:16, Prisma, Next.js (`next build --webpack`, `next start`), `@axe-core/playwright`, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-10-23-release-ui-suite-design.md` (read it first). Related earlier work: `.superpowers/sdd/2026-10-21-jsonschema-import-fidelity/browser-lifecycle-report.md` (how the existing specs run) and the inventory of routes/features summarised in the spec.

## Global Constraints

- Playwright only; keep the repo style: plain helper functions in `tests/e2e/helpers`, per-spec test-id constants, no page-object framework.
- Tags via `test(name, { tag: [...] }, fn)`: `@smoke`, `@regression`, `@slow`, `@external`; selected with `--grep` / `--grep-invert`. Every test carries at least one tier tag (a lint/guard test enforces it).
- Environment per run: throwaway Docker `postgres:16` database, `prisma migrate deploy`, `db:seed`, production build (`next build --webpack`, `AUTH_TRUST_HOST=true next start`), torn down in a `finally`. Never touches a developer's `.env` database, `data/pglite`, or a running dev server (random free port).
- Smoke tier: about 5 minutes, runs on Chromium, Firefox and WebKit; regression: Chromium, sharded, `retries: 1`; a test that passes only on retry is reported as flaky, never hidden.
- No `waitForTimeout` sleeps, no `test.fixme`/skip without a tracked reason in the test title, no order dependence between tests except inside an explicit `serial` describe, no shared mutable data between spec files.
- Settings once in config: `navigationTimeout 60_000`, `actionTimeout 30_000`, `trace: retain-on-failure`, `screenshot: only-on-failure`, `video: retain-on-failure`; reporters `list` locally, `html` (open: never) + `junit` in CI.
- Visual snapshots only in a dedicated Chromium project, generated in the official Playwright Docker image, dates/ids masked. Accessibility: `@axe-core/playwright` against a recorded baseline; new violations fail.
- Missing `data-testid`s are added to product code where a spec would otherwise match on text; keep ids kebab-case and stable.
- Not tested in the browser: Git export (no UI), `/dev/design-system`, Google sign-in.
- No Co-Authored-By trailers. Leave pre-existing uncommitted `.gitignore`/`.ignore` alone.

## Review Focus

- Teardown on failure/interrupt: Docker container, port and temp dirs are removed when a run fails or is Ctrl-C'd (Task 2).
- Two suite runs at the same time (different ports, databases) do not interfere (Task 2).
- A test that passes only on retry is surfaced as flaky in the report (Task 1).
- Auth state expires or is stale: setup project re-logs in per run, never reuses a committed file (Task 1).
- Visual snapshots produced on one OS must not fail on another: only run in the Docker image (Task 7).

---

### Task 1: Config, tags, fixtures, tidy existing specs

**Files:**
- Modify: `playwright.config.ts`, `package.json` (scripts), `tests/e2e/helpers/auth.ts`, `tests/e2e/helpers/db.ts`, existing specs under `tests/e2e/*.spec.ts`
- Create: `tests/e2e/auth.setup.ts`, `tests/e2e/helpers/fixtures.ts`, `tests/e2e/helpers/unique.ts`, `tests/unit/e2e-suite-guard.test.ts`
- Test: `tests/unit/e2e-suite-guard.test.ts`

**Interfaces:**
- Produces: projects `setup`, `chromium`, `firefox-smoke`, `webkit-smoke`, `serial-after`, `visual`, `a11y`; `export const test` from `fixtures.ts` extending Playwright's `test` with `authedPage` (storageState from the setup project), `workspace` (creates a domain/product and optional entities, removes them afterwards: `{ domainName, productName, domainSlug, productSlug, cleanup() }`) ; `unique(prefix: string): string` (prefix + 8 random base36 chars); npm scripts `test:e2e:smoke` (`--grep @smoke`), `test:e2e:regression` (`--grep-invert "@slow|@external"`), `test:e2e:nightly` (all).

- [ ] **Step 1: Write the failing guard test** `tests/unit/e2e-suite-guard.test.ts`: scans `tests/e2e/**/*.spec.ts` and asserts (a) every `test(` call has a tier tag, (b) no `waitForTimeout(`, (c) no `test.fixme(` / `test.skip(` whose title lacks a reason in brackets, (d) no copy-pasted `test.use({ navigationTimeout` blocks (config owns them), (e) no `createDomain`/`createProduct` local function redefinition outside `helpers/`.
- [ ] **Step 2: Run** `npx vitest run tests/unit/e2e-suite-guard.test.ts` — expect FAIL listing offenders.
- [ ] **Step 3: Implement** config (projects, timeouts, reporters via `process.env.CI`), `auth.setup.ts` (UI login once, `storageState` to `playwright/.auth/admin.json`, git-ignored), `fixtures.ts`, `unique.ts`; make `helpers/auth.ts`'s `authedPage` reuse the state; replace the fake-cookie `layout.spec`; consolidate duplicated helpers (`createDomain`, `createProduct`, `createEventFromMenu`, `RAW_DB_TEXT`) into `helpers/`; tag every existing test (`jsonschema-lifecycle` matrix and `events-external-refs`, `navigation` crawl = `@slow`; URL-import network tests = `@external`; basic flows = `@smoke`; rest `@regression`); resolve the `schema-lifecycle` `test.fixme` (fix or remove with a note); replace the `waitForTimeout`/swallowed `networkidle` waits with web-first assertions; `helpers/db.ts` reads `E2E_DATABASE_URL ?? DATABASE_URL` (never `.env` unless that is all that is set).
- [ ] **Step 4: Run** the guard test (PASS) and `npx playwright test --list` (every test listed under a tier).
- [ ] **Step 5: Commit** `test(e2e): tiered config, shared auth state and fixtures, tag and tidy existing specs`.

### Task 2: Release runner (throwaway DB, build, start, tiers, teardown)

**Files:**
- Create: `scripts/e2e-release.mjs`, `docs/testing/e2e.md`
- Modify: `package.json` (scripts `test:e2e:release`, `test:e2e:release:smoke`), `.gitignore`
- Test: `tests/unit/scripts/e2e-release.test.ts` (unit-test the pure parts: arg parsing, port picking, env assembly, teardown ordering with fake deps)

**Interfaces:**
- Produces: `node scripts/e2e-release.mjs --tier smoke|regression|nightly [--keep] [--shard i/n] [--project name]` and exports `planRun(args, env): RunPlan` and `runRelease(plan, deps): Promise<number>` (exit code). Steps: pick a free app port and DB port; `docker run -d --rm postgres:16` with a random name and password; wait healthy; `DATABASE_URL`/`E2E_DATABASE_URL` set; `prisma migrate deploy`; `db:seed`; `next build --webpack` (skipped with `--reuse-build` when `.next` is newer than `src`); `AUTH_TRUST_HOST=true next start -p <port>` with `NEXTAUTH_SECRET`/`NEXTAUTH_URL`; poll `/api/v1/health`; run `playwright test --grep <tier>`; always stop the app, remove the container, delete temp dirs, in a `finally` and on SIGINT/SIGTERM.

- [ ] **Step 1: Write failing unit tests**: `planRun` maps tiers to the right Playwright args; two plans pick different ports; `runRelease` with fake deps calls teardown when a step throws and on a simulated SIGINT, in reverse order of setup; `--keep` skips container removal but still stops the app.
- [ ] **Step 2: Run** the test — expect FAIL.
- [ ] **Step 3: Implement** the runner (plain Node, no new dependency beyond what exists; Docker via `child_process`), the docs page (how to run locally, in CI, how to read reports, how to update visual snapshots, troubleshooting: Turbopack/symlinked node_modules in worktrees, `AUTH_TRUST_HOST`, parser worker build), and the npm scripts.
- [ ] **Step 4: Run** the unit tests (PASS), then a real dry run `npm run test:e2e:release:smoke -- --list-only` that provisions, migrates, seeds, builds, starts, lists the smoke tests and tears down (verify container gone with `docker ps`).
- [ ] **Step 5: Commit** `test(e2e): release runner with throwaway database and guaranteed teardown`.

### Task 3: CI job

**Files:**
- Modify: `.github/workflows/ci.yml` (or create `.github/workflows/e2e.yml`)
- Test: `tests/unit/ci-e2e-workflow.test.ts` (parses the workflow YAML and asserts triggers, steps and artifact upload)

**Interfaces:**
- Produces: workflow `e2e` — on `pull_request`: smoke (three browsers); on `schedule` (nightly) and tags `v*`: regression + nightly tiers, 4 shards; Postgres service or Docker, Node 22, `npx playwright install --with-deps`, cache of Playwright browsers, uploads `playwright-report`, `test-results` (traces/videos), junit XML as artifacts on failure and always for regression; smoke job required for merge (documented), regression reporting only.

- [ ] **Step 1: Write failing test** asserting the workflow has the three triggers, a smoke job, a sharded regression job, `playwright install`, artifact uploads with `if: always()` for reports.
- [ ] **Step 2: Run** `npx vitest run tests/unit/ci-e2e-workflow.test.ts` — expect FAIL.
- [ ] **Step 3: Implement** the workflow using the release runner (`npm run test:e2e:release -- --tier ...`).
- [ ] **Step 4: Run** the test (PASS) and `npx --yes action-validator` or `actionlint` if available (else note it).
- [ ] **Step 5: Commit** `ci: end-to-end release job (smoke on pull requests, regression nightly and on tags)`.

### Task 4: Specs batch 1 — auth, page sweep, hierarchy CRUD (smoke-critical)

**Files:**
- Create: `tests/e2e/auth.spec.ts`, `tests/e2e/smoke-pages.spec.ts`, `tests/e2e/hierarchy-crud.spec.ts`
- Modify: product components where `data-testid` is missing (domain/product grids, admin tabs, auth forms, delete dialogs)
- Test: the specs themselves

**Interfaces:**
- Consumes: Task 1 fixtures (`test`, `authedPage`, `workspace`, `unique`).
- Produces: `auth.spec` (login success; wrong password shows "Invalid email or password"; unauthenticated visit redirects to /login; sign out; register creates a user and signs in) `@smoke`; `smoke-pages.spec` (a table of every ActivityBar route and admin tab: loads, no 5xx response, no console error, no error boundary, heading visible; plus `GET /api/v1/health`) `@smoke`; `hierarchy-crud.spec` (create/edit/delete domain incl. DomainDeletionDialog impact counts, create/edit/delete product, create entity via wizard Start Blank, rename, delete, tenant-level entity via enterprise wizard) `@smoke` for the create path, `@regression` for the rest.

- [ ] **Step 1: Write the specs** with the exact flows above; each asserts a visible outcome (not just "no error").
- [ ] **Step 2: Run** `npm run test:e2e:release:smoke` — expect failures where testids or behaviour are missing.
- [ ] **Step 3: Add** the missing testids; fix real product bugs found (failing test first) or record them under "Bugs found" in the final report.
- [ ] **Step 4: Run** smoke tier three times — expect green and no flaky report.
- [ ] **Step 5: Commit** per spec file.

### Task 5: Specs batch 2 — entity publish/versions, entity tabs, importers

**Files:**
- Create: `tests/e2e/entity-publish-versions.spec.ts`, `tests/e2e/entity-tabs.spec.ts`, `tests/e2e/importers.spec.ts`, `tests/e2e/fixtures/importer-samples/` (Avro, Protobuf, OpenAPI, BigQuery DDL, TypeSpec multi-model)
- Modify: product components for missing testids

**Interfaces:**
- Produces: publish dialog (bump kinds, blockers, confirm), Versions tab and diff, deprecate and retire banners (possible now that the database is throwaway Postgres, so immutable audit rows are fine); Governance, Alerts, API, Deployments and TypeSpec tabs, field studio, right panel, primary-key dialog outside JSON Schema, type-mapping override, staged emit; importer matrix (Avro, Protobuf, OpenAPI, BigQuery, TypeSpec multi-model, file drop, Standards Library, Natural Language with AI unconfigured shows the configuration message) each paste/drop → review → create → generate one target.

- [ ] **Step 1: Write the specs** (`@regression`; the importer matrix `@regression`, the publish happy path `@smoke`).
- [ ] **Step 2: Run** the regression tier for these files — expect failures to triage.
- [ ] **Step 3: Fix** product bugs (failing test first) or record them; add testids.
- [ ] **Step 4: Run** three times for flakiness.
- [ ] **Step 5: Commit** per spec file.

### Task 6: Specs batch 3 — governance/compliance, admin, discovery, domain assets, glossary/lineage, type-mappings

**Files:**
- Create: `tests/e2e/governance-compliance.spec.ts`, `tests/e2e/admin.spec.ts`, `tests/e2e/discovery.spec.ts`, `tests/e2e/domain-assets.spec.ts`, `tests/e2e/glossary-lineage.spec.ts`, `tests/e2e/type-mappings.spec.ts`
- Modify: product components for missing testids (admin pages have almost none)

**Interfaces:**
- Produces: governance request approve/reject, retention policy editor; compliance Query/Gaps/Audit tabs, filters, CSV export (download asserted); admin users/roles, domains, emitters, health, classifications, settings persistence (theme, font size, language survive reload); command palette, keyboard shortcuts (Mod+K, `/`, Esc), tenant switch, notifications bell and page filters; domain and product Data Types, APIs, Properties/traits and the trait editor, enterprise traits; glossary create and search, lineage graph render and node popover; type-mappings reference table. All `@regression`.

- [ ] **Step 1: Write the specs.**
- [ ] **Step 2: Run** the regression tier for these files and triage.
- [ ] **Step 3: Fix** product bugs (failing test first) or record them; add testids.
- [ ] **Step 4: Run** three times for flakiness.
- [ ] **Step 5: Commit** per spec file.

### Task 7: API, accessibility and visual tiers

**Files:**
- Create: `tests/e2e/api-v1.spec.ts`, `tests/e2e/a11y.spec.ts`, `tests/e2e/a11y-baseline.json`, `tests/e2e/visual.spec.ts`, `tests/e2e/visual.spec.ts-snapshots/` (generated in Docker), `scripts/e2e-update-snapshots.mjs`
- Modify: `package.json` (`@axe-core/playwright` devDependency, scripts `test:e2e:update-snapshots`)

**Interfaces:**
- Produces: `api-v1.spec` via Playwright `request` (health without auth; schemas list/detail/emit/validate including the closure `files` shape and 422 ambiguous error; webhooks CRUD and deliveries; notifications; docs JSON) `@regression`; `a11y.spec` scanning every ActivityBar route and key dialogs with axe, comparing violations to `a11y-baseline.json` (new violations fail; the baseline only shrinks) `@regression`; `visual.spec` Chromium-only `toHaveScreenshot` for login, domains grid, an empty state, an entity editor, admin settings, with dates/ids masked, run only through the Docker image used by `scripts/e2e-update-snapshots.mjs` (documented).

- [ ] **Step 1: Write the specs.**
- [ ] **Step 2: Run** them; generate the baseline and snapshots (inside `mcr.microsoft.com/playwright:v<installed version>-jammy` with the repo mounted), commit them.
- [ ] **Step 3: Verify** `visual` passes a second time from a clean checkout path and fails when a CSS change is simulated (revert after).
- [ ] **Step 4: Run** three times for flakiness.
- [ ] **Step 5: Commit** `test(e2e): API, accessibility baseline and visual snapshot tiers`.

### Task 8: Full release run, triage, coverage matrix

**Files:**
- Create: `docs/testing/e2e-coverage-matrix.md`
- Modify: whatever the triage requires (specs, product code with failing tests first)

**Interfaces:**
- Consumes: Tasks 1-7 and plan `2026-10-23-multi-entity-emission.md` Task 12 (the reference-lifecycle spec is part of the `@regression` tier and must be in this run).
- Produces: a matrix mapping every route/feature area from the spec inventory to its specs and tier; the final run's pass/flaky/fail numbers per tier and browser; a list of product bugs found (fixed / open).

- [ ] **Step 1: Run** `npm run test:e2e:release -- --tier nightly` (everything) and `--tier smoke` on all three browsers; collect the reports.
- [ ] **Step 2: Triage** every failure: product bug (fix with a failing test first when small, else record), test bug (fix), environment (document).
- [ ] **Step 3: Re-run** until the smoke tier is green on three consecutive runs and regression has no unexplained failures; record flaky tests and fix or quarantine with a tracked reason.
- [ ] **Step 4: Write** the coverage matrix and add the release checklist section ("before every release: `npm run test:e2e:release -- --tier nightly`, expected result, where reports live") to `docs/testing/e2e.md`.
- [ ] **Step 5: Commit** `docs(e2e): coverage matrix and release checklist`.

---

## Self-review notes

- Spec coverage: framework/tier/fixtures/CI/coverage/visual/a11y decisions → Tasks 1-8; throwaway database and teardown → Task 2; the multi-entity reference spec comes from the other plan's Task 12 and is run in Task 8.
- Names used across tasks: `test`/`authedPage`/`workspace`/`unique` (Task 1) consumed by Tasks 4-7; `test:e2e:release*` scripts (Task 2) used by Tasks 3-8.
- Open builder calls: folder layout inside `tests/e2e`, sharding count, which pages enter the visual tier, a11y baseline format.
- Sequencing: runs after the multi-entity plan's Tasks 8-11 and before its Task 12 (so Task 12's reference spec is written with the new fixtures).

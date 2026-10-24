# Release UI regression suite (Playwright)

Date: 2026-10-23. Status: draft for approval.

## Intent and why

Every release of the product must be checked in a real browser, across the whole product, with one command, and with a result a person can trust (green means releasable). Today there are 18 Playwright specs (~78 tests) that cover the schema import/generation lifecycle, events, navigation and contacts well, but whole areas have no browser test at all (auth, admin, governance, compliance, glossary, lineage, notifications, hierarchy CRUD, entity publish/versions, most importers, command palette, REST API), the suite is not run by CI, and it depends on a developer's local database state.

## Framework decision

Playwright (`@playwright/test`), already in the repo. It drives real Chromium/Firefox/WebKit, auto-waits (fewer flaky tests), records traces, screenshots and video on failure, shards across machines, has built-in API testing, visual snapshots and accessibility integration (`@axe-core/playwright`). No change of framework; the existing specs are kept and reorganized.

## Decisions (the assistant's calls unless marked; change any you disagree with)

1. **Environment per run:** a throwaway PostgreSQL database (Docker `postgres:16` locally and in CI), migrated and seeded fresh, app started from a production build (`next build --webpack` then `AUTH_TRUST_HOST=true next start`), database dropped at the end. This removes the PGlite single-process/SIGINT problem, lets the suite delete what it creates, and allows the publish/version flows (immutable audit rows) to be tested through the UI. One command: `npm run test:e2e:release` creates everything, runs, tears down.
2. **Tiers selected by tags** (`test(name, { tag: ["@smoke"] }, fn)`, `--grep`):
   - `@smoke` (about 5 minutes, on every pull request): login, a sweep that every page loads without a server error or console error, create domain/product/blank entity/field, generate one target, create and save an event, shell 404, API health. Runs on Chromium, Firefox and WebKit.
   - `@regression` (nightly and before every release): every functional spec, Chromium, sharded, one retry.
   - `@slow` / `@external`: the 15-variation JSON Schema matrix across all targets, external refs, the navigation crawl (stays serial), network-dependent URL import. Run nightly, not per pull request.
   - `visual`: Chromium-only screenshot comparisons on a few stable pages, with snapshots generated in the Playwright Docker image (macOS and Linux render differently), dates and ids masked.
   - `a11y`: an axe scan of every route against a recorded baseline of known violations; new violations fail.
3. **Fixtures:** one-time login via a setup project saving `storageState` (replaces the per-test UI login and the fake-cookie layout spec); a `workspace` fixture that creates and removes a domain/product/entities for a spec; collision-proof unique names (random suffix, not just a timestamp); timeouts, trace, screenshot and video set once in the config instead of copy-pasted into 14 specs.
4. **Conventions:** keep the repo's style (plain helper functions in `tests/e2e/helpers`, per-spec test-id constants), no page-object framework. Duplicated helpers are consolidated into the shared helpers. Missing `data-testid`s are added to the product code where specs would otherwise rely on text matching (admin pages, domain/product grids).
5. **Reporting and gating:** `list` locally; `html` plus `junit` on CI; a flaky test (passes only on retry) is reported, not hidden; no `test.fixme`/skip may remain without a tracked reason (the one existing `fixme` is resolved or removed).
6. **CI:** add an end-to-end job to the GitHub workflow (Postgres service, build, install browsers, `@smoke` on pull requests, `@regression` nightly and on release tags, artifacts for traces and reports). (The user asked for something to run at every release; whether it also gates merges is the assistant's call: smoke gates, regression reports.)
7. **Coverage to add**, most release-critical first: auth (login success/failure, protected redirect, sign out, register); page sweep (every ActivityBar route and admin tab); hierarchy CRUD (domain/product/entity create, edit, delete incl. the deletion dialog, tenant-level entity); entity publish and versions (bumps, blockers, diff, deprecate, retire); importers (Avro, Protobuf, OpenAPI, BigQuery, TypeSpec multi-model, file drop, Standards Library, Natural Language with AI unconfigured); entity tabs (Governance, Alerts, API, Deployments, TypeSpec, field studio, right panel, primary-key dialog, type-mapping override, staged emit); governance and compliance (requests, retention, query/gaps/audit, CSV export); admin (users/roles, domains, emitters, health, classifications, settings persistence); discovery (command palette, shortcuts, tenant switch, notifications); domain assets (data types, APIs, traits); glossary and lineage; REST API v1 and webhooks (Playwright `request`); type-mappings page; the new multi-entity reference flow (published/draft/pinned references, file sets, ambiguity prompt) once it lands.
8. **Not tested in the browser:** Git export (no UI exists), `/dev/design-system` (development only), Google sign-in (external).

## Goals

- One command runs the whole release check; the same suite runs in CI.
- A new product area is covered by adding a spec in a known place with a known tag.
- A failing run produces enough evidence (trace, screenshot, video, server log) to diagnose without re-running.
- The suite never depends on or damages a developer's own database or running dev server.

## Non-goals

- Replacing the Vitest unit/integration suites or the corpus.
- Load/performance testing.
- Testing against real cloud services (Spanner/BigQuery) from the browser suite.

## Anti-goals (a failure even if it "works")

- Green runs hiding skipped or retried-until-green tests.
- Tests that pass only on a developer machine, a dev server, or a particular database.
- Visual snapshots that fail on every other machine.
- A suite so slow nobody runs it before a release (the smoke tier must stay near five minutes).

## Left to the builder

- Exact folder layout inside `tests/e2e`, names of the fixtures, how the run script orchestrates Docker/Postgres, ports.
- Which specific pages enter the visual tier; the accessibility baseline format.
- Sharding count for the regression tier.

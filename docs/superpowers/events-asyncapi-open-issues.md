# Events (AsyncAPI 3) program — open issues at merge (2026-10-15)

State at `feat/events-asyncapi` tip `63b2b9fb`, merged into `main`. Phase 4b (Events core) is complete, the final
whole-branch review ran (five area reviewers), and its Critical/Important findings were fixed (F1–F7). This file
lists what is **still open**. Spec backlog (Epics 13–22) lives in
`docs/superpowers/specs/2026-10-13-events-asyncapi-design.md` §14; this is the delta found during execution and review.

## 1. Decisions needed (do not change without an owner decision)

| # | Item | Why it is open | Recommendation |
|---|---|---|---|
| D1 | **Authentication is cookie-presence only** (`src/middleware.ts`): any `authjs.session-token=<anything>` passes; every `/api/*` path is public; `/api/domains-tree` and `/api/tenants` need no auth and return domain/product/entity names, ids and all tenants. `tests/e2e/layout.spec.ts` relies on the fake cookie. | Pre-existing; app-wide behavior change (login, e2e). | Auth.js edge-safe split config verifying the JWT in middleware; `auth()` on both routes; e2e mints real sessions (`tests/e2e/helpers/auth.ts`); middleware test. Treat as the top security item. |
| D2 | **Tenant boundary strictness.** Tenant is a "soft grouping" (`active-tenant.ts`): the `active_tenant` cookie is client-controlled, `isActive` is not checked, no `secure` flag; RBAC is not enforced (`ctx.userRole` is never read by services — a VIEWER can create/update/delete products). Entity page loads any entity by bare id (`[entityId]/page.tsx` legacy-link arm); product/domain pages fall back to a tenant-agnostic domain lookup; draft privacy is page-level only (REST `?version=draft` and the emit actions are tenant-scoped, not product-scoped); Bearer API-key callers resolve the tenant through the cookie (machine clients only reach the fallback tenant); unscoped loaders remain: deployments overview, governance lists, glossary, lineage, `getDomainsAction`, `/api/command-palette-fields`. | Design choice with wide blast radius. | Decide hard boundary vs soft grouping. If hard: tenant-bound API keys / `X-Tenant-Id`, strict 404 loaders, RBAC in services. |
| D3 | **Avro emitter** (`~/src/my/typespec/packages/avro`, other repo): hardcodes `decimal(38,0)` (`transform.ts:47`), does not sanitise enum symbols (this repo now projects them), stack-overflows on a self-referencing entity. JSON Schema emitter renders int64/uint64/decimal as `{"type":"string"}`. | Lives outside this repo. | Fix upstream; update `default-mappings.ts` note when done. |
| D4 | Classification mapping policy (SENSITIVE→Confidential, NEVER_STORED→Restricted) is an unconfirmed choice. | Governance policy. | Confirm or change. |
| D5 | Leftover dev-DB test rows (~21 `e2e-domain-*`, ~10 `evt-*`/`ft-*` domains, 3 `ft-*` tenants) and hundreds of undeletable `PUBLISH_VERSION` audit rows from tests. | Never OK'd for deletion (audit rows are trigger-protected). | OK a one-off cleanup of the domains/tenants; audit rows need a trigger bypass. |
| D6 | Mutually pinning entities (A@1.0↔B@1.0 by publish order) can never be deleted, nor their product/domain (spec §6.1 "deprecate instead"). The remedy text does not say "deprecate instead" yet. | Product decision. | Add hint now; closure-aware "delete together" later if wanted. |

R78 (decided in review): Event Spec bump is MAJOR on channel format/dialect/protocol change, trait headers-pin major move, and `defaultContentType` change; server removal stays MINOR. Spec §6.1 updated.

## 2. Security / hardening follow-ups

- **TypeSpec import actions:** the 30 s timeout cannot stop synchronous CPU work (event-loop DoS for an authenticated author; needs a worker/child process); abandoned compiles are uncapped; no role check; `compileAndApplyTypeSpecSourceAction` relies on Next's 1 MB body default.
- **Raw error text sweep (H6):** non-Events services still build `DB_ERROR/INTERNAL_ERROR` messages from `e.message` (`entity-version.service.ts:257`, `annotation`, `compliance`, `git`, `stale-source-flag`, `typespec-source-migration`, `health`); REST `apiError` forwards them verbatim; `generateSchemaAction` returns emitter stdout/stderr with absolute paths; deadlock families not mapped to retryable CONFLICT (`setChannelMessages` vs `deleteMessage`, `auditedWrite` trait/channel/message deletes).
- **Governance requests / glossary links / admin actions:** role-gated writes, unscoped loaders (see D2).
- **Rate limit** keys on a spoofable `X-Forwarded-For`; `GET /v1/schemas*`, webhooks, notifications are unlimited; `?version=draft` renders on demand (shells out to `tsp`). No global security headers (frame-ancestors, HSTS, nosniff). `middleware` → `proxy` deprecation warning from Next.
- **Entity guard-then-delete race:** a referrer published between the guard check and the delete leaves a dangling edge (milliseconds, recoverable). Fix = lock handshake on `entity_versions` rows (publish `FOR KEY SHARE`, delete `FOR UPDATE`).
- Defence in depth: `loadHeaderPinFacts` entity-version lookup has no tenant clause; drift call in `load-events-tab-data.ts`/`load-event-spec-page.ts` is awaited bare (wrap and fall back to the stored flag); guard cost is 2–3 queries per action (cache per request); `applyTypeSpecAction` write + draft mark not atomic (an existing governance test pins `$transaction` called once with 3 ops — relax by finding the batch by content).

## 3. Product / UX follow-ups

- Warn before publishing with unsaved edits (Message and Event Spec pages); concurrent-edit protection (no `updatedAt` precondition); no-op Save flags "unpublished changes"; a correlation id without a location cannot be cleared; delete confirms use `window.confirm`.
- "Used by" rows for messages/specs still link to the Events **list** tab (detail routes exist: swap to detail hrefs; touches 5 T11 test files); no in-app "Open in owner" link to a foreign product's read-only view (reachable by URL only); entity `?version=` has no read-only view.
- Per-page `<title>` is not set; product-level and domain-level "Entities" sidebar rows lack the `?tab=entities` highlight; sidebar rows are `div`+`onClick` (no middle/cmd-click); breadcrumb `<nav>` in `field-studio.tsx` lacks an `aria-label`; icon-only ActivityBar/RightPanel buttons lack names; `ImportDialog.tsx` is dead code.
- `loadEntityOptions` is unbounded and runs on every product page load (lazy-load via action); `usage.ts` has no cap/pagination; the events allow-list lists every tenant message (server cap 200, no search); the "unpublished changes" badge also lights up for any edited shared trait (D8 `hasChanges`).
- Unified Schema Workbench (other session): symmetric discard-confirm (loading over a form-built schema), notice flicker, "Start over" has no confirm, equivalence check rejects harmless variants with a vague reason, `fields:[]` edge cases, vacuous unmount-timer test.

## 4. Data / architecture follow-ups

- Store the root model name at publish time (`entity_versions`, schema change): a rename currently breaks hand-authored multi-model frozen sources (`ROOT_MODEL_NOT_FOUND`); Avro namespace derives from live slugs.
- Migration folder names `20261013…20261017` are future-dated: until **2026-10-18** a Prisma-generated `YYYYMMDDHHMMSS_*` migration sorts before them (documented in `docs/database.md`; do not rename — applied names are recorded).
- No GIN/expression indexes on `event_spec_versions.messageVersionIds/frozenChannels/frozenTraits` (bounded seq scans); `20261013` rewrites `entities` under an exclusive lock; the `20261015` backfill freezes `typespecSource` as an immutable 1.0 before `db:flag-stale-sources` is run; existing entities with newly reserved slugs have no preflight.
- Service-level integration tests run on PostgreSQL only; the default provider PGlite has migration-level tests only.
- Stored `typespecSource` is not regenerated after the generator's wire-name change: entities with previously mangled names show a source/regeneration difference until next edit/publish. Avro enum symbols are renamed (lossy; warning shown); published Avro names for hard-keyword fields changed (`_op`→`op`).
- Duplicate helpers: `TYPESPEC_KEYWORDS` in `emitter.service.ts`, `findRootModelName`'s sanitizer in `version-source.ts`, "first 3 versions and N more" in three places, `selectClass`, ownership helper variants.
- Reserved-key creation-time check belongs in `normalizeCatalogName`; `findEnumBlocks` is quadratic only on unbalanced source (unreachable in production); `@typespec/db` is broken (Story 16.4).

## 5. Tests / infra

- Baseline failures: 8 (`db-emitter-parity` ×4 and `e2e-critical-flows` bigquery ×1 from the broken `@typespec/db`; `schemas-tab` ×3) plus load-dependent 5 s typespec-cli timeouts that pass alone.
- Playwright specs: `events-flow.spec.ts` (4 tests), `navigation`, `schema-lifecycle`, `layout`, `sample` pass on a dedicated dev server; **restart your `next dev` on :3000** to pick up `serverExternalPackages: ["@typespec/compiler"]` (entity publish fails under dev otherwise).
- Final e2e run (own dev server): every spec passes when run on its own, including the two new ones (`dashboard-not-found`, `entity-field-edit`). The default 8-worker parallel run fails the same 8 first-wave tests with 30 s timeouts (dev-server capacity, load average 25–50 on 16 cores); with `--timeout=120000` they pass. With 4 workers `navigation` "every explorer node" can click a sidebar node whose fixture another spec's `afterAll` already deleted (CI uses `workers: 1`). The `events-flow`, `schema-lifecycle` and `entity-field-edit` fixtures are visible to the other specs' navigation crawl; isolate them (per-spec tenant or domain filter) if you want parallel e2e.
- The dev server will not start from a git worktree: `next.config.ts` pins `turbopack.root: __dirname` and Turbopack rejects a `node_modules` symlink pointing outside it (agents worked around it with a temporary edit). Run e2e from the main checkout.
- Shared `node_modules` can be poisoned by agent symlinks (a self-referencing `node_modules/@typespec/@typespec` broke the production build once): check `find node_modules -maxdepth 3 -type l` after automated runs.

## 6. Not started (spec §14 backlog)

16.4 `@typespec/db`; 16.7–16.11 (type-mapping gaps, emission panel, E2E emit leg); Epic 17 gRPC; Epic 19 AsyncAPI import; Epic 20 visual builder + Kafka/Pub-Sub/Pulsar binding forms; Epic 22 follow-ups (drift dashboard, impact analysis); `EntityVersionArtifact` cache (14.5); `GovernanceRequest` for MAJOR; role-at-level enforcement.

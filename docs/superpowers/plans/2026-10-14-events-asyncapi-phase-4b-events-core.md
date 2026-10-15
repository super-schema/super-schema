# Events Phase 4b — Events Core: Data Model, Services, Publish, Emission Wiring, Pages, REST, Navigation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Messages, Channels, Traits and Event Specs real records in the product — Prisma tables, line-unique names, audited CRUD, Draft + Publish for Messages and Event Specs, a DB-backed AsyncAPI 3 emission pipeline that renders payloads from pinned entity versions with the existing TypeSpec emitters and validates with `@asyncapi/parser`, the Event Spec page (Editor · Document · Preview · Versions · Diagnostics), Message / Channel / Trait pages, workspace list tabs, sidebar leaves and New-menu entries, `GET /api/v1/event-specs/:id`, and the "Who uses X?" panel.

**Architecture:** Seven new tables (`channels`, `channel_messages`, `traits`, `messages`, `message_versions`, `event_specs`, `event_spec_versions`) carry the spec §4.2 level columns with placement CHECKs and reuse Track B's `schema_references` edge table for every pin. Pure modules under `src/lib/events/` hold value types, input parsers, bump rules, publish planners, catalog → `ResolvedEventSpec` mappers, the TypeSpec program combiner and the JSON Schema bundle inliner. Services under `src/services/events/` do all DB work (Result pattern, `withAudit`, `createInScope` / `writeWithUniqueName` for names, owner checks → `FORBIDDEN`). An `ArtifactRenderer` turns a pinned `EntityVersion` (its `resolvedSource` + FIELD-pinned closure) into Avro / JSON Schema / Protobuf `SchemaArtifact`s through the existing `@typespec/*` CLI path; the resolver loads a spec draft (channels incl. cross-product, message versions or draft messages, traits), renders artifacts per channel format profile and hands a `ResolvedEventSpec` to Track C's `AsyncApi3Adapter` (structural + parser validators). Published spec versions store the emitted document and are never regenerated. Server actions colocated with the product route revalidate `/schemas` (layout) on success. UI lives in `src/features/events/**`; routes are thin server pages.

**Tech Stack:** Next.js 16 App Router (server components + server actions), Prisma 7 (PostgreSQL / PGlite), Vitest 4 + Testing Library (jsdom), Tailwind design tokens, `yaml` 2, `@asyncapi/parser` 3 (+ Avro / Protobuf schema parsers), `@asyncapi/react-component` 3.2.1 — all already in `package.json`. No new npm packages.

**Spec:** `docs/superpowers/specs/2026-10-13-events-asyncapi-design.md` — §4.1 placement, §6 events data model, §7.2–7.4 emission / publish / surfaces, §9 (only what the pages need now), §10 errors / security, §11 testing. Stories 18.1, 18.2, 18.3, 18.6, 18.7, 18.8, 18.9 (+ the DB-backed half of 18.4 and the wiring of 18.5).

**Program context:** `docs/superpowers/plans/2026-10-13-events-asyncapi-phase-1.md` (levels, registry, `assetHref`, explorer tree), `docs/superpowers/plans/2026-10-14-events-asyncapi-phase-2a-slim-versioning.md` (Track B: `EntityVersion`, `SchemaReference`, `publishEntity`), `docs/superpowers/plans/2026-10-14-events-asyncapi-phase-4a-assembler.md` (Track C: pure AsyncAPI layer — merged).

## Story coverage

| Story | Delivered here | Left for later |
|---|---|---|
| 18.1 Prisma models | `Channel`, `ChannelMessage`, `Trait`, `Message`, `MessageVersion`, `EventSpec` (`specType` default `asyncapi@3.0`), `EventSpecVersion`; migration `20261016_events_core`; registry kinds `trait` / `message` / `channel` / `eventSpec`. `SchemaReference` reused from Track B | — |
| 18.2 Services + actions | CRUD for all four kinds; pins; trait refs; allowed messages; draft `EventSpecDocument` with reference validation; `withAudit`; owner checks | Role-at-level permission enforcement (parity with existing data-type actions) |
| 18.3 Publish | Message + Event Spec publish, §6.1 bump rules, raise-only, blockers reported together, frozen channels / traits, `SchemaReference` rows | MAJOR governance (`GovernanceRequest`) |
| 18.4 (DB half) | DB → `ResolvedEventSpec` resolver, on-demand artifact rendering from `EntityVersion.resolvedSource`, stored document for published versions (§7.2 step 1) | `EntityVersionArtifact` cache (14.5) |
| 18.5 (wiring) | `AsyncApiParserValidator` runs on every emit | — |
| 18.6 Pages | Event Spec page (5 tabs, minimal structured editor), Message / Channel / Trait pages, workspace list tabs | Visual builder, binding forms (Phase 5 / Epic 20) |
| 18.7 REST | `GET /api/v1/event-specs/:id?version=&format=` | — |
| 18.8 Navigation | Sidebar leaves (hidden when empty), New-menu entries, `assetHref` events kind, `loading.tsx` per route | Playwright link crawl (Phase 1 Task 14 owns it) |
| 18.9 Who uses X | `SchemaReference` lookup + panel on entity Versions tab and Message page | Impact analysis / drift dashboard (22.1) |

## Global Constraints

- **Preconditions:** Track B (`EntityVersion`, `SchemaReference`, migrations `20261015_entity_versioning(_backfill)`, `src/services/entity-version.service.ts`, `src/lib/entity-versioning/**`, `version-actions.ts`, `PublishEntityDialog.tsx`) is merged into `feat/events-asyncapi`. Track C (`src/lib/event-specs/**`) is merged. Do not depend on Track D or Phase 1 Tasks 13/14.
- **Result pattern:** every service returns `Result<T, ServiceError>` (`@/types/result`); nothing throws across a service boundary. Server actions return `ActionResult<T>` (`src/types/action-result.ts`, Task 2).
- **Audit:** every mutation goes through `auditedWrite()` (Task 2) which wraps `withAudit` (`@/lib/audit`) and maps `ServiceErrorRejection` / `AuditUserMissingError` / Prisma `P2002` / `P2003` / `P2025`.
- **Revalidation:** every mutating server action calls `revalidatePath("/schemas", "layout")` **after success only** (`next.config.ts` sets `staleTimes.dynamic = 30`; see `tests/unit/app/revalidate-after-mutation.test.ts`). Read-only actions never revalidate.
- **Names:** line-unique across all kinds (spec §4.3) via `createInScope` / `writeWithUniqueName` (`src/services/scoped-create.service.ts`). Catalog names are AsyncAPI component keys: `^[A-Za-z0-9._-]{1,128}$`.
- **Placement:** Channel / Message / Event Spec → Product only; Trait → Tenant / Domain / Product (`ALLOWED_LEVELS`, `src/lib/levels.ts`). DB CHECKs mirror it.
- **Ownership (spec §10):** every update / delete action passes the page's owner `ScopeTarget`; services return `FORBIDDEN` when the record's level columns differ. Cross-product references (channels, message versions) are read-only by ID.
- **Migrations:** hand-written, idempotent SQL (`DO $$ … EXCEPTION WHEN duplicate_object`, `IF NOT EXISTS`), `prisma/migrations/20261016_events_core/migration.sql`, sorts after `20261015_entity_versioning_backfill`; applied with `npm run db:deploy` (PostgreSQL) and by `applyPgliteMigrations` (PGlite). Run `npx prisma generate` after editing `prisma/schema.prisma`.
- **No new npm packages.** `@asyncapi/parser` is imported only by server code (`src/services/**`, route handlers); never from a `"use client"` module.
- **Strict TypeScript**, no `any` in `src/`. Non-hook helpers must not start with `use…` (ESLint `react-hooks/rules-of-hooks`).
- **Tests:** unit `tests/unit/**` (node; component tests start with `// @vitest-environment jsdom`), DB integration `tests/integration/**` against the real PostgreSQL in `.env` (`DATABASE_URL`, same pattern as `tests/integration/services/entity-version.service.test.ts`). TypeSpec-CLI-backed tests (`tests/integration/services/events/artifact-renderer.test.ts`, `event-spec-emit.test.ts`, `event-spec-publish.test.ts`) spawn `tsp`; run them with `--no-file-parallelism` and 180 s timeouts — they time out under parallel load (known).
- **Baseline** (main checkout, `feat/events-asyncapi` after the Track B merge): `npx tsc --noEmit` clean; `npx vitest run` → **8 pre-existing failures** (db-emitter-parity ×4, e2e-critical-flows bigquery ×1, schemas-tab ×3). They are not regressions; the count must not grow.
- **Commits:** one commit per task (message given in the task). Append the repository's required `Co-Authored-By` trailer if your environment mandates one.

### Track B / Track C APIs this plan consumes (exact signatures)

```ts
// Track B — src/services/entity-version.service.ts
publishEntity(entityId: string, opts: PublishInput, ctx: ServiceContext): Promise<Result<EntityVersionSummary>>
listEntityVersions(entityId: string, ctx: ServiceContext): Promise<Result<EntityVersionSummary[]>>
// Track B — src/lib/entity-versioning/*
type BumpKind = "MAJOR" | "MINOR"; type ChangeKind = BumpKind | "INITIAL";
interface VersionNumber { major: number; minor: number }
interface PublishInput { bump?: BumpKind; changeSummary?: string }
isBumpKind(v: unknown): v is BumpKind
formatVersionLabel(v: VersionNumber): string; parseVersionLabel(label: string): Result<VersionNumber>
nextVersionNumber(latest: VersionNumber | null, bump: BumpKind): { version: VersionNumber; changeKind: ChangeKind }
resolveBump(suggested: BumpKind, requested: BumpKind | undefined): Result<BumpKind>   // BUMP_TOO_LOW
collectReferencedEntityIds(entityId: string, fields: { id: string; decorators: unknown }[], metadata: unknown): string[]
// Track B — "use server" src/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/version-actions.ts
listEntityVersionsAction(entityId: string): Promise<{ success: true; versions: EntityVersionSummary[] } | { error: string }>
// Track B — Prisma: EntityVersion { id, entityId, major, minor, sequence, resolvedSource, fieldSnapshot, ... },
//   SchemaReference { fromKind, fromId, role, toKind, toId, isDraft }, enums EntityVersionChangeKind,
//   SchemaReferenceFromKind, SchemaReferenceRole, SchemaReferenceToKind; Entity.latestVersionId / hasUnpublishedChanges.

// Track C — src/lib/event-specs (barrel) + validation module
type EventSpecDocument, ResolvedChannel, ResolvedMessage, ResolvedTrait, ResolvedEventSpec, SchemaArtifact,
     FormatProfile, PayloadFormat, JsonSchemaDialect, JsonObject, Diagnostic, EmitOutput, TraitKind
resolveEventSpecDocument(doc, catalog: { channels; messages; traits }, { productSlug, version }): Result<ResolvedEventSpec>   // UNRESOLVED_REFERENCES, details.problems: { pointer, message }[]
getEventSpecAdapter(specType: string, options?: { validators?: EventSpecValidator[] }): Result<EventSpecAdapter>
StructuralAsyncApi3Validator; AsyncApiParserValidator (from "@/lib/event-specs/validation/asyncapi-parser-validator")
placeRootMessageFirst(proto: string, rootMessage: string): Result<string>
toJson(doc: JsonObject): string; toYaml(doc: JsonObject): string; normalizeDiagnostics(list); hasErrors(list); diagnostic(sev, code, msg, ptr)
mapSchemaRefs(schema: JsonObject, mapRef: (ref: string) => string): JsonObject   // "@/lib/event-specs/json-schema-keywords"
```

## Design decisions resolved in this plan (review these)

| # | Decision |
|---|---|
| D1 | **Level columns stay uniform** (`tenantId` required, `domainId?`, `productId?`) on all four tables (spec §4.2); product-only kinds get `CHECK ("productId" IS NOT NULL AND "domainId" IS NOT NULL)`, traits `CHECK ("productId" IS NULL OR "domainId" IS NOT NULL)`. |
| D2 | **Pins are columns + mirrored edges.** `Message.{payload,headers,key}Entity(Version)Id`, `MessageVersion.{payload,headers,key}EntityVersionId`, `Trait.headersEntity(Version)Id` are the source of truth; every write rewrites the matching `SchemaReference` rows in the same transaction (`MESSAGE`/`MESSAGE_VERSION`/`TRAIT` → `ENTITY_VERSION`, roles `PAYLOAD`/`HEADERS`/`KEY`; `EVENT_SPEC`/`EVENT_SPEC_VERSION` → `MESSAGE_VERSION`, role `MESSAGE`). `isDraft = true` only for `MESSAGE` and `EVENT_SPEC` rows. |
| D3 | **Pin FKs use `ON DELETE NO ACTION`, not `RESTRICT`.** NO ACTION is checked at the end of the statement, so deleting a domain / product (which cascades messages *and* entities in one statement) succeeds, while deleting an entity whose version is pinned fails with `P2003` → `IN_USE`. This is the only delete restriction in this phase besides "a Message with versions used by a published spec version cannot be deleted" (service check). |
| D4 | **`messageVersionIds` may hold a Message id in a draft** — meaning "this product's message draft, preview only" (Track C's `ResolvedMessage.id` already documents this). Only own-product drafts are accepted. Publish is blocked (`UNPUBLISHED_MESSAGE`) until every entry is a `MessageVersion` id. |
| D5 | **Pin defaults:** a create/update input pin with `entityVersionId` *omitted* pins the entity's latest published version (picker default "latest"); `null` means unpinned — the draft preview renders the entity's current draft and publish is blocked (`UNPUBLISHED_PIN`). |
| D6 | **Bump details beyond §6.1:** Message — headers/key *removed* or pin switched to a *different entity* → MAJOR; headers/key *added* → MINOR; a pin moving to a lower major is MAJOR too. Event Spec — operation `action` changed, operation moved to another channel, or `reply` removed/changed → MAJOR; added operations / messages / reply → MINOR. Everything else MINOR. |
| D7 | **`EventSpecVersion` adds `sourceDocument Json`** (the draft `EventSpecDocument` as published) — the next publish's bump classifier needs the previous operations by key. `frozenChannels` = `ResolvedChannel[]`; `frozenTraits` = `FrozenTrait[]` (trait row data, no rendered artifacts — those live in `document`). |
| D8 | **"Has changes" for a spec** = draft dirty (`hasUnpublishedChanges`) **or** live Channels / Traits differ from the frozen copies (Channels and Traits are live, spec Q10). Without this a channel address change could never be republished. |
| D9 | **On-demand artifact rendering** (no `EntityVersionArtifact` until 14.5): one TypeSpec program = pinned version `resolvedSource` + FIELD-pinned closure (BFS over `SchemaReference`), imports/usings hoisted, file-level `namespace` statements replaced by one level-derived namespace (§4.4, e.g. `Acme.Payments.Checkout`), duplicate declarations deduped (first wins, warning). JSON Schema is rendered **once** as a 2020-12 bundle and inlined into local `#/$defs` (refs like `Address.json` never reach the document → no `REMOTE_REF`); the assembler down-converts for draft-07 channels. Avro picks `<Root>.avsc.json` (references already inlined by the emitter). Protobuf uses the existing projection + `@field(n)` from each version's `fieldSnapshot` + `placeRootMessageFirst`. Process-local LRU (256 entries, key `versionId:format`, versions are immutable), concurrency 2; draft subjects are never cached. |
| D10 | **Validation** = `StructuralAsyncApi3Validator` + `AsyncApiParserValidator` on every server-side emit. Errors block publish; warnings are shown and stored in `compatReport.diagnostics`. |
| D11 | **Spec publish order:** snapshot (DB, no rendering) → analysis → label → render + emit with `info.version = label` → all blockers together → short transaction (row lock, `updatedAt` + `latestVersionId` unchanged else `CONFLICT`). Rendering never runs inside a transaction. |
| D12 | **REST `version`:** omitted → latest published; `draft` → current draft emission; `MAJOR.MINOR` → that version's stored document. Never published + omitted → 404 with `suggestedFix: "Pass ?version=draft"`. Body is the raw document (`application/yaml` / `application/json`); errors use the existing JSON error envelope. |
| D13 | **Draft documents use `info.version: "draft"`.** |
| D14 | **Preview:** `@asyncapi/react-component` peer range is `react >=18`; a grep of `lib/esm` (2026-10-14) finds no removed React 19 APIs (`findDOMNode`, `ReactDOM.render`). Primary renderer = the React component via `next/dynamic` (`ssr: false`); an error boundary falls back to the standalone bundle in a `sandbox="allow-scripts"` iframe whose assets are served by `/api/asyncapi-preview/[asset]` (`/api/*` is public in `src/middleware.ts`). |
| D15 | **Workspace tabs:** product `entities | data-types | apis | events | traits` (`events` has `?section=specs|messages|channels`, default `specs`); domain `products | data-types | apis | traits`; enterprise `entities | data-types | traits`. |
| D16 | **Permissions parity:** actions require an authenticated session (same as the existing data-type / API actions); role-at-level enforcement (spec §10 Permissions) is deferred and listed in Out of scope. |

## Review Focus

1. **Cascades vs NO ACTION pins** — deleting the domain removes channels, messages, message versions and entities in one statement; deleting just a pinned entity fails. Tests in Task 1.
2. **All publish blockers at once** — unpublished pin + missing trait + invalid correlationId on a Message; draft message ref + unresolved channel + parser error on an Event Spec — every one listed, nothing written. Tests in Tasks 6, 10, 12.
3. **Raise-only** — MAJOR suggested → MINOR request returns `BUMP_TOO_LOW`; MINOR suggested → MAJOR request accepted. Tests in Tasks 6, 10, 12.
4. **No remote refs** — a payload whose entity references another entity emits a local, document-rooted `$ref` (`#/components/messages/…/payload/schema/$defs/Address`, or `…/definitions/Address` after the draft-07 down-conversion), never `Address.json`; the parser reports zero errors. Tests in Tasks 5 and 9.
5. **Cross-product consumer** — a Fraud spec receives Checkout's `OrderCreated@1.0` on Checkout's channel (read-only); updating that channel from Fraud returns `FORBIDDEN`. Tests in Tasks 3 and 9.
6. **Published documents are immutable** — after a channel address edit, `?version=1.0` (REST + page) still returns the stored document, and the spec shows "has changes" (MAJOR suggested). Tests in Tasks 12 and 13.
7. **Sidebar hides empty event leaves** and highlights the right leaf on `/messages/<id>`. Tests in Task 7.
8. **Concurrent publishes** — the second waits on the row lock and then gets `NO_CHANGES` (or `CONFLICT` via the unique index). Test in Task 10.

## Out of scope (explicit)

- AsyncAPI import (Phase 5 / Epic 19) — `importedSource` / `sourceVersion` columns exist but stay null.
- Visual builder, Kafka / Pub/Sub / Pulsar binding forms, generic binding forms (Phase 5 / Epic 20) — bindings and parameters are raw JSON textareas validated by `JSON.parse` (object shape) only.
- Governance approval for MAJOR publishes (`GovernanceRequest.subjectKind`), `governanceRequestId` stays null.
- `EntityVersionArtifact` cache (14.5), drift dashboard (22.1), version deprecation (22.4).
- Delete restrictions beyond D3; deleting a Channel or Trait referenced by drafts is allowed (drafts then show `UNRESOLVED_REFERENCE` diagnostics; published versions are frozen).
- Role-at-level permission enforcement (spec §10 Permissions).
- Playwright link crawl of every workspace (Phase 1 Task 14); this plan adds one events E2E flow.

## Execution waves (parallel worktrees)

Each wave's tasks touch disjoint files and may run in separate worktrees (Task 0 shows the setup). Merge every task branch of a wave into `feat/events-asyncapi` (and run the wave gate: `npx tsc --noEmit && npx vitest run && npx next build`) before starting the next wave. Waves 1 and 2 have no mutual dependencies — with capacity, run all six tasks at once.

| Wave | Tasks (parallel) | Depends on |
|---|---|---|
| 0 | 0 → 1 → 2 (serial) | Track B + C merged |
| 1 | 3 · 4 · 5 | 2 |
| 2 | 6 · 7 · 8 | 2 |
| 3 | 9 · 10 · 11 | 4, 5 (9) · 4, 6 (10) · 2 (11) |
| 4 | 12 · 13 · 14 | 6, 9 (12) · 9 (13) · 3, 4, 7, 8 (14) |
| 5 | 15 · 16 · 17 | 3, 7, 8 (15) · 4, 8, 10, 11 (16) · 8, 9, 12 (17) |
| 6 | 18 | all |

---

## File structure (Phase 4b)

| File | Responsibility | Task |
|---|---|---|
| `prisma/schema.prisma` (modify) | 7 models, `TraitKind`, back-relations | 1 |
| `prisma/migrations/20261016_events_core/migration.sql` (create) | Tables, FKs, CHECKs, immutability triggers, indexes | 1 |
| `src/types/action-result.ts` (create) | `ActionResult<T>` (client-safe) | 2 |
| `src/lib/action-context.ts` (create) | `getActionContext()`, `toActionResult()`, `NOT_AUTHENTICATED` | 2 |
| `src/lib/events/types.ts` (create) | Events value types (client-safe) | 2 |
| `src/lib/events/inputs.ts` (create) | Name / protocol / format-profile / JSON-text validators, constants | 2 |
| `src/lib/events/catalog-specs.ts` (create) | `ChannelSpec` / `MessageSpec` parse + read + semantic validation | 2 |
| `src/lib/events/event-spec-document.ts` (create) | `EventSpecDocument` parse, empty doc, reference collection | 2 |
| `src/lib/events/ownership.ts` (create) | `assertOwnedBy()` → `FORBIDDEN` | 2 |
| `src/lib/events/list-items.ts` (create) | Row → list-item mappers | 2 |
| `src/services/name-registry.service.ts` (modify) | Kinds `trait` / `message` / `channel` / `eventSpec` | 2 |
| `src/services/events/audited.ts` (create) | `auditedWrite()` | 2 |
| `src/services/events/schema-references.ts` (create) | `replaceReferences()`, `deleteReferencesFrom()`, `pinEdges()` | 2 |
| `src/services/events/pins.ts` (create) | `PinInput`, `resolvePin()` | 2 |
| `src/features/events/route-scope.ts` (create) | `resolveProductRoute()`, `resolveLevelRoute()` | 2 |
| `tests/integration/services/events/helpers.ts` (create) | DB test scope helpers | 2 |
| `src/services/events/channel.service.ts`, `trait.service.ts` (create) | Channel / Trait CRUD | 3 |
| `src/app/(dashboard)/schemas/[domainSlug]/[productSlug]/channel-actions.ts` (create) | Channel actions | 3 |
| `src/app/(dashboard)/schemas/trait-actions.ts` (create) | Trait actions (all levels) | 3 |
| `src/services/events/message.service.ts`, `event-spec.service.ts` (create) | Message / Event Spec draft CRUD | 4 |
| `src/app/(dashboard)/schemas/[domainSlug]/[productSlug]/message-actions.ts`, `event-spec-actions.ts` (create) | Actions | 4 |
| `src/lib/typespec-official/emitter.service.ts` (modify) | Export `runTypeSpecEmitterFiles`, `injectProtobufFieldNumbers`, helpers | 5 |
| `src/lib/events/version-source.ts` (create) | TypeSpec statement splitter, program combiner, level namespace | 5 |
| `src/lib/events/json-schema-bundle.ts` (create) | Bundle → local `$defs` inliner | 5 |
| `src/services/events/artifact-renderer.ts` (create) | `ArtifactRenderer` (closure, per-format source, pick output, LRU) | 5 |
| `src/lib/events/bump-rules.ts`, `publish-plan.ts` (create) | Bump classifiers, versioned publish planner, message / spec inputs | 6 |
| `src/lib/navigation/asset-href.ts`, `build-explorer-tree.ts` (modify) | `events` kind; trait / message / channel / spec counts | 7 |
| `src/app/api/domains-tree/route.ts`, `src/components/layout/LeftSidebar.tsx`, `.../components/CreateDropdown.tsx` (modify) | Counts query, sidebar leaves, New-menu items | 7 |
| `.../[entityId]/components/PublishEntityDialog.tsx` (modify) | Structural `PublishPreview` prop + `description` | 8 |
| `src/features/events/shared/*.tsx` (create) | `PublishVersionButton`, `EventVersionList`, `JsonField`, `EntityPinPicker`, `EventBreadcrumb` | 8 |
| `src/features/events/load-options.ts` (create) | Picker option loaders | 8 |
| `src/features/events/event-specs/AsyncApiPreview.tsx`, `preview-src-doc.ts` (create) | Preview + iframe fallback | 8 |
| `src/app/api/asyncapi-preview/[asset]/route.ts` (create), `next.config.ts` (modify) | Standalone bundle assets | 8 |
| `src/lib/events/catalog-mapping.ts` (create) | Rows → `ResolvedChannel` / `MessageSource` / `FrozenTrait`; artifact plan | 9 |
| `src/services/events/event-spec-resolver.ts`, `event-spec-emit.service.ts` (create) | Draft snapshot, resolve + render, `emitEventSpec` | 9 |
| `src/app/(dashboard)/schemas/[domainSlug]/[productSlug]/event-spec-emit-actions.ts` (create) | Emit actions | 9 |
| `src/services/events/version-summary.ts`, `message-publish.service.ts` (create) | Message publish | 10 |
| `src/app/(dashboard)/schemas/[domainSlug]/[productSlug]/message-version-actions.ts` (create) | Message publish actions | 10 |
| `src/lib/events/usage.ts`, `src/services/events/usage.service.ts`, `src/app/(dashboard)/schemas/usage-actions.ts`, `src/features/events/shared/UsedByPanel.tsx` (create); `.../[entityId]/entity-workspace.tsx` (modify) | Who uses X | 11 |
| `src/services/events/event-spec-publish.service.ts`, `.../[productSlug]/event-spec-version-actions.ts` (create) | Spec publish | 12 |
| `src/app/api/v1/event-specs/[id]/route.ts` (create) | REST | 13 |
| `src/features/events/workspace/{load-events-tab-data.ts,EventsTab.tsx,TraitsTab.tsx}` (create); product / domain / enterprise pages + workspaces (modify) | List tabs + create flows | 14 |
| `.../channels/[channelId]/*`, `.../traits/[traitId]/*` (3 levels), `src/features/events/{channels,traits}/*` (create) | Channel / Trait pages | 15 |
| `.../messages/[messageId]/*`, `src/features/events/messages/*` (create) | Message page | 16 |
| `.../specs/[specId]/*`, `src/features/events/event-specs/*` (create) | Event Spec page | 17 |
| `tests/e2e/events-flow.spec.ts` (create) | E2E flow | 18 |

---

### Task 0: Worktree setup + baseline

**Files:** none (environment only).

- [ ] **Step 1: Confirm the preconditions on the integration branch**

```bash
MAIN=/Users/jsenjaliya/src/my/super-schema
git -C "$MAIN" switch feat/events-asyncapi && git -C "$MAIN" pull --ff-only || true
test -f "$MAIN/prisma/migrations/20261015_entity_versioning/migration.sql" && echo "track B migration: ok"
grep -q "^model EntityVersion " "$MAIN/prisma/schema.prisma" && grep -q "^model SchemaReference " "$MAIN/prisma/schema.prisma" && echo "track B models: ok"
test -f "$MAIN/src/services/entity-version.service.ts" && echo "track B service: ok"
test -f "$MAIN/src/lib/event-specs/adapter.ts" && test -f "$MAIN/src/lib/event-specs/validation/asyncapi-parser-validator.ts" && echo "track C: ok"
```

Expected: four `ok` lines. If any is missing, stop — Track B / C must be merged first.

- [ ] **Step 2: Create the task worktree** (one per task; `N` = task number)

```bash
N=1
git -C "$MAIN" worktree add "/Users/jsenjaliya/src/my/super-schema-4b-t$N" -b "feat/events-4b-t$N" feat/events-asyncapi
cd "/Users/jsenjaliya/src/my/super-schema-4b-t$N"
ln -s "$MAIN/node_modules" node_modules
ln -s "$MAIN/.env" .env
npx prisma generate
```

`src/generated/prisma` is gitignored, so each worktree generates its own client from its own schema. Worktrees share the database in `.env`; the migration is additive and idempotent, so concurrent worktrees can all run `npm run db:deploy`.

- [ ] **Step 3: Record the baseline**

Run: `npx tsc --noEmit` — Expected: no errors.
Run: `npx vitest run` — Expected: 8 failed (db-emitter-parity ×4, e2e-critical-flows bigquery ×1, schemas-tab ×3). Extra `tsp` timeouts under parallel load are environmental: re-run the file alone (`npx vitest run <file> --no-file-parallelism`) before treating it as a regression.

- [ ] **Step 4: Confirm the new paths do not exist yet**

Run: `ls src/lib/events src/services/events src/features/events prisma/migrations/20261016_events_core 2>&1 | grep -c "No such file"` — Expected: `4`.

---

### Task 1: Events data model — Prisma models + migration `20261016_events_core` (Story 18.1)

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20261016_events_core/migration.sql`
- Test: `tests/integration/db/events-core-pglite.test.ts`, `tests/integration/db/events-core.test.ts`

**Interfaces:**
- Produces Prisma delegates `channel`, `channelMessage`, `trait`, `message`, `messageVersion`, `eventSpec`, `eventSpecVersion`; enum `TraitKind`; `MessageVersion.changeKind` / `EventSpecVersion.changeKind` reuse Track B's `EntityVersionChangeKind`.

- [ ] **Step 1: Write the failing PGlite migration test** (`tests/integration/db/events-core-pglite.test.ts`)

```ts
import { describe, it, expect } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { applyPgliteMigrations } from "@/lib/pglite-migrate";

const NOW = "CURRENT_TIMESTAMP";

describe("events core migration on PGlite", () => {
  it("applies, enforces placement + immutability, blocks deleting pinned entities, cascades with the domain", async () => {
    const db = new PGlite();
    try {
      const applied = await applyPgliteMigrations(db);
      expect(applied).toContain("20261016_events_core");

      await db.exec(`INSERT INTO "users" ("id","email","updatedAt") VALUES ('u1','u1@example.test',${NOW})`);
      await db.exec(`INSERT INTO "domains" ("id","tenantId","name","slug","updatedAt") VALUES ('d1','tenant_default','D','d',${NOW})`);
      await db.exec(`INSERT INTO "products" ("id","domainId","name","slug","updatedAt") VALUES ('p1','d1','P','p',${NOW})`);
      await db.exec(
        `INSERT INTO "entities" ("id","name","slug","tenantId","domainId","productId","ownerId","updatedAt")
         VALUES ('e1','Order','order','tenant_default','d1','p1','u1',${NOW})`
      );
      await db.exec(
        `INSERT INTO "entity_versions" ("id","entityId","major","minor","sequence","resolvedSource","fieldSnapshot","changeKind","publishedById")
         VALUES ('v1','e1',1,0,1,'model Order {}','[]','INITIAL','u1')`
      );

      // Channels are product-only (spec §4.1).
      await expect(
        db.exec(`INSERT INTO "channels" ("id","name","protocol","format","tenantId","updatedAt") VALUES ('c0','orders','kafka','avro','tenant_default',${NOW})`)
      ).rejects.toThrow(/channels_level_check/);
      // A dialect only makes sense for JSON Schema.
      await expect(
        db.exec(
          `INSERT INTO "channels" ("id","name","protocol","format","formatDialect","tenantId","domainId","productId","updatedAt")
           VALUES ('c9','orders','kafka','avro','draft-07','tenant_default','d1','p1',${NOW})`
        )
      ).rejects.toThrow(/channels_format_check/);
      await db.exec(
        `INSERT INTO "channels" ("id","name","address","protocol","format","tenantId","domainId","productId","updatedAt")
         VALUES ('c1','orders','payments.orders.v1','kafka','avro','tenant_default','d1','p1',${NOW})`
      );

      // Traits may live at tenant level; only MESSAGE traits carry headers.
      await expect(
        db.exec(
          `INSERT INTO "traits" ("id","kind","name","tenantId","headersEntityId","updatedAt")
           VALUES ('t0','OPERATION','Bad','tenant_default','e1',${NOW})`
        )
      ).rejects.toThrow(/traits_headers_check/);
      await db.exec(
        `INSERT INTO "traits" ("id","kind","name","tenantId","headersEntityId","headersEntityVersionId","updatedAt")
         VALUES ('t1','MESSAGE','CloudEvents','tenant_default','e1','v1',${NOW})`
      );

      await db.exec(
        `INSERT INTO "messages" ("id","name","payloadEntityId","payloadEntityVersionId","tenantId","domainId","productId","updatedAt")
         VALUES ('m1','OrderCreated','e1','v1','tenant_default','d1','p1',${NOW})`
      );
      await db.exec(`INSERT INTO "channel_messages" ("channelId","messageId") VALUES ('c1','m1')`);
      await db.exec(
        `INSERT INTO "message_versions" ("id","messageId","major","minor","sequence","resolvedSpec","payloadEntityVersionId","changeKind","publishedById")
         VALUES ('mv1','m1',1,0,1,'{}','v1','INITIAL','u1')`
      );
      await db.exec(`UPDATE "messages" SET "latestVersionId" = 'mv1', "hasUnpublishedChanges" = false WHERE "id" = 'm1'`);
      await db.exec(
        `INSERT INTO "event_specs" ("id","name","document","tenantId","domainId","productId","updatedAt")
         VALUES ('s1','checkout-service','{"info":{"title":"checkout-service"},"servers":[],"operations":[]}','tenant_default','d1','p1',${NOW})`
      );
      const spec = await db.query<{ specType: string }>(`SELECT "specType" FROM "event_specs" WHERE "id" = 's1'`);
      expect(spec.rows[0].specType).toBe("asyncapi@3.0");
      await db.exec(
        `INSERT INTO "event_spec_versions" ("id","eventSpecId","major","minor","sequence","document","sourceDocument","frozenChannels","frozenTraits","messageVersionIds","changeKind","publishedById")
         VALUES ('sv1','s1',1,0,1,'{}','{}','[]','[]',ARRAY['mv1'],'INITIAL','u1')`
      );

      await expect(db.exec(`UPDATE "message_versions" SET "minor" = 1 WHERE "id" = 'mv1'`)).rejects.toThrow(/immutable/);
      await expect(db.exec(`UPDATE "event_spec_versions" SET "minor" = 1 WHERE "id" = 'sv1'`)).rejects.toThrow(/immutable/);

      // D3: a pinned entity cannot be deleted on its own …
      await expect(db.exec(`DELETE FROM "entities" WHERE "id" = 'e1'`)).rejects.toThrow(/foreign key/);

      // … but the tenant-level trait (outside the domain) is the only thing that would survive the cascade.
      await db.exec(`DELETE FROM "traits" WHERE "id" = 't1'`);
      await db.exec(`DELETE FROM "domains" WHERE "id" = 'd1'`);
      for (const table of ["channels", "channel_messages", "messages", "message_versions", "event_specs", "event_spec_versions", "entities"]) {
        const left = await db.query(`SELECT 1 FROM "${table}"`);
        expect(left.rows, table).toHaveLength(0);
      }
    } finally {
      await db.close();
    }
  }, 60_000);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/integration/db/events-core-pglite.test.ts`
Expected: FAIL — `expected [...] to contain '20261016_events_core'`.

- [ ] **Step 3: Add the models to `prisma/schema.prisma`**

Add back-relations to existing models (one line each, next to the existing relation lists):

```prisma
// model User
  publishedMessageVersions   MessageVersion[]   @relation("MessageVersionPublisher")
  publishedEventSpecVersions EventSpecVersion[] @relation("EventSpecVersionPublisher")

// model Tenant, model Domain and model Product (all three)
  channels   Channel[]
  traits     Trait[]
  messages   Message[]
  eventSpecs EventSpec[]

// model Entity
  traitHeaderPins    Trait[]   @relation("TraitHeadersEntity")
  messagePayloadPins Message[] @relation("MessagePayloadEntity")
  messageHeadersPins Message[] @relation("MessageHeadersEntity")
  messageKeyPins     Message[] @relation("MessageKeyEntity")

// model EntityVersion
  traitHeaderPins           Trait[]          @relation("TraitHeadersVersion")
  messagePayloadPins        Message[]        @relation("MessagePayloadVersion")
  messageHeadersPins        Message[]        @relation("MessageHeadersVersion")
  messageKeyPins            Message[]        @relation("MessageKeyVersion")
  messageVersionPayloadPins MessageVersion[] @relation("MessageVersionPayload")
  messageVersionHeadersPins MessageVersion[] @relation("MessageVersionHeaders")
  messageVersionKeyPins     MessageVersion[] @relation("MessageVersionKey")
```

Append the new block after `model SchemaReference`:

```prisma
// ============================================================
// Events (Epic 18 — spec §6)
// ============================================================

enum TraitKind {
  MESSAGE
  OPERATION
}

/// Spec §6.1 Channel — product level, live (not versioned); frozen into each EventSpecVersion.
model Channel {
  id            String           @id @default(cuid())
  name          String
  /// AsyncAPI channel address; may contain {param}; null = unknown / dynamic.
  address       String?
  /// kafka | googlepubsub | pulsar | any AsyncAPI protocol string.
  protocol      String
  /// Format profile (spec §1): avro | json-schema | protobuf.
  format        String
  /// draft-07 | 2020-12 — JSON Schema only.
  formatDialect String?
  /// ChannelSpec (src/lib/events/types.ts): AsyncAPI Channel Object minus address + messages.
  spec          Json             @default("{}")
  tenantId      String
  domainId      String?
  productId     String?
  tenant        Tenant           @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  domain        Domain?          @relation(fields: [domainId], references: [id], onDelete: Cascade)
  product       Product?         @relation(fields: [productId], references: [id], onDelete: Cascade)
  messages      ChannelMessage[]
  createdAt     DateTime         @default(now())
  updatedAt     DateTime         @updatedAt

  @@index([tenantId])
  @@index([domainId])
  @@index([productId])
  @@map("channels")
}

/// Messages allowed on a channel (unpinned; may reference other products' Messages).
model ChannelMessage {
  channelId String
  messageId String
  createdAt DateTime @default(now())
  channel   Channel  @relation(fields: [channelId], references: [id], onDelete: Cascade)
  message   Message  @relation(fields: [messageId], references: [id], onDelete: Cascade)

  @@id([channelId, messageId])
  @@index([messageId])
  @@map("channel_messages")
}

/// Spec §6.1 Trait — tenant / domain / product, live; frozen into each EventSpecVersion.
model Trait {
  id                     String         @id @default(cuid())
  kind                   TraitKind
  name                   String
  /// AsyncAPI Message Trait / Operation Trait object.
  spec                   Json           @default("{}")
  /// MESSAGE traits only (CHECK): headers entity + pinned published version (mirrored in SchemaReference, role HEADERS).
  headersEntityId        String?
  headersEntityVersionId String?
  tenantId               String
  domainId               String?
  productId              String?
  tenant                 Tenant         @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  domain                 Domain?        @relation(fields: [domainId], references: [id], onDelete: Cascade)
  product                Product?       @relation(fields: [productId], references: [id], onDelete: Cascade)
  headersEntity          Entity?        @relation("TraitHeadersEntity", fields: [headersEntityId], references: [id], onDelete: NoAction)
  headersEntityVersion   EntityVersion? @relation("TraitHeadersVersion", fields: [headersEntityVersionId], references: [id], onDelete: NoAction)
  createdAt              DateTime       @default(now())
  updatedAt              DateTime       @updatedAt

  @@index([tenantId])
  @@index([domainId])
  @@index([productId])
  @@map("traits")
}

/// Spec §6.1 Message — product level draft; published as immutable MessageVersions.
model Message {
  id                     String           @id @default(cuid())
  name                   String
  /// MessageSpec (src/lib/events/types.ts): AsyncAPI Message Object fields + traitIds.
  spec                   Json             @default("{}")
  payloadEntityId        String
  payloadEntityVersionId String?
  headersEntityId        String?
  headersEntityVersionId String?
  keyEntityId            String?
  keyEntityVersionId     String?
  latestVersionId        String?          @unique
  hasUnpublishedChanges  Boolean          @default(true)
  tenantId               String
  domainId               String?
  productId              String?
  tenant                 Tenant           @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  domain                 Domain?          @relation(fields: [domainId], references: [id], onDelete: Cascade)
  product                Product?         @relation(fields: [productId], references: [id], onDelete: Cascade)
  payloadEntity          Entity           @relation("MessagePayloadEntity", fields: [payloadEntityId], references: [id], onDelete: NoAction)
  payloadEntityVersion   EntityVersion?   @relation("MessagePayloadVersion", fields: [payloadEntityVersionId], references: [id], onDelete: NoAction)
  headersEntity          Entity?          @relation("MessageHeadersEntity", fields: [headersEntityId], references: [id], onDelete: NoAction)
  headersEntityVersion   EntityVersion?   @relation("MessageHeadersVersion", fields: [headersEntityVersionId], references: [id], onDelete: NoAction)
  keyEntity              Entity?          @relation("MessageKeyEntity", fields: [keyEntityId], references: [id], onDelete: NoAction)
  keyEntityVersion       EntityVersion?   @relation("MessageKeyVersion", fields: [keyEntityVersionId], references: [id], onDelete: NoAction)
  versions               MessageVersion[] @relation("MessageVersions")
  latestVersion          MessageVersion?  @relation("MessageLatestVersion", fields: [latestVersionId], references: [id], onDelete: SetNull)
  channels               ChannelMessage[]
  createdAt              DateTime         @default(now())
  updatedAt              DateTime         @updatedAt

  @@index([tenantId])
  @@index([domainId])
  @@index([productId])
  @@index([payloadEntityId])
  @@map("messages")
}

/// Immutable published Message (DB trigger forbids UPDATE).
model MessageVersion {
  id                     String                  @id @default(cuid())
  messageId              String
  major                  Int
  minor                  Int
  sequence               Int
  /// MessageResolvedSpec (src/lib/events/types.ts): name + spec + pinned EntityVersion ids / labels.
  resolvedSpec           Json
  payloadEntityVersionId String
  headersEntityVersionId String?
  keyEntityVersionId     String?
  changeKind             EntityVersionChangeKind
  /// { reasons: string[] } — bump classifier output.
  compatReport           Json                    @default("{}")
  changeSummary          String?
  publishedById          String
  publishedAt            DateTime                @default(now())
  /// Unused until MAJOR governance.
  governanceRequestId    String?
  message                Message                 @relation("MessageVersions", fields: [messageId], references: [id], onDelete: Cascade)
  latestOf               Message?                @relation("MessageLatestVersion")
  publishedBy            User                    @relation("MessageVersionPublisher", fields: [publishedById], references: [id])
  payloadEntityVersion   EntityVersion           @relation("MessageVersionPayload", fields: [payloadEntityVersionId], references: [id], onDelete: NoAction)
  headersEntityVersion   EntityVersion?          @relation("MessageVersionHeaders", fields: [headersEntityVersionId], references: [id], onDelete: NoAction)
  keyEntityVersion       EntityVersion?          @relation("MessageVersionKey", fields: [keyEntityVersionId], references: [id], onDelete: NoAction)

  @@unique([messageId, major, minor])
  @@unique([messageId, sequence])
  @@index([payloadEntityVersionId])
  @@map("message_versions")
}

/// Spec §6.1 Event Spec — product level draft (EventSpecDocument); published as immutable EventSpecVersions.
model EventSpec {
  id                    String             @id @default(cuid())
  name                  String
  specType              String             @default("asyncapi@3.0")
  /// EventSpecDocument (src/lib/event-specs/types.ts).
  document              Json
  latestVersionId       String?            @unique
  hasUnpublishedChanges Boolean            @default(true)
  /// AsyncAPI import provenance (Epic 19) — unused in Phase 4b.
  importedSource        String?
  sourceVersion         String?
  tenantId              String
  domainId              String?
  productId             String?
  tenant                Tenant             @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  domain                Domain?            @relation(fields: [domainId], references: [id], onDelete: Cascade)
  product               Product?           @relation(fields: [productId], references: [id], onDelete: Cascade)
  versions              EventSpecVersion[] @relation("EventSpecVersions")
  latestVersion         EventSpecVersion?  @relation("EventSpecLatestVersion", fields: [latestVersionId], references: [id], onDelete: SetNull)
  createdAt             DateTime           @default(now())
  updatedAt             DateTime           @updatedAt

  @@index([tenantId])
  @@index([domainId])
  @@index([productId])
  @@map("event_specs")
}

/// Immutable published Event Spec (DB trigger forbids UPDATE). `document` is never regenerated (spec §7.2 step 1).
model EventSpecVersion {
  id                  String                  @id @default(cuid())
  eventSpecId         String
  major               Int
  minor               Int
  sequence            Int
  /// Fully resolved AsyncAPI document; info.version = MAJOR.MINOR.
  document            Json
  /// The EventSpecDocument draft as published (input to the next bump classification).
  sourceDocument      Json
  /// ResolvedChannel[] frozen at publish.
  frozenChannels      Json
  /// FrozenTrait[] frozen at publish.
  frozenTraits        Json
  messageVersionIds   String[]
  changeKind          EntityVersionChangeKind
  /// { reasons: string[]; diagnostics: Diagnostic[] } (warnings / info at publish).
  compatReport        Json                    @default("{}")
  changeSummary       String?
  publishedById       String
  publishedAt         DateTime                @default(now())
  governanceRequestId String?
  eventSpec           EventSpec               @relation("EventSpecVersions", fields: [eventSpecId], references: [id], onDelete: Cascade)
  latestOf            EventSpec?              @relation("EventSpecLatestVersion")
  publishedBy         User                    @relation("EventSpecVersionPublisher", fields: [publishedById], references: [id])

  @@unique([eventSpecId, major, minor])
  @@unique([eventSpecId, sequence])
  @@map("event_spec_versions")
}
```

- [ ] **Step 4: Write the migration** (`prisma/migrations/20261016_events_core/migration.sql`)

```sql
-- Events core (Epic 18, spec §6.1): channels, channel_messages, traits, messages,
-- message_versions, event_specs, event_spec_versions. Pins reuse schema_references
-- (Track B). Idempotent so a partial apply can be re-run.

-- ── enum ─────────────────────────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE "TraitKind" AS ENUM ('MESSAGE', 'OPERATION');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── tables ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "channels" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "address" TEXT,
    "protocol" TEXT NOT NULL,
    "format" TEXT NOT NULL,
    "formatDialect" TEXT,
    "spec" JSONB NOT NULL DEFAULT '{}',
    "tenantId" TEXT NOT NULL,
    "domainId" TEXT,
    "productId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "channels_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "traits" (
    "id" TEXT NOT NULL,
    "kind" "TraitKind" NOT NULL,
    "name" TEXT NOT NULL,
    "spec" JSONB NOT NULL DEFAULT '{}',
    "headersEntityId" TEXT,
    "headersEntityVersionId" TEXT,
    "tenantId" TEXT NOT NULL,
    "domainId" TEXT,
    "productId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "traits_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "messages" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "spec" JSONB NOT NULL DEFAULT '{}',
    "payloadEntityId" TEXT NOT NULL,
    "payloadEntityVersionId" TEXT,
    "headersEntityId" TEXT,
    "headersEntityVersionId" TEXT,
    "keyEntityId" TEXT,
    "keyEntityVersionId" TEXT,
    "latestVersionId" TEXT,
    "hasUnpublishedChanges" BOOLEAN NOT NULL DEFAULT true,
    "tenantId" TEXT NOT NULL,
    "domainId" TEXT,
    "productId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "channel_messages" (
    "channelId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "channel_messages_pkey" PRIMARY KEY ("channelId", "messageId")
);

CREATE TABLE IF NOT EXISTS "message_versions" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "major" INTEGER NOT NULL,
    "minor" INTEGER NOT NULL,
    "sequence" INTEGER NOT NULL,
    "resolvedSpec" JSONB NOT NULL,
    "payloadEntityVersionId" TEXT NOT NULL,
    "headersEntityVersionId" TEXT,
    "keyEntityVersionId" TEXT,
    "changeKind" "EntityVersionChangeKind" NOT NULL,
    "compatReport" JSONB NOT NULL DEFAULT '{}',
    "changeSummary" TEXT,
    "publishedById" TEXT NOT NULL,
    "publishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "governanceRequestId" TEXT,
    CONSTRAINT "message_versions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "event_specs" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "specType" TEXT NOT NULL DEFAULT 'asyncapi@3.0',
    "document" JSONB NOT NULL,
    "latestVersionId" TEXT,
    "hasUnpublishedChanges" BOOLEAN NOT NULL DEFAULT true,
    "importedSource" TEXT,
    "sourceVersion" TEXT,
    "tenantId" TEXT NOT NULL,
    "domainId" TEXT,
    "productId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "event_specs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "event_spec_versions" (
    "id" TEXT NOT NULL,
    "eventSpecId" TEXT NOT NULL,
    "major" INTEGER NOT NULL,
    "minor" INTEGER NOT NULL,
    "sequence" INTEGER NOT NULL,
    "document" JSONB NOT NULL,
    "sourceDocument" JSONB NOT NULL,
    "frozenChannels" JSONB NOT NULL,
    "frozenTraits" JSONB NOT NULL,
    "messageVersionIds" TEXT[],
    "changeKind" "EntityVersionChangeKind" NOT NULL,
    "compatReport" JSONB NOT NULL DEFAULT '{}',
    "changeSummary" TEXT,
    "publishedById" TEXT NOT NULL,
    "publishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "governanceRequestId" TEXT,
    CONSTRAINT "event_spec_versions_pkey" PRIMARY KEY ("id")
);

-- ── unique + lookup indexes ──────────────────────────────────────────────────
CREATE UNIQUE INDEX IF NOT EXISTS "messages_latestVersionId_key"                ON "messages"("latestVersionId");
CREATE UNIQUE INDEX IF NOT EXISTS "event_specs_latestVersionId_key"             ON "event_specs"("latestVersionId");
CREATE UNIQUE INDEX IF NOT EXISTS "message_versions_messageId_major_minor_key"  ON "message_versions"("messageId", "major", "minor");
CREATE UNIQUE INDEX IF NOT EXISTS "message_versions_messageId_sequence_key"     ON "message_versions"("messageId", "sequence");
CREATE UNIQUE INDEX IF NOT EXISTS "event_spec_versions_eventSpecId_major_minor_key" ON "event_spec_versions"("eventSpecId", "major", "minor");
CREATE UNIQUE INDEX IF NOT EXISTS "event_spec_versions_eventSpecId_sequence_key"    ON "event_spec_versions"("eventSpecId", "sequence");
CREATE INDEX IF NOT EXISTS "channels_tenantId_idx"      ON "channels"("tenantId");
CREATE INDEX IF NOT EXISTS "channels_domainId_idx"      ON "channels"("domainId");
CREATE INDEX IF NOT EXISTS "channels_productId_idx"     ON "channels"("productId");
CREATE INDEX IF NOT EXISTS "traits_tenantId_idx"        ON "traits"("tenantId");
CREATE INDEX IF NOT EXISTS "traits_domainId_idx"        ON "traits"("domainId");
CREATE INDEX IF NOT EXISTS "traits_productId_idx"       ON "traits"("productId");
CREATE INDEX IF NOT EXISTS "messages_tenantId_idx"      ON "messages"("tenantId");
CREATE INDEX IF NOT EXISTS "messages_domainId_idx"      ON "messages"("domainId");
CREATE INDEX IF NOT EXISTS "messages_productId_idx"     ON "messages"("productId");
CREATE INDEX IF NOT EXISTS "messages_payloadEntityId_idx" ON "messages"("payloadEntityId");
CREATE INDEX IF NOT EXISTS "channel_messages_messageId_idx" ON "channel_messages"("messageId");
CREATE INDEX IF NOT EXISTS "message_versions_payloadEntityVersionId_idx" ON "message_versions"("payloadEntityVersionId");
CREATE INDEX IF NOT EXISTS "event_specs_tenantId_idx"   ON "event_specs"("tenantId");
CREATE INDEX IF NOT EXISTS "event_specs_domainId_idx"   ON "event_specs"("domainId");
CREATE INDEX IF NOT EXISTS "event_specs_productId_idx"  ON "event_specs"("productId");

-- ── foreign keys (D3: pins are NO ACTION — checked at end of statement) ───────
DO $$ BEGIN ALTER TABLE "channels" ADD CONSTRAINT "channels_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "channels" ADD CONSTRAINT "channels_domainId_fkey" FOREIGN KEY ("domainId") REFERENCES "domains"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "channels" ADD CONSTRAINT "channels_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN ALTER TABLE "traits" ADD CONSTRAINT "traits_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "traits" ADD CONSTRAINT "traits_domainId_fkey" FOREIGN KEY ("domainId") REFERENCES "domains"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "traits" ADD CONSTRAINT "traits_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "traits" ADD CONSTRAINT "traits_headersEntityId_fkey" FOREIGN KEY ("headersEntityId") REFERENCES "entities"("id") ON DELETE NO ACTION ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "traits" ADD CONSTRAINT "traits_headersEntityVersionId_fkey" FOREIGN KEY ("headersEntityVersionId") REFERENCES "entity_versions"("id") ON DELETE NO ACTION ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN ALTER TABLE "messages" ADD CONSTRAINT "messages_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "messages" ADD CONSTRAINT "messages_domainId_fkey" FOREIGN KEY ("domainId") REFERENCES "domains"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "messages" ADD CONSTRAINT "messages_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "messages" ADD CONSTRAINT "messages_payloadEntityId_fkey" FOREIGN KEY ("payloadEntityId") REFERENCES "entities"("id") ON DELETE NO ACTION ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "messages" ADD CONSTRAINT "messages_payloadEntityVersionId_fkey" FOREIGN KEY ("payloadEntityVersionId") REFERENCES "entity_versions"("id") ON DELETE NO ACTION ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "messages" ADD CONSTRAINT "messages_headersEntityId_fkey" FOREIGN KEY ("headersEntityId") REFERENCES "entities"("id") ON DELETE NO ACTION ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "messages" ADD CONSTRAINT "messages_headersEntityVersionId_fkey" FOREIGN KEY ("headersEntityVersionId") REFERENCES "entity_versions"("id") ON DELETE NO ACTION ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "messages" ADD CONSTRAINT "messages_keyEntityId_fkey" FOREIGN KEY ("keyEntityId") REFERENCES "entities"("id") ON DELETE NO ACTION ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "messages" ADD CONSTRAINT "messages_keyEntityVersionId_fkey" FOREIGN KEY ("keyEntityVersionId") REFERENCES "entity_versions"("id") ON DELETE NO ACTION ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "messages" ADD CONSTRAINT "messages_latestVersionId_fkey" FOREIGN KEY ("latestVersionId") REFERENCES "message_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN ALTER TABLE "channel_messages" ADD CONSTRAINT "channel_messages_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "channels"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "channel_messages" ADD CONSTRAINT "channel_messages_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "messages"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN ALTER TABLE "message_versions" ADD CONSTRAINT "message_versions_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "messages"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "message_versions" ADD CONSTRAINT "message_versions_publishedById_fkey" FOREIGN KEY ("publishedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "message_versions" ADD CONSTRAINT "message_versions_payloadEntityVersionId_fkey" FOREIGN KEY ("payloadEntityVersionId") REFERENCES "entity_versions"("id") ON DELETE NO ACTION ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "message_versions" ADD CONSTRAINT "message_versions_headersEntityVersionId_fkey" FOREIGN KEY ("headersEntityVersionId") REFERENCES "entity_versions"("id") ON DELETE NO ACTION ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "message_versions" ADD CONSTRAINT "message_versions_keyEntityVersionId_fkey" FOREIGN KEY ("keyEntityVersionId") REFERENCES "entity_versions"("id") ON DELETE NO ACTION ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN ALTER TABLE "event_specs" ADD CONSTRAINT "event_specs_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "event_specs" ADD CONSTRAINT "event_specs_domainId_fkey" FOREIGN KEY ("domainId") REFERENCES "domains"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "event_specs" ADD CONSTRAINT "event_specs_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "event_specs" ADD CONSTRAINT "event_specs_latestVersionId_fkey" FOREIGN KEY ("latestVersionId") REFERENCES "event_spec_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN ALTER TABLE "event_spec_versions" ADD CONSTRAINT "event_spec_versions_eventSpecId_fkey" FOREIGN KEY ("eventSpecId") REFERENCES "event_specs"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "event_spec_versions" ADD CONSTRAINT "event_spec_versions_publishedById_fkey" FOREIGN KEY ("publishedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── placement + shape CHECKs (spec §4.1, D1) ─────────────────────────────────
DO $$ BEGIN ALTER TABLE "channels" ADD CONSTRAINT "channels_level_check" CHECK ("productId" IS NOT NULL AND "domainId" IS NOT NULL); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "messages" ADD CONSTRAINT "messages_level_check" CHECK ("productId" IS NOT NULL AND "domainId" IS NOT NULL); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "event_specs" ADD CONSTRAINT "event_specs_level_check" CHECK ("productId" IS NOT NULL AND "domainId" IS NOT NULL); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "traits" ADD CONSTRAINT "traits_level_check" CHECK ("productId" IS NULL OR "domainId" IS NOT NULL); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "channels" ADD CONSTRAINT "channels_format_check" CHECK (
    "format" IN ('avro', 'json-schema', 'protobuf')
    AND ("formatDialect" IS NULL OR ("format" = 'json-schema' AND "formatDialect" IN ('draft-07', '2020-12')))
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "traits" ADD CONSTRAINT "traits_headers_check"
    CHECK ("kind" = 'MESSAGE' OR ("headersEntityId" IS NULL AND "headersEntityVersionId" IS NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "message_versions" ADD CONSTRAINT "message_versions_numbers_check" CHECK ("major" >= 1 AND "minor" >= 0 AND "sequence" >= 1); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "event_spec_versions" ADD CONSTRAINT "event_spec_versions_numbers_check" CHECK ("major" >= 1 AND "minor" >= 0 AND "sequence" >= 1); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── immutability (DELETE stays allowed so parents cascade) ───────────────────
CREATE OR REPLACE FUNCTION prevent_published_version_update()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'Published versions are immutable; publish a new version instead';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS message_versions_immutable ON "message_versions";
CREATE TRIGGER message_versions_immutable
  BEFORE UPDATE ON "message_versions"
  FOR EACH ROW
  EXECUTE FUNCTION prevent_published_version_update();

DROP TRIGGER IF EXISTS event_spec_versions_immutable ON "event_spec_versions";
CREATE TRIGGER event_spec_versions_immutable
  BEFORE UPDATE ON "event_spec_versions"
  FOR EACH ROW
  EXECUTE FUNCTION prevent_published_version_update();
```

- [ ] **Step 5: Generate the client and run the PGlite test**

Run: `npx prisma generate && npx vitest run tests/integration/db/events-core-pglite.test.ts`
Expected: PASS (1 test).

- [ ] **Step 6: Write the PostgreSQL round-trip test** (`tests/integration/db/events-core.test.ts`) — proves `schema.prisma` matches the SQL

```ts
import "dotenv/config";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient, type Prisma } from "@/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

let prisma: PrismaClient;
const TENANT = "tenant_default";
class Rollback extends Error {}

async function inRolledBackTx(fn: (tx: Prisma.TransactionClient) => Promise<void>) {
  try {
    await prisma.$transaction(async (tx) => {
      await fn(tx);
      throw new Rollback();
    }, { timeout: 30_000 });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }
}

beforeAll(() => {
  prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
});
afterAll(async () => prisma.$disconnect());

describe("events core schema (PostgreSQL)", () => {
  it("round-trips every events model and relation through the generated client", async () => {
    await inRolledBackTx(async (tx) => {
      const user = await tx.user.findFirstOrThrow();
      const s = `${Date.now()}`;
      const d = await tx.domain.create({ data: { name: `ev-${s}`, slug: `ev-${s}`, tenantId: TENANT } });
      const p = await tx.product.create({ data: { domainId: d.id, name: "Checkout", slug: `checkout-${s}` } });
      const e = await tx.entity.create({
        data: { name: "Order", slug: `order-${s}`, tenantId: TENANT, domainId: d.id, productId: p.id, ownerId: user.id },
      });
      const v = await tx.entityVersion.create({
        data: { entityId: e.id, major: 1, minor: 0, sequence: 1, resolvedSource: "model Order {}", fieldSnapshot: [], changeKind: "INITIAL", publishedById: user.id },
      });
      const level = { tenantId: TENANT, domainId: d.id, productId: p.id };

      const channel = await tx.channel.create({
        data: { ...level, name: "orders", address: "payments.orders.v1", protocol: "kafka", format: "avro", spec: { bindings: { kafka: { partitions: 12 } } } },
      });
      const trait = await tx.trait.create({
        data: { kind: "MESSAGE", name: `CloudEvents${s}`, tenantId: TENANT, headersEntityId: e.id, headersEntityVersionId: v.id },
      });
      const message = await tx.message.create({
        data: { ...level, name: "OrderCreated", payloadEntityId: e.id, payloadEntityVersionId: v.id, spec: { traitIds: [trait.id] } },
      });
      await tx.channelMessage.create({ data: { channelId: channel.id, messageId: message.id } });
      const mv = await tx.messageVersion.create({
        data: {
          messageId: message.id, major: 1, minor: 0, sequence: 1, resolvedSpec: { name: "OrderCreated" },
          payloadEntityVersionId: v.id, changeKind: "INITIAL", publishedById: user.id,
        },
      });
      await tx.message.update({ where: { id: message.id }, data: { latestVersionId: mv.id, hasUnpublishedChanges: false } });
      const spec = await tx.eventSpec.create({
        data: { ...level, name: "checkout-service", document: { info: { title: "checkout-service" }, servers: [], operations: [] } },
      });
      expect(spec.specType).toBe("asyncapi@3.0");
      const sv = await tx.eventSpecVersion.create({
        data: {
          eventSpecId: spec.id, major: 1, minor: 0, sequence: 1, document: { asyncapi: "3.0.0" }, sourceDocument: {},
          frozenChannels: [], frozenTraits: [], messageVersionIds: [mv.id], changeKind: "INITIAL", publishedById: user.id,
        },
      });

      const reread = await tx.message.findUniqueOrThrow({
        where: { id: message.id },
        include: { latestVersion: true, channels: true, payloadEntityVersion: true },
      });
      expect(reread.latestVersion?.id).toBe(mv.id);
      expect(reread.channels).toHaveLength(1);
      expect(reread.payloadEntityVersion?.id).toBe(v.id);
      expect((await tx.eventSpecVersion.findUniqueOrThrow({ where: { id: sv.id } })).messageVersionIds).toEqual([mv.id]);
      expect((await tx.trait.findUniqueOrThrow({ where: { id: trait.id }, include: { headersEntityVersion: true } })).headersEntityVersion?.id).toBe(v.id);
    });
  });
});
```

- [ ] **Step 7: Apply to PostgreSQL and run**

Run: `npm run db:deploy && npx vitest run tests/integration/db/events-core.test.ts tests/integration/db/events-core-pglite.test.ts`
Expected: PASS (2 tests). Then `npx tsc --noEmit` — no errors.

- [ ] **Step 8: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/20261016_events_core tests/integration/db/events-core-pglite.test.ts tests/integration/db/events-core.test.ts
git commit -m "feat(18.1): events core tables — channels, traits, messages, event specs + immutable versions"
```

---
### Task 2: Foundations — value types, input parsers, registry kinds, references, audit + action helpers (Stories 18.1 / 18.2)

**Files:**
- Create: `src/types/action-result.ts`, `src/lib/action-context.ts`
- Create: `src/lib/events/types.ts`, `src/lib/events/inputs.ts`, `src/lib/events/catalog-specs.ts`, `src/lib/events/event-spec-document.ts`, `src/lib/events/ownership.ts`, `src/lib/events/list-items.ts`
- Modify: `src/services/name-registry.service.ts`, `tests/unit/services/name-registry.test.ts` (fake DB gains the four new delegates)
- Create: `src/services/events/audited.ts`, `src/services/events/schema-references.ts`, `src/services/events/pins.ts`
- Create: `src/features/events/route-scope.ts`
- Create: `tests/integration/services/events/helpers.ts` (support file, not collected)
- Test: `tests/unit/lib/events/inputs.test.ts`, `tests/unit/lib/events/catalog-specs.test.ts`, `tests/unit/lib/events/event-spec-document.test.ts`, `tests/unit/lib/events/ownership-list-items.test.ts`, `tests/unit/services/events/audited.test.ts`, `tests/unit/services/name-registry-events.test.ts`, `tests/integration/services/events/foundations.test.ts`

**Interfaces (produced — every later task uses these names):**

```ts
// src/types/action-result.ts
type ActionResult<T> = { success: true; data: T } | { success: false; error: string; code?: string; details?: object };
// src/lib/action-context.ts (server)
getActionContext(): Promise<ServiceContext | null>; toActionResult<T>(r: Result<T>): ActionResult<T>; NOT_AUTHENTICATED
// src/lib/events/inputs.ts (pure, client-safe)
CATALOG_NAME_PATTERN; KNOWN_PROTOCOLS; PAYLOAD_FORMATS; JSON_SCHEMA_DIALECTS
normalizeCatalogName(raw, kindLabel): Result<string>; normalizeProtocol(raw): Result<string>
normalizeFormatProfile(format, dialect): Result<{ format: PayloadFormat; formatDialect: JsonSchemaDialect | null }>
isJsonObject(v): v is JsonObject; parseJsonObjectText(text, label): Result<JsonObject | undefined>
parseJsonObjectArrayText(text, label): Result<JsonObject[] | undefined>; formatJsonText(value): string
// src/lib/events/catalog-specs.ts
parseChannelSpec(v): Result<ChannelSpec>; readChannelSpec(v): ChannelSpec
parseMessageSpec(v): Result<MessageSpec>; readMessageSpec(v): MessageSpec; validateMessageSpec(spec): string[]
// src/lib/events/event-spec-document.ts
COMPONENT_KEY_PATTERN; emptyEventSpecDocument(title, description?): EventSpecDocument
parseEventSpecDocument(v): Result<EventSpecDocument>   // VALIDATION_ERROR, details.problems: DocumentProblem[]
collectDocumentRefs(doc): DocumentRefs                // { channelIds, messageRefIds, traitIds }
// src/lib/events/ownership.ts
assertOwnedBy(record: LevelScope, owner: LevelScope, label: string): Result<void>   // FORBIDDEN
// src/services/events/*
auditedWrite<T>(p: AuditedWriteParams<T>): Promise<Result<T>>
replaceReferences(tx, from: { kind; id }, edges: ReferenceEdge[], isDraft: boolean): Promise<void>
deleteReferencesFrom(tx, kind, ids: string[]): Promise<void>; pinEdges(pins): ReferenceEdge[]
resolvePin(db, tenantId, input: PinInput, label): Promise<Result<EntityPin>>
// src/features/events/route-scope.ts (server)
resolveProductRoute(domainSlug, productSlug): Promise<ProductRoute | null>
resolveLevelRoute(domainSlug: string | null, productSlug: string | null): Promise<LevelRoute | null>
```

- [ ] **Step 1: Write the failing pure tests**

`tests/unit/lib/events/inputs.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  normalizeCatalogName,
  normalizeFormatProfile,
  normalizeProtocol,
  parseJsonObjectArrayText,
  parseJsonObjectText,
  formatJsonText,
} from "@/lib/events/inputs";

describe("catalog inputs", () => {
  it("accepts AsyncAPI component-key names and trims them", () => {
    expect(normalizeCatalogName("  OrderCreated ", "Message")).toEqual({ success: true, data: "OrderCreated" });
    expect(normalizeCatalogName("checkout.orders-v1_x", "Channel").success).toBe(true);
  });

  it("rejects names with spaces, slashes or over 128 chars", () => {
    for (const bad of ["Order Created", "a/b", "", "x".repeat(129)]) {
      const r = normalizeCatalogName(bad, "Message");
      expect(r.success).toBe(false);
      expect(!r.success && r.error.code).toBe("VALIDATION_ERROR");
    }
  });

  it("lower-cases protocols and rejects malformed ones", () => {
    expect(normalizeProtocol(" Kafka ")).toEqual({ success: true, data: "kafka" });
    expect(normalizeProtocol("kafka-secure").success).toBe(true);
    expect(normalizeProtocol("my protocol").success).toBe(false);
    expect(normalizeProtocol("").success).toBe(false);
  });

  it("defaults JSON Schema to draft-07 and forbids a dialect on other formats", () => {
    expect(normalizeFormatProfile("json-schema", null)).toEqual({ success: true, data: { format: "json-schema", formatDialect: "draft-07" } });
    expect(normalizeFormatProfile("json-schema", "2020-12")).toEqual({ success: true, data: { format: "json-schema", formatDialect: "2020-12" } });
    expect(normalizeFormatProfile("avro", "")).toEqual({ success: true, data: { format: "avro", formatDialect: null } });
    expect(normalizeFormatProfile("avro", "draft-07").success).toBe(false);
    expect(normalizeFormatProfile("xml", null).success).toBe(false);
    expect(normalizeFormatProfile("json-schema", "draft-04").success).toBe(false);
  });

  it("parses JSON object / array-of-object text; empty means undefined", () => {
    expect(parseJsonObjectText("  ", "Bindings")).toEqual({ success: true, data: undefined });
    expect(parseJsonObjectText('{"kafka":{"partitions":12}}', "Bindings")).toEqual({ success: true, data: { kafka: { partitions: 12 } } });
    const notObject = parseJsonObjectText("[1]", "Bindings");
    expect(!notObject.success && notObject.error.message).toMatch(/Bindings must be a JSON object/);
    const broken = parseJsonObjectText("{", "Bindings");
    expect(!broken.success && broken.error.message).toMatch(/Bindings is not valid JSON/);
    expect(parseJsonObjectArrayText('[{"payload":{"id":"1"}}]', "Examples")).toEqual({ success: true, data: [{ payload: { id: "1" } }] });
    expect(parseJsonObjectArrayText('[1]', "Examples").success).toBe(false);
  });

  it("formats JSON for textareas", () => {
    expect(formatJsonText(undefined)).toBe("");
    expect(formatJsonText({ a: 1 })).toBe('{\n  "a": 1\n}');
  });
});
```

`tests/unit/lib/events/catalog-specs.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { parseChannelSpec, parseMessageSpec, readMessageSpec, validateMessageSpec } from "@/lib/events/catalog-specs";

describe("channel spec", () => {
  it("keeps known AsyncAPI channel fields and drops unknown keys", () => {
    const r = parseChannelSpec({ title: "Orders", bindings: { kafka: { partitions: 12 } }, parameters: { region: { description: "r" } }, extra: 1 });
    expect(r).toEqual({ success: true, data: { title: "Orders", bindings: { kafka: { partitions: 12 } }, parameters: { region: { description: "r" } } } });
  });

  it("reports every wrongly-typed field together", () => {
    const r = parseChannelSpec({ title: 3, bindings: [], tags: [1] });
    expect(r.success).toBe(false);
    expect(!r.success && (r.error.details as { problems: string[] }).problems).toEqual([
      "title must be a string",
      "bindings must be an object",
      "tags must be an array of objects",
    ]);
  });
});

describe("message spec", () => {
  it("defaults traitIds to [] and keeps AsyncAPI message fields", () => {
    expect(parseMessageSpec({ contentType: "avro/binary" })).toEqual({ success: true, data: { contentType: "avro/binary", traitIds: [] } });
  });

  it("reads leniently from stored JSON (bad parts dropped)", () => {
    expect(readMessageSpec({ title: 7, traitIds: ["t1", 2] })).toEqual({ traitIds: ["t1"] });
    expect(readMessageSpec(null)).toEqual({ traitIds: [] });
  });

  it("flags semantic problems that block publish", () => {
    expect(
      validateMessageSpec({
        contentType: "avro binary",
        correlationId: { location: "header.id" },
        examples: [{ payload: {}, foo: 1 }],
        traitIds: ["t1", "t1"],
      })
    ).toEqual([
      "contentType must not contain whitespace",
      'correlationId.location must start with "$message.header#" or "$message.payload#"',
      'examples[0] has unsupported key "foo" (allowed: name, summary, headers, payload)',
      'trait "t1" is listed more than once',
    ]);
    expect(validateMessageSpec({ correlationId: { location: "$message.header#/ce_id" }, traitIds: [] })).toEqual([]);
  });
});
```

`tests/unit/lib/events/event-spec-document.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { collectDocumentRefs, emptyEventSpecDocument, parseEventSpecDocument } from "@/lib/events/event-spec-document";

const op = (over: Record<string, unknown> = {}) => ({
  key: "publishOrderCreated", action: "send", channelId: "ch1", messageVersionIds: ["mv1"], traitIds: [], ...over,
});

describe("EventSpecDocument", () => {
  it("creates an empty draft", () => {
    expect(emptyEventSpecDocument("checkout-service")).toEqual({ info: { title: "checkout-service" }, servers: [], operations: [] });
  });

  it("normalizes a valid document and drops unknown keys", () => {
    const r = parseEventSpecDocument({
      info: { title: " checkout-service ", description: "d", junk: 1 },
      servers: [{ key: "kafka-prod", protocol: "kafka", host: "kafka:9092" }],
      operations: [op({ reply: { channelId: "ch2" } })],
      defaultContentType: "application/json",
    });
    expect(r).toEqual({
      success: true,
      data: {
        info: { title: "checkout-service", description: "d" },
        defaultContentType: "application/json",
        servers: [{ key: "kafka-prod", protocol: "kafka", host: "kafka:9092" }],
        operations: [{ key: "publishOrderCreated", action: "send", channelId: "ch1", messageVersionIds: ["mv1"], traitIds: [], reply: { channelId: "ch2" } }],
      },
    });
  });

  it("reports every problem with a pointer into the draft", () => {
    const r = parseEventSpecDocument({
      info: { title: "" },
      servers: [{ key: "a b", protocol: "", host: "h" }],
      operations: [op(), op({ action: "publish", channelId: "" })],
    });
    expect(r.success).toBe(false);
    expect(!r.success && (r.error.details as { problems: unknown[] }).problems).toEqual([
      { pointer: "/info/title", message: "info.title is required" },
      { pointer: "/servers/0/key", message: 'Server key "a b" must match ^[A-Za-z0-9._-]+$' },
      { pointer: "/servers/0/protocol", message: "Server protocol is required" },
      { pointer: "/operations/1/key", message: 'Duplicate operation key "publishOrderCreated"' },
      { pointer: "/operations/1/action", message: 'Operation action must be "send" or "receive"' },
      { pointer: "/operations/1/channelId", message: "Operation channel is required" },
    ]);
  });

  it("collects channel, message and trait references in first-reference order", () => {
    const parsed = parseEventSpecDocument({
      info: { title: "x" },
      servers: [],
      operations: [
        op({ traitIds: ["t1"], reply: { channelId: "ch2", messageVersionIds: ["mv2"] } }),
        op({ key: "second", channelId: "ch2", messageVersionIds: ["mv1", "m-draft"], traitIds: ["t1", "t2"] }),
      ],
    });
    expect(parsed.success && collectDocumentRefs(parsed.data)).toEqual({
      channelIds: ["ch1", "ch2"],
      messageRefIds: ["mv1", "mv2", "m-draft"],
      traitIds: ["t1", "t2"],
    });
  });
});
```

`tests/unit/lib/events/ownership-list-items.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { assertOwnedBy } from "@/lib/events/ownership";
import { channelListItem, eventSpecListItem, messageListItem, traitListItem } from "@/lib/events/list-items";

const checkout = { tenantId: "t", domainId: "d1", productId: "p1" };
const fraud = { tenantId: "t", domainId: "d2", productId: "p2" };
const updatedAt = new Date("2026-10-14T10:00:00.000Z");

describe("assertOwnedBy", () => {
  it("passes for the owner and returns FORBIDDEN otherwise", () => {
    expect(assertOwnedBy(checkout, checkout, 'Channel "orders"').success).toBe(true);
    const r = assertOwnedBy(checkout, fraud, 'Channel "orders"');
    expect(!r.success && r.error.code).toBe("FORBIDDEN");
    expect(!r.success && r.error.message).toMatch(/read-only/);
  });
});

describe("list items", () => {
  it("maps rows to list items with summaries and version labels", () => {
    expect(channelListItem({ id: "c", name: "orders", address: "a.b", protocol: "kafka", format: "avro", spec: { summary: "Orders" }, updatedAt })).toEqual({
      id: "c", name: "orders", summary: "Orders", updatedAt: "2026-10-14T10:00:00.000Z", address: "a.b", protocol: "kafka", format: "avro",
    });
    expect(
      messageListItem({ id: "m", name: "OrderCreated", spec: { description: "d" }, hasUnpublishedChanges: false, updatedAt, latestVersion: { major: 1, minor: 3 }, payloadEntity: { name: "Order" } })
    ).toMatchObject({ summary: "d", latestVersionLabel: "1.3", payloadEntityName: "Order" });
    expect(
      eventSpecListItem({ id: "s", name: "checkout-service", document: { info: { title: "x", description: "Spec" }, servers: [], operations: [{}, {}] }, hasUnpublishedChanges: true, updatedAt, latestVersion: null })
    ).toMatchObject({ summary: "Spec", latestVersionLabel: null, operationCount: 2 });
    expect(traitListItem({ id: "t", name: "CloudEvents", kind: "MESSAGE", spec: {}, updatedAt })).toMatchObject({ kind: "MESSAGE", summary: "" });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/unit/lib/events`
Expected: FAIL — `Cannot find module '@/lib/events/inputs'` (and the other new modules).

- [ ] **Step 3: Implement the client-safe types** (`src/types/action-result.ts`, `src/lib/events/types.ts`)

```ts
// src/types/action-result.ts
/**
 * Server action result (client-safe). `details` carries a ServiceError's structured
 * payload — validation problems, publish blockers — so forms can render them.
 */
export type ActionResult<T> =
  | { success: true; data: T }
  | { success: false; error: string; code?: string; details?: object };
```

```ts
// src/lib/events/types.ts
/** Events core value types shared by services, actions and client components (spec §6.1). Client-safe. */
import type { ChangeKind } from "@/lib/entity-versioning/types";
import type {
  EventSpecDocument,
  JsonObject,
  JsonSchemaDialect,
  PayloadFormat,
  ResolvedChannel,
  ResolvedTrait,
  TraitKind,
} from "@/lib/event-specs/types";

export type { EventSpecDocument, JsonObject, JsonSchemaDialect, PayloadFormat, TraitKind };

export type PinRole = "payload" | "headers" | "key";
export const PIN_ROLES: readonly PinRole[] = ["payload", "headers", "key"];

/** A Message / Trait reference to an entity. `entityVersionId: null` = not pinned yet (draft preview only). */
export interface EntityPin {
  entityId: string;
  entityVersionId: string | null;
}

/** Channel.spec — AsyncAPI Channel Object minus `address` and `messages`. */
export interface ChannelSpec {
  title?: string;
  summary?: string;
  description?: string;
  parameters?: Record<string, JsonObject>;
  bindings?: JsonObject;
  tags?: JsonObject[];
  externalDocs?: JsonObject;
}

/** Message.spec — AsyncAPI Message Object fields + catalog trait ids (MESSAGE traits). */
export interface MessageSpec {
  title?: string;
  summary?: string;
  description?: string;
  contentType?: string;
  correlationId?: JsonObject;
  tags?: JsonObject[];
  externalDocs?: JsonObject;
  bindings?: JsonObject;
  examples?: JsonObject[];
  traitIds: string[];
}

/** A pin frozen into a MessageVersion. */
export interface ResolvedPin {
  entityId: string;
  entityName: string;
  entityVersionId: string;
  label: string;
  major: number;
}

/** MessageVersion.resolvedSpec. */
export interface MessageResolvedSpec {
  name: string;
  spec: MessageSpec;
  payload: ResolvedPin;
  headers: ResolvedPin | null;
  key: ResolvedPin | null;
}

/** Trait row data frozen into an EventSpecVersion (rendered headers live in the stored document — D7). */
export type FrozenTrait = Omit<ResolvedTrait, "headers"> & {
  headersEntityId: string | null;
  headersEntityVersionId: string | null;
};

export type FrozenChannel = ResolvedChannel;

export interface EventVersionSummary {
  id: string;
  major: number;
  minor: number;
  /** "2.1" */
  label: string;
  sequence: number;
  changeKind: ChangeKind;
  changeSummary: string | null;
  publishedByName: string | null;
  /** ISO-8601 */
  publishedAt: string;
}

interface LevelColumns {
  tenantId: string;
  domainId: string | null;
  productId: string | null;
}

export interface ChannelDetail extends LevelColumns {
  id: string;
  name: string;
  address: string | null;
  protocol: string;
  format: PayloadFormat;
  formatDialect: JsonSchemaDialect | null;
  spec: ChannelSpec;
  allowedMessageIds: string[];
}

export interface TraitDetail extends LevelColumns {
  id: string;
  name: string;
  kind: TraitKind;
  spec: JsonObject;
  headers: EntityPin | null;
}

export interface MessageDetail extends LevelColumns {
  id: string;
  name: string;
  spec: MessageSpec;
  payload: EntityPin;
  headers: EntityPin | null;
  key: EntityPin | null;
  latestVersionLabel: string | null;
  hasUnpublishedChanges: boolean;
}

export interface EventSpecDetail extends LevelColumns {
  id: string;
  name: string;
  specType: string;
  document: EventSpecDocument;
  latestVersionLabel: string | null;
  hasUnpublishedChanges: boolean;
}

export interface CatalogListItem {
  id: string;
  name: string;
  summary: string;
  /** ISO-8601 */
  updatedAt: string;
}
export interface ChannelListItem extends CatalogListItem {
  address: string | null;
  protocol: string;
  format: PayloadFormat;
}
export interface MessageListItem extends CatalogListItem {
  latestVersionLabel: string | null;
  hasUnpublishedChanges: boolean;
  payloadEntityName: string;
}
export interface EventSpecListItem extends CatalogListItem {
  latestVersionLabel: string | null;
  hasUnpublishedChanges: boolean;
  operationCount: number;
}
export interface TraitListItem extends CatalogListItem {
  kind: TraitKind;
}
/** A list item with its canonical URL (computed server-side with assetHref). */
export type Linked<T> = T & { href: string };
```

- [ ] **Step 4: Implement the pure parsers** (`src/lib/events/inputs.ts`, `catalog-specs.ts`, `event-spec-document.ts`, `ownership.ts`, `list-items.ts`)

```ts
// src/lib/events/inputs.ts
import { ok, err, type Result } from "@/types/result";
import type { JsonObject, JsonSchemaDialect, JsonValue, PayloadFormat } from "@/lib/event-specs/types";

/** AsyncAPI component keys (`^[a-zA-Z0-9.\-_]+$`) — catalog names become component keys. */
export const CATALOG_NAME_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;
const PROTOCOL_PATTERN = /^[a-z][a-z0-9+.-]{0,31}$/;

/** Suggestions for the protocol field; any AsyncAPI protocol string matching PROTOCOL_PATTERN is accepted. */
export const KNOWN_PROTOCOLS = [
  "kafka", "googlepubsub", "pulsar", "amqp", "amqp1", "anypointmq", "http", "ibmmq", "jms",
  "mqtt", "nats", "redis", "sns", "solace", "sqs", "stomp", "ws",
] as const;
export const PAYLOAD_FORMATS: readonly PayloadFormat[] = ["avro", "json-schema", "protobuf"];
export const JSON_SCHEMA_DIALECTS: readonly JsonSchemaDialect[] = ["draft-07", "2020-12"];

const invalid = (message: string, suggestedFix?: string) =>
  err({ code: "VALIDATION_ERROR", message, ...(suggestedFix && { suggestedFix }) });

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizeCatalogName(raw: string, kindLabel: string): Result<string> {
  const name = (raw ?? "").trim();
  if (!CATALOG_NAME_PATTERN.test(name)) {
    return invalid(
      `${kindLabel} name "${raw}" is invalid`,
      "Use 1–128 letters, digits, '.', '_' or '-' (the name becomes an AsyncAPI component key)."
    );
  }
  return ok(name);
}

export function normalizeProtocol(raw: string): Result<string> {
  const protocol = (raw ?? "").trim().toLowerCase();
  if (!PROTOCOL_PATTERN.test(protocol)) {
    return invalid(`Protocol "${raw}" is invalid`, `Use an AsyncAPI protocol such as ${KNOWN_PROTOCOLS.slice(0, 3).join(", ")}.`);
  }
  return ok(protocol);
}

export function normalizeFormatProfile(
  format: string,
  dialect: string | null | undefined
): Result<{ format: PayloadFormat; formatDialect: JsonSchemaDialect | null }> {
  if (!PAYLOAD_FORMATS.includes(format as PayloadFormat)) {
    return invalid(`Format "${format}" is not supported`, `Use one of ${PAYLOAD_FORMATS.join(", ")}.`);
  }
  const d = dialect?.trim() ? dialect.trim() : null;
  if (format !== "json-schema") {
    return d ? invalid(`A dialect is only valid for JSON Schema (got "${d}" for ${format})`) : ok({ format: format as PayloadFormat, formatDialect: null });
  }
  if (d && !JSON_SCHEMA_DIALECTS.includes(d as JsonSchemaDialect)) {
    return invalid(`JSON Schema dialect "${d}" is not supported`, `Use ${JSON_SCHEMA_DIALECTS.join(" or ")}.`);
  }
  return ok({ format: "json-schema", formatDialect: (d as JsonSchemaDialect | null) ?? "draft-07" });
}

function parseJsonText(text: string, label: string): Result<JsonValue | undefined> {
  if (!text.trim()) return ok(undefined);
  try {
    return ok(JSON.parse(text) as JsonValue);
  } catch (e) {
    return invalid(`${label} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export function parseJsonObjectText(text: string, label: string): Result<JsonObject | undefined> {
  const parsed = parseJsonText(text, label);
  if (!parsed.success || parsed.data === undefined) return parsed as Result<undefined>;
  return isJsonObject(parsed.data) ? ok(parsed.data) : invalid(`${label} must be a JSON object`);
}

export function parseJsonObjectArrayText(text: string, label: string): Result<JsonObject[] | undefined> {
  const parsed = parseJsonText(text, label);
  if (!parsed.success || parsed.data === undefined) return parsed as Result<undefined>;
  return Array.isArray(parsed.data) && parsed.data.every(isJsonObject)
    ? ok(parsed.data as JsonObject[])
    : invalid(`${label} must be a JSON array of objects`);
}

export function formatJsonText(value: JsonValue | undefined): string {
  return value === undefined ? "" : JSON.stringify(value, null, 2);
}
```

```ts
// src/lib/events/catalog-specs.ts
import { ok, err, type Result } from "@/types/result";
import type { JsonObject } from "@/lib/event-specs/types";
import type { ChannelSpec, MessageSpec } from "./types";
import { isJsonObject } from "./inputs";

/** Reads typed fields off an unknown object, collecting one problem per bad field (spec §10: report together). */
class FieldReader {
  readonly problems: string[] = [];
  private readonly src: Record<string, unknown>;

  constructor(value: unknown, label: string) {
    if (value === undefined || value === null) this.src = {};
    else if (isJsonObject(value)) this.src = value;
    else {
      this.src = {};
      this.problems.push(`${label} must be an object`);
    }
  }

  string(key: string): string | undefined {
    const v = this.src[key];
    if (v === undefined || v === null || v === "") return undefined;
    if (typeof v !== "string") return this.fail(`${key} must be a string`);
    return v;
  }

  object(key: string): JsonObject | undefined {
    const v = this.src[key];
    if (v === undefined || v === null) return undefined;
    return isJsonObject(v) ? v : this.fail(`${key} must be an object`);
  }

  objects(key: string): JsonObject[] | undefined {
    const v = this.src[key];
    if (v === undefined || v === null) return undefined;
    return Array.isArray(v) && v.every(isJsonObject) ? (v as JsonObject[]) : this.fail(`${key} must be an array of objects`);
  }

  objectMap(key: string): Record<string, JsonObject> | undefined {
    const v = this.object(key);
    if (v === undefined) return undefined;
    return Object.values(v).every(isJsonObject) ? (v as Record<string, JsonObject>) : this.fail(`${key} values must be objects`);
  }

  /** Lenient: keeps the string entries; a non-array is a problem. */
  strings(key: string): string[] {
    const v = this.src[key];
    if (v === undefined || v === null) return [];
    if (!Array.isArray(v)) return this.fail(`${key} must be an array of strings`) ?? [];
    const kept = v.filter((x): x is string => typeof x === "string" && x.length > 0);
    if (kept.length !== v.length) this.problems.push(`${key} must contain only non-empty strings`);
    return kept;
  }

  private fail(problem: string): undefined {
    this.problems.push(problem);
    return undefined;
  }
}

function compact<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

function readChannel(value: unknown): { spec: ChannelSpec; problems: string[] } {
  const r = new FieldReader(value, "Channel spec");
  const spec = compact<ChannelSpec>({
    title: r.string("title"),
    summary: r.string("summary"),
    description: r.string("description"),
    parameters: r.objectMap("parameters"),
    bindings: r.object("bindings"),
    tags: r.objects("tags"),
    externalDocs: r.object("externalDocs"),
  });
  return { spec, problems: r.problems };
}

function readMessage(value: unknown): { spec: MessageSpec; problems: string[] } {
  const r = new FieldReader(value, "Message spec");
  const spec = compact<MessageSpec>({
    title: r.string("title"),
    summary: r.string("summary"),
    description: r.string("description"),
    contentType: r.string("contentType"),
    correlationId: r.object("correlationId"),
    tags: r.objects("tags"),
    externalDocs: r.object("externalDocs"),
    bindings: r.object("bindings"),
    examples: r.objects("examples"),
    traitIds: r.strings("traitIds"),
  });
  return { spec, problems: r.problems };
}

const invalidSpec = (label: string, problems: string[]) =>
  err({ code: "VALIDATION_ERROR", message: `Invalid ${label}: ${problems.join("; ")}`, details: { problems } });

export function parseChannelSpec(value: unknown): Result<ChannelSpec> {
  const { spec, problems } = readChannel(value);
  return problems.length > 0 ? invalidSpec("channel spec", problems) : ok(spec);
}

export function readChannelSpec(value: unknown): ChannelSpec {
  return readChannel(value).spec;
}

export function parseMessageSpec(value: unknown): Result<MessageSpec> {
  const { spec, problems } = readMessage(value);
  return problems.length > 0 ? invalidSpec("message spec", problems) : ok(spec);
}

export function readMessageSpec(value: unknown): MessageSpec {
  return readMessage(value).spec;
}

const EXAMPLE_KEYS = new Set(["name", "summary", "headers", "payload"]);
const CORRELATION_PREFIXES = ["$message.header#", "$message.payload#"];

/** Semantic checks a structurally valid MessageSpec must also pass before publish. */
export function validateMessageSpec(spec: MessageSpec): string[] {
  const problems: string[] = [];
  if (spec.contentType !== undefined && /\s/.test(spec.contentType)) problems.push("contentType must not contain whitespace");
  if (spec.correlationId !== undefined) {
    const location = spec.correlationId.location;
    if (typeof location !== "string" || !CORRELATION_PREFIXES.some((p) => location.startsWith(p))) {
      problems.push('correlationId.location must start with "$message.header#" or "$message.payload#"');
    }
  }
  spec.examples?.forEach((example, i) => {
    for (const key of Object.keys(example)) {
      if (!EXAMPLE_KEYS.has(key)) problems.push(`examples[${i}] has unsupported key "${key}" (allowed: name, summary, headers, payload)`);
    }
  });
  const seen = new Set<string>();
  for (const id of spec.traitIds) {
    if (seen.has(id)) problems.push(`trait "${id}" is listed more than once`);
    seen.add(id);
  }
  return problems;
}
```

```ts
// src/lib/events/event-spec-document.ts
import { ok, err, type Result } from "@/types/result";
import type {
  EventSpecDocument,
  EventSpecLocalComponents,
  EventSpecOperation,
  EventSpecServer,
  JsonObject,
} from "@/lib/event-specs/types";
import { isJsonObject } from "./inputs";

export const COMPONENT_KEY_PATTERN = /^[A-Za-z0-9._-]+$/;
export interface DocumentProblem {
  pointer: string;
  message: string;
}
export interface DocumentRefs {
  channelIds: string[];
  messageRefIds: string[];
  traitIds: string[];
}

export function emptyEventSpecDocument(title: string, description?: string): EventSpecDocument {
  return { info: description ? { title, description } : { title }, servers: [], operations: [] };
}

type Bag = Record<string, unknown>;
const asBag = (v: unknown): Bag => (isJsonObject(v) ? v : {});

function optString(src: Bag, key: string, pointer: string, problems: DocumentProblem[]): string | undefined {
  const v = src[key];
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v === "string") return v;
  problems.push({ pointer: `${pointer}/${key}`, message: `${key} must be a string` });
  return undefined;
}

function optObject(src: Bag, key: string, pointer: string, problems: DocumentProblem[]): JsonObject | undefined {
  const v = src[key];
  if (v === undefined || v === null) return undefined;
  if (isJsonObject(v)) return v;
  problems.push({ pointer: `${pointer}/${key}`, message: `${key} must be an object` });
  return undefined;
}

function stringList(src: Bag, key: string, pointer: string, problems: DocumentProblem[]): string[] {
  const v = src[key];
  if (v === undefined || v === null) return [];
  if (Array.isArray(v) && v.every((x) => typeof x === "string" && x.length > 0)) return [...(v as string[])];
  problems.push({ pointer: `${pointer}/${key}`, message: `${key} must be an array of ids` });
  return [];
}

function compact<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

function parseServers(raw: unknown, problems: DocumentProblem[]): EventSpecServer[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    problems.push({ pointer: "/servers", message: "servers must be an array" });
    return [];
  }
  const keys = new Set<string>();
  return raw.map((item, i) => {
    const p = `/servers/${i}`;
    const s = asBag(item);
    const key = typeof s.key === "string" ? s.key.trim() : "";
    if (!COMPONENT_KEY_PATTERN.test(key)) problems.push({ pointer: `${p}/key`, message: `Server key "${key}" must match ^[A-Za-z0-9._-]+$` });
    else if (keys.has(key)) problems.push({ pointer: `${p}/key`, message: `Duplicate server key "${key}"` });
    keys.add(key);
    const protocol = typeof s.protocol === "string" ? s.protocol.trim() : "";
    if (!protocol) problems.push({ pointer: `${p}/protocol`, message: "Server protocol is required" });
    const host = typeof s.host === "string" ? s.host.trim() : "";
    if (!host) problems.push({ pointer: `${p}/host`, message: "Server host is required" });
    return compact<EventSpecServer>({
      key,
      protocol,
      host,
      pathname: optString(s, "pathname", p, problems),
      protocolVersion: optString(s, "protocolVersion", p, problems),
      description: optString(s, "description", p, problems),
      externalRef: optString(s, "externalRef", p, problems),
    });
  });
}

function parseOperations(raw: unknown, problems: DocumentProblem[]): EventSpecOperation[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    problems.push({ pointer: "/operations", message: "operations must be an array" });
    return [];
  }
  const keys = new Set<string>();
  return raw.map((item, i) => {
    const p = `/operations/${i}`;
    const o = asBag(item);
    const key = typeof o.key === "string" ? o.key.trim() : "";
    if (!COMPONENT_KEY_PATTERN.test(key)) problems.push({ pointer: `${p}/key`, message: `Operation key "${key}" must match ^[A-Za-z0-9._-]+$` });
    else if (keys.has(key)) problems.push({ pointer: `${p}/key`, message: `Duplicate operation key "${key}"` });
    keys.add(key);
    const action = o.action === "send" || o.action === "receive" ? o.action : null;
    if (!action) problems.push({ pointer: `${p}/action`, message: 'Operation action must be "send" or "receive"' });
    const channelId = typeof o.channelId === "string" ? o.channelId.trim() : "";
    if (!channelId) problems.push({ pointer: `${p}/channelId`, message: "Operation channel is required" });

    let reply: EventSpecOperation["reply"];
    if (o.reply !== undefined && o.reply !== null) {
      if (!isJsonObject(o.reply)) problems.push({ pointer: `${p}/reply`, message: "reply must be an object" });
      else {
        const r = o.reply;
        reply = compact({
          channelId: optString(r, "channelId", `${p}/reply`, problems),
          messageVersionIds: r.messageVersionIds === undefined ? undefined : stringList(r, "messageVersionIds", `${p}/reply`, problems),
        });
      }
    }

    return compact<EventSpecOperation>({
      key,
      action: action ?? "send",
      channelId,
      messageVersionIds: stringList(o, "messageVersionIds", p, problems),
      traitIds: stringList(o, "traitIds", p, problems),
      summary: optString(o, "summary", p, problems),
      description: optString(o, "description", p, problems),
      bindings: optObject(o, "bindings", p, problems),
      reply,
    });
  });
}

function parseComponents(raw: unknown, problems: DocumentProblem[]): EventSpecLocalComponents | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!isJsonObject(raw)) {
    problems.push({ pointer: "/components", message: "components must be an object" });
    return undefined;
  }
  const out: EventSpecLocalComponents = {};
  for (const key of ["correlationIds", "parameters", "securitySchemes", "operationBindings"] as const) {
    const map = optObject(raw, key, "/components", problems);
    if (map === undefined) continue;
    if (!Object.values(map).every(isJsonObject)) {
      problems.push({ pointer: `/components/${key}`, message: `components.${key} values must be objects` });
      continue;
    }
    out[key] = map as Record<string, JsonObject>;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Validate + normalize a stored or submitted draft (spec §6.1). Unknown keys are dropped. */
export function parseEventSpecDocument(value: unknown): Result<EventSpecDocument> {
  const problems: DocumentProblem[] = [];
  if (!isJsonObject(value)) {
    return err({ code: "VALIDATION_ERROR", message: "The event spec document must be an object", details: { problems: [{ pointer: "", message: "document must be an object" }] } });
  }
  const infoBag = asBag(value.info);
  if (!isJsonObject(value.info)) problems.push({ pointer: "/info", message: "info must be an object" });
  const title = typeof infoBag.title === "string" ? infoBag.title.trim() : "";
  if (!title) problems.push({ pointer: "/info/title", message: "info.title is required" });
  else if (title.length > 200) problems.push({ pointer: "/info/title", message: "info.title must be at most 200 characters" });
  const tags = infoBag.tags;
  if (tags !== undefined && !(Array.isArray(tags) && tags.every(isJsonObject))) problems.push({ pointer: "/info/tags", message: "tags must be an array of objects" });

  const doc: EventSpecDocument = {
    info: compact({
      title,
      description: optString(infoBag, "description", "/info", problems),
      contact: optObject(infoBag, "contact", "/info", problems),
      license: optObject(infoBag, "license", "/info", problems),
      tags: Array.isArray(tags) && tags.every(isJsonObject) ? (tags as JsonObject[]) : undefined,
      externalDocs: optObject(infoBag, "externalDocs", "/info", problems),
    }),
    servers: [],
    operations: [],
  };
  const defaultContentType = optString(value, "defaultContentType", "", problems);
  if (defaultContentType !== undefined) doc.defaultContentType = defaultContentType;
  doc.servers = parseServers(value.servers, problems);
  doc.operations = parseOperations(value.operations, problems);
  const components = parseComponents(value.components, problems);
  if (components) doc.components = components;

  if (problems.length > 0) {
    return err({
      code: "VALIDATION_ERROR",
      message: `The event spec document has ${problems.length} problem(s)`,
      details: { problems },
      suggestedFix: "Fix the highlighted fields and save again.",
    });
  }
  return ok(doc);
}

/** Every referenced id, unique, in first-reference order. */
export function collectDocumentRefs(doc: EventSpecDocument): DocumentRefs {
  const channelIds = new Set<string>();
  const messageRefIds = new Set<string>();
  const traitIds = new Set<string>();
  for (const op of doc.operations) {
    channelIds.add(op.channelId);
    op.messageVersionIds.forEach((id) => messageRefIds.add(id));
    op.traitIds.forEach((id) => traitIds.add(id));
    if (op.reply?.channelId) channelIds.add(op.reply.channelId);
    op.reply?.messageVersionIds?.forEach((id) => messageRefIds.add(id));
  }
  return { channelIds: [...channelIds], messageRefIds: [...messageRefIds], traitIds: [...traitIds] };
}
```

```ts
// src/lib/events/ownership.ts
import { ok, err, type Result } from "@/types/result";
import { levelLabel, levelOf, type LevelScope } from "@/lib/levels";

/** Spec §10: writes to another level's / product's records return FORBIDDEN (cross references are read-only). */
export function assertOwnedBy(record: LevelScope, owner: LevelScope, label: string): Result<void> {
  if (record.tenantId === owner.tenantId && record.domainId === owner.domainId && record.productId === owner.productId) {
    return ok(undefined);
  }
  return err({
    code: "FORBIDDEN",
    message: `${label} is owned by another ${levelLabel(levelOf(record))} scope and is read-only here.`,
    suggestedFix: "Open it from its owning level to edit it.",
  });
}
```

```ts
// src/lib/events/list-items.ts
import { formatVersionLabel } from "@/lib/entity-versioning/version-math";
import type { VersionNumber } from "@/lib/entity-versioning/types";
import { readChannelSpec, readMessageSpec } from "./catalog-specs";
import { isJsonObject } from "./inputs";
import type { ChannelListItem, EventSpecListItem, MessageListItem, PayloadFormat, TraitKind, TraitListItem } from "./types";

function summaryOf(spec: { summary?: unknown; description?: unknown }): string {
  const text = typeof spec.summary === "string" && spec.summary ? spec.summary : typeof spec.description === "string" ? spec.description : "";
  return text.slice(0, 200);
}
const label = (v: VersionNumber | null) => (v ? formatVersionLabel(v) : null);

export function channelListItem(row: { id: string; name: string; address: string | null; protocol: string; format: string; spec: unknown; updatedAt: Date }): ChannelListItem {
  return {
    id: row.id, name: row.name, summary: summaryOf(readChannelSpec(row.spec)), updatedAt: row.updatedAt.toISOString(),
    address: row.address, protocol: row.protocol, format: row.format as PayloadFormat,
  };
}

export function messageListItem(row: {
  id: string; name: string; spec: unknown; hasUnpublishedChanges: boolean; updatedAt: Date;
  latestVersion: VersionNumber | null; payloadEntity: { name: string };
}): MessageListItem {
  return {
    id: row.id, name: row.name, summary: summaryOf(readMessageSpec(row.spec)), updatedAt: row.updatedAt.toISOString(),
    latestVersionLabel: label(row.latestVersion), hasUnpublishedChanges: row.hasUnpublishedChanges, payloadEntityName: row.payloadEntity.name,
  };
}

export function eventSpecListItem(row: {
  id: string; name: string; document: unknown; hasUnpublishedChanges: boolean; updatedAt: Date; latestVersion: VersionNumber | null;
}): EventSpecListItem {
  const doc = isJsonObject(row.document) ? row.document : {};
  const info = isJsonObject(doc.info) ? doc.info : {};
  return {
    id: row.id, name: row.name, summary: summaryOf(info), updatedAt: row.updatedAt.toISOString(),
    latestVersionLabel: label(row.latestVersion), hasUnpublishedChanges: row.hasUnpublishedChanges,
    operationCount: Array.isArray(doc.operations) ? doc.operations.length : 0,
  };
}

export function traitListItem(row: { id: string; name: string; kind: string; spec: unknown; updatedAt: Date }): TraitListItem {
  return {
    id: row.id, name: row.name, kind: row.kind as TraitKind,
    summary: summaryOf(isJsonObject(row.spec) ? row.spec : {}), updatedAt: row.updatedAt.toISOString(),
  };
}
```

- [ ] **Step 5: Run the pure tests**

Run: `npx vitest run tests/unit/lib/events`
Expected: PASS (4 files).

- [ ] **Step 6: Write the failing service-helper tests**

`tests/unit/services/name-registry-events.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { assertNameAvailable } from "@/services/name-registry.service";

const empty = { findMany: vi.fn(async () => []) };
function fakeDb(rows: Partial<Record<string, Array<Record<string, unknown>>>>) {
  const delegate = (key: string) => ({ findMany: vi.fn(async () => rows[key] ?? []) });
  return {
    entity: empty, sharedEnum: empty, customScalar: empty, unionType: empty, serviceDefinition: empty,
    trait: delegate("trait"), message: delegate("message"), channel: delegate("channel"), eventSpec: delegate("eventSpec"),
  };
}

describe("name registry — events kinds", () => {
  it("treats channels, messages, traits and event specs as line-unique names", async () => {
    const db = fakeDb({ channel: [{ id: "c1", name: "orders", tenantId: "t", domainId: "d1", productId: "p1" }] });
    const r = await assertNameAvailable(db as never, { name: "Orders", tenantId: "t", domainId: "d1", productId: "p1" });
    expect(r.success).toBe(false);
    expect(!r.success && r.error.message).toBe('"Orders" is already used by Channel "orders" at Product level.');
  });

  it("sees tenant-level traits from every product line and ignores sibling products", async () => {
    const db = fakeDb({
      trait: [{ id: "t1", name: "CloudEvents", tenantId: "t", domainId: null, productId: null }],
      eventSpec: [{ id: "s1", name: "checkout-service", tenantId: "t", domainId: "d1", productId: "p1" }],
    });
    const traitClash = await assertNameAvailable(db as never, { name: "cloudevents", tenantId: "t", domainId: "d2", productId: "p9" });
    expect(!traitClash.success && traitClash.error.message).toMatch(/Trait "CloudEvents" at Enterprise level/);
    const sibling = await assertNameAvailable(db as never, { name: "checkout-service", tenantId: "t", domainId: "d1", productId: "p2" });
    expect(sibling.success).toBe(true);
  });

  it("excludes the record being renamed", async () => {
    const db = fakeDb({ message: [{ id: "m1", name: "OrderCreated", tenantId: "t", domainId: "d1", productId: "p1" }] });
    const r = await assertNameAvailable(db as never, {
      name: "OrderCreated", tenantId: "t", domainId: "d1", productId: "p1", exclude: { kind: "message", id: "m1" },
    });
    expect(r.success).toBe(true);
  });
});
```

`tests/unit/services/events/audited.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({ withAudit: vi.fn() }));
vi.mock("@/lib/audit", () => {
  class AuditUserMissingError extends Error {}
  return { withAudit: h.withAudit, AuditUserMissingError };
});

import { auditedWrite } from "@/services/events/audited";
import { AuditUserMissingError } from "@/lib/audit";

beforeEach(() => {
  h.withAudit.mockReset();
  h.withAudit.mockImplementation(async ({ fn }: { fn: () => Promise<unknown> }) => fn());
});
const base = { action: "CREATE", entityType: "Channel", entityId: "pending", userId: "u1" };

describe("auditedWrite", () => {
  it("returns the data and audits once on success", async () => {
    const r = await auditedWrite({ ...base, run: async () => ({ success: true as const, data: { id: "c1" } }) });
    expect(r).toEqual({ success: true, data: { id: "c1" } });
    expect(h.withAudit).toHaveBeenCalledTimes(1);
  });

  it("passes a Result failure through without auditing it", async () => {
    const r = await auditedWrite({ ...base, run: async () => ({ success: false as const, error: { code: "NAME_CONFLICT", message: "taken" } }) });
    expect(r).toEqual({ success: false, error: { code: "NAME_CONFLICT", message: "taken" } });
  });

  it("maps a missing audit user and Prisma errors to service errors", async () => {
    h.withAudit.mockRejectedValueOnce(new AuditUserMissingError("gone"));
    expect(await auditedWrite({ ...base, run: vi.fn() })).toMatchObject({ success: false, error: { code: "UNAUTHORIZED" } });
    h.withAudit.mockRejectedValueOnce(Object.assign(new Error("fk"), { code: "P2003" }));
    expect(await auditedWrite({ ...base, run: vi.fn() })).toMatchObject({ success: false, error: { code: "IN_USE" } });
    h.withAudit.mockRejectedValueOnce(Object.assign(new Error("dup"), { code: "P2002" }));
    expect(await auditedWrite({ ...base, run: vi.fn() })).toMatchObject({ success: false, error: { code: "CONFLICT" } });
    h.withAudit.mockRejectedValueOnce(new Error("boom"));
    expect(await auditedWrite({ ...base, run: vi.fn() })).toEqual({ success: false, error: { code: "DB_ERROR", message: "boom" } });
  });
});
```

- [ ] **Step 7: Run to verify failure**

Run: `npx vitest run tests/unit/services/name-registry-events.test.ts tests/unit/services/events/audited.test.ts`
Expected: FAIL — registry ignores the `channel` delegate (test 1 passes as available) and `Cannot find module '@/services/events/audited'`.

- [ ] **Step 8: Extend the name registry** (`src/services/name-registry.service.ts`)

```ts
export type RegistryKind =
  | "entity" | "sharedEnum" | "customScalar" | "unionType" | "service"
  | "trait" | "message" | "channel" | "eventSpec";

const KIND_LABEL: Record<RegistryKind, string> = {
  entity: "Entity",
  sharedEnum: "Enum",
  customScalar: "Scalar",
  unionType: "Union",
  service: "API",
  trait: "Trait",
  message: "Message",
  channel: "Channel",
  eventSpec: "Event Spec",
};

const FINDERS: Record<RegistryKind, (db: Db, where: RegistryWhere) => Promise<NamedRow[]>> = {
  entity: (db, where) => db.entity.findMany({ where, select: NAMED_SELECT }),
  sharedEnum: (db, where) => db.sharedEnum.findMany({ where, select: NAMED_SELECT }),
  customScalar: (db, where) => db.customScalar.findMany({ where, select: NAMED_SELECT }),
  unionType: (db, where) => db.unionType.findMany({ where, select: NAMED_SELECT }),
  service: (db, where) => db.serviceDefinition.findMany({ where, select: NAMED_SELECT }),
  trait: (db, where) => db.trait.findMany({ where, select: NAMED_SELECT }),
  message: (db, where) => db.message.findMany({ where, select: NAMED_SELECT }),
  channel: (db, where) => db.channel.findMany({ where, select: NAMED_SELECT }),
  eventSpec: (db, where) => db.eventSpec.findMany({ where, select: NAMED_SELECT }),
};
```

(Replace the three existing declarations; nothing else in the file changes. `scripts/report-name-conflicts.ts` picks the new kinds up automatically through `findNameConflicts`.)

The existing unit test `tests/unit/services/name-registry.test.ts` builds a fake DB with only the five old delegates; with the new finders its "available" cases would hit `undefined.findMany` → `DB_ERROR`. Add the four delegates to its `fakeDb` (around line 93):

```ts
  const fakeDb = (over: Record<string, unknown> = {}) =>
    ({
      entity: { findMany: emptyFinder },
      sharedEnum: { findMany: emptyFinder },
      customScalar: { findMany: emptyFinder },
      unionType: { findMany: emptyFinder },
      serviceDefinition: { findMany: emptyFinder },
      trait: { findMany: emptyFinder },
      message: { findMany: emptyFinder },
      channel: { findMany: emptyFinder },
      eventSpec: { findMany: emptyFinder },
      ...over,
    }) as never;
```

(Every other test that touches the registry mocks `@/services/name-registry.service` entirely — checked with `grep -rn 'vi.mock("@/services/name-registry.service"' tests`.)

- [ ] **Step 9: Implement the service helpers**

```ts
// src/services/events/audited.ts
import { withAudit, AuditUserMissingError } from "@/lib/audit";
import { ServiceErrorRejection } from "@/services/scoped-create.service";
import { ok, err, type Result } from "@/types/result";

export interface AuditedWriteParams<T> {
  action: string;
  entityType: string;
  entityId: string;
  userId: string;
  beforeState?: object;
  /** A Result failure is returned as-is and never audited (withAudit only logs after fn resolves). */
  run: () => Promise<Result<T>>;
}

function prismaCode(e: unknown): string | undefined {
  const code = typeof e === "object" && e !== null ? (e as { code?: unknown }).code : undefined;
  return typeof code === "string" ? code : undefined;
}

/** withAudit + the error mapping every events mutation needs (no throw crosses the service boundary). */
export async function auditedWrite<T>(p: AuditedWriteParams<T>): Promise<Result<T>> {
  try {
    const data = await withAudit({
      action: p.action,
      entityType: p.entityType,
      entityId: p.entityId,
      userId: p.userId,
      beforeState: p.beforeState,
      fn: async () => {
        const r = await p.run();
        if (!r.success) throw new ServiceErrorRejection(r.error);
        return r.data;
      },
    });
    return ok(data);
  } catch (e: unknown) {
    if (e instanceof ServiceErrorRejection) return err(e.serviceError);
    if (e instanceof AuditUserMissingError) return err({ code: "UNAUTHORIZED", message: e.message });
    const code = prismaCode(e);
    if (code === "P2002") return err({ code: "CONFLICT", message: "A concurrent change won.", suggestedFix: "Reload and try again." });
    if (code === "P2003") {
      return err({ code: "IN_USE", message: "This record is referenced by another record and cannot be removed.", suggestedFix: "Remove the references first." });
    }
    if (code === "P2025") return err({ code: "NOT_FOUND", message: "The record no longer exists." });
    return err({ code: "DB_ERROR", message: e instanceof Error ? e.message : "Database error" });
  }
}
```

```ts
// src/services/events/schema-references.ts
import type { Prisma, SchemaReferenceFromKind, SchemaReferenceRole, SchemaReferenceToKind } from "@/generated/prisma/client";
import type { PinRole } from "@/lib/events/types";

type Tx = Prisma.TransactionClient;

export interface ReferenceEdge {
  role: SchemaReferenceRole;
  toKind: SchemaReferenceToKind;
  toId: string;
}

const ROLE: Record<PinRole, SchemaReferenceRole> = { payload: "PAYLOAD", headers: "HEADERS", key: "KEY" };

/** Edges for pinned entity versions (unpinned roles produce no edge). */
export function pinEdges(pins: Partial<Record<PinRole, string | null>>): ReferenceEdge[] {
  return (Object.entries(pins) as Array<[PinRole, string | null | undefined]>)
    .filter((entry): entry is [PinRole, string] => typeof entry[1] === "string")
    .map(([role, toId]) => ({ role: ROLE[role], toKind: "ENTITY_VERSION" as const, toId }));
}

/** D2: rewrite every edge from one record in the caller's transaction. */
export async function replaceReferences(
  tx: Tx,
  from: { kind: SchemaReferenceFromKind; id: string },
  edges: ReferenceEdge[],
  isDraft: boolean
): Promise<void> {
  await tx.schemaReference.deleteMany({ where: { fromKind: from.kind, fromId: from.id } });
  if (edges.length === 0) return;
  await tx.schemaReference.createMany({
    data: edges.map((e) => ({ fromKind: from.kind, fromId: from.id, role: e.role, toKind: e.toKind, toId: e.toId, isDraft })),
    skipDuplicates: true,
  });
}

export async function deleteReferencesFrom(tx: Tx, kind: SchemaReferenceFromKind, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await tx.schemaReference.deleteMany({ where: { fromKind: kind, fromId: { in: ids } } });
}
```

```ts
// src/services/events/pins.ts
import type { PrismaClient, Prisma } from "@/generated/prisma/client";
import type { EntityPin } from "@/lib/events/types";
import { ok, err, type Result } from "@/types/result";

type Db = PrismaClient | Prisma.TransactionClient;

/** D5: `entityVersionId` omitted → latest published version; `null` → unpinned (draft preview only). */
export interface PinInput {
  entityId: string;
  entityVersionId?: string | null;
}

export async function resolvePin(db: Db, tenantId: string, input: PinInput, label: string): Promise<Result<EntityPin>> {
  const entity = await db.entity.findFirst({
    where: { id: input.entityId, tenantId },
    select: { id: true, name: true, latestVersionId: true },
  });
  if (!entity) return err({ code: "VALIDATION_ERROR", message: `${label}: entity "${input.entityId}" not found in this tenant` });
  if (input.entityVersionId === undefined) return ok({ entityId: entity.id, entityVersionId: entity.latestVersionId });
  if (input.entityVersionId === null) return ok({ entityId: entity.id, entityVersionId: null });
  const version = await db.entityVersion.findUnique({ where: { id: input.entityVersionId }, select: { entityId: true } });
  if (!version || version.entityId !== entity.id) {
    return err({ code: "VALIDATION_ERROR", message: `${label}: "${input.entityVersionId}" is not a published version of ${entity.name}` });
  }
  return ok({ entityId: entity.id, entityVersionId: input.entityVersionId });
}
```

```ts
// src/lib/action-context.ts
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { getEffectiveRole } from "@/services/rbac.service";
import type { ActionResult } from "@/types/action-result";
import type { Result } from "@/types/result";
import type { ServiceContext } from "@/types/service-context";

export const NOT_AUTHENTICATED = { success: false, error: "Not authenticated", code: "UNAUTHORIZED" } as const satisfies ActionResult<never>;

/** Same role resolution as version-actions.ts: authenticated user, effective role fail-closed to VIEWER (D16). */
export async function getActionContext(): Promise<ServiceContext | null> {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return null;
  const role = await getEffectiveRole(userId, null, { userId, userRole: "VIEWER", prisma });
  return { userId, userRole: role.success && role.data ? role.data : "VIEWER", prisma };
}

export function toActionResult<T>(result: Result<T>): ActionResult<T> {
  if (result.success) return { success: true, data: result.data };
  const { message, code, details } = result.error;
  return details ? { success: false, error: message, code, details } : { success: false, error: message, code };
}
```

```ts
// src/features/events/route-scope.ts
import { prisma } from "@/lib/db";
import { getActiveTenantId } from "@/lib/active-tenant";
import type { ScopeTarget } from "@/lib/asset-scope";
import type { LevelScope } from "@/lib/levels";

interface Named {
  id: string;
  name: string;
  slug: string;
}

export interface ProductRoute {
  tenantId: string;
  tenantSlug: string;
  domain: Named;
  product: Named;
}

/** Product addressed by `/schemas/<domainSlug>/<productSlug>/…` inside the active tenant, or null. */
export async function resolveProductRoute(domainSlug: string, productSlug: string): Promise<ProductRoute | null> {
  const tenantId = await getActiveTenantId();
  const product = await prisma.product.findFirst({
    where: { slug: productSlug, domain: { slug: domainSlug, tenantId } },
    select: {
      id: true, name: true, slug: true,
      domain: { select: { id: true, name: true, slug: true, tenant: { select: { id: true, slug: true } } } },
    },
  });
  if (!product) return null;
  return {
    tenantId: product.domain.tenant.id,
    tenantSlug: product.domain.tenant.slug,
    domain: { id: product.domain.id, name: product.domain.name, slug: product.domain.slug },
    product: { id: product.id, name: product.name, slug: product.slug },
  };
}

export interface LevelRoute {
  scope: LevelScope;
  target: ScopeTarget;
  tenantSlug: string;
  domain: Named | null;
  product: Named | null;
}

/** Enterprise (both null), domain (productSlug null) or product level, inside the active tenant. */
export async function resolveLevelRoute(domainSlug: string | null, productSlug: string | null): Promise<LevelRoute | null> {
  if (domainSlug && productSlug) {
    const route = await resolveProductRoute(domainSlug, productSlug);
    if (!route) return null;
    return {
      scope: { tenantId: route.tenantId, domainId: route.domain.id, productId: route.product.id },
      target: { level: "PRODUCT", productId: route.product.id },
      tenantSlug: route.tenantSlug,
      domain: route.domain,
      product: route.product,
    };
  }
  const tenantId = await getActiveTenantId();
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { id: true, slug: true } });
  if (!tenant) return null;
  if (!domainSlug) {
    return {
      scope: { tenantId, domainId: null, productId: null },
      target: { level: "TENANT", tenantId },
      tenantSlug: tenant.slug,
      domain: null,
      product: null,
    };
  }
  const domain = await prisma.domain.findFirst({ where: { slug: domainSlug, tenantId }, select: { id: true, name: true, slug: true } });
  if (!domain) return null;
  return {
    scope: { tenantId, domainId: domain.id, productId: null },
    target: { level: "DOMAIN", domainId: domain.id },
    tenantSlug: tenant.slug,
    domain,
    product: null,
  };
}
```

- [ ] **Step 10: Write the DB integration helper** (`tests/integration/services/events/helpers.ts`)

```ts
import "dotenv/config";
import { PrismaClient } from "@/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { publishEntity } from "@/services/entity-version.service";
import type { Result } from "@/types/result";
import type { ServiceContext } from "@/types/service-context";

export const TENANT = "tenant_default";

export function connectTestDb(): PrismaClient {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
}

export async function testContext(prisma: PrismaClient): Promise<ServiceContext> {
  const user = await prisma.user.findFirstOrThrow();
  return { userId: user.id, userRole: "AUTHOR", prisma };
}

export function unwrap<T>(r: Result<T>): T {
  if (!r.success) throw new Error(`${r.error.code}: ${r.error.message} ${JSON.stringify(r.error.details ?? {})}`);
  return r.data;
}

export function stamp(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export interface TestField {
  name: string;
  type: string;
  /** For reference fields: the referenced entity (also written into the TypeSpec source by name). */
  ref?: { id: string; name: string };
}

/** A fresh domain + product with entity helpers; names carry a unique stamp so line-unique names never collide. */
export async function createProductScope(prisma: PrismaClient, ctx: ServiceContext, label = "evt") {
  const s = stamp();
  const domain = await prisma.domain.create({ data: { name: `${label}-${s}`, slug: `${label}-${s}`, tenantId: TENANT } });
  const product = await prisma.product.create({ data: { domainId: domain.id, name: `${label} ${s}`, slug: `${label}-p-${s}` } });

  async function entity(name: string, fields: TestField[] = [{ name: "id", type: "string" }]) {
    const body = fields.map((f) => `  ${f.name}: ${f.ref ? f.ref.name : f.type};`).join("\n");
    return prisma.entity.create({
      data: {
        name, slug: `${name.toLowerCase()}-${s}`, tenantId: TENANT, domainId: domain.id, productId: product.id,
        ownerId: ctx.userId, typespecSource: `model ${name} {\n${body}\n}\n`,
        fields: {
          create: fields.map((f, i) => ({
            name: f.name, slug: f.name, type: f.ref ? "reference" : f.type, nullable: false, sortOrder: i, fieldNumber: i + 1,
            decorators: f.ref ? { referencedEntityId: f.ref.id, referencedEntityName: f.ref.name } : {},
          })),
        },
      },
    });
  }

  async function publishedEntity(name: string, fields?: TestField[]) {
    const e = await entity(name, fields);
    const version = unwrap(await publishEntity(e.id, {}, ctx));
    return { entity: e, version };
  }

  return { s, domain, product, entity, publishedEntity };
}

/** Remove edge rows (no FKs) for every record under the domains, then cascade-delete the domains (D3). */
export async function cleanupDomains(prisma: PrismaClient, domainIds: Array<string | undefined>): Promise<void> {
  const ids = domainIds.filter((d): d is string => !!d);
  if (ids.length === 0) return;
  const inDomains = { domainId: { in: ids } };
  const [ev, m, mv, s, sv, t] = await Promise.all([
    prisma.entityVersion.findMany({ where: { entity: inDomains }, select: { id: true } }),
    prisma.message.findMany({ where: inDomains, select: { id: true } }),
    prisma.messageVersion.findMany({ where: { message: inDomains }, select: { id: true } }),
    prisma.eventSpec.findMany({ where: inDomains, select: { id: true } }),
    prisma.eventSpecVersion.findMany({ where: { eventSpec: inDomains }, select: { id: true } }),
    prisma.trait.findMany({ where: inDomains, select: { id: true } }),
  ]);
  const idsOf = (rows: Array<{ id: string }>) => rows.map((r) => r.id);
  await prisma.schemaReference.deleteMany({
    where: {
      OR: [
        { fromKind: "ENTITY_VERSION", fromId: { in: idsOf(ev) } },
        { fromKind: "MESSAGE", fromId: { in: idsOf(m) } },
        { fromKind: "MESSAGE_VERSION", fromId: { in: idsOf(mv) } },
        { fromKind: "EVENT_SPEC", fromId: { in: idsOf(s) } },
        { fromKind: "EVENT_SPEC_VERSION", fromId: { in: idsOf(sv) } },
        { fromKind: "TRAIT", fromId: { in: idsOf(t) } },
      ],
    },
  });
  // audit_log rows written by withAudit are immutable by design (trigger) and stay.
  await prisma.domain.deleteMany({ where: { id: { in: ids } } });
}

/** Tenant-level traits live outside any domain; tests delete the ones they create. */
export async function cleanupTenantTraits(prisma: PrismaClient, traitIds: string[]): Promise<void> {
  if (traitIds.length === 0) return;
  await prisma.schemaReference.deleteMany({ where: { fromKind: "TRAIT", fromId: { in: traitIds } } });
  await prisma.trait.deleteMany({ where: { id: { in: traitIds } } });
}
```

- [ ] **Step 11: Write the integration test** (`tests/integration/services/events/foundations.test.ts`)

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import type { ServiceContext } from "@/types/service-context";
import { pinEdges, replaceReferences } from "@/services/events/schema-references";
import { resolvePin } from "@/services/events/pins";
import { cleanupDomains, connectTestDb, createProductScope, TENANT, testContext } from "./helpers";

let prisma: PrismaClient;
let ctx: ServiceContext;
beforeAll(async () => {
  prisma = connectTestDb();
  ctx = await testContext(prisma);
});
afterAll(async () => prisma.$disconnect());

describe("events foundations (DB)", () => {
  it("resolvePin defaults to the latest published version, keeps null, rejects foreign versions", async () => {
    let domainId: string | undefined;
    try {
      const sc = await createProductScope(prisma, ctx);
      domainId = sc.domain.id;
      const order = await sc.publishedEntity("Order");
      const draftOnly = await sc.entity("Draft");

      expect(await resolvePin(prisma, TENANT, { entityId: order.entity.id }, "Payload")).toEqual({
        success: true, data: { entityId: order.entity.id, entityVersionId: order.version.id },
      });
      expect(await resolvePin(prisma, TENANT, { entityId: draftOnly.id }, "Payload")).toEqual({
        success: true, data: { entityId: draftOnly.id, entityVersionId: null },
      });
      expect(await resolvePin(prisma, TENANT, { entityId: order.entity.id, entityVersionId: null }, "Payload")).toMatchObject({
        success: true, data: { entityVersionId: null },
      });
      const foreign = await resolvePin(prisma, TENANT, { entityId: draftOnly.id, entityVersionId: order.version.id }, "Payload");
      expect(!foreign.success && foreign.error.message).toMatch(/is not a published version of Draft/);
      const missing = await resolvePin(prisma, TENANT, { entityId: "nope" }, "Headers");
      expect(!missing.success && missing.error.code).toBe("VALIDATION_ERROR");
    } finally {
      await cleanupDomains(prisma, [domainId]);
    }
  });

  it("replaceReferences rewrites all edges from one record", async () => {
    const fromId = `test-${Date.now()}`;
    try {
      await prisma.$transaction((tx) =>
        replaceReferences(tx, { kind: "MESSAGE", id: fromId }, pinEdges({ payload: "v1", headers: null, key: "v2" }), true)
      );
      let rows = await prisma.schemaReference.findMany({ where: { fromId }, orderBy: { role: "asc" } });
      expect(rows.map((r) => [r.role, r.toId, r.isDraft])).toEqual([["PAYLOAD", "v1", true], ["KEY", "v2", true]]);
      await prisma.$transaction((tx) => replaceReferences(tx, { kind: "MESSAGE", id: fromId }, pinEdges({ payload: "v3" }), true));
      rows = await prisma.schemaReference.findMany({ where: { fromId } });
      expect(rows.map((r) => r.toId)).toEqual(["v3"]);
    } finally {
      await prisma.schemaReference.deleteMany({ where: { fromId } });
    }
  });
});
```

- [ ] **Step 12: Run everything for this task**

Run: `npx vitest run tests/unit/lib/events tests/unit/services/name-registry-events.test.ts tests/unit/services/events tests/integration/services/events/foundations.test.ts tests/unit/services/name-registry.test.ts tests/integration/services/name-registry.test.ts`
Expected: PASS. Then `npx tsc --noEmit` — no errors.

- [ ] **Step 13: Commit**

```bash
git add src/types/action-result.ts src/lib/action-context.ts src/lib/events src/services/name-registry.service.ts src/services/events src/features/events/route-scope.ts tests/unit/lib/events tests/unit/services/name-registry-events.test.ts tests/unit/services/name-registry.test.ts tests/unit/services/events tests/integration/services/events
git commit -m "feat(18.1,18.2): events value types, parsers, registry kinds, reference + audit helpers"
```

---
### Task 3: Channel + Trait services and server actions (Story 18.2) — Wave 1

**Files:**
- Create: `src/services/events/channel.service.ts`, `src/services/events/trait.service.ts`
- Create: `src/app/(dashboard)/schemas/[domainSlug]/[productSlug]/channel-actions.ts`, `src/app/(dashboard)/schemas/trait-actions.ts`
- Test: `tests/integration/services/events/channel.service.test.ts`, `tests/integration/services/events/trait.service.test.ts`, `tests/unit/app/channel-trait-actions.test.ts`

**Interfaces:**

```ts
// channel.service.ts
interface ChannelInput { name: string; address: string | null; protocol: string; format: string; formatDialect?: string | null; spec?: ChannelSpec }
createChannel(productId: string, input: ChannelInput, ctx): Promise<Result<ChannelDetail>>
updateChannel(id: string, input: ChannelInput, owner: ScopeTarget, ctx): Promise<Result<ChannelDetail>>   // full replace
setChannelMessages(id: string, messageIds: string[], owner: ScopeTarget, ctx): Promise<Result<ChannelDetail>>
deleteChannel(id: string, owner: ScopeTarget, ctx): Promise<Result<{ id: string }>>
getChannel(id: string, ctx): Promise<Result<ChannelDetail>>
CHANNEL_SELECT; toChannelDetail(row): ChannelDetail          // read-side reuse (page loaders)
// trait.service.ts
interface TraitInput { name: string; kind: TraitKind; spec?: JsonObject; headers?: PinInput | null }
createTrait(target: ScopeTarget, input: TraitInput, ctx): Promise<Result<TraitDetail>>
updateTrait(id: string, input: Omit<TraitInput, "kind">, owner: ScopeTarget, ctx): Promise<Result<TraitDetail>>  // kind is immutable
deleteTrait(id: string, owner: ScopeTarget, ctx): Promise<Result<{ id: string }>>
getTrait(id: string, ctx): Promise<Result<TraitDetail>>
TRAIT_SELECT; toTraitDetail(row): TraitDetail
// channel-actions.ts ("use server")
createChannelAction(productId, input): Promise<ActionResult<ChannelDetail>>
updateChannelAction(channelId, productId, input): Promise<ActionResult<ChannelDetail>>
setChannelMessagesAction(channelId, productId, messageIds): Promise<ActionResult<ChannelDetail>>
deleteChannelAction(channelId, productId): Promise<ActionResult<{ id: string }>>
// trait-actions.ts ("use server") — a TENANT target always uses the server-resolved active tenant
createTraitAction(target: ScopeTarget, input): Promise<ActionResult<TraitDetail>>
updateTraitAction(traitId, owner: ScopeTarget, input): Promise<ActionResult<TraitDetail>>
deleteTraitAction(traitId, owner: ScopeTarget): Promise<ActionResult<{ id: string }>>
```

- [ ] **Step 1: Write the failing integration tests**

`tests/integration/services/events/channel.service.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import type { ServiceContext } from "@/types/service-context";
import { createChannel, deleteChannel, getChannel, setChannelMessages, updateChannel } from "@/services/events/channel.service";
import { cleanupDomains, connectTestDb, createProductScope, testContext, unwrap } from "./helpers";

let prisma: PrismaClient;
let ctx: ServiceContext;
beforeAll(async () => {
  prisma = connectTestDb();
  ctx = await testContext(prisma);
});
afterAll(async () => prisma.$disconnect());

const base = { address: "payments.orders.v1", protocol: "Kafka", format: "avro", spec: { bindings: { kafka: { partitions: 12 } } } };

describe("channel service", () => {
  it("creates, renames, sets allowed messages and deletes a channel", async () => {
    let domainId: string | undefined;
    try {
      const sc = await createProductScope(prisma, ctx);
      domainId = sc.domain.id;
      const owner = { level: "PRODUCT" as const, productId: sc.product.id };

      const created = unwrap(await createChannel(sc.product.id, { ...base, name: `orders-${sc.s}` }, ctx));
      expect(created).toMatchObject({
        name: `orders-${sc.s}`, protocol: "kafka", format: "avro", formatDialect: null,
        productId: sc.product.id, domainId: sc.domain.id, spec: { bindings: { kafka: { partitions: 12 } } }, allowedMessageIds: [],
      });

      const json = unwrap(await updateChannel(created.id, { ...base, name: `orders2-${sc.s}`, format: "json-schema", formatDialect: null }, owner, ctx));
      expect(json).toMatchObject({ name: `orders2-${sc.s}`, format: "json-schema", formatDialect: "draft-07" });

      const order = await sc.publishedEntity("Order");
      const message = await prisma.message.create({
        data: { name: `OrderCreated-${sc.s}`, payloadEntityId: order.entity.id, tenantId: sc.domain.tenantId, domainId: sc.domain.id, productId: sc.product.id },
      });
      expect(unwrap(await setChannelMessages(created.id, [message.id, message.id], owner, ctx)).allowedMessageIds).toEqual([message.id]);
      const unknown = await setChannelMessages(created.id, ["nope"], owner, ctx);
      expect(!unknown.success && unknown.error.code).toBe("VALIDATION_ERROR");

      expect(unwrap(await deleteChannel(created.id, owner, ctx))).toEqual({ id: created.id });
      expect((await getChannel(created.id, ctx)).success).toBe(false);
    } finally {
      await cleanupDomains(prisma, [domainId]);
    }
  });

  it("rejects line conflicts, invalid profiles and writes from another product (FORBIDDEN)", async () => {
    const domainIds: Array<string | undefined> = [];
    try {
      const checkout = await createProductScope(prisma, ctx, "co");
      const fraud = await createProductScope(prisma, ctx, "fr");
      domainIds.push(checkout.domain.id, fraud.domain.id);
      await checkout.entity(`Orders${checkout.s}`);

      const clash = await createChannel(checkout.product.id, { ...base, name: `orders${checkout.s}` }, ctx);
      expect(!clash.success && clash.error.code).toBe("NAME_CONFLICT");
      const badProfile = await createChannel(checkout.product.id, { ...base, name: `x-${checkout.s}`, formatDialect: "draft-07" }, ctx);
      expect(!badProfile.success && badProfile.error.code).toBe("VALIDATION_ERROR");

      const channel = unwrap(await createChannel(checkout.product.id, { ...base, name: `orders-${checkout.s}` }, ctx));
      const foreign = await updateChannel(channel.id, { ...base, name: channel.name }, { level: "PRODUCT", productId: fraud.product.id }, ctx);
      expect(!foreign.success && foreign.error.code).toBe("FORBIDDEN");
      const foreignDelete = await deleteChannel(channel.id, { level: "PRODUCT", productId: fraud.product.id }, ctx);
      expect(!foreignDelete.success && foreignDelete.error.code).toBe("FORBIDDEN");
    } finally {
      await cleanupDomains(prisma, domainIds);
    }
  });
});
```

`tests/integration/services/events/trait.service.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import type { ServiceContext } from "@/types/service-context";
import { createTrait, deleteTrait, updateTrait } from "@/services/events/trait.service";
import { cleanupDomains, cleanupTenantTraits, connectTestDb, createProductScope, TENANT, testContext, unwrap } from "./helpers";

let prisma: PrismaClient;
let ctx: ServiceContext;
beforeAll(async () => {
  prisma = connectTestDb();
  ctx = await testContext(prisma);
});
afterAll(async () => prisma.$disconnect());

describe("trait service", () => {
  it("creates tenant / domain traits, pins MESSAGE headers (default latest) and mirrors the pin in SchemaReference", async () => {
    let domainId: string | undefined;
    const tenantTraits: string[] = [];
    try {
      const sc = await createProductScope(prisma, ctx);
      domainId = sc.domain.id;
      const headers = await sc.publishedEntity("CloudEventsHeaders");

      const tenantTrait = unwrap(
        await createTrait({ level: "TENANT", tenantId: TENANT }, { name: `CloudEvents-${sc.s}`, kind: "MESSAGE", headers: { entityId: headers.entity.id } }, ctx)
      );
      tenantTraits.push(tenantTrait.id);
      expect(tenantTrait).toMatchObject({ domainId: null, productId: null, headers: { entityId: headers.entity.id, entityVersionId: headers.version.id } });
      const refs = await prisma.schemaReference.findMany({ where: { fromKind: "TRAIT", fromId: tenantTrait.id } });
      expect(refs.map((r) => [r.role, r.toKind, r.toId, r.isDraft])).toEqual([["HEADERS", "ENTITY_VERSION", headers.version.id, false]]);

      const tenantOwner = { level: "TENANT" as const, tenantId: TENANT };
      const cleared = unwrap(await updateTrait(tenantTrait.id, { name: tenantTrait.name, spec: { summary: "CE" }, headers: null }, tenantOwner, ctx));
      expect(cleared).toMatchObject({ headers: null, spec: { summary: "CE" } });
      expect(await prisma.schemaReference.count({ where: { fromKind: "TRAIT", fromId: tenantTrait.id } })).toBe(0);

      const op = unwrap(await createTrait({ level: "DOMAIN", domainId: sc.domain.id }, { name: `Retry-${sc.s}`, kind: "OPERATION", spec: { summary: "r" } }, ctx));
      expect(op).toMatchObject({ kind: "OPERATION", domainId: sc.domain.id, productId: null });
      const badHeaders = await createTrait({ level: "DOMAIN", domainId: sc.domain.id }, { name: `Bad-${sc.s}`, kind: "OPERATION", headers: { entityId: headers.entity.id } }, ctx);
      expect(!badHeaders.success && badHeaders.error.code).toBe("VALIDATION_ERROR");

      const wrongOwner = await deleteTrait(op.id, tenantOwner, ctx);
      expect(!wrongOwner.success && wrongOwner.error.code).toBe("FORBIDDEN");
      expect(unwrap(await deleteTrait(op.id, { level: "DOMAIN", domainId: sc.domain.id }, ctx))).toEqual({ id: op.id });
    } finally {
      await cleanupTenantTraits(prisma, tenantTraits);
      await cleanupDomains(prisma, [domainId]);
    }
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/integration/services/events/channel.service.test.ts tests/integration/services/events/trait.service.test.ts`
Expected: FAIL — `Cannot find module '@/services/events/channel.service'`.

- [ ] **Step 3: Implement `src/services/events/channel.service.ts`**

```ts
import type { Prisma } from "@/generated/prisma/client";
import { resolveScope, type ScopeTarget } from "@/lib/asset-scope";
import type { LevelScope } from "@/lib/levels";
import { normalizeCatalogName, normalizeFormatProfile, normalizeProtocol } from "@/lib/events/inputs";
import { parseChannelSpec, readChannelSpec } from "@/lib/events/catalog-specs";
import { assertOwnedBy } from "@/lib/events/ownership";
import type { ChannelDetail, ChannelSpec, JsonSchemaDialect, PayloadFormat } from "@/lib/events/types";
import { createInScope, writeWithUniqueName } from "@/services/scoped-create.service";
import { auditedWrite } from "@/services/events/audited";
import { ok, err, type Result } from "@/types/result";
import type { ServiceContext } from "@/types/service-context";

export interface ChannelInput {
  name: string;
  address: string | null;
  protocol: string;
  format: string;
  formatDialect?: string | null;
  spec?: ChannelSpec;
}

const CHANNEL_SELECT = {
  id: true, name: true, address: true, protocol: true, format: true, formatDialect: true, spec: true,
  tenantId: true, domainId: true, productId: true,
  messages: { select: { messageId: true }, orderBy: { messageId: "asc" } },
} satisfies Prisma.ChannelSelect;
type ChannelRow = Prisma.ChannelGetPayload<{ select: typeof CHANNEL_SELECT }>;

function toDetail(row: ChannelRow): ChannelDetail {
  return {
    id: row.id, name: row.name, address: row.address, protocol: row.protocol,
    format: row.format as PayloadFormat, formatDialect: (row.formatDialect as JsonSchemaDialect | null) ?? null,
    spec: readChannelSpec(row.spec), tenantId: row.tenantId, domainId: row.domainId, productId: row.productId,
    allowedMessageIds: row.messages.map((m) => m.messageId),
  };
}

interface NormalizedChannel {
  name: string;
  address: string | null;
  protocol: string;
  format: PayloadFormat;
  formatDialect: JsonSchemaDialect | null;
  spec: ChannelSpec;
}

function normalizeChannel(input: ChannelInput): Result<NormalizedChannel> {
  const name = normalizeCatalogName(input.name, "Channel");
  if (!name.success) return name;
  const protocol = normalizeProtocol(input.protocol);
  if (!protocol.success) return protocol;
  const profile = normalizeFormatProfile(input.format, input.formatDialect);
  if (!profile.success) return profile;
  const spec = parseChannelSpec(input.spec ?? {});
  if (!spec.success) return spec;
  const address = input.address?.trim() ? input.address.trim() : null;
  return ok({ name: name.data, address, protocol: protocol.data, ...profile.data, spec: spec.data });
}

function columns(n: NormalizedChannel) {
  return { name: n.name, address: n.address, protocol: n.protocol, format: n.format, formatDialect: n.formatDialect, spec: n.spec as unknown as Prisma.InputJsonValue };
}

async function loadOwned(ctx: ServiceContext, id: string, owner: ScopeTarget): Promise<Result<{ row: ChannelRow; scope: LevelScope }>> {
  const scope = await resolveScope(ctx.prisma, owner);
  if (!scope.success) return scope;
  const row = await ctx.prisma.channel.findUnique({ where: { id }, select: CHANNEL_SELECT });
  if (!row) return err({ code: "NOT_FOUND", message: `Channel "${id}" not found` });
  const owned = assertOwnedBy(row, scope.data, `Channel "${row.name}"`);
  if (!owned.success) return owned;
  return ok({ row, scope: scope.data });
}

export async function createChannel(productId: string, input: ChannelInput, ctx: ServiceContext): Promise<Result<ChannelDetail>> {
  const n = normalizeChannel(input);
  if (!n.success) return n;
  return auditedWrite({
    action: "CREATE", entityType: "Channel", entityId: "pending", userId: ctx.userId,
    run: async () => {
      const created = await createInScope(ctx.prisma, {
        kind: "channel",
        target: { level: "PRODUCT", productId },
        name: n.data.name,
        write: (tx, scope) => tx.channel.create({ data: { ...columns(n.data), ...scope }, select: CHANNEL_SELECT }),
      });
      return created.success ? ok(toDetail(created.data)) : created;
    },
  });
}

export async function updateChannel(id: string, input: ChannelInput, owner: ScopeTarget, ctx: ServiceContext): Promise<Result<ChannelDetail>> {
  const n = normalizeChannel(input);
  if (!n.success) return n;
  const owned = await loadOwned(ctx, id, owner);
  if (!owned.success) return owned;
  return auditedWrite({
    action: "UPDATE", entityType: "Channel", entityId: id, userId: ctx.userId, beforeState: toDetail(owned.data.row),
    run: () =>
      writeWithUniqueName(ctx.prisma, {
        scope: owned.data.scope,
        name: n.data.name,
        exclude: { kind: "channel", id },
        write: async (tx) => toDetail(await tx.channel.update({ where: { id }, data: columns(n.data), select: CHANNEL_SELECT })),
      }),
  });
}

export async function setChannelMessages(id: string, messageIds: string[], owner: ScopeTarget, ctx: ServiceContext): Promise<Result<ChannelDetail>> {
  const owned = await loadOwned(ctx, id, owner);
  if (!owned.success) return owned;
  const unique = [...new Set(messageIds)];
  const found = await ctx.prisma.message.findMany({ where: { id: { in: unique }, tenantId: owned.data.row.tenantId }, select: { id: true } });
  const missing = unique.filter((m) => !found.some((f) => f.id === m));
  if (missing.length > 0) {
    return err({ code: "VALIDATION_ERROR", message: `Unknown message(s): ${missing.join(", ")}`, details: { problems: missing.map((m) => `Message "${m}" not found`) } });
  }
  return auditedWrite({
    action: "UPDATE", entityType: "Channel", entityId: id, userId: ctx.userId, beforeState: toDetail(owned.data.row),
    run: async () =>
      ok(
        toDetail(
          await ctx.prisma.$transaction(async (tx) => {
            await tx.channelMessage.deleteMany({ where: { channelId: id } });
            if (unique.length > 0) await tx.channelMessage.createMany({ data: unique.map((messageId) => ({ channelId: id, messageId })) });
            return tx.channel.findUniqueOrThrow({ where: { id }, select: CHANNEL_SELECT });
          })
        )
      ),
  });
}

export async function deleteChannel(id: string, owner: ScopeTarget, ctx: ServiceContext): Promise<Result<{ id: string }>> {
  const owned = await loadOwned(ctx, id, owner);
  if (!owned.success) return owned;
  return auditedWrite({
    action: "DELETE", entityType: "Channel", entityId: id, userId: ctx.userId, beforeState: toDetail(owned.data.row),
    run: async () => {
      await ctx.prisma.channel.delete({ where: { id } });
      return ok({ id });
    },
  });
}

export async function getChannel(id: string, ctx: ServiceContext): Promise<Result<ChannelDetail>> {
  const row = await ctx.prisma.channel.findUnique({ where: { id }, select: CHANNEL_SELECT });
  return row ? ok(toDetail(row)) : err({ code: "NOT_FOUND", message: `Channel "${id}" not found` });
}

/** Read-side reuse by the page loaders (Task 15). */
export { CHANNEL_SELECT, toDetail as toChannelDetail };
```

- [ ] **Step 4: Implement `src/services/events/trait.service.ts`**

```ts
import type { Prisma } from "@/generated/prisma/client";
import { resolveScope, type ScopeTarget } from "@/lib/asset-scope";
import type { LevelScope } from "@/lib/levels";
import { isJsonObject, normalizeCatalogName } from "@/lib/events/inputs";
import { assertOwnedBy } from "@/lib/events/ownership";
import type { EntityPin, JsonObject, TraitDetail, TraitKind } from "@/lib/events/types";
import { createInScope, writeWithUniqueName } from "@/services/scoped-create.service";
import { auditedWrite } from "@/services/events/audited";
import { resolvePin, type PinInput } from "@/services/events/pins";
import { deleteReferencesFrom, pinEdges, replaceReferences } from "@/services/events/schema-references";
import { ok, err, type Result } from "@/types/result";
import type { ServiceContext } from "@/types/service-context";

export interface TraitInput {
  name: string;
  kind: TraitKind;
  spec?: JsonObject;
  headers?: PinInput | null;
}

const TRAIT_SELECT = {
  id: true, name: true, kind: true, spec: true, headersEntityId: true, headersEntityVersionId: true,
  tenantId: true, domainId: true, productId: true,
} satisfies Prisma.TraitSelect;
type TraitRow = Prisma.TraitGetPayload<{ select: typeof TRAIT_SELECT }>;

function toDetail(row: TraitRow): TraitDetail {
  return {
    id: row.id, name: row.name, kind: row.kind, spec: isJsonObject(row.spec) ? row.spec : {},
    headers: row.headersEntityId ? { entityId: row.headersEntityId, entityVersionId: row.headersEntityVersionId } : null,
    tenantId: row.tenantId, domainId: row.domainId, productId: row.productId,
  };
}

interface NormalizedTrait {
  name: string;
  spec: JsonObject;
  headers: EntityPin | null;
}

async function normalizeTrait(ctx: ServiceContext, tenantId: string, kind: TraitKind, input: Omit<TraitInput, "kind">): Promise<Result<NormalizedTrait>> {
  const name = normalizeCatalogName(input.name, "Trait");
  if (!name.success) return name;
  if (input.spec !== undefined && !isJsonObject(input.spec)) return err({ code: "VALIDATION_ERROR", message: "Trait spec must be a JSON object" });
  if (input.headers && kind !== "MESSAGE") {
    return err({ code: "VALIDATION_ERROR", message: "Only MESSAGE traits can carry a headers entity", suggestedFix: "Remove the headers entity or create a MESSAGE trait." });
  }
  let headers: EntityPin | null = null;
  if (input.headers) {
    const pin = await resolvePin(ctx.prisma, tenantId, input.headers, "Headers");
    if (!pin.success) return pin;
    headers = pin.data;
  }
  return ok({ name: name.data, spec: input.spec ?? {}, headers });
}

function columns(n: NormalizedTrait) {
  return {
    name: n.name, spec: n.spec as Prisma.InputJsonValue,
    headersEntityId: n.headers?.entityId ?? null, headersEntityVersionId: n.headers?.entityVersionId ?? null,
  };
}

const headerEdges = (n: NormalizedTrait) => pinEdges({ headers: n.headers?.entityVersionId ?? null });

async function loadOwned(ctx: ServiceContext, id: string, owner: ScopeTarget): Promise<Result<{ row: TraitRow; scope: LevelScope }>> {
  const scope = await resolveScope(ctx.prisma, owner);
  if (!scope.success) return scope;
  const row = await ctx.prisma.trait.findUnique({ where: { id }, select: TRAIT_SELECT });
  if (!row) return err({ code: "NOT_FOUND", message: `Trait "${id}" not found` });
  const owned = assertOwnedBy(row, scope.data, `Trait "${row.name}"`);
  if (!owned.success) return owned;
  return ok({ row, scope: scope.data });
}

export async function createTrait(target: ScopeTarget, input: TraitInput, ctx: ServiceContext): Promise<Result<TraitDetail>> {
  if (input.kind !== "MESSAGE" && input.kind !== "OPERATION") return err({ code: "VALIDATION_ERROR", message: "Trait kind must be MESSAGE or OPERATION" });
  const scope = await resolveScope(ctx.prisma, target);
  if (!scope.success) return scope;
  const n = await normalizeTrait(ctx, scope.data.tenantId, input.kind, input);
  if (!n.success) return n;
  return auditedWrite({
    action: "CREATE", entityType: "Trait", entityId: "pending", userId: ctx.userId,
    run: async () => {
      const created = await createInScope(ctx.prisma, {
        kind: "trait",
        target,
        name: n.data.name,
        write: async (tx, s) => {
          const row = await tx.trait.create({ data: { kind: input.kind, ...columns(n.data), ...s }, select: TRAIT_SELECT });
          await replaceReferences(tx, { kind: "TRAIT", id: row.id }, headerEdges(n.data), false);
          return row;
        },
      });
      return created.success ? ok(toDetail(created.data)) : created;
    },
  });
}

export async function updateTrait(id: string, input: Omit<TraitInput, "kind">, owner: ScopeTarget, ctx: ServiceContext): Promise<Result<TraitDetail>> {
  const owned = await loadOwned(ctx, id, owner);
  if (!owned.success) return owned;
  const n = await normalizeTrait(ctx, owned.data.row.tenantId, owned.data.row.kind, input);
  if (!n.success) return n;
  return auditedWrite({
    action: "UPDATE", entityType: "Trait", entityId: id, userId: ctx.userId, beforeState: toDetail(owned.data.row),
    run: () =>
      writeWithUniqueName(ctx.prisma, {
        scope: owned.data.scope,
        name: n.data.name,
        exclude: { kind: "trait", id },
        write: async (tx) => {
          const row = await tx.trait.update({ where: { id }, data: columns(n.data), select: TRAIT_SELECT });
          await replaceReferences(tx, { kind: "TRAIT", id }, headerEdges(n.data), false);
          return toDetail(row);
        },
      }),
  });
}

export async function deleteTrait(id: string, owner: ScopeTarget, ctx: ServiceContext): Promise<Result<{ id: string }>> {
  const owned = await loadOwned(ctx, id, owner);
  if (!owned.success) return owned;
  return auditedWrite({
    action: "DELETE", entityType: "Trait", entityId: id, userId: ctx.userId, beforeState: toDetail(owned.data.row),
    run: async () => {
      await ctx.prisma.$transaction(async (tx) => {
        await deleteReferencesFrom(tx, "TRAIT", [id]);
        await tx.trait.delete({ where: { id } });
      });
      return ok({ id });
    },
  });
}

export async function getTrait(id: string, ctx: ServiceContext): Promise<Result<TraitDetail>> {
  const row = await ctx.prisma.trait.findUnique({ where: { id }, select: TRAIT_SELECT });
  return row ? ok(toDetail(row)) : err({ code: "NOT_FOUND", message: `Trait "${id}" not found` });
}

/** Read-side reuse by the page loaders (Task 15). */
export { TRAIT_SELECT, toDetail as toTraitDetail };
```

- [ ] **Step 5: Run the integration tests**

Run: `npx vitest run tests/integration/services/events/channel.service.test.ts tests/integration/services/events/trait.service.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Write the failing action tests** (`tests/unit/app/channel-trait-actions.test.ts`)

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  auth: vi.fn(),
  revalidatePath: vi.fn(),
  getActiveTenantId: vi.fn(),
  createChannel: vi.fn(),
  updateChannel: vi.fn(),
  setChannelMessages: vi.fn(),
  deleteChannel: vi.fn(),
  createTrait: vi.fn(),
  updateTrait: vi.fn(),
  deleteTrait: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ prisma: { tag: "prisma" } }));
vi.mock("@/lib/auth", () => ({ auth: h.auth }));
vi.mock("next/cache", () => ({ revalidatePath: h.revalidatePath }));
vi.mock("@/lib/active-tenant", () => ({ getActiveTenantId: h.getActiveTenantId }));
vi.mock("@/services/rbac.service", () => ({ getEffectiveRole: vi.fn().mockResolvedValue({ success: true, data: "AUTHOR" }) }));
vi.mock("@/services/events/channel.service", () => ({
  createChannel: h.createChannel, updateChannel: h.updateChannel, setChannelMessages: h.setChannelMessages, deleteChannel: h.deleteChannel,
}));
vi.mock("@/services/events/trait.service", () => ({ createTrait: h.createTrait, updateTrait: h.updateTrait, deleteTrait: h.deleteTrait }));

import {
  createChannelAction,
  deleteChannelAction,
  setChannelMessagesAction,
  updateChannelAction,
} from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/channel-actions";
import { createTraitAction, deleteTraitAction, updateTraitAction } from "@/app/(dashboard)/schemas/trait-actions";

const CTX = { userId: "user-1", userRole: "AUTHOR", prisma: { tag: "prisma" } };
const INPUT = { name: "orders", address: "a", protocol: "kafka", format: "avro" };
const OK = { success: true, data: { id: "c1" } };
const FAIL = { success: false, error: { code: "FORBIDDEN", message: "read-only", details: { x: 1 } } };

beforeEach(() => {
  vi.clearAllMocks();
  h.auth.mockResolvedValue({ user: { id: "user-1" } });
  h.getActiveTenantId.mockResolvedValue("tenant-active");
});

describe("channel actions", () => {
  it("rejects unauthenticated calls without touching the service", async () => {
    h.auth.mockResolvedValue(null);
    expect(await createChannelAction("p1", INPUT)).toEqual({ success: false, error: "Not authenticated", code: "UNAUTHORIZED" });
    expect(h.createChannel).not.toHaveBeenCalled();
  });

  it("passes the product owner target and revalidates the /schemas layout on success", async () => {
    for (const fn of [h.createChannel, h.updateChannel, h.setChannelMessages, h.deleteChannel]) fn.mockResolvedValue(OK);
    expect(await createChannelAction("p1", INPUT)).toEqual({ success: true, data: { id: "c1" } });
    expect(h.createChannel).toHaveBeenCalledWith("p1", INPUT, CTX);
    await updateChannelAction("c1", "p1", INPUT);
    expect(h.updateChannel).toHaveBeenCalledWith("c1", INPUT, { level: "PRODUCT", productId: "p1" }, CTX);
    await setChannelMessagesAction("c1", "p1", ["m1"]);
    expect(h.setChannelMessages).toHaveBeenCalledWith("c1", ["m1"], { level: "PRODUCT", productId: "p1" }, CTX);
    await deleteChannelAction("c1", "p1");
    expect(h.revalidatePath.mock.calls).toEqual(Array(4).fill(["/schemas", "layout"]));
  });

  it("returns service errors with code + details and does not revalidate", async () => {
    h.updateChannel.mockResolvedValue(FAIL);
    expect(await updateChannelAction("c1", "p2", INPUT)).toEqual({ success: false, error: "read-only", code: "FORBIDDEN", details: { x: 1 } });
    expect(h.revalidatePath).not.toHaveBeenCalled();
  });
});

describe("trait actions", () => {
  it("never trusts a client tenant id for TENANT targets", async () => {
    h.createTrait.mockResolvedValue(OK);
    h.updateTrait.mockResolvedValue(OK);
    h.deleteTrait.mockResolvedValue(OK);
    const input = { name: "CloudEvents", kind: "MESSAGE" as const };
    await createTraitAction({ level: "TENANT", tenantId: "spoofed" }, input);
    expect(h.createTrait).toHaveBeenCalledWith({ level: "TENANT", tenantId: "tenant-active" }, input, CTX);
    await updateTraitAction("t1", { level: "TENANT", tenantId: "spoofed" }, { name: "CloudEvents" });
    expect(h.updateTrait).toHaveBeenCalledWith("t1", { name: "CloudEvents" }, { level: "TENANT", tenantId: "tenant-active" }, CTX);
    await deleteTraitAction("t1", { level: "DOMAIN", domainId: "d1" });
    expect(h.deleteTrait).toHaveBeenCalledWith("t1", { level: "DOMAIN", domainId: "d1" }, CTX);
    expect(h.revalidatePath).toHaveBeenCalledTimes(3);
  });
});
```

- [ ] **Step 7: Run to verify failure**

Run: `npx vitest run tests/unit/app/channel-trait-actions.test.ts`
Expected: FAIL — `Cannot find module '.../channel-actions'`.

- [ ] **Step 8: Implement the actions**

```ts
// src/app/(dashboard)/schemas/[domainSlug]/[productSlug]/channel-actions.ts
"use server";

import { revalidatePath } from "next/cache";
import { getActionContext, NOT_AUTHENTICATED, toActionResult } from "@/lib/action-context";
import {
  createChannel, deleteChannel, setChannelMessages, updateChannel, type ChannelInput,
} from "@/services/events/channel.service";
import type { ChannelDetail } from "@/lib/events/types";
import type { ActionResult } from "@/types/action-result";
import type { Result } from "@/types/result";

async function mutate<T>(run: (ctx: NonNullable<Awaited<ReturnType<typeof getActionContext>>>) => Promise<Result<T>>): Promise<ActionResult<T>> {
  const ctx = await getActionContext();
  if (!ctx) return NOT_AUTHENTICATED;
  const result = await run(ctx);
  if (result.success) revalidatePath("/schemas", "layout");
  return toActionResult(result);
}

const productOwner = (productId: string) => ({ level: "PRODUCT" as const, productId });

export async function createChannelAction(productId: string, input: ChannelInput): Promise<ActionResult<ChannelDetail>> {
  return mutate((ctx) => createChannel(productId, input, ctx));
}

export async function updateChannelAction(channelId: string, productId: string, input: ChannelInput): Promise<ActionResult<ChannelDetail>> {
  return mutate((ctx) => updateChannel(channelId, input, productOwner(productId), ctx));
}

export async function setChannelMessagesAction(channelId: string, productId: string, messageIds: string[]): Promise<ActionResult<ChannelDetail>> {
  return mutate((ctx) => setChannelMessages(channelId, messageIds, productOwner(productId), ctx));
}

export async function deleteChannelAction(channelId: string, productId: string): Promise<ActionResult<{ id: string }>> {
  return mutate((ctx) => deleteChannel(channelId, productOwner(productId), ctx));
}
```

```ts
// src/app/(dashboard)/schemas/trait-actions.ts
"use server";

import { revalidatePath } from "next/cache";
import { getActiveTenantId } from "@/lib/active-tenant";
import { getActionContext, NOT_AUTHENTICATED, toActionResult } from "@/lib/action-context";
import type { ScopeTarget } from "@/lib/asset-scope";
import { createTrait, deleteTrait, updateTrait, type TraitInput } from "@/services/events/trait.service";
import type { TraitDetail } from "@/lib/events/types";
import type { ActionResult } from "@/types/action-result";
import type { Result } from "@/types/result";

/** A TENANT target is always the server-resolved active tenant (same rule as data types). */
async function serverTarget(target: ScopeTarget): Promise<ScopeTarget> {
  return target.level === "TENANT" ? { level: "TENANT", tenantId: await getActiveTenantId() } : target;
}

async function mutate<T>(run: (ctx: NonNullable<Awaited<ReturnType<typeof getActionContext>>>) => Promise<Result<T>>): Promise<ActionResult<T>> {
  const ctx = await getActionContext();
  if (!ctx) return NOT_AUTHENTICATED;
  const result = await run(ctx);
  if (result.success) revalidatePath("/schemas", "layout");
  return toActionResult(result);
}

export async function createTraitAction(target: ScopeTarget, input: TraitInput): Promise<ActionResult<TraitDetail>> {
  return mutate(async (ctx) => createTrait(await serverTarget(target), input, ctx));
}

export async function updateTraitAction(traitId: string, owner: ScopeTarget, input: Omit<TraitInput, "kind">): Promise<ActionResult<TraitDetail>> {
  return mutate(async (ctx) => updateTrait(traitId, input, await serverTarget(owner), ctx));
}

export async function deleteTraitAction(traitId: string, owner: ScopeTarget): Promise<ActionResult<{ id: string }>> {
  return mutate(async (ctx) => deleteTrait(traitId, await serverTarget(owner), ctx));
}
```

- [ ] **Step 9: Run the task's tests + type check**

Run: `npx vitest run tests/unit/app/channel-trait-actions.test.ts tests/integration/services/events/channel.service.test.ts tests/integration/services/events/trait.service.test.ts && npx tsc --noEmit`
Expected: PASS; no type errors.

- [ ] **Step 10: Commit**

```bash
git add src/services/events/channel.service.ts src/services/events/trait.service.ts "src/app/(dashboard)/schemas/[domainSlug]/[productSlug]/channel-actions.ts" "src/app/(dashboard)/schemas/trait-actions.ts" tests/integration/services/events/channel.service.test.ts tests/integration/services/events/trait.service.test.ts tests/unit/app/channel-trait-actions.test.ts
git commit -m "feat(18.2): channel and trait services + server actions (owner checks, line-unique names, audit)"
```

---

### Task 4: Message + Event Spec draft services and server actions (Story 18.2) — Wave 1

**Files:**
- Create: `src/services/events/message.service.ts`, `src/services/events/event-spec.service.ts`
- Create: `src/app/(dashboard)/schemas/[domainSlug]/[productSlug]/message-actions.ts`, `src/app/(dashboard)/schemas/[domainSlug]/[productSlug]/event-spec-actions.ts`
- Test: `tests/integration/services/events/message.service.test.ts`, `tests/integration/services/events/event-spec.service.test.ts`, `tests/unit/app/message-event-spec-actions.test.ts`

**Interfaces:**

```ts
// message.service.ts
interface MessageInput { name: string; spec?: MessageSpec; payload: PinInput; headers?: PinInput | null; key?: PinInput | null }
createMessage(productId, input: MessageInput, ctx): Promise<Result<MessageDetail>>
updateMessage(id, input: MessageInput, owner: ScopeTarget, ctx): Promise<Result<MessageDetail>>   // full replace; marks the draft dirty
deleteMessage(id, owner, ctx): Promise<Result<{ id: string }>>   // IN_USE when a version is pinned by a published spec version
getMessage(id, ctx): Promise<Result<MessageDetail>>
MESSAGE_SELECT; toMessageDetail(row): MessageDetail
// event-spec.service.ts
interface CreateEventSpecInput { name: string; title?: string; description?: string }
createEventSpec(productId, input, ctx): Promise<Result<EventSpecDetail>>
updateEventSpecDocument(id, document: unknown, owner, ctx): Promise<Result<EventSpecDetail>>   // VALIDATION_ERROR details.problems: DocumentProblem[]
renameEventSpec(id, name: string, owner, ctx): Promise<Result<EventSpecDetail>>
deleteEventSpec(id, owner, ctx): Promise<Result<{ id: string }>>
getEventSpec(id, ctx): Promise<Result<EventSpecDetail>>
SPEC_SELECT; toEventSpecDetail(row): Result<EventSpecDetail>
// message-actions.ts / event-spec-actions.ts ("use server") — same names with an "Action" suffix,
// owner = { level: "PRODUCT", productId } passed as the second argument for update/rename/delete.
```

- [ ] **Step 1: Write the failing integration tests**

`tests/integration/services/events/message.service.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import type { ServiceContext } from "@/types/service-context";
import { createMessage, deleteMessage, updateMessage } from "@/services/events/message.service";
import { createTrait } from "@/services/events/trait.service";
import { cleanupDomains, connectTestDb, createProductScope, testContext, unwrap } from "./helpers";

let prisma: PrismaClient;
let ctx: ServiceContext;
beforeAll(async () => {
  prisma = connectTestDb();
  ctx = await testContext(prisma);
});
afterAll(async () => prisma.$disconnect());

const draftRefs = (fromId: string) =>
  prisma.schemaReference.findMany({ where: { fromKind: "MESSAGE", fromId }, orderBy: { role: "asc" } }).then((rows) => rows.map((r) => [r.role, r.toId, r.isDraft]));

describe("message service", () => {
  it("creates with default-latest pins, mirrors draft refs, re-pins and checks traits", async () => {
    const domainIds: Array<string | undefined> = [];
    try {
      const sc = await createProductScope(prisma, ctx);
      const other = await createProductScope(prisma, ctx, "oth");
      domainIds.push(sc.domain.id, other.domain.id);
      const owner = { level: "PRODUCT" as const, productId: sc.product.id };
      const order = await sc.publishedEntity("Order");
      const key = await sc.entity("OrderKey");
      const trait = unwrap(await createTrait({ level: "DOMAIN", domainId: sc.domain.id }, { name: `CE-${sc.s}`, kind: "MESSAGE" }, ctx));
      const foreignTrait = unwrap(await createTrait({ level: "DOMAIN", domainId: other.domain.id }, { name: `CE2-${other.s}`, kind: "MESSAGE" }, ctx));

      const m = unwrap(
        await createMessage(sc.product.id, {
          name: `OrderCreated-${sc.s}`,
          spec: { contentType: "avro/binary", traitIds: [trait.id] },
          payload: { entityId: order.entity.id },
          key: { entityId: key.id },
        }, ctx)
      );
      expect(m).toMatchObject({
        payload: { entityId: order.entity.id, entityVersionId: order.version.id },
        key: { entityId: key.id, entityVersionId: null },
        headers: null, hasUnpublishedChanges: true, latestVersionLabel: null,
      });
      expect(await draftRefs(m.id)).toEqual([["PAYLOAD", order.version.id, true]]);

      const unpinned = unwrap(await updateMessage(m.id, { name: m.name, spec: m.spec, payload: { entityId: order.entity.id, entityVersionId: null } }, owner, ctx));
      expect(unpinned.payload.entityVersionId).toBeNull();
      expect(unpinned.key).toBeNull();
      expect(await draftRefs(m.id)).toEqual([]);

      const badTrait = await updateMessage(m.id, { name: m.name, spec: { traitIds: [foreignTrait.id] }, payload: { entityId: order.entity.id } }, owner, ctx);
      expect(!badTrait.success && badTrait.error.code).toBe("VALIDATION_ERROR");
      expect(!badTrait.success && JSON.stringify(badTrait.error.details)).toMatch(/not visible/);

      const foreign = await updateMessage(m.id, { name: m.name, payload: { entityId: order.entity.id } }, { level: "PRODUCT", productId: other.product.id }, ctx);
      expect(!foreign.success && foreign.error.code).toBe("FORBIDDEN");
    } finally {
      await cleanupDomains(prisma, domainIds);
    }
  });

  it("refuses to delete a message whose version is pinned by a published spec version", async () => {
    let domainId: string | undefined;
    try {
      const sc = await createProductScope(prisma, ctx);
      domainId = sc.domain.id;
      const owner = { level: "PRODUCT" as const, productId: sc.product.id };
      const order = await sc.publishedEntity("Order");
      const m = unwrap(await createMessage(sc.product.id, { name: `OrderCreated-${sc.s}`, payload: { entityId: order.entity.id } }, ctx));
      const mv = await prisma.messageVersion.create({
        data: { messageId: m.id, major: 1, minor: 0, sequence: 1, resolvedSpec: {}, payloadEntityVersionId: order.version.id, changeKind: "INITIAL", publishedById: ctx.userId },
      });
      await prisma.schemaReference.create({ data: { fromKind: "EVENT_SPEC_VERSION", fromId: `esv-${sc.s}`, role: "MESSAGE", toKind: "MESSAGE_VERSION", toId: mv.id } });

      const blocked = await deleteMessage(m.id, owner, ctx);
      expect(!blocked.success && blocked.error.code).toBe("IN_USE");

      await prisma.schemaReference.deleteMany({ where: { fromId: `esv-${sc.s}` } });
      expect(unwrap(await deleteMessage(m.id, owner, ctx))).toEqual({ id: m.id });
      expect(await prisma.messageVersion.count({ where: { id: mv.id } })).toBe(0);
    } finally {
      await cleanupDomains(prisma, [domainId]);
    }
  });
});
```

`tests/integration/services/events/event-spec.service.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import type { ServiceContext } from "@/types/service-context";
import { createEventSpec, deleteEventSpec, renameEventSpec, updateEventSpecDocument } from "@/services/events/event-spec.service";
import { createChannel } from "@/services/events/channel.service";
import { createMessage } from "@/services/events/message.service";
import { cleanupDomains, connectTestDb, createProductScope, testContext, unwrap } from "./helpers";

let prisma: PrismaClient;
let ctx: ServiceContext;
beforeAll(async () => {
  prisma = connectTestDb();
  ctx = await testContext(prisma);
});
afterAll(async () => prisma.$disconnect());

describe("event spec service", () => {
  it("validates references, accepts cross-product channels + versions and own drafts, mirrors EVENT_SPEC refs", async () => {
    const domainIds: Array<string | undefined> = [];
    try {
      const checkout = await createProductScope(prisma, ctx, "co");
      const fraud = await createProductScope(prisma, ctx, "fr");
      domainIds.push(checkout.domain.id, fraud.domain.id);
      const order = await checkout.publishedEntity("Order");
      const channel = unwrap(await createChannel(checkout.product.id, { name: `orders-${checkout.s}`, address: "payments.orders.v1", protocol: "kafka", format: "avro" }, ctx));
      const msg = unwrap(await createMessage(checkout.product.id, { name: `OrderCreated-${checkout.s}`, payload: { entityId: order.entity.id } }, ctx));
      const mv = await prisma.messageVersion.create({
        data: { messageId: msg.id, major: 1, minor: 0, sequence: 1, resolvedSpec: {}, payloadEntityVersionId: order.version.id, changeKind: "INITIAL", publishedById: ctx.userId },
      });

      const spec = unwrap(await createEventSpec(fraud.product.id, { name: `fraud-scorer-${fraud.s}`, title: "fraud-scorer" }, ctx));
      expect(spec).toMatchObject({ specType: "asyncapi@3.0", document: { info: { title: "fraud-scorer" }, servers: [], operations: [] }, hasUnpublishedChanges: true });
      const owner = { level: "PRODUCT" as const, productId: fraud.product.id };

      const unknown = await updateEventSpecDocument(spec.id, {
        info: { title: "fraud-scorer" }, servers: [],
        operations: [{ key: "consume", action: "receive", channelId: "nope", messageVersionIds: [msg.id], traitIds: ["t-missing"] }],
      }, owner, ctx);
      expect(!unknown.success && (unknown.error.details as { problems: unknown[] }).problems).toEqual([
        { pointer: "/operations/0/channelId", message: 'Channel "nope" not found' },
        { pointer: "/operations/0/messageVersionIds/0", message: `"${msg.id}" is neither a message version nor a message draft of this product` },
        { pointer: "/operations/0/traitIds/0", message: 'Trait "t-missing" not found' },
      ]);

      const saved = unwrap(await updateEventSpecDocument(spec.id, {
        info: { title: "fraud-scorer" }, servers: [{ key: "kafka-prod", protocol: "kafka", host: "kafka:9092" }],
        operations: [{ key: "consumeOrderCreated", action: "receive", channelId: channel.id, messageVersionIds: [mv.id], traitIds: [] }],
      }, owner, ctx));
      expect(saved.document.operations[0].channelId).toBe(channel.id);
      const refs = await prisma.schemaReference.findMany({ where: { fromKind: "EVENT_SPEC", fromId: spec.id } });
      expect(refs.map((r) => [r.role, r.toKind, r.toId, r.isDraft])).toEqual([["MESSAGE", "MESSAGE_VERSION", mv.id, true]]);

      const checkoutSpec = unwrap(await createEventSpec(checkout.product.id, { name: `checkout-service-${checkout.s}` }, ctx));
      const withDraft = await updateEventSpecDocument(checkoutSpec.id, {
        info: { title: "checkout-service" }, servers: [],
        operations: [{ key: "publish", action: "send", channelId: channel.id, messageVersionIds: [msg.id], traitIds: [] }],
      }, { level: "PRODUCT", productId: checkout.product.id }, ctx);
      expect(withDraft.success).toBe(true);
      expect(await prisma.schemaReference.count({ where: { fromKind: "EVENT_SPEC", fromId: checkoutSpec.id } })).toBe(0);

      const renamed = unwrap(await renameEventSpec(spec.id, `fraud-scorer-v2-${fraud.s}`, owner, ctx));
      expect(renamed.name).toBe(`fraud-scorer-v2-${fraud.s}`);
      expect(unwrap(await deleteEventSpec(spec.id, owner, ctx))).toEqual({ id: spec.id });
      expect(await prisma.schemaReference.count({ where: { fromKind: "EVENT_SPEC", fromId: spec.id } })).toBe(0);
    } finally {
      await cleanupDomains(prisma, domainIds);
    }
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/integration/services/events/message.service.test.ts tests/integration/services/events/event-spec.service.test.ts`
Expected: FAIL — `Cannot find module '@/services/events/message.service'`.

- [ ] **Step 3: Implement `src/services/events/message.service.ts`**

```ts
import type { Prisma } from "@/generated/prisma/client";
import { resolveScope, type ScopeTarget } from "@/lib/asset-scope";
import type { LevelScope } from "@/lib/levels";
import { formatVersionLabel } from "@/lib/entity-versioning/version-math";
import { normalizeCatalogName } from "@/lib/events/inputs";
import { parseMessageSpec, readMessageSpec } from "@/lib/events/catalog-specs";
import { assertOwnedBy } from "@/lib/events/ownership";
import type { EntityPin, MessageDetail, MessageSpec } from "@/lib/events/types";
import { inSameLine } from "@/services/name-registry.service";
import { createInScope, writeWithUniqueName } from "@/services/scoped-create.service";
import { auditedWrite } from "@/services/events/audited";
import { resolvePin, type PinInput } from "@/services/events/pins";
import { deleteReferencesFrom, pinEdges, replaceReferences } from "@/services/events/schema-references";
import { ok, err, type Result } from "@/types/result";
import type { ServiceContext } from "@/types/service-context";

export interface MessageInput {
  name: string;
  spec?: MessageSpec;
  payload: PinInput;
  headers?: PinInput | null;
  key?: PinInput | null;
}

const MESSAGE_SELECT = {
  id: true, name: true, spec: true, hasUnpublishedChanges: true, tenantId: true, domainId: true, productId: true,
  payloadEntityId: true, payloadEntityVersionId: true, headersEntityId: true, headersEntityVersionId: true,
  keyEntityId: true, keyEntityVersionId: true,
  latestVersion: { select: { major: true, minor: true } },
} satisfies Prisma.MessageSelect;
type MessageRow = Prisma.MessageGetPayload<{ select: typeof MESSAGE_SELECT }>;

const pinOf = (entityId: string | null, entityVersionId: string | null): EntityPin | null =>
  entityId ? { entityId, entityVersionId } : null;

function toDetail(row: MessageRow): MessageDetail {
  return {
    id: row.id, name: row.name, spec: readMessageSpec(row.spec),
    payload: { entityId: row.payloadEntityId, entityVersionId: row.payloadEntityVersionId },
    headers: pinOf(row.headersEntityId, row.headersEntityVersionId),
    key: pinOf(row.keyEntityId, row.keyEntityVersionId),
    latestVersionLabel: row.latestVersion ? formatVersionLabel(row.latestVersion) : null,
    hasUnpublishedChanges: row.hasUnpublishedChanges,
    tenantId: row.tenantId, domainId: row.domainId, productId: row.productId,
  };
}

interface NormalizedMessage {
  name: string;
  spec: MessageSpec;
  payload: EntityPin;
  headers: EntityPin | null;
  key: EntityPin | null;
}

async function normalizeMessage(ctx: ServiceContext, scope: LevelScope, input: MessageInput): Promise<Result<NormalizedMessage>> {
  const name = normalizeCatalogName(input.name, "Message");
  if (!name.success) return name;
  const spec = parseMessageSpec(input.spec ?? { traitIds: [] });
  if (!spec.success) return spec;

  const problems: string[] = [];
  const pin = async (value: PinInput | null | undefined, label: string): Promise<EntityPin | null> => {
    if (!value) return null;
    const r = await resolvePin(ctx.prisma, scope.tenantId, value, label);
    if (!r.success) problems.push(r.error.message);
    return r.success ? r.data : null;
  };
  const payload = await pin(input.payload, "Payload");
  const headers = await pin(input.headers, "Headers");
  const key = await pin(input.key, "Key");

  if (spec.data.traitIds.length > 0) {
    const traits = await ctx.prisma.trait.findMany({
      where: { id: { in: spec.data.traitIds } },
      select: { id: true, name: true, kind: true, tenantId: true, domainId: true, productId: true },
    });
    for (const id of spec.data.traitIds) {
      const t = traits.find((x) => x.id === id);
      if (!t) problems.push(`Trait "${id}" not found`);
      else if (t.kind !== "MESSAGE") problems.push(`Trait "${t.name}" is an OPERATION trait; messages take MESSAGE traits`);
      else if (!inSameLine(t, scope)) problems.push(`Trait "${t.name}" is not visible from this product (use a trait from this product, its domain or the Enterprise)`);
    }
  }
  if (!payload && problems.length === 0) problems.push("A payload entity is required");
  if (problems.length > 0 || !payload) {
    return err({ code: "VALIDATION_ERROR", message: problems.join("; "), details: { problems } });
  }
  return ok({ name: name.data, spec: spec.data, payload, headers, key });
}

function columns(n: NormalizedMessage) {
  return {
    name: n.name, spec: n.spec as unknown as Prisma.InputJsonValue,
    payloadEntityId: n.payload.entityId, payloadEntityVersionId: n.payload.entityVersionId,
    headersEntityId: n.headers?.entityId ?? null, headersEntityVersionId: n.headers?.entityVersionId ?? null,
    keyEntityId: n.key?.entityId ?? null, keyEntityVersionId: n.key?.entityVersionId ?? null,
  };
}

const draftEdges = (n: NormalizedMessage) =>
  pinEdges({ payload: n.payload.entityVersionId, headers: n.headers?.entityVersionId ?? null, key: n.key?.entityVersionId ?? null });

async function loadOwned(ctx: ServiceContext, id: string, owner: ScopeTarget): Promise<Result<{ row: MessageRow; scope: LevelScope }>> {
  const scope = await resolveScope(ctx.prisma, owner);
  if (!scope.success) return scope;
  const row = await ctx.prisma.message.findUnique({ where: { id }, select: MESSAGE_SELECT });
  if (!row) return err({ code: "NOT_FOUND", message: `Message "${id}" not found` });
  const owned = assertOwnedBy(row, scope.data, `Message "${row.name}"`);
  if (!owned.success) return owned;
  return ok({ row, scope: scope.data });
}

export async function createMessage(productId: string, input: MessageInput, ctx: ServiceContext): Promise<Result<MessageDetail>> {
  const target = { level: "PRODUCT" as const, productId };
  const scope = await resolveScope(ctx.prisma, target);
  if (!scope.success) return scope;
  const n = await normalizeMessage(ctx, scope.data, input);
  if (!n.success) return n;
  return auditedWrite({
    action: "CREATE", entityType: "Message", entityId: "pending", userId: ctx.userId,
    run: async () => {
      const created = await createInScope(ctx.prisma, {
        kind: "message",
        target,
        name: n.data.name,
        write: async (tx, s) => {
          const row = await tx.message.create({ data: { ...columns(n.data), ...s }, select: MESSAGE_SELECT });
          await replaceReferences(tx, { kind: "MESSAGE", id: row.id }, draftEdges(n.data), true);
          return row;
        },
      });
      return created.success ? ok(toDetail(created.data)) : created;
    },
  });
}

export async function updateMessage(id: string, input: MessageInput, owner: ScopeTarget, ctx: ServiceContext): Promise<Result<MessageDetail>> {
  const owned = await loadOwned(ctx, id, owner);
  if (!owned.success) return owned;
  const n = await normalizeMessage(ctx, owned.data.scope, input);
  if (!n.success) return n;
  return auditedWrite({
    action: "UPDATE", entityType: "Message", entityId: id, userId: ctx.userId, beforeState: toDetail(owned.data.row),
    run: () =>
      writeWithUniqueName(ctx.prisma, {
        scope: owned.data.scope,
        name: n.data.name,
        exclude: { kind: "message", id },
        write: async (tx) => {
          const row = await tx.message.update({ where: { id }, data: { ...columns(n.data), hasUnpublishedChanges: true }, select: MESSAGE_SELECT });
          await replaceReferences(tx, { kind: "MESSAGE", id }, draftEdges(n.data), true);
          return toDetail(row);
        },
      }),
  });
}

export async function deleteMessage(id: string, owner: ScopeTarget, ctx: ServiceContext): Promise<Result<{ id: string }>> {
  const owned = await loadOwned(ctx, id, owner);
  if (!owned.success) return owned;
  const versionIds = (await ctx.prisma.messageVersion.findMany({ where: { messageId: id }, select: { id: true } })).map((v) => v.id);
  if (versionIds.length > 0) {
    const pinned = await ctx.prisma.schemaReference.findFirst({
      where: { toKind: "MESSAGE_VERSION", toId: { in: versionIds }, isDraft: false },
      select: { fromId: true },
    });
    if (pinned) {
      return err({
        code: "IN_USE",
        message: `Message "${owned.data.row.name}" has versions used by a published event spec version and cannot be deleted.`,
        suggestedFix: "Deprecate it instead (spec §6.1: versions referenced by published versions are kept).",
      });
    }
  }
  return auditedWrite({
    action: "DELETE", entityType: "Message", entityId: id, userId: ctx.userId, beforeState: toDetail(owned.data.row),
    run: async () => {
      await ctx.prisma.$transaction(async (tx) => {
        await deleteReferencesFrom(tx, "MESSAGE", [id]);
        await deleteReferencesFrom(tx, "MESSAGE_VERSION", versionIds);
        if (versionIds.length > 0) await tx.schemaReference.deleteMany({ where: { toKind: "MESSAGE_VERSION", toId: { in: versionIds } } });
        await tx.message.delete({ where: { id } });
      });
      return ok({ id });
    },
  });
}

export async function getMessage(id: string, ctx: ServiceContext): Promise<Result<MessageDetail>> {
  const row = await ctx.prisma.message.findUnique({ where: { id }, select: MESSAGE_SELECT });
  return row ? ok(toDetail(row)) : err({ code: "NOT_FOUND", message: `Message "${id}" not found` });
}

/** Read-side reuse by the page loaders (Task 16). */
export { MESSAGE_SELECT, toDetail as toMessageDetail };
```

- [ ] **Step 4: Implement `src/services/events/event-spec.service.ts`**

```ts
import type { Prisma } from "@/generated/prisma/client";
import { resolveScope, type ScopeTarget } from "@/lib/asset-scope";
import type { LevelScope } from "@/lib/levels";
import { formatVersionLabel } from "@/lib/entity-versioning/version-math";
import { normalizeCatalogName } from "@/lib/events/inputs";
import { emptyEventSpecDocument, parseEventSpecDocument, type DocumentProblem } from "@/lib/events/event-spec-document";
import { assertOwnedBy } from "@/lib/events/ownership";
import type { EventSpecDetail, EventSpecDocument } from "@/lib/events/types";
import { inSameLine } from "@/services/name-registry.service";
import { createInScope, writeWithUniqueName } from "@/services/scoped-create.service";
import { auditedWrite } from "@/services/events/audited";
import { deleteReferencesFrom, replaceReferences } from "@/services/events/schema-references";
import { ok, err, type Result } from "@/types/result";
import type { ServiceContext } from "@/types/service-context";

export interface CreateEventSpecInput {
  name: string;
  title?: string;
  description?: string;
}

const SPEC_SELECT = {
  id: true, name: true, specType: true, document: true, hasUnpublishedChanges: true,
  tenantId: true, domainId: true, productId: true, latestVersion: { select: { major: true, minor: true } },
} satisfies Prisma.EventSpecSelect;
type SpecRow = Prisma.EventSpecGetPayload<{ select: typeof SPEC_SELECT }>;

function toDetail(row: SpecRow): Result<EventSpecDetail> {
  const document = parseEventSpecDocument(row.document);
  if (!document.success) return err({ code: "DATA_CORRUPT", message: `Stored document of event spec "${row.name}" is invalid`, details: document.error.details });
  return ok({
    id: row.id, name: row.name, specType: row.specType, document: document.data,
    latestVersionLabel: row.latestVersion ? formatVersionLabel(row.latestVersion) : null,
    hasUnpublishedChanges: row.hasUnpublishedChanges,
    tenantId: row.tenantId, domainId: row.domainId, productId: row.productId,
  });
}

function unwrapDetail(row: SpecRow): EventSpecDetail {
  const d = toDetail(row);
  if (!d.success) throw new Error(d.error.message); // only reachable for corrupt rows written outside this service
  return d.data;
}

async function loadOwned(ctx: ServiceContext, id: string, owner: ScopeTarget): Promise<Result<{ row: SpecRow; scope: LevelScope }>> {
  const scope = await resolveScope(ctx.prisma, owner);
  if (!scope.success) return scope;
  const row = await ctx.prisma.eventSpec.findUnique({ where: { id }, select: SPEC_SELECT });
  if (!row) return err({ code: "NOT_FOUND", message: `Event spec "${id}" not found` });
  const owned = assertOwnedBy(row, scope.data, `Event spec "${row.name}"`);
  if (!owned.success) return owned;
  return ok({ row, scope: scope.data });
}

/** Every referenced id must exist; drafts (D4) only from this spec's product; traits must be OPERATION traits in line. */
async function validateDocumentRefs(
  ctx: ServiceContext,
  scope: LevelScope,
  doc: EventSpecDocument
): Promise<{ problems: DocumentProblem[]; messageVersionIds: string[] }> {
  const channelIds = new Set<string>();
  const messageIds = new Set<string>();
  const traitIds = new Set<string>();
  for (const op of doc.operations) {
    channelIds.add(op.channelId);
    if (op.reply?.channelId) channelIds.add(op.reply.channelId);
    [...op.messageVersionIds, ...(op.reply?.messageVersionIds ?? [])].forEach((id) => messageIds.add(id));
    op.traitIds.forEach((id) => traitIds.add(id));
  }
  const [channels, versions, drafts, traits] = await Promise.all([
    ctx.prisma.channel.findMany({ where: { id: { in: [...channelIds] }, tenantId: scope.tenantId }, select: { id: true } }),
    ctx.prisma.messageVersion.findMany({ where: { id: { in: [...messageIds] }, message: { tenantId: scope.tenantId } }, select: { id: true } }),
    ctx.prisma.message.findMany({ where: { id: { in: [...messageIds] }, productId: scope.productId }, select: { id: true } }),
    ctx.prisma.trait.findMany({ where: { id: { in: [...traitIds] }, tenantId: scope.tenantId }, select: { id: true, name: true, kind: true, tenantId: true, domainId: true, productId: true } }),
  ]);
  const channelSet = new Set(channels.map((c) => c.id));
  const versionSet = new Set(versions.map((v) => v.id));
  const draftSet = new Set(drafts.map((d) => d.id));

  const problems: DocumentProblem[] = [];
  const checkMessages = (ids: string[], pointer: string) =>
    ids.forEach((id, j) => {
      if (!versionSet.has(id) && !draftSet.has(id)) {
        problems.push({ pointer: `${pointer}/${j}`, message: `"${id}" is neither a message version nor a message draft of this product` });
      }
    });
  doc.operations.forEach((op, i) => {
    const p = `/operations/${i}`;
    if (!channelSet.has(op.channelId)) problems.push({ pointer: `${p}/channelId`, message: `Channel "${op.channelId}" not found` });
    checkMessages(op.messageVersionIds, `${p}/messageVersionIds`);
    op.traitIds.forEach((id, k) => {
      const t = traits.find((x) => x.id === id);
      if (!t) problems.push({ pointer: `${p}/traitIds/${k}`, message: `Trait "${id}" not found` });
      else if (t.kind !== "OPERATION") problems.push({ pointer: `${p}/traitIds/${k}`, message: `Trait "${t.name}" is a MESSAGE trait; operations take OPERATION traits` });
      else if (!inSameLine(t, scope)) problems.push({ pointer: `${p}/traitIds/${k}`, message: `Trait "${t.name}" is not visible from this product` });
    });
    if (op.reply?.channelId && !channelSet.has(op.reply.channelId)) {
      problems.push({ pointer: `${p}/reply/channelId`, message: `Channel "${op.reply.channelId}" not found` });
    }
    if (op.reply?.messageVersionIds) checkMessages(op.reply.messageVersionIds, `${p}/reply/messageVersionIds`);
  });
  return { problems, messageVersionIds: [...messageIds].filter((id) => versionSet.has(id)) };
}

export async function createEventSpec(productId: string, input: CreateEventSpecInput, ctx: ServiceContext): Promise<Result<EventSpecDetail>> {
  const name = normalizeCatalogName(input.name, "Event spec");
  if (!name.success) return name;
  const document = emptyEventSpecDocument(input.title?.trim() || name.data, input.description?.trim() || undefined);
  return auditedWrite({
    action: "CREATE", entityType: "EventSpec", entityId: "pending", userId: ctx.userId,
    run: async () => {
      const created = await createInScope(ctx.prisma, {
        kind: "eventSpec",
        target: { level: "PRODUCT", productId },
        name: name.data,
        write: (tx, s) => tx.eventSpec.create({ data: { name: name.data, document: document as unknown as Prisma.InputJsonValue, ...s }, select: SPEC_SELECT }),
      });
      return created.success ? toDetail(created.data) : created;
    },
  });
}

export async function updateEventSpecDocument(id: string, document: unknown, owner: ScopeTarget, ctx: ServiceContext): Promise<Result<EventSpecDetail>> {
  const parsed = parseEventSpecDocument(document);
  if (!parsed.success) return parsed;
  const owned = await loadOwned(ctx, id, owner);
  if (!owned.success) return owned;
  const { problems, messageVersionIds } = await validateDocumentRefs(ctx, owned.data.scope, parsed.data);
  if (problems.length > 0) {
    return err({ code: "VALIDATION_ERROR", message: `The event spec references ${problems.length} unknown or invalid item(s)`, details: { problems } });
  }
  return auditedWrite({
    action: "UPDATE", entityType: "EventSpec", entityId: id, userId: ctx.userId, beforeState: { document: owned.data.row.document },
    run: async () => {
      const row = await ctx.prisma.$transaction(async (tx) => {
        const updated = await tx.eventSpec.update({
          where: { id },
          data: { document: parsed.data as unknown as Prisma.InputJsonValue, hasUnpublishedChanges: true },
          select: SPEC_SELECT,
        });
        await replaceReferences(
          tx,
          { kind: "EVENT_SPEC", id },
          messageVersionIds.map((toId) => ({ role: "MESSAGE" as const, toKind: "MESSAGE_VERSION" as const, toId })),
          true
        );
        return updated;
      });
      return toDetail(row);
    },
  });
}

export async function renameEventSpec(id: string, rawName: string, owner: ScopeTarget, ctx: ServiceContext): Promise<Result<EventSpecDetail>> {
  const name = normalizeCatalogName(rawName, "Event spec");
  if (!name.success) return name;
  const owned = await loadOwned(ctx, id, owner);
  if (!owned.success) return owned;
  return auditedWrite({
    action: "UPDATE", entityType: "EventSpec", entityId: id, userId: ctx.userId, beforeState: { name: owned.data.row.name },
    run: () =>
      writeWithUniqueName(ctx.prisma, {
        scope: owned.data.scope,
        name: name.data,
        exclude: { kind: "eventSpec", id },
        write: async (tx) => unwrapDetail(await tx.eventSpec.update({ where: { id }, data: { name: name.data }, select: SPEC_SELECT })),
      }),
  });
}

export async function deleteEventSpec(id: string, owner: ScopeTarget, ctx: ServiceContext): Promise<Result<{ id: string }>> {
  const owned = await loadOwned(ctx, id, owner);
  if (!owned.success) return owned;
  const versionIds = (await ctx.prisma.eventSpecVersion.findMany({ where: { eventSpecId: id }, select: { id: true } })).map((v) => v.id);
  return auditedWrite({
    action: "DELETE", entityType: "EventSpec", entityId: id, userId: ctx.userId, beforeState: { name: owned.data.row.name },
    run: async () => {
      await ctx.prisma.$transaction(async (tx) => {
        await deleteReferencesFrom(tx, "EVENT_SPEC", [id]);
        await deleteReferencesFrom(tx, "EVENT_SPEC_VERSION", versionIds);
        await tx.eventSpec.delete({ where: { id } });
      });
      return ok({ id });
    },
  });
}

export async function getEventSpec(id: string, ctx: ServiceContext): Promise<Result<EventSpecDetail>> {
  const row = await ctx.prisma.eventSpec.findUnique({ where: { id }, select: SPEC_SELECT });
  return row ? toDetail(row) : err({ code: "NOT_FOUND", message: `Event spec "${id}" not found` });
}

/** Read-side reuse by the page loader (Task 17); returns a Result because stored drafts are re-validated. */
export { SPEC_SELECT, toDetail as toEventSpecDetail };
```

- [ ] **Step 5: Run the integration tests**

Run: `npx vitest run tests/integration/services/events/message.service.test.ts tests/integration/services/events/event-spec.service.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Write the failing action tests** (`tests/unit/app/message-event-spec-actions.test.ts`)

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  auth: vi.fn(), revalidatePath: vi.fn(),
  createMessage: vi.fn(), updateMessage: vi.fn(), deleteMessage: vi.fn(),
  createEventSpec: vi.fn(), updateEventSpecDocument: vi.fn(), renameEventSpec: vi.fn(), deleteEventSpec: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ prisma: { tag: "prisma" } }));
vi.mock("@/lib/auth", () => ({ auth: h.auth }));
vi.mock("next/cache", () => ({ revalidatePath: h.revalidatePath }));
vi.mock("@/services/rbac.service", () => ({ getEffectiveRole: vi.fn().mockResolvedValue({ success: true, data: "AUTHOR" }) }));
vi.mock("@/services/events/message.service", () => ({ createMessage: h.createMessage, updateMessage: h.updateMessage, deleteMessage: h.deleteMessage }));
vi.mock("@/services/events/event-spec.service", () => ({
  createEventSpec: h.createEventSpec, updateEventSpecDocument: h.updateEventSpecDocument, renameEventSpec: h.renameEventSpec, deleteEventSpec: h.deleteEventSpec,
}));

import { createMessageAction, deleteMessageAction, updateMessageAction } from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/message-actions";
import {
  createEventSpecAction, deleteEventSpecAction, renameEventSpecAction, updateEventSpecDocumentAction,
} from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/event-spec-actions";

const CTX = { userId: "u1", userRole: "AUTHOR", prisma: { tag: "prisma" } };
const OWNER = { level: "PRODUCT", productId: "p1" };
const OK = { success: true, data: { id: "x" } };

beforeEach(() => {
  vi.clearAllMocks();
  h.auth.mockResolvedValue({ user: { id: "u1" } });
  for (const fn of Object.values(h)) if (fn !== h.auth && fn !== h.revalidatePath) fn.mockResolvedValue(OK);
});

describe("message + event spec actions", () => {
  it("wire product owners through and revalidate after each successful mutation", async () => {
    const input = { name: "OrderCreated", payload: { entityId: "e1" } };
    await createMessageAction("p1", input);
    expect(h.createMessage).toHaveBeenCalledWith("p1", input, CTX);
    await updateMessageAction("m1", "p1", input);
    expect(h.updateMessage).toHaveBeenCalledWith("m1", input, OWNER, CTX);
    await deleteMessageAction("m1", "p1");
    expect(h.deleteMessage).toHaveBeenCalledWith("m1", OWNER, CTX);
    await createEventSpecAction("p1", { name: "checkout-service" });
    await updateEventSpecDocumentAction("s1", "p1", { info: { title: "x" } });
    expect(h.updateEventSpecDocument).toHaveBeenCalledWith("s1", { info: { title: "x" } }, OWNER, CTX);
    await renameEventSpecAction("s1", "p1", "renamed");
    expect(h.renameEventSpec).toHaveBeenCalledWith("s1", "renamed", OWNER, CTX);
    await deleteEventSpecAction("s1", "p1");
    expect(h.revalidatePath).toHaveBeenCalledTimes(7);
    expect(h.revalidatePath).toHaveBeenLastCalledWith("/schemas", "layout");
  });

  it("surfaces validation problems in details", async () => {
    h.updateEventSpecDocument.mockResolvedValue({ success: false, error: { code: "VALIDATION_ERROR", message: "bad", details: { problems: [{ pointer: "/info/title", message: "x" }] } } });
    expect(await updateEventSpecDocumentAction("s1", "p1", {})).toEqual({
      success: false, error: "bad", code: "VALIDATION_ERROR", details: { problems: [{ pointer: "/info/title", message: "x" }] },
    });
    expect(h.revalidatePath).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 7: Implement the actions**

```ts
// src/app/(dashboard)/schemas/[domainSlug]/[productSlug]/message-actions.ts
"use server";

import { revalidatePath } from "next/cache";
import { getActionContext, NOT_AUTHENTICATED, toActionResult } from "@/lib/action-context";
import { createMessage, deleteMessage, updateMessage, type MessageInput } from "@/services/events/message.service";
import type { MessageDetail } from "@/lib/events/types";
import type { ActionResult } from "@/types/action-result";
import type { Result } from "@/types/result";

async function mutate<T>(run: (ctx: NonNullable<Awaited<ReturnType<typeof getActionContext>>>) => Promise<Result<T>>): Promise<ActionResult<T>> {
  const ctx = await getActionContext();
  if (!ctx) return NOT_AUTHENTICATED;
  const result = await run(ctx);
  if (result.success) revalidatePath("/schemas", "layout");
  return toActionResult(result);
}
const productOwner = (productId: string) => ({ level: "PRODUCT" as const, productId });

export async function createMessageAction(productId: string, input: MessageInput): Promise<ActionResult<MessageDetail>> {
  return mutate((ctx) => createMessage(productId, input, ctx));
}

export async function updateMessageAction(messageId: string, productId: string, input: MessageInput): Promise<ActionResult<MessageDetail>> {
  return mutate((ctx) => updateMessage(messageId, input, productOwner(productId), ctx));
}

export async function deleteMessageAction(messageId: string, productId: string): Promise<ActionResult<{ id: string }>> {
  return mutate((ctx) => deleteMessage(messageId, productOwner(productId), ctx));
}
```

```ts
// src/app/(dashboard)/schemas/[domainSlug]/[productSlug]/event-spec-actions.ts
"use server";

import { revalidatePath } from "next/cache";
import { getActionContext, NOT_AUTHENTICATED, toActionResult } from "@/lib/action-context";
import {
  createEventSpec, deleteEventSpec, renameEventSpec, updateEventSpecDocument, type CreateEventSpecInput,
} from "@/services/events/event-spec.service";
import type { EventSpecDetail } from "@/lib/events/types";
import type { ActionResult } from "@/types/action-result";
import type { Result } from "@/types/result";

async function mutate<T>(run: (ctx: NonNullable<Awaited<ReturnType<typeof getActionContext>>>) => Promise<Result<T>>): Promise<ActionResult<T>> {
  const ctx = await getActionContext();
  if (!ctx) return NOT_AUTHENTICATED;
  const result = await run(ctx);
  if (result.success) revalidatePath("/schemas", "layout");
  return toActionResult(result);
}
const productOwner = (productId: string) => ({ level: "PRODUCT" as const, productId });

export async function createEventSpecAction(productId: string, input: CreateEventSpecInput): Promise<ActionResult<EventSpecDetail>> {
  return mutate((ctx) => createEventSpec(productId, input, ctx));
}

export async function updateEventSpecDocumentAction(specId: string, productId: string, document: unknown): Promise<ActionResult<EventSpecDetail>> {
  return mutate((ctx) => updateEventSpecDocument(specId, document, productOwner(productId), ctx));
}

export async function renameEventSpecAction(specId: string, productId: string, name: string): Promise<ActionResult<EventSpecDetail>> {
  return mutate((ctx) => renameEventSpec(specId, name, productOwner(productId), ctx));
}

export async function deleteEventSpecAction(specId: string, productId: string): Promise<ActionResult<{ id: string }>> {
  return mutate((ctx) => deleteEventSpec(specId, productOwner(productId), ctx));
}
```

- [ ] **Step 8: Run the task's tests + type check**

Run: `npx vitest run tests/unit/app/message-event-spec-actions.test.ts tests/integration/services/events/message.service.test.ts tests/integration/services/events/event-spec.service.test.ts && npx tsc --noEmit`
Expected: PASS; no type errors.

- [ ] **Step 9: Commit**

```bash
git add src/services/events/message.service.ts src/services/events/event-spec.service.ts "src/app/(dashboard)/schemas/[domainSlug]/[productSlug]/message-actions.ts" "src/app/(dashboard)/schemas/[domainSlug]/[productSlug]/event-spec-actions.ts" tests/integration/services/events/message.service.test.ts tests/integration/services/events/event-spec.service.test.ts tests/unit/app/message-event-spec-actions.test.ts
git commit -m "feat(18.2): message + event spec draft services and actions (pins, draft refs, reference validation)"
```

---
### Task 5: Entity-version artifact renderer — emission wiring, part 1 (Stories 18.4 / 16.2 / 16.3 wiring) — Wave 1

**Files:**
- Modify: `src/lib/typespec-official/emitter.service.ts` (extract + export helpers; behavior unchanged)
- Create: `src/lib/events/version-source.ts`, `src/lib/events/json-schema-bundle.ts`, `src/services/events/artifact-renderer.ts`
- Test: `tests/unit/lib/events/version-source.test.ts`, `tests/unit/lib/events/json-schema-bundle.test.ts`, `tests/unit/lib/typespec-official/protobuf-field-numbers.test.ts`, `tests/unit/services/events/artifact-renderer.test.ts`, `tests/integration/services/events/artifact-renderer.test.ts`

**Interfaces:**

```ts
// emitter.service.ts (new exports)
interface EmittedFile { relativePath: string; content: string }
runTypeSpecEmitterFiles(packageName: string, source: string, options: Record<string, unknown>): Promise<Result<EmittedFile[]>>
injectProtobufFieldNumbers(source: string, modelName: string, fields: ReadonlyArray<{ name: string; fieldNumber?: number | null }>): string
stripRealCompileInvalidDecorators(source: string): string; sanitizeIdentifier(name: string): string
// version-source.ts (pure)
splitTypeSpecStatements(source): Result<TypeSpecStatement[]>
combineTypeSpecSources(parts: SourcePart[]): Result<CombinedSource>      // { imports, usings, body, warnings }
levelNamespace({ tenantSlug, domainSlug, productSlug }): string           // "Acme.Payments.Checkout"
findRootModelName(source, entityName): string | null
// json-schema-bundle.ts (pure)
inlineJsonSchemaBundle(bundle: JsonObject, rootModel: string): Result<JsonObject>
// artifact-renderer.ts
type ArtifactSubject = { kind: "version"; entityVersionId: string } | { kind: "draft"; entityId: string }
interface RenderedArtifact { artifact: SchemaArtifact; warnings: string[] }
interface ArtifactRenderer { render(subject: ArtifactSubject, format: PayloadFormat): Promise<Result<RenderedArtifact>> }
createArtifactRenderer(opts: { db; emitFiles?; maxEntries?; concurrency? }): ArtifactRenderer
getSharedArtifactRenderer(db: PrismaClient): ArtifactRenderer
buildTargetSource(format, combined, program): string; pickEmittedArtifact(format, files, rootModel): Result<SchemaArtifact>
```

- [ ] **Step 1: Write the failing pure tests**

`tests/unit/lib/events/version-source.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { combineTypeSpecSources, findRootModelName, levelNamespace, splitTypeSpecStatements } from "@/lib/events/version-source";

describe("splitTypeSpecStatements", () => {
  it("keeps decorators + comments with their statement; braces / semicolons inside strings do not split", () => {
    const src = [
      'import "@typespec/json-schema";',
      "using TypeSpec.JsonSchema;",
      "namespace Old.Ns;",
      "",
      "/** Order */",
      '@doc("has { braces } and ; semicolons")',
      "model Order {",
      "  id: string;",
      '  @pattern("^[a-z]+$") code: string;',
      "}",
      "",
      "enum Status { Active, Retired }",
      "alias Id = string;",
      "model Wrapped is Array<{ a: string }>;",
    ].join("\n");
    const r = splitTypeSpecStatements(src);
    expect(r.success && r.data.map((s) => [s.kind, s.name ?? null])).toEqual([
      ["import", null], ["using", null], ["namespace", null],
      ["declaration", "Order"], ["declaration", "Status"], ["declaration", "Id"], ["declaration", "Wrapped"],
    ]);
    expect(r.success && r.data[3].text.startsWith("/** Order */")).toBe(true);
  });

  it("reports unbalanced braces and unterminated strings", () => {
    expect(splitTypeSpecStatements("model A {").success).toBe(false);
    expect(splitTypeSpecStatements('model A { @doc("x) a: string; }').success).toBe(false);
  });
});

describe("combineTypeSpecSources", () => {
  it("hoists imports, drops file-level namespaces, dedupes declarations and warns on divergent copies", () => {
    const r = combineTypeSpecSources([
      { label: "Order@1.0", source: 'import "@typespec/json-schema";\nnamespace A;\nenum Status { Active }\nmodel Order { id: string; status: Status; address: Address; }\n' },
      { label: "Address@1.0", source: "namespace B;\nenum Status { Active }\nmodel Address { street: string; }\n" },
      { label: "Customer@2.0", source: "enum Status { Active, Retired }\n" },
    ]);
    expect(r.success && r.data.imports).toEqual(['import "@typespec/json-schema";']);
    expect(r.success && r.data.body).toBe(
      "enum Status { Active }\n\nmodel Order { id: string; status: Status; address: Address; }\n\nmodel Address { street: string; }"
    );
    expect(r.success && r.data.warnings).toEqual(['"Status" from Customer@2.0 differs from the copy in Order@1.0; the Order@1.0 copy is used']);
  });
});

describe("levelNamespace / findRootModelName", () => {
  it("PascalCases the level path (spec §4.4)", () => {
    expect(levelNamespace({ tenantSlug: "acme", domainSlug: "payments", productSlug: "checkout-v2" })).toBe("Acme.Payments.CheckoutV2");
    expect(levelNamespace({ tenantSlug: "acme", domainSlug: null, productSlug: null })).toBe("Acme");
    expect(levelNamespace({ tenantSlug: "1st", domainSlug: null, productSlug: null })).toBe("N1st");
  });

  it("finds the model named after the entity, else the first model", () => {
    expect(findRootModelName("enum S { A }\nmodel Line { a: string; }\nmodel Order { l: Line; }", "Order")).toBe("Order");
    expect(findRootModelName("model Line { a: string; }", "Order Line")).toBe("Line");
    expect(findRootModelName("enum S { A }", "Order")).toBeNull();
  });
});
```

`tests/unit/lib/events/json-schema-bundle.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { inlineJsonSchemaBundle } from "@/lib/events/json-schema-bundle";

const S = "https://json-schema.org/draft/2020-12/schema";

describe("inlineJsonSchemaBundle", () => {
  it("turns an @typespec/json-schema bundle into one schema with local $defs (no file refs)", () => {
    const bundle = {
      $schema: S, $id: "Order",
      $defs: {
        Order: {
          $schema: S, $id: "Order.json", type: "object",
          properties: { id: { type: "string" }, address: { $ref: "Address.json" }, parent: { $ref: "Order.json" } },
          required: ["id", "address"],
        },
        Address: { $schema: S, $id: "Address.json", type: "object", properties: { street: { type: "string" }, alias: { $ref: "#/properties/street" } } },
      },
    };
    expect(inlineJsonSchemaBundle(bundle, "Order")).toEqual({
      success: true,
      data: {
        $schema: S, type: "object",
        properties: { id: { type: "string" }, address: { $ref: "#/$defs/Address" }, parent: { $ref: "#" } },
        required: ["id", "address"],
        $defs: { Address: { type: "object", properties: { street: { type: "string" }, alias: { $ref: "#/$defs/Address/properties/street" } } } },
      },
    });
  });

  it("accepts a single non-bundled schema and rejects unknown refs or a missing root", () => {
    expect(inlineJsonSchemaBundle({ $schema: S, $id: "Order.json", type: "object", properties: {} }, "Order")).toEqual({
      success: true, data: { $schema: S, type: "object", properties: {} },
    });
    const unknown = inlineJsonSchemaBundle({ $id: "Order", $defs: { Order: { type: "object", properties: { x: { $ref: "Missing.json" } } } } }, "Order");
    expect(!unknown.success && unknown.error.code).toBe("SCHEMA_BUNDLE_UNRESOLVED");
    const noRoot = inlineJsonSchemaBundle({ $id: "Order", $defs: { Other: { type: "object" } } }, "Order");
    expect(!noRoot.success && noRoot.error.code).toBe("ROOT_SCHEMA_NOT_FOUND");
  });
});
```

`tests/unit/lib/typespec-official/protobuf-field-numbers.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
vi.mock("@/lib/db", () => ({ prisma: {} }));
import { injectProtobufFieldNumbers } from "@/lib/typespec-official/emitter.service";

describe("injectProtobufFieldNumbers", () => {
  it("targets the exact model (not a prefix match) and falls back to positions", () => {
    const src = "model OrderKey {\n  id: string;\n}\n\nmodel Order {\n  id: string;\n  total?: int32;\n}\n";
    expect(injectProtobufFieldNumbers(src, "Order", [{ name: "id", fieldNumber: 5 }, { name: "total", fieldNumber: null }])).toBe(
      "model OrderKey {\n  id: string;\n}\n\nmodel Order {\n  @field(5)\n  id: string;\n  @field(2)\n  total?: int32;\n}\n"
    );
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/unit/lib/events/version-source.test.ts tests/unit/lib/events/json-schema-bundle.test.ts tests/unit/lib/typespec-official/protobuf-field-numbers.test.ts`
Expected: FAIL — missing modules / `injectProtobufFieldNumbers` is not exported.

- [ ] **Step 3: Refactor `src/lib/typespec-official/emitter.service.ts`** (existing callers keep their behavior)

Add `import { ok, err, type Result } from "@/types/result";`. Export `stripRealCompileInvalidDecorators` and `sanitizeIdentifier` (add `export` to the two existing function declarations). Replace `injectProtobufFieldDecorators` and `runTypeSpecEmitter` with:

```ts
function injectProtobufFieldDecorators(source: string, model: SuperSchemaModel): string {
  return injectProtobufFieldNumbers(source, sanitizeIdentifier(model.entity.name), model.fields);
}

/**
 * Inject `@field(n)` before every listed property of `model <modelName>` — n is the
 * field's stored number, else its 1-based position. The model is matched by exact name
 * (`Order` never matches `OrderKey`); property lines keep their indentation.
 */
export function injectProtobufFieldNumbers(
  source: string,
  modelName: string,
  fields: ReadonlyArray<{ name: string; fieldNumber?: number | null }>
): string {
  const header = new RegExp(`\\bmodel\\s+${escapeRegExp(modelName)}(?![A-Za-z0-9_])`).exec(source);
  if (!header) return source;
  const openBrace = source.indexOf("{", header.index);
  if (openBrace === -1) return source;

  let depth = 0;
  let closeBrace = -1;
  for (let i = openBrace; i < source.length; i++) {
    if (source[i] === "{") depth++;
    if (source[i] === "}") {
      depth--;
      if (depth === 0) {
        closeBrace = i;
        break;
      }
    }
  }
  if (closeBrace === -1) return source;

  const before = source.slice(0, openBrace + 1);
  let body = source.slice(openBrace + 1, closeBrace);
  const after = source.slice(closeBrace);

  fields.forEach((field, index) => {
    const safeName = sanitizeIdentifier(field.name);
    const fieldNumber = field.fieldNumber ?? index + 1;
    const matcher = new RegExp(`^([ \\t]*)${escapeRegExp(safeName)}(\\??:)`, "m");
    if (matcher.test(body)) body = body.replace(matcher, `$1@field(${fieldNumber})\n$1${safeName}$2`);
  });

  return `${before}${body}${after}`;
}

export interface EmittedFile {
  relativePath: string;
  content: string;
}

/** Run one TypeSpec emitter in a throw-away workspace; every file it wrote, sorted by path. */
export async function runTypeSpecEmitterFiles(
  packageName: string,
  source: string,
  emitterOptions: Record<string, unknown>
): Promise<Result<EmittedFile[]>> {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "superschema-tsp-"));
  const outputDir = path.join(workspace, "out");

  try {
    await fs.symlink(path.join(process.cwd(), "node_modules"), path.join(workspace, "node_modules"), "dir");
    const mainFile = path.join(workspace, "main.tsp");
    const configFile = path.join(workspace, "tspconfig.yaml");
    await fs.writeFile(mainFile, source, "utf8");
    await fs.writeFile(
      configFile,
      stringifyYaml({
        emit: [packageName],
        options: { [packageName]: { "emitter-output-dir": "{project-root}/out", ...emitterOptions } },
      }),
      "utf8"
    );
    await execFileAsync(getTspBinaryPath(), ["compile", mainFile, "--config", configFile, "--pretty", "false"], {
      cwd: workspace,
      maxBuffer: 10 * 1024 * 1024,
    });

    const files = await collectTextFiles(outputDir);
    if (files.length === 0) {
      return err({ code: "EMITTER_NO_OUTPUT", message: `Emitter "${packageName}" completed but did not write any files.` });
    }
    return ok(files);
  } catch (error) {
    const message = error instanceof Error ? error.message : "TypeSpec emitter failed";
    const details =
      typeof error === "object" && error !== null && "stdout" in error
        ? [String((error as { stdout?: string }).stdout ?? ""), String((error as { stderr?: string }).stderr ?? "")]
            .filter(Boolean)
            .join("\n")
            .trim()
        : "";
    return err({ code: "EMITTER_FAILED", message: details || message });
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
}

async function runTypeSpecEmitter(
  packageName: string,
  source: string,
  emitterOptions: Record<string, unknown>
): Promise<OfficialTypeSpecTargetResult> {
  const files = await runTypeSpecEmitterFiles(packageName, source, emitterOptions);
  if (!files.success) return invalidResult(files.error.message);
  return { output: bundleGeneratedFiles(files.data), validationStatus: "VALID", warnings: [], errors: [] };
}
```

(`collectTextFiles` already returns `Array<{ relativePath; content }>`; change its return annotation to `Promise<EmittedFile[]>`.)

- [ ] **Step 4: Implement `src/lib/events/version-source.ts`**

```ts
import { ok, err, type Result } from "@/types/result";

export type StatementKind = "import" | "using" | "namespace" | "declaration" | "other";
export interface TypeSpecStatement {
  kind: StatementKind;
  /** Raw text incl. leading comments / decorators (imports and usings: just the statement). */
  text: string;
  keyword?: string;
  name?: string;
}
export interface SourcePart {
  label: string;
  source: string;
}
export interface CombinedSource {
  imports: string[];
  usings: string[];
  body: string;
  warnings: string[];
}

const DECLARATION_HEAD = /^(?:(?:extern|internal)\s+)*(model|enum|scalar|union|alias|op|interface)\s+([A-Za-z_][A-Za-z0-9_]*)/;
const parseError = (message: string) => err({ code: "TYPESPEC_PARSE_ERROR", message });

/** Index just past a string literal at `i` ("…" or """…"""), or -1 when unterminated. */
function skipString(src: string, i: number): number {
  if (src.startsWith('"""', i)) {
    const end = src.indexOf('"""', i + 3);
    return end < 0 ? -1 : end + 3;
  }
  let j = i + 1;
  while (j < src.length && src[j] !== '"') {
    if (src[j] === "\n") return -1;
    j += src[j] === "\\" ? 2 : 1;
  }
  return j < src.length ? j + 1 : -1;
}

/** A depth-0 `}` ends a statement only if the rest of its line is blank, `;` or a comment (so `Array<{…}>;` does not split). */
function blockStatementEnd(src: string, i: number): number {
  let j = i + 1;
  while (j < src.length && (src[j] === " " || src[j] === "\t")) j++;
  if (src[j] === ";") return j + 1;
  if (j >= src.length || src[j] === "\n" || src[j] === "\r" || src.startsWith("//", j) || src.startsWith("/*", j)) return i + 1;
  return -1;
}

/** Code with string contents and comments blanked, so decorator arguments and docs cannot fake keywords. */
function codeOnly(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"') {
      const end = skipString(text, i);
      out += '""';
      i = end < 0 ? text.length : end;
    } else if (c === "/" && text[i + 1] === "/") {
      const nl = text.indexOf("\n", i);
      out += " ";
      i = nl < 0 ? text.length : nl;
    } else if (c === "/" && text[i + 1] === "*") {
      const close = text.indexOf("*/", i + 2);
      out += " ";
      i = close < 0 ? text.length : close + 2;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

function stripLeadingDecorators(code: string): string {
  let s = code.trimStart();
  while (s.startsWith("@")) {
    const name = /^@[A-Za-z_][\w.]*/.exec(s);
    if (!name) break;
    let j = name[0].length;
    if (s[j] === "(") {
      let depth = 0;
      for (; j < s.length; j++) {
        if (s[j] === "(") depth++;
        else if (s[j] === ")" && --depth === 0) {
          j++;
          break;
        }
      }
    }
    s = s.slice(j).trimStart();
  }
  return s;
}

function classify(text: string): TypeSpecStatement {
  const head = stripLeadingDecorators(codeOnly(text)).trim();
  if (/^import\s/.test(head)) return { kind: "import", text: (/import\s+"[^"]*"\s*;/.exec(text)?.[0] ?? text).trim() };
  if (/^using\s/.test(head)) return { kind: "using", text: (/using\s+[^;]+;/.exec(text)?.[0] ?? text).trim() };
  if (/^namespace\s+[\w.`]+\s*;$/.test(head)) return { kind: "namespace", text };
  const m = DECLARATION_HEAD.exec(head);
  if (m) return { kind: "declaration", text, keyword: m[1], name: m[2] };
  return { kind: "other", text };
}

export function splitTypeSpecStatements(source: string): Result<TypeSpecStatement[]> {
  const out: TypeSpecStatement[] = [];
  let depth = 0;
  let start = 0;
  let i = 0;
  const push = (end: number) => {
    const text = source.slice(start, end).trim();
    if (text) out.push(classify(text));
    start = end;
  };
  while (i < source.length) {
    const c = source[i];
    if (c === '"') {
      const end = skipString(source, i);
      if (end < 0) return parseError("Unterminated string literal");
      i = end;
      continue;
    }
    if (c === "/" && source[i + 1] === "/") {
      const nl = source.indexOf("\n", i);
      i = nl < 0 ? source.length : nl;
      continue;
    }
    if (c === "/" && source[i + 1] === "*") {
      const close = source.indexOf("*/", i + 2);
      if (close < 0) return parseError("Unterminated block comment");
      i = close + 2;
      continue;
    }
    if (c === "{" || c === "(" || c === "[") depth++;
    else if (c === "}" || c === ")" || c === "]") {
      depth--;
      if (depth < 0) return parseError(`Unbalanced "${c}"`);
      if (depth === 0 && c === "}") {
        const end = blockStatementEnd(source, i);
        if (end >= 0) {
          push(end);
          i = end;
          continue;
        }
      }
    } else if (c === ";" && depth === 0) {
      push(i + 1);
      i += 1;
      continue;
    }
    i++;
  }
  if (depth !== 0) return parseError("Unbalanced braces");
  push(source.length);
  return ok(out);
}

/**
 * D9: one TypeSpec program from several sources (pinned root version first, then its closure).
 * Imports / usings are hoisted and de-duplicated, file-level `namespace X;` statements are dropped
 * (the caller wraps the program in one level-derived namespace), and a declaration name seen twice
 * keeps its first copy — with a warning when the copies differ.
 */
export function combineTypeSpecSources(parts: SourcePart[]): Result<CombinedSource> {
  const imports = new Set<string>();
  const usings = new Set<string>();
  const body: string[] = [];
  const seen = new Map<string, { label: string; normalized: string }>();
  const warnings: string[] = [];

  for (const part of parts) {
    const statements = splitTypeSpecStatements(part.source);
    if (!statements.success) return err({ ...statements.error, message: `${part.label}: ${statements.error.message}` });
    for (const s of statements.data) {
      if (s.kind === "import") imports.add(s.text);
      else if (s.kind === "using") usings.add(s.text);
      else if (s.kind === "namespace") continue;
      else if (s.kind === "declaration" && s.name) {
        const normalized = s.text.replace(/\s+/g, " ").trim();
        const prior = seen.get(s.name);
        if (prior) {
          if (prior.normalized !== normalized) warnings.push(`"${s.name}" from ${part.label} differs from the copy in ${prior.label}; the ${prior.label} copy is used`);
          continue;
        }
        seen.set(s.name, { label: part.label, normalized });
        body.push(s.text.trim());
      } else body.push(s.text.trim());
    }
  }
  return ok({ imports: [...imports], usings: [...usings], body: body.join("\n\n"), warnings });
}

function pascalSegment(slug: string): string {
  const pascal = slug
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join("");
  return pascal === "" || /^[0-9]/.test(pascal) ? `N${pascal}` : pascal;
}

/** Spec §4.4: `Acme.Payments.Checkout` (tenant-level items: `Acme`). */
export function levelNamespace(slugs: { tenantSlug: string; domainSlug: string | null; productSlug: string | null }): string {
  return [slugs.tenantSlug, slugs.domainSlug, slugs.productSlug]
    .filter((s): s is string => !!s)
    .map(pascalSegment)
    .join(".");
}

export function findRootModelName(source: string, entityName: string): string | null {
  const statements = splitTypeSpecStatements(source);
  if (!statements.success) return null;
  const models = statements.data.filter((s) => s.kind === "declaration" && s.keyword === "model");
  const safe = entityName.replace(/[^A-Za-z0-9_]/g, "_");
  return models.find((s) => s.name === safe || s.name === entityName)?.name ?? models[0]?.name ?? null;
}
```

- [ ] **Step 5: Implement `src/lib/events/json-schema-bundle.ts`**

```ts
import { mapSchemaRefs } from "@/lib/event-specs/json-schema-keywords";
import type { JsonObject } from "@/lib/event-specs/types";
import { isJsonObject } from "./inputs";
import { ok, err, type Result } from "@/types/result";

const DRAFT_2020_12 = "https://json-schema.org/draft/2020-12/schema";

function withoutKeys(schema: JsonObject, keys: readonly string[]): JsonObject {
  const out: JsonObject = {};
  for (const [k, v] of Object.entries(schema)) if (!keys.includes(k)) out[k] = v;
  return out;
}

/**
 * D9: `@typespec/json-schema` with `bundleId` writes `{ $id: <bundle>, $defs: { Order: { $id: "Order.json", … } } }`
 * whose cross-model refs are file refs (`"Address.json"`). AsyncAPI documents must not carry
 * non-local refs (REMOTE_REF), so the root model becomes the schema and every other model a local
 * `#/$defs/<Name>`; refs are rewritten in schema positions only (mapSchemaRefs).
 */
export function inlineJsonSchemaBundle(bundle: JsonObject, rootModel: string): Result<JsonObject> {
  const bundled = isJsonObject(bundle.$defs) && bundle.type === undefined && bundle.properties === undefined;
  const entries: Array<[string, JsonObject]> = bundled
    ? Object.entries(bundle.$defs as JsonObject).filter((e): e is [string, JsonObject] => isJsonObject(e[1]))
    : [[rootModel, bundle]];

  const nameById = new Map<string, string>();
  for (const [name, schema] of entries) {
    nameById.set(`${name}.json`, name);
    if (typeof schema.$id === "string") nameById.set(schema.$id, name);
  }
  const root = entries.find(([name]) => name === rootModel);
  if (!root) return err({ code: "ROOT_SCHEMA_NOT_FOUND", message: `JSON Schema bundle has no schema for "${rootModel}"` });

  const problems: string[] = [];
  const rewrite = (owner: string) => (ref: string): string => {
    const hash = ref.indexOf("#");
    const file = hash < 0 ? ref : ref.slice(0, hash);
    const fragment = hash < 0 ? "" : ref.slice(hash + 1);
    if (file === "") return owner === rootModel ? ref : `#/$defs/${owner}${fragment}`;
    const target = nameById.get(file);
    if (!target) {
      problems.push(`unresolvable $ref "${ref}" in ${owner}`);
      return ref;
    }
    return target === rootModel ? `#${fragment}` : `#/$defs/${target}${fragment}`;
  };

  const rootSchema = mapSchemaRefs(withoutKeys(root[1], ["$schema", "$id"]), rewrite(rootModel));
  const defs: JsonObject = isJsonObject(rootSchema.$defs) ? { ...rootSchema.$defs } : {};
  for (const [name, schema] of [...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (name === rootModel) continue;
    if (name in defs) {
      problems.push(`$defs name clash "${name}"`);
      continue;
    }
    defs[name] = mapSchemaRefs(withoutKeys(schema, ["$schema", "$id"]), rewrite(name));
  }
  if (problems.length > 0) return err({ code: "SCHEMA_BUNDLE_UNRESOLVED", message: problems.join("; "), details: { problems } });

  const out: JsonObject = { $schema: DRAFT_2020_12, ...withoutKeys(rootSchema, ["$defs"]) };
  if (Object.keys(defs).length > 0) out.$defs = defs;
  return ok(out);
}
```

- [ ] **Step 6: Run the pure tests**

Run: `npx vitest run tests/unit/lib/events/version-source.test.ts tests/unit/lib/events/json-schema-bundle.test.ts tests/unit/lib/typespec-official`
Expected: PASS (incl. the existing `emitter.service.test.ts`, whose output is unchanged).

- [ ] **Step 7: Write the failing renderer unit test** (`tests/unit/services/events/artifact-renderer.test.ts`)

```ts
import { describe, it, expect, vi } from "vitest";
vi.mock("@/lib/db", () => ({ prisma: {} }));
import { createArtifactRenderer, type EmitFiles } from "@/services/events/artifact-renderer";

type V = { id: string; entityId: string; major: number; minor: number; resolvedSource: string; fieldSnapshot: unknown; entity: { name: string } };
const versions: Record<string, V> = {
  vOrder: {
    id: "vOrder", entityId: "eOrder", major: 2, minor: 1, entity: { name: "Order" },
    resolvedSource: "namespace Custom;\nmodel Order {\n  id: string;\n  address: Address;\n}\n",
    fieldSnapshot: [{ name: "id", fieldNumber: 1 }, { name: "address", fieldNumber: 2 }],
  },
  vAddress: { id: "vAddress", entityId: "eAddress", major: 1, minor: 0, entity: { name: "Address" }, resolvedSource: "model Address {\n  street: string;\n}\n", fieldSnapshot: [{ name: "street", fieldNumber: null }] },
  vAddress2: { id: "vAddress2", entityId: "eAddress", major: 2, minor: 0, entity: { name: "Address" }, resolvedSource: "model Address {\n  line1: string;\n}\n", fieldSnapshot: [] },
  vCustomer: { id: "vCustomer", entityId: "eCustomer", major: 1, minor: 0, entity: { name: "Customer" }, resolvedSource: "model Customer {\n  home: Address;\n}\n", fieldSnapshot: [] },
  vBroken: { id: "vBroken", entityId: "eBroken", major: 1, minor: 0, entity: { name: "Broken" }, resolvedSource: "model Broken {\n  id: string;\n}\n", fieldSnapshot: [] },
};
const fieldPins: Record<string, string[]> = { vOrder: ["vAddress"], vCustomer: ["vAddress2"], vMixed: [] };

function fakeDb(extraPins: Record<string, string[]> = {}) {
  const pins = { ...fieldPins, ...extraPins };
  return {
    entityVersion: { findUnique: vi.fn(async ({ where }: { where: { id: string } }) => versions[where.id] ?? null) },
    schemaReference: { findMany: vi.fn(async ({ where }: { where: { fromId: string } }) => (pins[where.fromId] ?? []).map((toId) => ({ toId }))) },
    entity: { findUnique: vi.fn(async () => ({ tenant: { slug: "acme" }, domain: { slug: "payments" }, product: { slug: "checkout" } })) },
  };
}

const order = { kind: "version" as const, entityVersionId: "vOrder" };

describe("artifact renderer", () => {
  it("renders Avro from the combined program and picks <Root>.avsc.json", async () => {
    const emitFiles = vi.fn<EmitFiles>(async () => ({
      success: true,
      data: [
        { relativePath: "Address.avsc.json", content: '{"type":"record","name":"Address","fields":[]}' },
        { relativePath: "Order.avsc.json", content: '{"type":"record","name":"Order","fields":[]}' },
      ],
    }));
    const renderer = createArtifactRenderer({ db: fakeDb() as never, emitFiles });
    const r = await renderer.render(order, "avro");
    expect(r).toEqual({ success: true, data: { artifact: { format: "avro", schema: { type: "record", name: "Order", fields: [] } }, warnings: [] } });
    const [pkg, source, options] = emitFiles.mock.calls[0];
    expect(pkg).toBe("@typespec/avro");
    expect(options).toEqual({});
    expect(source).toContain("namespace Acme.Payments.Checkout;");
    expect(source).not.toContain("namespace Custom;");
    expect(source.indexOf("model Order")).toBeLessThan(source.indexOf("model Address"));
  });

  it("caches immutable versions (one emit for two renders) and does not cache failures", async () => {
    const emitFiles = vi.fn<EmitFiles>(async () => ({ success: true, data: [{ relativePath: "Order.avsc.json", content: '{"type":"record","name":"Order"}' }] }));
    const renderer = createArtifactRenderer({ db: fakeDb() as never, emitFiles });
    await renderer.render(order, "avro");
    await renderer.render(order, "avro");
    expect(emitFiles).toHaveBeenCalledTimes(1);

    const failing = vi.fn<EmitFiles>(async () => ({ success: false, error: { code: "EMITTER_FAILED", message: "boom" } }));
    const r2 = createArtifactRenderer({ db: fakeDb() as never, emitFiles: failing });
    const first = await r2.render({ kind: "version", entityVersionId: "vBroken" }, "avro");
    expect(!first.success && first.error).toEqual({ code: "ARTIFACT_RENDER_FAILED", message: "Broken@1.0 → avro: boom" });
    await r2.render({ kind: "version", entityVersionId: "vBroken" }, "avro");
    expect(failing).toHaveBeenCalledTimes(2);
  });

  it("renders JSON Schema once as a 2020-12 bundle and inlines it", async () => {
    const bundle = {
      $id: "Order",
      $defs: {
        Order: { $id: "Order.json", type: "object", properties: { address: { $ref: "Address.json" } } },
        Address: { $id: "Address.json", type: "object", properties: { street: { type: "string" } } },
      },
    };
    const emitFiles = vi.fn<EmitFiles>(async () => ({ success: true, data: [{ relativePath: "Order", content: JSON.stringify(bundle) }] }));
    const r = await createArtifactRenderer({ db: fakeDb() as never, emitFiles }).render(order, "json-schema");
    expect(r.success && r.data.artifact).toMatchObject({
      format: "json-schema", dialect: "2020-12",
      schema: { type: "object", properties: { address: { $ref: "#/$defs/Address" } }, $defs: { Address: { type: "object" } } },
    });
    expect(emitFiles.mock.calls[0][0]).toBe("@typespec/json-schema");
    expect(emitFiles.mock.calls[0][1]).toContain('import "@typespec/json-schema";');
    expect(emitFiles.mock.calls[0][2]).toEqual({ emitAllModels: true, "file-type": "json", bundleId: "Order" });
  });

  it("renders protobuf with @package, field numbers from every version, and the root message first", async () => {
    const proto = 'syntax = "proto3";\n\nmessage Address {\n  string street = 1;\n}\n\nmessage Order {\n  string id = 1;\n  Address address = 2;\n}\n';
    const emitFiles = vi.fn<EmitFiles>(async () => ({ success: true, data: [{ relativePath: "main.proto", content: proto }] }));
    const r = await createArtifactRenderer({ db: fakeDb() as never, emitFiles }).render(order, "protobuf");
    const text = r.success ? (r.data.artifact.schema as string) : "";
    expect(text.indexOf("// @RootNode\nmessage Order")).toBeGreaterThan(-1);
    expect(text.indexOf("message Order")).toBeLessThan(text.indexOf("message Address"));
    const source = emitFiles.mock.calls[0][1];
    expect(source).toContain("@package\nnamespace Acme.Payments.Checkout;");
    expect(source).toContain("@field(1)\n  id: string;");
    expect(source).toContain("@field(2)\n  address: Address;");
    expect(source).toContain("@field(1)\n  street: string;");
  });

  it("refuses two versions of one entity in a single program", async () => {
    const renderer = createArtifactRenderer({ db: fakeDb({ vOrder: ["vAddress", "vCustomer"] }) as never, emitFiles: vi.fn() });
    const r = await renderer.render(order, "avro");
    expect(!r.success && r.error.code).toBe("CONFLICTING_PINS");
  });
});
```

- [ ] **Step 8: Implement `src/services/events/artifact-renderer.ts`**

```ts
import type { PrismaClient, Prisma } from "@/generated/prisma/client";
import { placeRootMessageFirst } from "@/lib/event-specs/proto-root";
import type { JsonObject, PayloadFormat, SchemaArtifact } from "@/lib/event-specs/types";
import { isJsonObject } from "@/lib/events/inputs";
import { inlineJsonSchemaBundle } from "@/lib/events/json-schema-bundle";
import { combineTypeSpecSources, findRootModelName, levelNamespace, type CombinedSource } from "@/lib/events/version-source";
import { loadEntityModel } from "@/lib/compiler/entity-model-loader";
import { generateTypeSpec } from "@/lib/compiler/typespec-generator";
import { collectReferencedEntityIds } from "@/lib/entity-versioning/reference-targets";
import { formatVersionLabel } from "@/lib/entity-versioning/version-math";
import { getSchemaTargetDefinition } from "@/lib/schema-targets/catalog";
import {
  injectProtobufFieldNumbers,
  runTypeSpecEmitterFiles,
  sanitizeIdentifier,
  stripRealCompileInvalidDecorators,
  type EmittedFile,
} from "@/lib/typespec-official/emitter.service";
import { projectTypeSpecSourceForProtobuf } from "@/lib/typespec-official/protobuf-source";
import type { FieldSnapshot } from "@/services/version-history/version.types";
import { ok, err, type Result } from "@/types/result";

type Db = PrismaClient | Prisma.TransactionClient;

export type ArtifactSubject = { kind: "version"; entityVersionId: string } | { kind: "draft"; entityId: string };
export interface RenderedArtifact {
  artifact: SchemaArtifact;
  /** Program-combination warnings (duplicate declarations) — surfaced as diagnostics by the resolver. */
  warnings: string[];
}
export interface ArtifactRenderer {
  render(subject: ArtifactSubject, format: PayloadFormat): Promise<Result<RenderedArtifact>>;
}
export type EmitFiles = (packageName: string, source: string, options: Record<string, unknown>) => Promise<Result<EmittedFile[]>>;

export interface ProgramPart {
  label: string;
  entityId: string;
  /** null for a draft root. */
  versionId: string | null;
  rootModel: string;
  source: string;
  fields: Array<{ name: string; fieldNumber: number | null }>;
}
export interface Program {
  root: ProgramPart;
  deps: ProgramPart[];
  namespace: string;
}

const MAX_CLOSURE = 64;

async function namespaceFor(db: Db, entityId: string): Promise<Result<string>> {
  const e = await db.entity.findUnique({
    where: { id: entityId },
    select: { tenant: { select: { slug: true } }, domain: { select: { slug: true } }, product: { select: { slug: true } } },
  });
  if (!e) return err({ code: "NOT_FOUND", message: `Entity "${entityId}" not found` });
  return ok(levelNamespace({ tenantSlug: e.tenant.slug, domainSlug: e.domain?.slug ?? null, productSlug: e.product?.slug ?? null }));
}

async function loadVersionPart(db: Db, versionId: string): Promise<Result<{ part: ProgramPart; pins: string[] }>> {
  const v = await db.entityVersion.findUnique({
    where: { id: versionId },
    select: { id: true, entityId: true, major: true, minor: true, resolvedSource: true, fieldSnapshot: true, entity: { select: { name: true } } },
  });
  if (!v) return err({ code: "NOT_FOUND", message: `Entity version "${versionId}" not found` });
  const pins = await db.schemaReference.findMany({
    where: { fromKind: "ENTITY_VERSION", fromId: v.id, role: "FIELD", toKind: "ENTITY_VERSION" },
    select: { toId: true },
    orderBy: { toId: "asc" },
  });
  const snapshot = Array.isArray(v.fieldSnapshot) ? (v.fieldSnapshot as unknown as FieldSnapshot[]) : [];
  return ok({
    part: {
      label: `${v.entity.name}@${formatVersionLabel(v)}`,
      entityId: v.entityId,
      versionId: v.id,
      rootModel: findRootModelName(v.resolvedSource, v.entity.name) ?? sanitizeIdentifier(v.entity.name),
      source: v.resolvedSource,
      fields: snapshot.map((f) => ({ name: f.name, fieldNumber: f.fieldNumber ?? null })),
    },
    pins: pins.map((p) => p.toId),
  });
}

/** BFS over FIELD pins; one version per entity (CONFLICTING_PINS otherwise). */
async function loadClosure(db: Db, start: string[], present: Map<string, ProgramPart>): Promise<Result<ProgramPart[]>> {
  const byEntity = new Map(present);
  const queue = [...start];
  const visited = new Set<string>();
  const out: ProgramPart[] = [];
  while (queue.length > 0) {
    const id = queue.shift() as string;
    if (visited.has(id)) continue;
    visited.add(id);
    if (visited.size > MAX_CLOSURE) {
      return err({ code: "REFERENCE_CLOSURE_TOO_LARGE", message: `More than ${MAX_CLOSURE} referenced entity versions` });
    }
    const loaded = await loadVersionPart(db, id);
    if (!loaded.success) return loaded;
    const { part, pins } = loaded.data;
    const existing = byEntity.get(part.entityId);
    if (existing) {
      if (existing.versionId !== part.versionId) {
        return err({
          code: "CONFLICTING_PINS",
          message: `${existing.label} and ${part.label} are both reachable; one schema cannot contain two versions of the same entity`,
          suggestedFix: "Re-publish the referencing entities so they pin the same version.",
        });
      }
      continue;
    }
    byEntity.set(part.entityId, part);
    out.push(part);
    queue.push(...pins);
  }
  return ok(out);
}

export async function loadProgram(db: Db, subject: ArtifactSubject): Promise<Result<Program>> {
  if (subject.kind === "version") {
    const root = await loadVersionPart(db, subject.entityVersionId);
    if (!root.success) return root;
    const deps = await loadClosure(db, root.data.pins, new Map([[root.data.part.entityId, root.data.part]]));
    if (!deps.success) return deps;
    const namespace = await namespaceFor(db, root.data.part.entityId);
    if (!namespace.success) return namespace;
    return ok({ root: root.data.part, deps: deps.data, namespace: namespace.data });
  }

  const entity = await db.entity.findUnique({
    where: { id: subject.entityId },
    select: {
      id: true, name: true, typespecSource: true, metadata: true,
      fields: { orderBy: { sortOrder: "asc" }, select: { id: true, name: true, fieldNumber: true, decorators: true } },
    },
  });
  if (!entity) return err({ code: "NOT_FOUND", message: `Entity "${subject.entityId}" not found` });
  let source = entity.typespecSource;
  if (!source) {
    const model = await loadEntityModel(db, entity.id);
    if (!model.success) return model;
    source = generateTypeSpec(model.data);
  }
  const root: ProgramPart = {
    label: `${entity.name} (draft)`,
    entityId: entity.id,
    versionId: null,
    rootModel: findRootModelName(source, entity.name) ?? sanitizeIdentifier(entity.name),
    source,
    fields: entity.fields.map((f) => ({ name: f.name, fieldNumber: f.fieldNumber })),
  };
  const refIds = collectReferencedEntityIds(entity.id, entity.fields, entity.metadata);
  const refs = refIds.length > 0
    ? await db.entity.findMany({ where: { id: { in: refIds } }, select: { id: true, name: true, latestVersionId: true } })
    : [];
  const unpublished = refs.filter((r) => !r.latestVersionId).map((r) => r.name);
  if (unpublished.length > 0) {
    return err({ code: "UNPUBLISHED_REFERENCE", message: `${entity.name} references unpublished ${unpublished.join(", ")}; publish them to preview this payload` });
  }
  const deps = await loadClosure(db, refs.map((r) => r.latestVersionId as string), new Map([[entity.id, root]]));
  if (!deps.success) return deps;
  const namespace = await namespaceFor(db, entity.id);
  if (!namespace.success) return namespace;
  return ok({ root, deps: deps.data, namespace: namespace.data });
}

const FORMAT_HEADER: Record<PayloadFormat, { imports: string[]; usings: string[] }> = {
  avro: { imports: [], usings: [] },
  "json-schema": { imports: ['import "@typespec/json-schema";'], usings: [] },
  protobuf: { imports: ['import "@typespec/protobuf";'], usings: ["using TypeSpec.Protobuf;"] },
};

/** The `main.tsp` for one format (D9). */
export function buildTargetSource(format: PayloadFormat, combined: CombinedSource, program: Pick<Program, "root" | "deps" | "namespace">): string {
  const header = FORMAT_HEADER[format];
  const imports = [...new Set([...header.imports, ...combined.imports])];
  const usings = [...new Set([...header.usings, ...combined.usings])];
  let body = stripRealCompileInvalidDecorators(combined.body);
  if (format === "protobuf") {
    body = projectTypeSpecSourceForProtobuf(body);
    for (const part of [program.root, ...program.deps]) body = injectProtobufFieldNumbers(body, part.rootModel, part.fields);
  }
  const namespace = format === "protobuf" ? ["@package", `namespace ${program.namespace};`] : [`namespace ${program.namespace};`];
  return [...imports, ...usings, "", ...namespace, "", body, ""].join("\n");
}

function emitterOptions(format: PayloadFormat, rootModel: string): Record<string, unknown> {
  return format === "json-schema" ? { emitAllModels: true, "file-type": "json", bundleId: rootModel } : {};
}

const basename = (p: string) => p.split(/[\\/]/).pop() ?? p;

function parseJsonFile(file: EmittedFile): Result<JsonObject> {
  try {
    const value: unknown = JSON.parse(file.content);
    return isJsonObject(value) ? ok(value) : err({ code: "ARTIFACT_PARSE_FAILED", message: `${file.relativePath} is not a JSON object` });
  } catch (e) {
    return err({ code: "ARTIFACT_PARSE_FAILED", message: `${file.relativePath}: ${e instanceof Error ? e.message : String(e)}` });
  }
}

export function pickEmittedArtifact(format: PayloadFormat, files: EmittedFile[], rootModel: string): Result<SchemaArtifact> {
  if (format === "avro") {
    const file = files.find((f) => [`${rootModel}.avsc.json`, `${rootModel}.avsc`].includes(basename(f.relativePath)));
    if (!file) return err({ code: "ROOT_SCHEMA_NOT_FOUND", message: `Avro emitter wrote no ${rootModel}.avsc.json (got ${files.map((f) => f.relativePath).join(", ")})` });
    const json = parseJsonFile(file);
    return json.success ? ok({ format: "avro", schema: json.data }) : json;
  }
  if (format === "json-schema") {
    const file = files.find((f) => basename(f.relativePath) === rootModel) ?? (files.length === 1 ? files[0] : undefined);
    if (!file) return err({ code: "ROOT_SCHEMA_NOT_FOUND", message: `JSON Schema emitter wrote no bundle "${rootModel}"` });
    const json = parseJsonFile(file);
    if (!json.success) return json;
    const inlined = inlineJsonSchemaBundle(json.data, rootModel);
    return inlined.success ? ok({ format: "json-schema", dialect: "2020-12", schema: inlined.data }) : inlined;
  }
  const protos = files.filter((f) => f.relativePath.endsWith(".proto"));
  if (protos.length !== 1) return err({ code: "PROTO_NOT_SELF_CONTAINED", message: `Expected one .proto file, got ${protos.length}` });
  const placed = placeRootMessageFirst(protos[0].content, rootModel);
  return placed.success ? ok({ format: "protobuf", schema: placed.data }) : placed;
}

function createLimiter(max: number) {
  let active = 0;
  const waiting: Array<() => void> = [];
  return async function limit<T>(task: () => Promise<T>): Promise<T> {
    if (active >= max) await new Promise<void>((resolve) => waiting.push(resolve));
    active++;
    try {
      return await task();
    } finally {
      active--;
      waiting.shift()?.();
    }
  };
}

export interface ArtifactRendererOptions {
  db: Db;
  emitFiles?: EmitFiles;
  /** LRU size for immutable version renders (default 256). */
  maxEntries?: number;
  /** Concurrent `tsp` processes (default 2 — typespec-cli times out under heavier parallel load). */
  concurrency?: number;
}

export function createArtifactRenderer(options: ArtifactRendererOptions): ArtifactRenderer {
  const emitFiles = options.emitFiles ?? runTypeSpecEmitterFiles;
  const maxEntries = options.maxEntries ?? 256;
  const limit = createLimiter(options.concurrency ?? 2);
  const cache = new Map<string, Promise<Result<RenderedArtifact>>>();

  async function renderUncached(subject: ArtifactSubject, format: PayloadFormat): Promise<Result<RenderedArtifact>> {
    const program = await loadProgram(options.db, subject);
    if (!program.success) return program;
    const parts = [program.data.root, ...program.data.deps];
    const combined = combineTypeSpecSources(parts.map((p) => ({ label: p.label, source: p.source })));
    if (!combined.success) return combined;
    const packageName = getSchemaTargetDefinition(format)?.packageName;
    if (!packageName) return err({ code: "UNSUPPORTED_FORMAT", message: `No TypeSpec emitter for format "${format}"` });
    const source = buildTargetSource(format, combined.data, program.data);
    const files = await limit(() => emitFiles(packageName, source, emitterOptions(format, program.data.root.rootModel)));
    if (!files.success) {
      return err({ code: "ARTIFACT_RENDER_FAILED", message: `${program.data.root.label} → ${format}: ${files.error.message}` });
    }
    const artifact = pickEmittedArtifact(format, files.data, program.data.root.rootModel);
    return artifact.success ? ok({ artifact: artifact.data, warnings: combined.data.warnings }) : artifact;
  }

  return {
    render(subject, format) {
      if (subject.kind === "draft") return renderUncached(subject, format);
      const key = `${subject.entityVersionId}:${format}`;
      const hit = cache.get(key);
      if (hit) {
        cache.delete(key);
        cache.set(key, hit);
        return hit;
      }
      const pending = renderUncached(subject, format).then((r) => {
        if (!r.success) cache.delete(key);
        return r;
      });
      cache.set(key, pending);
      while (cache.size > maxEntries) cache.delete(cache.keys().next().value as string);
      return pending;
    },
  };
}

let shared: ArtifactRenderer | undefined;

/** Process-wide renderer (D9 cache) for server code; tests construct their own. */
export function getSharedArtifactRenderer(db: PrismaClient): ArtifactRenderer {
  shared ??= createArtifactRenderer({ db });
  return shared;
}
```

- [ ] **Step 9: Run the unit tests**

Run: `npx vitest run tests/unit/services/events/artifact-renderer.test.ts tests/unit/lib/events tests/unit/lib/typespec-official`
Expected: PASS.

- [ ] **Step 10: Write the real-emitter integration test** (`tests/integration/services/events/artifact-renderer.test.ts`)

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import type { JsonObject } from "@/lib/event-specs/types";
import type { ServiceContext } from "@/types/service-context";
import { createArtifactRenderer } from "@/services/events/artifact-renderer";
import { cleanupDomains, connectTestDb, createProductScope, testContext, unwrap } from "./helpers";

let prisma: PrismaClient;
let ctx: ServiceContext;
beforeAll(async () => {
  prisma = connectTestDb();
  ctx = await testContext(prisma);
});
afterAll(async () => prisma.$disconnect());

describe.sequential("artifact renderer — real @typespec emitters", () => {
  it("renders Avro, inlined JSON Schema and root-first Protobuf for a pinned version with a referenced entity; drafts too", async () => {
    let domainId: string | undefined;
    try {
      const sc = await createProductScope(prisma, ctx);
      domainId = sc.domain.id;
      const address = await sc.publishedEntity("Address", [{ name: "street", type: "string" }]);
      const order = await sc.publishedEntity("Order", [
        { name: "id", type: "string" },
        { name: "total", type: "int32" },
        { name: "address", type: "reference", ref: { id: address.entity.id, name: "Address" } },
      ]);
      const renderer = createArtifactRenderer({ db: prisma });
      const subject = { kind: "version" as const, entityVersionId: order.version.id };

      const avro = unwrap(await renderer.render(subject, "avro"));
      expect(avro.artifact).toMatchObject({ format: "avro", schema: { type: "record", name: "Order" } });
      expect(JSON.stringify(avro.artifact.schema)).toContain('"name":"Address"');

      const json = unwrap(await renderer.render(subject, "json-schema"));
      const schema = json.artifact.schema as JsonObject;
      expect(json.artifact.dialect).toBe("2020-12");
      expect((schema.properties as JsonObject).address).toEqual({ $ref: "#/$defs/Address" });
      expect(Object.keys(schema.$defs as JsonObject)).toEqual(["Address"]);
      expect(JSON.stringify(schema)).not.toMatch(/"\$ref":"[^#]/);

      const proto = unwrap(await renderer.render(subject, "protobuf"));
      const text = proto.artifact.schema as string;
      expect(text).toContain("// @RootNode\nmessage Order");
      expect(text.indexOf("message Order")).toBeLessThan(text.indexOf("message Address"));

      const draft = await sc.entity("Customer", [{ name: "name", type: "string" }]);
      const draftAvro = unwrap(await renderer.render({ kind: "draft", entityId: draft.id }, "avro"));
      expect(draftAvro.artifact.schema).toMatchObject({ name: "Customer" });
    } finally {
      await cleanupDomains(prisma, [domainId]);
    }
  }, 180_000);
});
```

- [ ] **Step 11: Run it alone**

Run: `npx vitest run tests/integration/services/events/artifact-renderer.test.ts --no-file-parallelism`
Expected: PASS (1 test, ~10–30 s). If protobuf fails on a scalar, that is Story 16.1 (spec O1) — the fixture only uses `string` / `int32`, which the protobuf emitter maps natively.

- [ ] **Step 12: Type check, existing emitter suites, commit**

Run: `npx tsc --noEmit && npx vitest run tests/unit/lib/typespec-official tests/integration/emission-pipeline.test.ts --no-file-parallelism`
Expected: no type errors; emitter suites unchanged (PASS).

```bash
git add src/lib/typespec-official/emitter.service.ts src/lib/events/version-source.ts src/lib/events/json-schema-bundle.ts src/services/events/artifact-renderer.ts tests/unit/lib/events/version-source.test.ts tests/unit/lib/events/json-schema-bundle.test.ts tests/unit/lib/typespec-official/protobuf-field-numbers.test.ts tests/unit/services/events/artifact-renderer.test.ts tests/integration/services/events/artifact-renderer.test.ts
git commit -m "feat(18.4): render payload artifacts from pinned entity versions (combined program, inlined JSON Schema, root-first proto)"
```

---
### Task 6: Bump rules + versioned publish planner (Story 18.3, pure) — Wave 2

**Files:**
- Create: `src/lib/events/bump-rules.ts`, `src/lib/events/publish-plan.ts`
- Test: `tests/unit/lib/events/bump-rules.test.ts`, `tests/unit/lib/events/publish-plan.test.ts`

**Interfaces:**

```ts
// bump-rules.ts
interface BumpDecision { bump: BumpKind; reasons: string[] }
stableStringify(value: unknown): string
classifyMessageBump(prev: MessageResolvedSpec, next: MessageResolvedSpec, traitNames?: Record<string, string>): BumpDecision
interface MessageVersionInfo { messageId: string; messageName: string; major: number; label: string }
interface EventSpecBumpSide { document: EventSpecDocument; channelAddresses: Record<string, string | null>; channelNames: Record<string, string>; messageVersions: Record<string, MessageVersionInfo> }
classifyEventSpecBump(prev: EventSpecBumpSide, next: EventSpecBumpSide): BumpDecision
// publish-plan.ts
type EventPublishBlockerKind = "NO_CHANGES" | "UNPUBLISHED_PIN" | "MISSING_ENTITY" | "MISSING_TRAIT" | "INVALID_SPEC"
  | "NAME_CONFLICT" | "UNPUBLISHED_MESSAGE" | "UNRESOLVED_REFERENCE" | "VALIDATION_ERROR";
interface EventPublishBlocker { kind: EventPublishBlockerKind; message: string; pointer?: string }
interface EventPublishAnalysis { isFirstPublish; latestLabel; suggestedBump; candidateLabels; initialLabel; reasons; blockers }  // satisfies Task 8's PublishPreview
interface EventPublishPlan { version: VersionNumber; label: string; sequence: number; changeKind: ChangeKind; reasons: string[] }
interface LatestVersion extends VersionNumber { sequence: number }
interface VersionedPublishInput { latest: LatestVersion | null; hasChanges: boolean; blockers: EventPublishBlocker[]; bump: BumpDecision | null }
analyzeVersionedPublish(input): EventPublishAnalysis
planVersionedPublish(input, requested?: BumpKind): Result<EventPublishPlan>   // PUBLISH_BLOCKED | BUMP_TOO_LOW
provisionalLabel(analysis): string
interface PinState { role: PinRole; entityId: string; entityName: string | null; version: { id; label; major } | null; latestLabel: string | null }
interface MessagePublishState { name; hasUnpublishedChanges; spec: MessageSpec; pins: PinState[]; missingTraitIds: string[]; traitNames: Record<string, string>; specProblems: string[]; nameConflict: string | null; latest: (LatestVersion & { resolved: MessageResolvedSpec }) | null }
messagePublishInput(state): { input: VersionedPublishInput; resolved: MessageResolvedSpec | null }
interface EventSpecPublishFacts { latest; hasChanges; previous: EventSpecBumpSide | null; current: EventSpecBumpSide; unresolved: { pointer; message }[]; unpublishedMessages: { id; name }[]; diagnostics: Diagnostic[]; nameConflict: string | null }
eventSpecPublishInput(facts): VersionedPublishInput
```

- [ ] **Step 1: Write the failing tests**

`tests/unit/lib/events/bump-rules.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { classifyEventSpecBump, classifyMessageBump, stableStringify, type EventSpecBumpSide } from "@/lib/events/bump-rules";
import type { MessageResolvedSpec, ResolvedPin } from "@/lib/events/types";

const pin = (entityName: string, label: string, entityId = `e-${entityName}`): ResolvedPin => ({
  entityId, entityName, entityVersionId: `${entityName}@${label}`, label, major: Number(label.split(".")[0]),
});
const msg = (over: Partial<MessageResolvedSpec> = {}, spec: Partial<MessageResolvedSpec["spec"]> = {}): MessageResolvedSpec => ({
  name: "OrderCreated",
  spec: { contentType: "avro/binary", traitIds: ["t-ce"], ...spec },
  payload: pin("Order", "2.1"),
  headers: null,
  key: pin("OrderKey", "1.0"),
  ...over,
});

describe("classifyMessageBump (spec §6.1)", () => {
  it("MINOR for a minor entity bump, docs, examples, tags", () => {
    expect(classifyMessageBump(msg(), msg({ payload: pin("Order", "2.2") }, { description: "d", examples: [{ payload: {} }] }))).toEqual({
      bump: "MINOR",
      reasons: ["Payload pin moved from v2.1 to v2.2", "Documentation changed", "Examples changed"],
    });
    expect(classifyMessageBump(msg(), msg())).toEqual({ bump: "MINOR", reasons: [] });
  });

  it("MAJOR when a pin moves to a new major, switches entity or a role is removed; adding a role is MINOR (D6)", () => {
    expect(classifyMessageBump(msg(), msg({ payload: pin("Order", "3.0") })).bump).toBe("MAJOR");
    expect(classifyMessageBump(msg(), msg({ payload: pin("Invoice", "1.0") })).reasons).toEqual(["Payload now references Invoice instead of Order"]);
    expect(classifyMessageBump(msg(), msg({ key: null }))).toEqual({ bump: "MAJOR", reasons: ["Kafka key removed (was OrderKey v1.0)"] });
    expect(classifyMessageBump(msg(), msg({ headers: pin("CloudEventsHeaders", "1.0") }))).toEqual({ bump: "MINOR", reasons: ["Headers added: CloudEventsHeaders v1.0"] });
  });

  it("MAJOR when a trait is removed or contentType / correlationId changes", () => {
    expect(classifyMessageBump(msg(), msg({}, { traitIds: [] }), { "t-ce": "CloudEvents" })).toEqual({ bump: "MAJOR", reasons: ["Trait CloudEvents removed"] });
    expect(classifyMessageBump(msg(), msg({}, { contentType: "application/json" })).reasons).toEqual(['contentType changed from "avro/binary" to "application/json"']);
    expect(classifyMessageBump(msg(), msg({}, { correlationId: { location: "$message.header#/id" } })).bump).toBe("MAJOR");
    expect(classifyMessageBump(msg(), msg({}, { traitIds: ["t-ce", "t-x"] })).bump).toBe("MINOR");
  });

  it("stableStringify ignores key order and undefined values", () => {
    expect(stableStringify({ b: 1, a: { d: undefined, c: [2] } })).toBe(stableStringify({ a: { c: [2] }, b: 1 }));
  });
});

const side = (operations: EventSpecBumpSide["document"]["operations"], over: Partial<EventSpecBumpSide> = {}): EventSpecBumpSide => ({
  document: { info: { title: "checkout-service" }, servers: [{ key: "kafka-prod", protocol: "kafka", host: "k:9092" }], operations },
  channelAddresses: { ch: "payments.orders.v1" },
  channelNames: { ch: "orders" },
  messageVersions: {
    "mv-1.3": { messageId: "m1", messageName: "OrderCreated", major: 1, label: "1.3" },
    "mv-1.4": { messageId: "m1", messageName: "OrderCreated", major: 1, label: "1.4" },
    "mv-2.0": { messageId: "m1", messageName: "OrderCreated", major: 2, label: "2.0" },
    "mv-c": { messageId: "m2", messageName: "OrderCancelled", major: 1, label: "1.0" },
  },
  ...over,
});
const op = (key: string, messageVersionIds: string[], over: Record<string, unknown> = {}) => ({ key, action: "send" as const, channelId: "ch", messageVersionIds, traitIds: [], ...over });

describe("classifyEventSpecBump (spec §6.1)", () => {
  const base = side([op("publishOrderCreated", ["mv-1.3", "mv-c"])]);

  it("MINOR for added operations / messages, minor message moves, servers and info", () => {
    const next = side([op("publishOrderCreated", ["mv-1.4", "mv-c"]), op("publishRefund", ["mv-c"])], {
      document: { info: { title: "checkout-service", description: "x" }, servers: [], operations: [op("publishOrderCreated", ["mv-1.4", "mv-c"]), op("publishRefund", ["mv-c"])] },
    });
    expect(classifyEventSpecBump(base, next)).toEqual({
      bump: "MINOR",
      reasons: [
        'Message OrderCreated moved from v1.3 to v1.4 in "publishOrderCreated"',
        'Operation "publishRefund" added',
        "Info, servers or components changed",
      ],
    });
  });

  it("MAJOR for removed operations, removed messages, new-major messages, address changes, action / channel changes", () => {
    expect(classifyEventSpecBump(base, side([])).reasons).toEqual(['Operation "publishOrderCreated" removed']);
    expect(classifyEventSpecBump(base, side([op("publishOrderCreated", ["mv-1.3"])])).reasons).toEqual([
      'Message OrderCancelled removed from operation "publishOrderCreated"',
    ]);
    expect(classifyEventSpecBump(base, side([op("publishOrderCreated", ["mv-2.0", "mv-c"])])).reasons).toEqual([
      'Message OrderCreated moved from v1.3 to v2.0 (new major) in "publishOrderCreated"',
    ]);
    expect(classifyEventSpecBump(base, side(base.document.operations, { channelAddresses: { ch: "payments.orders.v2" } })).reasons).toEqual([
      'Channel orders address changed from "payments.orders.v1" to "payments.orders.v2"',
    ]);
    expect(classifyEventSpecBump(base, side([op("publishOrderCreated", ["mv-1.3", "mv-c"], { action: "receive" })])).bump).toBe("MAJOR");
    expect(classifyEventSpecBump(base, side([op("publishOrderCreated", ["mv-1.3", "mv-c"], { channelId: "other" })])).bump).toBe("MAJOR");
  });
});
```

`tests/unit/lib/events/publish-plan.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  analyzeVersionedPublish, eventSpecPublishInput, messagePublishInput, planVersionedPublish, provisionalLabel,
  type MessagePublishState,
} from "@/lib/events/publish-plan";
import type { EventSpecBumpSide } from "@/lib/events/bump-rules";

const latest = { major: 1, minor: 3, sequence: 4 };

describe("versioned publish planner", () => {
  it("first publish is 1.0 INITIAL at sequence 1", () => {
    const input = { latest: null, hasChanges: true, blockers: [], bump: null };
    expect(analyzeVersionedPublish(input)).toMatchObject({ isFirstPublish: true, initialLabel: "1.0", candidateLabels: null });
    expect(planVersionedPublish(input)).toEqual({ success: true, data: { version: { major: 1, minor: 0 }, label: "1.0", sequence: 1, changeKind: "INITIAL", reasons: [] } });
  });

  it("blocks with NO_CHANGES (first) plus every other blocker, all together", () => {
    const r = planVersionedPublish({ latest, hasChanges: false, blockers: [{ kind: "NAME_CONFLICT", message: "taken" }], bump: { bump: "MINOR", reasons: [] } });
    expect(!r.success && r.error.code).toBe("PUBLISH_BLOCKED");
    expect(!r.success && (r.error.details as { blockers: Array<{ kind: string }> }).blockers.map((b) => b.kind)).toEqual(["NO_CHANGES", "NAME_CONFLICT"]);
  });

  it("is raise-only (spec Q6)", () => {
    const major = { latest, hasChanges: true, blockers: [], bump: { bump: "MAJOR" as const, reasons: ["Trait removed"] } };
    expect(planVersionedPublish(major, "MINOR")).toMatchObject({ success: false, error: { code: "BUMP_TOO_LOW" } });
    expect(planVersionedPublish(major)).toMatchObject({ success: true, data: { label: "2.0", sequence: 5, changeKind: "MAJOR", reasons: ["Trait removed"] } });
    const minor = { ...major, bump: { bump: "MINOR" as const, reasons: [] } };
    expect(planVersionedPublish(minor)).toMatchObject({ success: true, data: { label: "1.4", changeKind: "MINOR" } });
    expect(planVersionedPublish(minor, "MAJOR")).toMatchObject({ success: true, data: { label: "2.0" } });
    expect(provisionalLabel(analyzeVersionedPublish(minor))).toBe("1.4");
  });
});

describe("messagePublishInput", () => {
  const state = (over: Partial<MessagePublishState> = {}): MessagePublishState => ({
    name: "OrderCreated",
    hasUnpublishedChanges: true,
    spec: { traitIds: ["t1"] },
    pins: [
      { role: "payload", entityId: "e1", entityName: "Order", version: { id: "v21", label: "2.1", major: 2 }, latestLabel: "2.1" },
      { role: "key", entityId: "e2", entityName: "OrderKey", version: null, latestLabel: "1.0" },
      { role: "headers", entityId: "e3", entityName: "Headers", version: null, latestLabel: null },
    ],
    missingTraitIds: ["t9"],
    traitNames: {},
    specProblems: ["contentType must not contain whitespace"],
    nameConflict: '"OrderCreated" is already used by Entity "OrderCreated" at Product level.',
    latest: null,
    ...over,
  });

  it("reports unpublished pins, missing traits, spec problems and name conflicts together; no resolved spec", () => {
    const { input, resolved } = messagePublishInput(state());
    expect(resolved).toBeNull();
    expect(input.blockers.map((b) => b.message)).toEqual([
      "Kafka key: pick a published version of OrderKey (latest is v1.0)",
      "Headers: publish Headers first, then pin its version",
      'Trait "t9" no longer exists or is not a MESSAGE trait',
      "contentType must not contain whitespace",
      '"OrderCreated" is already used by Entity "OrderCreated" at Product level.',
    ]);
  });

  it("builds the frozen MessageResolvedSpec and classifies against the latest version", () => {
    const prev = { name: "OrderCreated", spec: { traitIds: ["t1"] }, payload: { entityId: "e1", entityName: "Order", entityVersionId: "v13", label: "1.3", major: 1 }, headers: null, key: null };
    const { input, resolved } = messagePublishInput(
      state({
        pins: [{ role: "payload", entityId: "e1", entityName: "Order", version: { id: "v21", label: "2.1", major: 2 }, latestLabel: "2.1" }],
        missingTraitIds: [], specProblems: [], nameConflict: null,
        latest: { ...latest, resolved: prev },
      })
    );
    expect(resolved).toEqual({ name: "OrderCreated", spec: { traitIds: ["t1"] }, payload: { entityId: "e1", entityName: "Order", entityVersionId: "v21", label: "2.1", major: 2 }, headers: null, key: null });
    expect(input.bump).toEqual({ bump: "MAJOR", reasons: ["Payload pin moved from Order v1.3 to v2.1 (new major)"] });
  });
});

describe("eventSpecPublishInput", () => {
  const current: EventSpecBumpSide = { document: { info: { title: "x" }, servers: [], operations: [] }, channelAddresses: {}, channelNames: {}, messageVersions: {} };

  it("turns unresolved refs, draft messages and error diagnostics (capped at 20) into blockers; warnings never block", () => {
    const errors = Array.from({ length: 22 }, (_, i) => ({ severity: "error" as const, code: "E", message: `e${i}`, pointer: `/p/${i}` }));
    const input = eventSpecPublishInput({
      latest: null, hasChanges: true, previous: null, current,
      unresolved: [{ pointer: "/operations/0/channelId", message: 'Channel "c9" not found' }],
      unpublishedMessages: [{ id: "m1", name: "OrderCreated" }],
      diagnostics: [...errors, { severity: "warning", code: "W", message: "w", pointer: "" }],
      nameConflict: null,
    });
    expect(input.blockers.slice(0, 3)).toEqual([
      { kind: "UNRESOLVED_REFERENCE", message: 'Channel "c9" not found', pointer: "/operations/0/channelId" },
      { kind: "UNPUBLISHED_MESSAGE", message: "Message OrderCreated is an unpublished draft — publish it and pick its version" },
      { kind: "VALIDATION_ERROR", message: "E: e0", pointer: "/p/0" },
    ]);
    expect(input.blockers).toHaveLength(2 + 20 + 1);
    expect(input.blockers.at(-1)).toEqual({ kind: "VALIDATION_ERROR", message: "…and 2 more validation error(s)" });
    expect(input.bump).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/unit/lib/events/bump-rules.test.ts tests/unit/lib/events/publish-plan.test.ts`
Expected: FAIL — missing modules.

- [ ] **Step 3: Implement `src/lib/events/bump-rules.ts`**

```ts
import type { BumpKind } from "@/lib/entity-versioning/types";
import type { EventSpecDocument, EventSpecOperation } from "@/lib/event-specs/types";
import type { MessageResolvedSpec, MessageSpec, ResolvedPin } from "./types";

export interface BumpDecision {
  bump: BumpKind;
  reasons: string[];
}

/** Key-order independent JSON (undefined members dropped) for structural equality. */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((k) => record[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(record[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

const same = (a: unknown, b: unknown) => stableStringify(a) === stableStringify(b);
const decide = (major: string[], minor: string[]): BumpDecision =>
  major.length > 0 ? { bump: "MAJOR", reasons: [...major, ...minor] } : { bump: "MINOR", reasons: minor };

function comparePin(role: string, prev: ResolvedPin | null, next: ResolvedPin | null, major: string[], minor: string[]): void {
  if (!prev && !next) return;
  if (prev && !next) {
    major.push(`${role} removed (was ${prev.entityName} v${prev.label})`);
    return;
  }
  if (!prev && next) {
    minor.push(`${role} added: ${next.entityName} v${next.label}`);
    return;
  }
  const p = prev as ResolvedPin;
  const n = next as ResolvedPin;
  if (p.entityId !== n.entityId) major.push(`${role} now references ${n.entityName} instead of ${p.entityName}`);
  else if (p.major !== n.major) major.push(`${role} pin moved from ${p.entityName} v${p.label} to v${n.label} (new major)`);
  else if (p.entityVersionId !== n.entityVersionId) minor.push(`${role} pin moved from v${p.label} to v${n.label}`);
}

const docsOf = (s: MessageSpec) => ({ title: s.title, summary: s.summary, description: s.description, tags: s.tags, externalDocs: s.externalDocs });

/** Spec §6.1 Message bump rules + D6. */
export function classifyMessageBump(prev: MessageResolvedSpec, next: MessageResolvedSpec, traitNames: Record<string, string> = {}): BumpDecision {
  const major: string[] = [];
  const minor: string[] = [];
  const traitName = (id: string) => traitNames[id] ?? id;
  comparePin("Payload", prev.payload, next.payload, major, minor);
  comparePin("Headers", prev.headers, next.headers, major, minor);
  comparePin("Kafka key", prev.key, next.key, major, minor);
  for (const id of prev.spec.traitIds) if (!next.spec.traitIds.includes(id)) major.push(`Trait ${traitName(id)} removed`);
  for (const id of next.spec.traitIds) if (!prev.spec.traitIds.includes(id)) minor.push(`Trait ${traitName(id)} added`);
  if ((prev.spec.contentType ?? "") !== (next.spec.contentType ?? "")) {
    major.push(`contentType changed from "${prev.spec.contentType ?? "(default)"}" to "${next.spec.contentType ?? "(default)"}"`);
  }
  if (!same(prev.spec.correlationId, next.spec.correlationId)) major.push("correlationId changed");
  if (prev.name !== next.name) minor.push(`Renamed from ${prev.name} to ${next.name}`);
  if (!same(docsOf(prev.spec), docsOf(next.spec))) minor.push("Documentation changed");
  if (!same(prev.spec.examples, next.spec.examples)) minor.push("Examples changed");
  if (!same(prev.spec.bindings, next.spec.bindings)) minor.push("Bindings changed");
  return decide(major, minor);
}

export interface MessageVersionInfo {
  messageId: string;
  messageName: string;
  major: number;
  label: string;
}

export interface EventSpecBumpSide {
  document: EventSpecDocument;
  /** Channel id → address (frozen copy for the previous side, live for the current side). */
  channelAddresses: Record<string, string | null>;
  channelNames: Record<string, string>;
  /** MessageVersion id → info, for every version id used by this side. */
  messageVersions: Record<string, MessageVersionInfo>;
}

function compareMessages(label: string, prevIds: string[], nextIds: string[], prev: EventSpecBumpSide, next: EventSpecBumpSide, major: string[], minor: string[]): void {
  const byMessage = (ids: string[], side: EventSpecBumpSide) => {
    const map = new Map<string, MessageVersionInfo>();
    for (const id of ids) {
      const info = side.messageVersions[id];
      if (info) map.set(info.messageId, info);
    }
    return map;
  };
  const p = byMessage(prevIds, prev);
  const n = byMessage(nextIds, next);
  for (const [messageId, before] of p) {
    const after = n.get(messageId);
    if (!after) major.push(`Message ${before.messageName} removed from operation "${label}"`);
    else if (after.major !== before.major) major.push(`Message ${before.messageName} moved from v${before.label} to v${after.label} (new major) in "${label}"`);
    else if (after.label !== before.label) minor.push(`Message ${before.messageName} moved from v${before.label} to v${after.label} in "${label}"`);
  }
  for (const [messageId, after] of n) if (!p.has(messageId)) minor.push(`Message ${after.messageName} added to "${label}"`);
}

const opDetails = (o: EventSpecOperation) => ({ summary: o.summary, description: o.description, bindings: o.bindings, traitIds: o.traitIds });

/** Spec §6.1 Event Spec bump rules + D6. */
export function classifyEventSpecBump(prev: EventSpecBumpSide, next: EventSpecBumpSide): BumpDecision {
  const major: string[] = [];
  const minor: string[] = [];
  const nextOps = new Map(next.document.operations.map((o) => [o.key, o]));
  const prevKeys = new Set(prev.document.operations.map((o) => o.key));

  for (const p of prev.document.operations) {
    const n = nextOps.get(p.key);
    if (!n) {
      major.push(`Operation "${p.key}" removed`);
      continue;
    }
    if (p.action !== n.action) major.push(`Operation "${p.key}" action changed from ${p.action} to ${n.action}`);
    if (p.channelId !== n.channelId) major.push(`Operation "${p.key}" moved to another channel`);
    compareMessages(p.key, p.messageVersionIds, n.messageVersionIds, prev, next, major, minor);
    if (p.reply && !n.reply) major.push(`Operation "${p.key}" reply removed`);
    else if (p.reply && n.reply) {
      if ((p.reply.channelId ?? null) !== (n.reply.channelId ?? null)) major.push(`Operation "${p.key}" reply moved to another channel`);
      compareMessages(`${p.key} reply`, p.reply.messageVersionIds ?? [], n.reply.messageVersionIds ?? [], prev, next, major, minor);
    } else if (!p.reply && n.reply) minor.push(`Operation "${p.key}" reply added`);
    if (!same(opDetails(p), opDetails(n))) minor.push(`Operation "${p.key}" details changed`);
  }
  for (const n of next.document.operations) if (!prevKeys.has(n.key)) minor.push(`Operation "${n.key}" added`);

  for (const [id, before] of Object.entries(prev.channelAddresses)) {
    if (!(id in next.channelAddresses)) continue;
    const after = next.channelAddresses[id];
    if (after !== before) major.push(`Channel ${next.channelNames[id] ?? prev.channelNames[id] ?? id} address changed from "${before}" to "${after}"`);
  }

  const shell = (d: EventSpecDocument) => ({ info: d.info, servers: d.servers, defaultContentType: d.defaultContentType, components: d.components });
  if (!same(shell(prev.document), shell(next.document))) minor.push("Info, servers or components changed");
  return decide(major, minor);
}
```

- [ ] **Step 4: Implement `src/lib/events/publish-plan.ts`**

```ts
import { ok, err, type Result } from "@/types/result";
import type { BumpKind, ChangeKind, VersionNumber } from "@/lib/entity-versioning/types";
import { INITIAL_VERSION, formatVersionLabel, nextVersionNumber, resolveBump } from "@/lib/entity-versioning/version-math";
import type { Diagnostic } from "@/lib/event-specs/types";
import { classifyEventSpecBump, classifyMessageBump, type BumpDecision, type EventSpecBumpSide } from "./bump-rules";
import type { MessageResolvedSpec, MessageSpec, PinRole, ResolvedPin } from "./types";

export type EventPublishBlockerKind =
  | "NO_CHANGES" | "UNPUBLISHED_PIN" | "MISSING_ENTITY" | "MISSING_TRAIT" | "INVALID_SPEC"
  | "NAME_CONFLICT" | "UNPUBLISHED_MESSAGE" | "UNRESOLVED_REFERENCE" | "VALIDATION_ERROR";

export interface EventPublishBlocker {
  kind: EventPublishBlockerKind;
  message: string;
  pointer?: string;
}

/** What the publish dialog shows (structurally a `PublishPreview`, Task 8). Never fails — blockers are data. */
export interface EventPublishAnalysis {
  isFirstPublish: boolean;
  latestLabel: string | null;
  suggestedBump: BumpKind | null;
  candidateLabels: Record<BumpKind, string> | null;
  initialLabel: string;
  reasons: string[];
  blockers: EventPublishBlocker[];
}

export interface EventPublishPlan {
  version: VersionNumber;
  label: string;
  sequence: number;
  changeKind: ChangeKind;
  reasons: string[];
}

export interface LatestVersion extends VersionNumber {
  sequence: number;
}

export interface VersionedPublishInput {
  latest: LatestVersion | null;
  hasChanges: boolean;
  blockers: EventPublishBlocker[];
  /** null when it cannot be classified yet (e.g. an unpublished pin); ignored on a first publish. */
  bump: BumpDecision | null;
}

export function analyzeVersionedPublish(input: VersionedPublishInput): EventPublishAnalysis {
  const blockers = [...input.blockers];
  if (input.latest && !input.hasChanges) {
    blockers.unshift({ kind: "NO_CHANGES", message: `No unpublished changes since v${formatVersionLabel(input.latest)}.` });
  }
  const initialLabel = formatVersionLabel(INITIAL_VERSION);
  if (!input.latest) {
    return { isFirstPublish: true, latestLabel: null, suggestedBump: null, candidateLabels: null, initialLabel, reasons: [], blockers };
  }
  return {
    isFirstPublish: false,
    latestLabel: formatVersionLabel(input.latest),
    suggestedBump: input.bump?.bump ?? null,
    candidateLabels: {
      MAJOR: formatVersionLabel(nextVersionNumber(input.latest, "MAJOR").version),
      MINOR: formatVersionLabel(nextVersionNumber(input.latest, "MINOR").version),
    },
    initialLabel,
    reasons: input.bump?.reasons ?? [],
    blockers,
  };
}

/** The version a publish will write, or every blocker at once (spec §10); raise-only bump (spec Q6). */
export function planVersionedPublish(input: VersionedPublishInput, requested?: BumpKind): Result<EventPublishPlan> {
  const analysis = analyzeVersionedPublish(input);
  if (analysis.blockers.length > 0) {
    return err({
      code: "PUBLISH_BLOCKED",
      message: analysis.blockers.map((b) => b.message).join("; "),
      details: { blockers: analysis.blockers },
      suggestedFix: "Resolve every blocker, then publish again.",
    });
  }
  if (!input.latest) {
    return ok({ version: INITIAL_VERSION, label: formatVersionLabel(INITIAL_VERSION), sequence: 1, changeKind: "INITIAL", reasons: [] });
  }
  const bump = resolveBump(analysis.suggestedBump ?? "MINOR", requested);
  if (!bump.success) return bump;
  const { version, changeKind } = nextVersionNumber(input.latest, bump.data);
  return ok({ version, label: formatVersionLabel(version), sequence: input.latest.sequence + 1, changeKind, reasons: analysis.reasons });
}

/** Label a publish would get with the suggested bump — used to emit `info.version` when blockers prevent planning. */
export function provisionalLabel(analysis: EventPublishAnalysis): string {
  if (analysis.isFirstPublish || !analysis.candidateLabels) return analysis.initialLabel;
  return analysis.candidateLabels[analysis.suggestedBump ?? "MINOR"];
}

// ── Message ────────────────────────────────────────────────────────────────

export interface PinState {
  role: PinRole;
  entityId: string;
  /** null = the entity no longer exists. */
  entityName: string | null;
  /** The pinned published version; null = unpinned. */
  version: { id: string; label: string; major: number } | null;
  /** The entity's latest published version, for the message text. */
  latestLabel: string | null;
}

export interface MessagePublishState {
  name: string;
  hasUnpublishedChanges: boolean;
  spec: MessageSpec;
  /** Roles in use only (payload always). */
  pins: PinState[];
  missingTraitIds: string[];
  traitNames: Record<string, string>;
  specProblems: string[];
  nameConflict: string | null;
  latest: (LatestVersion & { resolved: MessageResolvedSpec }) | null;
}

const ROLE_LABEL: Record<PinRole, string> = { payload: "Payload", headers: "Headers", key: "Kafka key" };

export function messagePublishInput(state: MessagePublishState): { input: VersionedPublishInput; resolved: MessageResolvedSpec | null } {
  const blockers: EventPublishBlocker[] = [];
  const pins: Partial<Record<PinRole, ResolvedPin>> = {};
  for (const pin of state.pins) {
    const label = ROLE_LABEL[pin.role];
    if (pin.entityName === null) blockers.push({ kind: "MISSING_ENTITY", message: `${label} entity "${pin.entityId}" no longer exists` });
    else if (!pin.version) {
      blockers.push({
        kind: "UNPUBLISHED_PIN",
        message: pin.latestLabel
          ? `${label}: pick a published version of ${pin.entityName} (latest is v${pin.latestLabel})`
          : `${label}: publish ${pin.entityName} first, then pin its version`,
      });
    } else {
      pins[pin.role] = { entityId: pin.entityId, entityName: pin.entityName, entityVersionId: pin.version.id, label: pin.version.label, major: pin.version.major };
    }
  }
  for (const id of state.missingTraitIds) blockers.push({ kind: "MISSING_TRAIT", message: `Trait "${id}" no longer exists or is not a MESSAGE trait` });
  for (const p of state.specProblems) blockers.push({ kind: "INVALID_SPEC", message: p });
  if (state.nameConflict) blockers.push({ kind: "NAME_CONFLICT", message: state.nameConflict });

  const pinsResolved = !blockers.some((b) => b.kind === "UNPUBLISHED_PIN" || b.kind === "MISSING_ENTITY");
  const resolved: MessageResolvedSpec | null =
    pins.payload && pinsResolved
      ? { name: state.name, spec: state.spec, payload: pins.payload, headers: pins.headers ?? null, key: pins.key ?? null }
      : null;
  const bump = state.latest && resolved ? classifyMessageBump(state.latest.resolved, resolved, state.traitNames) : null;
  const latest = state.latest ? { major: state.latest.major, minor: state.latest.minor, sequence: state.latest.sequence } : null;
  return { input: { latest, hasChanges: state.hasUnpublishedChanges, blockers, bump }, resolved };
}

// ── Event Spec ─────────────────────────────────────────────────────────────

export interface EventSpecPublishFacts {
  latest: LatestVersion | null;
  /** D8: draft dirty or live channels / traits differ from the frozen copies. */
  hasChanges: boolean;
  previous: EventSpecBumpSide | null;
  current: EventSpecBumpSide;
  unresolved: Array<{ pointer: string; message: string }>;
  unpublishedMessages: Array<{ id: string; name: string }>;
  diagnostics: Diagnostic[];
  nameConflict: string | null;
}

const MAX_DIAGNOSTIC_BLOCKERS = 20;

export function eventSpecPublishInput(facts: EventSpecPublishFacts): VersionedPublishInput {
  const blockers: EventPublishBlocker[] = [];
  for (const p of facts.unresolved) blockers.push({ kind: "UNRESOLVED_REFERENCE", message: p.message, pointer: p.pointer });
  for (const m of facts.unpublishedMessages) {
    blockers.push({ kind: "UNPUBLISHED_MESSAGE", message: `Message ${m.name} is an unpublished draft — publish it and pick its version` });
  }
  const errors = facts.diagnostics.filter((d) => d.severity === "error");
  for (const d of errors.slice(0, MAX_DIAGNOSTIC_BLOCKERS)) blockers.push({ kind: "VALIDATION_ERROR", message: `${d.code}: ${d.message}`, pointer: d.pointer });
  if (errors.length > MAX_DIAGNOSTIC_BLOCKERS) {
    blockers.push({ kind: "VALIDATION_ERROR", message: `…and ${errors.length - MAX_DIAGNOSTIC_BLOCKERS} more validation error(s)` });
  }
  if (facts.nameConflict) blockers.push({ kind: "NAME_CONFLICT", message: facts.nameConflict });
  const bump = facts.previous ? classifyEventSpecBump(facts.previous, facts.current) : null;
  return { latest: facts.latest, hasChanges: facts.hasChanges, blockers, bump };
}
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/unit/lib/events/bump-rules.test.ts tests/unit/lib/events/publish-plan.test.ts && npx tsc --noEmit`
Expected: PASS; no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/lib/events/bump-rules.ts src/lib/events/publish-plan.ts tests/unit/lib/events/bump-rules.test.ts tests/unit/lib/events/publish-plan.test.ts
git commit -m "feat(18.3): message + event spec bump rules and raise-only versioned publish planner"
```

---
### Task 7: Navigation data — `assetHref` events kind, explorer counts, sidebar leaves, New-menu items (Story 18.8) — Wave 2

**Files:**
- Modify: `src/lib/navigation/asset-href.ts`, `src/lib/navigation/build-explorer-tree.ts`, `src/app/api/domains-tree/route.ts`, `src/components/layout/LeftSidebar.tsx`, `src/app/(dashboard)/schemas/[domainSlug]/components/CreateDropdown.tsx`
- Test: `tests/unit/lib/navigation/asset-href-events.test.ts`, `tests/unit/lib/build-explorer-tree-events.test.ts`, `tests/unit/components/left-sidebar-events.test.tsx`, `tests/unit/components/create-dropdown-events.test.tsx`

**Interfaces:**

```ts
// asset-href.ts
type EventsSection = "specs" | "messages" | "channels";
AssetRef |= { kind: "events"; domainSlug: string; productSlug: string; section?: EventsSection }   // → ?tab=events&section=<s> (default specs)
// build-explorer-tree.ts — ExplorerRows gains optional traits / messages / channels / eventSpecs: LevelRow[]
// CreateDropdown — new optional props onNewEventSpec / onNewMessage / onNewChannel / onNewTrait (item shown only when passed)
```

- [ ] **Step 1: Write the failing tests**

`tests/unit/lib/navigation/asset-href-events.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { assetHref } from "@/lib/navigation/asset-href";

describe("assetHref — events kinds", () => {
  it("links the product Events tab with a section (default specs)", () => {
    expect(assetHref({ kind: "events", domainSlug: "payments", productSlug: "checkout" })).toBe("/schemas/payments/checkout?tab=events&section=specs");
    expect(assetHref({ kind: "events", domainSlug: "payments", productSlug: "checkout", section: "channels" })).toBe(
      "/schemas/payments/checkout?tab=events&section=channels"
    );
  });

  it("links detail pages for every level and versions", () => {
    expect(assetHref({ kind: "eventSpec", id: "s1", domainSlug: "payments", productSlug: "checkout" }, { version: "2.0" })).toBe(
      "/schemas/payments/checkout/specs/s1?version=2.0"
    );
    expect(assetHref({ kind: "message", id: "m 1", domainSlug: "payments", productSlug: "checkout" })).toBe("/schemas/payments/checkout/messages/m%201");
    expect(assetHref({ kind: "channel", id: "c1", domainSlug: "payments", productSlug: "checkout" })).toBe("/schemas/payments/checkout/channels/c1");
    expect(assetHref({ kind: "trait", id: "t1", domainSlug: null, productSlug: null })).toBe("/schemas/enterprise/traits/t1");
    expect(assetHref({ kind: "trait", id: "t1", domainSlug: "payments", productSlug: null })).toBe("/schemas/payments/traits/t1");
    expect(assetHref({ kind: "traits", domainSlug: null, productSlug: null })).toBe("/schemas/enterprise?tab=traits");
  });
});
```

`tests/unit/lib/build-explorer-tree-events.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { buildExplorerTree } from "@/lib/navigation/build-explorer-tree";

describe("buildExplorerTree — events counts", () => {
  it("counts traits at every level and messages / channels / event specs per product", () => {
    const tree = buildExplorerTree({
      domains: [{ id: "d1", name: "Payments", slug: "payments", isSystem: false }],
      products: [{ id: "p1", domainId: "d1", name: "Checkout", slug: "checkout", isSystem: false }],
      entities: [],
      dataTypes: [],
      services: [],
      traits: [{ domainId: null, productId: null }, { domainId: "d1", productId: null }, { domainId: "d1", productId: "p1" }],
      messages: [{ domainId: "d1", productId: "p1" }, { domainId: "d1", productId: "p1" }],
      channels: [{ domainId: "d1", productId: "p1" }],
      eventSpecs: [],
    });
    expect(tree.enterprise.counts.traits).toBe(1);
    expect(tree.domains[0].counts.traits).toBe(1);
    expect(tree.domains[0].products[0].counts).toMatchObject({ traits: 1, messages: 2, channels: 1, eventSpecs: 0 });
  });
});
```

`tests/unit/components/left-sidebar-events.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LeftSidebar } from "@/components/layout/LeftSidebar";

const push = vi.fn();
const location = vi.hoisted(() => ({ pathname: "/schemas/payments", search: "" }));
vi.mock("next/navigation", () => ({
  usePathname: () => location.pathname,
  useRouter: () => ({ push }),
  useSearchParams: () => new URLSearchParams(location.search),
}));

const tree = {
  enterprise: { counts: { dataTypes: 0, entities: 0, traits: 3 }, entities: [] },
  domains: [
    {
      id: "d1", name: "Payments", slug: "payments", isSystem: false,
      counts: { dataTypes: 0, apis: 0, traits: 1 },
      products: [
        {
          id: "p1", name: "Checkout", slug: "checkout", isSystem: false,
          counts: { dataTypes: 0, apis: 0, entities: 0, traits: 1, messages: 1, channels: 0, eventSpecs: 2 },
          entities: [],
        },
        {
          id: "p2", name: "Ledger", slug: "ledger", isSystem: false,
          counts: { dataTypes: 0, apis: 0, entities: 0, traits: 0, messages: 0, channels: 0, eventSpecs: 0 },
          entities: [],
        },
      ],
    },
  ],
};
vi.mock("@/hooks/useDomainsTree", () => ({
  useDomainsTree: () => ({ data: tree, isLoading: false, isError: false, refetch: vi.fn() }),
}));

const props = { width: 260, isCollapsed: false, onMouseDown: vi.fn(), onDoubleClick: vi.fn() };

describe("LeftSidebar — events leaves (spec §4.6)", () => {
  beforeEach(() => {
    push.mockReset();
    location.pathname = "/schemas/payments";
    location.search = "";
  });
  afterEach(() => cleanup());

  it("shows non-empty Event Specs / Messages / Traits leaves and hides empty ones", () => {
    render(<LeftSidebar {...props} />);
    expect(screen.queryByTestId("product-p1-channels")).toBeNull();
    expect(screen.queryByTestId("product-p2-event-specs")).toBeNull();
    expect(screen.queryByTestId("product-p2-traits")).toBeNull();
    fireEvent.click(screen.getByTestId("product-p1-event-specs"));
    expect(push).toHaveBeenLastCalledWith("/schemas/payments/checkout?tab=events&section=specs");
    fireEvent.click(screen.getByTestId("product-p1-messages"));
    expect(push).toHaveBeenLastCalledWith("/schemas/payments/checkout?tab=events&section=messages");
    fireEvent.click(screen.getByTestId("product-p1-traits"));
    expect(push).toHaveBeenLastCalledWith("/schemas/payments/checkout?tab=traits");
  });

  it("shows Traits under the domain and the Enterprise", () => {
    render(<LeftSidebar {...props} />);
    fireEvent.click(screen.getByTestId("domain-d1-traits"));
    expect(push).toHaveBeenLastCalledWith("/schemas/payments?tab=traits");
    fireEvent.click(screen.getByTestId("enterprise-traits"));
    expect(push).toHaveBeenLastCalledWith("/schemas/enterprise?tab=traits");
  });

  it("highlights the leaf of the open detail page and of the selected section", () => {
    location.pathname = "/schemas/payments/checkout/messages/m1";
    render(<LeftSidebar {...props} />);
    expect(screen.getByTestId("product-p1-messages").getAttribute("data-active")).toBe("true");
    expect(screen.getByTestId("product-p1-event-specs").getAttribute("data-active")).toBe("false");
    cleanup();
    location.pathname = "/schemas/payments/checkout";
    location.search = "tab=events&section=specs";
    render(<LeftSidebar {...props} />);
    expect(screen.getByTestId("product-p1-event-specs").getAttribute("data-active")).toBe("true");
  });
});
```

`tests/unit/components/create-dropdown-events.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CreateDropdown } from "@/app/(dashboard)/schemas/[domainSlug]/components/CreateDropdown";

afterEach(() => cleanup());

describe("CreateDropdown — events items", () => {
  it("offers New Event Spec / Message / Channel / Trait only when the level passes the callbacks", () => {
    const onNewMessage = vi.fn();
    render(
      <CreateDropdown onNewEntity={vi.fn()} onNewCustomDataType={vi.fn()} onNewEventSpec={vi.fn()} onNewMessage={onNewMessage} onNewChannel={vi.fn()} onNewTrait={vi.fn()} />
    );
    fireEvent.click(screen.getByTitle("More options"));
    for (const label of ["New Event Spec", "New Message", "New Channel", "New Trait"]) expect(screen.getByRole("menuitem", { name: new RegExp(label) })).toBeDefined();
    fireEvent.click(screen.getByRole("menuitem", { name: /New Message/ }));
    expect(onNewMessage).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("keeps the single New Custom Data Type entry and hides events items by default", () => {
    render(<CreateDropdown onNewEntity={vi.fn()} onNewCustomDataType={vi.fn()} />);
    fireEvent.click(screen.getByTitle("More options"));
    expect(screen.getAllByRole("menuitem").map((i) => i.textContent)).toEqual([
      "New EntitySchema entity with fields",
      "New Custom Data TypeEnum, scalar or union",
    ]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/unit/lib/navigation/asset-href-events.test.ts tests/unit/lib/build-explorer-tree-events.test.ts tests/unit/components/left-sidebar-events.test.tsx tests/unit/components/create-dropdown-events.test.tsx`
Expected: FAIL — `events` kind unknown (TS + wrong URL), counts 0, leaves missing, menu items missing.

- [ ] **Step 3: `assetHref` events kind** (`src/lib/navigation/asset-href.ts`)

```ts
export type EventsSection = "specs" | "messages" | "channels";

export type AssetRef =
  | { kind: "enterprise" }
  // … existing members unchanged …
  | { kind: "events"; domainSlug: string; productSlug: string; section?: EventsSection }
  | { kind: "newEntity"; domainSlug: string | null; productSlug: string | null };
```

and in `path()` before `case "newEntity"`:

```ts
    case "events":
      return { path: levelBase(ref.domainSlug, ref.productSlug), query: { tab: "events", section: ref.section ?? "specs" } };
```

- [ ] **Step 4: Explorer counts** (`src/lib/navigation/build-explorer-tree.ts`)

```ts
export interface ExplorerRows {
  domains: Array<{ id: string; name: string; slug: string; isSystem: boolean }>;
  products: Array<{ id: string; domainId: string; name: string; slug: string; isSystem: boolean }>;
  entities: Array<ExplorerEntity & LevelRow>;
  dataTypes: LevelRow[];
  services: LevelRow[];
  traits?: LevelRow[];
  messages?: LevelRow[];
  channels?: LevelRow[];
  eventSpecs?: LevelRow[];
}
```

Inside `buildExplorerTree`, next to `dataTypes` / `services`:

```ts
  const traits = countBy(input.traits ?? []);
  const messages = countBy(input.messages ?? []);
  const channels = countBy(input.channels ?? []);
  const eventSpecs = countBy(input.eventSpecs ?? []);
```

and replace the three hard-coded zeros: enterprise `traits: traits.get(TENANT) ?? 0`; domain `traits: traits.get(d.id) ?? 0`; product `traits: traits.get(p.id) ?? 0, messages: messages.get(p.id) ?? 0, channels: channels.get(p.id) ?? 0, eventSpecs: eventSpecs.get(p.id) ?? 0`. Update the doc comment ("Traits / messages / channels / eventSpecs counts are 0 until Phase 4") to "Counts every level-tagged kind; traits at every level, events kinds per product".

- [ ] **Step 5: Domains-tree route** (`src/app/api/domains-tree/route.ts`)

```ts
  const [domains, products, entities, enums, scalars, unions, services, traits, messages, channels, eventSpecs] = await Promise.all([
    // … the seven existing queries unchanged …
    prisma.trait.findMany({ where: { tenantId }, select: levelSelect }),
    prisma.message.findMany({ where: { tenantId }, select: levelSelect }),
    prisma.channel.findMany({ where: { tenantId }, select: levelSelect }),
    prisma.eventSpec.findMany({ where: { tenantId }, select: levelSelect }),
  ]);
  return NextResponse.json(
    buildExplorerTree({
      domains, products, entities, dataTypes: [...enums, ...scalars, ...unions], services, traits, messages, channels, eventSpecs,
    })
  );
```

- [ ] **Step 6: Sidebar leaves** (`src/components/layout/LeftSidebar.tsx`)

Add `FileCode2, Mail, Puzzle, Radio` to the `lucide-react` import and `type EventsSection` to the `asset-href` import. Next to `activeTab`:

```ts
  const activeSection = searchParams?.get("section") ?? null;
```

Inside `renderProduct`, after `apisHref`:

```ts
    const traitsHref = assetHref({ kind: "traits", domainSlug: domain.slug, productSlug: product.slug });
    const eventLeaves: Array<{ id: string; section: EventsSection; label: string; icon: typeof Mail; count: number }> = [
      { id: "event-specs", section: "specs", label: "Event Specs", icon: FileCode2, count: product.counts.eventSpecs },
      { id: "messages", section: "messages", label: "Messages", icon: Mail, count: product.counts.messages },
      { id: "channels", section: "channels", label: "Channels", icon: Radio, count: product.counts.channels },
    ];
```

and after the APIs `SidebarLeafCategory` block (still inside the expanded product `div`):

```tsx
            {eventLeaves
              .filter((leaf) => leaf.count > 0)
              .map((leaf) => {
                const href = assetHref({ kind: "events", domainSlug: domain.slug, productSlug: product.slug, section: leaf.section });
                const onList = pathname === base && activeTab === "events" && (activeSection ?? "specs") === leaf.section;
                return (
                  <SidebarLeafCategory
                    key={leaf.id}
                    testId={`product-${product.id}-${leaf.id}`}
                    active={onList || isWithin(pathname, `${base}/${leaf.section}`)}
                    count={leaf.count}
                    icon={leaf.icon}
                    label={leaf.label}
                    href={href}
                    pending={pendingTarget === href}
                    onNavigate={navigate}
                  />
                );
              })}

            {product.counts.traits > 0 && (
              <SidebarLeafCategory
                testId={`product-${product.id}-traits`}
                active={(pathname === base && activeTab === "traits") || isWithin(pathname, `${base}/traits`)}
                count={product.counts.traits}
                icon={Puzzle}
                label="Traits"
                href={traitsHref}
                pending={pendingTarget === traitsHref}
                onNavigate={navigate}
              />
            )}
```

In `renderDomain` (after the APIs leaf, before the products):

```tsx
            {domain.counts.traits > 0 && (
              <SidebarLeafCategory
                testId={`domain-${domain.id}-traits`}
                active={(pathname === base && activeTab === "traits") || isWithin(pathname, `${base}/traits`)}
                count={domain.counts.traits}
                icon={Puzzle}
                label="Traits"
                href={assetHref({ kind: "traits", domainSlug: domain.slug, productSlug: null })}
                pending={pendingTarget === assetHref({ kind: "traits", domainSlug: domain.slug, productSlug: null })}
                onNavigate={navigate}
              />
            )}
```

Next to `enterpriseDataTypes`:

```ts
  const enterpriseTraitsHref = assetHref({ kind: "traits", domainSlug: null, productSlug: null });
  const enterpriseTraits = tree?.enterprise.counts.traits ?? 0;
```

and in `renderEnterprise`, after the Data Types leaf:

```tsx
            {enterpriseTraits > 0 && (
              <SidebarLeafCategory
                testId="enterprise-traits"
                active={(pathname === enterpriseHref && activeTab === "traits") || isWithin(pathname, `${enterpriseHref}/traits`)}
                count={enterpriseTraits}
                icon={Puzzle}
                label="Traits"
                href={enterpriseTraitsHref}
                pending={pendingTarget === enterpriseTraitsHref}
                onNavigate={navigate}
              />
            )}
```

- [ ] **Step 7: New-menu items** (`src/app/(dashboard)/schemas/[domainSlug]/components/CreateDropdown.tsx`)

Extend the import with `FileCode2, Mail, Puzzle, Radio`, the props, and the menu:

```tsx
export function CreateDropdown({
  onNewEntity,
  onNewCustomDataType,
  onNewApi,
  onNewEventSpec,
  onNewMessage,
  onNewChannel,
  onNewTrait,
}: {
  onNewEntity: () => void;
  onNewCustomDataType: () => void;
  /** Omit where APIs cannot be created (Enterprise level) to hide the item. */
  onNewApi?: () => void;
  /** Events kinds are product-only (spec §4.1); pass them only on the product workspace. */
  onNewEventSpec?: () => void;
  onNewMessage?: () => void;
  onNewChannel?: () => void;
  /** Traits exist at every level. */
  onNewTrait?: () => void;
}) {
```

after `apiItem`:

```tsx
  const optional = (label: string, icon: DropdownItem["icon"], action: (() => void) | undefined, description: string): DropdownItem | null =>
    action ? { label, icon, action, description } : null;
  const eventItems = [
    optional("New Event Spec", FileCode2, onNewEventSpec, "AsyncAPI event specification"),
    optional("New Message", Mail, onNewMessage, "Event message with a pinned payload"),
    optional("New Channel", Radio, onNewChannel, "Topic / queue with a format profile"),
    optional("New Trait", Puzzle, onNewTrait, "Reusable message or operation trait"),
  ].filter((item): item is DropdownItem => item !== null);
```

and in the menu after `{apiItem && renderItem(apiItem)}`:

```tsx
          {eventItems.length > 0 && <div role="separator" className="my-1 border-t border-border" />}
          {eventItems.map(renderItem)}
```

- [ ] **Step 8: Run tests (new + existing navigation suites)**

Run: `npx vitest run tests/unit/lib/navigation tests/unit/lib/asset-href.test.ts tests/unit/lib/build-explorer-tree.test.ts tests/unit/lib/build-explorer-tree-events.test.ts tests/unit/components/left-sidebar-events.test.tsx tests/unit/components/left-sidebar-domain-assets.test.tsx tests/unit/components/create-dropdown-events.test.tsx && npx tsc --noEmit`
Expected: PASS; no type errors.

- [ ] **Step 9: Commit**

```bash
git add src/lib/navigation/asset-href.ts src/lib/navigation/build-explorer-tree.ts src/app/api/domains-tree/route.ts src/components/layout/LeftSidebar.tsx "src/app/(dashboard)/schemas/[domainSlug]/components/CreateDropdown.tsx" tests/unit/lib/navigation/asset-href-events.test.ts tests/unit/lib/build-explorer-tree-events.test.ts tests/unit/components/left-sidebar-events.test.tsx tests/unit/components/create-dropdown-events.test.tsx
git commit -m "feat(18.8): events nav — assetHref events kind, explorer counts, sidebar leaves, New-menu items"
```

---
### Task 8: Shared event UI kit + AsyncAPI preview (Stories 18.6 / 20.5 fallback) — Wave 2

**Files:**
- Modify: `src/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/components/PublishEntityDialog.tsx` (structural `PublishPreview`, optional `description`)
- Create: `src/features/events/shared/PublishVersionButton.tsx`, `EventVersionList.tsx`, `JsonField.tsx`, `EntityPinPicker.tsx`, `EventBreadcrumb.tsx`
- Create: `src/features/events/load-options.ts` (server option loaders for pickers), `src/features/events/crumbs.ts` (breadcrumb builders shared by the Wave 5 pages)
- Create: `src/features/events/event-specs/preview-src-doc.ts`, `src/features/events/event-specs/AsyncApiPreview.tsx`
- Create: `src/app/api/asyncapi-preview/[asset]/route.ts`; Modify: `next.config.ts`
- Test: `tests/unit/components/events/publish-version-button.test.tsx`, `tests/unit/components/events/entity-pin-picker.test.tsx`, `tests/unit/components/events/json-field-version-list.test.tsx`, `tests/unit/components/events/asyncapi-preview.test.tsx`, `tests/unit/api/asyncapi-preview-route.test.ts`

**Interfaces:**

```ts
// PublishEntityDialog.tsx
type PublishPreview = Pick<PublishAnalysis, "isFirstPublish" | "latestLabel" | "suggestedBump" | "candidateLabels" | "initialLabel" | "reasons">
  & { blockers: ReadonlyArray<{ kind: string; message: string }> };   // EventPublishAnalysis satisfies it
// shared components
PublishVersionButton({ subjectName, description, loadPreview, publish, onPublished?, disabled?, testId? })
EventVersionList({ versions: EventVersionSummary[]; hrefFor?: (label) => string; emptyText: string })
JsonField({ id, label, value, onChange, mode: "object" | "array", rows?, placeholder? })
EntityPinPicker({ id, label, entities: EntityOption[], value: EntityPin | null, onChange, optional?, hint?, loadVersions?, disabled? })
interface EntityOption { id; name; ownerLabel; latestVersionId: string | null; latestVersionLabel: string | null }
EventBreadcrumb({ crumbs: Crumb[] })            // Crumb = { label: string; href?: string }
// crumbs.ts
productCrumbs(route: ProductRoute, section: Crumb, current: string): Crumb[]
levelCrumbs(route: LevelRoute, section: Crumb, current: string): Crumb[]
// load-options.ts (server)
loadEntityOptions(tenantId): Promise<EntityOption[]>
loadTraitOptions(scope: LevelScope, kind: TraitKind): Promise<TraitOption[]>          // { id, name, ownerLabel }
loadChannelOptions(tenantId, productId): Promise<ChannelOption[]>                     // { id, name, address, protocol, format, ownerLabel, own, allowedMessageIds }
loadMessageRefOptions(tenantId, productId): Promise<MessageRefOption[]>               // { id, messageId, label, ownerLabel, own, draft }
loadMessageOptions(tenantId): Promise<MessageOption[]>                                // { id, name, ownerLabel }
// preview
buildPreviewSrcDoc(document: object, origin: string): string
AsyncApiPreview({ document: object | null; title: string; forceIframe?: boolean; renderer?: ComponentType<{ schema: string }> })
```

- [ ] **Step 1: Generalize the publish dialog** (`PublishEntityDialog.tsx`) — entity behavior unchanged

```tsx
/** The subset of a publish analysis the dialog renders — entity, message and event spec analyses all satisfy it. */
export type PublishPreview = Pick<
  PublishAnalysis,
  "isFirstPublish" | "latestLabel" | "suggestedBump" | "candidateLabels" | "initialLabel" | "reasons"
> & { blockers: ReadonlyArray<{ kind: string; message: string }> };
```

Change `preview: PublishAnalysis` → `preview: PublishPreview` in `PublishEntityFormProps`, `preview: PublishAnalysis | null` → `preview: PublishPreview | null` in `PublishEntityDialogProps`, add `description?: string` to `PublishEntityDialogProps`, and render it:

```tsx
          <DialogDescription className="text-body-small text-muted-foreground">
            {description ?? "Publishing freezes the current draft as an immutable version that messages and other entities can pin."}
          </DialogDescription>
```

Run: `npx vitest run tests/unit/components/entity-versioning-ui.test.tsx` — Expected: PASS (unchanged).

- [ ] **Step 2: Write the failing component tests**

`tests/unit/components/events/publish-version-button.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ refresh: vi.fn(), success: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: h.refresh }) }));
vi.mock("sonner", () => ({ toast: { success: h.success, error: vi.fn() } }));
vi.mock("@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/components/PublishEntityDialog", () => ({
  PublishEntityDialog: (p: {
    open: boolean; description?: string; loadError: string | null; publishError: string | null;
    preview: { blockers: Array<{ message: string }> } | null; onConfirm: (i: { bump?: "MAJOR" | "MINOR" }) => void;
  }) =>
    p.open ? (
      <div data-testid="dialog">
        <p>{p.description}</p>
        {p.loadError && <p role="alert">{p.loadError}</p>}
        {p.publishError && <p role="alert">{p.publishError}</p>}
        {p.preview && <button onClick={() => p.onConfirm({ bump: "MAJOR" })}>confirm</button>}
      </div>
    ) : null,
}));

import { PublishVersionButton } from "@/features/events/shared/PublishVersionButton";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
const preview = { isFirstPublish: true, latestLabel: null, suggestedBump: null, candidateLabels: null, initialLabel: "1.0", reasons: [], blockers: [] };

describe("PublishVersionButton", () => {
  it("loads the preview, publishes the chosen bump, toasts and refreshes", async () => {
    const publish = vi.fn(async () => ({ success: true as const, data: { label: "2.0" } }));
    const onPublished = vi.fn();
    render(
      <PublishVersionButton subjectName="OrderCreated" description="Freezes the message" loadPreview={async () => ({ success: true, data: preview })} publish={publish} onPublished={onPublished} />
    );
    fireEvent.click(screen.getByTestId("publish-version-button"));
    expect(await screen.findByText("Freezes the message")).toBeDefined();
    fireEvent.click(await screen.findByText("confirm"));
    await waitFor(() => expect(onPublished).toHaveBeenCalledWith("2.0"));
    expect(publish).toHaveBeenCalledWith({ bump: "MAJOR" });
    expect(h.success).toHaveBeenCalledWith("Published OrderCreated v2.0");
    expect(h.refresh).toHaveBeenCalled();
    expect(screen.queryByTestId("dialog")).toBeNull();
  });

  it("shows load and publish errors inside the dialog", async () => {
    render(
      <PublishVersionButton subjectName="x" description="d" loadPreview={async () => ({ success: false, error: "boom" })} publish={vi.fn()} />
    );
    fireEvent.click(screen.getByTestId("publish-version-button"));
    expect((await screen.findByRole("alert")).textContent).toBe("boom");
  });
});
```

`tests/unit/components/events/entity-pin-picker.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/version-actions", () => ({ listEntityVersionsAction: vi.fn() }));
import { EntityPinPicker, type EntityOption } from "@/features/events/shared/EntityPinPicker";

afterEach(() => cleanup());
const entities: EntityOption[] = [
  { id: "e1", name: "Order", ownerLabel: "Payments / Checkout", latestVersionId: "v21", latestVersionLabel: "2.1" },
  { id: "e2", name: "CloudEventsHeaders", ownerLabel: "Enterprise", latestVersionId: null, latestVersionLabel: null },
];
const loadVersions = vi.fn(async (entityId: string) => (entityId === "e1" ? [{ id: "v21", label: "2.1" }, { id: "v20", label: "2.0" }] : []));

describe("EntityPinPicker", () => {
  it("defaults a newly chosen entity to its latest published version", () => {
    const onChange = vi.fn();
    render(<EntityPinPicker id="payload" label="Payload" entities={entities} value={null} onChange={onChange} loadVersions={loadVersions} />);
    fireEvent.change(screen.getByLabelText("Payload entity"), { target: { value: "e1" } });
    expect(onChange).toHaveBeenCalledWith({ entityId: "e1", entityVersionId: "v21" });
  });

  it("lists published versions, flags a stale pin and an unpinned draft", async () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <EntityPinPicker id="payload" label="Payload" entities={entities} value={{ entityId: "e1", entityVersionId: "v20" }} onChange={onChange} loadVersions={loadVersions} />
    );
    await waitFor(() => expect(screen.getByRole("option", { name: "v2.0" })).toBeDefined());
    expect(screen.getByTestId("payload-newer").textContent).toBe("Newer version available (v2.1)");
    fireEvent.change(screen.getByLabelText("Payload version"), { target: { value: "" } });
    expect(onChange).toHaveBeenCalledWith({ entityId: "e1", entityVersionId: null });
    rerender(<EntityPinPicker id="payload" label="Payload" entities={entities} value={{ entityId: "e1", entityVersionId: null }} onChange={onChange} loadVersions={loadVersions} />);
    expect(screen.getByText(/publishing is blocked/)).toBeDefined();
  });

  it("allows clearing an optional pin", () => {
    const onChange = vi.fn();
    render(<EntityPinPicker id="headers" label="Headers" optional entities={entities} value={{ entityId: "e2", entityVersionId: null }} onChange={onChange} loadVersions={loadVersions} />);
    fireEvent.change(screen.getByLabelText("Headers entity"), { target: { value: "" } });
    expect(onChange).toHaveBeenCalledWith(null);
  });
});
```

`tests/unit/components/events/json-field-version-list.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JsonField } from "@/features/events/shared/JsonField";
import { EventVersionList } from "@/features/events/shared/EventVersionList";

afterEach(() => cleanup());

describe("JsonField", () => {
  it("flags invalid JSON and wrong shapes inline", () => {
    const onChange = vi.fn();
    const { rerender } = render(<JsonField id="b" label="Bindings" value="{" onChange={onChange} mode="object" />);
    expect(screen.getByRole("alert").textContent).toMatch(/Bindings is not valid JSON/);
    expect(screen.getByLabelText("Bindings").getAttribute("aria-invalid")).toBe("true");
    rerender(<JsonField id="b" label="Bindings" value='{"kafka":{}}' onChange={onChange} mode="object" />);
    expect(screen.queryByRole("alert")).toBeNull();
    rerender(<JsonField id="e" label="Examples" value="{}" onChange={onChange} mode="array" />);
    expect(screen.getByRole("alert").textContent).toMatch(/Examples must be a JSON array of objects/);
    fireEvent.change(screen.getByLabelText("Examples"), { target: { value: "[]" } });
    expect(onChange).toHaveBeenCalledWith("[]");
  });
});

describe("EventVersionList", () => {
  it("renders versions newest-first with deep links, or the empty text", () => {
    const { rerender } = render(<EventVersionList versions={[]} emptyText="Not published yet." />);
    expect(screen.getByText("Not published yet.")).toBeDefined();
    rerender(
      <EventVersionList
        emptyText="-"
        hrefFor={(label) => `/x?version=${label}`}
        versions={[{ id: "v2", major: 1, minor: 1, label: "1.1", sequence: 2, changeKind: "MINOR", changeSummary: "docs", publishedByName: "Ada", publishedAt: "2026-10-14T00:00:00.000Z" }]}
      />
    );
    expect(screen.getByRole("link", { name: "v1.1" }).getAttribute("href")).toBe("/x?version=1.1");
    expect(screen.getByText("MINOR")).toBeDefined();
    expect(screen.getByText("docs")).toBeDefined();
  });
});
```

`tests/unit/components/events/asyncapi-preview.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("next/dynamic", () => ({ default: () => function DynamicStub() { return <div data-testid="react-preview" />; } }));
import { AsyncApiPreview } from "@/features/events/event-specs/AsyncApiPreview";
import { buildPreviewSrcDoc } from "@/features/events/event-specs/preview-src-doc";

afterEach(() => cleanup());

describe("AsyncAPI preview (D14)", () => {
  it("escapes the document so it cannot break out of the inline script", () => {
    const html = buildPreviewSrcDoc({ info: { title: "</script><script>alert(1)</script>" } }, "https://app.test");
    expect(html).not.toContain("</script><script>alert(1)");
    expect(html).toContain('<script src="https://app.test/api/asyncapi-preview/standalone.js"></script>');
    expect(html).toContain("AsyncApiStandalone.render(");
  });

  it("uses the React renderer and falls back to the sandboxed iframe when it throws", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const Throwing = () => {
      throw new Error("React 19 incompatibility");
    };
    render(<AsyncApiPreview document={{ asyncapi: "3.0.0" }} title="checkout-service" renderer={Throwing} />);
    const frame = screen.getByTestId("asyncapi-preview-iframe");
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame.getAttribute("srcdoc")).toContain("asyncapi");
    cleanup();
    render(<AsyncApiPreview document={{ asyncapi: "3.0.0" }} title="t" />);
    expect(screen.getByTestId("react-preview")).toBeDefined();
  });

  it("asks for a document when there is none", () => {
    render(<AsyncApiPreview document={null} title="t" />);
    expect(screen.getByText(/No document to preview/)).toBeDefined();
  });
});
```

`tests/unit/api/asyncapi-preview-route.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { GET } from "@/app/api/asyncapi-preview/[asset]/route";

const call = (asset: string) => GET(new Request(`http://x/api/asyncapi-preview/${asset}`), { params: Promise.resolve({ asset }) });

describe("asyncapi preview assets", () => {
  it("serves the standalone bundle and stylesheet from node_modules", async () => {
    const js = await call("standalone.js");
    expect(js.status).toBe(200);
    expect(js.headers.get("content-type")).toMatch(/javascript/);
    expect((await js.text()).slice(0, 200)).toContain("AsyncApiStandalone");
    const css = await call("default.min.css");
    expect(css.headers.get("content-type")).toMatch(/text\/css/);
  });

  it("serves nothing else", async () => {
    expect((await call("constructor")).status).toBe(404);
    expect((await call("../../package.json")).status).toBe(404);
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `npx vitest run tests/unit/components/events tests/unit/api/asyncapi-preview-route.test.ts`
Expected: FAIL — missing modules.

- [ ] **Step 4: Implement the shared components**

```tsx
// src/features/events/shared/PublishVersionButton.tsx
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Upload } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  PublishEntityDialog,
  type PublishPreview,
} from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/components/PublishEntityDialog";
import type { PublishInput } from "@/lib/entity-versioning/types";
import type { ActionResult } from "@/types/action-result";

export interface PublishVersionButtonProps {
  subjectName: string;
  description: string;
  loadPreview: () => Promise<ActionResult<PublishPreview>>;
  publish: (input: PublishInput) => Promise<ActionResult<{ label: string }>>;
  onPublished?: (label: string) => void;
  disabled?: boolean;
  testId?: string;
}

/** Publish button + the shared raise-only publish dialog (same UX as entities, spec §5.3 / §7.4). */
export function PublishVersionButton({
  subjectName, description, loadPreview, publish, onPublished, disabled, testId = "publish-version-button",
}: PublishVersionButtonProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<PublishPreview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [publishError, setPublishError] = useState<string | null>(null);

  async function openDialog() {
    setOpen(true);
    setPreview(null);
    setLoadError(null);
    setPublishError(null);
    const r = await loadPreview();
    if (r.success) setPreview(r.data);
    else setLoadError(r.error);
  }

  async function confirm(input: PublishInput) {
    setPublishing(true);
    setPublishError(null);
    const r = await publish(input);
    setPublishing(false);
    if (!r.success) {
      setPublishError(r.error);
      return;
    }
    setOpen(false);
    toast.success(`Published ${subjectName} v${r.data.label}`);
    onPublished?.(r.data.label);
    router.refresh();
  }

  return (
    <>
      <Button variant="outline" onClick={openDialog} disabled={disabled} className="gap-1.5" data-testid={testId}>
        <Upload className="w-4 h-4" />
        Publish
      </Button>
      <PublishEntityDialog
        open={open}
        entityName={subjectName}
        description={description}
        preview={preview}
        loadError={loadError}
        isPublishing={publishing}
        publishError={publishError}
        onOpenChange={setOpen}
        onConfirm={confirm}
      />
    </>
  );
}
```

```tsx
// src/features/events/shared/EventVersionList.tsx
"use client";

import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { formatDateTime } from "@/lib/date-format";
import type { EventVersionSummary } from "@/lib/events/types";

export function EventVersionList({
  versions, hrefFor, emptyText,
}: {
  /** Newest first. */
  versions: EventVersionSummary[];
  hrefFor?: (label: string) => string;
  emptyText: string;
}) {
  if (versions.length === 0) {
    return <p className="text-body-small text-muted-foreground" data-testid="event-version-list-empty">{emptyText}</p>;
  }
  return (
    <ul className="space-y-space-2" data-testid="event-version-list">
      {versions.map((v) => (
        <li key={v.id} className="flex items-center justify-between gap-space-3 rounded-lg border border-border/50 px-space-4 py-space-3">
          <div className="flex min-w-0 items-center gap-space-3">
            {hrefFor ? (
              <Link href={hrefFor(v.label)} className="font-mono text-body-small font-medium text-primary hover:underline">v{v.label}</Link>
            ) : (
              <span className="font-mono text-body-small font-medium text-foreground">v{v.label}</span>
            )}
            <Badge variant="secondary">{v.changeKind}</Badge>
            {v.changeSummary && <span className="truncate text-caption text-muted-foreground">{v.changeSummary}</span>}
          </div>
          <span className="shrink-0 text-caption text-muted-foreground">
            {v.publishedByName ?? "Unknown"} · {formatDateTime(v.publishedAt)}
          </span>
        </li>
      ))}
    </ul>
  );
}
```

```tsx
// src/features/events/shared/JsonField.tsx
"use client";

import { useMemo } from "react";
import { Textarea } from "@/components/ui/textarea";
import { parseJsonObjectArrayText, parseJsonObjectText } from "@/lib/events/inputs";

/** Raw JSON editor for bindings / parameters / examples (binding forms are Phase 5). */
export function JsonField({
  id, label, value, onChange, mode, rows = 4, placeholder,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  mode: "object" | "array";
  rows?: number;
  placeholder?: string;
}) {
  const problem = useMemo(() => {
    const r = mode === "object" ? parseJsonObjectText(value, label) : parseJsonObjectArrayText(value, label);
    return r.success ? null : r.error.message;
  }, [value, mode, label]);
  return (
    <div className="space-y-space-1">
      <label htmlFor={id} className="block text-caption text-muted-foreground">{label}</label>
      <Textarea
        id={id}
        value={value}
        rows={rows}
        placeholder={placeholder ?? (mode === "object" ? "{ }" : "[ ]")}
        aria-invalid={problem ? "true" : "false"}
        onChange={(e) => onChange(e.target.value)}
        className="font-mono text-caption"
      />
      {problem && <p role="alert" className="text-caption text-destructive">{problem}</p>}
    </div>
  );
}
```

```tsx
// src/features/events/shared/EntityPinPicker.tsx
"use client";

import { useEffect, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { listEntityVersionsAction } from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/version-actions";
import type { EntityPin } from "@/lib/events/types";

export interface EntityOption {
  id: string;
  name: string;
  ownerLabel: string;
  latestVersionId: string | null;
  latestVersionLabel: string | null;
}
export interface VersionOption {
  id: string;
  label: string;
}

async function defaultLoadVersions(entityId: string): Promise<VersionOption[]> {
  const r = await listEntityVersionsAction(entityId);
  return "versions" in r ? r.versions.map((v) => ({ id: v.id, label: v.label })) : [];
}

const selectClass = "rounded-md border border-border bg-background px-space-2 py-1 text-body-small";

/**
 * Entity + published-version picker (spec §6.1 / §9). Choosing an entity pins its latest
 * published version (D5); "Unpinned" keeps the draft for preview only. `loadVersions` must be
 * a stable function (module-level or memoized).
 */
export function EntityPinPicker({
  id, label, entities, value, onChange, optional = false, hint, loadVersions = defaultLoadVersions, disabled,
}: {
  id: string;
  label: string;
  entities: EntityOption[];
  value: EntityPin | null;
  onChange: (pin: EntityPin | null) => void;
  optional?: boolean;
  hint?: string;
  loadVersions?: (entityId: string) => Promise<VersionOption[]>;
  disabled?: boolean;
}) {
  const entityId = value?.entityId ?? null;
  const [loaded, setLoaded] = useState<{ entityId: string; options: VersionOption[] } | null>(null);

  useEffect(() => {
    if (!entityId) return;
    let cancelled = false;
    void loadVersions(entityId).then((options) => {
      if (!cancelled) setLoaded({ entityId, options });
    });
    return () => {
      cancelled = true;
    };
  }, [entityId, loadVersions]);

  const groups = useMemo(() => {
    const byOwner = new Map<string, EntityOption[]>();
    for (const e of entities) byOwner.set(e.ownerLabel, [...(byOwner.get(e.ownerLabel) ?? []), e]);
    return [...byOwner.entries()];
  }, [entities]);

  const entity = entities.find((e) => e.id === entityId) ?? null;
  const options = loaded && loaded.entityId === entityId ? loaded.options : [];
  const pinned = value?.entityVersionId ?? null;
  const behind = pinned !== null && entity?.latestVersionId && pinned !== entity.latestVersionId;

  return (
    <fieldset className="space-y-space-1" data-testid={`${id}-picker`}>
      <legend className="text-caption text-muted-foreground">{label}</legend>
      <div className="flex flex-wrap gap-space-2">
        <select
          aria-label={`${label} entity`}
          className={selectClass}
          value={entityId ?? ""}
          disabled={disabled}
          onChange={(e) => {
            const next = entities.find((x) => x.id === e.target.value);
            onChange(next ? { entityId: next.id, entityVersionId: next.latestVersionId } : null);
          }}
        >
          {(optional || !entityId) && <option value="">{optional ? "— none —" : "Select an entity"}</option>}
          {groups.map(([owner, items]) => (
            <optgroup key={owner} label={owner}>
              {items.map((e) => (
                <option key={e.id} value={e.id}>{e.name}</option>
              ))}
            </optgroup>
          ))}
        </select>
        {entityId && (
          <select
            aria-label={`${label} version`}
            className={selectClass}
            value={pinned ?? ""}
            disabled={disabled}
            onChange={(e) => onChange({ entityId, entityVersionId: e.target.value || null })}
          >
            <option value="">Unpinned — preview uses the draft</option>
            {pinned && !options.some((o) => o.id === pinned) && <option value={pinned}>pinned version</option>}
            {options.map((v) => (
              <option key={v.id} value={v.id}>v{v.label}</option>
            ))}
          </select>
        )}
      </div>
      {behind && entity?.latestVersionLabel && (
        <Badge variant="secondary" data-testid={`${id}-newer`}>Newer version available (v{entity.latestVersionLabel})</Badge>
      )}
      {entityId && !pinned && (
        <p className="text-caption text-muted-foreground">Not pinned — publishing is blocked until a published version is pinned.</p>
      )}
      {hint && <p className="text-caption text-muted-foreground">{hint}</p>}
    </fieldset>
  );
}
```

```tsx
// src/features/events/shared/EventBreadcrumb.tsx
import Link from "next/link";
import { ChevronRight } from "lucide-react";

export interface Crumb {
  label: string;
  href?: string;
}

export function EventBreadcrumb({ crumbs }: { crumbs: Crumb[] }) {
  return (
    <nav aria-label="Breadcrumb" className="mb-space-4 flex flex-wrap items-center gap-space-1 text-body-small text-muted-foreground">
      {crumbs.map((c, i) => (
        <span key={`${c.label}-${i}`} className="flex items-center gap-space-1">
          {i > 0 && <ChevronRight className="w-3 h-3" aria-hidden="true" />}
          {c.href ? (
            <Link href={c.href} className="hover:text-foreground transition-colors">{c.label}</Link>
          ) : (
            <span className="font-medium text-foreground">{c.label}</span>
          )}
        </span>
      ))}
    </nav>
  );
}
```

```ts
// src/features/events/crumbs.ts
import { assetHref } from "@/lib/navigation/asset-href";
import type { LevelRoute, ProductRoute } from "./route-scope";
import type { Crumb } from "./shared/EventBreadcrumb";

/** Domains › <Domain> › <Product> › <section> › <current> — every link via assetHref. */
export function productCrumbs(route: ProductRoute, section: Crumb, current: string): Crumb[] {
  return [
    { label: "Domains", href: "/schemas" },
    { label: route.domain.name, href: assetHref({ kind: "domain", domainSlug: route.domain.slug }) },
    { label: route.product.name, href: assetHref({ kind: "product", domainSlug: route.domain.slug, productSlug: route.product.slug }) },
    section,
    { label: current },
  ];
}

/** Same for a trait at any level (Enterprise › …, Domains › <Domain> › …, or the product chain). */
export function levelCrumbs(route: LevelRoute, section: Crumb, current: string): Crumb[] {
  if (route.domain && route.product) {
    return productCrumbs({ tenantId: route.scope.tenantId, tenantSlug: route.tenantSlug, domain: route.domain, product: route.product }, section, current);
  }
  if (route.domain) {
    return [
      { label: "Domains", href: "/schemas" },
      { label: route.domain.name, href: assetHref({ kind: "domain", domainSlug: route.domain.slug }) },
      section,
      { label: current },
    ];
  }
  return [{ label: "Enterprise", href: assetHref({ kind: "enterprise" }) }, section, { label: current }];
}
```

- [ ] **Step 5: Implement the option loaders** (`src/features/events/load-options.ts`)

```ts
import { prisma } from "@/lib/db";
import { formatVersionLabel } from "@/lib/entity-versioning/version-math";
import type { LevelScope } from "@/lib/levels";
import type { TraitKind } from "@/lib/events/types";
import type { EntityOption } from "./shared/EntityPinPicker";

const OWNER_SELECT = { domain: { select: { name: true } }, product: { select: { name: true } } } as const;
type OwnerRow = { domain: { name: string } | null; product: { name: string } | null };

export function ownerLabel(row: OwnerRow): string {
  if (row.domain && row.product) return `${row.domain.name} / ${row.product.name}`;
  return row.domain ? row.domain.name : "Enterprise";
}

export async function loadEntityOptions(tenantId: string): Promise<EntityOption[]> {
  const rows = await prisma.entity.findMany({
    where: { tenantId },
    orderBy: { name: "asc" },
    select: { id: true, name: true, latestVersionId: true, latestVersion: { select: { major: true, minor: true } }, ...OWNER_SELECT },
  });
  return rows.map((r) => ({
    id: r.id, name: r.name, ownerLabel: ownerLabel(r), latestVersionId: r.latestVersionId,
    latestVersionLabel: r.latestVersion ? formatVersionLabel(r.latestVersion) : null,
  }));
}

export interface TraitOption {
  id: string;
  name: string;
  ownerLabel: string;
}

/** Traits visible from a level: Enterprise + that domain + that product (spec §4.3 line). */
export async function loadTraitOptions(scope: LevelScope, kind: TraitKind): Promise<TraitOption[]> {
  const rows = await prisma.trait.findMany({
    where: {
      tenantId: scope.tenantId,
      kind,
      OR: [
        { domainId: null },
        ...(scope.domainId ? [{ domainId: scope.domainId, productId: null }] : []),
        ...(scope.productId ? [{ productId: scope.productId }] : []),
      ],
    },
    orderBy: { name: "asc" },
    select: { id: true, name: true, ...OWNER_SELECT },
  });
  return rows.map((r) => ({ id: r.id, name: r.name, ownerLabel: ownerLabel(r) }));
}

export interface ChannelOption {
  id: string;
  name: string;
  address: string | null;
  protocol: string;
  format: string;
  ownerLabel: string;
  own: boolean;
  allowedMessageIds: string[];
}

export async function loadChannelOptions(tenantId: string, productId: string): Promise<ChannelOption[]> {
  const rows = await prisma.channel.findMany({
    where: { tenantId },
    orderBy: { name: "asc" },
    select: {
      id: true, name: true, address: true, protocol: true, format: true, productId: true, ...OWNER_SELECT,
      messages: { select: { messageId: true } },
    },
  });
  return rows
    .map((r) => ({
      id: r.id, name: r.name, address: r.address, protocol: r.protocol, format: r.format, ownerLabel: ownerLabel(r),
      own: r.productId === productId, allowedMessageIds: r.messages.map((m) => m.messageId),
    }))
    .sort((a, b) => Number(b.own) - Number(a.own));
}

export interface MessageRefOption {
  /** MessageVersion id, or the Message id for an own-product draft (D4). */
  id: string;
  messageId: string;
  label: string;
  ownerLabel: string;
  own: boolean;
  draft: boolean;
}

export async function loadMessageRefOptions(tenantId: string, productId: string): Promise<MessageRefOption[]> {
  const [versions, drafts] = await Promise.all([
    prisma.messageVersion.findMany({
      where: { message: { tenantId } },
      orderBy: [{ message: { name: "asc" } }, { sequence: "desc" }],
      select: { id: true, major: true, minor: true, messageId: true, message: { select: { name: true, productId: true, ...OWNER_SELECT } } },
    }),
    prisma.message.findMany({ where: { productId }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
  ]);
  return [
    ...versions.map((v) => ({
      id: v.id, messageId: v.messageId, label: `${v.message.name} v${formatVersionLabel(v)}`, ownerLabel: ownerLabel(v.message),
      own: v.message.productId === productId, draft: false,
    })),
    ...drafts.map((m) => ({ id: m.id, messageId: m.id, label: `${m.name} (draft — preview only)`, ownerLabel: "This product", own: true, draft: true })),
  ];
}

export interface MessageOption {
  id: string;
  name: string;
  ownerLabel: string;
}

export async function loadMessageOptions(tenantId: string): Promise<MessageOption[]> {
  const rows = await prisma.message.findMany({ where: { tenantId }, orderBy: { name: "asc" }, select: { id: true, name: true, ...OWNER_SELECT } });
  return rows.map((r) => ({ id: r.id, name: r.name, ownerLabel: ownerLabel(r) }));
}
```

- [ ] **Step 6: Implement the preview** (`preview-src-doc.ts`, `AsyncApiPreview.tsx`, asset route, `next.config.ts`)

```ts
// src/features/events/event-specs/preview-src-doc.ts
export const PREVIEW_ASSET_BASE = "/api/asyncapi-preview";

/**
 * D14 fallback: HTML for a `sandbox="allow-scripts"` iframe that renders the document with the
 * standalone `@asyncapi/react-component` bundle. The document is passed as a JS string literal
 * with `<` escaped, so no `</script>` can break out of the inline script.
 */
export function buildPreviewSrcDoc(document: object, origin: string): string {
  const literal = JSON.stringify(JSON.stringify(document)).replace(/</g, "\\u003c");
  return [
    "<!doctype html><html><head><meta charset=\"utf-8\">",
    `<link rel="stylesheet" href="${origin}${PREVIEW_ASSET_BASE}/default.min.css">`,
    "</head><body><div id=\"asyncapi\"></div>",
    `<script src="${origin}${PREVIEW_ASSET_BASE}/standalone.js"></script>`,
    `<script>AsyncApiStandalone.render({ schema: ${literal}, config: { show: { sidebar: true } } }, document.getElementById("asyncapi"));</script>`,
    "</body></html>",
  ].join("");
}
```

```tsx
// src/features/events/event-specs/AsyncApiPreview.tsx
"use client";

import { Component, useMemo, useSyncExternalStore, type ComponentType, type ReactNode } from "react";
import dynamic from "next/dynamic";
import "@asyncapi/react-component/styles/default.min.css";
import { buildPreviewSrcDoc } from "./preview-src-doc";

type RendererProps = { schema: string };

/** Client-only (spec §9): the component bundles @asyncapi/parser for the browser. Its CSS is scoped under `.aui-root`. */
const AsyncApiReact = dynamic<RendererProps>(
  () => import("@asyncapi/react-component").then((m) => m.default as unknown as ComponentType<RendererProps>),
  { ssr: false, loading: () => <p className="text-body-small text-muted-foreground">Loading preview…</p> }
);

class PreviewBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

const subscribeNoop = () => () => {};

function IframePreview({ document, title }: { document: object; title: string }) {
  const origin = useSyncExternalStore(subscribeNoop, () => window.location.origin, () => "");
  const srcDoc = useMemo(() => buildPreviewSrcDoc(document, origin), [document, origin]);
  return (
    <iframe
      title={`${title} preview`}
      sandbox="allow-scripts"
      srcDoc={srcDoc}
      className="h-[70vh] w-full rounded-lg border border-border bg-white"
      data-testid="asyncapi-preview-iframe"
    />
  );
}

export function AsyncApiPreview({
  document, title, forceIframe = false, renderer: Renderer = AsyncApiReact,
}: {
  document: object | null;
  title: string;
  forceIframe?: boolean;
  /** Injectable for tests; defaults to the dynamic `@asyncapi/react-component`. */
  renderer?: ComponentType<RendererProps>;
}) {
  const schema = useMemo(() => (document ? JSON.stringify(document) : ""), [document]);
  if (!document) return <p className="text-body-small text-muted-foreground">No document to preview — fix the diagnostics first.</p>;
  const iframe = <IframePreview document={document} title={title} />;
  if (forceIframe) return iframe;
  return (
    <div className="rounded-lg border border-border bg-white" data-testid="asyncapi-preview">
      <PreviewBoundary fallback={iframe}>
        <Renderer schema={schema} />
      </PreviewBoundary>
    </div>
  );
}
```

```ts
// src/app/api/asyncapi-preview/[asset]/route.ts
import { readFile } from "node:fs/promises";
import path from "node:path";

/** D14: static assets for the preview iframe fallback; an allow-list, never a path from the request. */
const ASSETS: Record<string, { file: string; type: string }> = {
  "standalone.js": { file: "node_modules/@asyncapi/react-component/browser/standalone/index.js", type: "text/javascript; charset=utf-8" },
  "default.min.css": { file: "node_modules/@asyncapi/react-component/styles/default.min.css", type: "text/css; charset=utf-8" },
};

export async function GET(_request: Request, { params }: { params: Promise<{ asset: string }> }) {
  const { asset } = await params;
  if (!Object.hasOwn(ASSETS, asset)) return new Response("Not found", { status: 404 });
  const entry = ASSETS[asset];
  try {
    const body = await readFile(path.join(process.cwd(), entry.file));
    return new Response(body, { headers: { "Content-Type": entry.type, "Cache-Control": "public, max-age=86400" } });
  } catch {
    return new Response("Preview asset unavailable", { status: 503 });
  }
}
```

`next.config.ts` — add to `nextConfig` (top level, next to `output`):

```ts
  // D14: the AsyncAPI preview iframe fallback reads these files at runtime (standalone output must ship them).
  outputFileTracingIncludes: {
    "/api/asyncapi-preview/[asset]": [
      "./node_modules/@asyncapi/react-component/browser/standalone/index.js",
      "./node_modules/@asyncapi/react-component/styles/default.min.css",
    ],
  },
```

- [ ] **Step 7: Run the tests + type check**

Run: `npx vitest run tests/unit/components/events tests/unit/api/asyncapi-preview-route.test.ts tests/unit/components/entity-versioning-ui.test.tsx && npx tsc --noEmit`
Expected: PASS; no type errors.

- [ ] **Step 8: Commit**

```bash
git add "src/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/components/PublishEntityDialog.tsx" src/features/events/shared src/features/events/load-options.ts src/features/events/crumbs.ts src/features/events/event-specs/preview-src-doc.ts src/features/events/event-specs/AsyncApiPreview.tsx "src/app/api/asyncapi-preview/[asset]/route.ts" next.config.ts tests/unit/components/events tests/unit/api/asyncapi-preview-route.test.ts
git commit -m "feat(18.6): shared event UI kit (publish button, pin picker, JSON field, versions) + AsyncAPI preview with iframe fallback"
```

---
### Task 9: Event spec resolver + `emitEventSpec` — emission wiring, part 2 (Stories 18.4 / 18.5, spec §7.2) — Wave 3

**Files:**
- Create: `src/lib/events/catalog-mapping.ts` (pure), `src/services/events/event-spec-resolver.ts`, `src/services/events/event-spec-emit.service.ts`
- Create: `src/app/(dashboard)/schemas/[domainSlug]/[productSlug]/event-spec-emit-actions.ts`
- Test: `tests/unit/lib/events/catalog-mapping.test.ts`, `tests/unit/app/event-spec-emit-actions.test.ts`, `tests/integration/services/events/event-spec-emit.test.ts`

**Interfaces:**

```ts
// catalog-mapping.ts (pure)
toResolvedChannel(row: ChannelRow): ResolvedChannel
interface MessageSource { id; messageId; name; productSlug; spec: MessageSpec; payload: ArtifactSubject; headers: ArtifactSubject | null; key: ArtifactSubject | null; unpublished: boolean }
messageSourceFromVersion(row: MessageVersionRow): MessageSource | null; messageSourceFromDraft(row: MessageDraftRow): MessageSource
toFrozenTrait(row: TraitRow): FrozenTrait; traitHeadersSubject(t: FrozenTrait): ArtifactSubject | null
toResolvedTrait(t: FrozenTrait, headers?: SchemaArtifact): ResolvedTrait
toResolvedMessage(source: MessageSource, artifacts: { payloads; headers?; keys }): ResolvedMessage
planArtifacts(doc, channelsById): Map<string, { payloadFormats: PayloadFormat[]; keyFormats: PayloadFormat[] }>
// event-spec-resolver.ts
DRAFT_VERSION = "draft"
interface DraftSnapshot { spec: {...}; document; latest: LatestEventSpecVersion | null; channels: ResolvedChannel[]; traits: FrozenTrait[]; messages: MessageSource[]; messageVersionInfo: Record<string, MessageVersionInfo>; unresolved: ResolveProblem[] }
loadDraftSnapshot(db, specId): Promise<Result<DraftSnapshot>>            // DB only, no rendering
resolveSnapshot(snapshot, renderer, version): Promise<{ resolved: ResolvedEventSpec | null; diagnostics: Diagnostic[] }>
// event-spec-emit.service.ts
type EmitTarget = { draft: true } | { versionLabel: string }
interface EventSpecEmission { specId; specName; version; published; document: JsonObject | null; json: string | null; yaml: string | null; diagnostics: Diagnostic[]; unpublishedMessages: { id; name }[] }
emitEventSpec(specId, target, ctx, deps?: { renderer?; validators? }): Promise<Result<EventSpecEmission>>
emitResolved(resolved, specType, deps): Promise<Result<EmitOutput>>
getLatestEventSpecVersionLabel(specId, ctx): Promise<Result<string | null>>
// event-spec-emit-actions.ts ("use server", read-only — no revalidate)
emitEventSpecDraftAction(specId): Promise<ActionResult<EventSpecEmission>>
getEventSpecVersionDocumentAction(specId, label): Promise<ActionResult<EventSpecEmission>>
```

- [ ] **Step 1: Write the failing pure test** (`tests/unit/lib/events/catalog-mapping.test.ts`)

```ts
import { describe, it, expect } from "vitest";
import {
  messageSourceFromDraft, messageSourceFromVersion, planArtifacts, toFrozenTrait, toResolvedChannel, toResolvedMessage, toResolvedTrait, traitHeadersSubject,
} from "@/lib/events/catalog-mapping";

const channel = (over: Record<string, unknown> = {}) =>
  toResolvedChannel({ id: "c1", name: "orders", address: "payments.orders.v1", protocol: "kafka", format: "avro", formatDialect: null, spec: { bindings: { kafka: { partitions: 12 } } }, product: { slug: "checkout" }, ...over });

describe("catalog mapping", () => {
  it("maps channel rows to ResolvedChannel (JSON Schema defaults to draft-07)", () => {
    expect(channel()).toEqual({
      id: "c1", name: "orders", productSlug: "checkout", address: "payments.orders.v1", protocol: "kafka",
      profile: { format: "avro" }, bindings: { kafka: { partitions: 12 } },
    });
    expect(channel({ format: "json-schema" }).profile).toEqual({ format: "json-schema", dialect: "draft-07" });
    expect(channel({ format: "json-schema", formatDialect: "2020-12" }).profile).toEqual({ format: "json-schema", dialect: "2020-12" });
  });

  it("builds message sources from versions (frozen pins) and drafts (pins or draft entities)", () => {
    expect(
      messageSourceFromVersion({
        id: "mv1", messageId: "m1", major: 1, minor: 3,
        resolvedSpec: {
          name: "OrderCreated", spec: { contentType: "avro/binary", traitIds: ["t1"] },
          payload: { entityId: "e1", entityName: "Order", entityVersionId: "v21", label: "2.1", major: 2 }, headers: null,
          key: { entityId: "e2", entityName: "OrderKey", entityVersionId: "vk", label: "1.0", major: 1 },
        },
        message: { name: "OrderCreated", product: { slug: "checkout" } },
      })
    ).toEqual({
      id: "mv1", messageId: "m1", name: "OrderCreated", productSlug: "checkout", spec: { contentType: "avro/binary", traitIds: ["t1"] },
      payload: { kind: "version", entityVersionId: "v21" }, headers: null, key: { kind: "version", entityVersionId: "vk" }, unpublished: false,
    });
    expect(messageSourceFromVersion({ id: "x", messageId: "m", major: 1, minor: 0, resolvedSpec: {}, message: { name: "M", product: null } })).toBeNull();
    expect(
      messageSourceFromDraft({
        id: "m2", name: "OrderCancelled", spec: {}, payloadEntityId: "e1", payloadEntityVersionId: null,
        headersEntityId: "e3", headersEntityVersionId: "vh", keyEntityId: null, keyEntityVersionId: null, product: { slug: "checkout" },
      })
    ).toMatchObject({ id: "m2", payload: { kind: "draft", entityId: "e1" }, headers: { kind: "version", entityVersionId: "vh" }, key: null, unpublished: true });
  });

  it("plans payload formats per channel and Kafka keys (Avro on Avro channels, else JSON Schema)", () => {
    const channels = new Map([
      ["c1", channel()],
      ["c2", channel({ id: "c2", format: "json-schema", protocol: "kafka" })],
      ["c3", channel({ id: "c3", format: "json-schema", protocol: "pulsar" })],
    ]);
    const plan = planArtifacts(
      {
        info: { title: "x" }, servers: [],
        operations: [
          { key: "a", action: "send", channelId: "c1", messageVersionIds: ["mv1"], traitIds: [] },
          { key: "b", action: "send", channelId: "c2", messageVersionIds: ["mv1"], traitIds: [], reply: { channelId: "c3", messageVersionIds: ["mv2"] } },
        ],
      },
      channels
    );
    expect(plan.get("mv1")).toEqual({ payloadFormats: ["avro", "json-schema"], keyFormats: ["avro", "json-schema"] });
    expect(plan.get("mv2")).toEqual({ payloadFormats: ["json-schema"], keyFormats: [] });
  });

  it("maps messages and traits to resolved shapes", () => {
    const source = messageSourceFromDraft({
      id: "m2", name: "OrderCancelled", spec: { summary: "s", traitIds: ["t1"] }, payloadEntityId: "e1", payloadEntityVersionId: "v1",
      headersEntityId: null, headersEntityVersionId: null, keyEntityId: null, keyEntityVersionId: null, product: { slug: "checkout" },
    });
    const payload = { format: "avro" as const, schema: { type: "record", name: "Order", fields: [] } };
    expect(toResolvedMessage(source, { payloads: [payload], keys: [] })).toEqual({
      id: "m2", name: "OrderCancelled", productSlug: "checkout", summary: "s", traitRefs: ["t1"], payloads: [payload], unpublished: true,
    });
    const trait = toFrozenTrait({
      id: "t1", name: "CloudEvents", kind: "MESSAGE", spec: { summary: "ce" }, headersEntityId: "e9", headersEntityVersionId: null,
      tenant: { slug: "acme" }, domain: null, product: null,
    });
    expect(trait).toEqual({ id: "t1", name: "CloudEvents", kind: "MESSAGE", ownerSlug: "acme", spec: { summary: "ce" }, headersEntityId: "e9", headersEntityVersionId: null });
    expect(traitHeadersSubject(trait)).toEqual({ kind: "draft", entityId: "e9" });
    expect(toResolvedTrait(trait)).toEqual({ id: "t1", name: "CloudEvents", kind: "MESSAGE", ownerSlug: "acme", spec: { summary: "ce" } });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/unit/lib/events/catalog-mapping.test.ts`
Expected: FAIL — missing module.

- [ ] **Step 3: Implement `src/lib/events/catalog-mapping.ts`**

```ts
import type {
  EventSpecDocument, JsonSchemaDialect, PayloadFormat, ResolvedChannel, ResolvedMessage, ResolvedTrait, SchemaArtifact, TraitKind,
} from "@/lib/event-specs/types";
import type { ArtifactSubject } from "@/services/events/artifact-renderer";
import { readChannelSpec, readMessageSpec } from "./catalog-specs";
import { isJsonObject } from "./inputs";
import type { FrozenTrait, MessageResolvedSpec, MessageSpec } from "./types";

function compact<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

export interface ChannelRow {
  id: string;
  name: string;
  address: string | null;
  protocol: string;
  format: string;
  formatDialect: string | null;
  spec: unknown;
  product: { slug: string } | null;
}

export function toResolvedChannel(row: ChannelRow): ResolvedChannel {
  const spec = readChannelSpec(row.spec);
  return compact<ResolvedChannel>({
    id: row.id,
    name: row.name,
    productSlug: row.product?.slug ?? "",
    address: row.address,
    protocol: row.protocol,
    profile:
      row.format === "json-schema"
        ? { format: "json-schema", dialect: (row.formatDialect as JsonSchemaDialect | null) ?? "draft-07" }
        : { format: row.format as PayloadFormat },
    title: spec.title,
    summary: spec.summary,
    description: spec.description,
    parameters: spec.parameters,
    bindings: spec.bindings,
    tags: spec.tags,
    externalDocs: spec.externalDocs,
  });
}

export interface MessageSource {
  /** MessageVersion id, or the Message id for a draft preview (D4). */
  id: string;
  messageId: string;
  name: string;
  productSlug: string;
  spec: MessageSpec;
  payload: ArtifactSubject;
  headers: ArtifactSubject | null;
  key: ArtifactSubject | null;
  unpublished: boolean;
}

export interface MessageVersionRow {
  id: string;
  messageId: string;
  major: number;
  minor: number;
  resolvedSpec: unknown;
  message: { name: string; product: { slug: string } | null };
}

export function messageSourceFromVersion(row: MessageVersionRow): MessageSource | null {
  if (!isJsonObject(row.resolvedSpec) || !isJsonObject(row.resolvedSpec.payload)) return null;
  const resolved = row.resolvedSpec as unknown as MessageResolvedSpec;
  const subject = (pin: MessageResolvedSpec["headers"]): ArtifactSubject | null =>
    pin ? { kind: "version", entityVersionId: pin.entityVersionId } : null;
  return {
    id: row.id,
    messageId: row.messageId,
    name: typeof resolved.name === "string" ? resolved.name : row.message.name,
    productSlug: row.message.product?.slug ?? "",
    spec: readMessageSpec(resolved.spec),
    payload: { kind: "version", entityVersionId: resolved.payload.entityVersionId },
    headers: subject(resolved.headers),
    key: subject(resolved.key),
    unpublished: false,
  };
}

export interface MessageDraftRow {
  id: string;
  name: string;
  spec: unknown;
  payloadEntityId: string;
  payloadEntityVersionId: string | null;
  headersEntityId: string | null;
  headersEntityVersionId: string | null;
  keyEntityId: string | null;
  keyEntityVersionId: string | null;
  product: { slug: string } | null;
}

const draftSubject = (entityId: string | null, versionId: string | null): ArtifactSubject | null =>
  entityId ? (versionId ? { kind: "version", entityVersionId: versionId } : { kind: "draft", entityId }) : null;

export function messageSourceFromDraft(row: MessageDraftRow): MessageSource {
  return {
    id: row.id,
    messageId: row.id,
    name: row.name,
    productSlug: row.product?.slug ?? "",
    spec: readMessageSpec(row.spec),
    payload: draftSubject(row.payloadEntityId, row.payloadEntityVersionId) as ArtifactSubject,
    headers: draftSubject(row.headersEntityId, row.headersEntityVersionId),
    key: draftSubject(row.keyEntityId, row.keyEntityVersionId),
    unpublished: true,
  };
}

export interface TraitRow {
  id: string;
  name: string;
  kind: TraitKind;
  spec: unknown;
  headersEntityId: string | null;
  headersEntityVersionId: string | null;
  tenant: { slug: string };
  domain: { slug: string } | null;
  product: { slug: string } | null;
}

export function toFrozenTrait(row: TraitRow): FrozenTrait {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    ownerSlug: row.product?.slug ?? row.domain?.slug ?? row.tenant.slug,
    spec: isJsonObject(row.spec) ? row.spec : {},
    headersEntityId: row.headersEntityId,
    headersEntityVersionId: row.headersEntityVersionId,
  };
}

export function traitHeadersSubject(t: FrozenTrait): ArtifactSubject | null {
  return draftSubject(t.headersEntityId, t.headersEntityVersionId);
}

export function toResolvedTrait(t: FrozenTrait, headers?: SchemaArtifact): ResolvedTrait {
  const resolved: ResolvedTrait = { id: t.id, name: t.name, kind: t.kind, ownerSlug: t.ownerSlug, spec: t.spec };
  if (headers) resolved.headers = headers;
  return resolved;
}

export function toResolvedMessage(
  source: MessageSource,
  artifacts: { payloads: SchemaArtifact[]; headers?: SchemaArtifact; keys: SchemaArtifact[] }
): ResolvedMessage {
  const s = source.spec;
  return compact<ResolvedMessage>({
    id: source.id,
    name: source.name,
    productSlug: source.productSlug,
    title: s.title,
    summary: s.summary,
    description: s.description,
    contentType: s.contentType,
    correlationId: s.correlationId,
    tags: s.tags,
    externalDocs: s.externalDocs,
    bindings: s.bindings,
    examples: s.examples,
    traitRefs: [...s.traitIds],
    payloads: artifacts.payloads,
    headers: artifacts.headers,
    keys: artifacts.keys.length > 0 ? artifacts.keys : undefined,
    unpublished: source.unpublished || undefined,
  });
}

/** Spec §7.2 step 3: payload formats = the channels' formats; Kafka keys = Avro on Avro channels, else JSON Schema. */
export function planArtifacts(
  doc: EventSpecDocument,
  channels: Map<string, ResolvedChannel>
): Map<string, { payloadFormats: PayloadFormat[]; keyFormats: PayloadFormat[] }> {
  const needs = new Map<string, { payload: Set<PayloadFormat>; key: Set<PayloadFormat> }>();
  const add = (channelId: string | undefined, messageIds: string[] | undefined) => {
    const channel = channelId ? channels.get(channelId) : undefined;
    if (!channel || !messageIds) return;
    for (const id of messageIds) {
      const entry = needs.get(id) ?? { payload: new Set<PayloadFormat>(), key: new Set<PayloadFormat>() };
      entry.payload.add(channel.profile.format);
      if (channel.protocol === "kafka") entry.key.add(channel.profile.format === "avro" ? "avro" : "json-schema");
      needs.set(id, entry);
    }
  };
  for (const op of doc.operations) {
    add(op.channelId, op.messageVersionIds);
    add(op.reply?.channelId, op.reply?.messageVersionIds); // reply messages need a reply channel (assembler rule)
  }
  return new Map([...needs].map(([id, e]) => [id, { payloadFormats: [...e.payload].sort(), keyFormats: [...e.key].sort() }]));
}
```

- [ ] **Step 4: Run the pure test**

Run: `npx vitest run tests/unit/lib/events/catalog-mapping.test.ts`
Expected: PASS.

- [ ] **Step 5: Implement `src/services/events/event-spec-resolver.ts`**

```ts
import type { PrismaClient, Prisma } from "@/generated/prisma/client";
import { diagnostic } from "@/lib/event-specs/diagnostics";
import { resolveEventSpecDocument, type ResolveProblem } from "@/lib/event-specs/resolve";
import type { Diagnostic, EventSpecDocument, PayloadFormat, ResolvedChannel, ResolvedEventSpec, SchemaArtifact } from "@/lib/event-specs/types";
import { formatVersionLabel } from "@/lib/entity-versioning/version-math";
import type { MessageVersionInfo } from "@/lib/events/bump-rules";
import {
  messageSourceFromDraft, messageSourceFromVersion, planArtifacts, toFrozenTrait, toResolvedChannel, toResolvedMessage, toResolvedTrait,
  traitHeadersSubject, type MessageSource,
} from "@/lib/events/catalog-mapping";
import { collectDocumentRefs, parseEventSpecDocument } from "@/lib/events/event-spec-document";
import type { FrozenTrait } from "@/lib/events/types";
import { ok, err, type Result } from "@/types/result";
import type { ArtifactRenderer, ArtifactSubject } from "./artifact-renderer";

type Db = PrismaClient | Prisma.TransactionClient;

/** D13: `info.version` of a draft emission. */
export const DRAFT_VERSION = "draft";

export interface LatestEventSpecVersion {
  id: string;
  major: number;
  minor: number;
  sequence: number;
  sourceDocument: EventSpecDocument;
  frozenChannels: ResolvedChannel[];
  frozenTraits: FrozenTrait[];
  messageVersionIds: string[];
}

export interface DraftSnapshot {
  spec: {
    id: string; name: string; specType: string; tenantId: string; domainId: string | null; productId: string; productSlug: string;
    updatedAt: Date; hasUnpublishedChanges: boolean; latestVersionId: string | null;
  };
  document: EventSpecDocument;
  latest: LatestEventSpecVersion | null;
  /** Referenced channels (incl. other products'), live, first-reference order. */
  channels: ResolvedChannel[];
  /** Operation traits + message traits, live, first-reference order. */
  traits: FrozenTrait[];
  messages: MessageSource[];
  /** Every MessageVersion used by the draft or by the latest version. */
  messageVersionInfo: Record<string, MessageVersionInfo>;
  /** Unresolved draft references (pointers into the draft document). */
  unresolved: ResolveProblem[];
}

const CHANNEL_SELECT = {
  id: true, name: true, address: true, protocol: true, format: true, formatDialect: true, spec: true, product: { select: { slug: true } },
} satisfies Prisma.ChannelSelect;
const TRAIT_SELECT = {
  id: true, name: true, kind: true, spec: true, headersEntityId: true, headersEntityVersionId: true,
  tenant: { select: { slug: true } }, domain: { select: { slug: true } }, product: { select: { slug: true } },
} satisfies Prisma.TraitSelect;
const VERSION_SELECT = {
  id: true, messageId: true, major: true, minor: true, resolvedSpec: true, message: { select: { name: true, product: { select: { slug: true } } } },
} satisfies Prisma.MessageVersionSelect;
const DRAFT_SELECT = {
  id: true, name: true, spec: true, payloadEntityId: true, payloadEntityVersionId: true, headersEntityId: true, headersEntityVersionId: true,
  keyEntityId: true, keyEntityVersionId: true, product: { select: { slug: true } },
} satisfies Prisma.MessageSelect;

const present = <T>(v: T | undefined): v is T => v !== undefined;

/** Spec §7.2 step 2 (DB half): everything a draft needs, without rendering any artifact. */
export async function loadDraftSnapshot(db: Db, specId: string): Promise<Result<DraftSnapshot>> {
  const row = await db.eventSpec.findUnique({
    where: { id: specId },
    select: {
      id: true, name: true, specType: true, document: true, tenantId: true, domainId: true, productId: true, updatedAt: true,
      hasUnpublishedChanges: true, latestVersionId: true, product: { select: { slug: true } },
      latestVersion: { select: { id: true, major: true, minor: true, sequence: true, sourceDocument: true, frozenChannels: true, frozenTraits: true, messageVersionIds: true } },
    },
  });
  if (!row || !row.productId || !row.product) return err({ code: "NOT_FOUND", message: `Event spec "${specId}" not found` });
  const document = parseEventSpecDocument(row.document);
  if (!document.success) return err({ code: "DATA_CORRUPT", message: `Stored draft of "${row.name}" is invalid`, details: document.error.details });

  let latest: LatestEventSpecVersion | null = null;
  if (row.latestVersion) {
    const source = parseEventSpecDocument(row.latestVersion.sourceDocument);
    if (!source.success) return err({ code: "DATA_CORRUPT", message: `Published source document of "${row.name}" is invalid` });
    latest = {
      id: row.latestVersion.id, major: row.latestVersion.major, minor: row.latestVersion.minor, sequence: row.latestVersion.sequence,
      sourceDocument: source.data,
      frozenChannels: (row.latestVersion.frozenChannels as unknown as ResolvedChannel[]) ?? [],
      frozenTraits: (row.latestVersion.frozenTraits as unknown as FrozenTrait[]) ?? [],
      messageVersionIds: row.latestVersion.messageVersionIds,
    };
  }

  const refs = collectDocumentRefs(document.data);
  const versionIds = [...new Set([...refs.messageRefIds, ...(latest?.messageVersionIds ?? [])])];
  const [channelRows, versionRows] = await Promise.all([
    db.channel.findMany({ where: { id: { in: refs.channelIds }, tenantId: row.tenantId }, select: CHANNEL_SELECT }),
    db.messageVersion.findMany({ where: { id: { in: versionIds }, message: { tenantId: row.tenantId } }, select: VERSION_SELECT }),
  ]);
  const versionById = new Map(versionRows.map((v) => [v.id, v]));
  const draftIds = refs.messageRefIds.filter((id) => !versionById.has(id));
  const draftRows = draftIds.length > 0
    ? await db.message.findMany({ where: { id: { in: draftIds }, productId: row.productId }, select: DRAFT_SELECT })
    : [];
  const draftById = new Map(draftRows.map((d) => [d.id, d]));

  const messages: MessageSource[] = refs.messageRefIds
    .map((id) => {
      const v = versionById.get(id);
      if (v) return messageSourceFromVersion(v) ?? undefined;
      const d = draftById.get(id);
      return d ? messageSourceFromDraft(d) : undefined;
    })
    .filter(present);

  const traitIds = [...new Set([...refs.traitIds, ...messages.flatMap((m) => m.spec.traitIds)])];
  const traitRows = traitIds.length > 0 ? await db.trait.findMany({ where: { id: { in: traitIds }, tenantId: row.tenantId }, select: TRAIT_SELECT }) : [];
  const traitById = new Map(traitRows.map((t) => [t.id, toFrozenTrait(t)]));
  const traits = traitIds.map((id) => traitById.get(id)).filter(present);
  const channelById = new Map(channelRows.map((c) => [c.id, toResolvedChannel(c)]));
  const channels = refs.channelIds.map((id) => channelById.get(id)).filter(present);

  const messageVersionInfo: Record<string, MessageVersionInfo> = {};
  for (const v of versionRows) messageVersionInfo[v.id] = { messageId: v.messageId, messageName: v.message.name, major: v.major, label: formatVersionLabel(v) };

  // Reference check with an artifact-less catalog: every unresolved id is reported together, with a draft pointer.
  const skeleton = resolveEventSpecDocument(
    document.data,
    { channels, messages: messages.map((m) => toResolvedMessage(m, { payloads: [], keys: [] })), traits: traits.map((t) => toResolvedTrait(t)) },
    { productSlug: row.product.slug, version: DRAFT_VERSION }
  );
  const unresolved: ResolveProblem[] = skeleton.success
    ? []
    : ((skeleton.error.details as { problems?: ResolveProblem[] } | undefined)?.problems ?? [{ pointer: "", message: skeleton.error.message }]);

  return ok({
    spec: {
      id: row.id, name: row.name, specType: row.specType, tenantId: row.tenantId, domainId: row.domainId, productId: row.productId,
      productSlug: row.product.slug, updatedAt: row.updatedAt, hasUnpublishedChanges: row.hasUnpublishedChanges, latestVersionId: row.latestVersionId,
    },
    document: document.data,
    latest,
    channels,
    traits,
    messages,
    messageVersionInfo,
    unresolved,
  });
}

/** Spec §7.2 step 3: render every artifact in the channels' format profiles, then build the ResolvedEventSpec. */
export async function resolveSnapshot(
  snapshot: DraftSnapshot,
  renderer: ArtifactRenderer,
  version: string
): Promise<{ resolved: ResolvedEventSpec | null; diagnostics: Diagnostic[] }> {
  if (snapshot.unresolved.length > 0) {
    return { resolved: null, diagnostics: snapshot.unresolved.map((p) => diagnostic("error", "UNRESOLVED_REFERENCE", `Draft reference: ${p.message}`, p.pointer)) };
  }
  const diagnostics: Diagnostic[] = [];
  const render = async (subject: ArtifactSubject | null, format: PayloadFormat, what: string): Promise<SchemaArtifact | undefined> => {
    if (!subject) return undefined;
    const r = await renderer.render(subject, format);
    if (!r.success) {
      diagnostics.push(diagnostic("error", r.error.code, `${what} (${format}): ${r.error.message}`, ""));
      return undefined;
    }
    for (const w of r.data.warnings) diagnostics.push(diagnostic("warning", "TYPESPEC_DUPLICATE_DECLARATION", `${what}: ${w}`, ""));
    return r.data.artifact;
  };
  const isArtifact = (a: SchemaArtifact | undefined): a is SchemaArtifact => a !== undefined;

  const needs = planArtifacts(snapshot.document, new Map(snapshot.channels.map((c) => [c.id, c])));
  const messages = await Promise.all(
    snapshot.messages.map(async (m) => {
      const need = needs.get(m.id) ?? { payloadFormats: [], keyFormats: [] };
      const [payloads, keys, headers] = await Promise.all([
        Promise.all(need.payloadFormats.map((f) => render(m.payload, f, `Message ${m.name} payload`))),
        Promise.all(need.keyFormats.map((f) => render(m.key, f, `Message ${m.name} key`))),
        render(m.headers, "json-schema", `Message ${m.name} headers`),
      ]);
      return toResolvedMessage(m, { payloads: payloads.filter(isArtifact), keys: keys.filter(isArtifact), headers });
    })
  );
  const traits = await Promise.all(
    snapshot.traits.map(async (t) => toResolvedTrait(t, await render(traitHeadersSubject(t), "json-schema", `Trait ${t.name} headers`)))
  );
  const resolved = resolveEventSpecDocument(snapshot.document, { channels: snapshot.channels, messages, traits }, { productSlug: snapshot.spec.productSlug, version });
  if (!resolved.success) return { resolved: null, diagnostics: [...diagnostics, diagnostic("error", resolved.error.code, resolved.error.message, "")] };
  return { resolved: resolved.data, diagnostics };
}
```

- [ ] **Step 6: Implement `src/services/events/event-spec-emit.service.ts`**

```ts
import {
  getEventSpecAdapter, normalizeDiagnostics, StructuralAsyncApi3Validator, toJson, toYaml,
  type Diagnostic, type EmitOutput, type EventSpecValidator, type JsonObject, type ResolvedEventSpec,
} from "@/lib/event-specs";
import { AsyncApiParserValidator } from "@/lib/event-specs/validation/asyncapi-parser-validator";
import { formatVersionLabel, parseVersionLabel } from "@/lib/entity-versioning/version-math";
import { isJsonObject } from "@/lib/events/inputs";
import { ok, err, type Result } from "@/types/result";
import type { ServiceContext } from "@/types/service-context";
import { getSharedArtifactRenderer, type ArtifactRenderer } from "./artifact-renderer";
import { DRAFT_VERSION, loadDraftSnapshot, resolveSnapshot } from "./event-spec-resolver";

export type EmitTarget = { draft: true } | { versionLabel: string };

export interface EventSpecEmission {
  specId: string;
  specName: string;
  /** "draft" or MAJOR.MINOR. */
  version: string;
  published: boolean;
  document: JsonObject | null;
  json: string | null;
  yaml: string | null;
  diagnostics: Diagnostic[];
  unpublishedMessages: Array<{ id: string; name: string }>;
}

export interface EmitDeps {
  renderer?: ArtifactRenderer;
  validators?: EventSpecValidator[];
}

let sharedValidators: EventSpecValidator[] | undefined;

/** D10: structural + @asyncapi/parser (one parser instance per process — it is expensive to build). */
export function defaultEventSpecValidators(): EventSpecValidator[] {
  sharedValidators ??= [new StructuralAsyncApi3Validator(), new AsyncApiParserValidator()];
  return sharedValidators;
}

export async function emitResolved(resolved: ResolvedEventSpec, specType: string, deps: EmitDeps = {}): Promise<Result<EmitOutput>> {
  const adapter = getEventSpecAdapter(specType, { validators: deps.validators ?? defaultEventSpecValidators() });
  if (!adapter.success) return adapter;
  return adapter.data.emit(resolved);
}

async function emitStoredVersion(ctx: ServiceContext, specId: string, label: string): Promise<Result<EventSpecEmission>> {
  const parsed = parseVersionLabel(label);
  if (!parsed.success) return parsed;
  const row = await ctx.prisma.eventSpecVersion.findUnique({
    where: { eventSpecId_major_minor: { eventSpecId: specId, major: parsed.data.major, minor: parsed.data.minor } },
    select: { document: true, major: true, minor: true, compatReport: true, eventSpec: { select: { name: true } } },
  });
  if (!row) {
    return err({ code: "NOT_FOUND", message: `Version ${formatVersionLabel(parsed.data)} of event spec "${specId}" not found`, suggestedFix: "List the published versions and pick one." });
  }
  const document = row.document as JsonObject;
  const report = isJsonObject(row.compatReport) ? row.compatReport : {};
  return ok({
    specId,
    specName: row.eventSpec.name,
    version: formatVersionLabel(row),
    published: true,
    document,
    json: toJson(document),
    yaml: toYaml(document),
    diagnostics: Array.isArray(report.diagnostics) ? (report.diagnostics as unknown as Diagnostic[]) : [],
    unpublishedMessages: [],
  });
}

/** Spec §7.2: a published version returns its stored document (never regenerated); a draft is resolved, rendered, emitted and validated. */
export async function emitEventSpec(specId: string, target: EmitTarget, ctx: ServiceContext, deps: EmitDeps = {}): Promise<Result<EventSpecEmission>> {
  if ("versionLabel" in target) return emitStoredVersion(ctx, specId, target.versionLabel);
  const snapshot = await loadDraftSnapshot(ctx.prisma, specId);
  if (!snapshot.success) return snapshot;
  const draft = await resolveSnapshot(snapshot.data, deps.renderer ?? getSharedArtifactRenderer(ctx.prisma), DRAFT_VERSION);
  const base = {
    specId,
    specName: snapshot.data.spec.name,
    version: DRAFT_VERSION,
    published: false,
    unpublishedMessages: snapshot.data.messages.filter((m) => m.unpublished).map((m) => ({ id: m.messageId, name: m.name })),
  };
  if (!draft.resolved) return ok({ ...base, document: null, json: null, yaml: null, diagnostics: normalizeDiagnostics(draft.diagnostics) });
  const out = await emitResolved(draft.resolved, snapshot.data.spec.specType, deps);
  if (!out.success) return out;
  return ok({
    ...base,
    document: out.data.document,
    json: out.data.json,
    yaml: out.data.yaml,
    diagnostics: normalizeDiagnostics([...draft.diagnostics, ...out.data.diagnostics]),
  });
}

export async function getLatestEventSpecVersionLabel(specId: string, ctx: ServiceContext): Promise<Result<string | null>> {
  const row = await ctx.prisma.eventSpec.findUnique({ where: { id: specId }, select: { latestVersion: { select: { major: true, minor: true } } } });
  if (!row) return err({ code: "NOT_FOUND", message: `Event spec "${specId}" not found` });
  return ok(row.latestVersion ? formatVersionLabel(row.latestVersion) : null);
}
```

- [ ] **Step 7: Implement the emit actions** (`event-spec-emit-actions.ts`) + their unit test

```ts
// src/app/(dashboard)/schemas/[domainSlug]/[productSlug]/event-spec-emit-actions.ts
"use server";

import { getActionContext, NOT_AUTHENTICATED, toActionResult } from "@/lib/action-context";
import { emitEventSpec, type EventSpecEmission } from "@/services/events/event-spec-emit.service";
import type { ActionResult } from "@/types/action-result";

/** Read-only: no revalidation. Draft emission renders artifacts on demand (D9) and validates with @asyncapi/parser. */
export async function emitEventSpecDraftAction(specId: string): Promise<ActionResult<EventSpecEmission>> {
  const ctx = await getActionContext();
  if (!ctx) return NOT_AUTHENTICATED;
  return toActionResult(await emitEventSpec(specId, { draft: true }, ctx));
}

export async function getEventSpecVersionDocumentAction(specId: string, label: string): Promise<ActionResult<EventSpecEmission>> {
  const ctx = await getActionContext();
  if (!ctx) return NOT_AUTHENTICATED;
  return toActionResult(await emitEventSpec(specId, { versionLabel: label }, ctx));
}
```

`tests/unit/app/event-spec-emit-actions.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({ auth: vi.fn(), revalidatePath: vi.fn(), emitEventSpec: vi.fn() }));
vi.mock("@/lib/db", () => ({ prisma: { tag: "prisma" } }));
vi.mock("@/lib/auth", () => ({ auth: h.auth }));
vi.mock("next/cache", () => ({ revalidatePath: h.revalidatePath }));
vi.mock("@/services/rbac.service", () => ({ getEffectiveRole: vi.fn().mockResolvedValue({ success: true, data: "VIEWER" }) }));
vi.mock("@/services/events/event-spec-emit.service", () => ({ emitEventSpec: h.emitEventSpec }));

import { emitEventSpecDraftAction, getEventSpecVersionDocumentAction } from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/event-spec-emit-actions";

beforeEach(() => {
  vi.clearAllMocks();
  h.auth.mockResolvedValue({ user: { id: "u1" } });
  h.emitEventSpec.mockResolvedValue({ success: true, data: { version: "draft" } });
});

describe("event spec emit actions", () => {
  it("emit the draft or a version without revalidating", async () => {
    expect(await emitEventSpecDraftAction("s1")).toEqual({ success: true, data: { version: "draft" } });
    expect(h.emitEventSpec).toHaveBeenCalledWith("s1", { draft: true }, { userId: "u1", userRole: "VIEWER", prisma: { tag: "prisma" } });
    await getEventSpecVersionDocumentAction("s1", "2.0");
    expect(h.emitEventSpec).toHaveBeenLastCalledWith("s1", { versionLabel: "2.0" }, expect.anything());
    expect(h.revalidatePath).not.toHaveBeenCalled();
  });

  it("requires a session", async () => {
    h.auth.mockResolvedValue(null);
    expect(await emitEventSpecDraftAction("s1")).toMatchObject({ success: false, code: "UNAUTHORIZED" });
  });
});
```

- [ ] **Step 8: Write the end-to-end integration test** (`tests/integration/services/events/event-spec-emit.test.ts`) — real DB, real emitters, real parser (never mocked, spec §11)

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import type { JsonObject } from "@/lib/event-specs/types";
import type { ServiceContext } from "@/types/service-context";
import { createArtifactRenderer } from "@/services/events/artifact-renderer";
import { createChannel } from "@/services/events/channel.service";
import { createEventSpec, updateEventSpecDocument } from "@/services/events/event-spec.service";
import { emitEventSpec } from "@/services/events/event-spec-emit.service";
import { createMessage } from "@/services/events/message.service";
import { createTrait } from "@/services/events/trait.service";
import { cleanupDomains, connectTestDb, createProductScope, testContext, unwrap } from "./helpers";

let prisma: PrismaClient;
let ctx: ServiceContext;
beforeAll(async () => {
  prisma = connectTestDb();
  ctx = await testContext(prisma);
});
afterAll(async () => prisma.$disconnect());

const errorsOf = (diagnostics: Array<{ severity: string }>) => diagnostics.filter((d) => d.severity === "error");

describe.sequential("emitEventSpec — DB → ResolvedEventSpec → AsyncAPI 3 (parser-validated)", () => {
  it("emits the §6.2-shaped producer spec (Avro + Kafka key + CloudEvents headers), a JSON consumer spec, and a draft preview", async () => {
    const domainIds: Array<string | undefined> = [];
    try {
      const checkout = await createProductScope(prisma, ctx, "co");
      const fraud = await createProductScope(prisma, ctx, "fr");
      domainIds.push(checkout.domain.id, fraud.domain.id);
      const s = checkout.s;
      const renderer = createArtifactRenderer({ db: prisma });

      const address = await checkout.publishedEntity("Address", [{ name: "street", type: "string" }]);
      const order = await checkout.publishedEntity("Order", [
        { name: "id", type: "string" },
        { name: "address", type: "reference", ref: { id: address.entity.id, name: "Address" } },
      ]);
      const orderKey = await checkout.publishedEntity("OrderKey", [{ name: "id", type: "string" }]);
      const headers = await checkout.publishedEntity("CloudEventsHeaders", [
        { name: "ce_id", type: "string" }, { name: "ce_type", type: "string" }, { name: "ce_source", type: "string" },
      ]);
      const trait = unwrap(await createTrait({ level: "DOMAIN", domainId: checkout.domain.id }, { name: `CloudEvents-${s}`, kind: "MESSAGE", headers: { entityId: headers.entity.id } }, ctx));

      const message = unwrap(await createMessage(checkout.product.id, {
        name: `OrderCreated-${s}`, spec: { contentType: "avro/binary", traitIds: [trait.id] },
        payload: { entityId: order.entity.id }, key: { entityId: orderKey.entity.id },
      }, ctx));
      // Task 10 (publish) lands in the same wave; freeze a version directly.
      const mv = await prisma.messageVersion.create({
        data: {
          messageId: message.id, major: 1, minor: 0, sequence: 1, changeKind: "INITIAL", publishedById: ctx.userId,
          payloadEntityVersionId: order.version.id, keyEntityVersionId: orderKey.version.id,
          resolvedSpec: {
            name: message.name, spec: { contentType: "avro/binary", traitIds: [trait.id] },
            payload: { entityId: order.entity.id, entityName: "Order", entityVersionId: order.version.id, label: "1.0", major: 1 },
            headers: null,
            key: { entityId: orderKey.entity.id, entityName: "OrderKey", entityVersionId: orderKey.version.id, label: "1.0", major: 1 },
          },
        },
      });

      const avroChannel = unwrap(await createChannel(checkout.product.id, {
        name: `orders-${s}`, address: "payments.orders.v1", protocol: "kafka", format: "avro", spec: { bindings: { kafka: { partitions: 12 } } },
      }, ctx));
      const jsonChannel = unwrap(await createChannel(checkout.product.id, {
        name: `orders-json-${s}`, address: "payments.orders.json.v1", protocol: "kafka", format: "json-schema",
      }, ctx));

      // Producer spec (Checkout).
      const producer = unwrap(await createEventSpec(checkout.product.id, { name: `checkout-service-${s}`, title: "checkout-service" }, ctx));
      unwrap(await updateEventSpecDocument(producer.id, {
        info: { title: "checkout-service" },
        servers: [{ key: "kafka-prod", protocol: "kafka", host: "kafka-prod.internal:9092" }],
        operations: [{ key: "publishOrderCreated", action: "send", channelId: avroChannel.id, messageVersionIds: [mv.id], traitIds: [] }],
      }, { level: "PRODUCT", productId: checkout.product.id }, ctx));

      const emitted = unwrap(await emitEventSpec(producer.id, { draft: true }, ctx, { renderer }));
      expect(errorsOf(emitted.diagnostics)).toEqual([]);
      const doc = emitted.document as JsonObject;
      expect(doc.asyncapi).toBe("3.0.0");
      expect(doc.info).toEqual({ title: "checkout-service", version: "draft" });
      const component = ((doc.components as JsonObject).messages as JsonObject)[message.name] as JsonObject;
      expect(component.contentType).toBe("avro/binary");
      expect((component.payload as JsonObject).schemaFormat).toBe("application/vnd.apache.avro+json;version=1.9.0");
      expect(((component.bindings as JsonObject).kafka as JsonObject).key).toMatchObject({ type: "record", name: "OrderKey" });
      const traitComponent = ((doc.components as JsonObject).messageTraits as JsonObject)[trait.name] as JsonObject;
      expect((traitComponent.headers as JsonObject).type).toBe("object");
      expect(emitted.yaml).toContain("asyncapi: 3.0.0");

      // Consumer spec (Fraud) on Checkout's JSON channel — cross-product, read-only.
      const consumer = unwrap(await createEventSpec(fraud.product.id, { name: `fraud-scorer-${fraud.s}`, title: "fraud-scorer" }, ctx));
      unwrap(await updateEventSpecDocument(consumer.id, {
        info: { title: "fraud-scorer" }, servers: [],
        operations: [{ key: "consumeOrderCreated", action: "receive", channelId: jsonChannel.id, messageVersionIds: [mv.id], traitIds: [] }],
      }, { level: "PRODUCT", productId: fraud.product.id }, ctx));
      const consumed = unwrap(await emitEventSpec(consumer.id, { draft: true }, ctx, { renderer }));
      expect(errorsOf(consumed.diagnostics)).toEqual([]);
      const json = JSON.stringify(consumed.document);
      expect(json).toContain("application/schema+json;version=draft-07");
      expect(json).not.toMatch(/"\$ref":"[^#]/); // Review Focus 4: no file refs (Address.json) reach the document

      // Draft preview with an unpublished own-product message (D4).
      unwrap(await updateEventSpecDocument(producer.id, {
        info: { title: "checkout-service" }, servers: [],
        operations: [{ key: "publishDraft", action: "send", channelId: avroChannel.id, messageVersionIds: [message.id], traitIds: [] }],
      }, { level: "PRODUCT", productId: checkout.product.id }, ctx));
      const preview = unwrap(await emitEventSpec(producer.id, { draft: true }, ctx, { renderer }));
      expect(preview.unpublishedMessages).toEqual([{ id: message.id, name: message.name }]);
      expect(preview.diagnostics.some((d) => d.code === "UNPUBLISHED_MESSAGE")).toBe(true);

      // Unresolved references are reported with draft pointers, no document.
      await prisma.eventSpec.update({
        where: { id: producer.id },
        data: { document: { info: { title: "x" }, servers: [], operations: [{ key: "op", action: "send", channelId: "gone", messageVersionIds: [], traitIds: [] }] } },
      });
      const broken = unwrap(await emitEventSpec(producer.id, { draft: true }, ctx, { renderer }));
      expect(broken.document).toBeNull();
      expect(broken.diagnostics).toEqual([{ severity: "error", code: "UNRESOLVED_REFERENCE", message: 'Draft reference: Channel "gone" not found', pointer: "/operations/0/channelId" }]);
    } finally {
      await cleanupDomains(prisma, domainIds);
    }
  }, 180_000);
});
```

- [ ] **Step 9: Run the task's tests**

Run: `npx vitest run tests/unit/lib/events/catalog-mapping.test.ts tests/unit/app/event-spec-emit-actions.test.ts && npx vitest run tests/integration/services/events/event-spec-emit.test.ts --no-file-parallelism`
Expected: PASS. If the parser reports an error diagnostic, print `emitted.diagnostics` — it is a genuine assembler / rendering issue (Track C's `$ref` rebasing — Phase 4a decision D8 — is the first suspect); do not relax the assertion.

- [ ] **Step 10: Type check + commit**

Run: `npx tsc --noEmit` — Expected: no errors.

```bash
git add src/lib/events/catalog-mapping.ts src/services/events/event-spec-resolver.ts src/services/events/event-spec-emit.service.ts "src/app/(dashboard)/schemas/[domainSlug]/[productSlug]/event-spec-emit-actions.ts" tests/unit/lib/events/catalog-mapping.test.ts tests/unit/app/event-spec-emit-actions.test.ts tests/integration/services/events/event-spec-emit.test.ts
git commit -m "feat(18.4,18.5): DB-backed event spec emission — resolver, on-demand artifacts, parser-validated AsyncAPI 3"
```

---
### Task 10: Message publish — service + actions (Story 18.3) — Wave 3

**Files:**
- Create: `src/services/events/version-summary.ts`, `src/services/events/message-publish.service.ts`
- Create: `src/app/(dashboard)/schemas/[domainSlug]/[productSlug]/message-version-actions.ts`
- Test: `tests/integration/services/events/message-publish.test.ts`, `tests/unit/app/message-version-actions.test.ts`

**Interfaces:**

```ts
// version-summary.ts
VERSION_SUMMARY_SELECT; toEventVersionSummary(row): EventVersionSummary
// message-publish.service.ts
loadMessagePublishState(db, messageId): Promise<Result<MessagePublishState>>
previewMessagePublish(messageId, ctx): Promise<Result<EventPublishAnalysis>>
publishMessage(messageId, input: PublishInput, ctx): Promise<Result<EventVersionSummary>>
listMessageVersions(messageId, ctx): Promise<Result<EventVersionSummary[]>>
getMessageVersion(messageId, label, ctx): Promise<Result<{ summary: EventVersionSummary; resolvedSpec: MessageResolvedSpec }>>
// message-version-actions.ts ("use server")
getMessagePublishPreviewAction(messageId): Promise<ActionResult<EventPublishAnalysis>>
publishMessageAction(messageId, input: PublishInput): Promise<ActionResult<EventVersionSummary>>   // revalidates on success
listMessageVersionsAction(messageId): Promise<ActionResult<EventVersionSummary[]>>
```

- [ ] **Step 1: Write the failing integration test** (`tests/integration/services/events/message-publish.test.ts`)

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import type { ServiceContext } from "@/types/service-context";
import { publishEntity } from "@/services/entity-version.service";
import { createMessage, updateMessage } from "@/services/events/message.service";
import { createTrait } from "@/services/events/trait.service";
import { getMessageVersion, listMessageVersions, previewMessagePublish, publishMessage } from "@/services/events/message-publish.service";
import { cleanupDomains, connectTestDb, createProductScope, testContext, unwrap } from "./helpers";

let prisma: PrismaClient;
let ctx: ServiceContext;
beforeAll(async () => {
  prisma = connectTestDb();
  ctx = await testContext(prisma);
});
afterAll(async () => prisma.$disconnect());

describe("message publish (spec §6.1, §10)", () => {
  it("reports all blockers together, then publishes 1.0 → 1.1 → 2.0 with raise-only bumps and frozen pins", async () => {
    let domainId: string | undefined;
    try {
      const sc = await createProductScope(prisma, ctx);
      domainId = sc.domain.id;
      const owner = { level: "PRODUCT" as const, productId: sc.product.id };
      const order = await sc.entity("Order");
      const trait = unwrap(await createTrait({ level: "DOMAIN", domainId: sc.domain.id }, { name: `CE-${sc.s}`, kind: "MESSAGE" }, ctx));
      const message = unwrap(await createMessage(sc.product.id, {
        name: `OrderCreated-${sc.s}`, spec: { correlationId: { location: "header.id" }, traitIds: [trait.id] }, payload: { entityId: order.id },
      }, ctx));
      await prisma.trait.delete({ where: { id: trait.id } });

      const blockedPreview = unwrap(await previewMessagePublish(message.id, ctx));
      expect(blockedPreview.blockers.map((b) => b.kind)).toEqual(["UNPUBLISHED_PIN", "MISSING_TRAIT", "INVALID_SPEC"]);
      const blocked = await publishMessage(message.id, {}, ctx);
      expect(!blocked.success && blocked.error.code).toBe("PUBLISH_BLOCKED");
      expect(await prisma.messageVersion.count({ where: { messageId: message.id } })).toBe(0);

      const orderV1 = unwrap(await publishEntity(order.id, {}, ctx));
      unwrap(await updateMessage(message.id, { name: message.name, spec: { contentType: "avro/binary", traitIds: [] }, payload: { entityId: order.id } }, owner, ctx));
      const v1 = unwrap(await publishMessage(message.id, { changeSummary: "first" }, ctx));
      expect(v1).toMatchObject({ label: "1.0", changeKind: "INITIAL", sequence: 1, changeSummary: "first" });
      expect(await prisma.message.findUniqueOrThrow({ where: { id: message.id } })).toMatchObject({ latestVersionId: v1.id, hasUnpublishedChanges: false });
      const refs = await prisma.schemaReference.findMany({ where: { fromKind: "MESSAGE_VERSION", fromId: v1.id } });
      expect(refs.map((r) => [r.role, r.toId, r.isDraft])).toEqual([["PAYLOAD", orderV1.id, false]]);
      const frozen = unwrap(await getMessageVersion(message.id, "1.0", ctx));
      expect(frozen.resolvedSpec.payload).toMatchObject({ entityName: "Order", entityVersionId: orderV1.id, label: "1.0" });

      const again = await publishMessage(message.id, {}, ctx);
      expect(!again.success && JSON.stringify(again.error.details)).toContain("NO_CHANGES");

      unwrap(await updateMessage(message.id, { name: message.name, spec: { contentType: "avro/binary", description: "docs", traitIds: [] }, payload: { entityId: order.id, entityVersionId: orderV1.id } }, owner, ctx));
      expect(unwrap(await previewMessagePublish(message.id, ctx)).suggestedBump).toBe("MINOR");
      expect(unwrap(await publishMessage(message.id, {}, ctx)).label).toBe("1.1");

      await prisma.entity.update({ where: { id: order.id }, data: { description: "v2", hasUnpublishedChanges: true } });
      const orderV2 = unwrap(await publishEntity(order.id, { bump: "MAJOR" }, ctx));
      unwrap(await updateMessage(message.id, { name: message.name, spec: { contentType: "avro/binary", description: "docs", traitIds: [] }, payload: { entityId: order.id, entityVersionId: orderV2.id } }, owner, ctx));
      const majorPreview = unwrap(await previewMessagePublish(message.id, ctx));
      expect(majorPreview).toMatchObject({ suggestedBump: "MAJOR", candidateLabels: { MAJOR: "2.0", MINOR: "1.2" } });
      expect(majorPreview.reasons[0]).toMatch(/new major/);
      const tooLow = await publishMessage(message.id, { bump: "MINOR" }, ctx);
      expect(!tooLow.success && tooLow.error.code).toBe("BUMP_TOO_LOW");
      expect(unwrap(await publishMessage(message.id, {}, ctx))).toMatchObject({ label: "2.0", changeKind: "MAJOR", sequence: 3 });
      expect(unwrap(await listMessageVersions(message.id, ctx)).map((v) => v.label)).toEqual(["2.0", "1.1", "1.0"]);

      await expect(prisma.messageVersion.update({ where: { id: v1.id }, data: { changeSummary: "x" } })).rejects.toThrow(/immutable/);
    } finally {
      await cleanupDomains(prisma, [domainId]);
    }
  });

  it("serializes concurrent publishes of one message (exactly one wins)", async () => {
    let domainId: string | undefined;
    try {
      const sc = await createProductScope(prisma, ctx);
      domainId = sc.domain.id;
      const order = await sc.publishedEntity("Order");
      const message = unwrap(await createMessage(sc.product.id, { name: `OrderCreated-${sc.s}`, payload: { entityId: order.entity.id } }, ctx));
      const results = await Promise.all([publishMessage(message.id, {}, ctx), publishMessage(message.id, {}, ctx)]);
      expect(results.filter((r) => r.success)).toHaveLength(1);
      const loser = results.find((r) => !r.success);
      const loserCode = loser && !loser.success ? loser.error.code : "none";
      expect(["PUBLISH_BLOCKED", "CONFLICT"]).toContain(loserCode);
      expect(await prisma.messageVersion.count({ where: { messageId: message.id } })).toBe(1);
    } finally {
      await cleanupDomains(prisma, [domainId]);
    }
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/integration/services/events/message-publish.test.ts`
Expected: FAIL — missing module.

- [ ] **Step 3: Implement `src/services/events/version-summary.ts`**

```ts
import type { ChangeKind } from "@/lib/entity-versioning/types";
import { formatVersionLabel } from "@/lib/entity-versioning/version-math";
import type { EventVersionSummary } from "@/lib/events/types";

/** Shared by MessageVersion and EventSpecVersion selects (same column names). */
export const VERSION_SUMMARY_SELECT = {
  id: true, major: true, minor: true, sequence: true, changeKind: true, changeSummary: true, publishedAt: true,
  publishedBy: { select: { name: true } },
} as const;

export interface VersionSummaryRow {
  id: string;
  major: number;
  minor: number;
  sequence: number;
  changeKind: ChangeKind;
  changeSummary: string | null;
  publishedAt: Date;
  publishedBy: { name: string | null };
}

export function toEventVersionSummary(row: VersionSummaryRow): EventVersionSummary {
  return {
    id: row.id, major: row.major, minor: row.minor, label: formatVersionLabel(row), sequence: row.sequence,
    changeKind: row.changeKind, changeSummary: row.changeSummary, publishedByName: row.publishedBy.name,
    publishedAt: row.publishedAt.toISOString(),
  };
}
```

- [ ] **Step 4: Implement `src/services/events/message-publish.service.ts`**

```ts
import type { PrismaClient, Prisma } from "@/generated/prisma/client";
import { formatVersionLabel, parseVersionLabel } from "@/lib/entity-versioning/version-math";
import type { PublishInput } from "@/lib/entity-versioning/types";
import { readMessageSpec, validateMessageSpec } from "@/lib/events/catalog-specs";
import {
  analyzeVersionedPublish, messagePublishInput, planVersionedPublish,
  type EventPublishAnalysis, type MessagePublishState, type PinState,
} from "@/lib/events/publish-plan";
import type { EventVersionSummary, MessageResolvedSpec, PinRole } from "@/lib/events/types";
import { assertNameAvailable } from "@/services/name-registry.service";
import { auditedWrite } from "@/services/events/audited";
import { pinEdges, replaceReferences } from "@/services/events/schema-references";
import { toEventVersionSummary, VERSION_SUMMARY_SELECT } from "@/services/events/version-summary";
import { ok, err, type Result } from "@/types/result";
import type { ServiceContext } from "@/types/service-context";

type Db = PrismaClient | Prisma.TransactionClient;

const notFound = (messageId: string) => err({ code: "NOT_FOUND", message: `Message "${messageId}" not found` });
const isString = (v: string | null): v is string => typeof v === "string";

export async function loadMessagePublishState(db: Db, messageId: string): Promise<Result<MessagePublishState>> {
  const row = await db.message.findUnique({
    where: { id: messageId },
    select: {
      id: true, name: true, spec: true, hasUnpublishedChanges: true, tenantId: true, domainId: true, productId: true,
      payloadEntityId: true, payloadEntityVersionId: true, headersEntityId: true, headersEntityVersionId: true, keyEntityId: true, keyEntityVersionId: true,
      latestVersion: { select: { major: true, minor: true, sequence: true, resolvedSpec: true } },
    },
  });
  if (!row) return notFound(messageId);
  const spec = readMessageSpec(row.spec);
  const latestResolved = row.latestVersion ? (row.latestVersion.resolvedSpec as unknown as MessageResolvedSpec) : null;

  const roles: Array<[PinRole, string | null, string | null]> = [
    ["payload", row.payloadEntityId, row.payloadEntityVersionId],
    ["headers", row.headersEntityId, row.headersEntityVersionId],
    ["key", row.keyEntityId, row.keyEntityVersionId],
  ];
  const used = roles.filter((r): r is [PinRole, string, string | null] => r[1] !== null);
  const traitIds = [...new Set([...spec.traitIds, ...(latestResolved?.spec.traitIds ?? [])])];
  const [entities, versions, traits] = await Promise.all([
    db.entity.findMany({ where: { id: { in: used.map((r) => r[1]) } }, select: { id: true, name: true, latestVersion: { select: { major: true, minor: true } } } }),
    db.entityVersion.findMany({ where: { id: { in: used.map((r) => r[2]).filter(isString) } }, select: { id: true, entityId: true, major: true, minor: true } }),
    traitIds.length > 0 ? db.trait.findMany({ where: { id: { in: traitIds } }, select: { id: true, name: true, kind: true } }) : Promise.resolve([]),
  ]);

  const pins: PinState[] = used.map(([role, entityId, versionId]) => {
    const entity = entities.find((e) => e.id === entityId);
    const version = versionId ? versions.find((v) => v.id === versionId && v.entityId === entityId) : undefined;
    return {
      role,
      entityId,
      entityName: entity?.name ?? null,
      version: version ? { id: version.id, label: formatVersionLabel(version), major: version.major } : null,
      latestLabel: entity?.latestVersion ? formatVersionLabel(entity.latestVersion) : null,
    };
  });

  const name = await assertNameAvailable(db, {
    name: row.name, tenantId: row.tenantId, domainId: row.domainId, productId: row.productId, exclude: { kind: "message", id: row.id },
  });
  if (!name.success && name.error.code !== "NAME_CONFLICT") return name;

  return ok({
    name: row.name,
    hasUnpublishedChanges: row.hasUnpublishedChanges,
    spec,
    pins,
    missingTraitIds: spec.traitIds.filter((id) => !traits.some((t) => t.id === id && t.kind === "MESSAGE")),
    traitNames: Object.fromEntries(traits.map((t) => [t.id, t.name])),
    specProblems: validateMessageSpec(spec),
    nameConflict: name.success ? null : name.error.message,
    latest: row.latestVersion && latestResolved
      ? { major: row.latestVersion.major, minor: row.latestVersion.minor, sequence: row.latestVersion.sequence, resolved: latestResolved }
      : null,
  });
}

export async function previewMessagePublish(messageId: string, ctx: ServiceContext): Promise<Result<EventPublishAnalysis>> {
  const state = await loadMessagePublishState(ctx.prisma, messageId);
  if (!state.success) return state;
  return ok(analyzeVersionedPublish(messagePublishInput(state.data).input));
}

/** One transaction, message row locked (concurrent publishes serialize; the loser sees NO_CHANGES or the unique index → CONFLICT). */
export async function publishMessage(messageId: string, input: PublishInput, ctx: ServiceContext): Promise<Result<EventVersionSummary>> {
  const changeSummary = input.changeSummary?.trim() ? input.changeSummary.trim() : null;
  return auditedWrite({
    action: "PUBLISH_VERSION", entityType: "Message", entityId: messageId, userId: ctx.userId,
    run: () =>
      ctx.prisma.$transaction(
        async (tx): Promise<Result<EventVersionSummary>> => {
          await tx.$queryRaw`SELECT "id" FROM "messages" WHERE "id" = ${messageId} FOR UPDATE`;
          const state = await loadMessagePublishState(tx, messageId);
          if (!state.success) return state;
          const { input: versioned, resolved } = messagePublishInput(state.data);
          const plan = planVersionedPublish(versioned, input.bump);
          if (!plan.success) return plan;
          if (!resolved) return err({ code: "PUBLISH_BLOCKED", message: "The message pins could not be resolved" });

          const version = await tx.messageVersion.create({
            data: {
              messageId,
              major: plan.data.version.major,
              minor: plan.data.version.minor,
              sequence: plan.data.sequence,
              resolvedSpec: resolved as unknown as Prisma.InputJsonValue,
              payloadEntityVersionId: resolved.payload.entityVersionId,
              headersEntityVersionId: resolved.headers?.entityVersionId ?? null,
              keyEntityVersionId: resolved.key?.entityVersionId ?? null,
              changeKind: plan.data.changeKind,
              compatReport: { reasons: plan.data.reasons },
              changeSummary,
              publishedById: ctx.userId,
            },
            select: VERSION_SUMMARY_SELECT,
          });
          await replaceReferences(
            tx,
            { kind: "MESSAGE_VERSION", id: version.id },
            pinEdges({ payload: resolved.payload.entityVersionId, headers: resolved.headers?.entityVersionId ?? null, key: resolved.key?.entityVersionId ?? null }),
            false
          );
          await tx.message.update({ where: { id: messageId }, data: { latestVersionId: version.id, hasUnpublishedChanges: false }, select: { id: true } });
          return ok(toEventVersionSummary(version));
        },
        { timeout: 15_000 }
      ),
  });
}

export async function listMessageVersions(messageId: string, ctx: ServiceContext): Promise<Result<EventVersionSummary[]>> {
  const exists = await ctx.prisma.message.findUnique({ where: { id: messageId }, select: { id: true } });
  if (!exists) return notFound(messageId);
  const rows = await ctx.prisma.messageVersion.findMany({ where: { messageId }, orderBy: { sequence: "desc" }, select: VERSION_SUMMARY_SELECT });
  return ok(rows.map(toEventVersionSummary));
}

export async function getMessageVersion(
  messageId: string,
  label: string,
  ctx: ServiceContext
): Promise<Result<{ summary: EventVersionSummary; resolvedSpec: MessageResolvedSpec }>> {
  const parsed = parseVersionLabel(label);
  if (!parsed.success) return parsed;
  const row = await ctx.prisma.messageVersion.findUnique({
    where: { messageId_major_minor: { messageId, major: parsed.data.major, minor: parsed.data.minor } },
    select: { ...VERSION_SUMMARY_SELECT, resolvedSpec: true },
  });
  if (!row) return err({ code: "NOT_FOUND", message: `Version ${formatVersionLabel(parsed.data)} of message "${messageId}" not found` });
  return ok({ summary: toEventVersionSummary(row), resolvedSpec: row.resolvedSpec as unknown as MessageResolvedSpec });
}
```

- [ ] **Step 5: Run the integration test**

Run: `npx vitest run tests/integration/services/events/message-publish.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Actions + unit test**

```ts
// src/app/(dashboard)/schemas/[domainSlug]/[productSlug]/message-version-actions.ts
"use server";

import { revalidatePath } from "next/cache";
import { getActionContext, NOT_AUTHENTICATED, toActionResult } from "@/lib/action-context";
import { isBumpKind, type PublishInput } from "@/lib/entity-versioning/types";
import type { EventPublishAnalysis } from "@/lib/events/publish-plan";
import type { EventVersionSummary } from "@/lib/events/types";
import { listMessageVersions, previewMessagePublish, publishMessage } from "@/services/events/message-publish.service";
import type { ActionResult } from "@/types/action-result";

const MAX_CHANGE_SUMMARY = 500;

export async function getMessagePublishPreviewAction(messageId: string): Promise<ActionResult<EventPublishAnalysis>> {
  const ctx = await getActionContext();
  if (!ctx) return NOT_AUTHENTICATED;
  return toActionResult(await previewMessagePublish(messageId, ctx));
}

export async function publishMessageAction(messageId: string, input: PublishInput): Promise<ActionResult<EventVersionSummary>> {
  const ctx = await getActionContext();
  if (!ctx) return NOT_AUTHENTICATED;
  if (input.bump !== undefined && !isBumpKind(input.bump)) return { success: false, error: "bump must be MAJOR or MINOR", code: "VALIDATION_ERROR" };
  if (input.changeSummary !== undefined && (typeof input.changeSummary !== "string" || input.changeSummary.length > MAX_CHANGE_SUMMARY)) {
    return { success: false, error: `Change summary must be at most ${MAX_CHANGE_SUMMARY} characters`, code: "VALIDATION_ERROR" };
  }
  const result = await publishMessage(messageId, { bump: input.bump, changeSummary: input.changeSummary }, ctx);
  if (result.success) revalidatePath("/schemas", "layout");
  return toActionResult(result);
}

export async function listMessageVersionsAction(messageId: string): Promise<ActionResult<EventVersionSummary[]>> {
  const ctx = await getActionContext();
  if (!ctx) return NOT_AUTHENTICATED;
  return toActionResult(await listMessageVersions(messageId, ctx));
}
```

`tests/unit/app/message-version-actions.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({ auth: vi.fn(), revalidatePath: vi.fn(), previewMessagePublish: vi.fn(), publishMessage: vi.fn(), listMessageVersions: vi.fn() }));
vi.mock("@/lib/db", () => ({ prisma: { tag: "prisma" } }));
vi.mock("@/lib/auth", () => ({ auth: h.auth }));
vi.mock("next/cache", () => ({ revalidatePath: h.revalidatePath }));
vi.mock("@/services/rbac.service", () => ({ getEffectiveRole: vi.fn().mockResolvedValue({ success: true, data: "AUTHOR" }) }));
vi.mock("@/services/events/message-publish.service", () => ({
  previewMessagePublish: h.previewMessagePublish, publishMessage: h.publishMessage, listMessageVersions: h.listMessageVersions,
}));

import { getMessagePublishPreviewAction, listMessageVersionsAction, publishMessageAction } from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/message-version-actions";

beforeEach(() => {
  vi.clearAllMocks();
  h.auth.mockResolvedValue({ user: { id: "u1" } });
});

describe("message version actions", () => {
  it("validates the bump and summary before calling the service", async () => {
    expect(await publishMessageAction("m1", { bump: "PATCH" as never })).toEqual({ success: false, error: "bump must be MAJOR or MINOR", code: "VALIDATION_ERROR" });
    expect(await publishMessageAction("m1", { changeSummary: "x".repeat(501) })).toMatchObject({ code: "VALIDATION_ERROR" });
    expect(h.publishMessage).not.toHaveBeenCalled();
  });

  it("publishes, revalidates on success only, and passes blockers through", async () => {
    h.publishMessage.mockResolvedValueOnce({ success: true, data: { label: "1.0" } });
    expect(await publishMessageAction("m1", { bump: "MAJOR" })).toEqual({ success: true, data: { label: "1.0" } });
    expect(h.revalidatePath).toHaveBeenCalledWith("/schemas", "layout");
    h.publishMessage.mockResolvedValueOnce({ success: false, error: { code: "PUBLISH_BLOCKED", message: "Publish Order first", details: { blockers: [] } } });
    expect(await publishMessageAction("m1", {})).toEqual({ success: false, error: "Publish Order first", code: "PUBLISH_BLOCKED", details: { blockers: [] } });
    expect(h.revalidatePath).toHaveBeenCalledTimes(1);
  });

  it("passes preview and versions through", async () => {
    h.previewMessagePublish.mockResolvedValue({ success: true, data: { isFirstPublish: true } });
    h.listMessageVersions.mockResolvedValue({ success: true, data: [] });
    expect(await getMessagePublishPreviewAction("m1")).toEqual({ success: true, data: { isFirstPublish: true } });
    expect(await listMessageVersionsAction("m1")).toEqual({ success: true, data: [] });
  });
});
```

Run: `npx vitest run tests/unit/app/message-version-actions.test.ts tests/integration/services/events/message-publish.test.ts && npx tsc --noEmit`
Expected: PASS; no type errors.

- [ ] **Step 7: Commit**

```bash
git add src/services/events/version-summary.ts src/services/events/message-publish.service.ts "src/app/(dashboard)/schemas/[domainSlug]/[productSlug]/message-version-actions.ts" tests/integration/services/events/message-publish.test.ts tests/unit/app/message-version-actions.test.ts
git commit -m "feat(18.3): message publish — all blockers together, raise-only bump, frozen pins in SchemaReference"
```

---

### Task 11: "Who uses X?" — usage service, action, panel (Story 18.9) — Wave 3

**Files:**
- Create: `src/lib/events/usage.ts` (pure), `src/services/events/usage.service.ts`, `src/app/(dashboard)/schemas/usage-actions.ts`, `src/features/events/shared/UsedByPanel.tsx`
- Modify: `src/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/entity-workspace.tsx` (mount the panel on the Versions tab)
- Test: `tests/unit/lib/events/usage.test.ts`, `tests/integration/services/events/usage.service.test.ts`, `tests/unit/components/events/used-by-panel.test.tsx`

**Interfaces:**

```ts
// usage.ts
type UsageSubject = { kind: "entity"; entityId: string } | { kind: "message"; messageId: string };
interface UsageRow { id: string; fromKind: UsageFromKind; role: string; isDraft: boolean; target: string; label: string; href: string | null }
interface UsageLookups { entityVersions; messages; messageVersions; eventSpecs; eventSpecVersions; traits }   // id → display record
describeUsage(ref: { id; fromKind; fromId; role; isDraft; toId }, lookups, targetLabels: Record<string, string>): UsageRow
// usage.service.ts
findUsages(subject: UsageSubject, ctx): Promise<Result<UsageRow[]>>
// usage-actions.ts ("use server", read-only)
listUsagesAction(subject: UsageSubject): Promise<ActionResult<UsageRow[]>>
// UsedByPanel.tsx
UsedByPanel({ subject: UsageSubject; title?: string })
```

- [ ] **Step 1: Write the failing pure test** (`tests/unit/lib/events/usage.test.ts`)

```ts
import { describe, it, expect } from "vitest";
import { describeUsage, type UsageLookups } from "@/lib/events/usage";

const at = { domainSlug: "payments", productSlug: "checkout" };
const lookups: UsageLookups = {
  entityVersions: { ev1: { label: "2.1", entity: { name: "Order", slug: "order", ...at } } },
  messages: { m1: { id: "m1", name: "OrderCreated", ...at } },
  messageVersions: { mv1: { label: "1.3", message: { id: "m1", name: "OrderCreated", ...at } } },
  eventSpecs: { s1: { id: "s1", name: "checkout-service", ...at } },
  eventSpecVersions: { sv1: { label: "2.0", eventSpec: { id: "s1", name: "checkout-service", ...at } } },
  traits: { t1: { id: "t1", name: "CloudEvents", domainSlug: null, productSlug: null } },
};
const ref = (fromKind: string, fromId: string, role = "PAYLOAD", isDraft = false) => ({ id: `${fromKind}-${fromId}`, fromKind, fromId, role, isDraft, toId: "target" });

describe("describeUsage", () => {
  it("labels and links every referencing kind with assetHref (versions deep-link)", () => {
    const targets = { target: "Order v2.1" };
    expect(describeUsage(ref("MESSAGE_VERSION", "mv1"), lookups, targets)).toMatchObject({
      label: "Message OrderCreated v1.3", href: "/schemas/payments/checkout/messages/m1?version=1.3", target: "Order v2.1", role: "PAYLOAD",
    });
    expect(describeUsage(ref("MESSAGE", "m1", "KEY", true), lookups, targets)).toMatchObject({ label: "Message OrderCreated (draft)", href: "/schemas/payments/checkout/messages/m1", isDraft: true });
    expect(describeUsage(ref("EVENT_SPEC_VERSION", "sv1", "MESSAGE"), lookups, targets)).toMatchObject({ label: "Event spec checkout-service v2.0", href: "/schemas/payments/checkout/specs/s1?version=2.0" });
    expect(describeUsage(ref("EVENT_SPEC", "s1", "MESSAGE", true), lookups, targets)).toMatchObject({ label: "Event spec checkout-service (draft)" });
    expect(describeUsage(ref("TRAIT", "t1", "HEADERS"), lookups, targets)).toMatchObject({ label: "Trait CloudEvents", href: "/schemas/enterprise/traits/t1" });
    expect(describeUsage(ref("ENTITY_VERSION", "ev1", "FIELD"), lookups, targets)).toMatchObject({ label: "Entity Order v2.1", href: "/schemas/payments/checkout/order?version=2.1" });
  });

  it("keeps rows whose source disappeared (no link)", () => {
    expect(describeUsage(ref("MESSAGE_VERSION", "gone"), lookups, {})).toMatchObject({ label: "Message version gone (deleted)", href: null, target: "target" });
  });
});
```

- [ ] **Step 2: Implement `src/lib/events/usage.ts`**

```ts
import { assetHref } from "@/lib/navigation/asset-href";

export type UsageSubject = { kind: "entity"; entityId: string } | { kind: "message"; messageId: string };
export type UsageFromKind = "ENTITY_VERSION" | "MESSAGE" | "MESSAGE_VERSION" | "EVENT_SPEC" | "EVENT_SPEC_VERSION" | "TRAIT";

export interface UsageRow {
  id: string;
  fromKind: UsageFromKind;
  role: string;
  isDraft: boolean;
  /** The referenced version of the subject, e.g. "Order v2.1". */
  target: string;
  label: string;
  href: string | null;
}

interface At {
  domainSlug: string | null;
  productSlug: string | null;
}
export interface UsageLookups {
  entityVersions: Record<string, { label: string; entity: At & { name: string; slug: string } }>;
  messages: Record<string, At & { id: string; name: string }>;
  messageVersions: Record<string, { label: string; message: At & { id: string; name: string } }>;
  eventSpecs: Record<string, At & { id: string; name: string }>;
  eventSpecVersions: Record<string, { label: string; eventSpec: At & { id: string; name: string } }>;
  traits: Record<string, At & { id: string; name: string }>;
}

export interface ReferenceLike {
  id: string;
  fromKind: string;
  fromId: string;
  role: string;
  isDraft: boolean;
  toId: string;
}

const product = (a: At) => (a.domainSlug && a.productSlug ? { domainSlug: a.domainSlug, productSlug: a.productSlug } : null);

export function describeUsage(ref: ReferenceLike, lookups: UsageLookups, targetLabels: Record<string, string>): UsageRow {
  const base = { id: ref.id, fromKind: ref.fromKind as UsageFromKind, role: ref.role, isDraft: ref.isDraft, target: targetLabels[ref.toId] ?? ref.toId };
  const missing = (what: string): UsageRow => ({ ...base, label: `${what} ${ref.fromId} (deleted)`, href: null });
  switch (ref.fromKind) {
    case "ENTITY_VERSION": {
      const v = lookups.entityVersions[ref.fromId];
      if (!v) return missing("Entity version");
      const href = assetHref({ kind: "entity", slug: v.entity.slug, domainSlug: v.entity.domainSlug, productSlug: v.entity.productSlug }, { version: v.label });
      return { ...base, label: `Entity ${v.entity.name} v${v.label}`, href };
    }
    case "MESSAGE": {
      const m = lookups.messages[ref.fromId];
      const p = m && product(m);
      if (!m || !p) return missing("Message");
      return { ...base, label: `Message ${m.name} (draft)`, href: assetHref({ kind: "message", id: m.id, ...p }) };
    }
    case "MESSAGE_VERSION": {
      const v = lookups.messageVersions[ref.fromId];
      const p = v && product(v.message);
      if (!v || !p) return missing("Message version");
      return { ...base, label: `Message ${v.message.name} v${v.label}`, href: assetHref({ kind: "message", id: v.message.id, ...p }, { version: v.label }) };
    }
    case "EVENT_SPEC": {
      const s = lookups.eventSpecs[ref.fromId];
      const p = s && product(s);
      if (!s || !p) return missing("Event spec");
      return { ...base, label: `Event spec ${s.name} (draft)`, href: assetHref({ kind: "eventSpec", id: s.id, ...p }) };
    }
    case "EVENT_SPEC_VERSION": {
      const v = lookups.eventSpecVersions[ref.fromId];
      const p = v && product(v.eventSpec);
      if (!v || !p) return missing("Event spec version");
      return { ...base, label: `Event spec ${v.eventSpec.name} v${v.label}`, href: assetHref({ kind: "eventSpec", id: v.eventSpec.id, ...p }, { version: v.label }) };
    }
    case "TRAIT": {
      const t = lookups.traits[ref.fromId];
      if (!t) return missing("Trait");
      return { ...base, label: `Trait ${t.name}`, href: assetHref({ kind: "trait", id: t.id, domainSlug: t.domainSlug, productSlug: t.productSlug }) };
    }
    default:
      return missing(ref.fromKind);
  }
}
```

Run: `npx vitest run tests/unit/lib/events/usage.test.ts` — Expected: PASS.

- [ ] **Step 3: Write the failing integration test** (`tests/integration/services/events/usage.service.test.ts`)

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import type { ServiceContext } from "@/types/service-context";
import { createMessage } from "@/services/events/message.service";
import { findUsages } from "@/services/events/usage.service";
import { cleanupDomains, connectTestDb, createProductScope, testContext, unwrap } from "./helpers";

let prisma: PrismaClient;
let ctx: ServiceContext;
beforeAll(async () => {
  prisma = connectTestDb();
  ctx = await testContext(prisma);
});
afterAll(async () => prisma.$disconnect());

describe("findUsages", () => {
  it("lists published uses before drafts for an entity and for a message", async () => {
    let domainId: string | undefined;
    try {
      const sc = await createProductScope(prisma, ctx);
      domainId = sc.domain.id;
      const order = await sc.publishedEntity("Order");
      const message = unwrap(await createMessage(sc.product.id, { name: `OrderCreated-${sc.s}`, payload: { entityId: order.entity.id } }, ctx));
      const mv = await prisma.messageVersion.create({
        data: { messageId: message.id, major: 1, minor: 0, sequence: 1, resolvedSpec: {}, payloadEntityVersionId: order.version.id, changeKind: "INITIAL", publishedById: ctx.userId },
      });
      await prisma.schemaReference.create({ data: { fromKind: "MESSAGE_VERSION", fromId: mv.id, role: "PAYLOAD", toKind: "ENTITY_VERSION", toId: order.version.id } });

      const entityUses = unwrap(await findUsages({ kind: "entity", entityId: order.entity.id }, ctx));
      expect(entityUses.map((u) => [u.label, u.isDraft, u.target])).toEqual([
        [`Message ${message.name} v1.0`, false, "Order v1.0"],
        [`Message ${message.name} (draft)`, true, "Order v1.0"],
      ]);
      expect(entityUses[0].href).toBe(`/schemas/${sc.domain.slug}/${sc.product.slug}/messages/${message.id}?version=1.0`);

      expect(unwrap(await findUsages({ kind: "message", messageId: message.id }, ctx))).toEqual([]);
      const missing = await findUsages({ kind: "entity", entityId: "nope" }, ctx);
      expect(!missing.success && missing.error.code).toBe("NOT_FOUND");
    } finally {
      await cleanupDomains(prisma, [domainId]);
    }
  });
});
```

- [ ] **Step 4: Implement `src/services/events/usage.service.ts`**

```ts
import { formatVersionLabel } from "@/lib/entity-versioning/version-math";
import { describeUsage, type UsageLookups, type UsageRow, type UsageSubject } from "@/lib/events/usage";
import { ok, err, type Result } from "@/types/result";
import type { ServiceContext } from "@/types/service-context";

const AT = { domain: { select: { slug: true } }, product: { select: { slug: true } } } as const;
const at = (r: { domain: { slug: string } | null; product: { slug: string } | null }) => ({ domainSlug: r.domain?.slug ?? null, productSlug: r.product?.slug ?? null });
const idsOf = (refs: Array<{ fromKind: string; fromId: string }>, kind: string) => refs.filter((r) => r.fromKind === kind).map((r) => r.fromId);

/** Spec §6.1 / 18.9: every SchemaReference pointing at any version of the subject, published uses first. */
export async function findUsages(subject: UsageSubject, ctx: ServiceContext): Promise<Result<UsageRow[]>> {
  const db = ctx.prisma;
  let toKind: "ENTITY_VERSION" | "MESSAGE_VERSION";
  let targets: Array<{ id: string; label: string }>;
  if (subject.kind === "entity") {
    const entity = await db.entity.findUnique({ where: { id: subject.entityId }, select: { name: true, versions: { select: { id: true, major: true, minor: true } } } });
    if (!entity) return err({ code: "NOT_FOUND", message: `Entity "${subject.entityId}" not found` });
    toKind = "ENTITY_VERSION";
    targets = entity.versions.map((v) => ({ id: v.id, label: `${entity.name} v${formatVersionLabel(v)}` }));
  } else {
    const message = await db.message.findUnique({ where: { id: subject.messageId }, select: { name: true, versions: { select: { id: true, major: true, minor: true } } } });
    if (!message) return err({ code: "NOT_FOUND", message: `Message "${subject.messageId}" not found` });
    toKind = "MESSAGE_VERSION";
    targets = message.versions.map((v) => ({ id: v.id, label: `${message.name} v${formatVersionLabel(v)}` }));
  }
  if (targets.length === 0) return ok([]);

  const refs = await db.schemaReference.findMany({
    where: { toKind, toId: { in: targets.map((t) => t.id) } },
    orderBy: [{ isDraft: "asc" }, { createdAt: "asc" }],
  });
  const [entityVersions, messages, messageVersions, eventSpecs, eventSpecVersions, traits] = await Promise.all([
    db.entityVersion.findMany({ where: { id: { in: idsOf(refs, "ENTITY_VERSION") } }, select: { id: true, major: true, minor: true, entity: { select: { name: true, slug: true, ...AT } } } }),
    db.message.findMany({ where: { id: { in: idsOf(refs, "MESSAGE") } }, select: { id: true, name: true, ...AT } }),
    db.messageVersion.findMany({ where: { id: { in: idsOf(refs, "MESSAGE_VERSION") } }, select: { id: true, major: true, minor: true, message: { select: { id: true, name: true, ...AT } } } }),
    db.eventSpec.findMany({ where: { id: { in: idsOf(refs, "EVENT_SPEC") } }, select: { id: true, name: true, ...AT } }),
    db.eventSpecVersion.findMany({ where: { id: { in: idsOf(refs, "EVENT_SPEC_VERSION") } }, select: { id: true, major: true, minor: true, eventSpec: { select: { id: true, name: true, ...AT } } } }),
    db.trait.findMany({ where: { id: { in: idsOf(refs, "TRAIT") } }, select: { id: true, name: true, ...AT } }),
  ]);
  const lookups: UsageLookups = {
    entityVersions: Object.fromEntries(entityVersions.map((v) => [v.id, { label: formatVersionLabel(v), entity: { name: v.entity.name, slug: v.entity.slug, ...at(v.entity) } }])),
    messages: Object.fromEntries(messages.map((m) => [m.id, { id: m.id, name: m.name, ...at(m) }])),
    messageVersions: Object.fromEntries(messageVersions.map((v) => [v.id, { label: formatVersionLabel(v), message: { id: v.message.id, name: v.message.name, ...at(v.message) } }])),
    eventSpecs: Object.fromEntries(eventSpecs.map((s) => [s.id, { id: s.id, name: s.name, ...at(s) }])),
    eventSpecVersions: Object.fromEntries(eventSpecVersions.map((v) => [v.id, { label: formatVersionLabel(v), eventSpec: { id: v.eventSpec.id, name: v.eventSpec.name, ...at(v.eventSpec) } }])),
    traits: Object.fromEntries(traits.map((t) => [t.id, { id: t.id, name: t.name, ...at(t) }])),
  };
  const targetLabels = Object.fromEntries(targets.map((t) => [t.id, t.label]));
  return ok(refs.map((r) => describeUsage(r, lookups, targetLabels)));
}
```

Run: `npx vitest run tests/integration/services/events/usage.service.test.ts` — Expected: PASS.

- [ ] **Step 5: Action + panel + their test**

```ts
// src/app/(dashboard)/schemas/usage-actions.ts
"use server";

import { getActionContext, NOT_AUTHENTICATED, toActionResult } from "@/lib/action-context";
import type { UsageRow, UsageSubject } from "@/lib/events/usage";
import { findUsages } from "@/services/events/usage.service";
import type { ActionResult } from "@/types/action-result";

export async function listUsagesAction(subject: UsageSubject): Promise<ActionResult<UsageRow[]>> {
  const ctx = await getActionContext();
  if (!ctx) return NOT_AUTHENTICATED;
  return toActionResult(await findUsages(subject, ctx));
}
```

```tsx
// src/features/events/shared/UsedByPanel.tsx
"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { listUsagesAction } from "@/app/(dashboard)/schemas/usage-actions";
import type { UsageRow, UsageSubject } from "@/lib/events/usage";

type State = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; rows: UsageRow[] };

/** Spec 18.9 "Who uses X?" — published uses first, drafts flagged. */
export function UsedByPanel({ subject, title = "Used by" }: { subject: UsageSubject; title?: string }) {
  const [state, setState] = useState<State>({ status: "loading" });
  const kind = subject.kind;
  const id = subject.kind === "entity" ? subject.entityId : subject.messageId;

  useEffect(() => {
    let cancelled = false;
    const current: UsageSubject = kind === "entity" ? { kind, entityId: id } : { kind, messageId: id };
    void listUsagesAction(current).then((r) => {
      if (cancelled) return;
      setState(r.success ? { status: "ready", rows: r.data } : { status: "error", message: r.error });
    });
    return () => {
      cancelled = true;
    };
  }, [kind, id]);

  return (
    <section className="space-y-space-2" data-testid="used-by-panel">
      <h3 className="text-heading-3 text-foreground">{title}</h3>
      {state.status === "loading" && (
        <p className="flex items-center gap-2 text-body-small text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Looking up references…</p>
      )}
      {state.status === "error" && <p role="alert" className="text-body-small text-destructive">{state.message}</p>}
      {state.status === "ready" && state.rows.length === 0 && <p className="text-body-small text-muted-foreground">Nothing references this yet.</p>}
      {state.status === "ready" && state.rows.length > 0 && (
        <ul className="space-y-space-1">
          {state.rows.map((row) => (
            <li key={row.id} className="flex flex-wrap items-center gap-space-2 text-body-small">
              {row.href ? <Link href={row.href} className="text-primary hover:underline">{row.label}</Link> : <span className="text-muted-foreground">{row.label}</span>}
              <Badge variant="secondary">{row.role}</Badge>
              {row.isDraft && <Badge variant="outline">draft</Badge>}
              <span className="text-caption text-muted-foreground">→ {row.target}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
```

`tests/unit/components/events/used-by-panel.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ listUsagesAction: vi.fn() }));
vi.mock("@/app/(dashboard)/schemas/usage-actions", () => ({ listUsagesAction: h.listUsagesAction }));
import { UsedByPanel } from "@/features/events/shared/UsedByPanel";

afterEach(() => cleanup());

describe("UsedByPanel", () => {
  it("lists references with links, roles and draft badges", async () => {
    h.listUsagesAction.mockResolvedValue({
      success: true,
      data: [
        { id: "r1", fromKind: "MESSAGE_VERSION", role: "PAYLOAD", isDraft: false, target: "Order v2.1", label: "Message OrderCreated v1.3", href: "/m?version=1.3" },
        { id: "r2", fromKind: "MESSAGE", role: "KEY", isDraft: true, target: "Order v2.1", label: "Message OrderCreated (draft)", href: "/m" },
      ],
    });
    render(<UsedByPanel subject={{ kind: "entity", entityId: "e1" }} />);
    expect((await screen.findByRole("link", { name: "Message OrderCreated v1.3" })).getAttribute("href")).toBe("/m?version=1.3");
    expect(screen.getByText("draft")).toBeDefined();
    expect(h.listUsagesAction).toHaveBeenCalledWith({ kind: "entity", entityId: "e1" });
  });

  it("shows the empty and error states", async () => {
    h.listUsagesAction.mockResolvedValueOnce({ success: true, data: [] });
    render(<UsedByPanel subject={{ kind: "message", messageId: "m1" }} />);
    expect(await screen.findByText("Nothing references this yet.")).toBeDefined();
    cleanup();
    h.listUsagesAction.mockResolvedValueOnce({ success: false, error: "boom" });
    render(<UsedByPanel subject={{ kind: "message", messageId: "m1" }} />);
    expect((await screen.findByRole("alert")).textContent).toBe("boom");
  });
});
```

- [ ] **Step 6: Mount on the entity Versions tab** (`entity-workspace.tsx`, Track B file)

Add `import { UsedByPanel } from "@/features/events/shared/UsedByPanel";` and, in the `activeTab === "versions"` block, right after `<EntityVersionList versions={publishedVersions} />`:

```tsx
            <UsedByPanel subject={{ kind: "entity", entityId: entity.id }} />
```

Existing entity workspace tests render this tab with mocked actions; add `vi.mock("@/app/(dashboard)/schemas/usage-actions", () => ({ listUsagesAction: vi.fn().mockResolvedValue({ success: true, data: [] }) }))` to every test file that renders `EntityWorkspace` (find them with `grep -rln "entity-workspace\"" tests/unit`).

- [ ] **Step 7: Run + commit**

Run: `npx vitest run tests/unit/lib/events/usage.test.ts tests/unit/components/events/used-by-panel.test.tsx tests/integration/services/events/usage.service.test.ts tests/unit/components/entity-workspace.test.ts tests/unit/components/entity-workspace-level.test.tsx tests/unit/components/entity-versioning-ui.test.tsx && npx tsc --noEmit`
Expected: PASS; no type errors.

```bash
git add src/lib/events/usage.ts src/services/events/usage.service.ts "src/app/(dashboard)/schemas/usage-actions.ts" src/features/events/shared/UsedByPanel.tsx "src/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/entity-workspace.tsx" tests/unit/lib/events/usage.test.ts tests/integration/services/events/usage.service.test.ts tests/unit/components/events/used-by-panel.test.tsx tests/unit/components
git commit -m "feat(18.9): who-uses-X lookup over SchemaReference + Used-by panel on entity versions"
```

---
### Task 12: Event Spec publish — service + actions (Stories 18.3 / 18.4, spec §7.4) — Wave 4

**Files:**
- Create: `src/services/events/event-spec-publish.service.ts`
- Create: `src/app/(dashboard)/schemas/[domainSlug]/[productSlug]/event-spec-version-actions.ts`
- Test: `tests/integration/services/events/event-spec-publish.test.ts`, `tests/unit/app/event-spec-version-actions.test.ts`

**Interfaces:**

```ts
previewEventSpecPublish(specId, ctx, deps?: EmitDeps): Promise<Result<EventPublishAnalysis>>
publishEventSpec(specId, input: PublishInput, ctx, deps?: EmitDeps): Promise<Result<EventVersionSummary>>
listEventSpecVersions(specId, ctx): Promise<Result<EventVersionSummary[]>>
// event-spec-version-actions.ts ("use server")
getEventSpecPublishPreviewAction(specId): Promise<ActionResult<EventPublishAnalysis>>
publishEventSpecAction(specId, input: PublishInput): Promise<ActionResult<EventVersionSummary>>   // revalidates on success
listEventSpecVersionsAction(specId): Promise<ActionResult<EventVersionSummary[]>>
```

- [ ] **Step 1: Write the failing integration test** (`tests/integration/services/events/event-spec-publish.test.ts`) — real emitters + parser

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import type { JsonObject } from "@/lib/event-specs/types";
import type { ServiceContext } from "@/types/service-context";
import { createArtifactRenderer } from "@/services/events/artifact-renderer";
import { createChannel, updateChannel } from "@/services/events/channel.service";
import { createEventSpec, updateEventSpecDocument } from "@/services/events/event-spec.service";
import { emitEventSpec } from "@/services/events/event-spec-emit.service";
import { listEventSpecVersions, previewEventSpecPublish, publishEventSpec } from "@/services/events/event-spec-publish.service";
import { createMessage } from "@/services/events/message.service";
import { publishMessage } from "@/services/events/message-publish.service";
import { cleanupDomains, connectTestDb, createProductScope, testContext, unwrap } from "./helpers";

let prisma: PrismaClient;
let ctx: ServiceContext;
beforeAll(async () => {
  prisma = connectTestDb();
  ctx = await testContext(prisma);
});
afterAll(async () => prisma.$disconnect());

const addressOf = (doc: JsonObject | null, channelKey: string) => ((doc?.channels as JsonObject)[channelKey] as JsonObject).address;

describe.sequential("event spec publish (spec §6.1, §7.4, D8, D11)", () => {
  it("blocks on draft messages, publishes 1.0, republishes a live channel change as MAJOR, keeps stored documents immutable", async () => {
    let domainId: string | undefined;
    try {
      const sc = await createProductScope(prisma, ctx);
      domainId = sc.domain.id;
      const deps = { renderer: createArtifactRenderer({ db: prisma }) };
      const owner = { level: "PRODUCT" as const, productId: sc.product.id };
      const order = await sc.publishedEntity("Order", [{ name: "id", type: "string" }]);
      const message = unwrap(await createMessage(sc.product.id, { name: `OrderCreated-${sc.s}`, spec: { contentType: "avro/binary", traitIds: [] }, payload: { entityId: order.entity.id } }, ctx));
      const channelInput = { name: `orders-${sc.s}`, address: "payments.orders.v1", protocol: "kafka", format: "avro" };
      const channel = unwrap(await createChannel(sc.product.id, channelInput, ctx));
      const spec = unwrap(await createEventSpec(sc.product.id, { name: `checkout-service-${sc.s}`, title: "checkout-service" }, ctx));
      const doc = (messageRef: string) => ({
        info: { title: "checkout-service" },
        servers: [{ key: "kafka-prod", protocol: "kafka", host: "kafka-prod.internal:9092" }],
        operations: [{ key: "publishOrderCreated", action: "send", channelId: channel.id, messageVersionIds: [messageRef], traitIds: [] }],
      });

      unwrap(await updateEventSpecDocument(spec.id, doc(message.id), owner, ctx));
      const blocked = unwrap(await previewEventSpecPublish(spec.id, ctx, deps));
      expect(blocked.blockers.map((b) => b.kind)).toEqual(["UNPUBLISHED_MESSAGE"]);
      expect((await publishEventSpec(spec.id, {}, ctx, deps)).success).toBe(false);

      const mv = unwrap(await publishMessage(message.id, {}, ctx));
      unwrap(await updateEventSpecDocument(spec.id, doc(mv.id), owner, ctx));
      const v1 = unwrap(await publishEventSpec(spec.id, { changeSummary: "first" }, ctx, deps));
      expect(v1).toMatchObject({ label: "1.0", changeKind: "INITIAL", sequence: 1 });
      const stored = await prisma.eventSpecVersion.findUniqueOrThrow({ where: { id: v1.id } });
      expect((stored.document as JsonObject).info).toMatchObject({ title: "checkout-service", version: "1.0" });
      expect(stored.messageVersionIds).toEqual([mv.id]);
      expect((stored.frozenChannels as Array<{ address: string }>)[0].address).toBe("payments.orders.v1");
      const refs = await prisma.schemaReference.findMany({ where: { fromKind: "EVENT_SPEC_VERSION", fromId: v1.id } });
      expect(refs.map((r) => [r.role, r.toKind, r.toId, r.isDraft])).toEqual([["MESSAGE", "MESSAGE_VERSION", mv.id, false]]);
      expect((await prisma.eventSpec.findUniqueOrThrow({ where: { id: spec.id } })).hasUnpublishedChanges).toBe(false);

      const again = await publishEventSpec(spec.id, {}, ctx, deps);
      expect(!again.success && JSON.stringify(again.error.details)).toContain("NO_CHANGES");

      // D8: a live channel change makes the spec publishable and is classified MAJOR (address change).
      unwrap(await updateChannel(channel.id, { ...channelInput, address: "payments.orders.v2" }, owner, ctx));
      const majorPreview = unwrap(await previewEventSpecPublish(spec.id, ctx, deps));
      expect(majorPreview.suggestedBump).toBe("MAJOR");
      expect(majorPreview.reasons.join(" ")).toContain('address changed from "payments.orders.v1" to "payments.orders.v2"');
      expect((await publishEventSpec(spec.id, { bump: "MINOR" }, ctx, deps))).toMatchObject({ success: false, error: { code: "BUMP_TOO_LOW" } });
      expect(unwrap(await publishEventSpec(spec.id, {}, ctx, deps))).toMatchObject({ label: "2.0", changeKind: "MAJOR" });

      // Published documents are never regenerated (spec §7.2 step 1).
      const old = unwrap(await emitEventSpec(spec.id, { versionLabel: "1.0" }, ctx));
      expect(addressOf(old.document, channel.name)).toBe("payments.orders.v1");
      const latest = unwrap(await emitEventSpec(spec.id, { versionLabel: "2.0" }, ctx));
      expect(addressOf(latest.document, channel.name)).toBe("payments.orders.v2");
      expect(unwrap(await listEventSpecVersions(spec.id, ctx)).map((v) => v.label)).toEqual(["2.0", "1.0"]);

      // Unresolved references block together with nothing written.
      await prisma.eventSpec.update({
        where: { id: spec.id },
        data: { hasUnpublishedChanges: true, document: { ...doc(mv.id), operations: [{ key: "op", action: "send", channelId: "gone", messageVersionIds: [mv.id], traitIds: [] }] } },
      });
      const unresolved = unwrap(await previewEventSpecPublish(spec.id, ctx, deps));
      expect(unresolved.blockers.map((b) => b.kind)).toContain("UNRESOLVED_REFERENCE");
      expect(await prisma.eventSpecVersion.count({ where: { eventSpecId: spec.id } })).toBe(2);
    } finally {
      await cleanupDomains(prisma, [domainId]);
    }
  }, 240_000);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/integration/services/events/event-spec-publish.test.ts --no-file-parallelism`
Expected: FAIL — missing module.

- [ ] **Step 3: Implement `src/services/events/event-spec-publish.service.ts`**

```ts
import type { Prisma } from "@/generated/prisma/client";
import { normalizeDiagnostics, type Diagnostic, type EmitOutput, type EventSpecDocument, type ResolvedChannel } from "@/lib/event-specs";
import type { BumpKind, PublishInput } from "@/lib/entity-versioning/types";
import { stableStringify, type EventSpecBumpSide, type MessageVersionInfo } from "@/lib/events/bump-rules";
import {
  analyzeVersionedPublish, eventSpecPublishInput, planVersionedPublish, provisionalLabel,
  type EventPublishAnalysis, type EventSpecPublishFacts, type VersionedPublishInput,
} from "@/lib/events/publish-plan";
import type { EventVersionSummary } from "@/lib/events/types";
import { assertNameAvailable } from "@/services/name-registry.service";
import { ok, err, type Result } from "@/types/result";
import type { ServiceContext } from "@/types/service-context";
import { getSharedArtifactRenderer } from "./artifact-renderer";
import { auditedWrite } from "./audited";
import { emitResolved, type EmitDeps } from "./event-spec-emit.service";
import { loadDraftSnapshot, resolveSnapshot, type DraftSnapshot } from "./event-spec-resolver";
import { replaceReferences } from "./schema-references";
import { toEventVersionSummary, VERSION_SUMMARY_SELECT } from "./version-summary";

function bumpSide(document: EventSpecDocument, channels: ResolvedChannel[], versionIds: string[], info: Record<string, MessageVersionInfo>): EventSpecBumpSide {
  return {
    document,
    channelAddresses: Object.fromEntries(channels.map((c) => [c.id, c.address])),
    channelNames: Object.fromEntries(channels.map((c) => [c.id, c.name])),
    messageVersions: Object.fromEntries(versionIds.filter((id) => info[id]).map((id) => [id, info[id]])),
  };
}

async function gatherFacts(ctx: ServiceContext, snapshot: DraftSnapshot): Promise<Result<Omit<EventSpecPublishFacts, "diagnostics">>> {
  const { latest, spec } = snapshot;
  const published = snapshot.messages.filter((m) => !m.unpublished).map((m) => m.id);
  const liveChanged = latest !== null
    && (stableStringify(latest.frozenChannels) !== stableStringify(snapshot.channels) || stableStringify(latest.frozenTraits) !== stableStringify(snapshot.traits));
  const name = await assertNameAvailable(ctx.prisma, {
    name: spec.name, tenantId: spec.tenantId, domainId: spec.domainId, productId: spec.productId, exclude: { kind: "eventSpec", id: spec.id },
  });
  if (!name.success && name.error.code !== "NAME_CONFLICT") return name;
  return ok({
    latest: latest ? { major: latest.major, minor: latest.minor, sequence: latest.sequence } : null,
    hasChanges: spec.hasUnpublishedChanges || liveChanged,
    previous: latest ? bumpSide(latest.sourceDocument, latest.frozenChannels, latest.messageVersionIds, snapshot.messageVersionInfo) : null,
    current: bumpSide(snapshot.document, snapshot.channels, published, snapshot.messageVersionInfo),
    unresolved: snapshot.unresolved,
    unpublishedMessages: snapshot.messages.filter((m) => m.unpublished).map((m) => ({ id: m.messageId, name: m.name })),
    nameConflict: name.success ? null : name.error.message,
  });
}

interface Prepared {
  snapshot: DraftSnapshot;
  input: VersionedPublishInput;
  output: EmitOutput | null;
  diagnostics: Diagnostic[];
}

/** D11: snapshot → analysis → label → render + emit with info.version = label → every blocker together. */
async function prepare(specId: string, requested: BumpKind | undefined, ctx: ServiceContext, deps: EmitDeps): Promise<Result<Prepared>> {
  const snapshot = await loadDraftSnapshot(ctx.prisma, specId);
  if (!snapshot.success) return snapshot;
  const facts = await gatherFacts(ctx, snapshot.data);
  if (!facts.success) return facts;

  const base = eventSpecPublishInput({ ...facts.data, diagnostics: [] });
  const analysis = analyzeVersionedPublish(base);
  let label = provisionalLabel(analysis);
  if (analysis.blockers.length === 0) {
    const plan = planVersionedPublish(base, requested);
    if (!plan.success) return plan; // BUMP_TOO_LOW
    label = plan.data.label;
  }

  const draft = await resolveSnapshot(snapshot.data, deps.renderer ?? getSharedArtifactRenderer(ctx.prisma), label);
  let output: EmitOutput | null = null;
  let diagnostics = draft.diagnostics;
  if (draft.resolved) {
    const out = await emitResolved(draft.resolved, snapshot.data.spec.specType, deps);
    if (!out.success) return out;
    output = out.data;
    diagnostics = normalizeDiagnostics([...draft.diagnostics, ...out.data.diagnostics]);
  }
  // Unresolved references are already UNRESOLVED_REFERENCE blockers from the facts.
  const emitted = diagnostics.filter((d) => d.code !== "UNRESOLVED_REFERENCE");
  return ok({ snapshot: snapshot.data, input: eventSpecPublishInput({ ...facts.data, diagnostics: emitted }), output, diagnostics });
}

export async function previewEventSpecPublish(specId: string, ctx: ServiceContext, deps: EmitDeps = {}): Promise<Result<EventPublishAnalysis>> {
  const prepared = await prepare(specId, undefined, ctx, deps);
  if (!prepared.success) return prepared;
  return ok(analyzeVersionedPublish(prepared.data.input));
}

export async function publishEventSpec(specId: string, input: PublishInput, ctx: ServiceContext, deps: EmitDeps = {}): Promise<Result<EventVersionSummary>> {
  const changeSummary = input.changeSummary?.trim() ? input.changeSummary.trim() : null;
  const prepared = await prepare(specId, input.bump, ctx, deps);
  if (!prepared.success) return prepared;
  const plan = planVersionedPublish(prepared.data.input, input.bump);
  if (!plan.success) return plan;
  const { snapshot, output, diagnostics } = prepared.data;
  if (!output) return err({ code: "PUBLISH_BLOCKED", message: "The event spec could not be emitted" });
  const messageVersionIds = [...new Set(snapshot.messages.filter((m) => !m.unpublished).map((m) => m.id))];

  return auditedWrite({
    action: "PUBLISH_VERSION", entityType: "EventSpec", entityId: specId, userId: ctx.userId,
    run: () =>
      ctx.prisma.$transaction(
        async (tx): Promise<Result<EventVersionSummary>> => {
          await tx.$queryRaw`SELECT "id" FROM "event_specs" WHERE "id" = ${specId} FOR UPDATE`;
          const current = await tx.eventSpec.findUnique({ where: { id: specId }, select: { updatedAt: true, latestVersionId: true } });
          if (!current) return err({ code: "NOT_FOUND", message: `Event spec "${specId}" not found` });
          if (current.updatedAt.getTime() !== snapshot.spec.updatedAt.getTime() || current.latestVersionId !== snapshot.spec.latestVersionId) {
            return err({ code: "CONFLICT", message: "The event spec changed while publishing.", suggestedFix: "Reload and publish again." });
          }
          const version = await tx.eventSpecVersion.create({
            data: {
              eventSpecId: specId,
              major: plan.data.version.major,
              minor: plan.data.version.minor,
              sequence: plan.data.sequence,
              document: output.document as Prisma.InputJsonValue,
              sourceDocument: snapshot.document as unknown as Prisma.InputJsonValue,
              frozenChannels: snapshot.channels as unknown as Prisma.InputJsonValue,
              frozenTraits: snapshot.traits as unknown as Prisma.InputJsonValue,
              messageVersionIds,
              changeKind: plan.data.changeKind,
              compatReport: { reasons: plan.data.reasons, diagnostics: diagnostics.filter((d) => d.severity !== "error") } as unknown as Prisma.InputJsonValue,
              changeSummary,
              publishedById: ctx.userId,
            },
            select: VERSION_SUMMARY_SELECT,
          });
          await replaceReferences(
            tx,
            { kind: "EVENT_SPEC_VERSION", id: version.id },
            messageVersionIds.map((toId) => ({ role: "MESSAGE" as const, toKind: "MESSAGE_VERSION" as const, toId })),
            false
          );
          await tx.eventSpec.update({ where: { id: specId }, data: { latestVersionId: version.id, hasUnpublishedChanges: false }, select: { id: true } });
          return ok(toEventVersionSummary(version));
        },
        { timeout: 15_000 }
      ),
  });
}

export async function listEventSpecVersions(specId: string, ctx: ServiceContext): Promise<Result<EventVersionSummary[]>> {
  const exists = await ctx.prisma.eventSpec.findUnique({ where: { id: specId }, select: { id: true } });
  if (!exists) return err({ code: "NOT_FOUND", message: `Event spec "${specId}" not found` });
  const rows = await ctx.prisma.eventSpecVersion.findMany({ where: { eventSpecId: specId }, orderBy: { sequence: "desc" }, select: VERSION_SUMMARY_SELECT });
  return ok(rows.map(toEventVersionSummary));
}
```

- [ ] **Step 4: Run the integration test**

Run: `npx vitest run tests/integration/services/events/event-spec-publish.test.ts --no-file-parallelism`
Expected: PASS (1 test, ~30–90 s).

- [ ] **Step 5: Actions + unit test**

```ts
// src/app/(dashboard)/schemas/[domainSlug]/[productSlug]/event-spec-version-actions.ts
"use server";

import { revalidatePath } from "next/cache";
import { getActionContext, NOT_AUTHENTICATED, toActionResult } from "@/lib/action-context";
import { isBumpKind, type PublishInput } from "@/lib/entity-versioning/types";
import type { EventPublishAnalysis } from "@/lib/events/publish-plan";
import type { EventVersionSummary } from "@/lib/events/types";
import { listEventSpecVersions, previewEventSpecPublish, publishEventSpec } from "@/services/events/event-spec-publish.service";
import type { ActionResult } from "@/types/action-result";

const MAX_CHANGE_SUMMARY = 500;

export async function getEventSpecPublishPreviewAction(specId: string): Promise<ActionResult<EventPublishAnalysis>> {
  const ctx = await getActionContext();
  if (!ctx) return NOT_AUTHENTICATED;
  return toActionResult(await previewEventSpecPublish(specId, ctx));
}

export async function publishEventSpecAction(specId: string, input: PublishInput): Promise<ActionResult<EventVersionSummary>> {
  const ctx = await getActionContext();
  if (!ctx) return NOT_AUTHENTICATED;
  if (input.bump !== undefined && !isBumpKind(input.bump)) return { success: false, error: "bump must be MAJOR or MINOR", code: "VALIDATION_ERROR" };
  if (input.changeSummary !== undefined && (typeof input.changeSummary !== "string" || input.changeSummary.length > MAX_CHANGE_SUMMARY)) {
    return { success: false, error: `Change summary must be at most ${MAX_CHANGE_SUMMARY} characters`, code: "VALIDATION_ERROR" };
  }
  const result = await publishEventSpec(specId, { bump: input.bump, changeSummary: input.changeSummary }, ctx);
  if (result.success) revalidatePath("/schemas", "layout");
  return toActionResult(result);
}

export async function listEventSpecVersionsAction(specId: string): Promise<ActionResult<EventVersionSummary[]>> {
  const ctx = await getActionContext();
  if (!ctx) return NOT_AUTHENTICATED;
  return toActionResult(await listEventSpecVersions(specId, ctx));
}
```

`tests/unit/app/event-spec-version-actions.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({ auth: vi.fn(), revalidatePath: vi.fn(), previewEventSpecPublish: vi.fn(), publishEventSpec: vi.fn(), listEventSpecVersions: vi.fn() }));
vi.mock("@/lib/db", () => ({ prisma: { tag: "prisma" } }));
vi.mock("@/lib/auth", () => ({ auth: h.auth }));
vi.mock("next/cache", () => ({ revalidatePath: h.revalidatePath }));
vi.mock("@/services/rbac.service", () => ({ getEffectiveRole: vi.fn().mockResolvedValue({ success: true, data: "AUTHOR" }) }));
vi.mock("@/services/events/event-spec-publish.service", () => ({
  previewEventSpecPublish: h.previewEventSpecPublish, publishEventSpec: h.publishEventSpec, listEventSpecVersions: h.listEventSpecVersions,
}));

import {
  getEventSpecPublishPreviewAction, listEventSpecVersionsAction, publishEventSpecAction,
} from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/event-spec-version-actions";

beforeEach(() => {
  vi.clearAllMocks();
  h.auth.mockResolvedValue({ user: { id: "u1" } });
});

describe("event spec version actions", () => {
  it("validates input, publishes and revalidates only on success", async () => {
    expect(await publishEventSpecAction("s1", { bump: "PATCH" as never })).toMatchObject({ success: false, code: "VALIDATION_ERROR" });
    h.publishEventSpec.mockResolvedValueOnce({ success: true, data: { label: "1.0" } });
    expect(await publishEventSpecAction("s1", {})).toEqual({ success: true, data: { label: "1.0" } });
    h.publishEventSpec.mockResolvedValueOnce({ success: false, error: { code: "BUMP_TOO_LOW", message: "must be MAJOR" } });
    expect(await publishEventSpecAction("s1", { bump: "MINOR" })).toEqual({ success: false, error: "must be MAJOR", code: "BUMP_TOO_LOW" });
    expect(h.revalidatePath.mock.calls).toEqual([["/schemas", "layout"]]);
  });

  it("passes the preview and version list through without revalidating", async () => {
    h.previewEventSpecPublish.mockResolvedValue({ success: true, data: { isFirstPublish: true } });
    h.listEventSpecVersions.mockResolvedValue({ success: true, data: [] });
    expect(await getEventSpecPublishPreviewAction("s1")).toEqual({ success: true, data: { isFirstPublish: true } });
    expect(await listEventSpecVersionsAction("s1")).toEqual({ success: true, data: [] });
    expect(h.revalidatePath).not.toHaveBeenCalled();
  });
});
```

Run: `npx vitest run tests/unit/app/event-spec-version-actions.test.ts && npx tsc --noEmit` — Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/services/events/event-spec-publish.service.ts "src/app/(dashboard)/schemas/[domainSlug]/[productSlug]/event-spec-version-actions.ts" tests/integration/services/events/event-spec-publish.test.ts tests/unit/app/event-spec-version-actions.test.ts
git commit -m "feat(18.3): event spec publish — frozen channels/traits, stored AsyncAPI document, live-change detection, raise-only"
```

---

### Task 13: REST `GET /api/v1/event-specs/:id` (Story 18.7) — Wave 4

**Files:**
- Create: `src/app/api/v1/event-specs/[id]/route.ts`
- Test: `tests/unit/api/v1/event-specs-route.test.ts`

**Interfaces:** `GET /api/v1/event-specs/:id?version=<MAJOR.MINOR|draft>&format=yaml|json` → `200` raw document (`application/yaml` default / `application/json`), headers `Content-Disposition: inline; filename="<name>-<version>.asyncapi.<ext>"`, `X-Event-Spec-Version`. Errors use the v1 JSON envelope (`apiError`). D12 semantics for `version`.

- [ ] **Step 1: Write the failing test** (`tests/unit/api/v1/event-specs-route.test.ts`)

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({ authenticateRequest: vi.fn(), checkRateLimit: vi.fn(), emitEventSpec: vi.fn(), getLatestEventSpecVersionLabel: vi.fn() }));
vi.mock("@/app/api/v1/middleware", () => ({ authenticateRequest: h.authenticateRequest }));
vi.mock("@/app/api/v1/rate-limit", () => ({ checkRateLimit: h.checkRateLimit }));
vi.mock("@/services/events/event-spec-emit.service", () => ({ emitEventSpec: h.emitEventSpec, getLatestEventSpecVersionLabel: h.getLatestEventSpecVersionLabel }));

import { GET } from "@/app/api/v1/event-specs/[id]/route";

const CTX = { userId: "api-key-user", userRole: "ADMIN", prisma: {} };
const emission = (over: Record<string, unknown> = {}) => ({
  success: true,
  data: { specId: "s1", specName: "checkout-service", version: "2.0", published: true, document: { asyncapi: "3.0.0" }, json: '{"asyncapi":"3.0.0"}\n', yaml: "asyncapi: 3.0.0\n", diagnostics: [], unpublishedMessages: [], ...over },
});
const call = (query = "") => GET(new Request(`http://x/api/v1/event-specs/s1${query}`), { params: Promise.resolve({ id: "s1" }) });

beforeEach(() => {
  vi.clearAllMocks();
  h.checkRateLimit.mockReturnValue(null);
  h.authenticateRequest.mockResolvedValue({ authenticated: true, context: CTX });
});

describe("GET /api/v1/event-specs/:id", () => {
  it("returns the latest published version as YAML by default", async () => {
    h.getLatestEventSpecVersionLabel.mockResolvedValue({ success: true, data: "2.0" });
    h.emitEventSpec.mockResolvedValue(emission());
    const res = await call();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/yaml; charset=utf-8");
    expect(res.headers.get("content-disposition")).toBe('inline; filename="checkout-service-2.0.asyncapi.yaml"');
    expect(res.headers.get("x-event-spec-version")).toBe("2.0");
    expect(await res.text()).toBe("asyncapi: 3.0.0\n");
    expect(h.emitEventSpec).toHaveBeenCalledWith("s1", { versionLabel: "2.0" }, CTX);
  });

  it("serves a requested version as JSON and the draft on version=draft", async () => {
    h.emitEventSpec.mockResolvedValue(emission({ version: "1.0" }));
    const res = await call("?version=1.0&format=json");
    expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(await res.text()).toBe('{"asyncapi":"3.0.0"}\n');
    expect(h.emitEventSpec).toHaveBeenCalledWith("s1", { versionLabel: "1.0" }, CTX);
    h.emitEventSpec.mockResolvedValue(emission({ version: "draft", published: false }));
    await call("?version=draft");
    expect(h.emitEventSpec).toHaveBeenLastCalledWith("s1", { draft: true }, CTX);
  });

  it("maps errors: unauthenticated 401, bad format 400, never published 404, unknown version 404, unresolved draft 400", async () => {
    h.authenticateRequest.mockResolvedValueOnce({ authenticated: false });
    expect((await call()).status).toBe(401);
    expect((await call("?format=xml")).status).toBe(400);
    h.getLatestEventSpecVersionLabel.mockResolvedValueOnce({ success: true, data: null });
    const never = await call();
    expect(never.status).toBe(404);
    expect((await never.json()).error.suggestedFix).toMatch(/version=draft/);
    h.emitEventSpec.mockResolvedValueOnce({ success: false, error: { code: "NOT_FOUND", message: "Version 9.0 not found" } });
    expect((await call("?version=9.0")).status).toBe(404);
    h.emitEventSpec.mockResolvedValueOnce(emission({ document: null, json: null, yaml: null, diagnostics: [{ severity: "error", code: "UNRESOLVED_REFERENCE", message: "x", pointer: "/operations/0/channelId" }] }));
    const broken = await call("?version=draft");
    expect(broken.status).toBe(400);
    expect((await broken.json()).error.details.diagnostics).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Implement `src/app/api/v1/event-specs/[id]/route.ts`**

```ts
/**
 * GET /api/v1/event-specs/:id?version=<MAJOR.MINOR|draft>&format=yaml|json (spec §7.4, Story 18.7).
 *
 * version omitted → latest published version (404 when never published; pass version=draft);
 * a published version is the stored document, never regenerated (spec §7.2 step 1).
 * The body is the raw AsyncAPI document; errors use the v1 JSON error envelope.
 */
import { authenticateRequest } from "@/app/api/v1/middleware";
import { checkRateLimit } from "@/app/api/v1/rate-limit";
import { apiError, apiServerError, apiUnauthorized } from "@/app/api/v1/error-handler";
import { emitEventSpec, getLatestEventSpecVersionLabel, type EmitTarget } from "@/services/events/event-spec-emit.service";

const CONTENT_TYPE = { yaml: "application/yaml; charset=utf-8", json: "application/json; charset=utf-8" } as const;

function fileStem(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]+/g, "-");
}

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const limited = checkRateLimit(request);
  if (limited) return limited;
  const auth = await authenticateRequest(request);
  if (!auth.authenticated || !auth.context) return apiUnauthorized();

  try {
    const { id } = await params;
    const url = new URL(request.url);
    const format = url.searchParams.get("format") ?? "yaml";
    if (format !== "yaml" && format !== "json") {
      return apiError({ code: "VALIDATION_ERROR", message: `format must be "yaml" or "json" (got "${format}")` });
    }

    const versionParam = url.searchParams.get("version");
    let target: EmitTarget;
    if (versionParam === "draft") target = { draft: true };
    else if (versionParam) target = { versionLabel: versionParam };
    else {
      const latest = await getLatestEventSpecVersionLabel(id, auth.context);
      if (!latest.success) return apiError(latest.error);
      if (!latest.data) {
        return apiError({ code: "NOT_FOUND", message: `Event spec "${id}" has no published version`, suggestedFix: "Pass ?version=draft to emit the current draft." });
      }
      target = { versionLabel: latest.data };
    }

    const emission = await emitEventSpec(id, target, auth.context);
    if (!emission.success) return apiError(emission.error);
    const { document, yaml, json, version, specName, diagnostics } = emission.data;
    if (!document || !yaml || !json) {
      return apiError({ code: "VALIDATION_ERROR", message: "The draft has unresolved references and cannot be emitted", details: { diagnostics } });
    }
    return new Response(format === "json" ? json : yaml, {
      status: 200,
      headers: {
        "Content-Type": CONTENT_TYPE[format],
        "Content-Disposition": `inline; filename="${fileStem(specName)}-${version}.asyncapi.${format}"`,
        "X-Event-Spec-Version": version,
      },
    });
  } catch (e) {
    console.error("GET /api/v1/event-specs/:id error:", e);
    return apiServerError();
  }
}
```

- [ ] **Step 3: Run + commit**

Run: `npx vitest run tests/unit/api/v1/event-specs-route.test.ts && npx tsc --noEmit`
Expected: PASS; no type errors.

```bash
git add "src/app/api/v1/event-specs/[id]/route.ts" tests/unit/api/v1/event-specs-route.test.ts
git commit -m "feat(18.7): GET /api/v1/event-specs/:id — stored versions, draft emission, yaml|json"
```

---
### Task 14: Workspace tabs — Events + Traits lists and create flows on product / domain / Enterprise (Stories 18.6 / 18.8, D15) — Wave 4

**Files:**
- Create: `src/features/events/workspace/types.ts`, `src/features/events/workspace/load-events-tab-data.ts`, `src/features/events/workspace/EventsTab.tsx`, `src/features/events/workspace/TraitsTab.tsx`
- Modify: `src/app/(dashboard)/schemas/[domainSlug]/[productSlug]/page.tsx`, `src/app/(dashboard)/schemas/[domainSlug]/domain-workspace.tsx`
- Modify: `src/app/(dashboard)/schemas/[domainSlug]/page.tsx`, `src/app/(dashboard)/schemas/[domainSlug]/domain-tabs.tsx`
- Modify: `src/app/(dashboard)/schemas/enterprise/page.tsx`, `src/app/(dashboard)/schemas/enterprise/enterprise-workspace.tsx`
- Modify tests (new mocks / menu expectations): `tests/unit/components/domain-workspace-tabs.test.tsx`, `tests/unit/components/domain-workspace-delete.test.tsx`, `tests/unit/components/domain-tabs.test.tsx`, `tests/unit/components/enterprise-workspace.test.tsx`, `tests/unit/app/product-workspace-page.test.ts`, `tests/unit/app/enterprise-page.test.ts`
- Test: `tests/unit/components/events/events-tab.test.tsx`, `tests/unit/components/events/traits-tab.test.tsx`

**Interfaces:**

```ts
// workspace/types.ts (client-safe)
type EventsCreateIntent = "eventSpec" | "message" | "channel";
interface EventsTabData { eventSpecs: Linked<EventSpecListItem>[]; messages: Linked<MessageListItem>[]; channels: Linked<ChannelListItem>[]; payloadEntities: EntityOption[] }
interface TraitGroup { label: string; href: string; traits: Linked<TraitListItem>[] }
interface TraitsTabData { own: Linked<TraitListItem>[]; inherited: TraitGroup[] }
EMPTY_EVENTS_TAB: EventsTabData; EMPTY_TRAITS_TAB: TraitsTabData
// load-events-tab-data.ts (server)
loadProductEventsData({ tenantId, domainId, productId, domainSlug, productSlug }): Promise<{ events: EventsTabData; traits: TraitsTabData }>
loadLevelTraits({ scope: LevelScope; domainSlug: string | null }): Promise<TraitsTabData>
// EventsTab.tsx
normalizeEventsSection(raw: string | null): EventsSection
EventsTab({ productId, domainSlug, productSlug, data, section, onSectionChange, createIntent?, onCreateIntentConsumed? })
// TraitsTab.tsx
TraitsTab({ target: ScopeTarget; domainSlug: string | null; productSlug: string | null; data: TraitsTabData; createIntent?: "trait" | null; onCreateIntentConsumed? })
```

- [ ] **Step 1: Write the failing component tests**

`tests/unit/components/events/events-tab.test.tsx`:

```tsx
// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ push: vi.fn(), createChannelAction: vi.fn(), createMessageAction: vi.fn(), createEventSpecAction: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: h.push }) }));
vi.mock("@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/channel-actions", () => ({ createChannelAction: h.createChannelAction }));
vi.mock("@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/message-actions", () => ({ createMessageAction: h.createMessageAction }));
vi.mock("@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/event-spec-actions", () => ({ createEventSpecAction: h.createEventSpecAction }));

import { EventsTab, normalizeEventsSection } from "@/features/events/workspace/EventsTab";
import type { EventsTabData } from "@/features/events/workspace/types";

const data: EventsTabData = {
  eventSpecs: [{ id: "s1", name: "checkout-service", summary: "", updatedAt: "", latestVersionLabel: "2.0", hasUnpublishedChanges: true, operationCount: 1, href: "/schemas/payments/checkout/specs/s1" }],
  messages: [],
  channels: [{ id: "c1", name: "orders", summary: "Orders topic", updatedAt: "", address: "payments.orders.v1", protocol: "kafka", format: "avro", href: "/schemas/payments/checkout/channels/c1" }],
  payloadEntities: [{ id: "e1", name: "Order", ownerLabel: "Payments / Checkout", latestVersionId: "v1", latestVersionLabel: "1.0" }],
};

function renderTab(props: Partial<Parameters<typeof EventsTab>[0]> = {}) {
  const onSectionChange = vi.fn();
  render(
    <QueryClientProvider client={new QueryClient()}>
      <EventsTab productId="p1" domainSlug="payments" productSlug="checkout" data={data} section="specs" onSectionChange={onSectionChange} {...props} />
    </QueryClientProvider>
  );
  return { onSectionChange };
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => cleanup());

describe("EventsTab", () => {
  it("normalizes the section param", () => {
    expect(normalizeEventsSection("channels")).toBe("channels");
    expect(normalizeEventsSection("bogus")).toBe("specs");
    expect(normalizeEventsSection(null)).toBe("specs");
  });

  it("lists the selected section with canonical links, badges and counts", () => {
    const { onSectionChange } = renderTab();
    expect(screen.getByRole("link", { name: /checkout-service/ }).getAttribute("href")).toBe("/schemas/payments/checkout/specs/s1");
    expect(screen.getByText("v2.0")).toBeDefined();
    expect(screen.getByText("unpublished changes")).toBeDefined();
    fireEvent.click(screen.getByTestId("events-section-channels"));
    expect(onSectionChange).toHaveBeenCalledWith("channels");
  });

  it("shows an empty state per section", () => {
    renderTab({ section: "messages" });
    expect(screen.getByTestId("events-messages-empty")).toBeDefined();
  });

  it("creates a channel from the New menu intent and opens it", async () => {
    h.createChannelAction.mockResolvedValue({ success: true, data: { id: "c9" } });
    const onCreateIntentConsumed = vi.fn();
    const { onSectionChange } = renderTab({ createIntent: "channel", onCreateIntentConsumed });
    expect(onSectionChange).toHaveBeenCalledWith("channels");
    expect(onCreateIntentConsumed).toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Channel name"), { target: { value: "refunds" } });
    fireEvent.change(screen.getByLabelText("Address"), { target: { value: "payments.refunds.v1" } });
    fireEvent.change(screen.getByLabelText("Format"), { target: { value: "json-schema" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(h.push).toHaveBeenCalledWith("/schemas/payments/checkout/channels/c9"));
    expect(h.createChannelAction).toHaveBeenCalledWith("p1", { name: "refunds", address: "payments.refunds.v1", protocol: "kafka", format: "json-schema", formatDialect: "draft-07" });
  });

  it("creates a message (payload pinned to the latest version server-side) and an event spec; shows errors", async () => {
    h.createMessageAction.mockResolvedValue({ success: false, error: '"OrderCreated" is already used by Entity "OrderCreated" at Product level.' });
    renderTab({ createIntent: "message" });
    fireEvent.change(screen.getByLabelText("Message name"), { target: { value: "OrderCreated" } });
    fireEvent.change(screen.getByLabelText("Payload entity"), { target: { value: "e1" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/already used/);
    expect(h.createMessageAction).toHaveBeenCalledWith("p1", { name: "OrderCreated", payload: { entityId: "e1" } });
    cleanup();

    h.createEventSpecAction.mockResolvedValue({ success: true, data: { id: "s9" } });
    renderTab({ createIntent: "eventSpec" });
    fireEvent.change(screen.getByLabelText("Event spec name"), { target: { value: "checkout-service-v2" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(h.push).toHaveBeenCalledWith("/schemas/payments/checkout/specs/s9"));
    expect(h.createEventSpecAction).toHaveBeenCalledWith("p1", { name: "checkout-service-v2", title: undefined });
  });
});
```

`tests/unit/components/events/traits-tab.test.tsx`:

```tsx
// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ push: vi.fn(), createTraitAction: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: h.push }) }));
vi.mock("@/app/(dashboard)/schemas/trait-actions", () => ({ createTraitAction: h.createTraitAction }));
import { TraitsTab } from "@/features/events/workspace/TraitsTab";

afterEach(() => cleanup());
const trait = (id: string, name: string, href: string) => ({ id, name, kind: "MESSAGE" as const, summary: "", updatedAt: "", href });

describe("TraitsTab", () => {
  it("lists own traits and read-only inherited groups", () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <TraitsTab
          target={{ level: "DOMAIN", domainId: "d1" }} domainSlug="payments" productSlug={null}
          data={{ own: [trait("t1", "Retry", "/schemas/payments/traits/t1")], inherited: [{ label: "From Enterprise", href: "/schemas/enterprise?tab=traits", traits: [trait("t2", "CloudEvents", "/schemas/enterprise/traits/t2")] }] }}
        />
      </QueryClientProvider>
    );
    expect(screen.getByRole("link", { name: /Retry/ }).getAttribute("href")).toBe("/schemas/payments/traits/t1");
    expect(screen.getByRole("link", { name: "From Enterprise" }).getAttribute("href")).toBe("/schemas/enterprise?tab=traits");
    expect(screen.getByRole("link", { name: /CloudEvents/ }).getAttribute("href")).toBe("/schemas/enterprise/traits/t2");
  });

  it("creates a trait at the tab's level and opens it", async () => {
    h.createTraitAction.mockResolvedValue({ success: true, data: { id: "t9" } });
    render(
      <QueryClientProvider client={new QueryClient()}>
        <TraitsTab target={{ level: "TENANT", tenantId: "tenant-1" }} domainSlug={null} productSlug={null} data={{ own: [], inherited: [] }} createIntent="trait" />
      </QueryClientProvider>
    );
    fireEvent.change(screen.getByLabelText("Trait name"), { target: { value: "CloudEvents" } });
    fireEvent.change(screen.getByLabelText("Kind"), { target: { value: "OPERATION" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(h.push).toHaveBeenCalledWith("/schemas/enterprise/traits/t9"));
    expect(h.createTraitAction).toHaveBeenCalledWith({ level: "TENANT", tenantId: "tenant-1" }, { name: "CloudEvents", kind: "OPERATION" });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/unit/components/events/events-tab.test.tsx tests/unit/components/events/traits-tab.test.tsx`
Expected: FAIL — missing modules.

- [ ] **Step 3: Implement `src/features/events/workspace/types.ts` and `load-events-tab-data.ts`**

```ts
// src/features/events/workspace/types.ts
import type { ChannelListItem, EventSpecListItem, Linked, MessageListItem, TraitListItem } from "@/lib/events/types";
import type { EntityOption } from "@/features/events/shared/EntityPinPicker";

export type EventsCreateIntent = "eventSpec" | "message" | "channel";

export interface EventsTabData {
  eventSpecs: Linked<EventSpecListItem>[];
  messages: Linked<MessageListItem>[];
  channels: Linked<ChannelListItem>[];
  /** Entities a new Message may take as payload (every entity of the tenant). */
  payloadEntities: EntityOption[];
}

export interface TraitGroup {
  label: string;
  href: string;
  traits: Linked<TraitListItem>[];
}

export interface TraitsTabData {
  own: Linked<TraitListItem>[];
  /** Traits of broader levels (domain, Enterprise), read-only here. */
  inherited: TraitGroup[];
}

export const EMPTY_EVENTS_TAB: EventsTabData = { eventSpecs: [], messages: [], channels: [], payloadEntities: [] };
export const EMPTY_TRAITS_TAB: TraitsTabData = { own: [], inherited: [] };
```

```ts
// src/features/events/workspace/load-events-tab-data.ts
import { prisma } from "@/lib/db";
import type { LevelScope } from "@/lib/levels";
import { assetHref } from "@/lib/navigation/asset-href";
import { channelListItem, eventSpecListItem, messageListItem, traitListItem } from "@/lib/events/list-items";
import type { Linked, TraitListItem } from "@/lib/events/types";
import { loadEntityOptions } from "@/features/events/load-options";
import type { EventsTabData, TraitGroup, TraitsTabData } from "./types";

const TRAIT_SELECT = { id: true, name: true, kind: true, spec: true, updatedAt: true } as const;
const VERSION = { select: { major: true, minor: true } } as const;

function linkTraits(rows: Array<{ id: string; name: string; kind: string; spec: unknown; updatedAt: Date }>, domainSlug: string | null, productSlug: string | null): Linked<TraitListItem>[] {
  return rows.map((t) => ({ ...traitListItem(t), href: assetHref({ kind: "trait", id: t.id, domainSlug, productSlug }) }));
}

const nonEmpty = (groups: TraitGroup[]) => groups.filter((g) => g.traits.length > 0);

export async function loadProductEventsData(args: {
  tenantId: string; domainId: string; productId: string; domainSlug: string; productSlug: string;
}): Promise<{ events: EventsTabData; traits: TraitsTabData }> {
  const { tenantId, domainId, productId, domainSlug, productSlug } = args;
  const [specs, messages, channels, payloadEntities, ownTraits, domainTraits, tenantTraits] = await Promise.all([
    prisma.eventSpec.findMany({
      where: { productId }, orderBy: { name: "asc" },
      select: { id: true, name: true, document: true, hasUnpublishedChanges: true, updatedAt: true, latestVersion: VERSION },
    }),
    prisma.message.findMany({
      where: { productId }, orderBy: { name: "asc" },
      select: { id: true, name: true, spec: true, hasUnpublishedChanges: true, updatedAt: true, latestVersion: VERSION, payloadEntity: { select: { name: true } } },
    }),
    prisma.channel.findMany({
      where: { productId }, orderBy: { name: "asc" },
      select: { id: true, name: true, address: true, protocol: true, format: true, spec: true, updatedAt: true },
    }),
    loadEntityOptions(tenantId),
    prisma.trait.findMany({ where: { productId }, orderBy: { name: "asc" }, select: TRAIT_SELECT }),
    prisma.trait.findMany({ where: { domainId, productId: null }, orderBy: { name: "asc" }, select: TRAIT_SELECT }),
    prisma.trait.findMany({ where: { tenantId, domainId: null }, orderBy: { name: "asc" }, select: TRAIT_SELECT }),
  ]);
  const at = { domainSlug, productSlug };
  return {
    events: {
      eventSpecs: specs.map((s) => ({ ...eventSpecListItem(s), href: assetHref({ kind: "eventSpec", id: s.id, ...at }) })),
      messages: messages.map((m) => ({ ...messageListItem(m), href: assetHref({ kind: "message", id: m.id, ...at }) })),
      channels: channels.map((c) => ({ ...channelListItem(c), href: assetHref({ kind: "channel", id: c.id, ...at }) })),
      payloadEntities,
    },
    traits: {
      own: linkTraits(ownTraits, domainSlug, productSlug),
      inherited: nonEmpty([
        { label: "From Domain", href: assetHref({ kind: "traits", domainSlug, productSlug: null }), traits: linkTraits(domainTraits, domainSlug, null) },
        { label: "From Enterprise", href: assetHref({ kind: "traits", domainSlug: null, productSlug: null }), traits: linkTraits(tenantTraits, null, null) },
      ]),
    },
  };
}

/** Domain (scope.domainId set) or Enterprise traits; a domain also shows the Enterprise traits read-only. */
export async function loadLevelTraits(args: { scope: LevelScope; domainSlug: string | null }): Promise<TraitsTabData> {
  const { scope, domainSlug } = args;
  if (!scope.domainId) {
    const own = await prisma.trait.findMany({ where: { tenantId: scope.tenantId, domainId: null }, orderBy: { name: "asc" }, select: TRAIT_SELECT });
    return { own: linkTraits(own, null, null), inherited: [] };
  }
  const [own, tenant] = await Promise.all([
    prisma.trait.findMany({ where: { domainId: scope.domainId, productId: null }, orderBy: { name: "asc" }, select: TRAIT_SELECT }),
    prisma.trait.findMany({ where: { tenantId: scope.tenantId, domainId: null }, orderBy: { name: "asc" }, select: TRAIT_SELECT }),
  ]);
  return {
    own: linkTraits(own, domainSlug, null),
    inherited: nonEmpty([{ label: "From Enterprise", href: assetHref({ kind: "traits", domainSlug: null, productSlug: null }), traits: linkTraits(tenant, null, null) }]),
  };
}
```

- [ ] **Step 4: Implement `src/features/events/workspace/EventsTab.tsx`**

```tsx
"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { FileCode2, Mail, Plus, Radio } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { createChannelAction } from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/channel-actions";
import { createEventSpecAction } from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/event-spec-actions";
import { createMessageAction } from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/message-actions";
import { useInvalidateDomainsTree } from "@/hooks/useDomainsTree";
import { JSON_SCHEMA_DIALECTS, KNOWN_PROTOCOLS, PAYLOAD_FORMATS } from "@/lib/events/inputs";
import { assetHref, type EventsSection } from "@/lib/navigation/asset-href";
import type { EntityOption } from "@/features/events/shared/EntityPinPicker";
import type { EventsCreateIntent, EventsTabData } from "./types";

const SECTIONS: Array<{ id: EventsSection; label: string; singular: string; intent: EventsCreateIntent; icon: typeof Mail }> = [
  { id: "specs", label: "Event Specs", singular: "Event Spec", intent: "eventSpec", icon: FileCode2 },
  { id: "messages", label: "Messages", singular: "Message", intent: "message", icon: Mail },
  { id: "channels", label: "Channels", singular: "Channel", intent: "channel", icon: Radio },
];
const SECTION_OF: Record<EventsCreateIntent, EventsSection> = { eventSpec: "specs", message: "messages", channel: "channels" };
const selectClass = "w-full rounded-md border border-border bg-background px-space-2 py-1.5 text-body-small";

export function normalizeEventsSection(raw: string | null): EventsSection {
  return raw === "messages" || raw === "channels" ? raw : "specs";
}

function Field({ label, htmlFor, children }: { label: string; htmlFor: string; children: ReactNode }) {
  return (
    <div className="space-y-space-1">
      <label htmlFor={htmlFor} className="block text-caption text-muted-foreground">{label}</label>
      {children}
    </div>
  );
}

function FormShell({ title, testId, error, busy, onCancel, onSubmit, children }: {
  title: string; testId: string; error: string | null; busy: boolean; onCancel: () => void; onSubmit: () => void; children: ReactNode;
}) {
  return (
    <form
      data-testid={testId}
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
      className="surface-glass space-y-space-3 rounded-xl border border-primary/20 p-space-4"
    >
      <h3 className="text-heading-3 text-foreground">{title}</h3>
      {children}
      {error && <p role="alert" className="text-body-small text-destructive">{error}</p>}
      <div className="flex justify-end gap-space-2">
        <Button type="button" variant="outline" size="sm" onClick={onCancel} disabled={busy}>Cancel</Button>
        <Button type="submit" size="sm" disabled={busy}>{busy ? "Creating…" : "Create"}</Button>
      </div>
    </form>
  );
}

type CreateResult = { success: true; data: { id: string } } | { success: false; error: string };
function useCreateForm(onCreated: (id: string) => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run(action: () => Promise<CreateResult>) {
    setBusy(true);
    setError(null);
    const r = await action();
    setBusy(false);
    if (r.success) onCreated(r.data.id);
    else setError(r.error);
  }
  return { busy, error, run };
}

function NewEventSpecForm({ productId, onCancel, onCreated }: { productId: string; onCancel: () => void; onCreated: (id: string) => void }) {
  const [name, setName] = useState("");
  const [title, setTitle] = useState("");
  const form = useCreateForm(onCreated);
  return (
    <FormShell title="New Event Spec" testId="new-event-spec-form" error={form.error} busy={form.busy} onCancel={onCancel}
      onSubmit={() => form.run(() => createEventSpecAction(productId, { name, title: title.trim() || undefined }))}>
      <Field label="Name (AsyncAPI-safe: letters, digits, . _ -)" htmlFor="new-spec-name">
        <Input id="new-spec-name" aria-label="Event spec name" value={name} onChange={(e) => setName(e.target.value)} placeholder="checkout-service" required />
      </Field>
      <Field label="Title (info.title — defaults to the name)" htmlFor="new-spec-title">
        <Input id="new-spec-title" aria-label="Event spec title" value={title} onChange={(e) => setTitle(e.target.value)} />
      </Field>
    </FormShell>
  );
}

function NewMessageForm({ productId, entities, onCancel, onCreated }: { productId: string; entities: EntityOption[]; onCancel: () => void; onCreated: (id: string) => void }) {
  const [name, setName] = useState("");
  const [entityId, setEntityId] = useState("");
  const form = useCreateForm(onCreated);
  const groups = useMemo(() => {
    const byOwner = new Map<string, EntityOption[]>();
    for (const e of entities) byOwner.set(e.ownerLabel, [...(byOwner.get(e.ownerLabel) ?? []), e]);
    return [...byOwner.entries()];
  }, [entities]);
  return (
    <FormShell title="New Message" testId="new-message-form" error={form.error} busy={form.busy} onCancel={onCancel}
      onSubmit={() => form.run(() => createMessageAction(productId, { name, payload: { entityId } }))}>
      <Field label="Name" htmlFor="new-message-name">
        <Input id="new-message-name" aria-label="Message name" value={name} onChange={(e) => setName(e.target.value)} placeholder="OrderCreated" required />
      </Field>
      <Field label="Payload entity (pins its latest published version)" htmlFor="new-message-payload">
        <select id="new-message-payload" aria-label="Payload entity" className={selectClass} value={entityId} onChange={(e) => setEntityId(e.target.value)} required>
          <option value="">Select an entity</option>
          {groups.map(([owner, items]) => (
            <optgroup key={owner} label={owner}>
              {items.map((e) => (
                <option key={e.id} value={e.id}>{e.name}{e.latestVersionLabel ? ` (v${e.latestVersionLabel})` : " (unpublished)"}</option>
              ))}
            </optgroup>
          ))}
        </select>
      </Field>
    </FormShell>
  );
}

function NewChannelForm({ productId, onCancel, onCreated }: { productId: string; onCancel: () => void; onCreated: (id: string) => void }) {
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [protocol, setProtocol] = useState("kafka");
  const [format, setFormat] = useState("avro");
  const [dialect, setDialect] = useState("draft-07");
  const form = useCreateForm(onCreated);
  return (
    <FormShell title="New Channel" testId="new-channel-form" error={form.error} busy={form.busy} onCancel={onCancel}
      onSubmit={() =>
        form.run(() =>
          createChannelAction(productId, { name, address: address.trim() || null, protocol, format, formatDialect: format === "json-schema" ? dialect : null })
        )
      }>
      <div className="grid grid-cols-1 gap-space-3 md:grid-cols-2">
        <Field label="Name" htmlFor="new-channel-name">
          <Input id="new-channel-name" aria-label="Channel name" value={name} onChange={(e) => setName(e.target.value)} placeholder="orders" required />
        </Field>
        <Field label="Address (topic / queue; {param} allowed)" htmlFor="new-channel-address">
          <Input id="new-channel-address" aria-label="Address" value={address} onChange={(e) => setAddress(e.target.value)} placeholder="payments.orders.v1" />
        </Field>
        <Field label="Protocol" htmlFor="new-channel-protocol">
          <Input id="new-channel-protocol" aria-label="Protocol" list="event-protocols" value={protocol} onChange={(e) => setProtocol(e.target.value)} />
          <datalist id="event-protocols">{KNOWN_PROTOCOLS.map((p) => <option key={p} value={p} />)}</datalist>
        </Field>
        <Field label="Format" htmlFor="new-channel-format">
          <select id="new-channel-format" aria-label="Format" className={selectClass} value={format} onChange={(e) => setFormat(e.target.value)}>
            {PAYLOAD_FORMATS.map((f) => <option key={f} value={f}>{f}</option>)}
          </select>
        </Field>
        {format === "json-schema" && (
          <Field label="JSON Schema dialect" htmlFor="new-channel-dialect">
            <select id="new-channel-dialect" aria-label="Dialect" className={selectClass} value={dialect} onChange={(e) => setDialect(e.target.value)}>
              {JSON_SCHEMA_DIALECTS.map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
          </Field>
        )}
      </div>
    </FormShell>
  );
}

function ItemList<T extends { id: string; name: string; summary: string; href: string }>({
  items, empty, testId, meta,
}: { items: T[]; empty: string; testId: string; meta: (item: T) => ReactNode }) {
  if (items.length === 0) return <p className="py-space-8 text-center text-body-small text-muted-foreground" data-testid={`${testId}-empty`}>{empty}</p>;
  return (
    <ul className="grid grid-cols-1 gap-space-3 md:grid-cols-2 xl:grid-cols-3" data-testid={testId}>
      {items.map((item) => (
        <li key={item.id}>
          <Link href={item.href} className="block rounded-lg border border-border/60 p-space-4 transition-colors hover:border-primary/40">
            <div className="flex items-center justify-between gap-space-2">
              <span className="truncate font-medium text-foreground">{item.name}</span>
              <span className="flex shrink-0 items-center gap-space-1">{meta(item)}</span>
            </div>
            {item.summary && <p className="mt-space-1 line-clamp-2 text-caption text-muted-foreground">{item.summary}</p>}
          </Link>
        </li>
      ))}
    </ul>
  );
}

const versionBadges = (latest: string | null, dirty: boolean) => (
  <>
    <Badge variant="secondary">{latest ? `v${latest}` : "unpublished"}</Badge>
    {latest && dirty && <Badge variant="outline">unpublished changes</Badge>}
  </>
);

export function EventsTab({
  productId, domainSlug, productSlug, data, section, onSectionChange, createIntent, onCreateIntentConsumed,
}: {
  productId: string;
  domainSlug: string;
  productSlug: string;
  data: EventsTabData;
  section: EventsSection;
  onSectionChange: (section: EventsSection) => void;
  createIntent?: EventsCreateIntent | null;
  onCreateIntentConsumed?: () => void;
}) {
  const router = useRouter();
  const invalidateDomainsTree = useInvalidateDomainsTree();
  const [creating, setCreating] = useState<EventsCreateIntent | null>(null);

  // A New-menu click on the workspace header opens the matching inline form (same pattern as DomainTypesTab).
  useEffect(() => {
    if (!createIntent) return;
    setCreating(createIntent);
    onSectionChange(SECTION_OF[createIntent]);
    onCreateIntentConsumed?.();
  }, [createIntent, onCreateIntentConsumed, onSectionChange]);

  const at = { domainSlug, productSlug };
  const opened = (href: string) => {
    void invalidateDomainsTree();
    router.push(href);
  };
  const counts: Record<EventsSection, number> = { specs: data.eventSpecs.length, messages: data.messages.length, channels: data.channels.length };
  const current = SECTIONS.find((s) => s.id === section) ?? SECTIONS[0];

  return (
    <div className="space-y-space-4" data-testid="events-tab">
      <div className="flex flex-wrap items-center gap-space-2">
        <div role="tablist" aria-label="Events sections" className="flex items-center gap-space-1 rounded-lg bg-muted p-[3px]">
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              type="button"
              role="tab"
              aria-selected={section === s.id}
              data-testid={`events-section-${s.id}`}
              onClick={() => onSectionChange(s.id)}
              className={`flex items-center gap-space-1 rounded-md px-space-3 py-1 text-body-small ${section === s.id ? "bg-background font-medium text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
            >
              <s.icon className="w-4 h-4" aria-hidden="true" />
              {s.label}
              <span className="text-caption text-muted-foreground">{counts[s.id]}</span>
            </button>
          ))}
        </div>
        <Button size="sm" variant="outline" className="ml-auto gap-1.5" onClick={() => setCreating(current.intent)} data-testid="events-new">
          <Plus className="w-4 h-4" /> New {current.singular}
        </Button>
      </div>

      {creating === "eventSpec" && (
        <NewEventSpecForm productId={productId} onCancel={() => setCreating(null)} onCreated={(id) => opened(assetHref({ kind: "eventSpec", id, ...at }))} />
      )}
      {creating === "message" && (
        <NewMessageForm productId={productId} entities={data.payloadEntities} onCancel={() => setCreating(null)} onCreated={(id) => opened(assetHref({ kind: "message", id, ...at }))} />
      )}
      {creating === "channel" && (
        <NewChannelForm productId={productId} onCancel={() => setCreating(null)} onCreated={(id) => opened(assetHref({ kind: "channel", id, ...at }))} />
      )}

      {section === "specs" && (
        <ItemList items={data.eventSpecs} empty="No event specs yet — create one to describe what this product sends and receives." testId="events-specs"
          meta={(s) => (<>{versionBadges(s.latestVersionLabel, s.hasUnpublishedChanges)}<span className="text-caption text-muted-foreground">{s.operationCount} op</span></>)} />
      )}
      {section === "messages" && (
        <ItemList items={data.messages} empty="No messages yet — a message pins a published entity version as its payload." testId="events-messages"
          meta={(m) => (<>{versionBadges(m.latestVersionLabel, m.hasUnpublishedChanges)}<span className="text-caption text-muted-foreground">{m.payloadEntityName}</span></>)} />
      )}
      {section === "channels" && (
        <ItemList items={data.channels} empty="No channels yet — a channel is a topic / queue with a format profile." testId="events-channels"
          meta={(c) => (<><Badge variant="secondary">{c.protocol}</Badge><Badge variant="outline">{c.format}</Badge></>)} />
      )}
    </div>
  );
}
```

(`useCreateForm` is a real hook — it calls `useState` — so its `use` prefix is correct.)

- [ ] **Step 5: Implement `src/features/events/workspace/TraitsTab.tsx`**

```tsx
"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Plus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { createTraitAction } from "@/app/(dashboard)/schemas/trait-actions";
import { useInvalidateDomainsTree } from "@/hooks/useDomainsTree";
import type { ScopeTarget } from "@/lib/asset-scope";
import type { Linked, TraitKind, TraitListItem } from "@/lib/events/types";
import { assetHref } from "@/lib/navigation/asset-href";
import type { TraitsTabData } from "./types";

function TraitCards({ traits }: { traits: Linked<TraitListItem>[] }) {
  return (
    <ul className="grid grid-cols-1 gap-space-3 md:grid-cols-2 xl:grid-cols-3">
      {traits.map((t) => (
        <li key={t.id}>
          <Link href={t.href} className="block rounded-lg border border-border/60 p-space-4 transition-colors hover:border-primary/40">
            <div className="flex items-center justify-between gap-space-2">
              <span className="truncate font-medium text-foreground">{t.name}</span>
              <Badge variant="secondary">{t.kind === "MESSAGE" ? "message" : "operation"}</Badge>
            </div>
            {t.summary && <p className="mt-space-1 text-caption text-muted-foreground">{t.summary}</p>}
          </Link>
        </li>
      ))}
    </ul>
  );
}

export function TraitsTab({
  target, domainSlug, productSlug, data, createIntent, onCreateIntentConsumed,
}: {
  target: ScopeTarget;
  domainSlug: string | null;
  productSlug: string | null;
  data: TraitsTabData;
  createIntent?: "trait" | null;
  onCreateIntentConsumed?: () => void;
}) {
  const router = useRouter();
  const invalidateDomainsTree = useInvalidateDomainsTree();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [kind, setKind] = useState<TraitKind>("MESSAGE");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!createIntent) return;
    setOpen(true);
    onCreateIntentConsumed?.();
  }, [createIntent, onCreateIntentConsumed]);

  async function create() {
    setBusy(true);
    setError(null);
    const r = await createTraitAction(target, { name, kind });
    setBusy(false);
    if (!r.success) {
      setError(r.error);
      return;
    }
    void invalidateDomainsTree();
    router.push(assetHref({ kind: "trait", id: r.data.id, domainSlug, productSlug }));
  }

  return (
    <div className="space-y-space-6" data-testid="traits-tab">
      <div className="flex items-center justify-between">
        <p className="text-body-small text-muted-foreground">Reusable AsyncAPI message traits (e.g. CloudEvents headers) and operation traits.</p>
        <Button size="sm" variant="outline" className="gap-1.5" onClick={() => setOpen(true)} data-testid="traits-new">
          <Plus className="w-4 h-4" /> New Trait
        </Button>
      </div>

      {open && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void create();
          }}
          className="surface-glass space-y-space-3 rounded-xl border border-primary/20 p-space-4"
          data-testid="new-trait-form"
        >
          <h3 className="text-heading-3 text-foreground">New Trait</h3>
          <div className="grid grid-cols-1 gap-space-3 md:grid-cols-2">
            <div className="space-y-space-1">
              <label htmlFor="new-trait-name" className="block text-caption text-muted-foreground">Name</label>
              <Input id="new-trait-name" aria-label="Trait name" value={name} onChange={(e) => setName(e.target.value)} placeholder="CloudEvents" required />
            </div>
            <div className="space-y-space-1">
              <label htmlFor="new-trait-kind" className="block text-caption text-muted-foreground">Kind</label>
              <select id="new-trait-kind" aria-label="Kind" value={kind} onChange={(e) => setKind(e.target.value as TraitKind)} className="w-full rounded-md border border-border bg-background px-space-2 py-1.5 text-body-small">
                <option value="MESSAGE">Message trait</option>
                <option value="OPERATION">Operation trait</option>
              </select>
            </div>
          </div>
          {error && <p role="alert" className="text-body-small text-destructive">{error}</p>}
          <div className="flex justify-end gap-space-2">
            <Button type="button" variant="outline" size="sm" onClick={() => setOpen(false)} disabled={busy}>Cancel</Button>
            <Button type="submit" size="sm" disabled={busy}>{busy ? "Creating…" : "Create"}</Button>
          </div>
        </form>
      )}

      {data.own.length > 0 ? (
        <TraitCards traits={data.own} />
      ) : (
        <p className="text-body-small text-muted-foreground" data-testid="traits-empty">No traits at this level yet.</p>
      )}

      {data.inherited.map((group) => (
        <section key={group.label} className="space-y-space-2">
          <h3 className="text-heading-3 text-muted-foreground">
            <Link href={group.href} className="hover:text-foreground">{group.label}</Link>
          </h3>
          <TraitCards traits={group.traits} />
        </section>
      ))}
    </div>
  );
}
```

- [ ] **Step 6: Run the component tests**

Run: `npx vitest run tests/unit/components/events/events-tab.test.tsx tests/unit/components/events/traits-tab.test.tsx`
Expected: PASS.

- [ ] **Step 7: Wire the product workspace** (`domain-workspace.tsx` + product `page.tsx`)

In `domain-workspace.tsx`:

```tsx
// imports
import { useCallback } from "react"; // add to the existing react import
import { Puzzle, Radio } from "lucide-react"; // add to the existing lucide import
import { EventsTab, normalizeEventsSection } from "@/features/events/workspace/EventsTab";
import { TraitsTab } from "@/features/events/workspace/TraitsTab";
import { EMPTY_EVENTS_TAB, EMPTY_TRAITS_TAB, type EventsCreateIntent, type EventsTabData, type TraitsTabData } from "@/features/events/workspace/types";
import { assetHref, type EventsSection } from "@/lib/navigation/asset-href"; // extend the existing import

export type DomainTab = "entities" | "data-types" | "apis" | "events" | "traits";

export function normalizeWorkspaceTab(raw: string | null): DomainTab {
  if (raw === "types") return "data-types";
  if (raw === "data-types" || raw === "apis" || raw === "entities" || raw === "events" || raw === "traits") return raw;
  return "entities";
}

const domainTabs: { icon: React.ComponentType<{ className?: string }>; label: string; id: DomainTab }[] = [
  { icon: Database, label: "Entities", id: "entities" },
  { icon: Hash, label: "Data Types", id: "data-types" },
  { icon: Globe, label: "APIs", id: "apis" },
  { icon: Radio, label: "Events", id: "events" },
  { icon: Puzzle, label: "Traits", id: "traits" },
];
```

Props (`DomainWorkspaceProps`) gain:

```ts
  /** Product-level Event Specs / Messages / Channels (spec §4.5). */
  events?: EventsTabData;
  /** Product traits + read-only domain / Enterprise traits. */
  traits?: TraitsTabData;
```

Inside the component, after the `activeTab` state:

```tsx
  const sectionParam = searchParams.get("section");
  const [eventsSection, setEventsSection] = useState<EventsSection>(normalizeEventsSection(sectionParam));
  useEffect(() => {
    setEventsSection(normalizeEventsSection(sectionParam));
  }, [sectionParam]);
  const [eventsCreateIntent, setEventsCreateIntent] = useState<EventsCreateIntent | null>(null);
  const [traitCreateIntent, setTraitCreateIntent] = useState<"trait" | null>(null);
  const consumeEventsIntent = useCallback(() => setEventsCreateIntent(null), []);
  const consumeTraitIntent = useCallback(() => setTraitCreateIntent(null), []);
  const selectEventsSection = useCallback(
    (section: EventsSection) => {
      setEventsSection(section);
      window.history.replaceState(null, "", assetHref({ kind: "events", domainSlug, productSlug, section }));
    },
    [domainSlug, productSlug]
  );
```

`tabHref` gains two branches (before the `return assetHref({ kind: "product", … })`):

```ts
    if (tab === "events") return assetHref({ kind: "events", domainSlug, productSlug, section: eventsSection });
    if (tab === "traits") return assetHref({ kind: "traits", domainSlug, productSlug });
```

`CreateDropdown` gains:

```tsx
            onNewEventSpec={() => { selectTab("events"); setEventsCreateIntent("eventSpec"); }}
            onNewMessage={() => { selectTab("events"); setEventsCreateIntent("message"); }}
            onNewChannel={() => { selectTab("events"); setEventsCreateIntent("channel"); }}
            onNewTrait={() => { selectTab("traits"); setTraitCreateIntent("trait"); }}
```

and after the APIs panel:

```tsx
      {/* Events tab */}
      {activeTab === "events" && (
        <EventsTab
          productId={productId}
          domainSlug={domainSlug}
          productSlug={productSlug}
          data={events ?? EMPTY_EVENTS_TAB}
          section={eventsSection}
          onSectionChange={selectEventsSection}
          createIntent={eventsCreateIntent}
          onCreateIntentConsumed={consumeEventsIntent}
        />
      )}

      {/* Traits tab */}
      {activeTab === "traits" && (
        <TraitsTab
          target={productTarget}
          domainSlug={domainSlug}
          productSlug={productSlug}
          data={traits ?? EMPTY_TRAITS_TAB}
          createIntent={traitCreateIntent}
          onCreateIntentConsumed={consumeTraitIntent}
        />
      )}
```

In `src/app/(dashboard)/schemas/[domainSlug]/[productSlug]/page.tsx`: add `import { loadProductEventsData } from "@/features/events/workspace/load-events-tab-data";`; right before the big `Promise.all` start the load so it runs concurrently:

```ts
  const eventsDataPromise = loadProductEventsData({
    tenantId: domain.tenantId, domainId: domain.id, productId: product.id, domainSlug, productSlug,
  });
```

after the `Promise.all` destructuring: `const eventsData = await eventsDataPromise;` and pass `events={eventsData.events}` and `traits={eventsData.traits}` to `<DomainWorkspace>`.

- [ ] **Step 8: Wire the domain page** (`domain-tabs.tsx` + domain `page.tsx`)

```tsx
// domain-tabs.tsx
import { Puzzle } from "lucide-react"; // add to the existing lucide import
import { TraitsTab } from "@/features/events/workspace/TraitsTab";
import { EMPTY_TRAITS_TAB, type TraitsTabData } from "@/features/events/workspace/types";

export type DomainPageTab = "products" | "data-types" | "apis" | "traits";

export function normalizeDomainTab(raw: string | null): DomainPageTab {
  if (raw === "types") return "data-types";
  if (raw === "data-types" || raw === "apis" || raw === "products" || raw === "traits") return raw;
  return "products";
}

const TABS: { id: DomainPageTab; label: string; icon: typeof Package }[] = [
  { id: "products", label: "Products", icon: Package },
  { id: "data-types", label: "Data Types", icon: Layers },
  { id: "apis", label: "APIs", icon: Globe },
  { id: "traits", label: "Traits", icon: Puzzle },
];
```

`DomainTabsProps` gains `traits?: TraitsTabData;` (destructure it), `hrefFor` gains `if (tab === "traits") return assetHref({ kind: "traits", domainSlug: domain.slug, productSlug: null });`, and the tabpanel gains:

```tsx
        {activeTab === "traits" && (
          <TraitsTab target={target} domainSlug={domain.slug} productSlug={null} data={traits ?? EMPTY_TRAITS_TAB} />
        )}
```

In the domain `page.tsx`: `import { loadLevelTraits } from "@/features/events/workspace/load-events-tab-data";`, before its `Promise.all`:

```ts
  const traitsPromise = loadLevelTraits({ scope: { tenantId: resolved.tenantId, domainId: resolved.id, productId: null }, domainSlug });
```

and pass `traits={await traitsPromise}` to `<DomainTabs>`.

- [ ] **Step 9: Wire the Enterprise workspace** (`enterprise-workspace.tsx` + enterprise `page.tsx`)

```tsx
// enterprise-workspace.tsx
import { Puzzle } from "lucide-react"; // add to the existing lucide import
import { TraitsTab } from "@/features/events/workspace/TraitsTab";
import { EMPTY_TRAITS_TAB, type TraitsTabData } from "@/features/events/workspace/types";

export type EnterpriseTab = "entities" | "data-types" | "traits";

export function normalizeEnterpriseTab(raw: string | null, fallback: EnterpriseTab): EnterpriseTab {
  if (raw === "types") return "data-types";
  if (raw === "data-types" || raw === "entities" || raw === "traits") return raw;
  return fallback;
}

const TABS: { id: EnterpriseTab; label: string; icon: typeof Database }[] = [
  { id: "entities", label: "Entities", icon: Database },
  { id: "data-types", label: "Data Types", icon: Hash },
  { id: "traits", label: "Traits", icon: Puzzle },
];

/** Every tab writes an explicit `?tab=` so the URL never depends on the default. */
function tabHref(tab: EnterpriseTab) {
  if (tab === "data-types") return assetHref({ kind: "dataTypes", domainSlug: null, productSlug: null });
  if (tab === "traits") return assetHref({ kind: "traits", domainSlug: null, productSlug: null });
  return assetHref({ kind: "enterprise" }, { query: { tab: "entities" } });
}
```

`EnterpriseWorkspaceProps` gains `traits?: TraitsTabData;`; add `const [traitCreateIntent, setTraitCreateIntent] = useState<"trait" | null>(null);` and `const consumeTraitIntent = useCallback(() => setTraitCreateIntent(null), []);` (add `useCallback` to the react import); the `CreateDropdown` gains `onNewTrait={() => { selectTab("traits"); setTraitCreateIntent("trait"); }}`; the tabpanel gains:

```tsx
        {activeTab === "traits" && (
          <TraitsTab
            target={{ level: "TENANT", tenantId }}
            domainSlug={null}
            productSlug={null}
            data={traits ?? EMPTY_TRAITS_TAB}
            createIntent={traitCreateIntent}
            onCreateIntentConsumed={consumeTraitIntent}
          />
        )}
```

Update the header copy to "Entities, data types and traits shared across every domain." In `enterprise/page.tsx`: `import { loadLevelTraits } …`, start `const traitsPromise = loadLevelTraits({ scope: { tenantId, domainId: null, productId: null }, domainSlug: null });` before its `Promise.all` and pass `traits={await traitsPromise}`.

- [ ] **Step 10: Keep the existing suites green**

Add these mocks (next to the existing `vi.mock` calls) in `tests/unit/components/domain-workspace-tabs.test.tsx`, `domain-workspace-delete.test.tsx`, `domain-tabs.test.tsx` and `enterprise-workspace.test.tsx` — the new tabs import server-action modules that pull in NextAuth:

```ts
vi.mock("@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/channel-actions", () => ({ createChannelAction: vi.fn() }));
vi.mock("@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/message-actions", () => ({ createMessageAction: vi.fn() }));
vi.mock("@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/event-spec-actions", () => ({ createEventSpecAction: vi.fn() }));
vi.mock("@/app/(dashboard)/schemas/trait-actions", () => ({ createTraitAction: vi.fn() }));
```

Update the two exact-menu assertions (the level-aware New menu now offers the events kinds, spec §4.6):

```ts
// domain-workspace-tabs.test.tsx — "lists exactly New Entity, New Custom Data Type, New API and the events kinds"
    expect(items.map((i) => i.querySelector(".text-body-small")?.textContent)).toEqual([
      "New Entity", "New Custom Data Type", "New API", "New Event Spec", "New Message", "New Channel", "New Trait",
    ]);

// enterprise-workspace.test.tsx — "offers exactly New Entity, New Custom Data Type and New Trait"
    expect(items.map((i) => i.textContent)).toEqual([
      expect.stringContaining("New Entity"),
      expect.stringContaining("New Custom Data Type"),
      expect.stringContaining("New Trait"),
    ]);
```

In `tests/unit/app/product-workspace-page.test.ts` and `tests/unit/app/enterprise-page.test.ts` add:

```ts
vi.mock("@/features/events/workspace/load-events-tab-data", () => ({
  loadProductEventsData: vi.fn(async () => ({
    events: { eventSpecs: [], messages: [], channels: [], payloadEntities: [] },
    traits: { own: [], inherited: [] },
  })),
  loadLevelTraits: vi.fn(async () => ({ own: [], inherited: [] })),
}));
```

Add one assertion to `domain-workspace-tabs.test.tsx` proving `?tab=events&section=channels` opens the Events tab on Channels:

```tsx
  it("opens the Events tab on the section from the URL", () => {
    nav.search = "tab=events&section=channels";
    renderWorkspace();
    expect(screen.getByTestId("events-section-channels").getAttribute("aria-selected")).toBe("true");
    expect(normalizeWorkspaceTab("traits")).toBe("traits");
  });
```

- [ ] **Step 11: Run all affected suites + type check**

Run: `npx vitest run tests/unit/components tests/unit/app/product-workspace-page.test.ts tests/unit/app/enterprise-page.test.ts && npx tsc --noEmit`
Expected: PASS (beyond the 3 baseline `schemas-tab` failures); no type errors.

- [ ] **Step 12: Commit**

```bash
git add src/features/events/workspace "src/app/(dashboard)/schemas/[domainSlug]/[productSlug]/page.tsx" "src/app/(dashboard)/schemas/[domainSlug]/domain-workspace.tsx" "src/app/(dashboard)/schemas/[domainSlug]/page.tsx" "src/app/(dashboard)/schemas/[domainSlug]/domain-tabs.tsx" "src/app/(dashboard)/schemas/enterprise/page.tsx" "src/app/(dashboard)/schemas/enterprise/enterprise-workspace.tsx" tests/unit/components tests/unit/app/product-workspace-page.test.ts tests/unit/app/enterprise-page.test.ts
git commit -m "feat(18.6,18.8): Events + Traits workspace tabs with create flows; level-aware New menus"
```

---
### Task 15: Channel + Trait detail pages (Story 18.6) — Wave 5

**Files:**
- Create: `src/features/events/channels/load-channel-page.ts`, `src/features/events/channels/ChannelEditor.tsx`
- Create: `src/app/(dashboard)/schemas/[domainSlug]/[productSlug]/channels/[channelId]/page.tsx`, `.../channels/[channelId]/loading.tsx`
- Create: `src/features/events/traits/load-trait-page.ts`, `src/features/events/traits/TraitEditor.tsx`, `src/features/events/traits/TraitRoutePage.tsx`
- Create: `src/app/(dashboard)/schemas/enterprise/traits/[traitId]/{page,loading}.tsx`, `src/app/(dashboard)/schemas/[domainSlug]/traits/[traitId]/{page,loading}.tsx`, `src/app/(dashboard)/schemas/[domainSlug]/[productSlug]/traits/[traitId]/{page,loading}.tsx`
- Test: `tests/unit/components/events/channel-editor.test.tsx`, `tests/unit/components/events/trait-editor.test.tsx`, `tests/unit/app/channel-trait-pages.test.ts`

**Interfaces:**

```ts
interface ChannelPageData { channel: ChannelDetail; productId: string; crumbs: Crumb[]; listHref: string; messageOptions: MessageOption[] }
loadChannelPage({ domainSlug, productSlug, channelId }): Promise<ChannelPageData | null>
ChannelEditor(props: ChannelPageData)
interface TraitPageData { trait: TraitDetail; owner: ScopeTarget; crumbs: Crumb[]; listHref: string; entityOptions: EntityOption[] }
loadTraitPage({ domainSlug: string | null; productSlug: string | null; traitId }): Promise<TraitPageData | null>
TraitEditor(props: TraitPageData); TraitRoutePage({ domainSlug, productSlug, traitId })   // async server component
```

- [ ] **Step 1: Write the failing tests**

`tests/unit/components/events/channel-editor.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn(), updateChannelAction: vi.fn(), setChannelMessagesAction: vi.fn(), deleteChannelAction: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: h.push, refresh: h.refresh }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/channel-actions", () => ({
  updateChannelAction: h.updateChannelAction, setChannelMessagesAction: h.setChannelMessagesAction, deleteChannelAction: h.deleteChannelAction,
}));
import { ChannelEditor } from "@/features/events/channels/ChannelEditor";

const props = {
  productId: "p1",
  listHref: "/schemas/payments/checkout?tab=events&section=channels",
  crumbs: [{ label: "Channels", href: "/x" }, { label: "orders" }],
  messageOptions: [{ id: "m1", name: "OrderCreated", ownerLabel: "Payments / Checkout" }, { id: "m2", name: "Refund", ownerLabel: "Billing / Ledger" }],
  channel: {
    id: "c1", name: "orders", address: "payments.orders.v1", protocol: "kafka", format: "avro" as const, formatDialect: null,
    spec: { summary: "Orders", bindings: { kafka: { partitions: 12 } } }, allowedMessageIds: ["m1"],
    tenantId: "t", domainId: "d1", productId: "p1",
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  h.updateChannelAction.mockResolvedValue({ success: true, data: { id: "c1" } });
  h.setChannelMessagesAction.mockResolvedValue({ success: true, data: { id: "c1" } });
});
afterEach(() => cleanup());

describe("ChannelEditor", () => {
  it("saves the channel and the changed allow-list", async () => {
    render(<ChannelEditor {...props} />);
    fireEvent.change(screen.getByLabelText("Address"), { target: { value: "payments.orders.v2" } });
    fireEvent.change(screen.getByLabelText("Format"), { target: { value: "json-schema" } });
    fireEvent.click(screen.getByLabelText("Refund"));
    fireEvent.click(screen.getByTestId("channel-save"));
    await waitFor(() => expect(h.refresh).toHaveBeenCalled());
    expect(h.updateChannelAction).toHaveBeenCalledWith("c1", "p1", {
      name: "orders", address: "payments.orders.v2", protocol: "kafka", format: "json-schema", formatDialect: "draft-07",
      spec: { summary: "Orders", bindings: { kafka: { partitions: 12 } } },
    });
    expect(h.setChannelMessagesAction).toHaveBeenCalledWith("c1", "p1", ["m1", "m2"]);
  });

  it("blocks saving invalid bindings JSON and shows server errors", async () => {
    render(<ChannelEditor {...props} />);
    fireEvent.change(screen.getByLabelText("Bindings"), { target: { value: "{" } });
    fireEvent.click(screen.getByTestId("channel-save"));
    expect(h.updateChannelAction).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Bindings"), { target: { value: "" } });
    h.updateChannelAction.mockResolvedValueOnce({ success: false, error: '"orders" is already used by Entity "Orders" at Product level.' });
    fireEvent.click(screen.getByTestId("channel-save"));
    expect((await screen.findByTestId("channel-error")).textContent).toMatch(/already used/);
  });

  it("deletes after confirmation and returns to the list", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    h.deleteChannelAction.mockResolvedValue({ success: true, data: { id: "c1" } });
    render(<ChannelEditor {...props} />);
    fireEvent.click(screen.getByTestId("channel-delete"));
    await waitFor(() => expect(h.push).toHaveBeenCalledWith(props.listHref));
  });
});
```

`tests/unit/components/events/trait-editor.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn(), updateTraitAction: vi.fn(), deleteTraitAction: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: h.push, refresh: h.refresh }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/app/(dashboard)/schemas/trait-actions", () => ({ updateTraitAction: h.updateTraitAction, deleteTraitAction: h.deleteTraitAction }));
vi.mock("@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/version-actions", () => ({
  listEntityVersionsAction: vi.fn(async () => ({ success: true, versions: [{ id: "v1", label: "1.0" }] })),
}));
import { TraitEditor } from "@/features/events/traits/TraitEditor";

afterEach(() => cleanup());
const base = {
  owner: { level: "TENANT" as const, tenantId: "t" },
  crumbs: [{ label: "Traits" }],
  listHref: "/schemas/enterprise?tab=traits",
  entityOptions: [{ id: "e1", name: "CloudEventsHeaders", ownerLabel: "Enterprise", latestVersionId: "v1", latestVersionLabel: "1.0" }],
};

describe("TraitEditor", () => {
  it("saves a MESSAGE trait with its spec JSON and pinned headers entity", async () => {
    h.updateTraitAction.mockResolvedValue({ success: true, data: { id: "t1" } });
    render(
      <TraitEditor {...base} trait={{ id: "t1", name: "CloudEvents", kind: "MESSAGE", spec: { summary: "CE" }, headers: null, tenantId: "t", domainId: null, productId: null }} />
    );
    fireEvent.change(screen.getByLabelText("Headers entity"), { target: { value: "e1" } });
    fireEvent.click(screen.getByTestId("trait-save"));
    await waitFor(() => expect(h.refresh).toHaveBeenCalled());
    expect(h.updateTraitAction).toHaveBeenCalledWith("t1", base.owner, { name: "CloudEvents", spec: { summary: "CE" }, headers: { entityId: "e1", entityVersionId: "v1" } });
  });

  it("has no headers picker for OPERATION traits", () => {
    render(<TraitEditor {...base} trait={{ id: "t2", name: "Retry", kind: "OPERATION", spec: {}, headers: null, tenantId: "t", domainId: null, productId: null }} />);
    expect(screen.queryByLabelText("Headers entity")).toBeNull();
  });
});
```

`tests/unit/app/channel-trait-pages.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";

const h = vi.hoisted(() => ({ loadChannelPage: vi.fn(), loadTraitPage: vi.fn() }));
vi.mock("next/navigation", () => ({ notFound: vi.fn(() => { throw new Error("not found"); }) }));
vi.mock("@/features/events/channels/load-channel-page", () => ({ loadChannelPage: h.loadChannelPage }));
vi.mock("@/features/events/traits/load-trait-page", () => ({ loadTraitPage: h.loadTraitPage }));
vi.mock("@/features/events/channels/ChannelEditor", () => ({ ChannelEditor: () => null }));
vi.mock("@/features/events/traits/TraitEditor", () => ({ TraitEditor: () => null }));

import ChannelPage from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/channels/[channelId]/page";
import DomainTraitPage from "@/app/(dashboard)/schemas/[domainSlug]/traits/[traitId]/page";
import EnterpriseTraitPage from "@/app/(dashboard)/schemas/enterprise/traits/[traitId]/page";
import { TraitRoutePage } from "@/features/events/traits/TraitRoutePage";

describe("channel + trait routes", () => {
  it("404s when the channel is not in the addressed product", async () => {
    h.loadChannelPage.mockResolvedValue(null);
    await expect(ChannelPage({ params: Promise.resolve({ domainSlug: "payments", productSlug: "fraud", channelId: "c1" }) })).rejects.toThrow("not found");
    expect(h.loadChannelPage).toHaveBeenCalledWith({ domainSlug: "payments", productSlug: "fraud", channelId: "c1" });
  });

  it("routes every trait level through TraitRoutePage with the right slugs", async () => {
    const domain = await DomainTraitPage({ params: Promise.resolve({ domainSlug: "payments", traitId: "t1" }) });
    expect(domain.props).toEqual({ domainSlug: "payments", productSlug: null, traitId: "t1" });
    const enterprise = await EnterpriseTraitPage({ params: Promise.resolve({ traitId: "t2" }) });
    expect(enterprise.props).toEqual({ domainSlug: null, productSlug: null, traitId: "t2" });
    h.loadTraitPage.mockResolvedValue(null);
    await expect(TraitRoutePage({ domainSlug: null, productSlug: null, traitId: "t2" })).rejects.toThrow("not found");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/unit/components/events/channel-editor.test.tsx tests/unit/components/events/trait-editor.test.tsx tests/unit/app/channel-trait-pages.test.ts`
Expected: FAIL — missing modules.

- [ ] **Step 3: Loaders**

```ts
// src/features/events/channels/load-channel-page.ts
import { prisma } from "@/lib/db";
import { assetHref } from "@/lib/navigation/asset-href";
import type { ChannelDetail } from "@/lib/events/types";
import { CHANNEL_SELECT, toChannelDetail } from "@/services/events/channel.service";
import { productCrumbs } from "@/features/events/crumbs";
import { loadMessageOptions, type MessageOption } from "@/features/events/load-options";
import { resolveProductRoute } from "@/features/events/route-scope";
import type { Crumb } from "@/features/events/shared/EventBreadcrumb";

export interface ChannelPageData {
  channel: ChannelDetail;
  productId: string;
  crumbs: Crumb[];
  listHref: string;
  messageOptions: MessageOption[];
}

/** null → 404 (unknown product, or the channel belongs to another product). */
export async function loadChannelPage(params: { domainSlug: string; productSlug: string; channelId: string }): Promise<ChannelPageData | null> {
  const route = await resolveProductRoute(params.domainSlug, params.productSlug);
  if (!route) return null;
  const row = await prisma.channel.findFirst({ where: { id: params.channelId, productId: route.product.id }, select: CHANNEL_SELECT });
  if (!row) return null;
  const listHref = assetHref({ kind: "events", domainSlug: route.domain.slug, productSlug: route.product.slug, section: "channels" });
  return {
    channel: toChannelDetail(row),
    productId: route.product.id,
    listHref,
    crumbs: productCrumbs(route, { label: "Channels", href: listHref }, row.name),
    messageOptions: await loadMessageOptions(route.tenantId),
  };
}
```

```ts
// src/features/events/traits/load-trait-page.ts
import { prisma } from "@/lib/db";
import type { ScopeTarget } from "@/lib/asset-scope";
import { assetHref } from "@/lib/navigation/asset-href";
import type { TraitDetail } from "@/lib/events/types";
import { TRAIT_SELECT, toTraitDetail } from "@/services/events/trait.service";
import { levelCrumbs } from "@/features/events/crumbs";
import { loadEntityOptions } from "@/features/events/load-options";
import { resolveLevelRoute } from "@/features/events/route-scope";
import type { Crumb } from "@/features/events/shared/EventBreadcrumb";
import type { EntityOption } from "@/features/events/shared/EntityPinPicker";

export interface TraitPageData {
  trait: TraitDetail;
  owner: ScopeTarget;
  crumbs: Crumb[];
  listHref: string;
  entityOptions: EntityOption[];
}

/** A trait is only reachable under its own level's URL (assetHref); anything else 404s. */
export async function loadTraitPage(params: { domainSlug: string | null; productSlug: string | null; traitId: string }): Promise<TraitPageData | null> {
  const route = await resolveLevelRoute(params.domainSlug, params.productSlug);
  if (!route) return null;
  const row = await prisma.trait.findFirst({
    where: { id: params.traitId, tenantId: route.scope.tenantId, domainId: route.scope.domainId, productId: route.scope.productId },
    select: TRAIT_SELECT,
  });
  if (!row) return null;
  const listHref = assetHref({ kind: "traits", domainSlug: route.domain?.slug ?? null, productSlug: route.product?.slug ?? null });
  return {
    trait: toTraitDetail(row),
    owner: route.target,
    listHref,
    crumbs: levelCrumbs(route, { label: "Traits", href: listHref }, row.name),
    entityOptions: await loadEntityOptions(route.scope.tenantId),
  };
}
```

- [ ] **Step 4: `ChannelEditor`**

```tsx
// src/features/events/channels/ChannelEditor.tsx
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Radio, Save, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  deleteChannelAction, setChannelMessagesAction, updateChannelAction,
} from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/channel-actions";
import { formatJsonText, JSON_SCHEMA_DIALECTS, KNOWN_PROTOCOLS, parseJsonObjectText, PAYLOAD_FORMATS } from "@/lib/events/inputs";
import type { ChannelSpec, JsonObject } from "@/lib/events/types";
import { EventBreadcrumb } from "@/features/events/shared/EventBreadcrumb";
import { JsonField } from "@/features/events/shared/JsonField";
import type { ChannelPageData } from "./load-channel-page";

const selectClass = "w-full rounded-md border border-border bg-background px-space-2 py-1.5 text-body-small";
const sameIds = (a: string[], b: string[]) => a.length === b.length && [...a].sort().join() === [...b].sort().join();

function compact<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined && v !== "")) as T;
}

export function ChannelEditor({ channel, productId, crumbs, listHref, messageOptions }: ChannelPageData) {
  const router = useRouter();
  const [name, setName] = useState(channel.name);
  const [address, setAddress] = useState(channel.address ?? "");
  const [protocol, setProtocol] = useState(channel.protocol);
  const [format, setFormat] = useState<string>(channel.format);
  const [dialect, setDialect] = useState<string>(channel.formatDialect ?? "draft-07");
  const [title, setTitle] = useState(channel.spec.title ?? "");
  const [summary, setSummary] = useState(channel.spec.summary ?? "");
  const [description, setDescription] = useState(channel.spec.description ?? "");
  const [parametersText, setParametersText] = useState(formatJsonText(channel.spec.parameters));
  const [bindingsText, setBindingsText] = useState(formatJsonText(channel.spec.bindings));
  const [allowed, setAllowed] = useState<string[]>(channel.allowedMessageIds);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    const parameters = parseJsonObjectText(parametersText, "Parameters");
    const bindings = parseJsonObjectText(bindingsText, "Bindings");
    if (!parameters.success) return setError(parameters.error.message);
    if (!bindings.success) return setError(bindings.error.message);
    setSaving(true);
    setError(null);
    const spec: ChannelSpec = compact({
      title, summary, description,
      parameters: parameters.data as Record<string, JsonObject> | undefined,
      bindings: bindings.data,
      tags: channel.spec.tags,
      externalDocs: channel.spec.externalDocs,
    });
    const saved = await updateChannelAction(channel.id, productId, {
      name, address: address.trim() || null, protocol, format, formatDialect: format === "json-schema" ? dialect : null, spec,
    });
    if (saved.success && !sameIds(allowed, channel.allowedMessageIds)) {
      const messages = await setChannelMessagesAction(channel.id, productId, allowed);
      if (!messages.success) {
        setSaving(false);
        return setError(messages.error);
      }
    }
    setSaving(false);
    if (!saved.success) return setError(saved.error);
    toast.success("Channel saved");
    router.refresh();
  }

  async function remove() {
    if (!window.confirm(`Delete channel "${channel.name}"? Draft event specs that use it will report it as unresolved.`)) return;
    const r = await deleteChannelAction(channel.id, productId);
    if (!r.success) return setError(r.error);
    router.push(listHref);
  }

  const toggle = (id: string) => setAllowed((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  return (
    <div className="animate-auth-fade-up space-y-space-6">
      <EventBreadcrumb crumbs={crumbs} />
      <div className="flex items-center justify-between">
        <h1 className="flex items-center gap-space-2 text-display text-foreground"><Radio className="w-6 h-6" /> {channel.name}</h1>
        <div className="flex gap-space-2">
          <Button variant="outline" onClick={remove} data-testid="channel-delete" className="gap-1.5 text-muted-foreground hover:text-destructive"><Trash2 className="w-4 h-4" /> Delete</Button>
          <Button onClick={save} disabled={saving} data-testid="channel-save" className="gap-1.5">{saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />} Save</Button>
        </div>
      </div>
      {error && <p role="alert" data-testid="channel-error" className="text-body-small text-destructive">{error}</p>}

      <section className="grid grid-cols-1 gap-space-4 md:grid-cols-2">
        <label className="space-y-space-1"><span className="block text-caption text-muted-foreground">Name</span><Input aria-label="Name" value={name} onChange={(e) => setName(e.target.value)} /></label>
        <label className="space-y-space-1"><span className="block text-caption text-muted-foreground">Address (topic / queue; {"{param}"} allowed)</span><Input aria-label="Address" value={address} onChange={(e) => setAddress(e.target.value)} /></label>
        <label className="space-y-space-1">
          <span className="block text-caption text-muted-foreground">Protocol</span>
          <Input aria-label="Protocol" list="channel-protocols" value={protocol} onChange={(e) => setProtocol(e.target.value)} />
          <datalist id="channel-protocols">{KNOWN_PROTOCOLS.map((p) => <option key={p} value={p} />)}</datalist>
        </label>
        <div className="grid grid-cols-2 gap-space-2">
          <label className="space-y-space-1">
            <span className="block text-caption text-muted-foreground">Format profile</span>
            <select aria-label="Format" className={selectClass} value={format} onChange={(e) => setFormat(e.target.value)}>
              {PAYLOAD_FORMATS.map((f) => <option key={f} value={f}>{f}</option>)}
            </select>
          </label>
          {format === "json-schema" && (
            <label className="space-y-space-1">
              <span className="block text-caption text-muted-foreground">Dialect</span>
              <select aria-label="Dialect" className={selectClass} value={dialect} onChange={(e) => setDialect(e.target.value)}>
                {JSON_SCHEMA_DIALECTS.map((d) => <option key={d} value={d}>{d}</option>)}
              </select>
            </label>
          )}
        </div>
        <label className="space-y-space-1"><span className="block text-caption text-muted-foreground">Title</span><Input aria-label="Title" value={title} onChange={(e) => setTitle(e.target.value)} /></label>
        <label className="space-y-space-1"><span className="block text-caption text-muted-foreground">Summary</span><Input aria-label="Summary" value={summary} onChange={(e) => setSummary(e.target.value)} /></label>
        <label className="space-y-space-1 md:col-span-2"><span className="block text-caption text-muted-foreground">Description</span><Textarea aria-label="Description" rows={3} value={description} onChange={(e) => setDescription(e.target.value)} /></label>
        <JsonField id="channel-parameters" label="Parameters" mode="object" value={parametersText} onChange={setParametersText} placeholder='{ "region": { "description": "…" } }' />
        <JsonField id="channel-bindings" label="Bindings" mode="object" value={bindingsText} onChange={setBindingsText} placeholder='{ "kafka": { "partitions": 12 } }' />
      </section>

      <section className="space-y-space-2">
        <h2 className="text-heading-2 text-foreground">Allowed messages</h2>
        <p className="text-caption text-muted-foreground">Messages that may travel on this channel (any product). Event specs pin versions per operation.</p>
        <div className="grid grid-cols-1 gap-space-1 md:grid-cols-2">
          {messageOptions.map((m) => (
            <label key={m.id} className="flex items-center gap-space-2 text-body-small">
              <input type="checkbox" aria-label={m.name} checked={allowed.includes(m.id)} onChange={() => toggle(m.id)} />
              {m.name} <span className="text-caption text-muted-foreground">{m.ownerLabel}</span>
            </label>
          ))}
        </div>
      </section>
    </div>
  );
}
```

- [ ] **Step 5: `TraitEditor` + `TraitRoutePage`**

```tsx
// src/features/events/traits/TraitEditor.tsx
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Puzzle, Save, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { deleteTraitAction, updateTraitAction } from "@/app/(dashboard)/schemas/trait-actions";
import { formatJsonText, parseJsonObjectText } from "@/lib/events/inputs";
import type { EntityPin } from "@/lib/events/types";
import { EntityPinPicker } from "@/features/events/shared/EntityPinPicker";
import { EventBreadcrumb } from "@/features/events/shared/EventBreadcrumb";
import { JsonField } from "@/features/events/shared/JsonField";
import type { TraitPageData } from "./load-trait-page";

export function TraitEditor({ trait, owner, crumbs, listHref, entityOptions }: TraitPageData) {
  const router = useRouter();
  const [name, setName] = useState(trait.name);
  const [specText, setSpecText] = useState(formatJsonText(trait.spec) || "{}");
  const [headers, setHeaders] = useState<EntityPin | null>(trait.headers);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    const spec = parseJsonObjectText(specText, "Trait object");
    if (!spec.success) return setError(spec.error.message);
    setSaving(true);
    setError(null);
    const r = await updateTraitAction(trait.id, owner, { name, spec: spec.data ?? {}, headers: trait.kind === "MESSAGE" ? headers : null });
    setSaving(false);
    if (!r.success) return setError(r.error);
    toast.success("Trait saved");
    router.refresh();
  }

  async function remove() {
    if (!window.confirm(`Delete trait "${trait.name}"?`)) return;
    const r = await deleteTraitAction(trait.id, owner);
    if (!r.success) return setError(r.error);
    router.push(listHref);
  }

  return (
    <div className="animate-auth-fade-up space-y-space-6">
      <EventBreadcrumb crumbs={crumbs} />
      <div className="flex items-center justify-between">
        <h1 className="flex items-center gap-space-2 text-display text-foreground">
          <Puzzle className="w-6 h-6" /> {trait.name} <Badge variant="secondary">{trait.kind === "MESSAGE" ? "message trait" : "operation trait"}</Badge>
        </h1>
        <div className="flex gap-space-2">
          <Button variant="outline" onClick={remove} data-testid="trait-delete" className="gap-1.5 text-muted-foreground hover:text-destructive"><Trash2 className="w-4 h-4" /> Delete</Button>
          <Button onClick={save} disabled={saving} data-testid="trait-save" className="gap-1.5">{saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />} Save</Button>
        </div>
      </div>
      {error && <p role="alert" className="text-body-small text-destructive">{error}</p>}
      <label className="block max-w-md space-y-space-1">
        <span className="block text-caption text-muted-foreground">Name</span>
        <Input aria-label="Name" value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      {trait.kind === "MESSAGE" && (
        <EntityPinPicker
          id="trait-headers" label="Headers" optional entities={entityOptions} value={headers} onChange={setHeaders}
          hint="Rendered as a JSON Schema object schema (AsyncAPI requires object headers)."
        />
      )}
      <JsonField
        id="trait-spec" label="Trait object (AsyncAPI fields, e.g. summary, correlationId, bindings)" mode="object" rows={10}
        value={specText} onChange={setSpecText}
      />
    </div>
  );
}
```

```tsx
// src/features/events/traits/TraitRoutePage.tsx
import { notFound } from "next/navigation";
import { TraitEditor } from "./TraitEditor";
import { loadTraitPage } from "./load-trait-page";

/** One server component for the three trait URLs (Enterprise / domain / product, spec §4.5). */
export async function TraitRoutePage({ domainSlug, productSlug, traitId }: { domainSlug: string | null; productSlug: string | null; traitId: string }) {
  const data = await loadTraitPage({ domainSlug, productSlug, traitId });
  if (!data) notFound();
  return <TraitEditor {...data} />;
}
```

- [ ] **Step 6: Routes + loading skeletons**

```tsx
// src/app/(dashboard)/schemas/[domainSlug]/[productSlug]/channels/[channelId]/page.tsx
import { notFound } from "next/navigation";
import { ChannelEditor } from "@/features/events/channels/ChannelEditor";
import { loadChannelPage } from "@/features/events/channels/load-channel-page";

export default async function ChannelPage({ params }: { params: Promise<{ domainSlug: string; productSlug: string; channelId: string }> }) {
  const { domainSlug, productSlug, channelId } = await params;
  const data = await loadChannelPage({ domainSlug, productSlug, channelId });
  if (!data) notFound();
  return <ChannelEditor {...data} />;
}
```

```tsx
// src/app/(dashboard)/schemas/enterprise/traits/[traitId]/page.tsx
import { TraitRoutePage } from "@/features/events/traits/TraitRoutePage";

export default async function EnterpriseTraitPage({ params }: { params: Promise<{ traitId: string }> }) {
  const { traitId } = await params;
  return <TraitRoutePage domainSlug={null} productSlug={null} traitId={traitId} />;
}
```

```tsx
// src/app/(dashboard)/schemas/[domainSlug]/traits/[traitId]/page.tsx
import { TraitRoutePage } from "@/features/events/traits/TraitRoutePage";

export default async function DomainTraitPage({ params }: { params: Promise<{ domainSlug: string; traitId: string }> }) {
  const { domainSlug, traitId } = await params;
  return <TraitRoutePage domainSlug={domainSlug} productSlug={null} traitId={traitId} />;
}
```

```tsx
// src/app/(dashboard)/schemas/[domainSlug]/[productSlug]/traits/[traitId]/page.tsx
import { TraitRoutePage } from "@/features/events/traits/TraitRoutePage";

export default async function ProductTraitPage({ params }: { params: Promise<{ domainSlug: string; productSlug: string; traitId: string }> }) {
  const { domainSlug, productSlug, traitId } = await params;
  return <TraitRoutePage domainSlug={domainSlug} productSlug={productSlug} traitId={traitId} />;
}
```

Each of the four route folders also gets the same `loading.tsx`:

```tsx
import { PageSkeleton } from "@/components/layout/PageSkeleton";

export default function Loading() {
  return <PageSkeleton variant="entity" />;
}
```

- [ ] **Step 7: Run + type check + commit**

Run: `npx vitest run tests/unit/components/events/channel-editor.test.tsx tests/unit/components/events/trait-editor.test.tsx tests/unit/app/channel-trait-pages.test.ts && npx tsc --noEmit`
Expected: PASS; no type errors.

```bash
git add src/features/events/channels src/features/events/traits "src/app/(dashboard)/schemas/[domainSlug]/[productSlug]/channels" "src/app/(dashboard)/schemas/enterprise/traits" "src/app/(dashboard)/schemas/[domainSlug]/traits" "src/app/(dashboard)/schemas/[domainSlug]/[productSlug]/traits" tests/unit/components/events/channel-editor.test.tsx tests/unit/components/events/trait-editor.test.tsx tests/unit/app/channel-trait-pages.test.ts
git commit -m "feat(18.6): channel and trait pages (format profile, protocol, raw JSON bindings, headers pin, allow-list)"
```

---
### Task 16: Message page — editor, pins, versions + publish, Used by (Stories 18.6 / 18.3 UI / 18.9) — Wave 5

**Files:**
- Create: `src/features/events/messages/load-message-page.ts`, `src/features/events/messages/MessageEditor.tsx`, `src/features/events/messages/MessagePage.tsx`
- Create: `src/app/(dashboard)/schemas/[domainSlug]/[productSlug]/messages/[messageId]/page.tsx`, `.../messages/[messageId]/loading.tsx`
- Test: `tests/unit/components/events/message-editor.test.tsx`, `tests/unit/components/events/message-page.test.tsx`

**Interfaces:**

```ts
interface MessagePageData {
  message: MessageDetail; productId: string; domainSlug: string; productSlug: string; crumbs: Crumb[]; listHref: string;
  entityOptions: EntityOption[]; traitOptions: TraitOption[]; versions: EventVersionSummary[];
  viewing: { label: string; resolvedSpec: MessageResolvedSpec } | null;
}
loadMessagePage({ domainSlug, productSlug, messageId, version?: string }): Promise<MessagePageData | null>   // unknown ?version → null (404)
MessageEditor({ message, productId, listHref, entityOptions, traitOptions })
MessagePage(props: MessagePageData)
```

- [ ] **Step 1: Write the failing tests**

`tests/unit/components/events/message-editor.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn(), updateMessageAction: vi.fn(), deleteMessageAction: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: h.push, refresh: h.refresh }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/message-actions", () => ({ updateMessageAction: h.updateMessageAction, deleteMessageAction: h.deleteMessageAction }));
vi.mock("@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/version-actions", () => ({
  listEntityVersionsAction: vi.fn(async (id: string) => ({ success: true, versions: id === "e1" ? [{ id: "v21", label: "2.1" }, { id: "v20", label: "2.0" }] : [{ id: "vk", label: "1.0" }] })),
}));
import { MessageEditor } from "@/features/events/messages/MessageEditor";

const props = {
  productId: "p1",
  listHref: "/schemas/payments/checkout?tab=events&section=messages",
  entityOptions: [
    { id: "e1", name: "Order", ownerLabel: "Payments / Checkout", latestVersionId: "v21", latestVersionLabel: "2.1" },
    { id: "e2", name: "OrderKey", ownerLabel: "Payments / Checkout", latestVersionId: "vk", latestVersionLabel: "1.0" },
  ],
  traitOptions: [{ id: "t1", name: "CloudEvents", ownerLabel: "Enterprise" }],
  message: {
    id: "m1", name: "OrderCreated", spec: { contentType: "avro/binary", traitIds: [] },
    payload: { entityId: "e1", entityVersionId: "v20" }, headers: null, key: null,
    latestVersionLabel: null, hasUnpublishedChanges: true, tenantId: "t", domainId: "d1", productId: "p1",
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  h.updateMessageAction.mockResolvedValue({ success: true, data: { id: "m1" } });
});
afterEach(() => cleanup());

describe("MessageEditor", () => {
  it("saves AsyncAPI message fields, pins, traits, bindings and examples", async () => {
    render(<MessageEditor {...props} />);
    expect(await screen.findByTestId("payload-newer")).toBeDefined(); // pinned 2.0, latest 2.1
    fireEvent.change(screen.getByLabelText("Summary"), { target: { value: "An order was placed" } });
    fireEvent.change(screen.getByLabelText("Correlation ID location"), { target: { value: "$message.header#/ce_id" } });
    fireEvent.change(screen.getByLabelText("Kafka key entity"), { target: { value: "e2" } });
    fireEvent.click(screen.getByLabelText("CloudEvents"));
    fireEvent.change(screen.getByLabelText("Examples"), { target: { value: '[{"payload":{"id":"1"}}]' } });
    fireEvent.click(screen.getByTestId("message-save"));
    await waitFor(() => expect(h.refresh).toHaveBeenCalled());
    expect(h.updateMessageAction).toHaveBeenCalledWith("m1", "p1", {
      name: "OrderCreated",
      spec: {
        summary: "An order was placed", contentType: "avro/binary", correlationId: { location: "$message.header#/ce_id" },
        examples: [{ payload: { id: "1" } }], traitIds: ["t1"],
      },
      payload: { entityId: "e1", entityVersionId: "v20" },
      headers: null,
      key: { entityId: "e2", entityVersionId: "vk" },
    });
  });

  it("refuses invalid example JSON and shows validation problems from the server", async () => {
    render(<MessageEditor {...props} />);
    fireEvent.change(screen.getByLabelText("Examples"), { target: { value: "{}" } });
    fireEvent.click(screen.getByTestId("message-save"));
    expect(h.updateMessageAction).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Examples"), { target: { value: "" } });
    h.updateMessageAction.mockResolvedValueOnce({ success: false, error: "bad", code: "VALIDATION_ERROR", details: { problems: ['Trait "x" not found', "Payload: …"] } });
    fireEvent.click(screen.getByTestId("message-save"));
    expect(await screen.findByText('Trait "x" not found')).toBeDefined();
  });
});
```

`tests/unit/components/events/message-page.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("@/features/events/messages/MessageEditor", () => ({ MessageEditor: () => <div data-testid="message-editor" /> }));
vi.mock("@/features/events/shared/UsedByPanel", () => ({ UsedByPanel: (p: { subject: unknown }) => <div data-testid="used-by">{JSON.stringify(p.subject)}</div> }));
vi.mock("@/features/events/shared/PublishVersionButton", () => ({ PublishVersionButton: (p: { subjectName: string }) => <button data-testid="publish">{p.subjectName}</button> }));
vi.mock("@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/message-version-actions", () => ({ getMessagePublishPreviewAction: vi.fn(), publishMessageAction: vi.fn() }));
import { MessagePage } from "@/features/events/messages/MessagePage";

afterEach(() => cleanup());
const base = {
  productId: "p1", domainSlug: "payments", productSlug: "checkout", crumbs: [{ label: "Messages" }], listHref: "/l",
  entityOptions: [], traitOptions: [],
  message: { id: "m1", name: "OrderCreated", spec: { traitIds: [] }, payload: { entityId: "e1", entityVersionId: "v1" }, headers: null, key: null, latestVersionLabel: "1.3", hasUnpublishedChanges: true, tenantId: "t", domainId: "d1", productId: "p1" },
  versions: [{ id: "mv1", major: 1, minor: 3, label: "1.3", sequence: 4, changeKind: "MINOR" as const, changeSummary: null, publishedByName: "Ada", publishedAt: "2026-10-14T00:00:00.000Z" }],
};

describe("MessagePage", () => {
  it("shows the draft editor, publish button, versions with deep links and the Used-by panel", () => {
    render(<MessagePage {...base} viewing={null} />);
    expect(screen.getByTestId("message-editor")).toBeDefined();
    expect(screen.getByTestId("publish").textContent).toBe("OrderCreated");
    expect(screen.getByRole("link", { name: "v1.3" }).getAttribute("href")).toBe("/schemas/payments/checkout/messages/m1?version=1.3");
    expect(screen.getByText("unpublished changes")).toBeDefined();
    expect(screen.getByTestId("used-by").textContent).toBe(JSON.stringify({ kind: "message", messageId: "m1" }));
  });

  it("shows a published version read-only", () => {
    render(
      <MessagePage
        {...base}
        viewing={{ label: "1.3", resolvedSpec: { name: "OrderCreated", spec: { traitIds: [] }, payload: { entityId: "e1", entityName: "Order", entityVersionId: "v1", label: "2.1", major: 2 }, headers: null, key: null } }}
      />
    );
    expect(screen.queryByTestId("message-editor")).toBeNull();
    expect(screen.getByText(/Viewing v1\.3/)).toBeDefined();
    expect(screen.getByText(/Order v2\.1/)).toBeDefined();
    expect(screen.getByRole("link", { name: "Back to draft" }).getAttribute("href")).toBe("/schemas/payments/checkout/messages/m1");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/unit/components/events/message-editor.test.tsx tests/unit/components/events/message-page.test.tsx`
Expected: FAIL — missing modules.

- [ ] **Step 3: Loader** (`src/features/events/messages/load-message-page.ts`)

```ts
import { prisma } from "@/lib/db";
import { parseVersionLabel } from "@/lib/entity-versioning/version-math";
import { assetHref } from "@/lib/navigation/asset-href";
import type { EventVersionSummary, MessageDetail, MessageResolvedSpec } from "@/lib/events/types";
import { MESSAGE_SELECT, toMessageDetail } from "@/services/events/message.service";
import { toEventVersionSummary, VERSION_SUMMARY_SELECT } from "@/services/events/version-summary";
import { productCrumbs } from "@/features/events/crumbs";
import { loadEntityOptions, loadTraitOptions, type TraitOption } from "@/features/events/load-options";
import { resolveProductRoute } from "@/features/events/route-scope";
import type { Crumb } from "@/features/events/shared/EventBreadcrumb";
import type { EntityOption } from "@/features/events/shared/EntityPinPicker";

export interface MessagePageData {
  message: MessageDetail;
  productId: string;
  domainSlug: string;
  productSlug: string;
  crumbs: Crumb[];
  listHref: string;
  entityOptions: EntityOption[];
  traitOptions: TraitOption[];
  versions: EventVersionSummary[];
  /** `?version=1.3` — the frozen MessageVersion, read-only. */
  viewing: { label: string; resolvedSpec: MessageResolvedSpec } | null;
}

export async function loadMessagePage(params: { domainSlug: string; productSlug: string; messageId: string; version?: string }): Promise<MessagePageData | null> {
  const route = await resolveProductRoute(params.domainSlug, params.productSlug);
  if (!route) return null;
  const row = await prisma.message.findFirst({ where: { id: params.messageId, productId: route.product.id }, select: MESSAGE_SELECT });
  if (!row) return null;

  let viewing: MessagePageData["viewing"] = null;
  if (params.version) {
    const label = parseVersionLabel(params.version);
    if (!label.success) return null;
    const v = await prisma.messageVersion.findUnique({
      where: { messageId_major_minor: { messageId: row.id, major: label.data.major, minor: label.data.minor } },
      select: { resolvedSpec: true },
    });
    if (!v) return null;
    viewing = { label: `${label.data.major}.${label.data.minor}`, resolvedSpec: v.resolvedSpec as unknown as MessageResolvedSpec };
  }

  const scope = { tenantId: route.tenantId, domainId: route.domain.id, productId: route.product.id };
  const [versions, entityOptions, traitOptions] = await Promise.all([
    prisma.messageVersion.findMany({ where: { messageId: row.id }, orderBy: { sequence: "desc" }, select: VERSION_SUMMARY_SELECT }),
    loadEntityOptions(route.tenantId),
    loadTraitOptions(scope, "MESSAGE"),
  ]);
  const listHref = assetHref({ kind: "events", domainSlug: route.domain.slug, productSlug: route.product.slug, section: "messages" });
  return {
    message: toMessageDetail(row),
    productId: route.product.id,
    domainSlug: route.domain.slug,
    productSlug: route.product.slug,
    crumbs: productCrumbs(route, { label: "Messages", href: listHref }, row.name),
    listHref,
    entityOptions,
    traitOptions,
    versions: versions.map(toEventVersionSummary),
    viewing,
  };
}
```

- [ ] **Step 4: `MessageEditor`**

```tsx
// src/features/events/messages/MessageEditor.tsx
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Save, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { deleteMessageAction, updateMessageAction } from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/message-actions";
import { formatJsonText, parseJsonObjectArrayText, parseJsonObjectText } from "@/lib/events/inputs";
import type { EntityPin, MessageDetail, MessageSpec } from "@/lib/events/types";
import type { TraitOption } from "@/features/events/load-options";
import { EntityPinPicker, type EntityOption } from "@/features/events/shared/EntityPinPicker";
import { JsonField } from "@/features/events/shared/JsonField";

function compact<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined && v !== "")) as T;
}

export function MessageEditor({
  message, productId, listHref, entityOptions, traitOptions,
}: {
  message: MessageDetail;
  productId: string;
  listHref: string;
  entityOptions: EntityOption[];
  traitOptions: TraitOption[];
}) {
  const router = useRouter();
  const s = message.spec;
  const [name, setName] = useState(message.name);
  const [title, setTitle] = useState(s.title ?? "");
  const [summary, setSummary] = useState(s.summary ?? "");
  const [description, setDescription] = useState(s.description ?? "");
  const [contentType, setContentType] = useState(s.contentType ?? "");
  const [correlation, setCorrelation] = useState(typeof s.correlationId?.location === "string" ? s.correlationId.location : "");
  const [payload, setPayload] = useState<EntityPin | null>(message.payload);
  const [headers, setHeaders] = useState<EntityPin | null>(message.headers);
  const [key, setKey] = useState<EntityPin | null>(message.key);
  const [traitIds, setTraitIds] = useState<string[]>(s.traitIds);
  const [bindingsText, setBindingsText] = useState(formatJsonText(s.bindings));
  const [examplesText, setExamplesText] = useState(formatJsonText(s.examples));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [problems, setProblems] = useState<string[]>([]);

  async function save() {
    const bindings = parseJsonObjectText(bindingsText, "Bindings");
    const examples = parseJsonObjectArrayText(examplesText, "Examples");
    if (!bindings.success) return setError(bindings.error.message);
    if (!examples.success) return setError(examples.error.message);
    if (!payload) return setError("A payload entity is required");
    setSaving(true);
    setError(null);
    setProblems([]);
    const spec: MessageSpec = {
      ...compact({
        title, summary, description, contentType,
        correlationId: correlation.trim() ? { ...(s.correlationId ?? {}), location: correlation.trim() } : undefined,
        tags: s.tags, externalDocs: s.externalDocs, bindings: bindings.data, examples: examples.data,
      }),
      traitIds,
    };
    const r = await updateMessageAction(message.id, productId, { name, spec, payload, headers, key });
    setSaving(false);
    if (!r.success) {
      setError(r.error);
      const list = (r.details as { problems?: unknown } | undefined)?.problems;
      setProblems(Array.isArray(list) ? list.filter((p): p is string => typeof p === "string") : []);
      return;
    }
    toast.success("Message saved");
    router.refresh();
  }

  async function remove() {
    if (!window.confirm(`Delete message "${message.name}"?`)) return;
    const r = await deleteMessageAction(message.id, productId);
    if (!r.success) return setError(r.error);
    router.push(listHref);
  }

  const toggleTrait = (id: string) => setTraitIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  const text = (label: string, value: string, onChange: (v: string) => void, placeholder?: string) => (
    <label className="space-y-space-1">
      <span className="block text-caption text-muted-foreground">{label}</span>
      <Input aria-label={label} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
    </label>
  );

  return (
    <div className="space-y-space-6" data-testid="message-editor-form">
      <div className="flex justify-end gap-space-2">
        <Button variant="outline" onClick={remove} data-testid="message-delete" className="gap-1.5 text-muted-foreground hover:text-destructive"><Trash2 className="w-4 h-4" /> Delete</Button>
        <Button onClick={save} disabled={saving} data-testid="message-save" className="gap-1.5">{saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />} Save draft</Button>
      </div>
      {error && (
        <div role="alert" className="text-body-small text-destructive">
          <p>{error}</p>
          {problems.length > 0 && <ul className="list-disc pl-5">{problems.map((p) => <li key={p}>{p}</li>)}</ul>}
        </div>
      )}

      <section className="grid grid-cols-1 gap-space-4 md:grid-cols-2">
        {text("Name", name, setName)}
        {text("Title", title, setTitle)}
        {text("Summary", summary, setSummary)}
        {text("Content type", contentType, setContentType, "defaults from the channel format (avro/binary, application/json, …)")}
        {text("Correlation ID location", correlation, setCorrelation, "$message.header#/ce_id")}
        <label className="space-y-space-1 md:col-span-2">
          <span className="block text-caption text-muted-foreground">Description</span>
          <Textarea aria-label="Description" rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
        </label>
      </section>

      <section className="grid grid-cols-1 gap-space-4 md:grid-cols-3">
        <EntityPinPicker id="payload" label="Payload" entities={entityOptions} value={payload} onChange={setPayload} />
        <EntityPinPicker id="headers" label="Headers" optional entities={entityOptions} value={headers} onChange={setHeaders} hint="Rendered as a JSON Schema object." />
        <EntityPinPicker id="key" label="Kafka key" optional entities={entityOptions} value={key} onChange={setKey} hint="Emitted only on Kafka channels (Avro on Avro channels, else JSON Schema)." />
      </section>

      <section className="space-y-space-2">
        <h3 className="text-heading-3 text-foreground">Traits</h3>
        {traitOptions.length === 0 && <p className="text-caption text-muted-foreground">No message traits visible from this product.</p>}
        <div className="flex flex-wrap gap-space-4">
          {traitOptions.map((t) => (
            <label key={t.id} className="flex items-center gap-space-2 text-body-small">
              <input type="checkbox" aria-label={t.name} checked={traitIds.includes(t.id)} onChange={() => toggleTrait(t.id)} />
              {t.name} <span className="text-caption text-muted-foreground">{t.ownerLabel}</span>
            </label>
          ))}
        </div>
      </section>

      <section className="grid grid-cols-1 gap-space-4 md:grid-cols-2">
        <JsonField id="message-bindings" label="Bindings" mode="object" value={bindingsText} onChange={setBindingsText} placeholder='{ "kafka": { "schemaIdLocation": "header" } }' />
        <JsonField id="message-examples" label="Examples" mode="array" value={examplesText} onChange={setExamplesText} placeholder='[{ "payload": { } }]' />
      </section>
    </div>
  );
}
```

- [ ] **Step 5: `MessagePage`**

```tsx
// src/features/events/messages/MessagePage.tsx
"use client";

import Link from "next/link";
import { Mail } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  getMessagePublishPreviewAction, publishMessageAction,
} from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/message-version-actions";
import { assetHref } from "@/lib/navigation/asset-href";
import { EventBreadcrumb } from "@/features/events/shared/EventBreadcrumb";
import { EventVersionList } from "@/features/events/shared/EventVersionList";
import { PublishVersionButton } from "@/features/events/shared/PublishVersionButton";
import { UsedByPanel } from "@/features/events/shared/UsedByPanel";
import { MessageEditor } from "./MessageEditor";
import type { MessagePageData } from "./load-message-page";

export function MessagePage({
  message, productId, domainSlug, productSlug, crumbs, listHref, entityOptions, traitOptions, versions, viewing,
}: MessagePageData) {
  const draftHref = assetHref({ kind: "message", id: message.id, domainSlug, productSlug });
  const versionHref = (label: string) => assetHref({ kind: "message", id: message.id, domainSlug, productSlug }, { version: label });
  const pins = viewing ? [viewing.resolvedSpec.payload, viewing.resolvedSpec.headers, viewing.resolvedSpec.key] : [];

  return (
    <div className="animate-auth-fade-up space-y-space-6">
      <EventBreadcrumb crumbs={crumbs} />
      <div className="flex flex-wrap items-center justify-between gap-space-3">
        <div className="flex items-center gap-space-2">
          <Mail className="w-6 h-6" />
          <h1 className="text-display text-foreground">{message.name}</h1>
          <Badge variant="secondary">{message.latestVersionLabel ? `latest v${message.latestVersionLabel}` : "unpublished"}</Badge>
          {message.latestVersionLabel && message.hasUnpublishedChanges && <Badge variant="outline">unpublished changes</Badge>}
        </div>
        {!viewing && (
          <PublishVersionButton
            subjectName={message.name}
            description="Publishing freezes this draft — pinned entity versions included — as an immutable message version event specs can pin."
            loadPreview={() => getMessagePublishPreviewAction(message.id)}
            publish={(input) => publishMessageAction(message.id, input)}
            testId="message-publish"
          />
        )}
      </div>

      {viewing ? (
        <section className="space-y-space-3 rounded-lg border border-border/60 p-space-4" data-testid="message-version-view">
          <p className="text-body-small text-foreground">
            Viewing v{viewing.label} (published, read-only). <Link href={draftHref} className="text-primary hover:underline">Back to draft</Link>
          </p>
          <ul className="text-body-small text-muted-foreground">
            {pins.map((pin, i) =>
              pin ? <li key={pin.entityVersionId}>{["Payload", "Headers", "Kafka key"][i]}: {pin.entityName} v{pin.label}</li> : null
            )}
          </ul>
          <pre className="max-h-96 overflow-auto rounded-md bg-muted/30 p-space-3 text-caption font-mono">{JSON.stringify(viewing.resolvedSpec.spec, null, 2)}</pre>
        </section>
      ) : (
        <MessageEditor message={message} productId={productId} listHref={listHref} entityOptions={entityOptions} traitOptions={traitOptions} />
      )}

      <section className="space-y-space-3">
        <h2 className="text-heading-2 text-foreground">Published versions</h2>
        <EventVersionList versions={versions} hrefFor={versionHref} emptyText="Not published yet. Publish to cut version 1.0." />
      </section>

      <UsedByPanel subject={{ kind: "message", messageId: message.id }} title="Used by event specs" />
    </div>
  );
}
```

- [ ] **Step 6: Route + loading**

```tsx
// src/app/(dashboard)/schemas/[domainSlug]/[productSlug]/messages/[messageId]/page.tsx
import { notFound } from "next/navigation";
import { MessagePage } from "@/features/events/messages/MessagePage";
import { loadMessagePage } from "@/features/events/messages/load-message-page";

export default async function MessageRoute({
  params, searchParams,
}: {
  params: Promise<{ domainSlug: string; productSlug: string; messageId: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { domainSlug, productSlug, messageId } = await params;
  const version = (await searchParams)?.version;
  const data = await loadMessagePage({ domainSlug, productSlug, messageId, version: typeof version === "string" ? version : undefined });
  if (!data) notFound();
  return <MessagePage {...data} />;
}
```

`messages/[messageId]/loading.tsx` — the same `PageSkeleton variant="entity"` component as Task 15.

- [ ] **Step 7: Run + type check + commit**

Run: `npx vitest run tests/unit/components/events/message-editor.test.tsx tests/unit/components/events/message-page.test.tsx && npx tsc --noEmit`
Expected: PASS; no type errors.

```bash
git add src/features/events/messages "src/app/(dashboard)/schemas/[domainSlug]/[productSlug]/messages" tests/unit/components/events/message-editor.test.tsx tests/unit/components/events/message-page.test.tsx
git commit -m "feat(18.6,18.9): message page — pinned payload/headers/key, traits, publish + versions, used-by"
```

---
### Task 17: Event Spec page — Editor · Document · Preview · Versions · Diagnostics (Stories 18.6 / 18.7 UI, spec §7.4, §9) — Wave 5

**Files:**
- Create: `src/features/events/event-specs/load-event-spec-page.ts`, `spec-tabs.ts`, `EventSpecPage.tsx`, `EventSpecEditor.tsx`, `DocumentView.tsx`, `DiagnosticsList.tsx`, `use-event-spec-emission.ts` (all under `src/features/events/event-specs/`; `AsyncApiPreview.tsx` comes from Task 8)
- Create: `src/app/(dashboard)/schemas/[domainSlug]/[productSlug]/specs/[specId]/page.tsx`, `.../specs/[specId]/loading.tsx`
- Test: `tests/unit/components/events/event-spec-editor.test.tsx`, `tests/unit/components/events/document-view-diagnostics.test.tsx`, `tests/unit/components/events/event-spec-page.test.tsx`

**Interfaces:**

```ts
type SpecTab = "editor" | "document" | "preview" | "versions" | "diagnostics";
normalizeSpecTab(raw: string | null, viewingVersion: string | null): SpecTab     // a version view never opens the editor
interface EventSpecPageData {
  spec: EventSpecDetail; productId: string; domainSlug: string; productSlug: string; crumbs: Crumb[];
  channelOptions: ChannelOption[]; messageOptions: MessageRefOption[]; operationTraits: TraitOption[];
  versions: EventVersionSummary[]; viewingVersion: string | null; initialTab: SpecTab;
}
loadEventSpecPage({ domainSlug, productSlug, specId, version?, tab? }): Promise<EventSpecPageData | null>
useEventSpecEmission(specId, versionLabel): { status: "idle" | "loading" | "ready" | "error"; emission: EventSpecEmission | null; error: string | null; load(): Promise<void> }
EventSpecEditor({ spec, productId, channelOptions, messageOptions, operationTraits, onSaved })
DocumentView({ emission, loading, error, onRetry }); DiagnosticsList({ diagnostics, unpublishedMessages })
```

- [ ] **Step 1: Write the failing tests**

`tests/unit/components/events/event-spec-editor.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ updateEventSpecDocumentAction: vi.fn(), renameEventSpecAction: vi.fn() }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/event-spec-actions", () => ({
  updateEventSpecDocumentAction: h.updateEventSpecDocumentAction, renameEventSpecAction: h.renameEventSpecAction,
}));
import { EventSpecEditor } from "@/features/events/event-specs/EventSpecEditor";

const spec = {
  id: "s1", name: "checkout-service", specType: "asyncapi@3.0", latestVersionLabel: null, hasUnpublishedChanges: true,
  tenantId: "t", domainId: "d1", productId: "p1",
  document: { info: { title: "checkout-service" }, servers: [], operations: [] },
};
const props = {
  spec,
  productId: "p1",
  channelOptions: [
    { id: "c1", name: "orders", address: "payments.orders.v1", protocol: "kafka", format: "avro", ownerLabel: "Payments / Checkout", own: true, allowedMessageIds: ["m1"] },
    { id: "c2", name: "risk", address: "risk.v1", protocol: "kafka", format: "json-schema", ownerLabel: "Risk / Fraud", own: false, allowedMessageIds: [] },
  ],
  messageOptions: [
    { id: "mv1", messageId: "m1", label: "OrderCreated v1.0", ownerLabel: "Payments / Checkout", own: true, draft: false },
    { id: "m2", messageId: "m2", label: "OrderCancelled (draft — preview only)", ownerLabel: "This product", own: true, draft: true },
  ],
  operationTraits: [{ id: "t1", name: "Retry", ownerLabel: "Enterprise" }],
};

beforeEach(() => vi.clearAllMocks());
afterEach(() => cleanup());

describe("EventSpecEditor", () => {
  it("builds info, a server and an operation, then saves the EventSpecDocument", async () => {
    const onSaved = vi.fn();
    h.updateEventSpecDocumentAction.mockResolvedValue({ success: true, data: { ...spec, hasUnpublishedChanges: true } });
    render(<EventSpecEditor {...props} onSaved={onSaved} />);
    fireEvent.change(screen.getByLabelText("Description"), { target: { value: "Checkout events" } });
    fireEvent.click(screen.getByTestId("spec-add-server"));
    const server = screen.getByTestId("spec-server-0");
    fireEvent.change(within(server).getByLabelText("Key"), { target: { value: "kafka-prod" } });
    fireEvent.change(within(server).getByLabelText("Protocol"), { target: { value: "kafka" } });
    fireEvent.change(within(server).getByLabelText("Host"), { target: { value: "kafka-prod.internal:9092" } });
    fireEvent.click(screen.getByTestId("spec-add-operation"));
    const op = screen.getByTestId("spec-operation-0");
    fireEvent.change(within(op).getByLabelText("Key"), { target: { value: "publishOrderCreated" } });
    fireEvent.change(within(op).getByLabelText("Channel"), { target: { value: "c1" } });
    expect(within(op).getByText("allowed on channel")).toBeDefined();
    fireEvent.click(within(op).getByLabelText("OrderCreated v1.0"));
    fireEvent.click(within(op).getByLabelText("Retry"));
    fireEvent.click(screen.getByTestId("spec-save"));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(h.updateEventSpecDocumentAction).toHaveBeenCalledWith("s1", "p1", {
      info: { title: "checkout-service", description: "Checkout events" },
      servers: [{ key: "kafka-prod", protocol: "kafka", host: "kafka-prod.internal:9092" }],
      operations: [{ key: "publishOrderCreated", action: "send", channelId: "c1", messageVersionIds: ["mv1"], traitIds: ["t1"] }],
    });
    expect(h.renameEventSpecAction).not.toHaveBeenCalled();
  });

  it("shows pointer-addressed validation problems from the server", async () => {
    h.updateEventSpecDocumentAction.mockResolvedValue({
      success: false, error: "The event spec document has 1 problem(s)", code: "VALIDATION_ERROR",
      details: { problems: [{ pointer: "/operations/0/channelId", message: "Operation channel is required" }] },
    });
    render(<EventSpecEditor {...props} onSaved={vi.fn()} />);
    fireEvent.click(screen.getByTestId("spec-save"));
    expect(await screen.findByText("/operations/0/channelId: Operation channel is required")).toBeDefined();
  });
});
```

`tests/unit/components/events/document-view-diagnostics.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
import { DocumentView } from "@/features/events/event-specs/DocumentView";
import { DiagnosticsList } from "@/features/events/event-specs/DiagnosticsList";

afterEach(() => cleanup());
const emission = {
  specId: "s1", specName: "checkout-service", version: "2.0", published: true,
  document: { asyncapi: "3.0.0" }, json: '{\n  "asyncapi": "3.0.0"\n}\n', yaml: "asyncapi: 3.0.0\n", diagnostics: [], unpublishedMessages: [],
};

describe("DocumentView", () => {
  it("toggles YAML / JSON, copies and downloads with the version in the file name", () => {
    const writeText = vi.fn();
    Object.assign(navigator, { clipboard: { writeText } });
    const createObjectURL = vi.fn(() => "blob:x");
    Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    render(<DocumentView emission={emission} loading={false} error={null} onRetry={vi.fn()} />);
    expect(screen.getByTestId("document-text").textContent).toContain("asyncapi: 3.0.0");
    fireEvent.click(screen.getByRole("button", { name: "JSON" }));
    expect(screen.getByTestId("document-text").textContent).toContain('"asyncapi": "3.0.0"');
    fireEvent.click(screen.getByTestId("document-copy"));
    expect(writeText).toHaveBeenCalledWith(emission.json);
    fireEvent.click(screen.getByTestId("document-download"));
    expect(createObjectURL).toHaveBeenCalled();
    expect(click).toHaveBeenCalled();
    expect((click.mock.contexts[0] as HTMLAnchorElement).download).toBe("checkout-service-2.0.asyncapi.json");
  });

  it("points to Diagnostics when there is no document", () => {
    render(<DocumentView emission={{ ...emission, document: null, json: null, yaml: null }} loading={false} error={null} onRetry={vi.fn()} />);
    expect(screen.getByText(/No document — see the Diagnostics tab/)).toBeDefined();
  });
});

describe("DiagnosticsList", () => {
  it("lists diagnostics by severity with pointers, plus unpublished messages", () => {
    render(
      <DiagnosticsList
        diagnostics={[
          { severity: "error", code: "PAYLOAD_ARTIFACT_MISSING", message: "No payload schema rendered as avro", pointer: "/components/messages/OrderCreated/payload" },
          { severity: "warning", code: "SCHEMA_KEYWORD_DROPPED", message: "dropped", pointer: "" },
        ]}
        unpublishedMessages={[{ id: "m1", name: "OrderCreated" }]}
      />
    );
    expect(screen.getByText("1 error · 1 warning")).toBeDefined();
    expect(screen.getByText("/components/messages/OrderCreated/payload")).toBeDefined();
    expect(screen.getByText(/OrderCreated is an unpublished draft/)).toBeDefined();
  });

  it("celebrates a clean document", () => {
    render(<DiagnosticsList diagnostics={[]} unpublishedMessages={[]} />);
    expect(screen.getByText(/validates with @asyncapi\/parser/)).toBeDefined();
  });
});
```

`tests/unit/components/events/event-spec-page.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ emitEventSpecDraftAction: vi.fn(), getEventSpecVersionDocumentAction: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock("@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/event-spec-emit-actions", () => h);
vi.mock("@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/event-spec-version-actions", () => ({ getEventSpecPublishPreviewAction: vi.fn(), publishEventSpecAction: vi.fn() }));
vi.mock("@/features/events/event-specs/EventSpecEditor", () => ({ EventSpecEditor: () => <div data-testid="spec-editor" /> }));
vi.mock("@/features/events/event-specs/AsyncApiPreview", () => ({ AsyncApiPreview: (p: { document: unknown }) => <div data-testid="preview">{JSON.stringify(p.document)}</div> }));
vi.mock("@/features/events/shared/PublishVersionButton", () => ({ PublishVersionButton: () => <button data-testid="spec-publish">Publish</button> }));
import { EventSpecPage, normalizeSpecTab } from "@/features/events/event-specs/EventSpecPage";

const emission = { specId: "s1", specName: "checkout-service", version: "draft", published: false, document: { asyncapi: "3.0.0" }, json: "{}", yaml: "asyncapi: 3.0.0\n", diagnostics: [], unpublishedMessages: [] };
const base = {
  spec: { id: "s1", name: "checkout-service", specType: "asyncapi@3.0", latestVersionLabel: "1.0", hasUnpublishedChanges: true, tenantId: "t", domainId: "d1", productId: "p1", document: { info: { title: "x" }, servers: [], operations: [] } },
  productId: "p1", domainSlug: "payments", productSlug: "checkout", crumbs: [{ label: "Event Specs" }],
  channelOptions: [], messageOptions: [], operationTraits: [],
  versions: [{ id: "v1", major: 1, minor: 0, label: "1.0", sequence: 1, changeKind: "INITIAL" as const, changeSummary: null, publishedByName: "Ada", publishedAt: "2026-10-14T00:00:00.000Z" }],
};

beforeEach(() => {
  vi.clearAllMocks();
  h.emitEventSpecDraftAction.mockResolvedValue({ success: true, data: emission });
  h.getEventSpecVersionDocumentAction.mockResolvedValue({ success: true, data: { ...emission, version: "1.0", published: true } });
  window.history.replaceState(null, "", "/schemas/payments/checkout/specs/s1");
});
afterEach(() => cleanup());

describe("EventSpecPage", () => {
  it("normalizes tabs; a version view never opens the editor", () => {
    expect(normalizeSpecTab(null, null)).toBe("editor");
    expect(normalizeSpecTab("preview", null)).toBe("preview");
    expect(normalizeSpecTab("editor", "1.0")).toBe("document");
    expect(normalizeSpecTab(null, "1.0")).toBe("document");
  });

  it("emits the draft lazily once for Document / Preview / Diagnostics and writes ?tab= to the URL", async () => {
    render(<EventSpecPage {...base} viewingVersion={null} initialTab="editor" />);
    expect(screen.getByTestId("spec-editor")).toBeDefined();
    expect(screen.getByTestId("spec-publish")).toBeDefined();
    expect(h.emitEventSpecDraftAction).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("tab", { name: "Document" }));
    expect((await screen.findByTestId("document-text")).textContent).toContain("asyncapi: 3.0.0");
    expect(window.location.search).toBe("?tab=document");
    fireEvent.click(screen.getByRole("tab", { name: "Preview" }));
    expect(screen.getByTestId("preview").textContent).toBe(JSON.stringify({ asyncapi: "3.0.0" }));
    fireEvent.click(screen.getByRole("tab", { name: "Diagnostics" }));
    await waitFor(() => expect(h.emitEventSpecDraftAction).toHaveBeenCalledTimes(1));
  });

  it("shows a published version read-only from its stored document", async () => {
    render(<EventSpecPage {...base} viewingVersion="1.0" initialTab="document" />);
    await waitFor(() => expect(h.getEventSpecVersionDocumentAction).toHaveBeenCalledWith("s1", "1.0"));
    expect(screen.queryByTestId("spec-publish")).toBeNull();
    expect(screen.getByRole("tab", { name: "Editor" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("link", { name: "Back to draft" }).getAttribute("href")).toBe("/schemas/payments/checkout/specs/s1");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/unit/components/events/event-spec-editor.test.tsx tests/unit/components/events/document-view-diagnostics.test.tsx tests/unit/components/events/event-spec-page.test.tsx`
Expected: FAIL — missing modules.

- [ ] **Step 3: Loader + emission hook**

```ts
// src/features/events/event-specs/load-event-spec-page.ts
import { prisma } from "@/lib/db";
import { formatVersionLabel } from "@/lib/entity-versioning/version-math";
import { assetHref } from "@/lib/navigation/asset-href";
import type { EventSpecDetail, EventVersionSummary } from "@/lib/events/types";
import { SPEC_SELECT, toEventSpecDetail } from "@/services/events/event-spec.service";
import { toEventVersionSummary, VERSION_SUMMARY_SELECT } from "@/services/events/version-summary";
import { productCrumbs } from "@/features/events/crumbs";
import {
  loadChannelOptions, loadMessageRefOptions, loadTraitOptions, type ChannelOption, type MessageRefOption, type TraitOption,
} from "@/features/events/load-options";
import { resolveProductRoute } from "@/features/events/route-scope";
import type { Crumb } from "@/features/events/shared/EventBreadcrumb";
import { normalizeSpecTab, type SpecTab } from "./spec-tabs";

export interface EventSpecPageData {
  spec: EventSpecDetail;
  productId: string;
  domainSlug: string;
  productSlug: string;
  crumbs: Crumb[];
  channelOptions: ChannelOption[];
  messageOptions: MessageRefOption[];
  operationTraits: TraitOption[];
  versions: EventVersionSummary[];
  /** `?version=` of a published version; null = the draft. */
  viewingVersion: string | null;
  initialTab: SpecTab;
}

export async function loadEventSpecPage(params: {
  domainSlug: string; productSlug: string; specId: string; version?: string; tab?: string;
}): Promise<EventSpecPageData | null> {
  const route = await resolveProductRoute(params.domainSlug, params.productSlug);
  if (!route) return null;
  const row = await prisma.eventSpec.findFirst({ where: { id: params.specId, productId: route.product.id }, select: SPEC_SELECT });
  if (!row) return null;
  const detail = toEventSpecDetail(row);
  if (!detail.success) return null;

  const scope = { tenantId: route.tenantId, domainId: route.domain.id, productId: route.product.id };
  const [versionRows, channelOptions, messageOptions, operationTraits] = await Promise.all([
    prisma.eventSpecVersion.findMany({ where: { eventSpecId: row.id }, orderBy: { sequence: "desc" }, select: VERSION_SUMMARY_SELECT }),
    loadChannelOptions(route.tenantId, route.product.id),
    loadMessageRefOptions(route.tenantId, route.product.id),
    loadTraitOptions(scope, "OPERATION"),
  ]);
  const versions = versionRows.map(toEventVersionSummary);
  let viewingVersion: string | null = null;
  if (params.version) {
    const match = versions.find((v) => v.label === params.version || `v${v.label}` === params.version);
    if (!match) return null;
    viewingVersion = formatVersionLabel(match);
  }
  const listHref = assetHref({ kind: "events", domainSlug: route.domain.slug, productSlug: route.product.slug, section: "specs" });
  return {
    spec: detail.data,
    productId: route.product.id,
    domainSlug: route.domain.slug,
    productSlug: route.product.slug,
    crumbs: productCrumbs(route, { label: "Event Specs", href: listHref }, row.name),
    channelOptions,
    messageOptions,
    operationTraits,
    versions,
    viewingVersion,
    initialTab: normalizeSpecTab(params.tab ?? null, viewingVersion),
  };
}
```

`normalizeSpecTab` lives in a tiny client-safe module so the server loader and the client page share it:

```ts
// src/features/events/event-specs/spec-tabs.ts
export type SpecTab = "editor" | "document" | "preview" | "versions" | "diagnostics";
export const SPEC_TABS: Array<{ id: SpecTab; label: string }> = [
  { id: "editor", label: "Editor" },
  { id: "document", label: "Document" },
  { id: "preview", label: "Preview" },
  { id: "versions", label: "Versions" },
  { id: "diagnostics", label: "Diagnostics" },
];

/** A published version is read-only: it opens on Document and never on the Editor. */
export function normalizeSpecTab(raw: string | null, viewingVersion: string | null): SpecTab {
  const known = SPEC_TABS.some((t) => t.id === raw) ? (raw as SpecTab) : null;
  if (viewingVersion) return known && known !== "editor" ? known : "document";
  return known ?? "editor";
}
```

(`EventSpecPage.tsx` re-exports `normalizeSpecTab` for the test.)

```ts
// src/features/events/event-specs/use-event-spec-emission.ts
"use client";

import { useCallback, useState } from "react";
import {
  emitEventSpecDraftAction, getEventSpecVersionDocumentAction,
} from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/event-spec-emit-actions";
import type { EventSpecEmission } from "@/services/events/event-spec-emit.service";

type EmissionState = { status: "idle" | "loading" | "ready" | "error"; emission: EventSpecEmission | null; error: string | null };

/** Draft emission (rendered + parser-validated on the server) or a version's stored document. */
export function useEventSpecEmission(specId: string, versionLabel: string | null) {
  const [state, setState] = useState<EmissionState>({ status: "idle", emission: null, error: null });
  const load = useCallback(async () => {
    setState((s) => ({ ...s, status: "loading", error: null }));
    const r = versionLabel ? await getEventSpecVersionDocumentAction(specId, versionLabel) : await emitEventSpecDraftAction(specId);
    setState(r.success ? { status: "ready", emission: r.data, error: null } : { status: "error", emission: null, error: r.error });
  }, [specId, versionLabel]);
  return { ...state, load };
}
```

(`EventSpecEmission` is a type-only import from the service module — erased at compile time, nothing server-side is bundled.)

- [ ] **Step 4: `DocumentView` + `DiagnosticsList`**

```tsx
// src/features/events/event-specs/DocumentView.tsx
"use client";

import { useState } from "react";
import { Check, Copy, Download, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { highlightLine } from "@/lib/syntax-highlight";
import type { EventSpecEmission } from "@/services/events/event-spec-emit.service";

const MIME = { yaml: "application/yaml", json: "application/json" } as const;

export function DocumentView({
  emission, loading, error, onRetry,
}: { emission: EventSpecEmission | null; loading: boolean; error: string | null; onRetry: () => void }) {
  const [format, setFormat] = useState<"yaml" | "json">("yaml");
  const [copied, setCopied] = useState(false);

  if (loading) return <p className="flex items-center gap-2 text-body-small text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Rendering payloads and validating with @asyncapi/parser…</p>;
  if (error) {
    return (
      <div role="alert" className="space-y-space-2 text-body-small text-destructive">
        <p>{error}</p>
        <Button size="sm" variant="outline" onClick={onRetry}>Retry</Button>
      </div>
    );
  }
  if (!emission) return null;
  if (!emission.document || !emission.yaml || !emission.json) {
    return <p className="text-body-small text-muted-foreground">No document — see the Diagnostics tab for unresolved references.</p>;
  }
  const text = format === "yaml" ? emission.yaml : emission.json;
  const fileName = `${emission.specName}-${emission.version}.asyncapi.${format}`;

  function copy() {
    void navigator.clipboard.writeText(text);
    setCopied(true);
    toast.success("Copied");
    setTimeout(() => setCopied(false), 2000);
  }

  function download() {
    const url = URL.createObjectURL(new Blob([text], { type: MIME[format] }));
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="space-y-space-2">
      <div className="flex items-center gap-space-2">
        <div role="group" aria-label="Format" className="flex rounded-md border border-border">
          {(["yaml", "json"] as const).map((f) => (
            <button key={f} type="button" onClick={() => setFormat(f)} aria-pressed={format === f}
              className={`px-space-3 py-1 text-body-small ${format === f ? "bg-accent text-foreground" : "text-muted-foreground"}`}>
              {f.toUpperCase()}
            </button>
          ))}
        </div>
        <span className="text-caption text-muted-foreground">{emission.published ? `v${emission.version} (stored)` : "draft"}</span>
        <div className="ml-auto flex gap-space-2">
          <Button size="sm" variant="outline" onClick={copy} data-testid="document-copy" className="gap-1.5">{copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />} Copy</Button>
          <Button size="sm" variant="outline" onClick={download} data-testid="document-download" className="gap-1.5"><Download className="w-4 h-4" /> Download</Button>
        </div>
      </div>
      <pre className="max-h-[70vh] overflow-auto rounded-md border border-border/50 bg-muted/20 p-space-3 text-caption font-mono" data-testid="document-text">
        <code>
          {text.split("\n").map((line, i) => (
            <div key={i} className="flex">
              <span className="inline-block w-10 select-none pr-3 text-right text-muted-foreground/50">{i + 1}</span>
              <span className="flex-1">{highlightLine(line, format)}</span>
            </div>
          ))}
        </code>
      </pre>
    </div>
  );
}
```

```tsx
// src/features/events/event-specs/DiagnosticsList.tsx
import { Badge } from "@/components/ui/badge";
import type { Diagnostic } from "@/lib/event-specs/types";

const VARIANT = { error: "destructive", warning: "secondary", info: "outline" } as const;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export function DiagnosticsList({ diagnostics, unpublishedMessages }: { diagnostics: Diagnostic[]; unpublishedMessages: Array<{ id: string; name: string }> }) {
  const errors = diagnostics.filter((d) => d.severity === "error").length;
  const warnings = diagnostics.filter((d) => d.severity === "warning").length;
  return (
    <div className="space-y-space-3" data-testid="diagnostics-list">
      {unpublishedMessages.map((m) => (
        <p key={m.id} className="text-body-small text-muted-foreground">Message {m.name} is an unpublished draft (preview only) — publish it and pick its version before publishing this spec.</p>
      ))}
      {diagnostics.length === 0 ? (
        <p className="text-body-small text-muted-foreground">No problems found — the document validates with @asyncapi/parser.</p>
      ) : (
        <>
          <p className="text-body-small text-foreground">{plural(errors, "error")} · {plural(warnings, "warning")}</p>
          <ul className="space-y-space-2">
            {diagnostics.map((d, i) => (
              <li key={`${d.code}-${d.pointer}-${i}`} className="rounded-md border border-border/50 p-space-3">
                <div className="flex flex-wrap items-center gap-space-2">
                  <Badge variant={VARIANT[d.severity]}>{d.severity}</Badge>
                  <span className="font-mono text-caption">{d.code}</span>
                  {d.pointer && <span className="font-mono text-caption text-muted-foreground">{d.pointer}</span>}
                </div>
                <p className="mt-space-1 text-body-small text-foreground">{d.message}</p>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
```

(`Badge` variants `destructive` / `secondary` / `outline` exist in `src/components/ui/badge.tsx` — verified 2026-10-14.)

- [ ] **Step 5: `EventSpecEditor`** (minimal structured form — the visual builder is Phase 5)

```tsx
// src/features/events/event-specs/EventSpecEditor.tsx
"use client";

import { useMemo, useState } from "react";
import { Loader2, Plus, Save, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  renameEventSpecAction, updateEventSpecDocumentAction,
} from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/event-spec-actions";
import type { EventSpecDetail, EventSpecDocument } from "@/lib/events/types";
import type { EventSpecOperation, EventSpecServer } from "@/lib/event-specs/types";
import type { ChannelOption, MessageRefOption, TraitOption } from "@/features/events/load-options";

const selectClass = "w-full rounded-md border border-border bg-background px-space-2 py-1.5 text-body-small";
type Problem = { pointer: string; message: string };

function compact<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined && v !== "")) as T;
}

/** Strip UI-only empties so the saved document is exactly the spec §6.1 shape. */
function cleanDocument(doc: EventSpecDocument): EventSpecDocument {
  return compact({
    info: compact({ ...doc.info }),
    defaultContentType: doc.defaultContentType,
    servers: doc.servers.map((s) => compact({ ...s })),
    operations: doc.operations.map((o) => compact({ ...o })),
    components: doc.components,
  }) as EventSpecDocument;
}

export function EventSpecEditor({
  spec, productId, channelOptions, messageOptions, operationTraits, onSaved,
}: {
  spec: EventSpecDetail;
  productId: string;
  channelOptions: ChannelOption[];
  messageOptions: MessageRefOption[];
  operationTraits: TraitOption[];
  onSaved: (detail: EventSpecDetail) => void;
}) {
  const [name, setName] = useState(spec.name);
  const [doc, setDoc] = useState<EventSpecDocument>(spec.document);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [problems, setProblems] = useState<Problem[]>([]);
  const channelsById = useMemo(() => new Map(channelOptions.map((c) => [c.id, c])), [channelOptions]);

  const patchInfo = (patch: Partial<EventSpecDocument["info"]>) => setDoc((d) => ({ ...d, info: { ...d.info, ...patch } }));
  const patchServer = (i: number, patch: Partial<EventSpecServer>) =>
    setDoc((d) => ({ ...d, servers: d.servers.map((s, j) => (j === i ? { ...s, ...patch } : s)) }));
  const patchOperation = (i: number, patch: Partial<EventSpecOperation>) =>
    setDoc((d) => ({ ...d, operations: d.operations.map((o, j) => (j === i ? { ...o, ...patch } : o)) }));
  const toggleIn = (list: string[], id: string) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);

  async function save() {
    setSaving(true);
    setError(null);
    setProblems([]);
    if (name.trim() !== spec.name) {
      const renamed = await renameEventSpecAction(spec.id, productId, name);
      if (!renamed.success) {
        setSaving(false);
        return setError(renamed.error);
      }
    }
    const r = await updateEventSpecDocumentAction(spec.id, productId, cleanDocument(doc));
    setSaving(false);
    if (!r.success) {
      setError(r.error);
      const list = (r.details as { problems?: unknown } | undefined)?.problems;
      setProblems(Array.isArray(list) ? (list as Problem[]) : []);
      return;
    }
    toast.success("Draft saved");
    onSaved(r.data);
  }

  return (
    <div className="space-y-space-6" data-testid="spec-editor-form">
      <div className="flex items-center justify-end">
        <Button onClick={save} disabled={saving} data-testid="spec-save" className="gap-1.5">{saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />} Save draft</Button>
      </div>
      {error && (
        <div role="alert" className="text-body-small text-destructive">
          <p>{error}</p>
          {problems.length > 0 && <ul className="list-disc pl-5">{problems.map((p) => <li key={`${p.pointer}-${p.message}`}>{`${p.pointer}: ${p.message}`}</li>)}</ul>}
        </div>
      )}

      <section className="space-y-space-3">
        <h3 className="text-heading-3 text-foreground">Info</h3>
        <div className="grid grid-cols-1 gap-space-3 md:grid-cols-3">
          <label className="space-y-space-1"><span className="block text-caption text-muted-foreground">Name</span><Input aria-label="Spec name" value={name} onChange={(e) => setName(e.target.value)} /></label>
          <label className="space-y-space-1"><span className="block text-caption text-muted-foreground">Title (info.title)</span><Input aria-label="Title" value={doc.info.title} onChange={(e) => patchInfo({ title: e.target.value })} /></label>
          <label className="space-y-space-1"><span className="block text-caption text-muted-foreground">Default content type</span><Input aria-label="Default content type" value={doc.defaultContentType ?? ""} onChange={(e) => setDoc((d) => ({ ...d, defaultContentType: e.target.value || undefined }))} /></label>
          <label className="space-y-space-1 md:col-span-3"><span className="block text-caption text-muted-foreground">Description</span><Textarea aria-label="Description" rows={2} value={doc.info.description ?? ""} onChange={(e) => patchInfo({ description: e.target.value || undefined })} /></label>
        </div>
      </section>

      <section className="space-y-space-3">
        <div className="flex items-center justify-between">
          <h3 className="text-heading-3 text-foreground">Server references</h3>
          <Button size="sm" variant="outline" data-testid="spec-add-server" className="gap-1.5"
            onClick={() => setDoc((d) => ({ ...d, servers: [...d.servers, { key: "", protocol: "", host: "" }] }))}>
            <Plus className="w-4 h-4" /> Add server
          </Button>
        </div>
        {doc.servers.map((s, i) => (
          <div key={i} data-testid={`spec-server-${i}`} className="grid grid-cols-1 items-end gap-space-2 rounded-md border border-border/50 p-space-3 md:grid-cols-6">
            <label className="space-y-space-1"><span className="block text-caption text-muted-foreground">Key</span><Input aria-label="Key" value={s.key} onChange={(e) => patchServer(i, { key: e.target.value })} /></label>
            <label className="space-y-space-1"><span className="block text-caption text-muted-foreground">Protocol</span><Input aria-label="Protocol" value={s.protocol} onChange={(e) => patchServer(i, { protocol: e.target.value })} /></label>
            <label className="space-y-space-1 md:col-span-2"><span className="block text-caption text-muted-foreground">Host</span><Input aria-label="Host" value={s.host} onChange={(e) => patchServer(i, { host: e.target.value })} /></label>
            <label className="space-y-space-1"><span className="block text-caption text-muted-foreground">Pathname</span><Input aria-label="Pathname" value={s.pathname ?? ""} onChange={(e) => patchServer(i, { pathname: e.target.value || undefined })} /></label>
            <Button size="sm" variant="ghost" aria-label="Remove server" onClick={() => setDoc((d) => ({ ...d, servers: d.servers.filter((_, j) => j !== i) }))}><Trash2 className="w-4 h-4" /></Button>
          </div>
        ))}
      </section>

      <section className="space-y-space-3">
        <div className="flex items-center justify-between">
          <h3 className="text-heading-3 text-foreground">Operations</h3>
          <Button size="sm" variant="outline" data-testid="spec-add-operation" className="gap-1.5"
            onClick={() => setDoc((d) => ({ ...d, operations: [...d.operations, { key: "", action: "send", channelId: "", messageVersionIds: [], traitIds: [] }] }))}>
            <Plus className="w-4 h-4" /> Add operation
          </Button>
        </div>
        {doc.operations.map((op, i) => {
          const channel = channelsById.get(op.channelId);
          return (
            <div key={i} data-testid={`spec-operation-${i}`} className="space-y-space-3 rounded-md border border-border/50 p-space-3">
              <div className="grid grid-cols-1 items-end gap-space-2 md:grid-cols-6">
                <label className="space-y-space-1"><span className="block text-caption text-muted-foreground">Key</span><Input aria-label="Key" value={op.key} onChange={(e) => patchOperation(i, { key: e.target.value })} /></label>
                <label className="space-y-space-1">
                  <span className="block text-caption text-muted-foreground">Action</span>
                  <select aria-label="Action" className={selectClass} value={op.action} onChange={(e) => patchOperation(i, { action: e.target.value as EventSpecOperation["action"] })}>
                    <option value="send">send</option>
                    <option value="receive">receive</option>
                  </select>
                </label>
                <label className="space-y-space-1 md:col-span-3">
                  <span className="block text-caption text-muted-foreground">Channel</span>
                  <select aria-label="Channel" className={selectClass} value={op.channelId} onChange={(e) => patchOperation(i, { channelId: e.target.value })}>
                    <option value="">Select a channel</option>
                    {["This product", "Other products (read-only)"].map((group) => (
                      <optgroup key={group} label={group}>
                        {channelOptions.filter((c) => c.own === (group === "This product")).map((c) => (
                          <option key={c.id} value={c.id}>{`${c.name} — ${c.address ?? "(no address)"} (${c.protocol}/${c.format})${c.own ? "" : ` · ${c.ownerLabel}`}`}</option>
                        ))}
                      </optgroup>
                    ))}
                  </select>
                </label>
                <Button size="sm" variant="ghost" aria-label="Remove operation" onClick={() => setDoc((d) => ({ ...d, operations: d.operations.filter((_, j) => j !== i) }))}><Trash2 className="w-4 h-4" /></Button>
              </div>
              <label className="block space-y-space-1"><span className="block text-caption text-muted-foreground">Summary</span><Input aria-label="Summary" value={op.summary ?? ""} onChange={(e) => patchOperation(i, { summary: e.target.value || undefined })} /></label>
              <fieldset className="space-y-space-1">
                <legend className="text-caption text-muted-foreground">Messages (pinned versions; drafts are preview only)</legend>
                <div className="grid grid-cols-1 gap-space-1 md:grid-cols-2">
                  {messageOptions.map((m) => (
                    <label key={m.id} className="flex items-center gap-space-2 text-body-small">
                      <input type="checkbox" aria-label={m.label} checked={op.messageVersionIds.includes(m.id)}
                        onChange={() => patchOperation(i, { messageVersionIds: toggleIn(op.messageVersionIds, m.id) })} />
                      {m.label}
                      <span className="text-caption text-muted-foreground">{m.ownerLabel}</span>
                      {channel?.allowedMessageIds.includes(m.messageId) && <Badge variant="outline">allowed on channel</Badge>}
                    </label>
                  ))}
                </div>
              </fieldset>
              {operationTraits.length > 0 && (
                <fieldset className="flex flex-wrap gap-space-4">
                  <legend className="text-caption text-muted-foreground">Operation traits</legend>
                  {operationTraits.map((t) => (
                    <label key={t.id} className="flex items-center gap-space-2 text-body-small">
                      <input type="checkbox" aria-label={t.name} checked={op.traitIds.includes(t.id)} onChange={() => patchOperation(i, { traitIds: toggleIn(op.traitIds, t.id) })} />
                      {t.name}
                    </label>
                  ))}
                </fieldset>
              )}
            </div>
          );
        })}
      </section>
    </div>
  );
}
```

- [ ] **Step 6: `EventSpecPage`**

```tsx
// src/features/events/event-specs/EventSpecPage.tsx
"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { FileCode2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  getEventSpecPublishPreviewAction, publishEventSpecAction,
} from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/event-spec-version-actions";
import { assetHref } from "@/lib/navigation/asset-href";
import { EventBreadcrumb } from "@/features/events/shared/EventBreadcrumb";
import { EventVersionList } from "@/features/events/shared/EventVersionList";
import { PublishVersionButton } from "@/features/events/shared/PublishVersionButton";
import { AsyncApiPreview } from "./AsyncApiPreview";
import { DiagnosticsList } from "./DiagnosticsList";
import { DocumentView } from "./DocumentView";
import { EventSpecEditor } from "./EventSpecEditor";
import type { EventSpecPageData } from "./load-event-spec-page";
import { SPEC_TABS, type SpecTab } from "./spec-tabs";
import { useEventSpecEmission } from "./use-event-spec-emission";

export { normalizeSpecTab } from "./spec-tabs";

const NEEDS_EMISSION: ReadonlySet<SpecTab> = new Set(["document", "preview", "diagnostics"]);

export function EventSpecPage({
  spec, productId, domainSlug, productSlug, crumbs, channelOptions, messageOptions, operationTraits, versions, viewingVersion, initialTab,
}: EventSpecPageData) {
  const router = useRouter();
  const [tab, setTab] = useState<SpecTab>(initialTab);
  const emission = useEventSpecEmission(spec.id, viewingVersion);
  const { status, load } = emission;
  const specRef = { kind: "eventSpec" as const, id: spec.id, domainSlug, productSlug };
  const draftHref = assetHref(specRef);

  useEffect(() => {
    if (NEEDS_EMISSION.has(tab) && status === "idle") void load();
  }, [tab, status, load]);

  function selectTab(next: SpecTab) {
    setTab(next);
    window.history.replaceState(null, "", assetHref(specRef, { version: viewingVersion ?? undefined, query: { tab: next } }));
  }

  const diagnostics = emission.emission?.diagnostics ?? [];
  const errorCount = diagnostics.filter((d) => d.severity === "error").length;

  return (
    <div className="animate-auth-fade-up space-y-space-6">
      <EventBreadcrumb crumbs={crumbs} />
      <div className="flex flex-wrap items-center justify-between gap-space-3">
        <div className="flex flex-wrap items-center gap-space-2">
          <FileCode2 className="w-6 h-6" />
          <h1 className="text-display text-foreground">{spec.name}</h1>
          <Badge variant="secondary">{spec.specType}</Badge>
          <Badge variant="secondary">{spec.latestVersionLabel ? `latest v${spec.latestVersionLabel}` : "unpublished"}</Badge>
          {spec.latestVersionLabel && spec.hasUnpublishedChanges && <Badge variant="outline">unpublished changes</Badge>}
          {viewingVersion && <Badge>viewing v{viewingVersion}</Badge>}
        </div>
        {viewingVersion ? (
          <Link href={draftHref} className="text-body-small text-primary hover:underline">Back to draft</Link>
        ) : (
          <PublishVersionButton
            subjectName={spec.name}
            description="Publishing renders every payload from its pinned entity version, validates the AsyncAPI document and stores it immutably (MAJOR.MINOR becomes info.version)."
            loadPreview={() => getEventSpecPublishPreviewAction(spec.id)}
            publish={(input) => publishEventSpecAction(spec.id, input)}
            testId="spec-publish"
          />
        )}
      </div>

      <div role="tablist" aria-label={`${spec.name} sections`} className="flex items-center gap-space-1 border-b border-border">
        {SPEC_TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            disabled={t.id === "editor" && viewingVersion !== null}
            onClick={() => selectTab(t.id)}
            className={`-mb-px border-b-2 px-space-4 py-space-2 text-body-small transition-colors disabled:opacity-40 ${tab === t.id ? "border-primary font-medium text-primary" : "border-transparent text-muted-foreground hover:text-foreground"}`}
          >
            {t.label}
            {t.id === "diagnostics" && errorCount > 0 && <span className="ml-1 text-destructive">({errorCount})</span>}
          </button>
        ))}
      </div>

      <div role="tabpanel">
        {tab === "editor" && !viewingVersion && (
          <EventSpecEditor
            spec={spec}
            productId={productId}
            channelOptions={channelOptions}
            messageOptions={messageOptions}
            operationTraits={operationTraits}
            onSaved={() => {
              void load();
              router.refresh();
            }}
          />
        )}
        {tab === "document" && (
          <DocumentView emission={emission.emission} loading={status === "loading"} error={emission.error} onRetry={() => void load()} />
        )}
        {tab === "preview" && (
          status === "loading" ? <p className="text-body-small text-muted-foreground">Rendering…</p> : <AsyncApiPreview document={emission.emission?.document ?? null} title={spec.name} />
        )}
        {tab === "versions" && (
          <EventVersionList versions={versions} hrefFor={(label) => assetHref(specRef, { version: label })} emptyText="Not published yet. Publish to cut version 1.0." />
        )}
        {tab === "diagnostics" && (
          status === "loading" ? <p className="text-body-small text-muted-foreground">Validating…</p> : <DiagnosticsList diagnostics={diagnostics} unpublishedMessages={emission.emission?.unpublishedMessages ?? []} />
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 7: Route + loading**

```tsx
// src/app/(dashboard)/schemas/[domainSlug]/[productSlug]/specs/[specId]/page.tsx
import { notFound } from "next/navigation";
import { EventSpecPage } from "@/features/events/event-specs/EventSpecPage";
import { loadEventSpecPage } from "@/features/events/event-specs/load-event-spec-page";

export default async function EventSpecRoute({
  params, searchParams,
}: {
  params: Promise<{ domainSlug: string; productSlug: string; specId: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { domainSlug, productSlug, specId } = await params;
  const query = (await searchParams) ?? {};
  const pick = (v: string | string[] | undefined) => (typeof v === "string" ? v : undefined);
  const data = await loadEventSpecPage({ domainSlug, productSlug, specId, version: pick(query.version), tab: pick(query.tab) });
  if (!data) notFound();
  return <EventSpecPage {...data} />;
}
```

`specs/[specId]/loading.tsx` — the same `PageSkeleton variant="entity"` component as Task 15.

- [ ] **Step 8: Run + type check + commit**

Run: `npx vitest run tests/unit/components/events/event-spec-editor.test.tsx tests/unit/components/events/document-view-diagnostics.test.tsx tests/unit/components/events/event-spec-page.test.tsx && npx tsc --noEmit`
Expected: PASS; no type errors.

```bash
git add src/features/events/event-specs "src/app/(dashboard)/schemas/[domainSlug]/[productSlug]/specs" tests/unit/components/events/event-spec-editor.test.tsx tests/unit/components/events/document-view-diagnostics.test.tsx tests/unit/components/events/event-spec-page.test.tsx
git commit -m "feat(18.6): event spec page — structured editor, YAML/JSON document, AsyncAPI preview, versions, diagnostics"
```

---
### Task 18: End-to-end events flow + full verification (spec §11 E2E) — Wave 6

**Files:**
- Modify: `tests/e2e/helpers/db.ts` (edge-row cleanup for a domain)
- Create: `tests/e2e/events-flow.spec.ts`

**Prerequisites** (same as the existing E2E specs, see `tests/e2e/helpers/auth.ts` / `db.ts`): PostgreSQL provider (`DATABASE_URL`), seeded user (`npm run db:seed`), `npx playwright install chromium`, migrations deployed (`npm run db:deploy`).

- [ ] **Step 1: Edge-row cleanup helper** (`tests/e2e/helpers/db.ts`, append)

```ts
/** schema_references has no FKs (polymorphic): delete the rows of every events / version record under a domain. */
export async function deleteSchemaReferencesForDomain(domainId: string): Promise<void> {
  await pg().query(
    `DELETE FROM schema_references WHERE "fromId" IN (
       SELECT id FROM messages WHERE "domainId" = $1
       UNION SELECT mv.id FROM message_versions mv JOIN messages m ON m.id = mv."messageId" WHERE m."domainId" = $1
       UNION SELECT id FROM event_specs WHERE "domainId" = $1
       UNION SELECT sv.id FROM event_spec_versions sv JOIN event_specs s ON s.id = sv."eventSpecId" WHERE s."domainId" = $1
       UNION SELECT ev.id FROM entity_versions ev JOIN entities e ON e.id = ev."entityId" WHERE e."domainId" = $1
       UNION SELECT id FROM traits WHERE "domainId" = $1)`,
    [domainId]
  );
}
```

- [ ] **Step 2: Write the E2E spec** (`tests/e2e/events-flow.spec.ts`)

```ts
/**
 * Events E2E (spec §11): entity → publish 1.0 → channel → message → publish → event spec → publish →
 * download YAML → preview renders → REST serves the stored version → sidebar shows the Events leaves.
 * Uses createNavFixtures for the domain / product / entity and the UI for everything events-related.
 */
import { readFileSync } from "node:fs";
import { test, expect } from "./helpers/auth";
import { createNavFixtures, deleteNavFixtures, deleteSchemaReferencesForDomain, disconnectDb, type NavFixtures } from "./helpers/db";

let fixtures: NavFixtures | undefined;

test.beforeAll(async () => {
  fixtures = await createNavFixtures();
});

test.afterAll(async () => {
  try {
    if (fixtures) await deleteSchemaReferencesForDomain(fixtures.domain.id);
    await deleteNavFixtures(fixtures);
  } finally {
    await disconnectDb();
  }
});

test("design an event end to end and download the AsyncAPI document", async ({ authedPage: page }) => {
  test.setTimeout(240_000);
  const f = fixtures as NavFixtures;
  const s = Date.now().toString(36);
  const productUrl = `/schemas/${f.domain.slug}/${f.product.slug}`;
  const channelName = `orders-${s}`;
  const address = `payments.orders.${s}`;
  const messageName = `OrderCreated${s}`;
  const specName = `checkout-service-${s}`;

  // 1. Publish the payload entity (Track B UI).
  await page.goto(`${productUrl}/${f.productEntity.slug}`);
  await page.getByRole("button", { name: "Versions" }).first().click();
  await page.getByTestId("versions-publish-button").click();
  await page.getByTestId("confirm-publish").click();
  await expect(page.getByTestId("entity-version-list")).toContainText("v1.0");

  // 2. Channel via the product New menu.
  await page.goto(productUrl);
  await page.getByTitle("More options").click();
  await page.getByRole("menuitem", { name: /New Channel/ }).click();
  await page.getByLabel("Channel name").fill(channelName);
  await page.getByLabel("Address").fill(address);
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page).toHaveURL(/\/channels\/[^/?]+$/);

  // 3. Message pinned to the published entity, then publish 1.0.
  await page.goto(productUrl);
  await page.getByTitle("More options").click();
  await page.getByRole("menuitem", { name: /New Message/ }).click();
  await page.getByLabel("Message name").fill(messageName);
  await page.getByLabel("Payload entity").selectOption({ label: `${f.productEntity.name} (v1.0)` });
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page).toHaveURL(/\/messages\/[^/?]+$/);
  await page.getByTestId("message-publish").click();
  await page.getByTestId("confirm-publish").click();
  await expect(page.getByTestId("event-version-list")).toContainText("v1.0");

  // 4. Event spec: server + operation on the channel with the message version; save; publish.
  await page.goto(productUrl);
  await page.getByTitle("More options").click();
  await page.getByRole("menuitem", { name: /New Event Spec/ }).click();
  await page.getByLabel("Event spec name").fill(specName);
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page).toHaveURL(/\/specs\/[^/?]+/);
  const specId = new URL(page.url()).pathname.split("/specs/")[1];

  await page.getByTestId("spec-add-server").click();
  const server = page.getByTestId("spec-server-0");
  await server.getByLabel("Key").fill("kafka-prod");
  await server.getByLabel("Protocol").fill("kafka");
  await server.getByLabel("Host").fill("kafka-prod.internal:9092");
  await page.getByTestId("spec-add-operation").click();
  const op = page.getByTestId("spec-operation-0");
  await op.getByLabel("Key").fill("publishOrderCreated");
  await op.getByLabel("Channel").selectOption({ label: `${channelName} — ${address} (kafka/avro)` });
  await op.getByLabel(`${messageName} v1.0`).check();
  await page.getByTestId("spec-save").click();
  await expect(page.getByText("Draft saved")).toBeVisible();

  await page.getByRole("tab", { name: "Diagnostics" }).click();
  await expect(page.getByTestId("diagnostics-list")).toContainText("validates with @asyncapi/parser", { timeout: 90_000 });

  await page.getByTestId("spec-publish").click();
  await page.getByTestId("confirm-publish").click();
  await expect(page.getByText(/Published .* v1\.0/)).toBeVisible({ timeout: 90_000 });

  // 5. Document: download YAML of the stored version.
  await page.goto(`${productUrl}/specs/${specId}?version=1.0&tab=document`);
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByTestId("document-download").click()]);
  expect(download.suggestedFilename()).toBe(`${specName}-1.0.asyncapi.yaml`);
  const yaml = readFileSync((await download.path()) as string, "utf8");
  expect(yaml).toContain("asyncapi: 3.0.0");
  expect(yaml).toContain(`address: ${address}`);
  expect(yaml).toContain("version: '1.0'");

  // 6. Preview renders (React component or the sandboxed iframe fallback).
  await page.getByRole("tab", { name: "Preview" }).click();
  await expect(page.locator(".aui-root, [data-testid=asyncapi-preview-iframe]").first()).toBeVisible({ timeout: 60_000 });

  // 7. REST serves the stored version (session auth).
  const rest = await page.request.get(`/api/v1/event-specs/${specId}?format=json`);
  expect(rest.status()).toBe(200);
  const doc = (await rest.json()) as { asyncapi: string; info: { version: string } };
  expect(doc).toMatchObject({ asyncapi: "3.0.0", info: { version: "1.0" } });

  // 8. Sidebar shows the non-empty events leaves for this product.
  await page.goto(productUrl);
  await expect(page.getByTestId(`product-${f.product.id}-event-specs`)).toBeVisible();
  await expect(page.getByTestId(`product-${f.product.id}-messages`)).toBeVisible();
  await expect(page.getByTestId(`product-${f.product.id}-channels`)).toBeVisible();
});
```

- [ ] **Step 3: Run the E2E spec**

Run: `npx playwright test tests/e2e/events-flow.spec.ts`
Expected: 1 passed. On failure open the trace (`npx playwright show-trace`) — selector drift is fixed in the spec, behavior bugs in the owning task's code.

- [ ] **Step 4: Full verification**

- `npx prisma generate && npx tsc --noEmit` — Expected: no errors.
- `npx eslint src/lib/events src/services/events src/features/events "src/app/(dashboard)/schemas" src/app/api tests/unit tests/integration/services/events tests/e2e/events-flow.spec.ts` — Expected: no errors.
- `npx vitest run` — Expected: only the 8 baseline failures.
- `npx vitest run tests/integration/services/events tests/integration/db --no-file-parallelism` — Expected: all pass (TypeSpec CLI + parser, ~3–5 min).
- `npx next build` — Expected: success. Then `grep -rl "remote-references-are-disabled" .next/static || echo "parser validator not in client bundles"` — Expected: the echo (the server-side `AsyncApiParserValidator` never reaches the browser).
- PGlite smoke: `DB_PROVIDER=pglite npx vitest run tests/integration/db/events-core-pglite.test.ts` — Expected: PASS.

- [ ] **Step 5: Manual smoke** — `npm run dev`, then in the browser: product → New ▸ Channel / Message / Event Spec; Event Spec → Editor → Document (YAML/JSON, copy, download) → Preview → Diagnostics → Publish; `?version=1.0` read-only; sidebar leaves; Enterprise and domain Traits tabs; a cross-product consumer spec (another product's channel + message version) emits with zero errors.

- [ ] **Step 6: Commit**

```bash
git add tests/e2e/helpers/db.ts tests/e2e/events-flow.spec.ts
git commit -m "test(18.6-18.8): events end-to-end flow — publish chain, YAML download, preview, REST, sidebar"
```

---

## Phase 4b exit criteria

- Seven events tables exist on PostgreSQL and PGlite with placement CHECKs, immutability triggers and NO ACTION pin FKs; registry kinds `trait` / `message` / `channel` / `eventSpec` enforce line-unique names.
- Channels, Traits (all levels), Messages and Event Specs have audited CRUD with owner checks (`FORBIDDEN` cross-product), pins mirrored in `SchemaReference`.
- Messages and Event Specs publish with the §6.1 bump rules (+ D6), raise-only bumps and every blocker reported together; Event Spec versions store the parser-validated AsyncAPI document, frozen channels / traits and pinned MessageVersion ids; published documents are never regenerated.
- Draft emission renders payload / headers / key artifacts from pinned entity versions in each channel's format profile (Avro, JSON Schema with local `$defs`, root-first Protobuf) and validates with `@asyncapi/parser`.
- Event Spec page (5 tabs), Message / Channel / Trait pages, workspace Events + Traits tabs, sidebar leaves, New-menu entries, `loading.tsx` for every new route; `GET /api/v1/event-specs/:id`; "Used by" panels.
- `npx tsc --noEmit` clean; `npx vitest run` → 8 baseline failures only; events integration suites green; `npx next build` green; `tests/e2e/events-flow.spec.ts` passes.

## Handoff — how later work plugs in

- **Epic 19 (AsyncAPI import):** `AsyncApi3Adapter.import()` → splitter → `createChannel` / `createMessage` + `publishMessage` (1.0 baseline) / `createTrait` / `createEventSpec` + `updateEventSpecDocument` inside one transaction; set `EventSpec.importedSource` / `sourceVersion`.
- **Epic 20 (visual builder, binding forms):** replace `EventSpecEditor` / the raw JSON `bindings` / `parameters` fields; keep the `updateEventSpecDocumentAction` contract (`EventSpecDocument`, pointer-addressed `details.problems`). Live validation can call `emitEventSpecDraftAction` (debounced) and map `Diagnostic.pointer` to tree nodes.
- **14.5 (`EntityVersionArtifact`):** implement `ArtifactRenderer` backed by the table (fallback to `createArtifactRenderer` on a miss, then store) and inject it through `getSharedArtifactRenderer`; nothing else changes.
- **Governance for MAJOR (14.4 / 18.3):** gate `publishMessage` / `publishEventSpec` when `plan.changeKind === "MAJOR"` — create a `GovernanceRequest` and write the version on approval; `governanceRequestId` columns already exist.
- **Permissions (spec §10):** add a role-at-level check inside `getActionContext` callers (owner `ScopeTarget` is already passed to every mutating action).
- **22.1 drift dashboard:** `SchemaReference` + `MessageResolvedSpec.payload.major` vs the entity's latest version give entity → message → spec drift directly.

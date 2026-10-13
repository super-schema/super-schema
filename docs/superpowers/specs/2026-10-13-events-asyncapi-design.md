# Events (AsyncAPI) & Schema Platform Completeness — Design

- **Date:** 2026-10-13
- **Status:** Approved in conversation (sections 1–7 + backlog). Implementation authorized.
- **Branch:** `feat/events-asyncapi`
- **Scope:** Introduce an "Events" concept (AsyncAPI 3 event specifications) alongside Entities, Data Types and APIs; add the Tenant/Domain/Product placement model; add real entity versioning (Draft + Publish); and close the platform gaps found while designing this (import, formats, APIs, hygiene).

---

## 1. Definitions

| Term | Meaning |
|---|---|
| **Entity** | A core data record definition — a payload, a database table, etc. TypeSpec source (`entities.typespecSource`) is canonical; `fields` is a derived projection. |
| **Data Type** | A custom data type (enum / scalar / union) defined by a tenant, domain or product. Renamed from "Types" in the UI. Tables keep their names (`SharedEnum`, `CustomScalar`, `UnionType`). |
| **API** | Operations exposed over HTTP or gRPC (`ServiceDefinition` / `Operation`). |
| **Message** | Catalog item = an AsyncAPI **Message Object**. Payload / headers / Kafka key each reference a pinned **entity version**. Versioned (Draft + Publish). |
| **Channel** | Catalog item = an AsyncAPI **Channel Object** (address, parameters, bindings) + the payload **format profile** it carries. Not versioned. |
| **Trait** | Catalog item = an AsyncAPI **Message Trait** or **Operation Trait** (e.g. a CloudEvents envelope). Not versioned. |
| **Event Spec** | An event specification document. `specType = "asyncapi@3.0"` today; other spec types plug in later through adapters. Composes catalog Channels / Messages / Traits with operations and server references. Versioned (Draft + Publish). |
| **Server reference** | A pointer to infrastructure (name, protocol, host, pathname, external link). Servers are **not** modeled as entities in Super Schema. |
| **Format profile** | Implementation format + dialect: `avro`, `json-schema` (`draft-07` \| `2020-12`), `protobuf`. |

### Goals
Events must serve all three jobs at once, and enable more later:
- **A. Catalog / governance** — document the event estate (topics, producers/consumers, payload ownership, classification).
- **B. Design-first authoring** — design new events, export AsyncAPI + payload schemas.
- **C. Onboarding** — bulk-import existing AsyncAPI / Avro / Proto estate, then govern and evolve.

### Non-goals (this design)
- Modeling servers / infrastructure as first-class records.
- Schema-registry publishing (Confluent / Apicurio / Pub/Sub) — follow-up candidate (§14, 22.5).
- SDK / code generation per technology — follow-up (22.2).
- `ModelDefinition` (imported non-entity models, hidden in UI) — unchanged.

---

## 2. Decision log

| # | Question | Decision |
|---|---|---|
| Q1 | Primary job of Events | All of A, B, C (+ future uses) |
| Q2 | Unit managed under Events | **Catalog + composed specs** — reusable Messages and Channels; Event Specs compose them; one AsyncAPI doc per spec |
| Q3 | Placement | Overriding-free level model (§4). Data Types + APIs at Domain and Product; Entities, Messages, Channels, Event Specs at Product |
| — | Overriding | **None.** Names unique along a tenant→domain→product line; level only signals breadth of use |
| — | Cross-product / cross-domain references | Allowed, read-only, by ID |
| — | Servers | Referenced, not modeled |
| Q5 | Tenant level | **Data Types + Entities** (+ Traits, §4) |
| Q4 | Payload fidelity | TypeSpec canonical. Every change goes through Super Schema and yields a MAJOR or MINOR version. Specs reference **entity + version + format**; they stay locked until a user moves them |
| Q6 | When versions are cut | **Draft + Publish**; bump auto-classified (major if breaking in *any* supported format); user may raise, never lower; majors go through governance |
| — | Version format | `MAJOR.MINOR`, no patch |
| Q7 | Where format is chosen | **On the Channel** (Message is format-neutral) |
| Q8 | Message contents | Full AsyncAPI Message Object incl. traits (CloudEvents etc.), headers, correlationId, bindings, examples |
| Q9 | Storage / emission architecture | **AsyncAPI-shaped JSON + entity references**; payload schemas still produced by real TypeSpec emitters; doc validated by `@asyncapi/parser` |
| Q10 | What is versioned on the events side | **Messages and Event Specs.** Channels and Traits are live and frozen into each spec version at publish |
| Q11 | Protocols with hand-built forms | **Kafka, Google Pub/Sub, Apache Pulsar**; all others via generic forms generated from `@asyncapi/specs` binding schemas |
| — | Naming | Catalog "Event" renamed **Message**; `EventSpec.specType` added |
| — | JSON Schema dialect | Configurable per channel format profile; `draft-07` default for AsyncAPI compatibility |
| — | Protobuf root message | Industry standard: root first in file (Confluent message index 0) **and** `// @RootNode` (AsyncAPI protobuf-schema-parser) |
| D1 | Story 2-22 conflict | Keep 2-22's explicit Save/Discard UX; **supersede** its "every save creates a version" and "field added = major" rules with Draft + Publish (Epic 14) |

---

## 3. Current state (verified 2026-10-13)

- `Entity` has no kind / level beyond `productId` + transitional `domainId`. Data Types and APIs hang off `Domain` only.
- `Entity.version` is an `Int`; snapshots live in `entity.metadata.versionHistory` (`src/services/version-history/version.service.ts`, "MVP"), field-level only, no TypeSpec source, no frozen Data Types.
- Breaking-change checkers exist: `src/lib/migration/avro-compatibility.ts`, `src/lib/migration/openapi-breaking.ts`; classification via `src/services/classification.service.ts` (`classifyFromDiff`).
- `Operation` requires `httpMethod` / `httpPath` → gRPC not modeled. API CRUD + OpenAPI import landed in `a27e1a7d` (OpenAPI → `@typespec/openapi3` converter → TypeSpec pipeline).
- Importers return a single `ParsedEntity` except TypeSpec / OpenAPI (multi-asset via `createDomainAssetsFromImportAction`). Protobuf importer keeps only the first `message`; Avro nested records and JSON Schema `$defs` do not become entities.
- Emission is strictly per entity (`emitter.service.ts`); no product/spec scope. Compiler reads enums/scalars/unions from entity metadata rather than the Data Type tables.
- `@typespec/events`, `@typespec/streams`, `@typespec/sse` are installed (optional peers of `openapi3`) but cover only SSE-style event unions — no channels, servers, bindings, and no TypeSpec AsyncAPI emitter exists.
- Left nav: "Types" label at `src/app/(dashboard)/schemas/[domainSlug]/domain-workspace.tsx:128` and `src/components/layout/LeftSidebar.tsx:314` (+ `tests/unit/components/left-sidebar-domain-assets.test.tsx`).
- Reserved route slugs: `src/lib/slug.ts` (`RESERVED_SCHEMA_ROUTE_SLUGS = {"type-mappings"}`, `RESERVED_ENTITY_ROUTE_SLUGS = {"new"}`).
- npm registry currently returns 403 for every package (environment issue, user to resolve).

---

## 4. Levels, naming and navigation

### 4.1 Placement matrix

| Kind | Tenant | Domain | Product |
|---|---|---|---|
| Data Types (enum / scalar / union) | ✓ | ✓ | ✓ |
| Entities | ✓ | | ✓ |
| APIs (`ServiceDefinition`) | | ✓ | ✓ |
| Traits | ✓ | ✓ | ✓ |
| Messages, Channels, Event Specs | | | ✓ |

### 4.2 Data model
- `SharedEnum`, `CustomScalar`, `UnionType`, `Entity`, `ServiceDefinition`, and new `Trait` carry: `tenantId` (required), `domainId?`, `productId?`.
- Level is derived: `productId` set → Product; else `domainId` set → Domain; else Tenant.
- Product-level rows always also carry their product's `domainId` (so domain-scoped queries stay simple); tenant-level rows have both `domainId` and `productId` null. Invariant enforced by CHECK: `productId IS NULL OR domainId IS NOT NULL`.
- A DB `CHECK` constraint per table forbids levels the kind does not allow (e.g. `Entity`: tenant or product only; `ServiceDefinition`: domain or product only; `Channel` / `Message` / `EventSpec`: `productId NOT NULL`).
- Backfill: `tenantId` from the parent domain; rows stay at their current level. `Entity.domainId` / `productId` become nullable to permit tenant-level entities.
- `ServiceDefinition.scope` (`DOMAIN | ENTITY`) and `entityId` remain for entity-scoped APIs.
- Migrations authored against PostgreSQL (`npm run db:migrate`), applied to both providers (PGlite via `src/lib/pglite-migrate.ts`).

### 4.3 Name uniqueness (no overriding)
- A name is unique across **all kinds** along one line: tenant ∪ that domain ∪ one of its products. (An Entity and a Data Type cannot both be `Address` in the same line — they would collide in one TypeSpec namespace.)
- Sibling domains and sibling products may reuse names.
- Not expressible as a DB unique constraint → enforced in a `name-registry` service inside a transaction holding a per-tenant advisory lock (`pg_advisory_xact_lock(hashtext(tenantId))`).
- Existing violations are surfaced via a **conflict report** (admin view + CLI script); never auto-renamed. Only new conflicts are blocked.

### 4.4 Cross-references and namespaces
- References are by ID, read-only across products/domains.
- Generated TypeSpec places each item in a namespace derived from its level path, PascalCased slugs: `Acme.Payments.Checkout.Order`, `Acme.CustomerId` (tenant level).
- Compiler resolves Data Types from their tables (with levels) instead of `entity.metadata.custom.{enums,scalars,unions}`.

### 4.5 Routes

| URL | Shows |
|---|---|
| `/schemas/enterprise` | Tenant level — tabs: Data Types, Entities, Traits |
| `/schemas/enterprise/entities/[entityId]` | Tenant entity (same entity workspace component as product entities) |
| `/schemas/enterprise/new` | New tenant-level entity |
| `/schemas/[domainSlug]` | Product grid + tabs: Products, Data Types, APIs, Traits (`?tab=`) |
| `/schemas/[domainSlug]/[productSlug]` | Tabs: Entities, Data Types, APIs, Events (Event Specs, Messages, Channels), Traits |
| `/schemas/[domainSlug]/[productSlug]/[entityId]` | Unchanged |
| `/schemas/[domainSlug]/[productSlug]/specs/[specId]` | Event Spec page |
| `/schemas/[domainSlug]/[productSlug]/messages/[messageId]` | Message page |
| `/schemas/[domainSlug]/[productSlug]/channels/[channelId]` | Channel page |
| `/schemas/[domainSlug]/[productSlug]/traits/[traitId]` | Product trait page (tenant/domain traits under their level) |

- Reserved slugs: add `enterprise` to `RESERVED_SCHEMA_ROUTE_SLUGS`; add `events`, `channels`, `messages`, `specs`, `traits`, `data-types`, `apis` to the entity-route reserved set.
- **One URL builder:** `assetHref(asset, { version? })` in `src/lib/navigation/asset-href.ts` produces the canonical URL for every kind × level. Sidebar, command palette, cards, breadcrumbs, cross-product references and version deep links (`?version=2.1`) use it exclusively. The legacy 2-segment redirect stays.

### 4.6 Navigation
- Rename "Types" → **"Data Types"**; New menu groups enum/scalar/union under **New Data Type ▸**.
- New **Enterprise** section at the top of the left nav (tenant Data Types, Entities, Traits).
- Empty categories are hidden at every level, and so is a domain's product list when it has none.
- Each level's **New…** menu offers exactly the kinds allowed at that level (§4.1).

### 4.7 Navigation quality bar
Every navigation path and link must work. Enforced by: unit tests for `assetHref` (every kind × level × version); Playwright click-through of every sidebar node and breadcrumb plus a cross-product reference; Playwright link crawl visiting every rendered `href` on each workspace page (no 404s).

---

## 5. Entity versioning (Draft + Publish)

### 5.1 Model
- The `Entity` row (`typespecSource` + derived `fields`) is the **draft**. New columns: `latestVersionId String?`, `hasUnpublishedChanges Boolean @default(true)`.
- New immutable table **`EntityVersion`**:
  - `id`, `entityId`, `major Int`, `minor Int`, `sequence Int` (monotonic publish counter; `Entity.version` mirrors the latest sequence so existing Int consumers — `EmissionTargetStatus`, `DeploymentRecord` — keep working)
  - `resolvedSource String` — entity TypeSpec + frozen copies of every Data Type it uses
  - `fieldSnapshot Json` — field projection for diff UI
  - `changeKind` (`MAJOR | MINOR | INITIAL`), `compatReport Json` (per-format findings), `changeSummary String?`
  - `publishedById`, `publishedAt`, `governanceRequestId String?`
  - Unique `(entityId, major, minor)` and `(entityId, sequence)`.
- Entity→entity references: at publish, a reference field pins the referenced entity's **latest published version**, recorded in `SchemaReference` (role `FIELD`). If the referenced entity was never published, publish is blocked ("Publish B first").
- **`EntityVersionArtifact`** `(versionId, format, dialect, emitterPackage, emitterVersion, output, createdAt)`: generated on first use, then stored and reused, so a pinned version always renders identically even after emitter upgrades.
- Data Types are **not** versioned. Editing one sets `hasUnpublishedChanges` on the drafts of entities that use it; published versions keep their frozen copy.

### 5.2 Publish flow
1. Compile the draft with the real compiler (`compileTypeSpecWithGovernance`).
2. Build the resolved source (entity + Data Type closure).
3. Diff against the last published version.
4. Compatibility checks: Avro (existing `avro-compatibility.ts`), JSON Schema (new rule table), Proto (new rule table: field-number reuse, type change, removal without `reserved`).
5. Suggest **MAJOR** if breaking in any format, else **MINOR**. First publish = `1.0` (`INITIAL`).
6. User confirms; may raise MINOR → MAJOR, never lower.
7. MAJOR → `GovernanceRequest` (generalized with `subjectKind` / `subjectId`); version row created on approval. MINOR → published immediately.

### 5.3 UI
- Entity header: `Draft · unpublished changes · latest v2.1`.
- Publish dialog: diff, per-format compatibility findings, suggested bump, raise-only control.
- Version history tab lists `EntityVersion` rows; any version viewable read-only via `?version=2.1`.
- Story 2-22's explicit Save/Discard stays; saving updates the draft only.

### 5.4 Migration
- Precondition: Story 12.7 (batch TypeSpec source generation) has run, so every entity has `typespecSource`.
- Every `ACTIVE` entity gets an `INITIAL 1.0` version from its current state; `DRAFT` entities stay unpublished.
- Legacy `metadata.versionHistory` stays visible read-only as "Legacy history"; not converted.

---

## 6. Events data model

All new tables carry the level columns from §4.2.

### 6.1 Tables

**`Channel`** (product, live)
- `name`, `address` (may contain `{param}`), `protocol` (`kafka` \| `googlepubsub` \| `pulsar` \| any AsyncAPI protocol string), `format` (`avro` \| `json-schema` \| `protobuf`), `formatDialect String?` (`draft-07` \| `2020-12` for JSON Schema)
- `spec Json` — AsyncAPI Channel Object minus `messages` (title, summary, description, parameters, bindings, tags, externalDocs)
- **`ChannelMessage(channelId, messageId)`** — messages *allowed* on the channel, unpinned; may reference Messages from other products.

**`Trait`** (tenant / domain / product, live)
- `kind` (`MESSAGE` \| `OPERATION`), `name`, `spec Json` (AsyncAPI trait object)
- Message trait headers may pin an entity version (e.g. tenant-level `CloudEventsHeaders@1.0`) via `SchemaReference` (role `HEADERS`).

**`Message`** (product, draft) + **`MessageVersion`** (immutable)
- Draft: `name`, `spec Json` (AsyncAPI Message Object: name, title, summary, description, contentType, correlationId, tags, externalDocs, bindings, examples, trait IDs), `payloadEntityId` / `payloadEntityVersionId?`, `headersEntityId?` / `headersEntityVersionId?`, `keyEntityId?` / `keyEntityVersionId?`, `latestVersionId?`, `hasUnpublishedChanges`.
- Version: `major`, `minor`, `sequence`, `resolvedSpec Json` (with pinned `EntityVersion` IDs), `changeKind`, `compatReport`, publish metadata.
- Pickers list **published** entity versions (default latest). A draft may reference an unpublished entity for preview only; publishing is blocked until every pin is published. "Newer version available" badge when a pin is behind.
- **Bump rules:** MAJOR if payload/headers/key pin moves to a new *major* entity version, a trait is removed, or `contentType` / `correlationId` changes. Otherwise MINOR (minor entity bump, docs, examples, tags).

**`EventSpec`** (product, draft) + **`EventSpecVersion`** (immutable)
- Draft: `name`, `specType String @default("asyncapi@3.0")`, `document Json`:
  ```ts
  type EventSpecDocument = {
    info: { title: string; description?: string; contact?: object; license?: object;
            tags?: object[]; externalDocs?: object };
    defaultContentType?: string;
    servers: Array<{ key: string; protocol: string; host: string; pathname?: string;
                     protocolVersion?: string; description?: string; externalRef?: string }>;
    operations: Array<{ key: string; action: "send" | "receive"; channelId: string;
                        messageVersionIds: string[]; traitIds: string[];
                        summary?: string; description?: string; bindings?: object;
                        reply?: { channelId?: string; messageVersionIds?: string[] } }>;
    components?: { correlationIds?: object; parameters?: object;
                   securitySchemes?: object; operationBindings?: object };
  };
  ```
  plus `latestVersionId?`, `hasUnpublishedChanges`, `importedSource String?`, `sourceVersion String?`.
- **Every payload-bearing message must be a catalog Message** (keeps entity links + versioning). Import converts inline messages into catalog Messages.
- Version: `major`, `minor`, `sequence`, `document Json` (**fully resolved AsyncAPI document**), `frozenChannels Json`, `frozenTraits Json`, pinned `MessageVersion` IDs (also in `SchemaReference`), publish metadata. `major.minor` → AsyncAPI `info.version`.
- **Bump rules:** MAJOR if an operation is removed, a channel address changes, a referenced message moves to a new major, or a message is removed from an operation. Otherwise MINOR.

**`SchemaReference`** — one edge table for every pinned link
- `fromKind` (`ENTITY_VERSION` \| `MESSAGE` \| `MESSAGE_VERSION` \| `EVENT_SPEC` \| `EVENT_SPEC_VERSION` \| `TRAIT`; `OPERATION` later), `fromId`
- `role` (`FIELD` \| `PAYLOAD` \| `HEADERS` \| `KEY` \| `MESSAGE`)
- `toKind` (`ENTITY_VERSION` \| `MESSAGE_VERSION`), `toId`
- `isDraft Boolean`
- Index on `(toKind, toId)` → "who uses X", impact analysis, drift dashboard.
- Deletes restricted: a version referenced by any published version cannot be deleted (deprecate instead).

### 6.2 Worked example

Setup: **Checkout** product (payments domain) publishes `OrderCreated` to Kafka topic `payments.orders.v1`; **Fraud** product (risk domain) consumes it. Tenant-level `CloudEventsHeaders@1.0` entity and `CloudEvents` trait exist.

| Record | Level | Content |
|---|---|---|
| Entity `Order@2.1` | Checkout | Payload shape (TypeSpec) |
| Entity `OrderKey@1.0` | Checkout | Kafka key shape |
| Trait `CloudEvents` | Tenant | Message trait; headers → `CloudEventsHeaders@1.0` |
| Message `OrderCreated@1.3` | Checkout | payload → `Order@2.1`, key → `OrderKey@1.0`, traits [CloudEvents] |
| Channel `orders` | Checkout | address `payments.orders.v1`, kafka, avro, 12 partitions |
| Event Spec `checkout-service@2.0` | Checkout | server ref `kafka-prod`; **send** `OrderCreated@1.3` on `orders` |
| Event Spec `fraud-scorer@1.0` | Fraud | **receive** `OrderCreated@1.3` on Checkout's `orders` (cross-product, read-only) |

`checkout-service@2.0` emits:

```yaml
asyncapi: 3.0.0
info:
  title: checkout-service
  version: '2.0'
servers:
  kafka-prod:
    host: kafka-prod.internal:9092
    protocol: kafka
channels:
  orders:
    address: payments.orders.v1
    messages:
      OrderCreated:
        $ref: '#/components/messages/OrderCreated'
    bindings:
      kafka: { partitions: 12 }
operations:
  publishOrderCreated:
    action: send
    channel: { $ref: '#/channels/orders' }
    messages:
      - $ref: '#/channels/orders/messages/OrderCreated'
components:
  messages:
    OrderCreated:
      contentType: avro/binary
      traits:
        - $ref: '#/components/messageTraits/CloudEvents'
      payload:
        schemaFormat: application/vnd.apache.avro+json;version=1.9.0
        schema: { type: record, name: Order, namespace: acme.payments.checkout, fields: [] }
      bindings:
        kafka:
          key: { type: string }
  messageTraits:
    CloudEvents:
      headers:
        type: object
        properties: { ce_id: {type: string}, ce_type: {type: string}, ce_source: {type: string} }
```

`fraud-scorer@1.0` emits the same `channels` / `components` blocks (frozen copies of Checkout's records) with `action: receive`.

---

## 7. Emission

### 7.1 Adapter
```ts
interface EventSpecAdapter {
  specType: string;                                   // "asyncapi@3.0"
  emit(input: ResolvedEventSpec): Promise<Result<{ json: string; yaml: string; document: object }>>;
  validate(document: object): Promise<Result<Diagnostic[]>>;
  import(content: string): Promise<Result<ImportedEventSpec>>;
}
```
`AsyncApi3Adapter` is the first implementation. Lives in `src/lib/event-specs/`. This is a **new emission scope (whole spec)**, separate from per-entity targets in `src/lib/schema-targets/catalog.ts`.

### 7.2 Pipeline — `emitEventSpec(specId, { versionId? } | { draft: true })`
1. **Published version** → return the stored document; never regenerated.
2. **Draft** → resolve operations → Channels (incl. cross-product) → pinned `MessageVersion`s → Traits. Draft preview may use draft Messages, flagged "unpublished".
3. **Schemas** from `EntityVersionArtifact` in the channel's format profile:
   - Headers always JSON Schema (AsyncAPI requires an object schema).
   - Kafka key: Avro when the channel is Avro, otherwise JSON Schema.
4. **`schemaFormat`:**
   - avro → `application/vnd.apache.avro+json;version=1.9.0`
   - protobuf → `application/vnd.google.protobuf;version=3`
   - json-schema draft-07 → `application/schema+json;version=draft-07`
   - json-schema 2020-12 → `application/schema+json;version=2020-12`
5. **Assembly:** channels, messages, traits into `channels` / `components`; server refs into `servers`. Name clashes qualified: two channels named `orders` from different products → `checkout.orders`; same Message in two formats → `OrderCreated_avro` / `OrderCreated_json`.
6. **Validate** with `@asyncapi/parser` (Avro + Protobuf schema parsers registered). Errors block publish; warnings shown.
7. **Serialize** YAML (`yaml` package) + JSON.

### 7.3 Format profiles
- **JSON Schema:** generate 2020-12 with `@typespec/json-schema`; down-convert to draft-07 when the profile asks (`$defs`→`definitions`, `prefixItems`→`items` array, `dependentRequired`/`dependentSchemas`→`dependencies`, drop unsupported keywords with a warning). New dialects plug in without schema changes.
- **Protobuf:** one **self-contained** `.proto` per payload — root message **first** (Confluent message index 0) and annotated `// @RootNode` (AsyncAPI protobuf-schema-parser: root = message not referenced by others; `@RootNode` disambiguates); referenced entities inlined; imports limited to `google/protobuf/*`, `google/type/*`, `validate/validate.proto`, `buf/validate/validate.proto` (only imports the parser accepts). Verified against the `asyncapi/protobuf-schema-parser` README on 2026-10-13.
- **Avro:** referenced entities inlined as named records (first occurrence defines, later occurrences reference by full name).

### 7.4 Spec publish & surfaces
- Same flow as entities: diff vs last version, §6.1 bump rules, suggest, governance for MAJOR → `EventSpecVersion`.
- Event Spec page tabs: **Editor · Document** (YAML/JSON, copy, download) **· Preview · Versions · Diagnostics**.
- REST: `GET /api/v1/event-specs/:id?version=2.0&format=yaml|json`.

---

## 8. AsyncAPI import

### 8.1 Entry points
- Product **New ▸ Event Spec** → **Import** (upload / paste) or **Build visually**.
- `ImportFormat` += `"asyncapi"`; detector sniffs a top-level `asyncapi:` key (YAML or JSON); `ImportUploader` accepts `.yaml`, `.yml`, `.json`.
- Server action `importAsyncApiDocumentAction` (parser is Node-only).

### 8.2 Pipeline
1. **Parse** with `@asyncapi/parser` v3 + Avro/Protobuf schema parsers. 2.x documents are converted to 3.0 first with `@asyncapi/converter`. **Remote `$ref` resolution disabled** (SSRF). Multi-file docs later via `@asyncapi/bundler`.
2. **Diagnostics:** errors stop the import; warnings carry to review.
3. **Split into proposed assets:**
   - Channels → `Channel` (format inferred from messages' `schemaFormat`; mixed formats on one channel → warning).
   - Messages (component + inline) → `Message`, de-duplicated by name + payload hash.
   - Message / operation traits → `Trait`.
   - Payload / headers / key schemas → importer for their `schemaFormat` (Avro, Protobuf, JSON Schema) → **all** resulting entities incl. nested (Epic 15).
   - Info, servers, operations → `EventSpec` draft; servers → server references.
4. **Match against existing records** (§4.3 rules):
   - New → create.
   - Identical → link.
   - Different → user picks link / new draft of existing / rename.
   - Owned by another product → link read-only to the owner's record; never duplicate (keeps consumer imports from forking producer definitions).
5. **Review:** `AsyncApiImportReviewScreen` (modeled on `TypeSpecImportReviewScreen`): tree Spec → operations → channels → messages → entities; per item action (create / link / rename), level for traits and entities, warnings.
6. **Persist:** `createEventAssetsFromImportAction`, one transaction. New entities and Messages published as `1.0` (imported baseline — pins need published versions). Event Spec saved as **draft**. Source `info.version` → `sourceVersion`; original text → `importedSource`.

### 8.3 Fidelity
Payloads regenerate from entities (every change flows through Super Schema). Anything TypeSpec cannot represent is listed as a review warning. Round-trip suite on official AsyncAPI examples: import → emit → semantically equivalent.

---

## 9. Visual Event builder

- **Main surface:** Event Spec **Editor** tab. Left outline (Info · Server refs · Operations · Channels · Messages · Traits); center form for the selected node; right toggle between live **Document** (YAML) and **Preview** (same pattern as `VisualSchemaBuilder`'s live detail panel).
- **Operations:** add send/receive → pick Channel (own product or any product via search; foreign channels read-only with owner badge + "Open in owner" via `assetHref`) or create inline → pick allowed Messages with a version picker, or create inline.
- **Inline editors** (reused on standalone Message / Channel / Trait pages; save straight to catalog records):
  - Channel: name, address (`{param}` detection → parameters form), protocol, format profile, binding form, allowed messages.
  - Message: name, title, summary, contentType (defaulted from format), payload / headers / key (key only for Kafka) as entity + published-version pickers; **"New payload entity"** opens the existing entity wizard in a drawer; correlationId builder (`$message.header#/ce_id`); traits (tenant / domain / product); examples validated against the payload JSON Schema; tags, externalDocs.
  - Trait: kind, headers entity, remaining AsyncAPI trait fields.
- **Binding forms:**
  - Kafka — channel: topic, partitions, replicas, topicConfiguration; operation: groupId, clientId; message: key, schemaIdLocation, schemaIdPayloadEncoding, schemaLookupStrategy.
  - Google Pub/Sub — channel: labels, messageRetentionDuration, messageStoragePolicy, schemaSettings; message: attributes, orderingKey, schema.
  - Pulsar — channel: namespace, persistence, compaction, geo-replication, retention, ttl, deduplication.
  - All other protocols — generic form generated from `@asyncapi/specs` binding JSON Schemas (object / string / number / boolean / enum / array), raw JSON editor (schema-validated) as fallback.
- **Live validation:** debounced server emit + parse; diagnostics mapped by JSON pointer to tree nodes (badges).
- **Preview:** `@asyncapi/react-component`, client-only (`ssr: false`). Fallback if React 19 is unsupported: the component's standalone browser bundle in a sandboxed iframe.
- **YAML view:** existing code viewer from the TypeSpec Source tab (no Monaco).

---

## 10. Error handling, security, permissions

- Every service returns `Result<T, ServiceError>`; never throws.
- **Publish blockers** reported together: unpublished pins, parser errors, name conflicts, pending governance.
- **Import:** per-item failures do not abort the whole import; review shows them. Persist is one transaction, rolled back on failure.
- **Security:** remote `$ref` off; upload cap 5 MB; writes to another product's records return `FORBIDDEN`.
- **Permissions:** editing at a level requires a role at that level or above (`UserRole` scoping by `tenantId` / `domainId` / `productId`).
- All mutations wrapped with `withAudit`.

---

## 11. Testing

- **Unit (Vitest):** level resolution, name uniqueness, `assetHref`, compatibility rule tables (Avro / JSON Schema / Proto), bump classifier, resolved-source builder, AsyncAPI assembler (golden files), `schemaFormat` mapping, name-clash qualification, draft-07 down-converter, proto `@RootNode` writer, import splitter, catalog matcher.
- **Integration:** real compiler + real emitters → AsyncAPI document → `@asyncapi/parser` reports zero errors (Avro, JSON; Proto once 16.1 lands); import → emit round-trip on official AsyncAPI examples; migrations on **both PGlite and PostgreSQL**. The parser is never mocked in integration tests.
- **E2E (Playwright):** nav click-through + link crawl; entity → publish 1.0 → message → channel → spec → publish → download YAML; AsyncAPI import → review → persist → preview renders; cross-product consumer spec.

---

## 12. Build order & dependencies

1. 21.5 (Story 12.7 batch migration) + Epic 13 (levels, nav).
2. Epic 14 (versioning).
3. 16.2 + 16.3 (format profiles).
4. Epic 18 (events core).
5. Epics 19 (import) and 20 (builder) in parallel.

Parallel once Epic 13 is done: Epic 15, Epic 17, rest of Epic 16. Epic 22 last.

**External blockers:** npm registry access before 15.1 (`protobufjs`), 18.5, Epic 19, 20.5. 16.1 blocks Proto payloads only.

**Packages to add** (pending registry): `@asyncapi/parser`, `@asyncapi/avro-schema-parser`, `@asyncapi/protobuf-schema-parser`, `@asyncapi/converter`, `@asyncapi/react-component`, `@asyncapi/specs`, `protobufjs`. Later: `@asyncapi/modelina`, `@asyncapi/bundler`.

---

## 13. Open items & risks

| ID | Item | Mitigation |
|---|---|---|
| O1 | `@typespec/protobuf` fails on `numeric` / `utcDateTime` (compiler stdlib scalar chain) | Story 16.1; Proto payloads blocked until fixed; same class of problem expected for every new format → type-mapping gap tracking (16.9) |
| O2 | `@asyncapi/react-component` vs React 19 | Standalone bundle in sandboxed iframe |
| O3 | AsyncAPI parser support for JSON Schema 2020-12 | Default profile `draft-07`; 2020-12 selectable |
| O4 | npm registry 403 | User resolving; blocked stories listed in §12 |
| O5 | Existing cross-kind name conflicts | Conflict report; manual cleanup; only new conflicts blocked |
| O6 | Emitter output drift across package upgrades | `EntityVersionArtifact` stores outputs per emitter version |
| O7 | `@typespec/db` broken (no committed source) → bigquery / spanner / postgres targets fail | Story 16.4 |

---

## 14. Backlog

Status legend: **new** · **done** (commit) · **open** (unknown fix) · **blocked** (external).

### Epic 13 — Levels, naming and navigation
| ID | Story | Status |
|---|---|---|
| 13.1 | Rename Types → Data Types; "New ▸ Data Type" grouping | new |
| 13.2 | Level columns (`tenantId`, `domainId?`, `productId?`) on Data Types, Entities, APIs; CHECK constraints; backfill migration (both providers) | new |
| 13.3 | Name-registry service (line uniqueness, advisory lock) + conflict report | new |
| 13.4 | Level-derived TypeSpec namespaces; Data Types resolved from tables, not entity metadata | new |
| 13.5 | Enterprise workspace + routes; reserved slugs | new |
| 13.6 | Domain tabs (Products / Data Types / APIs / Traits) and product tabs | new |
| 13.7 | `assetHref()` URL builder; migrate every link site | new |
| 13.8 | Left nav: hide empty categories, Enterprise section, level-aware New menus | new |
| 13.9 | Playwright nav click-through + link crawl | new |

### Epic 14 — Entity Versioning (Draft + Publish)
| ID | Story | Status |
|---|---|---|
| 14.1 | `EntityVersion` table + draft pointers (supersedes `metadata.versionHistory`; delivers 12.3's missing source snapshot) | new |
| 14.2 | Resolved-source builder (frozen Data Types); entity→entity pins via `SchemaReference` | new |
| 14.3 | Compatibility checkers: JSON Schema + Proto rule tables; reuse Avro checker; bump suggestion | new |
| 14.4 | Publish dialog + flow; generalize `GovernanceRequest` (`subjectKind`/`subjectId`); MAJOR approval | new |
| 14.5 | `EntityVersionArtifact` frozen outputs | new |
| 14.6 | Version history tab + `?version=` read-only view; legacy history | new |
| 14.7 | Migration: `ACTIVE` → `1.0`; `sequence` mirrors `Entity.version` | new |
| 14.8 | Reconcile Story 2-22: keep Save/Discard; replace save-creates-version + classification rules | new |

### Epic 15 — Import completeness
| ID | Story | Status |
|---|---|---|
| 15.1 | Proto importer on `protobufjs`: all messages, nested, enums, oneof, maps | blocked (registry) |
| 15.2 | Proto `service`/`rpc` → gRPC APIs (needs 17.1) | new |
| 15.3 | Avro nested records / enums / fixed → separate entities + references | new |
| 15.4 | JSON Schema `$defs` / `$ref` → separate entities | new |
| 15.5 | Generic multi-asset review screen for every format | new |
| 15.6 | Wizard passes `format` (`EntityCreationWizard.tsx:516`); uploader + detector accept `.json` / `.yaml` / `.yml` | new |
| 15.7 | Bulk import persists (`handleConfirmBulk` is a no-op) | new |
| 15.8 | Record real `sourceFormat` on imported assets (hard-coded `"typespec"`) | new |
| 15.9 | TypeSpec importer extracts visibility + `@extension` | new |

### Epic 16 — Format and emitter completeness
| ID | Story | Status |
|---|---|---|
| 16.1 | Protobuf scalar mapping (`numeric`, `utcDateTime`, …) | open |
| 16.2 | JSON Schema dialect format profiles + draft-07 down-converter | new |
| 16.3 | Self-contained proto per payload (root first, `// @RootNode`, inline refs) | new |
| 16.4 | Fix broken `@typespec/db` → unblock bigquery / spanner / postgres | new |
| 16.5 | Declare `@typespec/{avro,java-pojo,events,http,rest,openapi}` in `package.json` | new |
| 16.6 | Replace invalid `@tag("classification:…")` on properties with an enterprise decorator; remove strip hack; keep paste-import round trip | new |
| 16.7 | Multi-model DB emit: FKs, `@interleave`, enums, maps | new |
| 16.8 | Multi-file artifact support → enable http-client / server SDK targets | new |
| 16.9 | Per-format type-mapping gap tracking per entity version (feeds drift dashboard) | new |
| 16.10 | Mount `EmissionPreviewPanel` in entity workspace; un-`fixme` E2E emit leg | new |

### Epic 17 — APIs completeness
| ID | Story | Status |
|---|---|---|
| 17.1 | `Operation.protocol` (`http` \| `grpc`), gRPC fields (service, rpc, streaming mode); HTTP fields optional | new |
| 17.2 | API CRUD persistence (ApiTab / DomainApisTab wired) | done (`a27e1a7d`) |
| 17.3 | OpenAPI importer | done (`a27e1a7d`) |
| 17.4 | Operation param / response types → `SchemaReference` (entity + version + format) | new |
| 17.5 | Service-scope emission: OpenAPI from service tables; gRPC `.proto` service | new |
| 17.6 | Remove or repurpose unused `InterfaceDefinition` | new |

### Epic 18 — Events core
| ID | Story | Status |
|---|---|---|
| 18.1 | Prisma: `Channel`, `ChannelMessage`, `Trait`, `Message`/`MessageVersion`, `EventSpec` (`specType`)/`EventSpecVersion`, `SchemaReference` | new |
| 18.2 | Services + server actions (Result pattern, audit) | new |
| 18.3 | Message + Event Spec publish, bump rules, governance | new |
| 18.4 | `EventSpecAdapter` + `AsyncApi3Adapter` emit pipeline | new |
| 18.5 | Validation via `@asyncapi/parser` + schema parsers; diagnostics | blocked (registry) |
| 18.6 | Event Spec page (Editor / Document / Preview / Versions / Diagnostics) | new |
| 18.7 | REST `GET /api/v1/event-specs/:id` | new |
| 18.8 | Product nav group "Events" (Event Specs, Messages, Channels) + Traits | new |
| 18.9 | "Who uses X?" lookup + impact analysis via `SchemaReference` | new |

### Epic 19 — AsyncAPI import
| ID | Story | Status |
|---|---|---|
| 19.1 | Format detection + uploader | new |
| 19.2 | Server action: parser, converter (2.x), remote `$ref` off | blocked (registry) |
| 19.3 | Splitter (document → assets) | new |
| 19.4 | Catalog matcher | new |
| 19.5 | `AsyncApiImportReviewScreen` | new |
| 19.6 | Persist transaction (1.0 baseline, spec draft) | new |
| 19.7 | Round-trip suite on official AsyncAPI examples | blocked (registry) |

### Epic 20 — Visual Event builder
| ID | Story | Status |
|---|---|---|
| 20.1 | Event Spec editor (outline, forms, live document) | new |
| 20.2 | Inline Channel / Message / Trait editors | new |
| 20.3 | Binding forms: Kafka, Google Pub/Sub, Pulsar | new |
| 20.4 | Generic binding form from `@asyncapi/specs` | blocked (registry) |
| 20.5 | Preview via `@asyncapi/react-component` (iframe fallback) | blocked (registry) |

### Epic 21 — Cleanup
| ID | Story | Status |
|---|---|---|
| 21.1 | Remove orphaned `DomainModelsTab` / `DomainDecoratorsTab` + unused props; decide `ModelDefinition` | new |
| 21.2 | `ImportDialog` (unmounted) — remove or remount | new |
| 21.3 | Outdated copy: `TemplateSelector` ("Avro/Proto coming soon"), `VisualSchemaBuilder/types.ts` header | new |
| 21.4 | Pre-existing failing test: `e2e-critical-flows` slug `orderid` vs `order-id` | new |
| 21.5 | Story 12.7 one-time TypeSpec-source batch migration (before 14.7) | new |
| 21.6 | 12.2 / 12.3 leftovers: `ICompilerService`; drop `EmissionTargetStatus.formatOptions` | new |

### Epic 22 — Follow-ups enabled by this work
| ID | Story |
|---|---|
| 22.1 | Drift dashboard (entity → message → spec version drift; cross-format differences per entity version) |
| 22.2 | Code generation via `@asyncapi/modelina` |
| 22.3 | Multi-file AsyncAPI import via `@asyncapi/bundler` |
| 22.4 | Version-level deprecation (entity / message / spec versions) |
| 22.5 | Schema-registry publishing (Confluent, Apicurio, Pub/Sub) — candidate; product brief lists as out of scope |
| 22.6 | Rollup reporting Entity → Product |
| 22.7 | Additional event spec types via `specType` adapters |

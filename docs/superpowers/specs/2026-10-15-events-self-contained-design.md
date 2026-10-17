# Events — self-contained Event + visual AsyncAPI builder

Status: **as built, 2026-10-16** (merged to `main`, including the completion round: publish and versions, used-by, external-reference UI, in-app leave guard, product contact editing). See `docs/events/REVIEW.md` for the review map and the known gaps. Changes since the original design: the payload format follows the **message** (Auto / explicit representation) instead of the channel (Q7 superseded); the legacy Message/Channel catalog tables, services and pages were removed (guarded migration `20261020_drop_legacy_event_catalog`); traits are presented as **Message properties (Trait)** with built-in CloudEvents 1.0 and W3C Trace Context (read-only, properties shown in the UI) and a single + Add flow; CodeMirror 6 is installed and powers the JSON fields and the live code panel; products have Engineering Lead, Manager and Team emails.
Supersedes, in `2026-10-13-events-asyncapi-design.md`: decision **Q2** (catalog + composed specs), **Q10** (Messages versioned), the Message/Channel/product-Trait rows of **§4.1**, the `/messages`, `/channels`, product `/traits` routes of **§4.5**, and the Message/Channel/Trait tables and `EventSpecDocument` shape of **§6.1**.
Unchanged from that spec: levels and name uniqueness (§4.2–4.4), Draft + Publish `MAJOR.MINOR`, entity-version pinning, TypeSpec-canonical payloads (Q4), emission pipeline (§7).

## 1. Intent

User, verbatim in substance: *"We only need New Event in the menu — not event spec, channel or trait; those are sub-parts. Under the event you pick the spec to follow (AsyncAPI). AsyncAPI then has all the parts the user provides visually — metadata, channels, messages, traits — and the user picks an entity as the payload."* Later: *servers/channels/other metadata may come from an infrastructure repo; for now the user types them. Use the best possible input components so entry is easy and error-free.*

Success: one **New Event** entry; one Event page that is the whole AsyncAPI document authored visually; no stand-alone Message / Channel / product-Trait assets; every field uses a component that prevents invalid input rather than reporting it afterwards; infra-sourced metadata can be plugged in later without reshaping the document.

## 2. Decisions

| # | Decision |
|---|---|
| E1 | The **Event** is the unit. Messages, channels, operations, servers, local traits are *inside* its document. |
| E2 | **Self-contained document** (option 1 of the chat proposal). Reuse = copy; cross-product consumption = a pinned, read-only **external reference** to a *published* event version. |
| E3 | **One MAJOR.MINOR per event.** Message-level versions disappear. Entity pins stay per message. |
| E4 | Tenant/Domain **Trait library stays**; events pick library traits or define local ones. Product-level standalone Traits are removed. |
| E5 | `EventSpec` table keeps its name and ids (UI word "Event"); `specType` selects the builder. Only `asyncapi@3.0` exists. |
| E6 | **Operations** are their own builder section (AsyncAPI 3 needs them for send/receive). |
| E7 | Infra-owned items carry optional `origin`; a provider seam is specified but **no provider framework is built now** (manual entry only). |
| E8 | Input components follow five rules (§7.2). **CodeMirror 6** is the JSON editor for Advanced fields, behind a `JsonEditor` wrapper. |
| E9 | Intra-document references are by **local key**, never DB id. Key rename rewrites references. |

## 3. Information architecture

- **Menu** (product level): New Entity · New Custom Data Type · New API · **New Event**. Removed: New Event Spec, New Message, New Channel, product-level New Trait. Tenant/Domain keep "New Trait" (library).
- **New Event dialog:** name, description, spec format (radio cards; AsyncAPI 3.0 only, enabled). No "Import existing…" link yet: the AsyncAPI importer is not built (`AsyncApi3Adapter.import()` returns `NOT_IMPLEMENTED`, Epic 19) — the link is added when that importer exists.
- **Events tab** (product): one flat list — name, spec badge, version, Draft badge, channel/message/operation counts. No Specs/Messages/Channels sections.
- **Event page** `/schemas/[d]/[p]/events/[eventId]` — header (name, spec badge, version, Draft indicator, Save, Publish); tabs `?tab=design|docs|versions|used-by` (no Source tab: the live Code panel is the source view and Versions → View shows a published version's code); Design renders the builder registered for `specType`; deep link `?section=<section>&item=<key>`.
- **Redirects:** `/specs/[id]` → `/events/[id]` (same id). Old `/messages/*`, `/channels/*`, product `/traits/*` → Events list with a one-time notice ("moved into events"); no id mapping is kept.
- All URLs through `assetHref()`; reserved slugs already include `events`.

## 4. Event document v2

```ts
type EntityPin = { entityId: string; entityVersionId: string | null }; // null = explicitly unpinned (existing semantics)
type Origin = { provider: string; ref: string; syncedAt: string };      // absent = typed by hand

type EventSpecDocument = {
  documentVersion: 2;   // discriminates from the legacy catalog-id shape until the legacy code is removed (§10)
  info: { title: string; description?: string; contact?: object; license?: object; tags?: object[]; externalDocs?: object };
  defaultContentType?: string;
  servers: Array<{ key; protocol; host; pathname?; protocolVersion?; description?; externalRef?; origin?: Origin }>;
  channels: Array<{
    key: string;
    // where it lives — infra-owned
    address: string | null; protocol: string; serverKeys: string[]; bindings?: object; origin?: Origin;
    // what it carries — contract-owned
    format: "avro" | "json-schema" | "protobuf"; formatDialect?: "draft-07" | "2020-12";
    title?; summary?; description?; parameters?: Record<string, object>; tags?: object[]; externalDocs?: object;
    messageKeys: string[];
  }>;
  messages: Array<{
    key: string; name?; title?; summary?; description?; contentType?; correlationId?: object;
    tags?; externalDocs?; bindings?; examples?;
    payload: EntityPin; headers?: EntityPin; keyPin?: EntityPin; traitKeys: string[];
  }>;
  traits: Array<
    | { key: string; kind: "MESSAGE" | "OPERATION"; spec: object; headers?: EntityPin }
    | { key: string; kind: "MESSAGE" | "OPERATION"; libraryTraitId: string }
  >;
  operations: Array<{
    key: string; action: "send" | "receive"; channelKey: string; messageKeys: string[]; traitKeys: string[];
    summary?; description?; bindings?; reply?: { channelKey?: string; messageKeys?: string[] };
  }>;
  externalRefs: Array<{ key: string; eventVersionId: string; kind: "channel" | "message"; itemKey: string }>;
  components?: { correlationIds?: object; parameters?: object; securitySchemes?: object /* origin allowed per scheme */ };
};
```

Rules (enforced by one pure `parseEventSpecDocument` that runs in the browser and on the server):
- Trait keys are unique across both trait kinds (so a key identifies one trait). Other keys match `^[a-zA-Z0-9._-]+$` (AsyncAPI components rule), ≤ 64 chars, unique within a kind. Channel-ish namespace = `channels[].key ∪ externalRefs[kind=channel].key`; message-ish likewise.
- `operation.channelKey` / `messageKeys` resolve in those namespaces; an operation's messages must be a subset of its channel's `messageKeys`. External channels expose the messages of the referenced published item.
- A channel address with `{expr}` requires a matching `parameters` entry.
- `traitKeys` resolve to `traits[].key` of the right `kind`.
- Problems are `{ pointer: JSON-Pointer, message }`, the shape the editor already renders.
- Entity pins: a draft may point at an unpublished entity (preview only); **publish is blocked until every pin is published** (existing rule).

## 5. Versioning and publish

- One `MAJOR.MINOR` per event; user may raise, never lower; majors go through governance (unchanged).
- **MAJOR** when: an operation is removed; a message is removed from a channel or operation; a channel is removed or its address / format / dialect / protocol changes (R78); a payload/headers/key pin moves to a new entity **major**, or a pin is added/removed/replaced; a trait is removed or its headers pin changes entity major (R78); `contentType`, `correlationId` or `defaultContentType` changes; a key is removed (a rename is removal + addition). Every MAJOR carries a human-readable reason. Everything else is **MINOR**. Synced (`origin`) changes use the same rules — the rules read the resolved document and ignore `origin`.
- Publish writes the fully resolved AsyncAPI document; library traits are frozen into the version (as `frozenTraits` today); external refs are frozen copies of the referenced published version.
- External reference picker lists **published** versions of other products' events; the page shows a "newer version available" badge when the source has moved on.

## 6. References and "used by"

`SchemaReference` already supports `EVENT_SPEC` / `EVENT_SPEC_VERSION` → `ENTITY_VERSION` with roles `PAYLOAD`, `HEADERS`, `KEY`, `MESSAGE`. On every document save the event's draft edges are replaced from the document: one edge per message pin, per trait headers pin, and per external ref. One enum addition: `toKind = EVENT_SPEC_VERSION` (external refs). Entity "who uses me" and event "used by" keep working with no new tables.

## 7. The AsyncAPI builder

### 7.1 Layout

Outline tree (left) · form for the selected node (middle) · AsyncAPI preview (right, collapsible). The preview renders the server's emission of the draft inside the existing sandboxed `@asyncapi/react-component` iframe (the component cannot be imported in-app); unsaved edits are previewed through a debounced server action `previewEventDocument(doc)` (the emitter needs entity pins resolved from the DB), and each refresh reloads the iframe. The outline shows a red dot per section with problems and a readiness checklist (Metadata → Server → Channel → Message → Operation). Empty states show one primary action. Explicit Save/Discard stays (D1) plus a leave-without-saving guard; Save always works on an incomplete draft, Publish lists blockers.

| Section | AsyncAPI | User provides |
|---|---|---|
| Metadata | `info`, `defaultContentType` | title, description, contact, license, tags, docs link; version automatic |
| Servers | `servers` | key, protocol, host:port, pathname, description |
| Channels | `channels` | **Where it lives**: address, protocol + binding form, servers. **What it carries**: format profile (+ dialect), messages allowed |
| Messages | `components.messages` | name/docs, content type, **payload entity + version**, headers entity, Kafka key entity, correlation id, examples, traits |
| Operations | `operations` | key, send/receive, channel, messages (subset of channel's), traits, reply |
| Traits | `messageTraits` / `operationTraits` | local definition or library pick |
| Advanced | `components.*` | correlation ids, parameters, security schemes |

### 7.2 Input rules and components

Rules: (1) pick, don't type, when the value is a reference; (2) make invalid states unrepresentable when options are finite; (3) derive instead of ask; (4) validate inline with the same code the server runs; (5) a draft always saves, publish gates on errors.

| Field | Component | Prevents |
|---|---|---|
| Spec format | radio cards + description | wrong spec |
| Keys | text input auto-slugged from title; live uniqueness + regex check; hint `#/components/messages/<key>`; rename rewrites references | duplicates, dangling refs |
| Payload / headers / key | searchable combobox (cmdk, like `TypePicker`): domain/product + classification chips; version select (default latest published); "newer vN" badge; field-tree preview; **+ New entity** in a sheet returning the pin | wrong entity, stale pin |
| Protocol | combobox of common protocols + free text; selection swaps the binding form | typos |
| Server host | host + port inputs (port 1–65535), suggested default port, pathname starts with `/` | malformed endpoint |
| Channel address | tokenized input: `{userId}` becomes a chip and **adds a Parameters row**; per-protocol rules (Kafka ≤ 249 chars `[a-zA-Z0-9._-]`; Pulsar `persistent://tenant/ns/topic`; Pub/Sub 3–255 chars starting with a letter) | missing parameters, illegal names |
| Format profile | segmented control; dialect select only for JSON Schema | invalid combos |
| Bindings | typed controls generated from the `@asyncapi/specs` binding schemas (steppers with min/unit, duration, switch, enum); Kafka / Pub/Sub / Pulsar tuned by hand; raw JSON only under Advanced | raw-JSON mistakes |
| Content type | combobox of common media types filtered by channel format; "inherit default" explicit | typos |
| Operation action | two cards: "Send — this service publishes" / "Receive — this service consumes" | reversed direction |
| Operation → channel → messages | channel select limited to this event's channels (+ external); message checklist limited to **that channel's** messages | invalid combinations |
| Channel → messages | chip multi-select with inline "Create message" | orphan messages |
| Traits | chip select over library + local; preview of headers added; warning when two traits set the same header | silent conflicts |
| Tags / contact / license / URLs | chip input (suggestions from tenant tags), email + URL validation, SPDX combobox | format errors |
| Descriptions | markdown textarea + preview toggle (CommonMark) | rendering surprises |
| Examples | `JsonEditor` + **Generate from payload** + live validation against the payload schema | examples that do not match |

Cross-cutting: parser problems map by JSON Pointer onto fields; Problems panel with click-to-jump; delete shows impact ("used by 2 operations") with cascade option; keyboard-first comboboxes, real labels, errors linked via `aria-describedby`.

### 7.3 `JsonEditor` and CodeMirror 6

`JsonEditor({ value, onChange, schema?, ariaLabel, readOnly?, height? })` is the only place CodeMirror is imported. Final implementation: CodeMirror 6 (`@codemirror/state`, `view`, `commands`, `language`, `lang-json`, `lint`, and `codemirror-json-schema` for schema-aware lint/autocomplete), lazy-loaded (`next/dynamic`, `ssr: false`) so it costs nothing until an Advanced field opens. **As built (2026-10-16):** CodeMirror 6 is installed and `JsonEditor` uses it (the textarea with the same props is the fallback while it loads and in tests). `codemirror-json-schema` is **not** installed — the registry answers `403` by security policy for that package — so there is no schema-aware lint: the `schema` prop is reserved and ignored, and a JSON field shows JSON parse errors plus the builder's own pointer-addressed problems.

## 8. Infra-source seam (deferred, shaped now)

Infra-owned: servers (all), channel `address/protocol/bindings/serverKeys`, security schemes. Contract-owned (always manual): info, messages, entity pins, format profile, operations, traits.
- Built now: optional `origin` on those items; the channel form split into two cards; section components that take `items` + `onChange` so a provider can drop in.
- Later (not built): a provider registry `{ id, kinds, search(query), resolve(ref) }`, a "Pick from <provider>" button above the manual form, read-only synced fields with "Synced from X · Detach to edit", and an "infra changed" drift badge like the existing catalog drift (D8).

## 9. Testing

Unit: document parse/validate/key-rename, resolver, bump rules, binding-form generator, address tokenizer, example generator. Integration: event services, edge replacement, publish, external refs. Component: each builder section and each input component (keyboard + error states). E2E: create event → channel → message with payload entity → operation → publish → preview; cross-product external reference; old-URL redirects.

## 10. Migration and rollout

Facts from the 2026-10-15 code audit (dev DB: 1 unpublished draft event spec, 7 messages, 3 channels, 7 traits of which 1 product-level, **no published event or message versions**; mostly test-named rows):

- **Pin integrity moves from DB foreign keys to our guards.** Today `messages`/`message_versions` FKs block entity delete (P2003). Edges have no FK, `findEntityReferrers` ignores draft edges, and an unpinned pin creates no edge. New edge/JSONB guards are required for: entity delete, entity retire, product/domain cascade delete, library-trait delete, and deletion of an event whose versions are externally referenced.
- **Publish lock contract** replaces `messages FOR SHARE`: lock `event_specs`, then `entities FOR SHARE` for every pinned entity, then write edges (entity publish already locks `entities FOR UPDATE`).
- **Published versions store `resolvedSpec`** (the `ResolvedEventSpec`, artifacts included) in a new nullable JSON column so external refs can reuse a referenced item without re-rendering. `event_spec_versions` is immutable (trigger) — new versions INSERT only.
- **Enum:** `SchemaReferenceToKind` gains `EVENT_SPEC_VERSION` in its own migration (PGlite wraps each migration in a transaction; the value cannot be used in the same file). External refs reuse edge role `MESSAGE`.
- **Destructive migration guard:** the final migration refuses (`RAISE EXCEPTION`) if any `message_versions` or `event_spec_versions` row with a legacy shape exists. Dev DB has none; other environments are protected. A fold-published-versions path is built only if a real environment needs it.
- **Reuse:** `assemble.ts`, `serialize.ts`, `validator.ts`, `adapter.ts` (id-opaque; set `id` = local key), `artifact-renderer.ts`, `resolve.ts`, `publish-plan.ts` (`analyzeVersionedPublish` / `planVersionedPublish`), `comparePin` / `compareTraitHeaders` / `compareChannelProfile` from `bump-rules.ts`, `audited.ts`, `publish-concurrency.ts`, `schema-references.ts`. Channel `messageKeys` are builder metadata; the emitter keeps deriving channel messages from operations (golden files unchanged).
- **UI facts:** `EntityCreationWizard` is not embeddable (no `onCreated`); the "+ New entity" sheet calls `createEntityWithFieldsAction` or the wizard gains callbacks. `EntityPinPicker` is pinned by `entity-pin-picker.test.tsx` — build the new combobox beside it. `@asyncapi/specs` (6.11.1) is only a transitive dependency and must become a direct one; its binding schemas are draft-07 and `$ref` `specificationExtension.json`, so the generator pre-loads definitions. No markdown renderer exists — the preview toggle renders safely (no `dangerouslySetInnerHTML`). Old `?tab=editor|document|diagnostics` URLs alias to `design|preview|source`.

**Phases** (suite stays green at every phase end; each phase is its own plan):

- **Phase A — backend, additive** (plan `2026-10-15-events-self-contained-phase-a-backend.md`): migrations; document types, parser and key tools; document → `ResolvedEventSpec`; event-level bump rules; edges; event service (CRUD); snapshot/emit/preview; publish; pin-integrity guards. New code lives in new files (`src/lib/events/document/*`, `src/services/events/event*.ts`) next to the old; nothing existing is removed.
- **Phase B — UI, additive then cutover**: new `assetHref` `event` kind and builder-section type; isolated input components (entity+version combobox, chip input, segmented control, address tokenizer, binding forms, markdown field, `JsonEditor`) each with tests; builder shell and sections; `events/[eventId]` route and loader; `onNewEvent` in `CreateDropdown` (hidden until wired). **Cutover commit:** data migration of legacy drafts to v2 (+ product-trait inlining), dropdown, flat Events tab, sidebar leaf, `usage.ts` hrefs, redirects, and the paired test/e2e rewrites.
- **Phase C — removal**: delete old pages, editors, actions, loaders, services, libs and tests (backend map lists them); update `tests/e2e/helpers/db.ts`; final guarded migration (delete legacy edges, `DROP TABLE` channels/messages in FK order, drop `prevent_message_version_delete()`, drop legacy `event_spec_versions` columns, handle `traits.productId`); regenerate the Prisma client.

## 11. Non-goals / deferred

Infra provider registry and sync; other spec types; undo/redo in the builder; schema-registry publishing and SDK generation (unchanged from the 2026-10-13 spec §14).

## 12. Assumptions carried (user did not object)

1. Dev DB holds only test rows → clean break is acceptable. **Checked 2026-10-15 on the shared dev Postgres:** 1 unpublished draft event spec, no published versions; mostly test-named rows. Other environments are protected by the migration guard (§10).
2. Product-level Traits go away; the Tenant/Domain library stays.
3. Operations are their own builder section.
4. CodeMirror was installed once the registry was fixed (2026-10-16); only `codemirror-json-schema` stays blocked (403).

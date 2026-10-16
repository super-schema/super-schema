# Events self-contained — Phase A (backend, additive) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the backend for self-contained Events (document v2, event-level bump rules, edges, services, publish, pin-integrity guards) next to the existing catalog code, without removing or changing any existing behavior.

**Architecture:** A new pure-library folder `src/lib/events/document/` (types, parser, key tools, resolver mapping, bump rules, edges) and new services `src/services/events/event*.ts` reuse the existing assembler, artifact renderer, publish plan and audit helpers. Documents carry `documentVersion: 2`; all intra-document references are local string keys. Old Message/Channel code is untouched until Phase C.

**Tech Stack:** TypeScript, Prisma 7 (PostgreSQL + PGlite), Vitest, `Result<T, ServiceError>` services.

**Spec:** `docs/superpowers/specs/2026-10-15-events-self-contained-design.md` (read §2, §4, §5, §6, §10 first). Superseded context: `docs/superpowers/specs/2026-10-13-events-asyncapi-design.md` §6.

## Global Constraints

- Services return `Result<T, ServiceError>` (`ok` / `err` from `@/types/result`) — **never throw**; unexpected DB failures map to a `DB_ERROR` Result through the existing guards (`guardRead` in `src/services/events/service-guards.ts`, `auditedWrite` in `src/services/events/audited.ts`).
- Pure functions in `src/lib/**` are client-safe: no Prisma, no `server-only`, no Node APIs.
- Do **not** edit or delete existing event files except where a task lists them under "Modify". Phase A is additive; the baseline suite (`npx vitest run event channel trait message`: 106 files / 1159 tests) must stay green after every task.
- Integration tests: first line `import "dotenv/config"` (the shared helper already does it); use `tests/integration/services/events/helpers.ts` (`connectTestDb`, `testContext`, `unwrap`, `stamp`, `createProductScope`, `cleanupDomains`, `cleanupTenantTraits`, `TENANT`). Names carry `stamp()`. Clean up with `cleanupDomains` (extend it only for new tables — none are added).
- Document keys: `^[a-zA-Z0-9._-]+$`, 1–64 chars. Trait keys are unique across both trait kinds. Namespaces: channel-ish = `channels[].key ∪ externalRefs[kind=channel].key`; message-ish = `messages[].key ∪ externalRefs[kind=message].key`.
- Validation problems are `{ pointer: string; message: string }` (RFC 6901 pointers into the draft document) returned as `err({ code: "VALIDATION_ERROR", message, details: { problems } })`.
- `EntityPin = { entityId: string; entityVersionId: string | null }` (`src/lib/events/types.ts:20`); `null` version = unpinned (draft preview only; publish blocked).
- External refs use edge role `MESSAGE` and `toKind: "EVENT_SPEC_VERSION"`.
- Commit after every task; message style `feat(events): …` / `test(events): …`; end each message with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- Run scoped tests with `npx vitest run <path>`; type-check with `npx tsc --noEmit` before each commit.
- Tools note: the Gortex MCP server is down; the user approved Read/Grep/Glob/Bash fallback for this program (ledger R68). Subagents receive this in every dispatch.

## Review Focus

1. **Duplicate/invalid keys:** a message key that equals an external-ref message key; a key of 65 chars; a key with a space or `/` — parser rejects, `renameKey` refuses.
2. **Operation ↔ channel consistency:** an operation naming a message not allowed on its channel; `reply.messageKeys` without `reply.channelKey`; an operation on an external channel.
3. **Address expressions:** `orders.{tenantId}.{region}` needs both parameters; a repeated `{a}{a}` needs one; empty `{}` is invalid.
4. **Pins:** a draft with an unpinned or unpublished entity saves but cannot publish; deleting or retiring an entity that any event draft or published version pins is blocked; an entity pinned only in a draft counts.
5. **Event deletion and concurrency:** deleting an event whose published versions are externally referenced is blocked and names the referrers; a save racing a publish must not lose edges (lock order `event_specs` → `entities FOR SHARE`).

## File Structure

| File | Responsibility |
|---|---|
| `prisma/migrations/20261018_event_document_v2_enums/migration.sql` | `ADD VALUE 'EVENT_SPEC_VERSION'` on the to-kind enum (own file) |
| `prisma/migrations/20261018_event_document_v2_columns/migration.sql` | `event_spec_versions.resolvedSpec JSONB NULL` |
| `prisma/schema.prisma` | enum value + `resolvedSpec Json?` on `EventSpecVersion` |
| `src/lib/events/document/types.ts` | `EventDocument` + part types, `DocumentProblem`, `emptyEventDocument`, key constants |
| `src/lib/events/document/parse.ts` | `parseEventDocument(value): Result<EventDocument>` (all rules, pointer problems) |
| `src/lib/events/document/keys.ts` | `slugKey`, `uniqueKey`, `renameKey` |
| `src/lib/events/document/resolve.ts` | `planDocumentArtifacts`, `resolveDocument` → `ResolvedEventSpec` |
| `src/lib/events/document/bump.ts` | `classifyEventBump` (event-level rules incl. R78) |
| `src/lib/events/document/edges.ts` | `collectDocumentEdges`, `collectDocumentRefs` |
| `src/services/events/event.service.ts` | create / update document / rename / delete / get / list |
| `src/services/events/event-snapshot.ts` | load draft/stored snapshot, render artifacts, resolve (like `event-spec-resolver.ts`) |
| `src/services/events/event-emit.service.ts` | `emitEventDraft`, `emitEventDocumentPreview`, `emitEventStoredVersion` |
| `src/services/events/event-publish.service.ts` | preview / publish / list versions |
| `src/services/events/event-guards.ts` | edge-based entity, library-trait, event and product guards |
| Tests | mirror under `tests/unit/lib/events/document/`, `tests/integration/services/events/`, `tests/db/` |

---

### Task A1: Migrations — enum value and `resolvedSpec` column

**Files:**
- Create: `prisma/migrations/20261018_event_document_v2_enums/migration.sql`
- Create: `prisma/migrations/20261018_event_document_v2_columns/migration.sql`
- Modify: `prisma/schema.prisma` (enum `SchemaReferenceToKind`, model `EventSpecVersion`)
- Test: `tests/db/event-document-v2-pglite.test.ts`

**Interfaces:**
- Produces: Prisma enum value `SchemaReferenceToKind.EVENT_SPEC_VERSION`; field `EventSpecVersion.resolvedSpec: Prisma.JsonValue | null`.

- [ ] **Step 1: Read the existing pattern.** Open `prisma/migrations/20261016_events_core/migration.sql` (find the real Postgres type name of the to-kind enum, e.g. `"SchemaReferenceToKind"`, and the `event_spec_versions` table definition) and `tests/db/schema-reference-ghost-edges-pglite.test.ts` (how a PGlite DB is built from all migrations). Note `src/lib/pglite-migrate.ts:54` wraps each migration file in a transaction, which is why the enum value and any use of it must be in different files.

- [ ] **Step 2: Write the failing test** in `tests/db/event-document-v2-pglite.test.ts`, copying the setup of the ghost-edge PGlite test. Two tests:

```ts
it("accepts schema_references rows pointing at an EVENT_SPEC_VERSION", async () => {
  // insert one row: fromKind 'EVENT_SPEC', role 'MESSAGE', toKind 'EVENT_SPEC_VERSION', toId 'x', isDraft true
  // expect no error and select count = 1
});
it("event_spec_versions has a nullable JSONB resolvedSpec column", async () => {
  const cols = await db.query(
    `select data_type, is_nullable from information_schema.columns where table_name = 'event_spec_versions' and column_name = 'resolvedSpec'`
  );
  expect(cols.rows).toEqual([{ data_type: "jsonb", is_nullable: "YES" }]);
});
```
Use the exact column names and insert shape from the events-core migration (quote camelCase columns).

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run tests/db/event-document-v2-pglite.test.ts`
Expected: FAIL (`invalid input value for enum` and zero rows for the column query).

- [ ] **Step 4: Write the migrations.**

`20261018_event_document_v2_enums/migration.sql`:
```sql
ALTER TYPE "SchemaReferenceToKind" ADD VALUE 'EVENT_SPEC_VERSION';
```
`20261018_event_document_v2_columns/migration.sql`:
```sql
ALTER TABLE "event_spec_versions" ADD COLUMN "resolvedSpec" JSONB;
```
(If Step 1 shows a different enum or table name, use the real one.) Update `prisma/schema.prisma`: add `EVENT_SPEC_VERSION` to `enum SchemaReferenceToKind` and `resolvedSpec Json?` to `model EventSpecVersion`. Run `npx prisma generate`.

- [ ] **Step 5: Run the test, then the PostgreSQL events DB test**

Run: `npx vitest run tests/db/event-document-v2-pglite.test.ts tests/db/events-core-pglite.test.ts`
Expected: PASS. Then apply to the shared dev Postgres: `npm run db:deploy` (idempotent) and rerun `npx vitest run tests/integration/db/events-core.test.ts` (find the actual path with `ls tests/**/events-core*`). Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add prisma tests/db/event-document-v2-pglite.test.ts
git commit -m "feat(events): schema_references can target event spec versions; event_spec_versions.resolvedSpec"
```

---

### Task A2: Document types, parser and key tools

**Files:**
- Create: `src/lib/events/document/types.ts`, `src/lib/events/document/parse.ts`, `src/lib/events/document/keys.ts`
- Test: `tests/unit/lib/events/document/parse.test.ts`, `tests/unit/lib/events/document/keys.test.ts`

**Interfaces:**
- Consumes: `JsonObject`, `PayloadFormat`, `JsonSchemaDialect`, `OperationAction`, `TraitKind`, `EventSpecInfo` from `@/lib/event-specs/types`; `EntityPin` from `@/lib/events/types`; `ok`, `err`, `Result` from `@/types/result`.
- Produces (exact):
```ts
// types.ts
export const DOCUMENT_VERSION = 2 as const;
export const KEY_PATTERN = /^[a-zA-Z0-9._-]+$/;
export const KEY_MAX_LENGTH = 64;
export interface Origin { provider: string; ref: string; syncedAt: string }
export interface DocServer { key: string; protocol: string; host: string; pathname?: string; protocolVersion?: string; description?: string; externalRef?: string; origin?: Origin }
export interface DocChannel {
  key: string; address: string | null; protocol: string; serverKeys: string[]; bindings?: JsonObject; origin?: Origin;
  format: PayloadFormat; formatDialect?: JsonSchemaDialect;
  title?: string; summary?: string; description?: string; parameters?: Record<string, JsonObject>; tags?: JsonObject[]; externalDocs?: JsonObject;
  messageKeys: string[];
}
export interface DocMessage {
  key: string; title?: string; summary?: string; description?: string; contentType?: string; correlationId?: JsonObject;
  tags?: JsonObject[]; externalDocs?: JsonObject; bindings?: JsonObject; examples?: JsonObject[];
  payload: EntityPin; headers?: EntityPin; keyPin?: EntityPin; traitKeys: string[];
}
export type DocTrait =
  | { key: string; kind: TraitKind; spec: JsonObject; headers?: EntityPin }
  | { key: string; kind: TraitKind; libraryTraitId: string };
export interface DocOperation {
  key: string; action: OperationAction; channelKey: string; messageKeys: string[]; traitKeys: string[];
  summary?: string; description?: string; bindings?: JsonObject; reply?: { channelKey?: string; messageKeys?: string[] };
}
export interface DocExternalRef { key: string; eventVersionId: string; kind: "channel" | "message"; itemKey: string }
export interface DocComponents { correlationIds?: Record<string, JsonObject>; parameters?: Record<string, JsonObject>; securitySchemes?: Record<string, JsonObject> }
export interface EventDocument {
  documentVersion: 2; info: EventSpecInfo; defaultContentType?: string;
  servers: DocServer[]; channels: DocChannel[]; messages: DocMessage[]; traits: DocTrait[];
  operations: DocOperation[]; externalRefs: DocExternalRef[]; components?: DocComponents;
}
export interface DocumentProblem { pointer: string; message: string }
export function emptyEventDocument(title: string, description?: string): EventDocument;
export const isLibraryTrait = (t: DocTrait): t is Extract<DocTrait, { libraryTraitId: string }> => "libraryTraitId" in t;
// parse.ts
export function parseEventDocument(value: unknown): Result<EventDocument>;
// keys.ts
export type KeyKind = "server" | "channel" | "message" | "trait" | "operation" | "externalRef";
export function slugKey(text: string): string;
export function uniqueKey(base: string, taken: Iterable<string>): string;
export function renameKey(doc: EventDocument, kind: KeyKind, from: string, to: string): Result<EventDocument>;
```

- [ ] **Step 1: Write the failing parser test** `tests/unit/lib/events/document/parse.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { emptyEventDocument, type EventDocument } from "@/lib/events/document/types";
import { parseEventDocument } from "@/lib/events/document/parse";

const pin = (id: string, v: string | null = "ev1") => ({ entityId: id, entityVersionId: v });

function valid(): EventDocument {
  return {
    ...emptyEventDocument("checkout-service"),
    servers: [{ key: "kafka-prod", protocol: "kafka", host: "kafka-prod.internal:9092" }],
    channels: [{ key: "orders", address: "payments.orders.v1", protocol: "kafka", serverKeys: ["kafka-prod"], format: "avro", messageKeys: ["OrderCreated"] }],
    messages: [{ key: "OrderCreated", payload: pin("ent-order"), keyPin: pin("ent-key"), traitKeys: ["CloudEvents"] }],
    traits: [{ key: "CloudEvents", kind: "MESSAGE", libraryTraitId: "trait-1" }],
    operations: [{ key: "publishOrderCreated", action: "send", channelKey: "orders", messageKeys: ["OrderCreated"], traitKeys: [] }],
  };
}
function problems(value: unknown): Array<{ pointer: string; message: string }> {
  const r = parseEventDocument(value);
  return r.success ? [] : ((r.error.details as { problems: Array<{ pointer: string; message: string }> }).problems);
}
const mutate = (fn: (d: EventDocument) => void) => { const d = valid(); fn(d); return d; };

describe("parseEventDocument", () => {
  it("accepts a complete document and returns it unchanged", () => {
    const r = parseEventDocument(valid());
    expect(r.success).toBe(true);
    if (r.success) expect(r.data).toEqual(valid());
  });
  it("accepts the empty document", () => {
    expect(parseEventDocument(emptyEventDocument("t")).success).toBe(true);
  });
  it("rejects non-objects and the wrong documentVersion", () => {
    expect(problems(null)[0].pointer).toBe("");
    expect(problems({ ...valid(), documentVersion: 1 })[0].pointer).toBe("/documentVersion");
  });
  it("requires info.title", () => {
    expect(problems(mutate((d) => { d.info.title = "  "; })).map((p) => p.pointer)).toContain("/info/title");
  });
  it("rejects invalid keys (space, slash, 65 chars)", () => {
    for (const key of ["a b", "a/b", "x".repeat(65)]) {
      const p = problems(mutate((d) => { d.channels[0].key = key; d.operations[0].channelKey = key; }));
      expect(p.map((x) => x.pointer)).toContain("/channels/0/key");
    }
  });
  it("rejects duplicate keys inside one namespace, including external refs", () => {
    const dup = mutate((d) => {
      d.externalRefs = [{ key: "OrderCreated", eventVersionId: "ev-other", kind: "message", itemKey: "Foo" }];
    });
    expect(problems(dup).map((p) => p.pointer)).toContain("/externalRefs/0/key");
    const twoChannels = mutate((d) => { d.channels.push({ ...d.channels[0] }); });
    expect(problems(twoChannels).map((p) => p.pointer)).toContain("/channels/1/key");
  });
  it("requires unique trait keys across both kinds", () => {
    const d = mutate((x) => { x.traits.push({ key: "CloudEvents", kind: "OPERATION", spec: {} }); });
    expect(problems(d).map((p) => p.pointer)).toContain("/traits/1/key");
  });
  it("validates channel fields", () => {
    expect(problems(mutate((d) => { (d.channels[0] as { format: string }).format = "xml"; })).map((p) => p.pointer)).toContain("/channels/0/format");
    expect(problems(mutate((d) => { d.channels[0].formatDialect = "2020-12"; })).map((p) => p.pointer)).toContain("/channels/0/formatDialect"); // dialect only for json-schema
    expect(problems(mutate((d) => { d.channels[0].protocol = ""; })).map((p) => p.pointer)).toContain("/channels/0/protocol");
    expect(problems(mutate((d) => { d.channels[0].serverKeys = ["nope"]; })).map((p) => p.pointer)).toContain("/channels/0/serverKeys/0");
    expect(problems(mutate((d) => { d.channels[0].messageKeys = ["ghost"]; })).map((p) => p.pointer)).toContain("/channels/0/messageKeys/0");
  });
  it("requires a parameter for every address expression", () => {
    const d = mutate((x) => { x.channels[0].address = "orders.{tenantId}.{region}"; x.channels[0].parameters = { tenantId: {} }; });
    const p = problems(d);
    expect(p.map((x) => x.pointer)).toContain("/channels/0/parameters");
    expect(p.some((x) => x.message.includes("{region}"))).toBe(true);
    const repeated = mutate((x) => { x.channels[0].address = "o.{a}.{a}"; x.channels[0].parameters = { a: {} }; });
    expect(problems(repeated)).toEqual([]);
    const empty = mutate((x) => { x.channels[0].address = "o.{}"; });
    expect(problems(empty).map((x) => x.pointer)).toContain("/channels/0/address");
  });
  it("requires a pinned payload entity and valid optional pins", () => {
    expect(problems(mutate((d) => { (d.messages[0] as { payload?: unknown }).payload = undefined; })).map((p) => p.pointer)).toContain("/messages/0/payload");
    expect(problems(mutate((d) => { d.messages[0].payload = { entityId: "", entityVersionId: null }; })).map((p) => p.pointer)).toContain("/messages/0/payload/entityId");
    expect(problems(mutate((d) => { d.messages[0].payload = pin("e", null); }))).toEqual([]); // unpinned is a legal draft
  });
  it("checks message trait references and kinds", () => {
    expect(problems(mutate((d) => { d.messages[0].traitKeys = ["missing"]; })).map((p) => p.pointer)).toContain("/messages/0/traitKeys/0");
    const wrongKind = mutate((d) => { d.traits[0] = { key: "CloudEvents", kind: "OPERATION", libraryTraitId: "t" }; });
    expect(problems(wrongKind).map((p) => p.pointer)).toContain("/messages/0/traitKeys/0");
  });
  it("keeps operations consistent with their channel", () => {
    expect(problems(mutate((d) => { d.operations[0].channelKey = "nope"; })).map((p) => p.pointer)).toContain("/operations/0/channelKey");
    const notOnChannel = mutate((d) => { d.messages.push({ key: "Other", payload: pin("e2"), traitKeys: [] }); d.operations[0].messageKeys = ["Other"]; });
    expect(problems(notOnChannel).map((p) => p.pointer)).toContain("/operations/0/messageKeys/0");
    const replyNoChannel = mutate((d) => { d.operations[0].reply = { messageKeys: ["OrderCreated"] }; });
    expect(problems(replyNoChannel).map((p) => p.pointer)).toContain("/operations/0/reply/channelKey");
    expect(problems(mutate((d) => { d.operations[0].action = "publish" as never; })).map((p) => p.pointer)).toContain("/operations/0/action");
  });
  it("allows operations on external channels without a subset check", () => {
    const d = mutate((x) => {
      x.externalRefs = [{ key: "ext-orders", eventVersionId: "ev9", kind: "channel", itemKey: "orders" }];
      x.operations.push({ key: "recv", action: "receive", channelKey: "ext-orders", messageKeys: ["OrderCreated"], traitKeys: [] });
    });
    expect(problems(d)).toEqual([]);
  });
  it("validates servers and external refs", () => {
    expect(problems(mutate((d) => { d.servers[0].pathname = "v1"; })).map((p) => p.pointer)).toContain("/servers/0/pathname");
    expect(problems(mutate((d) => { d.servers[0].host = ""; })).map((p) => p.pointer)).toContain("/servers/0/host");
    const badRef = mutate((d) => { d.externalRefs = [{ key: "x", eventVersionId: "", kind: "message", itemKey: "" }]; });
    const ptrs = problems(badRef).map((p) => p.pointer);
    expect(ptrs).toContain("/externalRefs/0/eventVersionId");
    expect(ptrs).toContain("/externalRefs/0/itemKey");
  });
  it("drops undefined optionals and trims strings", () => {
    const r = parseEventDocument(mutate((d) => { d.info.title = "  spaced  "; d.channels[0].title = undefined; }));
    expect(r.success && r.data.info.title).toBe("spaced");
    expect(r.success && "title" in r.data.channels[0]).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/unit/lib/events/document/parse.test.ts`
Expected: FAIL — cannot resolve `@/lib/events/document/types`.

- [ ] **Step 3: Write `types.ts`** exactly as the Interfaces block above, plus:
```ts
export function emptyEventDocument(title: string, description?: string): EventDocument {
  return {
    documentVersion: DOCUMENT_VERSION,
    info: description === undefined ? { title } : { title, description },
    servers: [], channels: [], messages: [], traits: [], operations: [], externalRefs: [],
  };
}
```

- [ ] **Step 4: Write `parse.ts`.** Structure (implement every rule the test lists; reuse the style of `src/lib/events/event-spec-document.ts`: `Bag`, `optString`, `compact`):

```ts
import { err, ok, type Result } from "@/types/result";
import type { EntityPin } from "@/lib/events/types";
import type { JsonObject } from "@/lib/event-specs/types";
import { DOCUMENT_VERSION, KEY_MAX_LENGTH, KEY_PATTERN, type DocComponents, type DocChannel, type DocExternalRef,
  type DocMessage, type DocOperation, type DocServer, type DocTrait, type DocumentProblem, type EventDocument } from "./types";

type Bag = Record<string, unknown>;
const isBag = (v: unknown): v is Bag => typeof v === "object" && v !== null && !Array.isArray(v);
const FORMATS = ["avro", "json-schema", "protobuf"];
const DIALECTS = ["draft-07", "2020-12"];
const ACTIONS = ["send", "receive"];
const TRAIT_KINDS = ["MESSAGE", "OPERATION"];
const ptr = (...parts: Array<string | number>) => parts.map((p) => `/${String(p).replace(/~/g, "~0").replace(/\//g, "~1")}`).join("");
const compact = <T extends object>(v: T): T => Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined)) as T;

export function parseEventDocument(value: unknown): Result<EventDocument> {
  const problems: DocumentProblem[] = [];
  const bad = (pointer: string, message: string) => { problems.push({ pointer, message }); };
  // 1. Readers: req(src,key,pointer) -> trimmed non-empty string | undefined (+problem); opt(src,key,pointer) -> trimmed string | undefined
  //    (problem when present and not a string); bag(src,key,pointer); list(src,key,pointer) -> string[]; pin(src,key,pointer,required).
  // 2. Root: not an object -> bad("", "Document must be an object") and return; documentVersion !== 2 -> bad("/documentVersion", ...).
  // 3. info: object with title (req). Copy optional description/contact/license/tags/externalDocs.
  // 4. Parse each array (servers, channels, messages, traits, operations, externalRefs) into typed items with per-field problems
  //    (see rules below). Missing array = [].
  // 5. Cross-reference checks AFTER parsing, using Sets:
  //    channelish = channels keys + externalRefs(kind channel) keys; messageish = messages keys + externalRefs(kind message) keys;
  //    uniqueness: servers; channelish (report on the later item's /key pointer, `/channels/i/key` or `/externalRefs/i/key`);
  //    messageish; traits (across both kinds); operations; externalRefs overall.
  //    channel.serverKeys ⊆ servers; channel.messageKeys ⊆ messageish; message.traitKeys ⊆ traits of kind MESSAGE;
  //    operation.channelKey ∈ channelish; operation.messageKeys ⊆ messageish and, when the channel is local, ⊆ that channel's messageKeys
  //    (pointer /operations/i/messageKeys/j); operation.traitKeys ⊆ traits of kind OPERATION;
  //    reply: messageKeys present without channelKey -> bad(/operations/i/reply/channelKey); reply.channelKey ∈ channelish;
  //    reply.messageKeys ⊆ messageish and, when the reply channel is local, ⊆ its messageKeys.
  // 6. Return err({ code: "VALIDATION_ERROR", message: `${n} problem(s) in the event document`, details: { problems } }) if any, else ok(doc).
}
```
Per-field rules to implement:
- key (all kinds): string, trimmed, `KEY_PATTERN`, length ≤ `KEY_MAX_LENGTH` → problem at `<item>/key`.
- server: `protocol`, `host` required non-empty, host has no whitespace and no `://`; `pathname` (if present) starts with `/`; optional `protocolVersion`, `description`, `externalRef`, `origin` (object with string `provider`, `ref`, `syncedAt`).
- channel: `address` string or null (absent → null); every `{expr}` found by `/\{([^{}]*)\}/g` must be non-empty (else problem at `/channels/i/address`) and have a key in `parameters` (else problem at `/channels/i/parameters` with text `Address expression "{name}" needs a parameter definition`); `protocol` required; `format` ∈ FORMATS; `formatDialect` only when `format === "json-schema"` and ∈ DIALECTS (else problem at `/channels/i/formatDialect`); optional `title/summary/description/parameters/bindings/tags/externalDocs/origin`; `serverKeys`, `messageKeys` string lists (default []).
- message: `payload` required pin (`entityId` non-empty string, `entityVersionId` string or null; problems at `/messages/i/payload/entityId`, `/messages/i/payload/entityVersionId`); optional `headers` and `keyPin` pins; optional text/object fields; `traitKeys` list.
- trait: `kind` ∈ TRAIT_KINDS; exactly one of `spec` (object) or `libraryTraitId` (non-empty string) — both or neither is a problem at `/traits/i`; local trait may carry `headers` pin.
- operation: `action` ∈ ACTIONS; `channelKey` required; `messageKeys`, `traitKeys` lists; optional `summary/description/bindings/reply`.
- externalRef: `eventVersionId` and `itemKey` non-empty; `kind` ∈ {"channel","message"}.
- components: object with optional `correlationIds`, `parameters`, `securitySchemes` records of objects.
- Normalize: trim strings, drop `undefined` keys (`compact`), keep arrays in authored order.

- [ ] **Step 5: Run the parser test**

Run: `npx vitest run tests/unit/lib/events/document/parse.test.ts`
Expected: PASS (all tests).

- [ ] **Step 6: Write the failing keys test** `tests/unit/lib/events/document/keys.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { renameKey, slugKey, uniqueKey } from "@/lib/events/document/keys";
import { parseEventDocument } from "@/lib/events/document/parse";
import { emptyEventDocument, type EventDocument } from "@/lib/events/document/types";

const pin = { entityId: "e", entityVersionId: "v" };
function doc(): EventDocument {
  return {
    ...emptyEventDocument("t"),
    servers: [{ key: "kafka-prod", protocol: "kafka", host: "h:9092" }],
    channels: [
      { key: "orders", address: "o", protocol: "kafka", serverKeys: ["kafka-prod"], format: "avro", messageKeys: ["OrderCreated"] },
      { key: "refunds", address: "r", protocol: "kafka", serverKeys: [], format: "avro", messageKeys: ["OrderCreated"] },
    ],
    messages: [{ key: "OrderCreated", payload: pin, traitKeys: ["Envelope"] }],
    traits: [{ key: "Envelope", kind: "MESSAGE", spec: {} }, { key: "Audited", kind: "OPERATION", spec: {} }],
    operations: [{ key: "pub", action: "send", channelKey: "orders", messageKeys: ["OrderCreated"], traitKeys: ["Audited"], reply: { channelKey: "refunds", messageKeys: ["OrderCreated"] } }],
  };
}

describe("slugKey / uniqueKey", () => {
  it("slugs titles into valid keys", () => {
    expect(slugKey("Order Created!")).toBe("Order-Created");
    expect(slugKey("  a//b  ")).toBe("a-b");
    expect(slugKey("")).toBe("item");
    expect(slugKey("x".repeat(100))).toHaveLength(64);
    expect(slugKey("naïve café")).toBe("na-ve-caf");
  });
  it("appends a numeric suffix until the key is free", () => {
    expect(uniqueKey("orders", ["orders", "orders-2"])).toBe("orders-3");
    expect(uniqueKey("fresh", ["orders"])).toBe("fresh");
    expect(uniqueKey("x".repeat(64), ["x".repeat(64)])).toHaveLength(64);
  });
});

describe("renameKey", () => {
  it("rewrites every reference to a renamed channel", () => {
    const r = renameKey(doc(), "channel", "orders", "orders-v2");
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.channels[0].key).toBe("orders-v2");
    expect(r.data.operations[0].channelKey).toBe("orders-v2");
    expect(r.data.operations[0].reply?.channelKey).toBe("refunds");
    expect(parseEventDocument(r.data).success).toBe(true);
  });
  it("rewrites a renamed reply channel", () => {
    const r = renameKey(doc(), "channel", "refunds", "returns");
    expect(r.success && r.data.operations[0].reply?.channelKey).toBe("returns");
  });
  it("rewrites message references in channels, operations and replies", () => {
    const r = renameKey(doc(), "message", "OrderCreated", "OrderPlaced");
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.channels.every((c) => c.messageKeys[0] === "OrderPlaced")).toBe(true);
    expect(r.data.operations[0].messageKeys).toEqual(["OrderPlaced"]);
    expect(r.data.operations[0].reply?.messageKeys).toEqual(["OrderPlaced"]);
    expect(parseEventDocument(r.data).success).toBe(true);
  });
  it("rewrites server and trait references", () => {
    const s = renameKey(doc(), "server", "kafka-prod", "kafka-eu");
    expect(s.success && s.data.channels[0].serverKeys).toEqual(["kafka-eu"]);
    const t = renameKey(doc(), "trait", "Envelope", "CloudEvents");
    expect(t.success && t.data.messages[0].traitKeys).toEqual(["CloudEvents"]);
    const o = renameKey(doc(), "trait", "Audited", "Tracked");
    expect(o.success && o.data.operations[0].traitKeys).toEqual(["Tracked"]);
  });
  it("renames an operation (nothing references it)", () => {
    const r = renameKey(doc(), "operation", "pub", "publish");
    expect(r.success && r.data.operations[0].key).toBe("publish");
  });
  it("renames an external ref and the keys that point at it", () => {
    const d = doc();
    d.externalRefs = [{ key: "ext", eventVersionId: "ev", kind: "channel", itemKey: "c" }];
    d.operations.push({ key: "recv", action: "receive", channelKey: "ext", messageKeys: [], traitKeys: [] });
    const r = renameKey(d, "externalRef", "ext", "upstream");
    expect(r.success && r.data.operations[1].channelKey).toBe("upstream");
  });
  it("refuses invalid, taken or unknown keys and never mutates the input", () => {
    const d = doc();
    const before = JSON.stringify(d);
    expect(renameKey(d, "channel", "orders", "a b").success).toBe(false);
    expect(renameKey(d, "channel", "orders", "refunds").success).toBe(false); // taken in the channel-ish namespace
    expect(renameKey(d, "channel", "ghost", "x").success).toBe(false);
    expect(renameKey(d, "trait", "Envelope", "Audited").success).toBe(false); // trait keys unique across kinds
    expect(JSON.stringify(d)).toBe(before);
  });
  it("is a no-op success when from === to", () => {
    expect(renameKey(doc(), "channel", "orders", "orders").success).toBe(true);
  });
});
```

- [ ] **Step 7: Run it to verify it fails**

Run: `npx vitest run tests/unit/lib/events/document/keys.test.ts`
Expected: FAIL — cannot resolve `@/lib/events/document/keys`.

- [ ] **Step 8: Write `keys.ts`.**

```ts
import { err, ok, type Result } from "@/types/result";
import { KEY_MAX_LENGTH, KEY_PATTERN, type EventDocument } from "./types";

export type KeyKind = "server" | "channel" | "message" | "trait" | "operation" | "externalRef";

export function slugKey(text: string): string {
  const slug = text.trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/-{2,}/g, "-").replace(/^-+|-+$/g, "").slice(0, KEY_MAX_LENGTH).replace(/-+$/g, "");
  return slug || "item";
}

export function uniqueKey(base: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  if (!used.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const suffix = `-${n}`;
    const candidate = `${base.slice(0, KEY_MAX_LENGTH - suffix.length)}${suffix}`;
    if (!used.has(candidate)) return candidate;
  }
}

export function renameKey(doc: EventDocument, kind: KeyKind, from: string, to: string): Result<EventDocument> {
  const fail = (message: string) => err({ code: "VALIDATION_ERROR" as const, message });
  if (!KEY_PATTERN.test(to) || to.length > KEY_MAX_LENGTH) return fail(`"${to}" is not a valid key`);
  const next = structuredClone(doc);
  const swap = (k: string) => (k === from ? to : k);
  const swapAll = (keys: string[]) => keys.map(swap);
  // Namespaces: channel-ish = channels + externalRefs(channel); message-ish = messages + externalRefs(message).
  const refKind = (key: string) => next.externalRefs.find((r) => r.key === key)?.kind;
  const channelish = () => [...next.channels.map((c) => c.key), ...next.externalRefs.filter((r) => r.kind === "channel").map((r) => r.key)];
  const messageish = () => [...next.messages.map((m) => m.key), ...next.externalRefs.filter((r) => r.kind === "message").map((r) => r.key)];
  const exists = { server: () => next.servers.map((s) => s.key), operation: () => next.operations.map((o) => o.key),
    trait: () => next.traits.map((t) => t.key), channel: channelish, message: messageish,
    externalRef: () => (refKind(from) === "channel" ? channelish() : messageish()) };
  const pool = exists[kind]();
  if (!pool.includes(from)) return fail(`No ${kind} with key "${from}"`);
  if (from === to) return ok(next);
  if (pool.includes(to)) return fail(`The key "${to}" is already used`);

  const asChannel = kind === "channel" || (kind === "externalRef" && refKind(from) === "channel");
  const asMessage = kind === "message" || (kind === "externalRef" && refKind(from) === "message");
  if (kind === "server") next.servers.forEach((s) => { if (s.key === from) s.key = to; });
  if (kind === "server") next.channels.forEach((c) => { c.serverKeys = swapAll(c.serverKeys); });
  if (kind === "operation") next.operations.forEach((o) => { if (o.key === from) o.key = to; });
  if (kind === "trait") {
    next.traits.forEach((t) => { if (t.key === from) t.key = to; });
    next.messages.forEach((m) => { m.traitKeys = swapAll(m.traitKeys); });
    next.operations.forEach((o) => { o.traitKeys = swapAll(o.traitKeys); });
  }
  if (kind === "channel") next.channels.forEach((c) => { if (c.key === from) c.key = to; });
  if (kind === "message") next.messages.forEach((m) => { if (m.key === from) m.key = to; });
  if (kind === "externalRef") next.externalRefs.forEach((r) => { if (r.key === from) r.key = to; });
  if (asChannel) next.operations.forEach((o) => {
    o.channelKey = swap(o.channelKey);
    if (o.reply?.channelKey !== undefined) o.reply.channelKey = swap(o.reply.channelKey);
  });
  if (asMessage) {
    next.channels.forEach((c) => { c.messageKeys = swapAll(c.messageKeys); });
    next.operations.forEach((o) => {
      o.messageKeys = swapAll(o.messageKeys);
      if (o.reply?.messageKeys) o.reply.messageKeys = swapAll(o.reply.messageKeys);
    });
  }
  return ok(next);
}
```
(The `slugKey("naïve café")` expectation is `na-ve-caf`; if the final trim leaves a different but valid slug, adjust the test, not the key rules.)

- [ ] **Step 9: Run both test files, type-check, commit**

Run: `npx vitest run tests/unit/lib/events/document && npx tsc --noEmit`
Expected: PASS, no type errors.
```bash
git add src/lib/events/document tests/unit/lib/events/document
git commit -m "feat(events): event document v2 types, parser and key tools"
```

---

### Task A3: Document → `ResolvedEventSpec`

**Files:**
- Create: `src/lib/events/document/resolve.ts`
- Test: `tests/unit/lib/events/document/resolve.test.ts`

**Interfaces:**
- Consumes: `EventDocument`, `DocMessage`, `DocTrait`, `isLibraryTrait` (A2); `ResolvedEventSpec`, `ResolvedChannel`, `ResolvedMessage`, `ResolvedTrait`, `ResolvedOperation`, `SchemaArtifact`, `PayloadFormat`, `TraitKind`, `JsonObject` from `@/lib/event-specs/types`; `FrozenTrait` from `@/lib/events/types`; `toResolvedTrait` from `@/lib/events/catalog-mapping`.
- Produces:
```ts
export interface MessageArtifacts { payloads: SchemaArtifact[]; headers?: SchemaArtifact; keys: SchemaArtifact[] }
export interface ExternalItems { channel?: ResolvedChannel; message?: ResolvedMessage; traits?: ResolvedTrait[] }
export interface ResolveDocumentInput {
  doc: EventDocument;
  productSlug: string;
  version: string;                                   // "MAJOR.MINOR" or a provisional label
  artifacts: ReadonlyMap<string, MessageArtifacts>;  // by local message key
  localTraitHeaders: ReadonlyMap<string, SchemaArtifact>; // by local trait key
  libraryTraits: ReadonlyMap<string, FrozenTrait>;   // by libraryTraitId
  libraryTraitHeaders: ReadonlyMap<string, SchemaArtifact>; // by libraryTraitId
  external: ReadonlyMap<string, ExternalItems>;      // by externalRef key
}
export function planDocumentArtifacts(doc: EventDocument): Map<string, { payloadFormats: PayloadFormat[]; keyFormats: PayloadFormat[] }>;
export function resolveDocument(input: ResolveDocumentInput): Result<ResolvedEventSpec>;
```
Read first: `src/lib/event-specs/resolve.ts` (v1 resolver, same output type and the `UNRESOLVED_REFERENCES` error shape), `src/lib/events/catalog-mapping.ts` (`planArtifacts` semantics, `toResolvedChannel`, `toResolvedMessage`, `toResolvedTrait`).

Behavior (every item is a test below):
- `ResolvedChannel.id` = channel key; `profile = { format, dialect: formatDialect }`; `productSlug` = input.productSlug. External channel → the `ExternalItems.channel` copy (its own `productSlug`, id replaced by the externalRef key).
- `ResolvedMessage.id` = message key; `traitRefs` = the message's `traitKeys`; `payloads/headers/keys` from `artifacts`. External message → `ExternalItems.message` with id replaced by the externalRef key.
- `ResolvedTrait`: local trait → `{ id: key, name: key, kind, ownerSlug: productSlug, spec, headers: localTraitHeaders.get(key) }`; library trait → `toResolvedTrait(frozen, libraryTraitHeaders.get(libraryTraitId))` with `id` replaced by the trait key. Traits are emitted only when used by a message/operation (like the v1 resolver).
- `ResolvedOperation.channelRef` = channel key (or externalRef key); `messageRefs`, `traitRefs`, `reply.channelRef/messageRefs` mapped from keys.
- `planDocumentArtifacts`: for each message key → the set of `channel.format` over (a) channels listing the message in `messageKeys` and (b) channels of operations/replies that use the message; `keyFormats` = same formats only for channels with `protocol === "kafka"` (a Kafka key is emitted only on Kafka channels).
- Problems (missing artifacts for a used message, missing library trait, missing external item) collect into one `err({ code: "UNRESOLVED_REFERENCES", message, details: { problems: [{ pointer, message }] } })`.

- [ ] **Step 1: Write the failing test** `tests/unit/lib/events/document/resolve.test.ts` with the worked example from spec §6.2 as a document:

```ts
import { describe, expect, it } from "vitest";
import { planDocumentArtifacts, resolveDocument, type ResolveDocumentInput } from "@/lib/events/document/resolve";
import { emptyEventDocument, type EventDocument } from "@/lib/events/document/types";
import { assembleAsyncApi3 } from "@/lib/event-specs/assemble";

const avro = (name: string) => ({ format: "avro" as const, schema: { type: "record", name, fields: [] } });
const doc = (): EventDocument => ({
  ...emptyEventDocument("checkout-service"),
  servers: [{ key: "kafka-prod", protocol: "kafka", host: "kafka-prod.internal:9092" }],
  channels: [{ key: "orders", address: "payments.orders.v1", protocol: "kafka", serverKeys: ["kafka-prod"], bindings: { kafka: { partitions: 12 } }, format: "avro", messageKeys: ["OrderCreated"] }],
  messages: [{ key: "OrderCreated", contentType: "avro/binary", payload: { entityId: "e1", entityVersionId: "v1" }, keyPin: { entityId: "e2", entityVersionId: "v2" }, traitKeys: ["CloudEvents"] }],
  traits: [{ key: "CloudEvents", kind: "MESSAGE", spec: {} }],
  operations: [{ key: "publishOrderCreated", action: "send", channelKey: "orders", messageKeys: ["OrderCreated"], traitKeys: [] }],
});
const input = (d = doc()): ResolveDocumentInput => ({
  doc: d, productSlug: "checkout", version: "2.0",
  artifacts: new Map([["OrderCreated", { payloads: [avro("Order")], keys: [avro("OrderKey")] }]]),
  localTraitHeaders: new Map([["CloudEvents", { format: "json-schema", dialect: "draft-07", schema: { type: "object", properties: { ce_id: { type: "string" } } } }]]),
  libraryTraits: new Map(), libraryTraitHeaders: new Map(), external: new Map(),
});

describe("planDocumentArtifacts", () => {
  it("renders payload and key in the format of every channel carrying the message", () => {
    expect(planDocumentArtifacts(doc()).get("OrderCreated")).toEqual({ payloadFormats: ["avro"], keyFormats: ["avro"] });
  });
  it("skips key formats for non-Kafka channels", () => {
    const d = doc(); d.channels[0].protocol = "googlepubsub";
    expect(planDocumentArtifacts(d).get("OrderCreated")?.keyFormats).toEqual([]);
  });
  it("includes channels reached only through operations or replies", () => {
    const d = doc(); d.channels[0].messageKeys = [];
    d.channels.push({ key: "audit", address: "a", protocol: "kafka", serverKeys: [], format: "json-schema", formatDialect: "draft-07", messageKeys: ["OrderCreated"] });
    d.operations[0].reply = { channelKey: "audit", messageKeys: ["OrderCreated"] };
    expect(planDocumentArtifacts(d).get("OrderCreated")?.payloadFormats.sort()).toEqual(["avro", "json-schema"]);
  });
});

describe("resolveDocument", () => {
  it("maps keys to ids and produces an assemblable spec", () => {
    const r = resolveDocument(input());
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.info).toMatchObject({ title: "checkout-service", version: "2.0" });
    expect(r.data.channels[0]).toMatchObject({ id: "orders", address: "payments.orders.v1", protocol: "kafka", profile: { format: "avro" } });
    expect(r.data.messages[0]).toMatchObject({ id: "OrderCreated", traitRefs: ["CloudEvents"] });
    expect(r.data.operations[0]).toMatchObject({ key: "publishOrderCreated", channelRef: "orders", messageRefs: ["OrderCreated"] });
    const assembled = assembleAsyncApi3(r.data);
    expect(assembled.diagnostics.filter((x) => x.severity === "error")).toEqual([]);
    expect((assembled.document.channels as Record<string, unknown>)).toHaveProperty("orders");
  });
  it("reports one UNRESOLVED_REFERENCES error listing every missing piece", () => {
    const i = input(); i.artifacts = new Map();
    const d = i.doc; d.traits = [{ key: "CloudEvents", kind: "MESSAGE", libraryTraitId: "gone" }];
    const r = resolveDocument(i);
    expect(r.success).toBe(false);
    if (r.success) return;
    expect(r.error.code).toBe("UNRESOLVED_REFERENCES");
    const pointers = (r.error.details as { problems: Array<{ pointer: string }> }).problems.map((p) => p.pointer);
    expect(pointers).toContain("/messages/0");
    expect(pointers).toContain("/traits/0/libraryTraitId");
  });
  it("uses a library trait's frozen copy and header artifact", () => {
    const i = input(); i.doc.traits = [{ key: "CloudEvents", kind: "MESSAGE", libraryTraitId: "lib-1" }];
    i.libraryTraits = new Map([["lib-1", { id: "lib-1", name: "CloudEvents", kind: "MESSAGE", ownerSlug: "acme", spec: { summary: "ce" }, headersEntityId: null, headersEntityVersionId: null }]]);
    const r = resolveDocument(i);
    expect(r.success && r.data.traits[0]).toMatchObject({ id: "CloudEvents", ownerSlug: "acme", spec: { summary: "ce" } });
  });
  it("substitutes external items under the external ref key", () => {
    const i = input();
    i.doc.externalRefs = [{ key: "ext-orders", eventVersionId: "ev9", kind: "channel", itemKey: "orders" }];
    i.doc.operations.push({ key: "recv", action: "receive", channelKey: "ext-orders", messageKeys: ["OrderCreated"], traitKeys: [] });
    i.external = new Map([["ext-orders", { channel: { id: "orders", name: "orders", productSlug: "checkout", address: "payments.orders.v1", protocol: "kafka", profile: { format: "avro" } } }]]);
    const r = resolveDocument(i);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.channels.map((c) => c.id).sort()).toEqual(["ext-orders", "orders"]);
  });
});
```
(The third `planDocumentArtifacts` test: after moving the Avro channel's message list to empty, `OrderCreated` is still used by the operation on Avro channel `orders` and by the reply on JSON Schema channel `audit`, so `payloadFormats` is `["avro", "json-schema"]`.)

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/unit/lib/events/document/resolve.test.ts`
Expected: FAIL — cannot resolve `@/lib/events/document/resolve`.

- [ ] **Step 3: Implement `resolve.ts`** following the behavior list above. Skeleton:

```ts
export function planDocumentArtifacts(doc: EventDocument) {
  const channelByKey = new Map(doc.channels.map((c) => [c.key, c]));
  const plan = new Map<string, { payloadFormats: Set<PayloadFormat>; keyFormats: Set<PayloadFormat> }>();
  const add = (channelKey: string | undefined, messageKeys: readonly string[] | undefined) => {
    const channel = channelKey === undefined ? undefined : channelByKey.get(channelKey);
    if (!channel) return; // external channels bring their own rendered messages
    for (const key of messageKeys ?? []) {
      const entry = plan.get(key) ?? { payloadFormats: new Set(), keyFormats: new Set() };
      entry.payloadFormats.add(channel.format);
      if (channel.protocol === "kafka") entry.keyFormats.add(channel.format);
      plan.set(key, entry);
    }
  };
  for (const c of doc.channels) add(c.key, c.messageKeys);
  for (const o of doc.operations) { add(o.channelKey, o.messageKeys); add(o.reply?.channelKey, o.reply?.messageKeys); }
  return new Map([...plan].map(([k, v]) => [k, { payloadFormats: [...v.payloadFormats], keyFormats: [...v.keyFormats] }]));
}
```
`resolveDocument`: build `problems` array; map channels (local → `{ id: key, name: key, productSlug, address, protocol, profile: { format, ...(formatDialect ? { dialect: formatDialect } : {}) }, title, summary, description, parameters, bindings, tags, externalDocs }`, dropping undefined); messages (require `artifacts.get(key)` with ≥1 payload, else problem `{ pointer: "/messages/<i>", message: 'Message "<key>" has no rendered payload' }`); traits (local → needs nothing; library → require `libraryTraits.get(libraryTraitId)` else problem `/traits/<i>/libraryTraitId`); operations; external refs (require `external.get(key)` to hold the item for its `kind`, else problem `/externalRefs/<i>`). Include only traits referenced by used messages/operations. Return `ok({ productSlug, info: { ...doc.info, version }, defaultContentType, servers: doc.servers.map(({ origin, ...s }) => s), operations, channels, messages, traits, components: doc.components ?? {} })`.

- [ ] **Step 4: Run test + type-check, commit**

Run: `npx vitest run tests/unit/lib/events/document/resolve.test.ts && npx tsc --noEmit`
Expected: PASS.
```bash
git add src/lib/events/document/resolve.ts tests/unit/lib/events/document/resolve.test.ts
git commit -m "feat(events): resolve an event document into a ResolvedEventSpec"
```

---

### Task A4: Event-level bump rules

**Files:**
- Create: `src/lib/events/document/bump.ts`
- Modify: `src/lib/events/bump-rules.ts` (export `comparePin`, `compareTraitHeaders`, `decide` **only if** they are not already exported — add `export`, change nothing else)
- Test: `tests/unit/lib/events/document/bump.test.ts`

**Interfaces:**
- Consumes: `EventDocument` (A2); `BumpDecision`, `comparePin`, `compareTraitHeaders`, `decide` from `@/lib/events/bump-rules`; `ResolvedPin`, `BumpTraitHeadersPin` (read the exact fields in `src/lib/events/bump-rules.ts:89-95` and `types.ts:51-57`).
- Produces:
```ts
export type EventBumpPinFact = Omit<ResolvedPin, "entityVersionId">; // { entityId, entityName, label, major }
export interface EventBumpSide {
  doc: EventDocument;
  /** facts per pinned entityVersionId (every pin in the doc must have one when it is non-null) */
  pins: Readonly<Record<string, EventBumpPinFact>>;
  /** per library trait id: its frozen headers pin (null = none) */
  libraryHeaders: Readonly<Record<string, BumpTraitHeadersPin | null>>;
  /** per external-ref eventVersionId: the referenced version's major number */
  externalMajors: Readonly<Record<string, number>>;
}
export function classifyEventBump(prev: EventBumpSide, next: EventBumpSide): BumpDecision;
```
Rules (spec §5). **MAJOR:** operation removed; a message removed from an operation or from a channel's `messageKeys`; channel removed; channel `address`/`protocol`/`format`/`formatDialect` changed (R78); message removed; payload/headers/key pin changed per `comparePin` (new entity major, pin added/removed/replaced → MAJOR; same-major move → MINOR); a trait removed from a message; trait headers pin changed per `compareTraitHeaders` (local traits via their `headers` pin, library traits via `libraryHeaders`); `contentType`, `correlationId` or `defaultContentType` changed; external ref removed; referenced `externalMajors` increased. **MINOR:** anything else that differs (docs, tags, examples, summaries, bindings, servers, info, new operations/messages/channels/traits, added message on operation, external minor move). Every MAJOR reason is a human-readable string in the decision. Read `decide` for how the `BumpDecision` is built and what an identical pair returns; do not invent new semantics.

- [ ] **Step 1: Write the failing test** `tests/unit/lib/events/document/bump.test.ts`. Build a `side(doc, overrides?)` helper with `pins: { v1: { entityId: "e1", entityName: "Order", label: "1.0", major: 1 }, v2: { …label "1.1", major: 1 }, v3: { …label "2.0", major: 2 } }`. One test per rule; each asserts `kind` (`"MAJOR"` or `"MINOR"` — confirm the literal names in `BumpDecision`) and that MAJOR carries a reason containing the thing named:

```ts
it("MAJOR when an operation is removed", () => { /* prev has ops [a,b], next [a] → major, reason mentions "b" */ });
it("MAJOR when a message is removed from an operation, MINOR when one is added", () => {});
it("MAJOR when a message is removed from a channel", () => {});
it("MAJOR when a channel is removed", () => {});
it.each(["address", "protocol", "format", "formatDialect"])("MAJOR when channel %s changes (R78)", () => {});
it("MAJOR when a message is removed", () => {});
it("MAJOR when the payload pin moves to a new entity major, MINOR for a same-major move", () => {});
it("MAJOR when a headers or key pin is added, removed or replaced", () => {});
it("MAJOR when a trait is removed from a message, MINOR when one is added", () => {});
it("MAJOR when a local trait's headers pin changes entity major; library trait via libraryHeaders", () => {});
it.each(["contentType", "correlationId"])("MAJOR when message %s changes", () => {});
it("MAJOR when defaultContentType changes", () => {});
it("MAJOR when an external ref is removed or its referenced major increases; MINOR for a minor move", () => {});
it("MINOR for description, tags, examples, summary, bindings, server and info edits", () => {});
it("MINOR for a brand-new channel, message, operation and trait", () => {});
it("a key rename is a removal plus an addition → MAJOR", () => {});
```
Write each body fully (build prev/next with small `doc()` mutations like the A2 tests do); no body may be left as a comment.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/unit/lib/events/document/bump.test.ts`
Expected: FAIL — cannot resolve `@/lib/events/document/bump`.

- [ ] **Step 3: Implement `bump.ts`.** Collect `major: string[]` and `minor: string[]`, diff by key with helper `byKey<T extends { key: string }>(items: T[]) => Map<string, T>`; reuse `comparePin(role, prevPin, nextPin, major, minor)` after converting a `DocMessage` pin to `ResolvedPin | null` through `side.pins[pin.entityVersionId]` (an unpinned/`null` version → `null`); reuse `compareTraitHeaders(traitName, prevHeadersPin, nextHeadersPin, major, minor)` with local trait pins converted the same way; compare scalar fields with `stableStringify`-style equality (import `stableStringify` from `bump-rules`, exporting it if needed); finally `return decide(major, minor)`.

- [ ] **Step 4: Run test + the old bump tests (must stay green), type-check, commit**

Run: `npx vitest run tests/unit/lib/events/document/bump.test.ts tests/unit/lib/events/bump-rules.test.ts && npx tsc --noEmit`
Expected: PASS.
```bash
git add src/lib/events tests/unit/lib/events
git commit -m "feat(events): event-level bump rules"
```

---

### Task A5: Edges and document reference collection

**Files:**
- Create: `src/lib/events/document/edges.ts`
- Test: `tests/unit/lib/events/document/edges.test.ts`

**Interfaces:**
- Consumes: `EventDocument`, `isLibraryTrait` (A2).
- Produces:
```ts
export interface DocumentEdge {
  role: "PAYLOAD" | "HEADERS" | "KEY" | "MESSAGE";
  toKind: "ENTITY_VERSION" | "EVENT_SPEC_VERSION";
  toId: string;
}
export function collectDocumentEdges(doc: EventDocument): DocumentEdge[];
export interface DocumentRefs {
  entityIds: string[];                                   // every pinned entity (versioned or not), unique, sorted
  pinnedVersionIds: string[];                            // unique, sorted
  unpinned: Array<{ pointer: string; entityId: string }>; // pins with entityVersionId === null
  libraryTraitIds: string[];
  externalVersionIds: string[];
}
export function collectDocumentRefs(doc: EventDocument): DocumentRefs;
```
Edge rules: one edge per non-null message pin (`payload`→PAYLOAD, `headers`→HEADERS, `keyPin`→KEY → `ENTITY_VERSION`), one `HEADERS` edge per local trait headers pin, one `MESSAGE`/`EVENT_SPEC_VERSION` edge per external ref; deduplicated on `(role,toKind,toId)`; sorted by role, toKind, toId. Unpinned pins create **no** edge but appear in `unpinned` (pointers like `/messages/0/payload`).

- [ ] **Step 1: Write the failing test** `tests/unit/lib/events/document/edges.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { collectDocumentEdges, collectDocumentRefs } from "@/lib/events/document/edges";
import { emptyEventDocument, type EventDocument } from "@/lib/events/document/types";

const doc = (): EventDocument => ({
  ...emptyEventDocument("t"),
  messages: [
    { key: "A", payload: { entityId: "e1", entityVersionId: "v1" }, headers: { entityId: "e2", entityVersionId: "v2" }, keyPin: { entityId: "e3", entityVersionId: null }, traitKeys: ["T"] },
    { key: "B", payload: { entityId: "e1", entityVersionId: "v1" }, traitKeys: [] },
  ],
  traits: [
    { key: "T", kind: "MESSAGE", spec: {}, headers: { entityId: "e4", entityVersionId: "v4" } },
    { key: "L", kind: "OPERATION", libraryTraitId: "lib-9" },
  ],
  externalRefs: [{ key: "x", eventVersionId: "ev-7", kind: "message", itemKey: "M" }],
});

describe("collectDocumentEdges", () => {
  it("emits pinned edges, trait header edges and external-ref edges, deduplicated and sorted", () => {
    expect(collectDocumentEdges(doc())).toEqual([
      { role: "HEADERS", toKind: "ENTITY_VERSION", toId: "v2" },
      { role: "HEADERS", toKind: "ENTITY_VERSION", toId: "v4" },
      { role: "MESSAGE", toKind: "EVENT_SPEC_VERSION", toId: "ev-7" },
      { role: "PAYLOAD", toKind: "ENTITY_VERSION", toId: "v1" },
    ]);
  });
  it("creates no edge for an unpinned pin", () => {
    expect(collectDocumentEdges(doc()).some((e) => e.role === "KEY")).toBe(false);
  });
  it("is empty for the empty document", () => {
    expect(collectDocumentEdges(emptyEventDocument("t"))).toEqual([]);
  });
});

describe("collectDocumentRefs", () => {
  it("lists entities, versions, unpinned pins, library traits and external versions", () => {
    expect(collectDocumentRefs(doc())).toEqual({
      entityIds: ["e1", "e2", "e3", "e4"],
      pinnedVersionIds: ["v1", "v2", "v4"],
      unpinned: [{ pointer: "/messages/0/keyPin", entityId: "e3" }],
      libraryTraitIds: ["lib-9"],
      externalVersionIds: ["ev-7"],
    });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/unit/lib/events/document/edges.test.ts`
Expected: FAIL — cannot resolve `@/lib/events/document/edges`.

- [ ] **Step 3: Implement `edges.ts`.**

```ts
import { isLibraryTrait, type EventDocument } from "./types";
import type { EntityPin } from "@/lib/events/types";

export interface DocumentEdge { role: "PAYLOAD" | "HEADERS" | "KEY" | "MESSAGE"; toKind: "ENTITY_VERSION" | "EVENT_SPEC_VERSION"; toId: string }
export interface DocumentRefs { entityIds: string[]; pinnedVersionIds: string[]; unpinned: Array<{ pointer: string; entityId: string }>; libraryTraitIds: string[]; externalVersionIds: string[] }

type PinSite = { pointer: string; role: "PAYLOAD" | "HEADERS" | "KEY"; pin: EntityPin };

function pinSites(doc: EventDocument): PinSite[] {
  const sites: PinSite[] = [];
  doc.messages.forEach((m, i) => {
    sites.push({ pointer: `/messages/${i}/payload`, role: "PAYLOAD", pin: m.payload });
    if (m.headers) sites.push({ pointer: `/messages/${i}/headers`, role: "HEADERS", pin: m.headers });
    if (m.keyPin) sites.push({ pointer: `/messages/${i}/keyPin`, role: "KEY", pin: m.keyPin });
  });
  doc.traits.forEach((t, i) => {
    if (!isLibraryTrait(t) && t.headers) sites.push({ pointer: `/traits/${i}/headers`, role: "HEADERS", pin: t.headers });
  });
  return sites;
}
const uniqueSorted = (xs: string[]) => [...new Set(xs)].sort();

export function collectDocumentEdges(doc: EventDocument): DocumentEdge[] {
  const edges = new Map<string, DocumentEdge>();
  const add = (e: DocumentEdge) => edges.set(`${e.role}|${e.toKind}|${e.toId}`, e);
  for (const s of pinSites(doc)) if (s.pin.entityVersionId) add({ role: s.role, toKind: "ENTITY_VERSION", toId: s.pin.entityVersionId });
  for (const r of doc.externalRefs) add({ role: "MESSAGE", toKind: "EVENT_SPEC_VERSION", toId: r.eventVersionId });
  return [...edges.values()].sort((a, b) => a.role.localeCompare(b.role) || a.toKind.localeCompare(b.toKind) || a.toId.localeCompare(b.toId));
}

export function collectDocumentRefs(doc: EventDocument): DocumentRefs {
  const sites = pinSites(doc);
  return {
    entityIds: uniqueSorted(sites.map((s) => s.pin.entityId)),
    pinnedVersionIds: uniqueSorted(sites.flatMap((s) => (s.pin.entityVersionId ? [s.pin.entityVersionId] : []))),
    unpinned: sites.filter((s) => !s.pin.entityVersionId).map((s) => ({ pointer: s.pointer, entityId: s.pin.entityId })),
    libraryTraitIds: uniqueSorted(doc.traits.flatMap((t) => (isLibraryTrait(t) ? [t.libraryTraitId] : []))),
    externalVersionIds: uniqueSorted(doc.externalRefs.map((r) => r.eventVersionId)),
  };
}
```

- [ ] **Step 4: Run test + type-check, commit**

Run: `npx vitest run tests/unit/lib/events/document/edges.test.ts && npx tsc --noEmit`
Expected: PASS.
```bash
git add src/lib/events/document/edges.ts tests/unit/lib/events/document/edges.test.ts
git commit -m "feat(events): collect edges and references from an event document"
```

---

### Task A6: Event service (create, update document, rename, delete, get, list)

**Files:**
- Create: `src/services/events/event.service.ts`
- Test: `tests/integration/services/events/event.service.test.ts`

**Interfaces:**
- Consumes: A2 (`parseEventDocument`, `emptyEventDocument`, `EventDocument`), A5 (`collectDocumentEdges`, `collectDocumentRefs`); existing `auditedWrite`, `createInScope`, `writeWithUniqueName`, `ServiceErrorRejection`, `loadOwnedRow`, `requireId`, `optionalString`, `normalizeCatalogName`, `replaceReferences`, `deleteReferencesFrom`, `resolvePin` (`src/services/events/pins.ts:14`), `formatVersionLabel`. Copy the structure of `src/services/events/event-spec.service.ts` (`createEventSpec` :113-139, `updateEventSpecDocument` :141-170, `renameEventSpec` :172-187, `deleteEventSpec` :189-204) — same select, same audit/transaction pattern, same `loadOwned` ownership read (spec §10).
- Produces:
```ts
export interface EventDetail {
  id: string; name: string; specType: string; document: EventDocument;
  latestVersionLabel: string | null; hasUnpublishedChanges: boolean;
  tenantId: string; domainId: string | null; productId: string | null;
}
export interface CreateEventInput { name: string; title?: string; description?: string }
export function createEvent(productId: string, input: CreateEventInput, ctx: ServiceContext): Promise<Result<EventDetail>>;
export function updateEventDocument(id: string, document: unknown, owner: ScopeTarget, ctx: ServiceContext): Promise<Result<EventDetail>>;
export function renameEvent(id: string, rawName: unknown, owner: ScopeTarget, ctx: ServiceContext): Promise<Result<EventDetail>>;
export function deleteEvent(id: string, owner: ScopeTarget, ctx: ServiceContext): Promise<Result<{ id: string }>>;
export function getEvent(id: string, ctx: ServiceContext): Promise<Result<EventDetail>>;
```
Behavior beyond the copy:
- `createEvent` writes `emptyEventDocument(title || name, description)` (`documentVersion: 2`).
- `toDetail` parses with `parseEventDocument`; a stored v1 document (no `documentVersion: 2`) yields `DATA_CORRUPT` (it is read by the old services, never this one).
- `updateEventDocument` validates references in this order and returns one `VALIDATION_ERROR` with all `{ pointer, message }` problems:
  1. `parseEventDocument` problems (pass through).
  2. **Pins:** every `entityId` must exist in the same tenant (use `resolvePin`'s existence rules; a non-null `entityVersionId` must belong to that entity); a pin to an entity of another tenant is a problem at its pointer.
  3. **Library traits:** each `libraryTraitId` must be a trait of the same tenant, level tenant or the event's domain (never another domain), of the same `kind` as the document trait.
  4. **External refs:** `eventVersionId` must be a *published* `EventSpecVersion` of the same tenant and not of this event; `kind/itemKey` must exist in that version's `resolvedSpec` (`channels[].id` or `messages[].id`, ids = local keys). Own-product refs are allowed but pointless; allow them.
- Writes: `tx.eventSpec.update({ data: { document, hasUnpublishedChanges: true } })` then `replaceReferences(tx, { kind: "EVENT_SPEC", id }, collectDocumentEdges(doc), true)` in the same transaction.
- `deleteEvent`: block (`CONFLICT`-style error, mirror the code `assetInUseError` uses in `delete-guards.ts:302`) when any `schema_references` row has `toKind = 'EVENT_SPEC_VERSION'` and `toId` in this event's version ids; the message lists referrers as "<event name> (<domain>/<product>)" (read `event.name`/product through `fromId` → `eventSpec`/`eventSpecVersion`). Otherwise delete edges from `EVENT_SPEC` and `EVENT_SPEC_VERSION` then the row, like `deleteEventSpec`.

- [ ] **Step 1: Write the failing integration test** `tests/integration/services/events/event.service.test.ts` using the shared helpers:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanupDomains, connectTestDb, createProductScope, testContext, unwrap } from "./helpers";
import { createEvent, deleteEvent, getEvent, renameEvent, updateEventDocument } from "@/services/events/event.service";
import { emptyEventDocument, type EventDocument } from "@/lib/events/document/types";

const prisma = connectTestDb();
const domainIds: string[] = [];
afterAll(async () => { await cleanupDomains(prisma, domainIds); await prisma.$disconnect(); });

async function setup() {
  const ctx = await testContext(prisma);
  const scope = await createProductScope(prisma, ctx);
  domainIds.push(scope.domain.id);
  const owner = { level: "PRODUCT" as const, productId: scope.product.id };
  const entity = await scope.publishedEntity("Order");
  return { ctx, scope, owner, entity };
}
const withMessage = (entityId: string, versionId: string | null): EventDocument => ({
  ...emptyEventDocument("svc"),
  channels: [{ key: "orders", address: "o", protocol: "kafka", serverKeys: [], format: "avro", messageKeys: ["OrderCreated"] }],
  messages: [{ key: "OrderCreated", payload: { entityId, entityVersionId: versionId }, traitKeys: [] }],
  operations: [{ key: "pub", action: "send", channelKey: "orders", messageKeys: ["OrderCreated"], traitKeys: [] }],
});

describe("event.service", () => {
  it("creates an empty v2 event and reads it back", async () => {
    const { ctx, scope } = await setup();
    const created = unwrap(await createEvent(scope.product.id, { name: "checkout", description: "d" }, ctx));
    expect(created.document.documentVersion).toBe(2);
    expect(created.document.info).toEqual({ title: "checkout", description: "d" });
    expect(unwrap(await getEvent(created.id, ctx)).name).toBe("checkout");
  });
  it("saves a document with pins and writes draft edges", async () => {
    const { ctx, scope, owner, entity } = await setup();
    const ev = unwrap(await createEvent(scope.product.id, { name: "e1" }, ctx));
    const saved = unwrap(await updateEventDocument(ev.id, withMessage(entity.entity.id, entity.version.id), owner, ctx));
    expect(saved.hasUnpublishedChanges).toBe(true);
    const edges = await prisma.schemaReference.findMany({ where: { fromKind: "EVENT_SPEC", fromId: ev.id } });
    expect(edges.map((e) => [e.role, e.toKind, e.toId])).toEqual([["PAYLOAD", "ENTITY_VERSION", entity.version.id]]);
  });
  it("replaces edges on every save and drops them when the pin is removed", async () => {
    const { ctx, scope, owner, entity } = await setup();
    const ev = unwrap(await createEvent(scope.product.id, { name: "e2" }, ctx));
    unwrap(await updateEventDocument(ev.id, withMessage(entity.entity.id, entity.version.id), owner, ctx));
    unwrap(await updateEventDocument(ev.id, emptyEventDocument("svc"), owner, ctx));
    expect(await prisma.schemaReference.count({ where: { fromKind: "EVENT_SPEC", fromId: ev.id } })).toBe(0);
  });
  it("accepts an unpinned pin as a draft but records no edge", async () => {
    const { ctx, scope, owner, entity } = await setup();
    const ev = unwrap(await createEvent(scope.product.id, { name: "e3" }, ctx));
    unwrap(await updateEventDocument(ev.id, withMessage(entity.entity.id, null), owner, ctx));
    expect(await prisma.schemaReference.count({ where: { fromKind: "EVENT_SPEC", fromId: ev.id } })).toBe(0);
  });
  it("rejects every problem at once with JSON-pointer details", async () => {
    const { ctx, scope, owner } = await setup();
    const ev = unwrap(await createEvent(scope.product.id, { name: "e4" }, ctx));
    const r = await updateEventDocument(ev.id, withMessage("no-such-entity", null), owner, ctx);
    expect(r.success).toBe(false);
    if (r.success) return;
    expect(r.error.code).toBe("VALIDATION_ERROR");
    expect((r.error.details as { problems: Array<{ pointer: string }> }).problems.map((p) => p.pointer)).toContain("/messages/0/payload/entityId");
  });
  it("rejects a pin to an entity of another tenant and a version that belongs to another entity", async () => {
    const { ctx, scope, owner, entity } = await setup();
    const other = await scope.publishedEntity("Other");
    const ev = unwrap(await createEvent(scope.product.id, { name: "e5" }, ctx));
    const r = await updateEventDocument(ev.id, withMessage(entity.entity.id, other.version.id), owner, ctx);
    expect(r.success).toBe(false);
  });
  it("rejects a library trait from another domain", async () => { /* create a domain-level Trait in a second domain via prisma.trait.create(...) then expect VALIDATION_ERROR at /traits/0/libraryTraitId */ });
  it("rejects an external ref to an unpublished or unknown event version, accepts a published one with a known item", async () => { /* prisma-seed an eventSpecVersion with resolvedSpec { channels:[{id:"orders"}], messages:[{id:"M"}] } */ });
  it("renames with name-registry uniqueness and refuses a duplicate in the same line", async () => {
    const { ctx, scope, owner } = await setup();
    const a = unwrap(await createEvent(scope.product.id, { name: "alpha" }, ctx));
    unwrap(await createEvent(scope.product.id, { name: "beta" }, ctx));
    expect((await renameEvent(a.id, "beta", owner, ctx)).success).toBe(false);
    expect(unwrap(await renameEvent(a.id, "gamma", owner, ctx)).name).toBe("gamma");
  });
  it("enforces ownership: another product's owner cannot write", async () => {
    const { ctx, scope } = await setup();
    const ev = unwrap(await createEvent(scope.product.id, { name: "e6" }, ctx));
    const stranger = { level: "PRODUCT" as const, productId: "someone-else" };
    const r = await updateEventDocument(ev.id, emptyEventDocument("x"), stranger, ctx);
    expect(r.success).toBe(false);
  });
  it("blocks deleting an event whose published version is referenced by another event", async () => { /* seed version + schema_reference toKind EVENT_SPEC_VERSION; expect failure naming the referrer; after removing the edge, delete succeeds and edges are gone */ });
  it("deletes an unreferenced event with its edges", async () => {
    const { ctx, scope, owner, entity } = await setup();
    const ev = unwrap(await createEvent(scope.product.id, { name: "e7" }, ctx));
    unwrap(await updateEventDocument(ev.id, withMessage(entity.entity.id, entity.version.id), owner, ctx));
    unwrap(await deleteEvent(ev.id, owner, ctx));
    expect(await prisma.eventSpec.count({ where: { id: ev.id } })).toBe(0);
    expect(await prisma.schemaReference.count({ where: { fromKind: "EVENT_SPEC", fromId: ev.id } })).toBe(0);
  });
  it("maps an unexpected database failure to a DB_ERROR Result instead of throwing", async () => { /* stub prisma.eventSpec.findUnique to reject, as usage.service.test.ts:245 does */ });
});
```
The four tests whose bodies are summarized in a `/* … */` comment are the cases the implementer must complete with the shown seeding approach (use `prisma.trait.create`, `prisma.eventSpecVersion.create` with the required columns copied from `tests/integration/services/events/event-spec-publish.service.test.ts`); no test may be left as an empty body.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/integration/services/events/event.service.test.ts`
Expected: FAIL — cannot resolve `@/services/events/event.service`.

- [ ] **Step 3: Implement `event.service.ts`** per the behavior list, copying the four reference functions' structure. Put the reference validation in a local `validateDocumentRefs(ctx, scope, doc)` returning `{ problems: DocumentProblem[] }` (pins via one `findMany` of entities by id with tenant filter and one `findMany` of entity versions by id; library traits via one `findMany`; external refs via one `findMany` of versions with `published` check — an `EventSpecVersion` row exists only for published versions).

- [ ] **Step 4: Run test, then the old service tests (must stay green), type-check, commit**

Run: `npx vitest run tests/integration/services/events/event.service.test.ts tests/integration/services/events/event-spec.service.test.ts && npx tsc --noEmit`
Expected: PASS.
```bash
git add src/services/events/event.service.ts tests/integration/services/events/event.service.test.ts
git commit -m "feat(events): event service for self-contained documents"
```

---

### Task A7: Snapshot, emit and preview

**Files:**
- Create: `src/services/events/event-snapshot.ts`, `src/services/events/event-emit.service.ts`
- Test: `tests/integration/services/events/event-emit.service.test.ts`

**Interfaces:**
- Consumes: A2, A3 (`planDocumentArtifacts`, `resolveDocument`, `MessageArtifacts`, `ExternalItems`), A5 (`collectDocumentRefs`); existing `ArtifactRenderer`, `ArtifactSubject`, `getSharedArtifactRenderer` (`artifact-renderer.ts`), `assembleAsyncApi3`, the serializer/validator used by `event-spec-emit.service.ts` (read its `emitDraft` :94-115 and `emitStoredVersion`; reuse the same `EmitDeps` and output type `EmitOutput`), `toFrozenTrait` / `traitHeadersSubject` (`catalog-mapping.ts`), `TRAIT_SELECT`, `loadDraftSnapshot` + `resolveSnapshot` (`event-spec-resolver.ts` — mirror, do not modify).
- Produces:
```ts
// event-snapshot.ts
export interface EventSnapshot {
  event: { id: string; name: string; tenantId: string; domainId: string; productId: string; productSlug: string; specType: string };
  document: EventDocument;
  latest: { id: string; major: number; minor: number; sourceDocument: unknown; resolvedSpec: unknown } | null;
  libraryTraits: Map<string, FrozenTrait>;   // by libraryTraitId
  external: Map<string, ExternalItems>;      // by externalRef key, from the referenced version's stored resolvedSpec
  externalMajors: Record<string, number>;    // by eventVersionId
}
export function loadEventSnapshot(db: Db, eventId: string, override?: EventDocument): Promise<Result<EventSnapshot>>;
export function resolveEventSnapshot(snapshot: EventSnapshot, renderer: ArtifactRenderer, version: string): Promise<{ resolved: ResolvedEventSpec | null; diagnostics: Diagnostic[] }>;
// event-emit.service.ts
export function emitEventDraft(eventId: string, productId: string, ctx: ServiceContext, deps?: EmitDeps): Promise<Result<EmitOutput>>;
export function emitEventDocumentPreview(eventId: string, productId: string, document: unknown, ctx: ServiceContext, deps?: EmitDeps): Promise<Result<EmitOutput>>;
export function emitEventStoredVersion(eventId: string, productId: string, version: string, ctx: ServiceContext): Promise<Result<EmitOutput>>;
```
Behavior:
- `loadEventSnapshot` reads the event (tenant-scoped; `productSlug` via product), the library `Trait` rows by `libraryTraitId` (`TRAIT_SELECT` + `toFrozenTrait`), and for each external ref the referenced `EventSpecVersion` (`id`, `major`, `minor`, `resolvedSpec`); the external item is `resolvedSpec.channels.find(id === itemKey)` or `resolvedSpec.messages.find(...)` (for a channel ref also the traits its messages use are *not* pulled — an external message brings its own `traitRefs` into `ExternalItems.traits` from `resolvedSpec.traits`). A missing item makes the resolve step report `UNRESOLVED_REFERENCES` (do not fail the load).
- `resolveEventSnapshot` renders artifacts through `renderer.render(subject, format)` exactly like `resolveSnapshot` does: for each message, `planDocumentArtifacts` formats; subject = `{ kind: "version", entityVersionId }` when pinned else `{ kind: "draft", entityId }`; failures become `Diagnostic`s (reuse `renderDiagnostic` semantics) and the message is skipped (resolve then reports it unresolved). Local-trait and library-trait header pins render as `json-schema` (draft-07), like v1 trait headers.
- `emitEventDocumentPreview` parses `document` with `parseEventDocument` (problems → `VALIDATION_ERROR` with details) and runs the same pipeline with `override`, **writing nothing**.
- `emitEventStoredVersion` reads the stored `document` (assembled AsyncAPI) from the version row exactly as `emitStoredVersion` does — no re-rendering.
- Ownership: `assertOwnedEventSpec`-style check that the event belongs to `productId` (copy `event-spec-publish.service.ts:41-52`).

- [ ] **Step 1: Write the failing integration test** `tests/integration/services/events/event-emit.service.test.ts`. Use a stub renderer through `deps` like `tests/integration/services/events/event-spec-emit.test.ts` does (read it; reuse its stub renderer and `EmitDeps` shape). Cases (write each body fully):

```ts
it("emits an AsyncAPI document for a draft with one pinned message", async () => {
  // createEvent + updateEventDocument with channel/message/operation (pin to a published entity); emitEventDraft(...) with the stub renderer
  // expect out.document.asyncapi === "3.0.0"; out.document.channels has "orders" (or the qualified key the assembler produces); no error diagnostics; out.yaml and out.json non-empty
});
it("previews unsaved edits without writing", async () => {
  // call emitEventDocumentPreview with a modified document; then read prisma.eventSpec.document and assert it is unchanged
});
it("reports a diagnostic and still returns when a payload cannot be rendered", async () => {
  // stub renderer that returns err for the payload; expect result success with an error Diagnostic mentioning the message key (resolved null → diagnostics only)
});
it("uses an unpublished entity draft for the preview", async () => { /* pin with entityVersionId null → renderer is called with { kind: "draft", entityId } */ });
it("substitutes an external message from a published version's resolvedSpec", async () => {
  // seed a published EventSpecVersion with resolvedSpec containing channels/messages (ResolvedChannel/ResolvedMessage shapes); doc has externalRef + receive operation; expect the emitted document to contain the external channel
});
it("emits a stored version from the saved AsyncAPI document without rendering", async () => { /* seed version row with document; renderer stub must not be called */ });
it("rejects a preview document that fails the parser, with pointer problems", async () => {});
it("rejects an event that belongs to another product", async () => {});
it("maps an unexpected database failure to a DB_ERROR Result", async () => {});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/integration/services/events/event-emit.service.test.ts`
Expected: FAIL — cannot resolve `@/services/events/event-emit.service`.

- [ ] **Step 3: Implement `event-snapshot.ts` and `event-emit.service.ts`** per the behavior list, mirroring `event-spec-resolver.ts` and `event-spec-emit.service.ts` file by file.

- [ ] **Step 4: Run test + old emit tests (stay green), type-check, commit**

Run: `npx vitest run tests/integration/services/events/event-emit.service.test.ts tests/integration/services/events/event-spec-emit.test.ts && npx tsc --noEmit`
Expected: PASS.
```bash
git add src/services/events/event-snapshot.ts src/services/events/event-emit.service.ts tests/integration/services/events/event-emit.service.test.ts
git commit -m "feat(events): snapshot, emit and preview for event documents"
```

---

### Task A8: Publish

**Files:**
- Create: `src/services/events/event-publish.service.ts`
- Test: `tests/integration/services/events/event-publish.service.test.ts`

**Interfaces:**
- Consumes: A2–A7; existing `analyzeVersionedPublish` / `planVersionedPublish` / `VersionedPublishInput` (`publish-plan.ts:41-98`), `EventPublishBlocker` kinds (`UNPUBLISHED_PIN`, `MISSING_ENTITY`, `MISSING_TRAIT`, `INVALID_SPEC`, `NO_CHANGES`, `UNRESOLVED_REFERENCE`, `VALIDATION_ERROR`), `publish-concurrency.ts` helpers, `toEventVersionSummary`/`version-summary.ts`, `EventVersionSummary`. **Read `src/services/events/event-spec-publish.service.ts` end to end first** (`gatherFacts` :80-102, `prepare` :128-151, `publishEventSpec` :173-257) and keep its structure: `preview` = analysis only; `publish` = prepare → transaction with locks → INSERT version → update event → replace edges.
- Produces:
```ts
export function previewEventPublish(eventId: string, productId: string, ctx: ServiceContext, deps?: EmitDeps): Promise<Result<EventPublishAnalysis>>;
export function publishEvent(eventId: string, productId: string, input: PublishInput, ctx: ServiceContext, deps?: EmitDeps): Promise<Result<EventVersionSummary>>;
export function listEventVersions(eventId: string, productId: string, ctx: ServiceContext): Promise<Result<EventVersionSummary[]>>;
```
(`PublishInput` is the existing type used by `publishEventSpec`; reuse it.)

Behavior:
- **Facts:** for every non-null pin, load entity-version facts (`label`, `major`, entity name) → `EventBumpSide.pins`; library traits' frozen headers pins → `libraryHeaders`; referenced external versions' majors → `externalMajors`. The *previous side* is built from `latest.sourceDocument` (a v2 document) with its own facts loaded by the same function; a `latest` whose `sourceDocument` is not a v2 document is treated as "no previous" only if the version has no `resolvedSpec`… **do not guess**: return `DATA_CORRUPT` for it (Phase C migration guarantees none exist).
- **Blockers:** unpinned pins (`UNPUBLISHED_PIN`, pointer from `collectDocumentRefs().unpinned`); pins whose entity version is missing/unpublished (`MISSING_ENTITY`); library trait missing (`MISSING_TRAIT`); resolver `UNRESOLVED_REFERENCES` (`UNRESOLVED_REFERENCE`); error diagnostics from the AsyncAPI validator (`INVALID_SPEC`); `NO_CHANGES` when the document equals the latest `sourceDocument` and no catalog drift (library trait changed since `frozenTraits`; reuse `hasCatalogDrift(frozen, live)` with channels empty).
- **Bump:** `classifyEventBump(prev, next)` feeds `planVersionedPublish`.
- **Write (single transaction, lock order matters):** `SELECT … FROM event_specs WHERE id = $1 FOR UPDATE`, then `SELECT … FROM entities WHERE id IN (pinned entity ids) FOR SHARE` (sorted ids; copy the raw-SQL helper pattern from `message.service.ts:263-280` and the entity side from `entity-version.service.ts:167`), re-check `latestVersionId` unchanged (`changedDuringPublish`), `INSERT event_spec_versions { document: assembled, sourceDocument: <v2 doc>, resolvedSpec: <ResolvedEventSpec>, frozenTraits: <library traits as FrozenTrait[]>, frozenChannels: [], messageVersionIds: [], major, minor, sequence, changeKind, compatReport (bump reasons), publishedById … same columns as v1 }`, update the event (`latestVersionId`, `hasUnpublishedChanges: false`), `replaceReferences(tx, { kind: "EVENT_SPEC_VERSION", id: versionId }, collectDocumentEdges(doc), false)`, and keep the draft edges (`EVENT_SPEC`, isDraft true) as they are.
- Audit through `auditedWrite` with `action: "PUBLISH_VERSION"`, `entityType: "EventSpec"`.

- [ ] **Step 1: Write the failing integration test** `tests/integration/services/events/event-publish.service.test.ts` (reuse the stub renderer approach of `event-spec-publish.service.test.ts`; write every body fully):

```ts
it("publishes 1.0 for a first publish and freezes document, sourceDocument and resolvedSpec", async () => {});
it("writes published edges from EVENT_SPEC_VERSION and keeps the draft edges", async () => {});
it("blocks publish while a pin is unpublished or unpinned, naming the pointer", async () => {});
it("blocks publish with NO_CHANGES when nothing changed, and after a library trait edit reports drift as a change", async () => {});
it("classifies bumps: payload pin to a new entity major → 2.0; same-major pin move → 1.1; docs-only edit → 1.1", async () => {});
it("lets the user raise the bump to major but never lower it", async () => {});
it("publishes an event that receives a message through an external ref and freezes the copy", async () => {});
it("returns CONFLICT-style 'changed while publishing' when the draft changes between prepare and write (simulate by updating the row in a hook)", async () => {});
it("serializes a concurrent save and publish without losing edges (Promise.all of updateEventDocument and publishEvent; afterwards published edges match the published document and draft edges match the saved document)", async () => {});
it("lists versions newest first", async () => {});
it("previewEventPublish writes nothing", async () => {});
it("rejects an event of another product and maps unexpected database failures to DB_ERROR", async () => {});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/integration/services/events/event-publish.service.test.ts`
Expected: FAIL — cannot resolve `@/services/events/event-publish.service`.

- [ ] **Step 3: Implement `event-publish.service.ts`** per the behavior list.

- [ ] **Step 4: Run test + old publish tests (stay green), type-check, commit**

Run: `npx vitest run tests/integration/services/events/event-publish.service.test.ts tests/integration/services/events/event-spec-publish.service.test.ts && npx tsc --noEmit`
Expected: PASS.
```bash
git add src/services/events/event-publish.service.ts tests/integration/services/events/event-publish.service.test.ts
git commit -m "feat(events): publish self-contained events"
```

---

### Task A9: Pin-integrity guards

**Files:**
- Create: `src/services/events/event-guards.ts`
- Modify (additive calls only): `src/services/entity.service.ts` (delete near :284-321 and retire flow), `src/services/events/trait.service.ts` (delete guard near :182), `src/lib/product-deletion.ts` and the product/domain delete paths (`src/services/product.service.ts:245`, `src/app/(dashboard)/schemas/[domainSlug]/actions.ts:417,439`, `src/app/(dashboard)/schemas/actions.ts:140`) — each gets one extra guard call whose result is merged with the existing guard's outcome.
- Test: `tests/integration/services/events/event-guards.test.ts`

**Interfaces:**
- Consumes: A5 edges (read `schema_references`), `Prisma` JSON containment for library traits.
- Produces:
```ts
export interface EventReferrer { eventId: string; eventName: string; domainName: string; productName: string; published: boolean }
export function findEntityEventReferrers(db: Db, entity: { id: string; tenantId: string }): Promise<EventReferrer[]>;   // draft AND published edges to any version of the entity
export function findLibraryTraitEventReferrers(db: Db, trait: { id: string; tenantId: string }): Promise<EventReferrer[]>; // documents with libraryTraitId, plus published frozenTraits
export function findEventVersionReferrers(db: Db, eventId: string): Promise<EventReferrer[]>;   // edges toKind EVENT_SPEC_VERSION for any version of the event
export function findCrossProductEventRefs(db: Db, scope: DeleteGuardScope): Promise<EventReferrer[]>; // events OUTSIDE the scope referencing event versions INSIDE it
export function eventsInUseError(kind: "Entity" | "Trait" | "Event" | "Product" | "Domain", name: string, found: EventReferrer[]): ServiceError | null;
```
Behavior: queries are tenant-scoped and bounded (copy `bounded()` / truncation flag handling from `delete-guards.ts:185-189`); `findEntityEventReferrers` covers an entity pinned **only in a draft** (draft edges have `isDraft: true`) and an unpinned pin (no edge): for unpinned pins also scan `event_specs.document` JSON containment (`messages[].payload.entityId`) so an entity named by an unpinned pin is protected too; `eventsInUseError` returns `null` for an empty list, otherwise a `CONFLICT`-shaped error whose message names up to 5 referrers ("Order is pinned by events: checkout (payments/checkout)…").
Wiring: entity delete and entity retire call `findEntityEventReferrers` (retire is blocked only for events with a *draft or published* pin on the **latest** version — read the existing retire flow before deciding the exact condition and keep the message consistent with it); trait delete calls `findLibraryTraitEventReferrers`; event delete (A6 already blocks on versions) is re-expressed through `findEventVersionReferrers` so one query serves both; product/domain delete merges `findCrossProductEventRefs` into the existing `findCrossProductPins` outcome.

- [ ] **Step 1: Write the failing integration test** `tests/integration/services/events/event-guards.test.ts` (write every body fully, using `createProductScope`, `createEvent`, `updateEventDocument`, `publishEvent`, `deleteEntity`/`retireEntity` from `@/services/entity.service` — find the exact export names there):

```ts
it("blocks deleting an entity pinned by a draft event, naming the event", async () => {});
it("still blocks after the event is published, and unblocks after the pin is removed and the draft saved (published edges keep protecting until the version is gone → expect still blocked by the published version)", async () => {});
it("protects an entity named only by an unpinned pin", async () => {});
it("does not block an entity pinned in another tenant (tenant isolation)", async () => {});
it("blocks deleting a library trait used by an event document", async () => {});
it("blocks deleting an event whose published version is externally referenced and names the referrer", async () => {});
it("blocks deleting a product whose published event is referenced from another product", async () => {});
it("returns a bounded referrer list (truncated flag) for an entity pinned by 60 events", async () => { /* seed 60 events through prisma.eventSpec.create + schemaReference.createMany */ });
it("maps an unexpected database failure to a DB_ERROR Result", async () => {});
```
Also extend `tests/unit/services/entity.service.test.ts` (or the closest existing entity-delete test) with one case that proves the old FK-based path still reports its existing message when the entity is pinned by a legacy message (regression).

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/integration/services/events/event-guards.test.ts`
Expected: FAIL — cannot resolve `@/services/events/event-guards`.

- [ ] **Step 3: Implement `event-guards.ts`**, then add the wiring calls in the listed existing files (additive: call the new guard, merge its error with the existing one — never remove an existing check).

- [ ] **Step 4: Run the new test and the full events baseline, type-check, commit**

Run: `npx vitest run tests/integration/services/events/event-guards.test.ts && npx vitest run event channel trait message entity product domain --reporter=dot && npx tsc --noEmit`
Expected: PASS (baseline files plus the new ones; no regression in the pre-existing 1159 tests).
```bash
git add src/services tests/integration/services/events/event-guards.test.ts src/lib/product-deletion.ts
git commit -m "feat(events): edge-based guards for entities, library traits, events and products"
```

---

## Phase A exit check

- [ ] `npx vitest run event channel trait message entity product domain --reporter=dot` — all green; test count = baseline (1159) + new tests.
- [ ] `npx tsc --noEmit` clean; `npm run lint` clean for new files.
- [ ] No existing file lost behavior: `git diff main --stat -- src` shows only additions plus the guard-wiring and `export` edits listed above.
- [ ] Record the outcome (task list, commits, deviations) in `.superpowers/sdd/2026-10-15-events-self-contained-phase-a/progress.md` (git-ignored ledger) and update the project memory file `events-asyncapi-program.md`.
- [ ] Phase B plan is written from the spec §10 and the UI impact map before any UI task starts.

# Events Phase 4a — Events Core: AsyncAPI 3 Document Assembler (pure layer)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a pure, fully unit-tested module tree under `src/lib/event-specs/` that turns an in-memory resolved event spec into a valid AsyncAPI 3.0.0 document (YAML + JSON + diagnostics) — spec §7.2 steps 3–7 — together with the pure cores of Story 16.2 (JSON Schema 2020-12 → draft-07 down-converter) and Story 16.3 (protobuf "root first + `// @RootNode`" post-processor).

**Architecture:** `types.ts` mirrors spec §6.1 `EventSpecDocument` (stored draft, IDs) and defines the resolved input model (`ResolvedEventSpec`: channels / messages / traits as objects, payload / headers / key as **pre-rendered** `SchemaArtifact`s). `resolve.ts` maps document + in-memory catalog → resolved model. `assemble.ts` builds the AsyncAPI document (schemaFormat mapping, headers rule, Kafka key placement, name-clash qualification, `$ref` wiring exactly as spec §6.2, deterministic ordering) and returns diagnostics instead of throwing. `serialize.ts` writes YAML (`yaml` v2) and JSON. `validator.ts` defines the pluggable `EventSpecValidator` interface plus a built-in structural validator; the `@asyncapi/parser`-backed validator (Story 18.5) plugs in later behind the same interface. `adapter.ts` implements spec §7.1 `EventSpecAdapter` as `AsyncApi3Adapter` (`emit` + `validate`; `import` → `NOT_IMPLEMENTED`).

**Tech Stack:** TypeScript (strict), Vitest 4 (node environment), `yaml` 2.8 (already a dependency). No new npm packages; no `@asyncapi/*` imports.

**Spec:** `docs/superpowers/specs/2026-10-13-events-asyncapi-design.md` — §1 definitions, §2 decisions (Q7, Q8, Q9, JSON Schema dialect, Protobuf root message), §6.1 data model, §6.2 worked example, §7 emission, §11 testing.

**Program context:** `docs/superpowers/plans/2026-10-13-events-asyncapi-phase-1.md` (phase table). Phase 4a is a fast-tracked, DB-free slice of Phase 4 (Epic 18) that runs in parallel with the database / versioning work.

## Story coverage

| Story | Delivered in Phase 4a | Left for later |
|---|---|---|
| 18.4 `EventSpecAdapter` + `AsyncApi3Adapter` emit pipeline | Adapter interface; `emit()` = assemble (§7.2 steps 3–5) + validate (step 6, pluggable) + serialize (step 7); `EventSpecDocument` → `ResolvedEventSpec` mapping over an in-memory catalog | DB-backed `emitEventSpec(specId, …)`: step 1 (stored published documents), step 2 catalog loading from Prisma, artifact rendering from `EntityVersionArtifact` |
| 18.5 Validation via `@asyncapi/parser` | `EventSpecValidator` interface + built-in structural validator; adapter runs a validator list | Parser-backed validator (registry-blocked) |
| 16.2 JSON Schema dialect profiles + down-converter | Pure `downConvertToDraft07()` (used by the assembler for headers / keys / draft-07 payload fallback) | Wiring into `@typespec/json-schema` rendering; dialect stored on Channel (18.1) |
| 16.3 Self-contained proto per payload | Pure `placeRootMessageFirst()` (root first + `// @RootNode`, idempotent) | Inlining referenced entities, import allow-list, wiring into proto rendering |
| Epic 19 import | `import()` returns `NOT_IMPLEMENTED` | Everything |

## Global Constraints

- **Parallel worktree, new files only.** This plan runs in a separate git worktree (Task 0) in parallel with other work. It creates files **only** under `src/lib/event-specs/` and `tests/unit/lib/event-specs/` (including `fixtures/` and `__golden__/`). It does not touch migrations, `prisma/schema.prisma`, `package.json` / lockfile, existing source or test files, or any shared module. The merge back is conflict-free by construction.
- **Pure.** No Prisma, no `fs` / network, no clock or randomness in `src/lib/event-specs/**`. Output is deterministic for equal input (Decision D6).
- **No new packages** (npm registry returns 403). Never import `@asyncapi/*`. Parser validation plugs in later as an `EventSpecValidator`.
- **YAML:** `import { stringify } from "yaml"` (v2, same as `src/lib/typespec-official/emitter.service.ts`); always pass `aliasDuplicateObjects: false`.
- **Result pattern:** anything that can fail returns `Result<T, ServiceError>` from `@/types/result` (`ok` / `err`); nothing throws. Document problems are `Diagnostic[]` (`severity`, `code`, `message`, RFC 6901 `pointer` into the emitted document).
- **Strict TypeScript**, no `any` in `src/`. Helper names must **not** start with `use…` — the repo ESLint config includes Next's React rules and `react-hooks/rules-of-hooks` flags such closures.
- **Tests:** Vitest unit tests in `tests/unit/lib/event-specs/**`. Support files in `tests/unit/lib/event-specs/fixtures/` are not `*.test.ts` (not collected) but are type-checked by `tsc`.
- **Baseline** (main checkout, `feat/events-asyncapi` @ `b3c6f20e`, 2026-10-14): `npx tsc --noEmit` clean; `npx vitest run` → **8 pre-existing failures** (db-emitter-parity ×4, e2e-critical-flows bigquery ×1 — integration; schemas-tab ×3 — unit). They are not regressions; the count must not grow.
- **Contract:** the emitted `checkout-service@2.0` document must be semantically equal to the YAML printed in spec §6.2 (Task 8 asserts it; Task 12 pins exact bytes in goldens).

## Design decisions resolved in this plan (review these)

| # | Decision |
|---|---|
| D1 | **Name-clash qualification** (§7.2 step 5). Names unique in the document stay plain. When one name comes from several owners, items owned by the spec's home product (`ResolvedEventSpec.productSlug`) keep the plain name and foreign items become `<ownerSlug>.<name>` (`checkout.orders`). If no clashing item is home, all are qualified. Anything still colliding (same owner, same name — e.g. two versions of one Message in one spec) gets `_2`, `_3`, … in key order plus a `NAME_DISAMBIGUATED` warning. Applies to channels, messages, message traits, operation traits (separately). |
| D2 | **Format suffixes** (§7.2 step 5): `avro` → `_avro`, JSON Schema draft-07 → `_json`, JSON Schema 2020-12 → `_json2020`, protobuf → `_proto`. Applied only when one Message is emitted in more than one format in the same document. When a message key differs from the Message name, the component carries `name: <original name>`. |
| D3 | **Headers** are emitted as a plain AsyncAPI Schema Object (as in §6.2), never wrapped in `schemaFormat`. A headers artifact must be JSON Schema with `type: object` → otherwise `HEADERS_NOT_OBJECT_SCHEMA` error and headers omitted. 2020-12 headers are down-converted. |
| D4 | **Kafka key** (§7.2 step 3): placed when the message variant is used on at least one channel with `protocol: "kafka"`; Avro key on Avro channels, JSON Schema draft-07 otherwise; emitted as a plain schema at `bindings.kafka.key` (first key of `kafka`, other bindings kept). A hand-written `bindings.kafka.key` is replaced with a `KEY_BINDING_OVERRIDDEN` warning. Missing rendering → `KEY_ARTIFACT_MISSING` error. |
| D5 | **`emit()` returns diagnostics, not failures.** `EmitOutput` = spec §7.1 `{ json, yaml, document }` + `diagnostics`. Callers decide (publish blocks on any `error`; draft preview shows them). Only a validator infrastructure failure (or throw) is an `err` Result. |
| D6 | **Deterministic ordering.** Maps (`servers`, `channels`, `operations`, every `components.*` map, `channel.messages`, `channel.parameters`) are sorted by key in UTF-16 order; authored arrays (operation messages, trait lists, tags, examples) keep their order; object keys follow a fixed canonical order (document: `asyncapi, info, servers, defaultContentType, channels, operations, components`; channel: `address, messages, title, summary, description, parameters, tags, externalDocs, bindings`; operation: `action, channel, summary, description, bindings, traits, messages, reply`; message: `name, title, summary, description, contentType, correlationId, traits, headers, payload, tags, externalDocs, bindings, examples`). User-supplied leaf content (schemas, bindings) keeps its own key order. |
| D7 | **Channel `messages`** = the messages referenced by operations (incl. replies) on that channel — not the catalog's full `ChannelMessage` allow-list, because a spec document contains only pinned MessageVersions. |
| D8 | **Embedded JSON Schema `$ref`s are rebased** onto their location in the document (`#/definitions/A` → `#/components/messages/M/payload/schema/definitions/A`) so they resolve from the document root (as the structural validator — and, we expect, `@asyncapi/parser` — resolves them). Data keywords (`const`, `enum`, `default`, `examples`) are not touched. Verify against the parser in Story 18.5. |
| D9 | JSON Schema without a dialect = `draft-07` (spec §2). A draft-07 channel falls back to a 2020-12 artifact via the down-converter, with each dropped keyword reported as `SCHEMA_KEYWORD_DROPPED` (warning). |
| D10 | Structural validator: an address parameter without a `parameters` entry is an **error**; a declared parameter missing from the address is a **warning**. Non-local `$ref` → `REMOTE_REF` error (spec §10: remote `$ref` off). |

## Review Focus

1. **`$ref` wiring identical to spec §6.2** — channel `messages.X` → `#/components/messages/X`; operation `channel` → `#/channels/<key>`; operation `messages[]` → `#/channels/<key>/messages/X`; message `traits[]` → `#/components/messageTraits/T`. Expected: `assembleAsyncApi3(checkoutServiceSpec)` deep-equals the parsed spec YAML. Tests in Tasks 8 and 12.
2. **Qualification with a foreign + home channel both named `orders`** — expected: home keeps `orders`, foreign becomes `checkout.orders`, and every `$ref` uses the qualified key. Same Message on an Avro and a JSON channel → `OrderCreated_avro` / `OrderCreated_json`. Tests in Tasks 5 and 8.
3. **Shuffled input arrays** (channels, messages, servers, operations reversed) — expected: byte-identical JSON. Test in Task 8; byte-stable YAML/JSON in Task 12.
4. **Headers that are not an object schema** (string schema, Avro, proto text) — expected: `HEADERS_NOT_OBJECT_SCHEMA` error, headers omitted, emit still succeeds. Tests in Tasks 6, 8, 10.
5. **Kafka key on a message used on Avro + JSON Kafka channels and on a Pulsar channel** — expected: Avro key on `_avro`, JSON key on `_json`, no key when only non-Kafka channels use the variant. Tests in Tasks 6 and 8.
6. **Down-converter walking only schema positions** — a property named `$defs`, `const: "#/$defs/X"`, and `default: { $ref }` must survive untouched; input never mutated. Test in Task 3.
7. **Proto scanner robustness** — braces inside strings / comments, a nested message with the root's name, stale `@RootNode` on another message, idempotency. Tests in Task 4.
8. **YAML anchors** — the same schema object referenced twice must not produce `&a1` / `*a1`. Test in Task 9.

## Out of scope (explicit)

- Prisma models `Channel`, `ChannelMessage`, `Trait`, `Message` / `MessageVersion`, `EventSpec` / `EventSpecVersion`, `SchemaReference` — **Story 18.1**, next phase after slim versioning.
- Services, server actions, audit, publish + bump rules (18.2, 18.3); §7.2 step 1 (return stored published document) and the DB-backed half of step 2 (loading the catalog snapshot).
- Entity → artifact rendering via TypeSpec emitters / `EntityVersionArtifact` (14.5); 16.2 / 16.3 wiring into rendering; proto inlining of referenced entities and import allow-list.
- UI (18.6, 18.8, Epic 20) and the REST endpoint (18.7).
- `@asyncapi/parser` validation (18.5, registry-blocked) and AsyncAPI `import()` (Epic 19) — `import()` returns `NOT_IMPLEMENTED`.

---

## File structure (Phase 4a)

| File | Responsibility |
|---|---|
| `src/lib/event-specs/types.ts` (create) | `EventSpecDocument` (spec §6.1 mirror), resolved input model, `SchemaArtifact`, `Diagnostic`, `EmitOutput`, `ImportedEventSpec` |
| `src/lib/event-specs/json-pointer.ts` (create) | RFC 6901 pointers, local `$ref` building / parsing / resolving |
| `src/lib/event-specs/diagnostics.ts` (create) | `diagnostic()`, `normalizeDiagnostics()`, `hasErrors()`, `compareStrings()` |
| `src/lib/event-specs/schema-format.ts` (create) | §7.2 step 4 `schemaFormat` mapping, profile normalization, format suffixes |
| `src/lib/event-specs/json-schema-downconvert.ts` (create) | Story 16.2 pure core: 2020-12 → draft-07 |
| `src/lib/event-specs/proto-root.ts` (create) | Story 16.3 pure core: root message first + `// @RootNode` |
| `src/lib/event-specs/qualify.ts` (create) | Deterministic name-clash qualification |
| `src/lib/event-specs/message-schemas.ts` (create) | Artifact selection, headers rule, Kafka key placement, `$ref` rebasing |
| `src/lib/event-specs/resolve.ts` (create) | `EventSpecDocument` + catalog → `ResolvedEventSpec` |
| `src/lib/event-specs/assemble.ts` (create) | AsyncAPI 3.0.0 document assembly |
| `src/lib/event-specs/serialize.ts` (create) | YAML + JSON serialization |
| `src/lib/event-specs/validator.ts` (create) | `EventSpecValidator` interface + structural validator |
| `src/lib/event-specs/adapter.ts` (create) | `EventSpecAdapter`, `AsyncApi3Adapter`, `getEventSpecAdapter()` |
| `src/lib/event-specs/index.ts` (create) | Public barrel |
| `tests/unit/lib/event-specs/fixtures/builders.ts` (create) | Test builders + `deepFreeze` |
| `tests/unit/lib/event-specs/fixtures/worked-example.ts` (create) | Spec §6.2 worked example fixtures + the spec YAML verbatim |
| `tests/unit/lib/event-specs/*.test.ts` (create) | One test file per concern (12 files, 88 tests) |
| `tests/unit/lib/event-specs/__golden__/*.asyncapi.{yaml,json}` (create) | Golden outputs for checkout-service@2.0 and fraud-scorer@1.0 |

---

### Task 0: Worktree setup + baseline

**Files:** none (environment only).

- [ ] **Step 1: Create the worktree** from the current branch head

```bash
MAIN=/Users/jsenjaliya/src/my/super-schema
git -C "$MAIN" worktree add /Users/jsenjaliya/src/my/super-schema-events-4a -b feat/events-asyncapi-4a-assembler feat/events-asyncapi
cd /Users/jsenjaliya/src/my/super-schema-events-4a
```

- [ ] **Step 2: Share dependencies and env with the main checkout** (symlinks, never copies)

```bash
ln -s "$MAIN/node_modules" node_modules
ln -s "$MAIN/.env" .env
npm run db:generate   # src/generated/prisma is gitignored; generate it from THIS worktree's schema (offline)
```

If `db:generate` fails offline, fall back to `ln -s "$MAIN/src/generated" src/generated` (note: it then tracks the main checkout's schema, which parallel DB work may change).

- [ ] **Step 3: Record the baseline**

Run: `npx tsc --noEmit` — Expected: no errors.
Run: `npx vitest run` — Expected: 8 failed (db-emitter-parity ×4, e2e-critical-flows bigquery ×1, schemas-tab ×3). Integration tests share the database from `.env`; if parallel DB work has migrated it and extra integration failures appear, confirm they reproduce on the main checkout at the same commit — they are environmental, not caused by this phase (which adds no DB code).

- [ ] **Step 4: Confirm the target directories are new**

Run: `ls src/lib/event-specs tests/unit/lib/event-specs` — Expected: `No such file or directory` for both.

---

### Task 1: Types, JSON pointers and diagnostics (Story 18.4)

**Files:**
- Create: `src/lib/event-specs/types.ts`
- Create: `src/lib/event-specs/json-pointer.ts`
- Create: `src/lib/event-specs/diagnostics.ts`
- Create: `tests/unit/lib/event-specs/fixtures/builders.ts` (test support used from Task 3 on)
- Test: `tests/unit/lib/event-specs/json-pointer.test.ts`

**Interfaces:**
- Produces (types): `JsonPrimitive`, `JsonValue`, `JsonObject`, `PayloadFormat`, `JsonSchemaDialect`, `FormatProfile`, `SchemaArtifact`, `EventSpecInfo`, `EventSpecServer`, `OperationAction`, `EventSpecOperation`, `EventSpecLocalComponents`, `EventSpecDocument`, `ResolvedChannel`, `ResolvedMessage`, `TraitKind`, `ResolvedTrait`, `ResolvedOperation`, `ResolvedEventSpec`, `DiagnosticSeverity`, `Diagnostic`, `EmitOutput`, `ImportedEventSpec`.
- Produces (functions): `escapePointerSegment(s)`, `unescapePointerSegment(s)`, `jsonPointer(...segments): string`, `localRef(...segments): string`, `parseLocalRef(ref): string[] | null`, `resolveLocalRef(root, ref): PointerResolution`; `compareStrings(a, b)`, `diagnostic(severity, code, message, pointer): Diagnostic`, `normalizeDiagnostics(list): Diagnostic[]`, `hasErrors(list): boolean`.
- Produces (test support): `avroRecord`, `jsonObject`, `channel`, `message`, `operation`, `spec`, `deepFreeze`.
- **Draft document → resolved model mapping** (implemented in Task 7):

| `EventSpecDocument` (§6.1) | `ResolvedEventSpec` |
|---|---|
| `info` + resolve option `version` | `info` (`version` = `MAJOR.MINOR`, → AsyncAPI `info.version`) |
| `defaultContentType`, `servers`, `components` | copied |
| `operations[].channelId` | `operations[].channelRef` (+ the Channel in `channels[]`) |
| `operations[].messageVersionIds` | `operations[].messageRefs` (+ the MessageVersions in `messages[]`) |
| `operations[].traitIds` | `operations[].traitRefs` (+ OPERATION traits in `traits[]`) |
| `operations[].reply.{channelId, messageVersionIds}` | `operations[].reply.{channelRef, messageRefs}` |
| catalog `message.traitRefs` | MESSAGE traits in `traits[]` |
| `servers[].externalRef` | emitted as AsyncAPI `servers.<key>.externalDocs.url` (Task 8) |

- [ ] **Step 1: Write the failing test** (`tests/unit/lib/event-specs/json-pointer.test.ts`)

```ts
import { describe, it, expect } from "vitest";
import { jsonPointer, localRef, parseLocalRef, resolveLocalRef } from "@/lib/event-specs/json-pointer";
import { hasErrors, normalizeDiagnostics } from "@/lib/event-specs/diagnostics";
import type { Diagnostic } from "@/lib/event-specs/types";

describe("json pointers", () => {
  it("escapes ~ and / per RFC 6901", () => {
    expect(jsonPointer("channels", "a/b", "c~d")).toBe("/channels/a~1b/c~0d");
    expect(jsonPointer()).toBe("");
    expect(localRef("components", "messages", "OrderCreated")).toBe("#/components/messages/OrderCreated");
  });

  it("parses local refs and rejects remote ones", () => {
    expect(parseLocalRef("#/channels/a~1b/messages/X")).toEqual(["channels", "a/b", "messages", "X"]);
    expect(parseLocalRef("#")).toEqual([]);
    expect(parseLocalRef("https://example.com/schema.json#/x")).toBeNull();
  });

  it("resolves refs through objects and arrays", () => {
    const doc = { channels: { "checkout.orders": { messages: { M: { payload: 1 } } } }, list: [{ a: true }] };
    expect(resolveLocalRef(doc, "#/channels/checkout.orders/messages/M")).toEqual({
      found: true,
      value: { payload: 1 },
    });
    expect(resolveLocalRef(doc, "#/list/0/a")).toEqual({ found: true, value: true });
    expect(resolveLocalRef(doc, "#/list/1")).toEqual({ found: false });
    expect(resolveLocalRef(doc, "#/channels/missing")).toEqual({ found: false });
  });
});

describe("diagnostics", () => {
  const d = (severity: Diagnostic["severity"], code: string, pointer: string): Diagnostic => ({
    severity,
    code,
    message: code,
    pointer,
  });

  it("orders by severity, pointer, code and removes duplicates", () => {
    const sorted = normalizeDiagnostics([
      d("info", "C", "/a"),
      d("warning", "B", "/b"),
      d("error", "A", "/z"),
      d("error", "A", "/b"),
      d("error", "A", "/b"),
    ]);
    expect(sorted.map((x) => `${x.severity}:${x.pointer}`)).toEqual(["error:/b", "error:/z", "warning:/b", "info:/a"]);
  });

  it("hasErrors is true only when an error is present", () => {
    expect(hasErrors([d("warning", "W", "")])).toBe(false);
    expect(hasErrors([d("warning", "W", ""), d("error", "E", "")])).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/unit/lib/event-specs/json-pointer.test.ts`
Expected: FAIL — `Cannot find package '@/lib/event-specs/json-pointer'` (module not created yet).

- [ ] **Step 3: Create the types** (`src/lib/event-specs/types.ts`)

```ts
/**
 * Events core — Phase 4a (pure layer). In-memory input/output shapes for the
 * AsyncAPI 3 document assembler (spec §6.1, §7). No Prisma, no IO: the DB-backed
 * resolver (Story 18.4) builds these from Channel / Message / Trait rows later.
 */

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;
export type JsonObject = { [key: string]: JsonValue };

export type PayloadFormat = "avro" | "json-schema" | "protobuf";
export type JsonSchemaDialect = "draft-07" | "2020-12";

/** Spec §1 "Format profile": implementation format + dialect (JSON Schema only). */
export type FormatProfile = { format: PayloadFormat; dialect?: JsonSchemaDialect };

/**
 * One pre-rendered schema in one format profile. Later produced from an
 * `EntityVersionArtifact` (Story 14.5); supplied in memory today.
 * Avro and JSON Schema → object; Protobuf → `.proto` source text.
 */
export type SchemaArtifact = {
  format: PayloadFormat;
  dialect?: JsonSchemaDialect;
  schema: JsonObject | string;
};

// ── Spec §6.1 `EventSpecDocument` — the stored draft shape (IDs, not objects) ──

export type EventSpecInfo = {
  title: string;
  description?: string;
  contact?: JsonObject;
  license?: JsonObject;
  tags?: JsonObject[];
  externalDocs?: JsonObject;
};

export type EventSpecServer = {
  key: string;
  protocol: string;
  host: string;
  pathname?: string;
  protocolVersion?: string;
  description?: string;
  externalRef?: string;
};

export type OperationAction = "send" | "receive";

export type EventSpecOperation = {
  key: string;
  action: OperationAction;
  channelId: string;
  messageVersionIds: string[];
  traitIds: string[];
  summary?: string;
  description?: string;
  bindings?: JsonObject;
  reply?: { channelId?: string; messageVersionIds?: string[] };
};

export type EventSpecLocalComponents = {
  correlationIds?: Record<string, JsonObject>;
  parameters?: Record<string, JsonObject>;
  securitySchemes?: Record<string, JsonObject>;
  operationBindings?: Record<string, JsonObject>;
};

export type EventSpecDocument = {
  info: EventSpecInfo;
  defaultContentType?: string;
  servers: EventSpecServer[];
  operations: EventSpecOperation[];
  components?: EventSpecLocalComponents;
};

// ── Resolved input model consumed by the assembler ──────────────────────────

export type ResolvedChannel = {
  /** Catalog Channel id. */
  id: string;
  name: string;
  /** Owning product slug — qualifies name clashes (`checkout.orders`). */
  productSlug: string;
  /** AsyncAPI allows `null` (address unknown / dynamic). May contain `{param}`. */
  address: string | null;
  protocol: string;
  profile: FormatProfile;
  title?: string;
  summary?: string;
  description?: string;
  parameters?: Record<string, JsonObject>;
  bindings?: JsonObject;
  tags?: JsonObject[];
  externalDocs?: JsonObject;
};

export type ResolvedMessage = {
  /** MessageVersion id (or the Message id for an unpublished draft preview). */
  id: string;
  name: string;
  productSlug: string;
  title?: string;
  summary?: string;
  description?: string;
  contentType?: string;
  correlationId?: JsonObject;
  tags?: JsonObject[];
  externalDocs?: JsonObject;
  bindings?: JsonObject;
  examples?: JsonObject[];
  /** ResolvedTrait ids (kind MESSAGE), authored order. */
  traitRefs: string[];
  /** Payload rendered in every format profile the message may be emitted in. */
  payloads: SchemaArtifact[];
  /** Headers — must be a JSON Schema object schema (spec §7.2 step 3). */
  headers?: SchemaArtifact;
  /** Kafka key renderings (Avro and/or JSON Schema). */
  keys?: SchemaArtifact[];
  /** Draft preview of an unpublished Message (spec §7.2 step 2). */
  unpublished?: boolean;
};

export type TraitKind = "MESSAGE" | "OPERATION";

export type ResolvedTrait = {
  id: string;
  name: string;
  kind: TraitKind;
  /** Slug of the owning level (tenant, domain or product). */
  ownerSlug: string;
  /** AsyncAPI Message Trait / Operation Trait object. */
  spec: JsonObject;
  /** Message-trait headers artifact (e.g. `CloudEventsHeaders@1.0`); wins over `spec.headers`. */
  headers?: SchemaArtifact;
};

export type ResolvedOperation = {
  key: string;
  action: OperationAction;
  /** ResolvedChannel id. */
  channelRef: string;
  /** ResolvedMessage ids, authored order. */
  messageRefs: string[];
  /** ResolvedTrait ids (kind OPERATION), authored order. */
  traitRefs: string[];
  summary?: string;
  description?: string;
  bindings?: JsonObject;
  reply?: { channelRef?: string; messageRefs?: string[] };
};

export type ResolvedEventSpec = {
  /** Slug of the product that owns the Event Spec; its items keep unqualified names. */
  productSlug: string;
  /** `version` is `MAJOR.MINOR` for a published version (spec §6.1). */
  info: EventSpecInfo & { version: string };
  defaultContentType?: string;
  servers: EventSpecServer[];
  operations: ResolvedOperation[];
  channels: ResolvedChannel[];
  messages: ResolvedMessage[];
  traits: ResolvedTrait[];
  components: EventSpecLocalComponents;
};

// ── Diagnostics and adapter results ─────────────────────────────────────────

export type DiagnosticSeverity = "error" | "warning" | "info";

export type Diagnostic = {
  severity: DiagnosticSeverity;
  code: string;
  message: string;
  /** RFC 6901 JSON pointer into the emitted document ("" = document root). */
  pointer: string;
};

/** Spec §7.1 emit result, plus the diagnostics gathered while assembling + validating. */
export type EmitOutput = {
  document: JsonObject;
  json: string;
  yaml: string;
  diagnostics: Diagnostic[];
};

/** Placeholder result of `EventSpecAdapter.import()`; Epic 19 (splitter) extends it. */
export type ImportedEventSpec = {
  document: EventSpecDocument;
  sourceVersion?: string;
  diagnostics: Diagnostic[];
};
```

- [ ] **Step 4: Create the pointer helpers** (`src/lib/event-specs/json-pointer.ts`)

```ts
/**
 * RFC 6901 JSON pointer helpers shared by the assembler (building `$ref`s and
 * diagnostic pointers) and the structural validator (resolving `$ref`s).
 */

export function escapePointerSegment(segment: string): string {
  return segment.replace(/~/g, "~0").replace(/\//g, "~1");
}

export function unescapePointerSegment(segment: string): string {
  return segment.replace(/~1/g, "/").replace(/~0/g, "~");
}

/** `jsonPointer("channels", "a/b")` → `/channels/a~1b`; no segments → `""` (root). */
export function jsonPointer(...segments: Array<string | number>): string {
  return segments.map((s) => "/" + escapePointerSegment(String(s))).join("");
}

/** Local reference string: `localRef("channels", "orders")` → `#/channels/orders`. */
export function localRef(...segments: Array<string | number>): string {
  return "#" + jsonPointer(...segments);
}

/** Split a local ref (`#/a/b`) into unescaped segments; `null` when not local. */
export function parseLocalRef(ref: string): string[] | null {
  if (ref === "#") return [];
  if (!ref.startsWith("#/")) return null;
  return ref
    .slice(2)
    .split("/")
    .map((raw) => {
      let decoded = raw;
      try {
        decoded = decodeURIComponent(raw);
      } catch {
        // keep the raw segment when it is not valid percent-encoding
      }
      return unescapePointerSegment(decoded);
    });
}

export type PointerResolution = { found: true; value: unknown } | { found: false };

/** Resolve a local `#/...` ref against `root`. */
export function resolveLocalRef(root: unknown, ref: string): PointerResolution {
  const segments = parseLocalRef(ref);
  if (segments === null) return { found: false };
  let current: unknown = root;
  for (const segment of segments) {
    if (Array.isArray(current)) {
      if (!/^(0|[1-9][0-9]*)$/.test(segment)) return { found: false };
      const index = Number(segment);
      if (index >= current.length) return { found: false };
      current = current[index];
    } else if (
      typeof current === "object" &&
      current !== null &&
      Object.prototype.hasOwnProperty.call(current, segment)
    ) {
      current = (current as Record<string, unknown>)[segment];
    } else {
      return { found: false };
    }
  }
  return { found: true, value: current };
}
```

- [ ] **Step 5: Create the diagnostics helpers** (`src/lib/event-specs/diagnostics.ts`)

```ts
import type { Diagnostic, DiagnosticSeverity } from "./types";

/** Locale-independent string order (UTF-16 code units) — keeps output stable across machines. */
export function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function diagnostic(severity: DiagnosticSeverity, code: string, message: string, pointer: string): Diagnostic {
  return { severity, code, message, pointer };
}

const SEVERITY_RANK: Record<DiagnosticSeverity, number> = { error: 0, warning: 1, info: 2 };

/** De-duplicate and order diagnostics: severity, then pointer, then code, then message. */
export function normalizeDiagnostics(list: Diagnostic[]): Diagnostic[] {
  const seen = new Set<string>();
  const unique: Diagnostic[] = [];
  for (const d of list) {
    const id = `${d.severity}\u0000${d.code}\u0000${d.pointer}\u0000${d.message}`;
    if (seen.has(id)) continue;
    seen.add(id);
    unique.push(d);
  }
  return unique.sort(
    (a, b) =>
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      compareStrings(a.pointer, b.pointer) ||
      compareStrings(a.code, b.code) ||
      compareStrings(a.message, b.message),
  );
}

export function hasErrors(list: Diagnostic[]): boolean {
  return list.some((d) => d.severity === "error");
}
```

- [ ] **Step 6: Create the test builders** (`tests/unit/lib/event-specs/fixtures/builders.ts`)

```ts
/** Small builders for per-concern assembler tests. */
import type {
  ResolvedChannel,
  ResolvedEventSpec,
  ResolvedMessage,
  ResolvedOperation,
  SchemaArtifact,
} from "@/lib/event-specs/types";

export function avroRecord(name: string): SchemaArtifact {
  return { format: "avro", schema: { type: "record", name, namespace: "acme.test", fields: [] } };
}

export function jsonObject(title: string, dialect: "draft-07" | "2020-12" = "draft-07"): SchemaArtifact {
  return { format: "json-schema", dialect, schema: { title, type: "object", properties: {} } };
}

export function channel(overrides: Partial<ResolvedChannel> & Pick<ResolvedChannel, "id" | "name">): ResolvedChannel {
  return {
    productSlug: "checkout",
    address: `${overrides.name}.v1`,
    protocol: "kafka",
    profile: { format: "avro" },
    ...overrides,
  };
}

export function message(overrides: Partial<ResolvedMessage> & Pick<ResolvedMessage, "id" | "name">): ResolvedMessage {
  return {
    productSlug: "checkout",
    traitRefs: [],
    payloads: [avroRecord(overrides.name), jsonObject(overrides.name)],
    ...overrides,
  };
}

export function operation(
  overrides: Partial<ResolvedOperation> & Pick<ResolvedOperation, "key" | "channelRef" | "messageRefs">,
): ResolvedOperation {
  return { action: "send", traitRefs: [], ...overrides };
}

export function spec(overrides: Partial<ResolvedEventSpec>): ResolvedEventSpec {
  return {
    productSlug: "checkout",
    info: { title: "test-spec", version: "1.0" },
    servers: [],
    operations: [],
    channels: [],
    messages: [],
    traits: [],
    components: {},
    ...overrides,
  };
}

/** Recursively freeze so any mutation of assembler input throws (ES modules are strict). */
export function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}
```

- [ ] **Step 7: Run tests — expect PASS**

Run: `npx vitest run tests/unit/lib/event-specs/json-pointer.test.ts`
Expected: PASS — 1 file, 5 tests.
Run: `npx tsc --noEmit` — Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add src/lib/event-specs/types.ts src/lib/event-specs/json-pointer.ts src/lib/event-specs/diagnostics.ts tests/unit/lib/event-specs/fixtures/builders.ts tests/unit/lib/event-specs/json-pointer.test.ts
git commit -m "feat(18.4): event-spec types, JSON pointer and diagnostics helpers"
```

---

### Task 2: `schemaFormat` mapping and format profiles (Story 18.4, spec §7.2 step 4)

**Files:**
- Create: `src/lib/event-specs/schema-format.ts`
- Test: `tests/unit/lib/event-specs/schema-format.test.ts`

**Interfaces:**
- Consumes: `FormatProfile`, `JsonSchemaDialect` (Task 1).
- Produces: `DEFAULT_JSON_SCHEMA_DIALECT = "draft-07"`; `SCHEMA_FORMATS` (`avro`, `protobuf`, `jsonSchemaDraft07`, `jsonSchema202012`); `normalizeProfile(profile): FormatProfile`; `sameProfile(a, b): boolean`; `schemaFormatFor(profile): string`; `formatSuffix(profile): string` (`avro` | `proto` | `json` | `json2020`).

- [ ] **Step 1: Write the failing test** (`tests/unit/lib/event-specs/schema-format.test.ts`)

```ts
import { describe, it, expect } from "vitest";
import { formatSuffix, normalizeProfile, sameProfile, schemaFormatFor } from "@/lib/event-specs/schema-format";

describe("schemaFormatFor (spec §7.2 step 4)", () => {
  it.each([
    [{ format: "avro" as const }, "application/vnd.apache.avro+json;version=1.9.0"],
    [{ format: "protobuf" as const }, "application/vnd.google.protobuf;version=3"],
    [{ format: "json-schema" as const, dialect: "draft-07" as const }, "application/schema+json;version=draft-07"],
    [{ format: "json-schema" as const, dialect: "2020-12" as const }, "application/schema+json;version=2020-12"],
  ])("%o → %s", (profile, expected) => {
    expect(schemaFormatFor(profile)).toBe(expected);
  });

  it("defaults JSON Schema to draft-07", () => {
    expect(schemaFormatFor({ format: "json-schema" })).toBe("application/schema+json;version=draft-07");
    expect(normalizeProfile({ format: "json-schema" })).toEqual({ format: "json-schema", dialect: "draft-07" });
  });

  it("ignores a dialect on non-JSON formats", () => {
    expect(normalizeProfile({ format: "avro", dialect: "2020-12" })).toEqual({ format: "avro" });
    expect(sameProfile({ format: "avro", dialect: "2020-12" }, { format: "avro" })).toBe(true);
    expect(sameProfile({ format: "json-schema" }, { format: "json-schema", dialect: "2020-12" })).toBe(false);
  });

  it("format suffixes qualify multi-format messages", () => {
    expect(formatSuffix({ format: "avro" })).toBe("avro");
    expect(formatSuffix({ format: "json-schema" })).toBe("json");
    expect(formatSuffix({ format: "json-schema", dialect: "2020-12" })).toBe("json2020");
    expect(formatSuffix({ format: "protobuf" })).toBe("proto");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/unit/lib/event-specs/schema-format.test.ts`
Expected: FAIL — `Cannot find package '@/lib/event-specs/schema-format'`.

- [ ] **Step 3: Implement** (`src/lib/event-specs/schema-format.ts`)

```ts
import type { FormatProfile, JsonSchemaDialect } from "./types";

/** Spec §2: draft-07 is the default JSON Schema dialect (AsyncAPI compatibility). */
export const DEFAULT_JSON_SCHEMA_DIALECT: JsonSchemaDialect = "draft-07";

/** Spec §7.2 step 4 — the exact `schemaFormat` strings. */
export const SCHEMA_FORMATS = {
  avro: "application/vnd.apache.avro+json;version=1.9.0",
  protobuf: "application/vnd.google.protobuf;version=3",
  jsonSchemaDraft07: "application/schema+json;version=draft-07",
  jsonSchema202012: "application/schema+json;version=2020-12",
} as const;

/** Fill the JSON Schema dialect default; drop a dialect on non-JSON formats. */
export function normalizeProfile(profile: FormatProfile): FormatProfile {
  return profile.format === "json-schema"
    ? { format: "json-schema", dialect: profile.dialect ?? DEFAULT_JSON_SCHEMA_DIALECT }
    : { format: profile.format };
}

export function sameProfile(a: FormatProfile, b: FormatProfile): boolean {
  const x = normalizeProfile(a);
  const y = normalizeProfile(b);
  return x.format === y.format && x.dialect === y.dialect;
}

export function schemaFormatFor(profile: FormatProfile): string {
  const p = normalizeProfile(profile);
  switch (p.format) {
    case "avro":
      return SCHEMA_FORMATS.avro;
    case "protobuf":
      return SCHEMA_FORMATS.protobuf;
    case "json-schema":
      return p.dialect === "2020-12" ? SCHEMA_FORMATS.jsonSchema202012 : SCHEMA_FORMATS.jsonSchemaDraft07;
  }
}

/** Suffix that qualifies one Message emitted in several formats (`OrderCreated_avro` / `OrderCreated_json`). */
export function formatSuffix(profile: FormatProfile): string {
  const p = normalizeProfile(profile);
  if (p.format === "avro") return "avro";
  if (p.format === "protobuf") return "proto";
  return p.dialect === "2020-12" ? "json2020" : "json";
}
```

- [ ] **Step 4: Run tests — expect PASS**

Run: `npx vitest run tests/unit/lib/event-specs/schema-format.test.ts`
Expected: PASS — 1 file, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/event-specs/schema-format.ts tests/unit/lib/event-specs/schema-format.test.ts
git commit -m "feat(18.4): AsyncAPI schemaFormat mapping per format profile"
```

---

### Task 3: JSON Schema 2020-12 → draft-07 down-converter (Story 16.2 pure core, spec §7.3)

**Files:**
- Create: `src/lib/event-specs/json-schema-downconvert.ts`
- Test: `tests/unit/lib/event-specs/json-schema-downconvert.test.ts`

**Interfaces:**
- Consumes: `JsonObject`, `JsonValue` (Task 1); `escapePointerSegment` (Task 1); `deepFreeze` (Task 1 fixtures).
- Produces: `DRAFT_07_META_SCHEMA`; `UNSUPPORTED_IN_DRAFT_07: readonly string[]`; `type DownConvertWarning = { pointer; keyword; message }`; `type DownConvertResult = { schema: JsonObject; warnings: DownConvertWarning[] }`; `downConvertToDraft07(schema: JsonObject): DownConvertResult`; `rewriteDefsRef(ref: string): string`.

Rules: `$defs` → `definitions` (merged with an existing `definitions`; clashes keep the first entry and warn); every `$ref` fragment segment `$defs` → `definitions`; `prefixItems` → `items` (array) and a sibling 2020-12 `items` → `additionalItems`; `dependentRequired` / `dependentSchemas` (and an existing draft-07 `dependencies`) → `dependencies` (array + schema for one property → `{ allOf: [{ required }, schema] }`); `$schema` → draft-07 URI when present; keywords in `UNSUPPORTED_IN_DRAFT_07` dropped with a warning carrying a JSON pointer. Only schema positions are walked.

- [ ] **Step 1: Write the failing test** (`tests/unit/lib/event-specs/json-schema-downconvert.test.ts`)

```ts
import { describe, it, expect } from "vitest";
import { DRAFT_07_META_SCHEMA, downConvertToDraft07, rewriteDefsRef } from "@/lib/event-specs/json-schema-downconvert";
import type { JsonObject } from "@/lib/event-specs/types";
import { deepFreeze } from "./fixtures/builders";

describe("downConvertToDraft07 (spec §7.3, Story 16.2)", () => {
  it("renames $defs to definitions and rewrites $ref fragments", () => {
    const { schema, warnings } = downConvertToDraft07({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: { shipTo: { $ref: "#/$defs/Address" }, billTo: { $ref: "common.json#/$defs/Address" } },
      $defs: { Address: { type: "object", properties: { zip: { $ref: "#/$defs/Zip" } } }, Zip: { type: "string" } },
    });
    expect(schema).toEqual({
      $schema: DRAFT_07_META_SCHEMA,
      type: "object",
      properties: { shipTo: { $ref: "#/definitions/Address" }, billTo: { $ref: "common.json#/definitions/Address" } },
      definitions: {
        Address: { type: "object", properties: { zip: { $ref: "#/definitions/Zip" } } },
        Zip: { type: "string" },
      },
    });
    expect(warnings).toEqual([]);
  });

  it("converts prefixItems to the items array and a sibling items to additionalItems", () => {
    const { schema } = downConvertToDraft07({
      type: "array",
      prefixItems: [{ type: "string" }, { type: "number" }],
      items: false,
    });
    expect(schema).toEqual({ type: "array", items: [{ type: "string" }, { type: "number" }], additionalItems: false });
    expect(downConvertToDraft07({ type: "array", items: { type: "string" } }).schema).toEqual({
      type: "array",
      items: { type: "string" },
    });
  });

  it("folds dependentRequired and dependentSchemas into dependencies", () => {
    const { schema } = downConvertToDraft07({
      type: "object",
      dependentRequired: { card: ["billingAddress"], vat: ["country"] },
      dependentSchemas: { vat: { properties: { country: { $ref: "#/$defs/Country" } } } },
    });
    expect(schema).toEqual({
      type: "object",
      dependencies: {
        card: ["billingAddress"],
        vat: { allOf: [{ required: ["country"] }, { properties: { country: { $ref: "#/definitions/Country" } } }] },
      },
    });
  });

  it("drops keywords draft-07 cannot express, with a pointer per warning", () => {
    const { schema, warnings } = downConvertToDraft07({
      type: "object",
      unevaluatedProperties: false,
      properties: { tags: { type: "array", contains: { type: "string" }, minContains: 1 } },
      $defs: { Node: { $anchor: "node", type: "object" } },
    });
    expect(schema).toEqual({
      type: "object",
      properties: { tags: { type: "array", contains: { type: "string" } } },
      definitions: { Node: { type: "object" } },
    });
    expect(warnings.map((w) => [w.pointer, w.keyword])).toEqual([
      ["/unevaluatedProperties", "unevaluatedProperties"],
      ["/properties/tags/minContains", "minContains"],
      ["/$defs/Node/$anchor", "$anchor"],
    ]);
  });

  it("leaves data keywords and property names alone", () => {
    const input: JsonObject = {
      type: "object",
      properties: { $defs: { type: "string", const: "#/$defs/X" } },
      default: { $ref: "#/$defs/X" },
      examples: [{ unevaluatedProperties: 1 }],
    };
    const { schema, warnings } = downConvertToDraft07(input);
    expect(schema).toEqual(input);
    expect(warnings).toEqual([]);
  });

  it("does not mutate its input", () => {
    const input = deepFreeze<JsonObject>({ $defs: { A: { type: "string" } }, prefixItems: [{ $ref: "#/$defs/A" }] });
    expect(() => downConvertToDraft07(input)).not.toThrow();
    expect(input).toEqual({ $defs: { A: { type: "string" } }, prefixItems: [{ $ref: "#/$defs/A" }] });
  });

  it("rewriteDefsRef only touches the fragment", () => {
    expect(rewriteDefsRef("#/$defs/A/$defs/B")).toBe("#/definitions/A/definitions/B");
    expect(rewriteDefsRef("schemas/$defs.json")).toBe("schemas/$defs.json");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/unit/lib/event-specs/json-schema-downconvert.test.ts`
Expected: FAIL — `Cannot find package '@/lib/event-specs/json-schema-downconvert'`.

- [ ] **Step 3: Implement** (`src/lib/event-specs/json-schema-downconvert.ts`)

```ts
import type { JsonObject, JsonValue } from "./types";
import { escapePointerSegment } from "./json-pointer";

/**
 * Spec §7.3 / Story 16.2 pure core: down-convert a JSON Schema 2020-12 document
 * to draft-07 for channels whose format profile asks for it.
 *
 * - `$defs` → `definitions`, and every `$ref` fragment segment `$defs` → `definitions`
 * - `prefixItems` → `items` (array form); a sibling 2020-12 `items` → `additionalItems`
 * - `dependentRequired` / `dependentSchemas` → `dependencies`
 * - keywords with no draft-07 equivalent are dropped, each with a warning
 *
 * Only schema positions are walked; data keywords (`const`, `enum`, `default`,
 * `examples`) and unknown keywords are copied verbatim. The input is never mutated.
 */

export const DRAFT_07_META_SCHEMA = "http://json-schema.org/draft-07/schema#";

export const UNSUPPORTED_IN_DRAFT_07: readonly string[] = [
  "$anchor",
  "$dynamicAnchor",
  "$dynamicRef",
  "$recursiveAnchor",
  "$recursiveRef",
  "$vocabulary",
  "unevaluatedProperties",
  "unevaluatedItems",
  "minContains",
  "maxContains",
  "contentSchema",
];

export type DownConvertWarning = { pointer: string; keyword: string; message: string };
export type DownConvertResult = { schema: JsonObject; warnings: DownConvertWarning[] };

const DROPPED = new Set(UNSUPPORTED_IN_DRAFT_07);
const SCHEMA_MAP_KEYWORDS = new Set(["properties", "patternProperties"]);
const SCHEMA_ARRAY_KEYWORDS = new Set(["allOf", "anyOf", "oneOf"]);
const SINGLE_SCHEMA_KEYWORDS = new Set([
  "additionalProperties",
  "additionalItems",
  "contains",
  "propertyNames",
  "if",
  "then",
  "else",
  "not",
]);

const isObject = (v: JsonValue | undefined): v is JsonObject =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export function downConvertToDraft07(schema: JsonObject): DownConvertResult {
  const warnings: DownConvertWarning[] = [];
  return { schema: convertSchema(schema, "", warnings), warnings };
}

/** Rewrite `$defs` segments in the fragment of a `$ref` (`a.json#/$defs/X` → `a.json#/definitions/X`). */
export function rewriteDefsRef(ref: string): string {
  const hash = ref.indexOf("#");
  if (hash < 0) return ref;
  const fragment = ref
    .slice(hash + 1)
    .split("/")
    .map((s) => (s === "$defs" ? "definitions" : s))
    .join("/");
  return `${ref.slice(0, hash)}#${fragment}`;
}

function at(pointer: string, key: string): string {
  return `${pointer}/${escapePointerSegment(key)}`;
}

/** Booleans are valid schemas (`true` / `false`); anything else non-object is copied. */
function convertSubschema(value: JsonValue, pointer: string, warnings: DownConvertWarning[]): JsonValue {
  return isObject(value) ? convertSchema(value, pointer, warnings) : structuredClone(value);
}

function convertSchemaArray(value: JsonValue, pointer: string, warnings: DownConvertWarning[]): JsonValue {
  return Array.isArray(value)
    ? value.map((v, i) => convertSubschema(v, `${pointer}/${i}`, warnings))
    : structuredClone(value);
}

function convertSchemaMap(value: JsonValue, pointer: string, warnings: DownConvertWarning[]): JsonValue {
  if (!isObject(value)) return structuredClone(value);
  const out: JsonObject = {};
  for (const [k, v] of Object.entries(value)) out[k] = convertSubschema(v, at(pointer, k), warnings);
  return out;
}

function mergeDefinitions(out: JsonObject, incoming: JsonValue, pointer: string, warnings: DownConvertWarning[]): void {
  if (!isObject(incoming)) return;
  const target: JsonObject = isObject(out.definitions) ? out.definitions : {};
  for (const [name, schema] of Object.entries(incoming)) {
    if (Object.prototype.hasOwnProperty.call(target, name)) {
      warnings.push({
        pointer: at(pointer, name),
        keyword: "definitions",
        message: `definition "${name}" exists in both $defs and definitions; the first one was kept`,
      });
      continue;
    }
    target[name] = schema;
  }
  out.definitions = target;
}

function combineDependency(existing: JsonValue, incoming: JsonValue): JsonValue {
  if (Array.isArray(existing) && Array.isArray(incoming)) {
    return [...existing, ...incoming.filter((x) => !existing.includes(x))];
  }
  const asSchema = (v: JsonValue): JsonValue => (Array.isArray(v) ? { required: v } : v);
  return { allOf: [asSchema(existing), asSchema(incoming)] };
}

function mergeDependencies(out: JsonObject, incoming: JsonValue): void {
  if (!isObject(incoming)) return;
  const target: JsonObject = isObject(out.dependencies) ? out.dependencies : {};
  for (const [prop, value] of Object.entries(incoming)) {
    target[prop] = Object.prototype.hasOwnProperty.call(target, prop) ? combineDependency(target[prop], value) : value;
  }
  out.dependencies = target;
}

function convertSchema(node: JsonObject, pointer: string, warnings: DownConvertWarning[]): JsonObject {
  const out: JsonObject = {};
  const hasPrefixItems = Array.isArray(node.prefixItems);

  for (const [key, value] of Object.entries(node)) {
    const here = at(pointer, key);

    if (DROPPED.has(key)) {
      warnings.push({ pointer: here, keyword: key, message: `"${key}" has no draft-07 equivalent and was dropped` });
      continue;
    }

    switch (key) {
      case "$schema":
        out.$schema = DRAFT_07_META_SCHEMA;
        break;
      case "$ref":
        out.$ref = typeof value === "string" ? rewriteDefsRef(value) : structuredClone(value);
        break;
      case "$defs":
      case "definitions":
        mergeDefinitions(out, convertSchemaMap(value, here, warnings), here, warnings);
        break;
      case "prefixItems":
        out.items = convertSchemaArray(value, here, warnings);
        break;
      case "items":
        if (hasPrefixItems) out.additionalItems = convertSubschema(value, here, warnings);
        else
          out.items = Array.isArray(value)
            ? convertSchemaArray(value, here, warnings)
            : convertSubschema(value, here, warnings);
        break;
      case "dependentRequired":
        mergeDependencies(out, structuredClone(value));
        break;
      case "dependentSchemas":
        mergeDependencies(out, convertSchemaMap(value, here, warnings));
        break;
      case "dependencies":
        mergeDependencies(
          out,
          isObject(value)
            ? Object.fromEntries(
                Object.entries(value).map(([k, v]) => [
                  k,
                  Array.isArray(v) ? structuredClone(v) : convertSubschema(v, at(here, k), warnings),
                ]),
              )
            : value,
        );
        break;
      default:
        if (SCHEMA_MAP_KEYWORDS.has(key)) out[key] = convertSchemaMap(value, here, warnings);
        else if (SCHEMA_ARRAY_KEYWORDS.has(key)) out[key] = convertSchemaArray(value, here, warnings);
        else if (SINGLE_SCHEMA_KEYWORDS.has(key)) out[key] = convertSubschema(value, here, warnings);
        else out[key] = structuredClone(value);
    }
  }
  return out;
}
```

- [ ] **Step 4: Run tests — expect PASS**

Run: `npx vitest run tests/unit/lib/event-specs/json-schema-downconvert.test.ts`
Expected: PASS — 1 file, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/event-specs/json-schema-downconvert.ts tests/unit/lib/event-specs/json-schema-downconvert.test.ts
git commit -m "feat(16.2): pure JSON Schema 2020-12 to draft-07 down-converter"
```

---

### Task 4: Protobuf root-first + `// @RootNode` post-processor (Story 16.3 pure core, spec §7.3)

**Files:**
- Create: `src/lib/event-specs/proto-root.ts`
- Test: `tests/unit/lib/event-specs/proto-root.test.ts`

**Interfaces:**
- Consumes: `ok`, `err`, `Result` from `@/types/result`.
- Produces: `ROOT_NODE_ANNOTATION = "// @RootNode"`; `placeRootMessageFirst(proto: string, rootMessage: string): Result<string>` — errors `PROTO_PARSE_ERROR` (unbalanced braces / quotes / comments) and `ROOT_MESSAGE_NOT_FOUND` (no top-level `message <rootMessage>`).

Behavior: a small scanner splits the file into top-level chunks (statements ending in `;`, definitions `message` / `enum` / `service` / `extend` ending at the matching `}`), skipping strings and comments while counting braces. Everything before the first definition is kept verbatim; the root definition (with its leading comments) moves first and gets `// @RootNode` directly above the `message` line; `@RootNode` lines are stripped from every other definition; definitions are re-joined with one blank line. Running it twice is a no-op.

- [ ] **Step 1: Write the failing test** (`tests/unit/lib/event-specs/proto-root.test.ts`)

```ts
import { describe, it, expect } from "vitest";
import { placeRootMessageFirst } from "@/lib/event-specs/proto-root";

const ORDER_PROTO = `syntax = "proto3";

package acme.payments.checkout;

import "google/protobuf/timestamp.proto";

// A line item.
message LineItem {
  string sku = 1;
  int32 quantity = 2;
}

// The order placed at checkout.
message Order {
  string id = 1;
  repeated LineItem items = 2;
  google.protobuf.Timestamp created_at = 3;
}
`;

const ORDER_PROTO_ROOT_FIRST = `syntax = "proto3";

package acme.payments.checkout;

import "google/protobuf/timestamp.proto";

// The order placed at checkout.
// @RootNode
message Order {
  string id = 1;
  repeated LineItem items = 2;
  google.protobuf.Timestamp created_at = 3;
}

// A line item.
message LineItem {
  string sku = 1;
  int32 quantity = 2;
}
`;

function run(proto: string, root: string): string {
  const res = placeRootMessageFirst(proto, root);
  if (!res.success) throw new Error(res.error.message);
  return res.data;
}

describe("placeRootMessageFirst (spec §7.3, Story 16.3)", () => {
  it("moves the root message first and annotates it with // @RootNode", () => {
    expect(run(ORDER_PROTO, "Order")).toBe(ORDER_PROTO_ROOT_FIRST);
  });

  it("is idempotent", () => {
    expect(run(ORDER_PROTO_ROOT_FIRST, "Order")).toBe(ORDER_PROTO_ROOT_FIRST);
  });

  it("annotates a root that is already first", () => {
    const src = `syntax = "proto3";\n\nmessage Order {\n  string id = 1;\n}\n`;
    expect(run(src, "Order")).toBe(`syntax = "proto3";\n\n// @RootNode\nmessage Order {\n  string id = 1;\n}\n`);
  });

  it("moves @RootNode off a stale root", () => {
    const src = `syntax = "proto3";\n\n// @RootNode\nmessage Old {\n  string a = 1;\n}\n\nmessage Order {\n  Old old = 1;\n}\n`;
    expect(run(src, "Order")).toBe(
      `syntax = "proto3";\n\n// @RootNode\nmessage Order {\n  Old old = 1;\n}\n\nmessage Old {\n  string a = 1;\n}\n`,
    );
  });

  it("ignores braces inside strings and comments, and nested messages with the root's name", () => {
    const src = [
      'syntax = "proto3";',
      "",
      "message Outer {",
      '  string note = 1 [json_name = "n{"]; // a } brace',
      "  /* { block } */",
      "  message Order { string id = 1; }",
      "  Order order = 2;",
      "}",
      "",
      "message Order {",
      "  string id = 1;",
      "}",
      "",
    ].join("\n");
    const out = run(src, "Order");
    expect(out.indexOf("// @RootNode\nmessage Order {")).toBeGreaterThan(0);
    expect(out.indexOf("message Order {\n  string id = 1;\n}")).toBeLessThan(out.indexOf("message Outer {"));
    expect(out).toContain(
      '  string note = 1 [json_name = "n{"]; // a } brace\n  /* { block } */\n  message Order { string id = 1; }',
    );
  });

  it("returns ROOT_MESSAGE_NOT_FOUND when the root is not a top-level message", () => {
    const res = placeRootMessageFirst(`syntax = "proto3";\nmessage Outer { message Order {} }\n`, "Order");
    expect(res.success).toBe(false);
    if (!res.success) expect(res.error.code).toBe("ROOT_MESSAGE_NOT_FOUND");
  });

  it("returns PROTO_PARSE_ERROR on unbalanced braces", () => {
    const res = placeRootMessageFirst(`syntax = "proto3";\nmessage Order {\n  string id = 1;\n`, "Order");
    expect(res.success).toBe(false);
    if (!res.success) expect(res.error.code).toBe("PROTO_PARSE_ERROR");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/unit/lib/event-specs/proto-root.test.ts`
Expected: FAIL — `Cannot find package '@/lib/event-specs/proto-root'`.

- [ ] **Step 3: Implement** (`src/lib/event-specs/proto-root.ts`)

```ts
import { ok, err, type Result } from "@/types/result";

/**
 * Spec §7.3 / Story 16.3 pure core: make the payload's root message the FIRST
 * top-level definition (Confluent message index 0) and annotate it with
 * `// @RootNode` (AsyncAPI protobuf-schema-parser). Stale `@RootNode` lines on
 * other top-level definitions are removed. Idempotent.
 *
 * Everything before the first top-level definition (syntax, package, imports,
 * options, header comments) is kept verbatim; top-level definitions keep their
 * text and leading comments and are re-joined with one blank line.
 */

export const ROOT_NODE_ANNOTATION = "// @RootNode";

const DEFINITION_KEYWORDS = new Set(["message", "enum", "service", "extend"]);
const ROOT_NODE_LINE = /^[ \t]*\/\/[ \t]*@RootNode\b.*$/;

type TopLevelChunk = {
  keyword: string;
  name?: string;
  /** Start of the chunk's leading comments (or of the keyword's line when none). */
  start: number;
  /** Start of the line holding the keyword. */
  lineStart: number;
  /** Exclusive end (after `}` / `;` and any same-line trailing comment). */
  end: number;
};

function lineStartOf(src: string, index: number): number {
  return src.lastIndexOf("\n", index - 1) + 1;
}

function skipString(src: string, i: number): number {
  const quote = src[i];
  let j = i + 1;
  while (j < src.length && src[j] !== quote) j += src[j] === "\\" ? 2 : 1;
  return j + 1;
}

function skipLineComment(src: string, i: number): number {
  const nl = src.indexOf("\n", i);
  return nl < 0 ? src.length : nl;
}

function skipBlockComment(src: string, i: number): number {
  const close = src.indexOf("*/", i + 2);
  return close < 0 ? -1 : close + 2;
}

/** Index after the token that ends the chunk (`;` at depth 0, or the `}` closing depth 1). */
function scanToEnd(src: string, from: number, isDefinition: boolean): number {
  let depth = 0;
  let i = from;
  while (i < src.length) {
    const c = src[i];
    if (c === '"' || c === "'") {
      i = skipString(src, i);
      continue;
    }
    if (src.startsWith("//", i)) {
      i = skipLineComment(src, i);
      continue;
    }
    if (src.startsWith("/*", i)) {
      const next = skipBlockComment(src, i);
      if (next < 0) return -1;
      i = next;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth < 0) return -1;
      if (isDefinition && depth === 0) return i + 1;
    } else if (c === ";" && depth === 0 && !isDefinition) return i + 1;
    i++;
  }
  return -1;
}

function extendThroughTrailingComment(src: string, end: number): number {
  const m = /^[ \t]*(\/\/[^\n]*)/.exec(src.slice(end));
  return m ? end + m[0].length : end;
}

function scanTopLevel(src: string): TopLevelChunk[] | null {
  const chunks: TopLevelChunk[] = [];
  let i = 0;
  let prevEnd = 0;
  let triviaStart = -1;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (src.startsWith("//", i)) {
      if (triviaStart < 0) triviaStart = lineStartOf(src, i);
      i = skipLineComment(src, i);
      continue;
    }
    if (src.startsWith("/*", i)) {
      if (triviaStart < 0) triviaStart = lineStartOf(src, i);
      const next = skipBlockComment(src, i);
      if (next < 0) return null;
      i = next;
      continue;
    }
    const word = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i));
    if (!word) return null;
    const keyword = word[0];
    const isDefinition = DEFINITION_KEYWORDS.has(keyword);
    const name = isDefinition ? /^\s+([A-Za-z_][A-Za-z0-9_.]*)/.exec(src.slice(i + keyword.length))?.[1] : undefined;
    const end = scanToEnd(src, i, isDefinition);
    if (end < 0) return null;
    const lineStart = Math.max(prevEnd, lineStartOf(src, i));
    chunks.push({
      keyword,
      name,
      start: Math.max(prevEnd, triviaStart >= 0 ? Math.min(triviaStart, lineStart) : lineStart),
      lineStart,
      end: extendThroughTrailingComment(src, end),
    });
    i = prevEnd = chunks[chunks.length - 1].end;
    triviaStart = -1;
  }
  return chunks;
}

function stripRootNodeLines(leading: string): string {
  return leading
    .split("\n")
    .filter((line) => !ROOT_NODE_LINE.test(line))
    .join("\n");
}

export function placeRootMessageFirst(proto: string, rootMessage: string): Result<string> {
  const chunks = scanTopLevel(proto);
  if (!chunks) {
    return err({ code: "PROTO_PARSE_ERROR", message: "Unbalanced braces, quotes or comments in .proto source" });
  }
  const firstDefIndex = chunks.findIndex((c) => DEFINITION_KEYWORDS.has(c.keyword));
  const root = chunks.find((c) => c.keyword === "message" && c.name === rootMessage);
  if (firstDefIndex < 0 || !root) {
    return err({
      code: "ROOT_MESSAGE_NOT_FOUND",
      message: `Top-level message "${rootMessage}" not found in .proto source`,
    });
  }

  const render = (c: TopLevelChunk): string => {
    const leading = stripRootNodeLines(proto.slice(c.start, c.lineStart));
    const body = proto.slice(c.lineStart, c.end);
    if (c !== root) return leading + body;
    const indent = /^[ \t]*/.exec(body)?.[0] ?? "";
    return `${leading}${indent}${ROOT_NODE_ANNOTATION}\n${body}`;
  };

  const tail = chunks.slice(firstDefIndex).filter((c) => c !== root);
  const head = proto.slice(0, chunks[firstDefIndex].start).trimEnd();
  const trailing = proto.slice(chunks[chunks.length - 1].end).trim();
  const body = [root, ...tail].map(render).join("\n\n");
  return ok(`${head ? `${head}\n\n` : ""}${body}${trailing ? `\n\n${trailing}` : ""}\n`);
}
```

- [ ] **Step 4: Run tests — expect PASS**

Run: `npx vitest run tests/unit/lib/event-specs/proto-root.test.ts`
Expected: PASS — 1 file, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/event-specs/proto-root.ts tests/unit/lib/event-specs/proto-root.test.ts
git commit -m "feat(16.3): pure proto post-processor - root message first with // @RootNode"
```

---

### Task 5: Name-clash qualification (Story 18.4, spec §7.2 step 5)

**Files:**
- Create: `src/lib/event-specs/qualify.ts`
- Test: `tests/unit/lib/event-specs/qualify.test.ts`

**Interfaces:**
- Consumes: `compareStrings` (Task 1).
- Produces: `type NameCandidate = { key: string; name: string; owner: string }`; `type QualifiedNames = { names: Map<string, string>; disambiguated: string[] }`; `qualifyNames(items: NameCandidate[], homeOwner: string): QualifiedNames` (Decision D1).

- [ ] **Step 1: Write the failing test** (`tests/unit/lib/event-specs/qualify.test.ts`)

```ts
import { describe, it, expect } from "vitest";
import { qualifyNames } from "@/lib/event-specs/qualify";

describe("qualifyNames (spec §7.2 step 5)", () => {
  it("keeps unique names", () => {
    const { names, disambiguated } = qualifyNames(
      [
        { key: "a", name: "orders", owner: "checkout" },
        { key: "b", name: "refunds", owner: "payments" },
      ],
      "checkout",
    );
    expect(Object.fromEntries(names)).toEqual({ a: "orders", b: "refunds" });
    expect(disambiguated).toEqual([]);
  });

  it("qualifies the foreign item when a home item has the same name", () => {
    const { names } = qualifyNames(
      [
        { key: "fraud-orders", name: "orders", owner: "fraud" },
        { key: "checkout-orders", name: "orders", owner: "checkout" },
      ],
      "fraud",
    );
    expect(Object.fromEntries(names)).toEqual({ "fraud-orders": "orders", "checkout-orders": "checkout.orders" });
  });

  it("qualifies every clashing item when none is home", () => {
    const { names } = qualifyNames(
      [
        { key: "x", name: "orders", owner: "checkout" },
        { key: "y", name: "orders", owner: "fraud" },
      ],
      "risk",
    );
    expect(Object.fromEntries(names)).toEqual({ x: "checkout.orders", y: "fraud.orders" });
  });

  it("falls back to numeric suffixes for same-owner clashes, independent of input order", () => {
    const items = [
      { key: "msgv-2", name: "OrderCreated", owner: "checkout" },
      { key: "msgv-1", name: "OrderCreated", owner: "checkout" },
    ];
    const forward = qualifyNames(items, "checkout");
    const reverse = qualifyNames([...items].reverse(), "checkout");
    expect(Object.fromEntries(forward.names)).toEqual({ "msgv-1": "OrderCreated", "msgv-2": "OrderCreated_2" });
    expect(Object.fromEntries(reverse.names)).toEqual(Object.fromEntries(forward.names));
    expect(forward.disambiguated).toEqual(["msgv-2"]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/unit/lib/event-specs/qualify.test.ts`
Expected: FAIL — `Cannot find package '@/lib/event-specs/qualify'`.

- [ ] **Step 3: Implement** (`src/lib/event-specs/qualify.ts`)

```ts
import { compareStrings } from "./diagnostics";

/**
 * Spec §7.2 step 5 name-clash qualification, deterministic regardless of input order.
 *
 * - Names unique in the document stay as they are.
 * - Same name from different owners: items owned by the spec's home product keep
 *   the plain name; foreign items become `<owner>.<name>` (`checkout.orders`).
 * - Anything still colliding (same owner, same name — e.g. two versions of one
 *   Message in one spec) gets `_2`, `_3`, … in key order and is reported.
 *
 * Format qualification (`OrderCreated_avro` / `OrderCreated_json`) is applied by
 * the caller to `name` before calling this (see `assembleAsyncApi3`).
 */

export type NameCandidate = {
  /** Stable identity of the item (catalog id, or `id|formatSuffix` for message variants). */
  key: string;
  /** Unqualified name. */
  name: string;
  /** Owning product (or level) slug. */
  owner: string;
};

export type QualifiedNames = {
  names: Map<string, string>;
  /** Keys that needed a numeric suffix, sorted. */
  disambiguated: string[];
};

export function qualifyNames(items: NameCandidate[], homeOwner: string): QualifiedNames {
  const owners = new Map<string, Set<string>>();
  for (const item of items) {
    const set = owners.get(item.name) ?? new Set<string>();
    set.add(item.owner);
    owners.set(item.name, set);
  }

  const proposals = items.map((item) => {
    const clash = (owners.get(item.name)?.size ?? 0) > 1;
    return { key: item.key, proposal: clash && item.owner !== homeOwner ? `${item.owner}.${item.name}` : item.name };
  });
  proposals.sort((a, b) => compareStrings(a.proposal, b.proposal) || compareStrings(a.key, b.key));

  const taken = new Set<string>();
  const names = new Map<string, string>();
  const disambiguated: string[] = [];
  for (const { key, proposal } of proposals) {
    let name = proposal;
    if (taken.has(name)) {
      let n = 2;
      while (taken.has(`${proposal}_${n}`)) n++;
      name = `${proposal}_${n}`;
      disambiguated.push(key);
    }
    taken.add(name);
    names.set(key, name);
  }
  return { names, disambiguated: disambiguated.sort(compareStrings) };
}
```

- [ ] **Step 4: Run tests — expect PASS**

Run: `npx vitest run tests/unit/lib/event-specs/qualify.test.ts`
Expected: PASS — 1 file, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/event-specs/qualify.ts tests/unit/lib/event-specs/qualify.test.ts
git commit -m "feat(18.4): deterministic name-clash qualification for AsyncAPI keys"
```

---

### Task 6: Message schema rules — artifact selection, headers, Kafka key, `$ref` rebasing (Story 18.4, spec §7.2 step 3)

**Files:**
- Create: `src/lib/event-specs/message-schemas.ts`
- Test: `tests/unit/lib/event-specs/message-schemas.test.ts`

**Interfaces:**
- Consumes: `Diagnostic`, `FormatProfile`, `JsonObject`, `JsonValue`, `SchemaArtifact` (Task 1); `diagnostic` (Task 1); `downConvertToDraft07` (Task 3); `normalizeProfile`, `sameProfile` (Task 2).
- Produces: `type SchemaRole = "payload" | "key"`; `type SchemaSelection = { schema?: JsonObject | string; diagnostics: Diagnostic[] }`; `selectArtifact(artifacts, profile, role, pointer): SchemaSelection`; `headersSchema(artifact, pointer): { schema?: JsonObject; diagnostics: Diagnostic[] }`; `kafkaKeyProfile(channelProfile): FormatProfile`; `placeKafkaKey(bindings, key): { bindings: JsonObject; overridden: boolean }`; `rebaseLocalRefs(schema, basePointer): JsonObject`.
- Diagnostic codes: `PAYLOAD_ARTIFACT_MISSING`, `KEY_ARTIFACT_MISSING`, `SCHEMA_SHAPE_INVALID` (protobuf must be text, Avro / JSON Schema must be objects), `HEADERS_NOT_OBJECT_SCHEMA`, `SCHEMA_KEYWORD_DROPPED` (warning).

- [ ] **Step 1: Write the failing test** (`tests/unit/lib/event-specs/message-schemas.test.ts`)

```ts
import { describe, it, expect } from "vitest";
import {
  headersSchema,
  kafkaKeyProfile,
  placeKafkaKey,
  rebaseLocalRefs,
  selectArtifact,
} from "@/lib/event-specs/message-schemas";
import type { SchemaArtifact } from "@/lib/event-specs/types";

const avro: SchemaArtifact = { format: "avro", schema: { type: "record", name: "Order", fields: [] } };
const json07: SchemaArtifact = { format: "json-schema", dialect: "draft-07", schema: { type: "object" } };
const json2020: SchemaArtifact = {
  format: "json-schema",
  dialect: "2020-12",
  schema: {
    type: "object",
    properties: { a: { $ref: "#/$defs/A" } },
    $defs: { A: { type: "string" } },
    unevaluatedProperties: false,
  },
};
const proto: SchemaArtifact = { format: "protobuf", schema: 'syntax = "proto3";\n// @RootNode\nmessage Order {}\n' };

describe("selectArtifact", () => {
  it("picks the artifact matching the channel's format profile", () => {
    expect(selectArtifact([avro, json07], { format: "avro" }, "payload", "/p").schema).toEqual(avro.schema);
    expect(selectArtifact([avro, json07], { format: "json-schema" }, "payload", "/p").schema).toEqual({
      type: "object",
    });
    expect(selectArtifact([proto], { format: "protobuf" }, "payload", "/p").schema).toBe(proto.schema);
  });

  it("down-converts 2020-12 when the channel wants draft-07 and rebases refs onto the document", () => {
    const res = selectArtifact(
      [json2020],
      { format: "json-schema", dialect: "draft-07" },
      "payload",
      "/components/messages/M/payload/schema",
    );
    expect(res.schema).toEqual({
      type: "object",
      properties: { a: { $ref: "#/components/messages/M/payload/schema/definitions/A" } },
      definitions: { A: { type: "string" } },
    });
    expect(res.diagnostics).toEqual([
      {
        severity: "warning",
        code: "SCHEMA_KEYWORD_DROPPED",
        message: 'Down-converting to draft-07: "unevaluatedProperties" has no draft-07 equivalent and was dropped',
        pointer: "/components/messages/M/payload/schema/unevaluatedProperties",
      },
    ]);
  });

  it("reports a missing artifact per role", () => {
    expect(selectArtifact([avro], { format: "protobuf" }, "payload", "/p").diagnostics[0]).toMatchObject({
      severity: "error",
      code: "PAYLOAD_ARTIFACT_MISSING",
      pointer: "/p",
    });
    expect(selectArtifact([], { format: "avro" }, "key", "/k").diagnostics[0].code).toBe("KEY_ARTIFACT_MISSING");
  });

  it("rejects an artifact whose schema has the wrong shape for its format", () => {
    const bad: SchemaArtifact = { format: "protobuf", schema: { not: "text" } };
    const res = selectArtifact([bad], { format: "protobuf" }, "payload", "/p");
    expect(res.schema).toBeUndefined();
    expect(res.diagnostics[0].code).toBe("SCHEMA_SHAPE_INVALID");
  });
});

describe("headersSchema (headers always JSON Schema object)", () => {
  it("accepts a JSON Schema object schema", () => {
    const res = headersSchema({ format: "json-schema", schema: { type: "object", properties: {} } }, "/h");
    expect(res).toEqual({ schema: { type: "object", properties: {} }, diagnostics: [] });
  });

  it.each<[string, SchemaArtifact]>([
    ["a non-object JSON Schema", { format: "json-schema", schema: { type: "string" } }],
    ["an Avro schema", { format: "avro", schema: { type: "record", name: "H", fields: [] } }],
    ["protobuf text", { format: "protobuf", schema: "message H {}" }],
  ])("rejects %s", (_label, artifact) => {
    const res = headersSchema(artifact, "/components/messages/M/headers");
    expect(res.schema).toBeUndefined();
    expect(res.diagnostics).toEqual([
      {
        severity: "error",
        code: "HEADERS_NOT_OBJECT_SCHEMA",
        message: "Headers must be a JSON Schema object schema (type: object); headers omitted",
        pointer: "/components/messages/M/headers",
      },
    ]);
  });
});

describe("Kafka key placement (spec §7.2 step 3)", () => {
  it("uses Avro on Avro channels, JSON Schema draft-07 otherwise", () => {
    expect(kafkaKeyProfile({ format: "avro" })).toEqual({ format: "avro" });
    expect(kafkaKeyProfile({ format: "json-schema", dialect: "2020-12" })).toEqual({
      format: "json-schema",
      dialect: "draft-07",
    });
    expect(kafkaKeyProfile({ format: "protobuf" })).toEqual({ format: "json-schema", dialect: "draft-07" });
  });

  it("puts the key first under bindings.kafka and keeps other bindings", () => {
    const input = { kafka: { schemaIdLocation: "header", bindingVersion: "0.5.0" }, amqp: { ack: true } };
    const { bindings, overridden } = placeKafkaKey(input, { type: "string" });
    expect(bindings).toEqual({
      kafka: { key: { type: "string" }, schemaIdLocation: "header", bindingVersion: "0.5.0" },
      amqp: { ack: true },
    });
    expect(Object.keys(bindings.kafka as object)[0]).toBe("key");
    expect(overridden).toBe(false);
    expect(input).toEqual({ kafka: { schemaIdLocation: "header", bindingVersion: "0.5.0" }, amqp: { ack: true } });
  });

  it("reports a replaced hand-written key", () => {
    expect(placeKafkaKey({ kafka: { key: { type: "integer" } } }, { type: "string" })).toEqual({
      bindings: { kafka: { key: { type: "string" } } },
      overridden: true,
    });
    expect(placeKafkaKey(undefined, { type: "string" }).bindings).toEqual({ kafka: { key: { type: "string" } } });
  });
});

describe("rebaseLocalRefs", () => {
  it("rebases local refs but not remote refs or data keywords", () => {
    expect(
      rebaseLocalRefs(
        { properties: { a: { $ref: "#/definitions/A" }, b: { $ref: "other.json#/x" } }, default: { $ref: "#/keep" } },
        "/components/messages/M/payload/schema",
      ),
    ).toEqual({
      properties: { a: { $ref: "#/components/messages/M/payload/schema/definitions/A" }, b: { $ref: "other.json#/x" } },
      default: { $ref: "#/keep" },
    });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/unit/lib/event-specs/message-schemas.test.ts`
Expected: FAIL — `Cannot find package '@/lib/event-specs/message-schemas'`.

- [ ] **Step 3: Implement** (`src/lib/event-specs/message-schemas.ts`)

```ts
import type { Diagnostic, FormatProfile, JsonObject, JsonValue, SchemaArtifact } from "./types";
import { diagnostic } from "./diagnostics";
import { downConvertToDraft07 } from "./json-schema-downconvert";
import { normalizeProfile, sameProfile } from "./schema-format";

/**
 * Spec §7.2 step 3 — which pre-rendered schema goes where:
 * - payload: the artifact in the channel's format profile (2020-12 is
 *   down-converted when the channel wants draft-07 and only 2020-12 exists);
 * - headers: always a JSON Schema object schema, emitted as a plain AsyncAPI
 *   Schema Object (draft-07 compatible);
 * - Kafka key: Avro when the channel is Avro, otherwise JSON Schema draft-07,
 *   placed at `bindings.kafka.key`.
 * Embedded JSON Schemas get their local `$ref`s rebased onto their location in
 * the AsyncAPI document so they stay resolvable from the document root.
 */

export type SchemaRole = "payload" | "key";

export type SchemaSelection = { schema?: JsonObject | string; diagnostics: Diagnostic[] };

const MISSING_CODE: Record<SchemaRole, string> = {
  payload: "PAYLOAD_ARTIFACT_MISSING",
  key: "KEY_ARTIFACT_MISSING",
};

const DATA_KEYWORDS = new Set(["const", "enum", "default", "examples"]);

const isObject = (v: unknown): v is JsonObject => typeof v === "object" && v !== null && !Array.isArray(v);

function describe(profile: FormatProfile): string {
  const p = normalizeProfile(profile);
  return p.dialect ? `${p.format} (${p.dialect})` : p.format;
}

function shapeIsValid(artifact: SchemaArtifact): boolean {
  return artifact.format === "protobuf" ? typeof artifact.schema === "string" : isObject(artifact.schema);
}

/** Rewrite local refs (`#/definitions/X`) to absolute document refs (`#<basePointer>/definitions/X`). */
export function rebaseLocalRefs(schema: JsonObject, basePointer: string): JsonObject {
  const walk = (node: JsonValue): JsonValue => {
    if (Array.isArray(node)) return node.map(walk);
    if (!isObject(node)) return node;
    const out: JsonObject = {};
    for (const [key, value] of Object.entries(node)) {
      if (key === "$ref" && typeof value === "string" && value.startsWith("#")) {
        out[key] = `#${basePointer}${value.slice(1)}`;
      } else if (DATA_KEYWORDS.has(key)) {
        out[key] = structuredClone(value);
      } else {
        out[key] = walk(value);
      }
    }
    return out;
  };
  return walk(schema) as JsonObject;
}

function downConverted(schema: JsonObject, pointer: string): { schema: JsonObject; diagnostics: Diagnostic[] } {
  const result = downConvertToDraft07(schema);
  return {
    schema: result.schema,
    diagnostics: result.warnings.map((w) =>
      diagnostic(
        "warning",
        "SCHEMA_KEYWORD_DROPPED",
        `Down-converting to draft-07: ${w.message}`,
        `${pointer}${w.pointer}`,
      ),
    ),
  };
}

/**
 * Pick the artifact for `profile`. `pointer` is where the schema lands in the
 * document (`…/payload/schema`, `…/bindings/kafka/key`).
 */
export function selectArtifact(
  artifacts: SchemaArtifact[],
  profile: FormatProfile,
  role: SchemaRole,
  pointer: string,
): SchemaSelection {
  const target = normalizeProfile(profile);
  const exact = artifacts.find((a) => sameProfile(a, target));
  const fallback =
    !exact && target.format === "json-schema" && target.dialect === "draft-07"
      ? artifacts.find((a) => sameProfile(a, { format: "json-schema", dialect: "2020-12" }))
      : undefined;
  const chosen = exact ?? fallback;

  if (!chosen) {
    return {
      diagnostics: [
        diagnostic("error", MISSING_CODE[role], `No ${role} schema rendered as ${describe(target)}`, pointer),
      ],
    };
  }
  if (!shapeIsValid(chosen)) {
    return {
      diagnostics: [
        diagnostic(
          "error",
          "SCHEMA_SHAPE_INVALID",
          `${describe(chosen)} ${role} schema must be ${chosen.format === "protobuf" ? ".proto source text" : "a JSON object"}`,
          pointer,
        ),
      ],
    };
  }
  if (typeof chosen.schema === "string") return { schema: chosen.schema, diagnostics: [] };
  if (target.format !== "json-schema") return { schema: structuredClone(chosen.schema), diagnostics: [] };
  if (fallback) {
    const converted = downConverted(chosen.schema, pointer);
    return { schema: rebaseLocalRefs(converted.schema, pointer), diagnostics: converted.diagnostics };
  }
  return { schema: rebaseLocalRefs(chosen.schema, pointer), diagnostics: [] };
}

/** Headers must be a JSON Schema whose `type` is `"object"`; 2020-12 is down-converted. */
export function headersSchema(
  artifact: SchemaArtifact,
  pointer: string,
): { schema?: JsonObject; diagnostics: Diagnostic[] } {
  const schema = artifact.schema;
  if (artifact.format !== "json-schema" || !isObject(schema) || schema.type !== "object") {
    return {
      diagnostics: [
        diagnostic(
          "error",
          "HEADERS_NOT_OBJECT_SCHEMA",
          "Headers must be a JSON Schema object schema (type: object); headers omitted",
          pointer,
        ),
      ],
    };
  }
  if (normalizeProfile(artifact).dialect === "2020-12") {
    const converted = downConverted(schema, pointer);
    return { schema: rebaseLocalRefs(converted.schema, pointer), diagnostics: converted.diagnostics };
  }
  return { schema: rebaseLocalRefs(schema, pointer), diagnostics: [] };
}

/** Spec §7.2 step 3: Avro key on an Avro channel, otherwise JSON Schema (draft-07). */
export function kafkaKeyProfile(channelProfile: FormatProfile): FormatProfile {
  return normalizeProfile(channelProfile).format === "avro"
    ? { format: "avro" }
    : { format: "json-schema", dialect: "draft-07" };
}

/**
 * Return a copy of `bindings` with `kafka.key` set (first key of `kafka`), keeping
 * every other binding. `overridden` reports a hand-written key that was replaced.
 */
export function placeKafkaKey(
  bindings: JsonObject | undefined,
  key: JsonObject | string,
): { bindings: JsonObject; overridden: boolean } {
  const copy: JsonObject = bindings ? structuredClone(bindings) : {};
  const kafka: JsonObject = isObject(copy.kafka) ? copy.kafka : {};
  const { key: previous, ...rest } = kafka;
  copy.kafka = { key, ...rest };
  return { bindings: copy, overridden: previous !== undefined };
}
```

- [ ] **Step 4: Run tests — expect PASS**

Run: `npx vitest run tests/unit/lib/event-specs/message-schemas.test.ts`
Expected: PASS — 1 file, 12 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/event-specs/message-schemas.ts tests/unit/lib/event-specs/message-schemas.test.ts
git commit -m "feat(18.4): payload/headers/key schema rules for AsyncAPI messages"
```

---

### Task 7: Worked-example fixtures + `EventSpecDocument` → `ResolvedEventSpec` mapping (Story 18.4, spec §6.1 / §6.2 / §7.2 step 2)

**Files:**
- Create: `tests/unit/lib/event-specs/fixtures/worked-example.ts`
- Create: `src/lib/event-specs/resolve.ts`
- Test: `tests/unit/lib/event-specs/resolve.test.ts`

**Interfaces:**
- Consumes: Task 1 types; `jsonPointer` (Task 1); `ok`, `err`, `Result`.
- Produces: `type EventSpecCatalog = { channels: ResolvedChannel[]; messages: ResolvedMessage[]; traits: ResolvedTrait[] }`; `type ResolveOptions = { productSlug: string; version: string }`; `type ResolveProblem = { pointer: string; message: string }`; `resolveEventSpecDocument(doc, catalog, options): Result<ResolvedEventSpec>` — error `UNRESOLVED_REFERENCES` with `details.problems: ResolveProblem[]` (all problems at once; pointers into the `EventSpecDocument`).
- Produces (fixtures): `ordersChannel`, `cloudEventsTrait`, `orderCreatedV13`, `kafkaProd`, `checkoutServiceSpec`, `fraudScorerSpec`, `checkoutServiceDocument`, `workedExampleCatalog`, `SPEC_6_2_CHECKOUT_YAML` (spec §6.2 YAML, verbatim).

Worked example mapping (spec §6.2 table → fixtures): Entity `Order@2.1` → `orderCreatedV13.payloads` (Avro record `acme.payments.checkout.Order`, plus a JSON Schema rendering); `OrderKey@1.0` → `orderCreatedV13.keys` (Avro `{ type: string }` + JSON Schema); Trait `CloudEvents` (tenant `acme`) → `cloudEventsTrait` with headers artifact `CloudEventsHeaders@1.0`; Message `OrderCreated@1.3` → `orderCreatedV13`; Channel `orders` → `ordersChannel` (Kafka, Avro, `partitions: 12`); `checkout-service@2.0` → `checkoutServiceSpec` (server `kafka-prod`, **send**); `fraud-scorer@1.0` → `fraudScorerSpec` (product `fraud`, **receive** on Checkout's channel).

- [ ] **Step 1: Create the fixtures** (`tests/unit/lib/event-specs/fixtures/worked-example.ts`)

```ts
/**
 * Spec §6.2 worked example as in-memory fixtures: Checkout publishes
 * `OrderCreated@1.3` on Kafka topic `payments.orders.v1`; Fraud consumes it.
 * Pre-rendered artifacts stand in for EntityVersionArtifact outputs.
 */
import type {
  EventSpecDocument,
  EventSpecServer,
  ResolvedChannel,
  ResolvedEventSpec,
  ResolvedMessage,
  ResolvedTrait,
} from "@/lib/event-specs/types";
import type { EventSpecCatalog } from "@/lib/event-specs/resolve";

export const ordersChannel: ResolvedChannel = {
  id: "ch-checkout-orders",
  name: "orders",
  productSlug: "checkout",
  address: "payments.orders.v1",
  protocol: "kafka",
  profile: { format: "avro" },
  bindings: { kafka: { partitions: 12 } },
};

/** Tenant-level `CloudEvents` trait; headers → `CloudEventsHeaders@1.0` (JSON Schema). */
export const cloudEventsTrait: ResolvedTrait = {
  id: "trait-cloudevents",
  name: "CloudEvents",
  kind: "MESSAGE",
  ownerSlug: "acme",
  spec: {},
  headers: {
    format: "json-schema",
    dialect: "draft-07",
    schema: {
      type: "object",
      properties: { ce_id: { type: "string" }, ce_type: { type: "string" }, ce_source: { type: "string" } },
    },
  },
};

/** `OrderCreated@1.3`: payload → `Order@2.1`, key → `OrderKey@1.0`, traits [CloudEvents]. */
export const orderCreatedV13: ResolvedMessage = {
  id: "msgv-ordercreated-1.3",
  name: "OrderCreated",
  productSlug: "checkout",
  contentType: "avro/binary",
  traitRefs: ["trait-cloudevents"],
  payloads: [
    { format: "avro", schema: { type: "record", name: "Order", namespace: "acme.payments.checkout", fields: [] } },
    {
      format: "json-schema",
      dialect: "draft-07",
      schema: { $schema: "http://json-schema.org/draft-07/schema#", title: "Order", type: "object", properties: {} },
    },
  ],
  keys: [
    { format: "avro", schema: { type: "string" } },
    { format: "json-schema", dialect: "draft-07", schema: { type: "string" } },
  ],
};

export const kafkaProd: EventSpecServer = { key: "kafka-prod", protocol: "kafka", host: "kafka-prod.internal:9092" };

export const checkoutServiceSpec: ResolvedEventSpec = {
  productSlug: "checkout",
  info: { title: "checkout-service", version: "2.0" },
  servers: [kafkaProd],
  operations: [
    {
      key: "publishOrderCreated",
      action: "send",
      channelRef: ordersChannel.id,
      messageRefs: [orderCreatedV13.id],
      traitRefs: [],
    },
  ],
  channels: [ordersChannel],
  messages: [orderCreatedV13],
  traits: [cloudEventsTrait],
  components: {},
};

/** Fraud product consumes Checkout's channel cross-product (frozen copies, read-only). */
export const fraudScorerSpec: ResolvedEventSpec = {
  productSlug: "fraud",
  info: { title: "fraud-scorer", version: "1.0" },
  servers: [kafkaProd],
  operations: [
    {
      key: "consumeOrderCreated",
      action: "receive",
      channelRef: ordersChannel.id,
      messageRefs: [orderCreatedV13.id],
      traitRefs: [],
    },
  ],
  channels: [ordersChannel],
  messages: [orderCreatedV13],
  traits: [cloudEventsTrait],
  components: {},
};

/** The stored §6.1 draft document for `checkout-service` (IDs only). */
export const checkoutServiceDocument: EventSpecDocument = {
  info: { title: "checkout-service" },
  servers: [kafkaProd],
  operations: [
    {
      key: "publishOrderCreated",
      action: "send",
      channelId: ordersChannel.id,
      messageVersionIds: [orderCreatedV13.id],
      traitIds: [],
    },
  ],
};

/** Catalog snapshot the DB-backed resolver will load (Story 18.4); includes unrelated rows. */
export const workedExampleCatalog: EventSpecCatalog = {
  channels: [ordersChannel, { ...ordersChannel, id: "ch-unused", name: "refunds", address: "payments.refunds.v1" }],
  messages: [orderCreatedV13],
  traits: [cloudEventsTrait],
};

/** Spec §6.2 `checkout-service@2.0` YAML, verbatim. */
export const SPEC_6_2_CHECKOUT_YAML = `asyncapi: 3.0.0
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
`;
```

- [ ] **Step 2: Write the failing test** (`tests/unit/lib/event-specs/resolve.test.ts`)

```ts
import { describe, it, expect } from "vitest";
import { resolveEventSpecDocument } from "@/lib/event-specs/resolve";
import type { EventSpecDocument } from "@/lib/event-specs/types";
import {
  checkoutServiceDocument,
  checkoutServiceSpec,
  cloudEventsTrait,
  ordersChannel,
  workedExampleCatalog,
} from "./fixtures/worked-example";

describe("resolveEventSpecDocument (EventSpecDocument → ResolvedEventSpec)", () => {
  it("maps the §6.2 checkout-service draft onto the resolved model", () => {
    const res = resolveEventSpecDocument(checkoutServiceDocument, workedExampleCatalog, {
      productSlug: "checkout",
      version: "2.0",
    });
    expect(res).toEqual({ success: true, data: checkoutServiceSpec });
  });

  it("carries reply, bindings, summary and local components across", () => {
    const doc: EventSpecDocument = {
      info: { title: "rr", description: "request/reply" },
      defaultContentType: "application/json",
      servers: [],
      operations: [
        {
          key: "ask",
          action: "send",
          channelId: ordersChannel.id,
          messageVersionIds: [],
          traitIds: [],
          summary: "Ask",
          bindings: { kafka: { groupId: { type: "string" } } },
          reply: { channelId: ordersChannel.id, messageVersionIds: [] },
        },
      ],
      components: { correlationIds: { byId: { location: "$message.header#/ce_id" } } },
    };
    const res = resolveEventSpecDocument(doc, workedExampleCatalog, { productSlug: "checkout", version: "0.1" });
    expect(res.success).toBe(true);
    if (!res.success) return;
    expect(res.data.info).toEqual({ title: "rr", description: "request/reply", version: "0.1" });
    expect(res.data.defaultContentType).toBe("application/json");
    expect(res.data.operations[0]).toEqual({
      key: "ask",
      action: "send",
      channelRef: ordersChannel.id,
      messageRefs: [],
      traitRefs: [],
      summary: "Ask",
      bindings: { kafka: { groupId: { type: "string" } } },
      reply: { channelRef: ordersChannel.id, messageRefs: [] },
    });
    expect(res.data.components).toEqual({ correlationIds: { byId: { location: "$message.header#/ce_id" } } });
    expect(res.data.channels.map((c) => c.id)).toEqual([ordersChannel.id]);
  });

  it("reports every unresolved reference together", () => {
    const doc: EventSpecDocument = {
      info: { title: "broken" },
      servers: [],
      operations: [
        {
          key: "a",
          action: "send",
          channelId: "nope",
          messageVersionIds: ["missing"],
          traitIds: [cloudEventsTrait.id],
        },
      ],
    };
    const res = resolveEventSpecDocument(doc, workedExampleCatalog, { productSlug: "checkout", version: "1.0" });
    expect(res.success).toBe(false);
    if (res.success) return;
    expect(res.error.code).toBe("UNRESOLVED_REFERENCES");
    expect((res.error.details as { problems: unknown[] }).problems).toEqual([
      { pointer: "/operations/0/channelId", message: 'Channel "nope" not found' },
      { pointer: "/operations/0/messageVersionIds/0", message: 'Message version "missing" not found' },
      {
        pointer: "/operations/0/traitIds/0",
        message: 'Trait "trait-cloudevents" is a MESSAGE trait, expected OPERATION',
      },
    ]);
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `npx vitest run tests/unit/lib/event-specs/resolve.test.ts`
Expected: FAIL — `Cannot find package '@/lib/event-specs/resolve'`.

- [ ] **Step 4: Implement** (`src/lib/event-specs/resolve.ts`)

```ts
import { ok, err, type Result } from "@/types/result";
import type {
  EventSpecDocument,
  ResolvedChannel,
  ResolvedEventSpec,
  ResolvedMessage,
  ResolvedOperation,
  ResolvedTrait,
  TraitKind,
} from "./types";
import { jsonPointer } from "./json-pointer";

/**
 * Spec §7.2 step 2 (pure part): map a stored `EventSpecDocument` (IDs) plus an
 * in-memory catalog snapshot onto the assembler's `ResolvedEventSpec`.
 *
 * Mapping:
 * - info + options.version → info (version = `MAJOR.MINOR`)
 * - defaultContentType, servers, components → copied
 * - operations[].channelId → operations[].channelRef (+ channels[])
 * - operations[].messageVersionIds → operations[].messageRefs (+ messages[])
 * - operations[].traitIds → operations[].traitRefs (+ traits[], kind OPERATION)
 * - operations[].reply.{channelId, messageVersionIds} → reply.{channelRef, messageRefs}
 * - catalog message.traitRefs → traits[] (kind MESSAGE)
 *
 * Only referenced catalog items are carried over, in first-reference order.
 * Every unresolved reference is reported together (spec §10).
 */

export type EventSpecCatalog = {
  channels: ResolvedChannel[];
  messages: ResolvedMessage[];
  traits: ResolvedTrait[];
};

export type ResolveOptions = { productSlug: string; version: string };

export type ResolveProblem = { pointer: string; message: string };

export function resolveEventSpecDocument(
  doc: EventSpecDocument,
  catalog: EventSpecCatalog,
  options: ResolveOptions,
): Result<ResolvedEventSpec> {
  const channelsById = new Map(catalog.channels.map((c) => [c.id, c]));
  const messagesById = new Map(catalog.messages.map((m) => [m.id, m]));
  const traitsById = new Map(catalog.traits.map((t) => [t.id, t]));

  const problems: ResolveProblem[] = [];
  const channels = new Map<string, ResolvedChannel>();
  const messages = new Map<string, ResolvedMessage>();
  const traits = new Map<string, ResolvedTrait>();

  const takeChannel = (id: string, pointer: string) => {
    const channel = channelsById.get(id);
    if (!channel) problems.push({ pointer, message: `Channel "${id}" not found` });
    else if (!channels.has(id)) channels.set(id, channel);
  };
  const takeTrait = (id: string, kind: TraitKind, pointer: string, context = "") => {
    const trait = traitsById.get(id);
    if (!trait) problems.push({ pointer, message: `${context}Trait "${id}" not found` });
    else if (trait.kind !== kind) {
      problems.push({ pointer, message: `${context}Trait "${id}" is a ${trait.kind} trait, expected ${kind}` });
    } else if (!traits.has(id)) traits.set(id, trait);
  };
  const takeMessage = (id: string, pointer: string) => {
    const message = messagesById.get(id);
    if (!message) {
      problems.push({ pointer, message: `Message version "${id}" not found` });
      return;
    }
    if (messages.has(id)) return;
    messages.set(id, message);
    for (const traitId of message.traitRefs) takeTrait(traitId, "MESSAGE", pointer, `Message version "${id}": `);
  };

  const operations: ResolvedOperation[] = doc.operations.map((op, index) => {
    const base = jsonPointer("operations", index);
    takeChannel(op.channelId, `${base}/channelId`);
    op.messageVersionIds.forEach((id, i) => takeMessage(id, `${base}/messageVersionIds/${i}`));
    op.traitIds.forEach((id, i) => takeTrait(id, "OPERATION", `${base}/traitIds/${i}`));
    if (op.reply?.channelId) takeChannel(op.reply.channelId, `${base}/reply/channelId`);
    op.reply?.messageVersionIds?.forEach((id, i) => takeMessage(id, `${base}/reply/messageVersionIds/${i}`));

    const resolved: ResolvedOperation = {
      key: op.key,
      action: op.action,
      channelRef: op.channelId,
      messageRefs: [...op.messageVersionIds],
      traitRefs: [...op.traitIds],
    };
    if (op.summary !== undefined) resolved.summary = op.summary;
    if (op.description !== undefined) resolved.description = op.description;
    if (op.bindings !== undefined) resolved.bindings = structuredClone(op.bindings);
    if (op.reply) {
      resolved.reply = {};
      if (op.reply.channelId !== undefined) resolved.reply.channelRef = op.reply.channelId;
      if (op.reply.messageVersionIds !== undefined) resolved.reply.messageRefs = [...op.reply.messageVersionIds];
    }
    return resolved;
  });

  if (problems.length > 0) {
    return err({
      code: "UNRESOLVED_REFERENCES",
      message: `${problems.length} reference(s) in the event spec could not be resolved`,
      details: { problems },
    });
  }

  const spec: ResolvedEventSpec = {
    productSlug: options.productSlug,
    info: { ...structuredClone(doc.info), version: options.version },
    servers: structuredClone(doc.servers),
    operations,
    channels: [...channels.values()],
    messages: [...messages.values()],
    traits: [...traits.values()],
    components: structuredClone(doc.components ?? {}),
  };
  if (doc.defaultContentType !== undefined) spec.defaultContentType = doc.defaultContentType;
  return ok(spec);
}
```

- [ ] **Step 5: Run tests — expect PASS**

Run: `npx vitest run tests/unit/lib/event-specs/resolve.test.ts`
Expected: PASS — 1 file, 3 tests.
Run: `npx tsc --noEmit` — Expected: no errors (the fixtures file is type-checked here).

- [ ] **Step 6: Commit**

```bash
git add src/lib/event-specs/resolve.ts tests/unit/lib/event-specs/fixtures/worked-example.ts tests/unit/lib/event-specs/resolve.test.ts
git commit -m "feat(18.4): map EventSpecDocument + catalog snapshot to ResolvedEventSpec"
```

---

### Task 8: AsyncAPI 3.0.0 document assembler (Story 18.4, spec §7.2 steps 3–5)

**Files:**
- Create: `src/lib/event-specs/assemble.ts`
- Test: `tests/unit/lib/event-specs/assemble.test.ts`

**Interfaces:**
- Consumes: Task 1 types and helpers (`compareStrings`, `diagnostic`, `normalizeDiagnostics`, `jsonPointer`, `localRef`); `formatSuffix`, `normalizeProfile`, `schemaFormatFor` (Task 2); `qualifyNames`, `NameCandidate` (Task 5); `headersSchema`, `kafkaKeyProfile`, `placeKafkaKey`, `selectArtifact` (Task 6); fixtures (Tasks 1, 7).
- Produces: `ASYNCAPI_VERSION = "3.0.0"`; `type AssemblyResult = { document: JsonObject; diagnostics: Diagnostic[] }`; `assembleAsyncApi3(spec: ResolvedEventSpec): AssemblyResult`.
- Diagnostic codes added here: `DUPLICATE_ID`, `DUPLICATE_OPERATION_KEY`, `DUPLICATE_SERVER_KEY`, `UNKNOWN_CHANNEL_REF`, `UNKNOWN_MESSAGE_REF`, `UNKNOWN_TRAIT_REF`, `REPLY_CHANNEL_REQUIRED`, `NAME_DISAMBIGUATED` (warning), `KEY_BINDING_OVERRIDDEN` (warning), `UNPUBLISHED_MESSAGE` (info); plus those from Task 6.

Algorithm: (1) index inputs by id; walk operations sorted by key, collecting used channels, **message variants** (`messageId|formatSuffix(channel profile)`, flagged `kafka` when any using channel is Kafka), operation traits, and the message traits of used variants; unknown refs become diagnostics and are skipped. (2) Qualify channel, message (format-suffixed first when a message has several variants), message-trait and operation-trait names with `qualifyNames(…, spec.productSlug)`. (3) Build `components.messages` per variant: traits refs, headers (D3), payload `{ schemaFormat, schema }`, Kafka key (D4), `name` when qualified. (4) Build trait components (artifact headers first, then the trait's own fields). (5) Channels with `messages` refs (D7). (6) Operations with channel / message / trait / reply refs. (7) Servers (`externalRef` → `externalDocs.url`). (8) Document in canonical order (D6).

- [ ] **Step 1: Write the failing test** (`tests/unit/lib/event-specs/assemble.test.ts`)

```ts
import { describe, it, expect } from "vitest";
import { parse } from "yaml";
import { assembleAsyncApi3 } from "@/lib/event-specs/assemble";
import type { JsonObject, ResolvedEventSpec, SchemaArtifact } from "@/lib/event-specs/types";
import { channel, deepFreeze, jsonObject, message, operation, spec } from "./fixtures/builders";
import { SPEC_6_2_CHECKOUT_YAML, checkoutServiceSpec, ordersChannel, orderCreatedV13 } from "./fixtures/worked-example";

const at = (doc: JsonObject, ...path: string[]): unknown =>
  path.reduce<unknown>((node, key) => (node as Record<string, unknown> | undefined)?.[key], doc);

describe("assembleAsyncApi3 — spec §6.2 worked example", () => {
  it("produces the documented checkout-service document with no diagnostics", () => {
    const { document, diagnostics } = assembleAsyncApi3(checkoutServiceSpec);
    expect(document).toEqual(parse(SPEC_6_2_CHECKOUT_YAML));
    expect(diagnostics).toEqual([]);
  });

  it("emits top-level keys in canonical AsyncAPI order", () => {
    const { document } = assembleAsyncApi3(checkoutServiceSpec);
    expect(Object.keys(document)).toEqual(["asyncapi", "info", "servers", "channels", "operations", "components"]);
    expect(Object.keys(at(document, "components", "messages", "OrderCreated") as object)).toEqual([
      "contentType",
      "traits",
      "payload",
      "bindings",
    ]);
  });

  it("never mutates its input", () => {
    const frozen = deepFreeze(structuredClone(checkoutServiceSpec));
    expect(() => assembleAsyncApi3(frozen)).not.toThrow();
    expect(frozen).toEqual(checkoutServiceSpec);
  });

  it("is independent of input array order", () => {
    const extra = channel({ id: "ch-refunds", name: "refunds" });
    const refund = message({ id: "msgv-refund", name: "RefundIssued" });
    const base = spec({
      channels: [ordersChannel, extra],
      messages: [orderCreatedV13, refund],
      traits: checkoutServiceSpec.traits,
      servers: [
        { key: "b", host: "b:9092", protocol: "kafka" },
        { key: "a", host: "a:9092", protocol: "kafka" },
      ],
      operations: [
        operation({ key: "z", channelRef: extra.id, messageRefs: [refund.id] }),
        operation({ key: "a", channelRef: ordersChannel.id, messageRefs: [orderCreatedV13.id] }),
      ],
    });
    const shuffled: ResolvedEventSpec = {
      ...base,
      channels: [...base.channels].reverse(),
      messages: [...base.messages].reverse(),
      servers: [...base.servers].reverse(),
      operations: [...base.operations].reverse(),
    };
    const a = assembleAsyncApi3(base);
    const b = assembleAsyncApi3(shuffled);
    expect(JSON.stringify(b.document)).toBe(JSON.stringify(a.document));
    expect(Object.keys(at(a.document, "servers") as object)).toEqual(["a", "b"]);
    expect(Object.keys(at(a.document, "operations") as object)).toEqual(["a", "z"]);
  });
});

describe("name-clash qualification", () => {
  it("qualifies a foreign channel that clashes with a home channel (checkout.orders)", () => {
    const fraudOrders = channel({
      id: "ch-fraud-orders",
      name: "orders",
      productSlug: "fraud",
      address: "risk.orders.v1",
    });
    const scored = message({ id: "msgv-scored", name: "OrderScored", productSlug: "fraud" });
    const { document, diagnostics } = assembleAsyncApi3(
      spec({
        productSlug: "fraud",
        channels: [ordersChannel, fraudOrders],
        messages: [{ ...orderCreatedV13, traitRefs: [] }, scored],
        operations: [
          operation({
            key: "consume",
            action: "receive",
            channelRef: ordersChannel.id,
            messageRefs: [orderCreatedV13.id],
          }),
          operation({ key: "publish", channelRef: fraudOrders.id, messageRefs: [scored.id] }),
        ],
      }),
    );
    expect(Object.keys(at(document, "channels") as object)).toEqual(["checkout.orders", "orders"]);
    expect(at(document, "channels", "orders", "address")).toBe("risk.orders.v1");
    expect(at(document, "operations", "consume")).toEqual({
      action: "receive",
      channel: { $ref: "#/channels/checkout.orders" },
      messages: [{ $ref: "#/channels/checkout.orders/messages/OrderCreated" }],
    });
    expect(diagnostics).toEqual([]);
  });

  it("suffixes one Message used in two formats (OrderCreated_avro / OrderCreated_json)", () => {
    const jsonOrders = channel({ id: "ch-orders-json", name: "orders-json", profile: { format: "json-schema" } });
    const msg = message({ id: "msgv-oc", name: "OrderCreated" });
    const { document } = assembleAsyncApi3(
      spec({
        channels: [ordersChannel, jsonOrders],
        messages: [msg],
        operations: [
          operation({ key: "avro", channelRef: ordersChannel.id, messageRefs: [msg.id] }),
          operation({ key: "json", channelRef: jsonOrders.id, messageRefs: [msg.id] }),
        ],
      }),
    );
    const messages = at(document, "components", "messages") as Record<string, JsonObject>;
    expect(Object.keys(messages)).toEqual(["OrderCreated_avro", "OrderCreated_json"]);
    expect(messages.OrderCreated_avro.name).toBe("OrderCreated");
    expect(at(messages.OrderCreated_avro, "payload", "schemaFormat")).toBe(
      "application/vnd.apache.avro+json;version=1.9.0",
    );
    expect(at(messages.OrderCreated_json, "payload", "schemaFormat")).toBe("application/schema+json;version=draft-07");
    expect(at(document, "channels", "orders-json", "messages")).toEqual({
      OrderCreated_json: { $ref: "#/components/messages/OrderCreated_json" },
    });
    expect(at(document, "operations", "json", "messages")).toEqual([
      { $ref: "#/channels/orders-json/messages/OrderCreated_json" },
    ]);
  });

  it("disambiguates two versions of one Message in one spec with a warning", () => {
    const v1 = message({ id: "msgv-1", name: "OrderCreated" });
    const v2 = message({ id: "msgv-2", name: "OrderCreated" });
    const { document, diagnostics } = assembleAsyncApi3(
      spec({
        channels: [ordersChannel],
        messages: [v2, v1],
        operations: [operation({ key: "send", channelRef: ordersChannel.id, messageRefs: [v1.id, v2.id] })],
      }),
    );
    expect(Object.keys(at(document, "components", "messages") as object)).toEqual(["OrderCreated", "OrderCreated_2"]);
    expect(diagnostics).toEqual([
      {
        severity: "warning",
        code: "NAME_DISAMBIGUATED",
        message: 'Name clash resolved with a numeric suffix: "OrderCreated_2"',
        pointer: "/components/messages/OrderCreated_2",
      },
    ]);
  });
});

describe("message schemas", () => {
  it("rejects a non-object headers schema and omits headers", () => {
    const msg = message({ id: "m", name: "M", headers: { format: "json-schema", schema: { type: "string" } } });
    const { document, diagnostics } = assembleAsyncApi3(
      spec({
        channels: [ordersChannel],
        messages: [msg],
        operations: [operation({ key: "o", channelRef: ordersChannel.id, messageRefs: ["m"] })],
      }),
    );
    expect(at(document, "components", "messages", "M", "headers")).toBeUndefined();
    expect(diagnostics.map((d) => [d.code, d.pointer])).toEqual([
      ["HEADERS_NOT_OBJECT_SCHEMA", "/components/messages/M/headers"],
    ]);
  });

  it("places an Avro key on Avro Kafka channels and a JSON Schema key on JSON Kafka channels", () => {
    const keys: SchemaArtifact[] = [
      { format: "avro", schema: { type: "string" } },
      { format: "json-schema", schema: { type: "string", format: "uuid" } },
    ];
    const jsonOrders = channel({ id: "ch-json", name: "orders-json", profile: { format: "json-schema" } });
    const msg = message({ id: "m", name: "M", keys, bindings: { kafka: { schemaIdLocation: "header" } } });
    const { document } = assembleAsyncApi3(
      spec({
        channels: [ordersChannel, jsonOrders],
        messages: [msg],
        operations: [
          operation({ key: "a", channelRef: ordersChannel.id, messageRefs: ["m"] }),
          operation({ key: "j", channelRef: jsonOrders.id, messageRefs: ["m"] }),
        ],
      }),
    );
    expect(at(document, "components", "messages", "M_avro", "bindings")).toEqual({
      kafka: { key: { type: "string" }, schemaIdLocation: "header" },
    });
    expect(at(document, "components", "messages", "M_json", "bindings")).toEqual({
      kafka: { key: { type: "string", format: "uuid" }, schemaIdLocation: "header" },
    });
  });

  it("does not place a key for non-Kafka channels, and reports a missing key format", () => {
    const pulsar = channel({ id: "ch-p", name: "p", protocol: "pulsar" });
    const keyed = message({ id: "m", name: "M", keys: [{ format: "json-schema", schema: { type: "string" } }] });
    const onPulsar = assembleAsyncApi3(
      spec({
        channels: [pulsar],
        messages: [keyed],
        operations: [operation({ key: "o", channelRef: pulsar.id, messageRefs: ["m"] })],
      }),
    );
    expect(at(onPulsar.document, "components", "messages", "M", "bindings")).toBeUndefined();
    expect(onPulsar.diagnostics).toEqual([]);

    const onKafkaAvro = assembleAsyncApi3(
      spec({
        channels: [ordersChannel],
        messages: [keyed],
        operations: [operation({ key: "o", channelRef: ordersChannel.id, messageRefs: ["m"] })],
      }),
    );
    expect(onKafkaAvro.diagnostics.map((d) => [d.code, d.pointer])).toEqual([
      ["KEY_ARTIFACT_MISSING", "/components/messages/M/bindings/kafka/key"],
    ]);
  });

  it("reports a missing payload rendering for the channel's format", () => {
    const protoChannel = channel({ id: "ch-proto", name: "proto", profile: { format: "protobuf" } });
    const msg = message({ id: "m", name: "M" });
    const { document, diagnostics } = assembleAsyncApi3(
      spec({
        channels: [protoChannel],
        messages: [msg],
        operations: [operation({ key: "o", channelRef: protoChannel.id, messageRefs: ["m"] })],
      }),
    );
    expect(at(document, "components", "messages", "M", "payload")).toBeUndefined();
    expect(diagnostics.map((d) => d.code)).toEqual(["PAYLOAD_ARTIFACT_MISSING"]);
  });

  it("down-converts a 2020-12 payload for a draft-07 channel and rebases its refs", () => {
    const jsonOrders = channel({
      id: "ch-json",
      name: "orders-json",
      profile: { format: "json-schema", dialect: "draft-07" },
    });
    const msg = message({
      id: "m",
      name: "M",
      payloads: [
        {
          format: "json-schema",
          dialect: "2020-12",
          schema: { type: "object", properties: { a: { $ref: "#/$defs/A" } }, $defs: { A: { type: "string" } } },
        },
      ],
    });
    const { document, diagnostics } = assembleAsyncApi3(
      spec({
        channels: [jsonOrders],
        messages: [msg],
        operations: [operation({ key: "o", channelRef: jsonOrders.id, messageRefs: ["m"] })],
      }),
    );
    expect(at(document, "components", "messages", "M", "payload")).toEqual({
      schemaFormat: "application/schema+json;version=draft-07",
      schema: {
        type: "object",
        properties: { a: { $ref: "#/components/messages/M/payload/schema/definitions/A" } },
        definitions: { A: { type: "string" } },
      },
    });
    expect(diagnostics).toEqual([]);
  });

  it("flags unpublished draft messages", () => {
    const msg = message({ id: "m", name: "M", unpublished: true });
    const { diagnostics } = assembleAsyncApi3(
      spec({
        channels: [ordersChannel],
        messages: [msg],
        operations: [operation({ key: "o", channelRef: ordersChannel.id, messageRefs: ["m"] })],
      }),
    );
    expect(diagnostics).toEqual([
      {
        severity: "info",
        code: "UNPUBLISHED_MESSAGE",
        message: 'Message "M" is an unpublished draft',
        pointer: "/components/messages/M",
      },
    ]);
  });
});

describe("operations, replies, channel parameters and components", () => {
  it("wires reply operations to the reply channel's messages", () => {
    const requests = channel({ id: "ch-req", name: "fraud-checks", profile: { format: "json-schema" } });
    const verdicts = channel({ id: "ch-res", name: "fraud-verdicts", profile: { format: "json-schema" } });
    const ask = message({ id: "msgv-ask", name: "FraudCheckRequested", payloads: [jsonObject("Ask")] });
    const verdict = message({ id: "msgv-verdict", name: "FraudVerdict", payloads: [jsonObject("Verdict")] });
    const { document, diagnostics } = assembleAsyncApi3(
      spec({
        channels: [requests, verdicts],
        messages: [ask, verdict],
        operations: [
          operation({
            key: "requestFraudCheck",
            channelRef: requests.id,
            messageRefs: [ask.id],
            reply: { channelRef: verdicts.id, messageRefs: [verdict.id] },
          }),
        ],
      }),
    );
    expect(at(document, "operations", "requestFraudCheck", "reply")).toEqual({
      channel: { $ref: "#/channels/fraud-verdicts" },
      messages: [{ $ref: "#/channels/fraud-verdicts/messages/FraudVerdict" }],
    });
    expect(at(document, "channels", "fraud-verdicts", "messages")).toEqual({
      FraudVerdict: { $ref: "#/components/messages/FraudVerdict" },
    });
    expect(diagnostics).toEqual([]);
  });

  it("requires a reply channel when reply messages are given", () => {
    const { document, diagnostics } = assembleAsyncApi3(
      spec({
        channels: [ordersChannel],
        messages: [{ ...orderCreatedV13, traitRefs: [] }],
        operations: [
          operation({
            key: "o",
            channelRef: ordersChannel.id,
            messageRefs: [],
            reply: { messageRefs: [orderCreatedV13.id] },
          }),
        ],
      }),
    );
    expect(at(document, "operations", "o", "reply")).toBeUndefined();
    expect(diagnostics.map((d) => [d.code, d.pointer])).toEqual([
      ["REPLY_CHANNEL_REQUIRED", "/operations/o/reply/messages"],
    ]);
  });

  it("emits channel parameters sorted by name", () => {
    const regional = channel({
      id: "ch-reg",
      name: "regional-orders",
      address: "orders.{region}.{tier}.v1",
      parameters: { tier: { enum: ["gold", "std"] }, region: { enum: ["eu", "us"], description: "Region code" } },
    });
    const msg = message({ id: "m", name: "M" });
    const { document } = assembleAsyncApi3(
      spec({
        channels: [regional],
        messages: [msg],
        operations: [operation({ key: "o", channelRef: regional.id, messageRefs: ["m"] })],
      }),
    );
    expect(at(document, "channels", "regional-orders")).toEqual({
      address: "orders.{region}.{tier}.v1",
      messages: { M: { $ref: "#/components/messages/M" } },
      parameters: { region: { enum: ["eu", "us"], description: "Region code" }, tier: { enum: ["gold", "std"] } },
    });
    expect(Object.keys(at(document, "channels", "regional-orders", "parameters") as object)).toEqual([
      "region",
      "tier",
    ]);
  });

  it("emits operation traits, operation bindings and local components", () => {
    const msg = message({ id: "m", name: "M" });
    const { document } = assembleAsyncApi3(
      spec({
        channels: [ordersChannel],
        messages: [msg],
        traits: [
          {
            id: "t-kafka",
            name: "KafkaConsumer",
            kind: "OPERATION",
            ownerSlug: "payments",
            spec: { bindings: { kafka: { groupId: { type: "string" } } } },
          },
        ],
        operations: [
          operation({
            key: "o",
            action: "receive",
            channelRef: ordersChannel.id,
            messageRefs: ["m"],
            traitRefs: ["t-kafka"],
            summary: "Consume",
          }),
        ],
        components: {
          correlationIds: { byCeId: { location: "$message.header#/ce_id" } },
          securitySchemes: { sasl: { type: "scramSha512" } },
        },
      }),
    );
    expect(at(document, "operations", "o")).toEqual({
      action: "receive",
      channel: { $ref: "#/channels/orders" },
      summary: "Consume",
      traits: [{ $ref: "#/components/operationTraits/KafkaConsumer" }],
      messages: [{ $ref: "#/channels/orders/messages/M" }],
    });
    expect(at(document, "components", "operationTraits")).toEqual({
      KafkaConsumer: { bindings: { kafka: { groupId: { type: "string" } } } },
    });
    expect(at(document, "components", "correlationIds")).toEqual({ byCeId: { location: "$message.header#/ce_id" } });
    expect(at(document, "components", "securitySchemes")).toEqual({ sasl: { type: "scramSha512" } });
  });

  it("maps a server externalRef to externalDocs.url", () => {
    const { document } = assembleAsyncApi3(
      spec({ servers: [{ key: "prod", host: "k:9092", protocol: "kafka", externalRef: "https://wiki/kafka-prod" }] }),
    );
    expect(at(document, "servers", "prod")).toEqual({
      host: "k:9092",
      protocol: "kafka",
      externalDocs: { url: "https://wiki/kafka-prod" },
    });
  });

  it("reports unknown references instead of throwing", () => {
    const { document, diagnostics } = assembleAsyncApi3(
      spec({
        channels: [ordersChannel],
        operations: [
          operation({ key: "a", channelRef: "ch-missing", messageRefs: [] }),
          operation({ key: "b", channelRef: ordersChannel.id, messageRefs: ["msg-missing"], traitRefs: ["t-missing"] }),
        ],
      }),
    );
    expect(diagnostics.map((d) => [d.code, d.pointer])).toEqual([
      ["UNKNOWN_CHANNEL_REF", "/operations/a/channel"],
      ["UNKNOWN_MESSAGE_REF", "/operations/b/messages/0"],
      ["UNKNOWN_TRAIT_REF", "/operations/b/traits/0"],
    ]);
    expect(Object.keys(at(document, "operations") as object)).toEqual(["b"]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/unit/lib/event-specs/assemble.test.ts`
Expected: FAIL — `Cannot find package '@/lib/event-specs/assemble'`.

- [ ] **Step 3: Implement** (`src/lib/event-specs/assemble.ts`)

```ts
import type {
  Diagnostic,
  FormatProfile,
  JsonObject,
  JsonValue,
  ResolvedChannel,
  ResolvedEventSpec,
  ResolvedMessage,
  ResolvedOperation,
  ResolvedTrait,
  TraitKind,
} from "./types";
import { compareStrings, diagnostic, normalizeDiagnostics } from "./diagnostics";
import { jsonPointer, localRef } from "./json-pointer";
import { formatSuffix, normalizeProfile, schemaFormatFor } from "./schema-format";
import { qualifyNames, type NameCandidate } from "./qualify";
import { headersSchema, kafkaKeyProfile, placeKafkaKey, selectArtifact } from "./message-schemas";

/**
 * Spec §7.2 steps 3–5: assemble an AsyncAPI 3.0.0 document from a
 * `ResolvedEventSpec`. Pure and deterministic: maps (servers, channels,
 * operations, components.*) are sorted by key; authored lists (operation
 * messages, trait lists) keep their order; the input is never mutated.
 * Problems never throw — they come back as diagnostics.
 */

export const ASYNCAPI_VERSION = "3.0.0";

export type AssemblyResult = { document: JsonObject; diagnostics: Diagnostic[] };

type MessageVariant = {
  key: string;
  message: ResolvedMessage;
  profile: FormatProfile;
  suffix: string;
  /** Used on at least one Kafka channel → carries `bindings.kafka.key`. */
  kafka: boolean;
};

/** Build an object with keys in the given order, dropping `undefined` values. */
function ordered(entries: Array<[string, JsonValue | undefined]>): JsonObject {
  const out: JsonObject = {};
  for (const [key, value] of entries) if (value !== undefined) out[key] = value;
  return out;
}

function sortedRecord(record: Record<string, JsonValue> | undefined): JsonObject | undefined {
  if (!record) return undefined;
  const keys = Object.keys(record).sort(compareStrings);
  if (keys.length === 0) return undefined;
  const out: JsonObject = {};
  for (const key of keys) out[key] = structuredClone(record[key]);
  return out;
}

function nonEmpty(obj: JsonObject): JsonObject | undefined {
  return Object.keys(obj).length > 0 ? obj : undefined;
}

function clone<T extends JsonValue>(value: T | undefined): T | undefined {
  return value === undefined ? undefined : structuredClone(value);
}

function ref(...segments: string[]): JsonObject {
  return { $ref: localRef(...segments) };
}

function indexById<T extends { id: string }>(items: T[], kind: string, diagnostics: Diagnostic[]): Map<string, T> {
  const map = new Map<string, T>();
  for (const item of items) {
    if (map.has(item.id)) {
      diagnostics.push(
        diagnostic("error", "DUPLICATE_ID", `Duplicate ${kind} id "${item.id}"; the first one is used`, ""),
      );
      continue;
    }
    map.set(item.id, item);
  }
  return map;
}

export function assembleAsyncApi3(spec: ResolvedEventSpec): AssemblyResult {
  const diagnostics: Diagnostic[] = [];
  const channelsById = indexById(spec.channels, "channel", diagnostics);
  const messagesById = indexById(spec.messages, "message", diagnostics);
  const traitsById = indexById(spec.traits, "trait", diagnostics);

  // ── 1. Walk operations: which channels, message variants and traits are used ──
  const operations = [...spec.operations].sort((a, b) => compareStrings(a.key, b.key));
  const usedChannels = new Map<string, ResolvedChannel>();
  const channelVariants = new Map<string, Set<string>>();
  const variants = new Map<string, MessageVariant>();
  const usedOperationTraits = new Map<string, ResolvedTrait>();
  const emitted: ResolvedOperation[] = [];
  const operationKeys = new Set<string>();

  const traitOfKind = (id: string, kind: TraitKind): ResolvedTrait | undefined => {
    const trait = traitsById.get(id);
    return trait && trait.kind === kind ? trait : undefined;
  };

  const takeMessage = (channel: ResolvedChannel, messageId: string, pointer: string): void => {
    const message = messagesById.get(messageId);
    if (!message) {
      diagnostics.push(
        diagnostic("error", "UNKNOWN_MESSAGE_REF", `Message "${messageId}" is not in the resolved spec`, pointer),
      );
      return;
    }
    const profile = normalizeProfile(channel.profile);
    const suffix = formatSuffix(profile);
    const key = `${message.id}|${suffix}`;
    const variant = variants.get(key) ?? { key, message, profile, suffix, kafka: false };
    if (channel.protocol === "kafka") variant.kafka = true;
    variants.set(key, variant);
    usedChannels.set(channel.id, channel);
    const set = channelVariants.get(channel.id) ?? new Set<string>();
    set.add(key);
    channelVariants.set(channel.id, set);
  };

  for (const op of operations) {
    const opPointer = jsonPointer("operations", op.key);
    if (operationKeys.has(op.key)) {
      diagnostics.push(
        diagnostic("error", "DUPLICATE_OPERATION_KEY", `Operation key "${op.key}" is used more than once`, opPointer),
      );
      continue;
    }
    operationKeys.add(op.key);
    const channel = channelsById.get(op.channelRef);
    if (!channel) {
      diagnostics.push(
        diagnostic(
          "error",
          "UNKNOWN_CHANNEL_REF",
          `Channel "${op.channelRef}" is not in the resolved spec`,
          `${opPointer}/channel`,
        ),
      );
      continue;
    }
    usedChannels.set(channel.id, channel);
    op.messageRefs.forEach((id, i) => takeMessage(channel, id, `${opPointer}/messages/${i}`));
    op.traitRefs.forEach((id, i) => {
      const trait = traitOfKind(id, "OPERATION");
      if (trait) usedOperationTraits.set(trait.id, trait);
      else
        diagnostics.push(
          diagnostic(
            "error",
            "UNKNOWN_TRAIT_REF",
            `Operation trait "${id}" is not in the resolved spec`,
            `${opPointer}/traits/${i}`,
          ),
        );
    });
    if (op.reply) {
      const replyMessages = op.reply.messageRefs ?? [];
      const replyChannel = op.reply.channelRef ? channelsById.get(op.reply.channelRef) : undefined;
      if (op.reply.channelRef && !replyChannel) {
        diagnostics.push(
          diagnostic(
            "error",
            "UNKNOWN_CHANNEL_REF",
            `Reply channel "${op.reply.channelRef}" is not in the resolved spec`,
            `${opPointer}/reply/channel`,
          ),
        );
      } else if (!op.reply.channelRef && replyMessages.length > 0) {
        diagnostics.push(
          diagnostic(
            "error",
            "REPLY_CHANNEL_REQUIRED",
            "Reply messages need a reply channel",
            `${opPointer}/reply/messages`,
          ),
        );
      }
      if (replyChannel) {
        usedChannels.set(replyChannel.id, replyChannel);
        replyMessages.forEach((id, i) => takeMessage(replyChannel, id, `${opPointer}/reply/messages/${i}`));
      }
    }
    emitted.push(op);
  }

  const usedMessageTraits = new Map<string, ResolvedTrait>();
  for (const variant of variants.values()) {
    for (const id of variant.message.traitRefs) {
      const trait = traitOfKind(id, "MESSAGE");
      if (trait) usedMessageTraits.set(trait.id, trait);
    }
  }

  // ── 2. Qualify names (spec §7.2 step 5) ──
  const disambiguationWarnings = (keys: string[], names: Map<string, string>, prefix: string[]): void => {
    for (const key of keys) {
      const name = names.get(key) as string;
      diagnostics.push(
        diagnostic(
          "warning",
          "NAME_DISAMBIGUATED",
          `Name clash resolved with a numeric suffix: "${name}"`,
          jsonPointer(...prefix, name),
        ),
      );
    }
  };

  const channelNames = qualifyNames(
    [...usedChannels.values()].map((c) => ({ key: c.id, name: c.name, owner: c.productSlug })),
    spec.productSlug,
  );
  disambiguationWarnings(channelNames.disambiguated, channelNames.names, ["channels"]);

  const variantCount = new Map<string, number>();
  for (const v of variants.values()) variantCount.set(v.message.id, (variantCount.get(v.message.id) ?? 0) + 1);
  const messageNames = qualifyNames(
    [...variants.values()].map(
      (v): NameCandidate => ({
        key: v.key,
        name: (variantCount.get(v.message.id) ?? 0) > 1 ? `${v.message.name}_${v.suffix}` : v.message.name,
        owner: v.message.productSlug,
      }),
    ),
    spec.productSlug,
  );
  disambiguationWarnings(messageNames.disambiguated, messageNames.names, ["components", "messages"]);

  const traitCandidates = (traits: Map<string, ResolvedTrait>): NameCandidate[] =>
    [...traits.values()].map((t) => ({ key: t.id, name: t.name, owner: t.ownerSlug }));
  const messageTraitNames = qualifyNames(traitCandidates(usedMessageTraits), spec.productSlug);
  disambiguationWarnings(messageTraitNames.disambiguated, messageTraitNames.names, ["components", "messageTraits"]);
  const operationTraitNames = qualifyNames(traitCandidates(usedOperationTraits), spec.productSlug);
  disambiguationWarnings(operationTraitNames.disambiguated, operationTraitNames.names, [
    "components",
    "operationTraits",
  ]);

  const channelKey = (id: string) => channelNames.names.get(id) as string;
  const messageKey = (variantKey: string) => messageNames.names.get(variantKey) as string;
  const variantOn = (channel: ResolvedChannel, messageId: string) => `${messageId}|${formatSuffix(channel.profile)}`;
  const byName = <T>(entries: Array<[string, T]>) => entries.sort((a, b) => compareStrings(a[0], b[0]));

  // ── 3. components.messages ──
  const componentMessages: JsonObject = {};
  for (const [name, variant] of byName(
    [...variants.values()].map((v): [string, MessageVariant] => [messageKey(v.key), v]),
  )) {
    const msg = variant.message;
    const base = ["components", "messages", name];

    const traitRefs: JsonObject[] = [];
    msg.traitRefs.forEach((id, i) => {
      const trait = traitOfKind(id, "MESSAGE");
      if (trait) traitRefs.push(ref("components", "messageTraits", messageTraitNames.names.get(trait.id) as string));
      else
        diagnostics.push(
          diagnostic(
            "error",
            "UNKNOWN_TRAIT_REF",
            `Message trait "${id}" is not in the resolved spec`,
            jsonPointer(...base, "traits", i),
          ),
        );
    });

    let headers: JsonObject | undefined;
    if (msg.headers) {
      const h = headersSchema(msg.headers, jsonPointer(...base, "headers"));
      diagnostics.push(...h.diagnostics);
      headers = h.schema;
    }

    const payloadSelection = selectArtifact(
      msg.payloads,
      variant.profile,
      "payload",
      jsonPointer(...base, "payload", "schema"),
    );
    diagnostics.push(...payloadSelection.diagnostics);
    const payload =
      payloadSelection.schema === undefined
        ? undefined
        : { schemaFormat: schemaFormatFor(variant.profile), schema: payloadSelection.schema };

    let bindings = clone(msg.bindings);
    if (variant.kafka && msg.keys && msg.keys.length > 0) {
      const keyPointer = jsonPointer(...base, "bindings", "kafka", "key");
      const keySelection = selectArtifact(msg.keys, kafkaKeyProfile(variant.profile), "key", keyPointer);
      diagnostics.push(...keySelection.diagnostics);
      if (keySelection.schema !== undefined) {
        const placed = placeKafkaKey(bindings, keySelection.schema);
        bindings = placed.bindings;
        if (placed.overridden) {
          diagnostics.push(
            diagnostic(
              "warning",
              "KEY_BINDING_OVERRIDDEN",
              "bindings.kafka.key was replaced by the pinned key schema",
              keyPointer,
            ),
          );
        }
      }
    }

    if (msg.unpublished) {
      diagnostics.push(
        diagnostic(
          "info",
          "UNPUBLISHED_MESSAGE",
          `Message "${msg.name}" is an unpublished draft`,
          jsonPointer(...base),
        ),
      );
    }

    componentMessages[name] = ordered([
      ["name", name !== msg.name ? msg.name : undefined],
      ["title", msg.title],
      ["summary", msg.summary],
      ["description", msg.description],
      ["contentType", msg.contentType],
      ["correlationId", clone(msg.correlationId)],
      ["traits", traitRefs.length > 0 ? traitRefs : undefined],
      ["headers", headers],
      ["payload", payload],
      ["tags", clone(msg.tags)],
      ["externalDocs", clone(msg.externalDocs)],
      ["bindings", bindings],
      ["examples", clone(msg.examples)],
    ]);
  }

  // ── 4. components.messageTraits / operationTraits ──
  const componentMessageTraits: JsonObject = {};
  for (const [name, trait] of byName(
    [...usedMessageTraits.values()].map((t): [string, ResolvedTrait] => [
      messageTraitNames.names.get(t.id) as string,
      t,
    ]),
  )) {
    if (!trait.headers) {
      componentMessageTraits[name] = structuredClone(trait.spec);
      continue;
    }
    const h = headersSchema(trait.headers, jsonPointer("components", "messageTraits", name, "headers"));
    diagnostics.push(...h.diagnostics);
    const rest = Object.entries(trait.spec).filter(([k]) => k !== "headers");
    componentMessageTraits[name] = ordered([
      ["headers", h.schema],
      ...rest.map(([k, v]): [string, JsonValue] => [k, structuredClone(v)]),
    ]);
  }
  const componentOperationTraits: JsonObject = {};
  for (const [name, trait] of byName(
    [...usedOperationTraits.values()].map((t): [string, ResolvedTrait] => [
      operationTraitNames.names.get(t.id) as string,
      t,
    ]),
  )) {
    componentOperationTraits[name] = structuredClone(trait.spec);
  }

  // ── 5. channels ──
  const channels: JsonObject = {};
  for (const [name, channel] of byName(
    [...usedChannels.values()].map((c): [string, ResolvedChannel] => [channelKey(c.id), c]),
  )) {
    const messages: JsonObject = {};
    const keys = [...(channelVariants.get(channel.id) ?? [])].map(messageKey).sort(compareStrings);
    for (const key of keys) messages[key] = ref("components", "messages", key);
    channels[name] = ordered([
      ["address", channel.address],
      ["messages", nonEmpty(messages)],
      ["title", channel.title],
      ["summary", channel.summary],
      ["description", channel.description],
      ["parameters", sortedRecord(channel.parameters)],
      ["tags", clone(channel.tags)],
      ["externalDocs", clone(channel.externalDocs)],
      ["bindings", clone(channel.bindings)],
    ]);
  }

  // ── 6. operations ──
  const operationsOut: JsonObject = {};
  for (const op of emitted) {
    const channel = channelsById.get(op.channelRef) as ResolvedChannel;
    const cKey = channelKey(channel.id);
    const messageRefs = op.messageRefs
      .filter((id) => messagesById.has(id))
      .map((id) => ref("channels", cKey, "messages", messageKey(variantOn(channel, id))));
    const traitRefs = op.traitRefs
      .filter((id) => usedOperationTraits.has(id))
      .map((id) => ref("components", "operationTraits", operationTraitNames.names.get(id) as string));

    let reply: JsonObject | undefined;
    if (op.reply) {
      const replyChannel = op.reply.channelRef ? channelsById.get(op.reply.channelRef) : undefined;
      const rKey = replyChannel ? channelKey(replyChannel.id) : undefined;
      const replyMessages =
        replyChannel && rKey
          ? (op.reply.messageRefs ?? [])
              .filter((id) => messagesById.has(id))
              .map((id) => ref("channels", rKey, "messages", messageKey(variantOn(replyChannel, id))))
          : [];
      reply = nonEmpty(
        ordered([
          ["channel", rKey ? ref("channels", rKey) : undefined],
          ["messages", replyMessages.length > 0 ? replyMessages : undefined],
        ]),
      );
    }

    operationsOut[op.key] = ordered([
      ["action", op.action],
      ["channel", ref("channels", cKey)],
      ["summary", op.summary],
      ["description", op.description],
      ["bindings", clone(op.bindings)],
      ["traits", traitRefs.length > 0 ? traitRefs : undefined],
      ["messages", messageRefs.length > 0 ? messageRefs : undefined],
      ["reply", reply],
    ]);
  }

  // ── 7. servers ──
  const servers: JsonObject = {};
  for (const server of [...spec.servers].sort((a, b) => compareStrings(a.key, b.key))) {
    if (Object.prototype.hasOwnProperty.call(servers, server.key)) {
      diagnostics.push(
        diagnostic(
          "error",
          "DUPLICATE_SERVER_KEY",
          `Server key "${server.key}" is used more than once`,
          jsonPointer("servers", server.key),
        ),
      );
      continue;
    }
    servers[server.key] = ordered([
      ["host", server.host],
      ["protocol", server.protocol],
      ["protocolVersion", server.protocolVersion],
      ["pathname", server.pathname],
      ["description", server.description],
      ["externalDocs", server.externalRef ? { url: server.externalRef } : undefined],
    ]);
  }

  // ── 8. document ──
  const components = ordered([
    ["messages", nonEmpty(componentMessages)],
    ["messageTraits", nonEmpty(componentMessageTraits)],
    ["operationTraits", nonEmpty(componentOperationTraits)],
    ["parameters", sortedRecord(spec.components.parameters)],
    ["correlationIds", sortedRecord(spec.components.correlationIds)],
    ["securitySchemes", sortedRecord(spec.components.securitySchemes)],
    ["operationBindings", sortedRecord(spec.components.operationBindings)],
  ]);

  const document = ordered([
    ["asyncapi", ASYNCAPI_VERSION],
    [
      "info",
      ordered([
        ["title", spec.info.title],
        ["version", spec.info.version],
        ["description", spec.info.description],
        ["contact", clone(spec.info.contact)],
        ["license", clone(spec.info.license)],
        ["tags", clone(spec.info.tags)],
        ["externalDocs", clone(spec.info.externalDocs)],
      ]),
    ],
    ["servers", nonEmpty(servers)],
    ["defaultContentType", spec.defaultContentType],
    ["channels", nonEmpty(channels)],
    ["operations", nonEmpty(operationsOut)],
    ["components", nonEmpty(components)],
  ]);

  return { document, diagnostics: normalizeDiagnostics(diagnostics) };
}
```

- [ ] **Step 4: Run tests — expect PASS**

Run: `npx vitest run tests/unit/lib/event-specs/assemble.test.ts`
Expected: PASS — 1 file, 19 tests.
Run: `npx tsc --noEmit` — Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/lib/event-specs/assemble.ts tests/unit/lib/event-specs/assemble.test.ts
git commit -m "feat(18.4): assemble AsyncAPI 3.0.0 documents from resolved event specs"
```

---

### Task 9: YAML + JSON serialization (Story 18.4, spec §7.2 step 7)

**Files:**
- Create: `src/lib/event-specs/serialize.ts`
- Test: `tests/unit/lib/event-specs/serialize.test.ts`

**Interfaces:**
- Consumes: `JsonObject` (Task 1); `stringify` from `yaml`.
- Produces: `toJson(document: JsonObject): string` (2-space indent, trailing newline); `toYaml(document: JsonObject): string` (`aliasDuplicateObjects: false`, `lineWidth: 0`, `singleQuote: true`).

- [ ] **Step 1: Write the failing test** (`tests/unit/lib/event-specs/serialize.test.ts`)

```ts
import { describe, it, expect } from "vitest";
import { parse } from "yaml";
import { toJson, toYaml } from "@/lib/event-specs/serialize";
import type { JsonObject } from "@/lib/event-specs/types";

describe("serialize", () => {
  it("writes 2-space JSON with a trailing newline, preserving key order", () => {
    expect(toJson({ b: 1, a: { d: true, c: null } })).toBe(
      '{\n  "b": 1,\n  "a": {\n    "d": true,\n    "c": null\n  }\n}\n',
    );
  });

  it("writes YAML with single quotes, no anchors and no line folding", () => {
    const shared: JsonObject = { type: "string" };
    const long = "x".repeat(120);
    const doc: JsonObject = {
      info: { version: "2.0", description: long },
      a: { $ref: "#/components/messages/M" },
      k1: shared,
      k2: shared,
    };
    const yaml = toYaml(doc);
    expect(yaml).toBe(
      [
        "info:",
        "  version: '2.0'",
        `  description: ${long}`,
        "a:",
        "  $ref: '#/components/messages/M'",
        "k1:",
        "  type: string",
        "k2:",
        "  type: string",
        "",
      ].join("\n"),
    );
    expect(yaml).not.toContain("&");
    expect(parse(yaml)).toEqual(doc);
  });

  it("renders .proto payload text as a literal block that round-trips", () => {
    const proto = 'syntax = "proto3";\n\n// @RootNode\nmessage Order {\n  string id = 1;\n}\n';
    const yaml = toYaml({ schema: proto });
    expect(yaml.startsWith("schema: |")).toBe(true);
    expect(parse(yaml)).toEqual({ schema: proto });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/unit/lib/event-specs/serialize.test.ts`
Expected: FAIL — `Cannot find package '@/lib/event-specs/serialize'`.

- [ ] **Step 3: Implement** (`src/lib/event-specs/serialize.ts`)

```ts
import { stringify } from "yaml";
import type { JsonObject } from "./types";

/**
 * Spec §7.2 step 7. Key order is whatever the assembler built (canonical
 * AsyncAPI order, maps sorted) — the serializers never reorder, so output is
 * byte-stable for equal input.
 */

export function toJson(document: JsonObject): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}

export function toYaml(document: JsonObject): string {
  return stringify(document, {
    aliasDuplicateObjects: false, // never emit &anchors / *aliases for repeated schemas
    lineWidth: 0, // never fold long descriptions
    singleQuote: true, // '2.0', '#/components/...' — matches spec §6.2
  });
}
```

- [ ] **Step 4: Run tests — expect PASS**

Run: `npx vitest run tests/unit/lib/event-specs/serialize.test.ts`
Expected: PASS — 1 file, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/event-specs/serialize.ts tests/unit/lib/event-specs/serialize.test.ts
git commit -m "feat(18.4): stable YAML and JSON serialization for event spec documents"
```

---

### Task 10: `EventSpecValidator` interface + structural validator (Stories 18.4 / 18.5 seam, spec §7.2 step 6)

**Files:**
- Create: `src/lib/event-specs/validator.ts`
- Test: `tests/unit/lib/event-specs/validator.test.ts`

**Interfaces:**
- Consumes: `Diagnostic` (Task 1); `diagnostic`, `normalizeDiagnostics` (Task 1); `jsonPointer`, `parseLocalRef`, `resolveLocalRef` (Task 1); `SPEC_6_2_CHECKOUT_YAML` (Task 7).
- Produces: `interface EventSpecValidator { readonly name: string; validate(document: object): Promise<Result<Diagnostic[]>> }`; `class StructuralAsyncApi3Validator implements EventSpecValidator` (`name = "structural"`); `validateAsyncApi3Structure(document: object): Diagnostic[]`.
- Checks and codes: `REQUIRED_FIELD` (asyncapi, info.title, info.version, server host/protocol, operation action/channel), `UNSUPPORTED_ASYNCAPI_VERSION`, `REMOTE_REF`, `UNRESOLVED_REF` (every `$ref` in the document), `INVALID_ACTION`, `OPERATION_CHANNEL_REF`, `OPERATION_MESSAGE_NOT_IN_CHANNEL`, `REPLY_MESSAGE_NOT_IN_CHANNEL`, `CHANNEL_PARAMETER_MISSING` (error), `CHANNEL_PARAMETER_UNUSED` (warning), `COMPONENT_KEY_INVALID` (`^[a-zA-Z0-9.\-_]+$`), `HEADERS_NOT_OBJECT_SCHEMA` (messages, message traits, inline channel messages; follows `$ref` and multi-format wrappers).
- **Fit for Story 18.5:** the parser-backed validator implements the same interface; it maps each parser diagnostic's `path: (string | number)[]` with `jsonPointer(...path)` and severity `0 → error`, `1 → warning`, `2 | 3 → info`, and returns `err(...)` only if the parser itself cannot run.

- [ ] **Step 1: Write the failing test** (`tests/unit/lib/event-specs/validator.test.ts`)

```ts
import { describe, it, expect } from "vitest";
import { parse } from "yaml";
import { StructuralAsyncApi3Validator, validateAsyncApi3Structure } from "@/lib/event-specs/validator";
import type { JsonObject } from "@/lib/event-specs/types";
import { SPEC_6_2_CHECKOUT_YAML } from "./fixtures/worked-example";

const valid = (): JsonObject => parse(SPEC_6_2_CHECKOUT_YAML) as JsonObject;
const codes = (doc: object) => validateAsyncApi3Structure(doc).map((d) => [d.severity, d.code, d.pointer]);

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests poke at arbitrary document paths
type LooseDoc = any;

/** Apply a mutation to a fresh copy of the §6.2 document. */
function mutate(fn: (doc: LooseDoc) => void): JsonObject {
  const doc = valid();
  fn(doc);
  return doc;
}

describe("validateAsyncApi3Structure", () => {
  it("accepts the spec §6.2 document", () => {
    expect(validateAsyncApi3Structure(valid())).toEqual([]);
  });

  it("requires asyncapi 3.0.0, info.title and info.version", () => {
    expect(codes({ info: {} })).toEqual([
      ["error", "REQUIRED_FIELD", "/asyncapi"],
      ["error", "REQUIRED_FIELD", "/info/title"],
      ["error", "REQUIRED_FIELD", "/info/version"],
    ]);
    expect(codes(mutate((d) => (d.asyncapi = "2.6.0")))).toEqual([
      ["error", "UNSUPPORTED_ASYNCAPI_VERSION", "/asyncapi"],
    ]);
  });

  it("requires server host and protocol", () => {
    expect(codes(mutate((d) => delete d.servers["kafka-prod"].host))).toEqual([
      ["error", "REQUIRED_FIELD", "/servers/kafka-prod/host"],
    ]);
  });

  it("flags unresolved and remote $refs", () => {
    expect(codes(mutate((d) => (d.channels.orders.messages.OrderCreated.$ref = "#/components/messages/Nope")))).toEqual(
      [["error", "UNRESOLVED_REF", "/channels/orders/messages/OrderCreated"]],
    );
    expect(
      codes(mutate((d) => (d.components.messages.OrderCreated.traits[0].$ref = "https://evil.example/trait.yaml"))),
    ).toEqual([["error", "REMOTE_REF", "/components/messages/OrderCreated/traits/0"]]);
  });

  it("checks operation → channel → message consistency", () => {
    expect(codes(mutate((d) => (d.operations.publishOrderCreated.action = "publish")))).toEqual([
      ["error", "INVALID_ACTION", "/operations/publishOrderCreated/action"],
    ]);
    expect(
      codes(mutate((d) => (d.operations.publishOrderCreated.channel = { $ref: "#/components/messages/OrderCreated" }))),
    ).toEqual([["error", "OPERATION_CHANNEL_REF", "/operations/publishOrderCreated/channel"]]);
    expect(
      codes(
        mutate((d) => (d.operations.publishOrderCreated.messages = [{ $ref: "#/components/messages/OrderCreated" }])),
      ),
    ).toEqual([["error", "OPERATION_MESSAGE_NOT_IN_CHANNEL", "/operations/publishOrderCreated/messages/0"]]);
    expect(codes(mutate((d) => delete d.operations.publishOrderCreated.channel))).toEqual([
      ["error", "REQUIRED_FIELD", "/operations/publishOrderCreated/channel"],
    ]);
  });

  it("checks reply messages belong to the reply channel", () => {
    const doc = mutate((d) => {
      d.channels.verdicts = { address: "v", messages: { V: { $ref: "#/components/messages/OrderCreated" } } };
      d.operations.publishOrderCreated.reply = {
        channel: { $ref: "#/channels/verdicts" },
        messages: [{ $ref: "#/channels/verdicts/messages/V" }, { $ref: "#/channels/orders/messages/OrderCreated" }],
      };
    });
    expect(codes(doc)).toEqual([
      ["error", "REPLY_MESSAGE_NOT_IN_CHANNEL", "/operations/publishOrderCreated/reply/messages/1"],
    ]);
  });

  it("checks address parameters against declared parameters", () => {
    const doc = mutate((d) => {
      d.channels.orders.address = "payments.{region}.orders.v1";
      d.channels.orders.parameters = { tier: { enum: ["gold"] } };
    });
    expect(codes(doc)).toEqual([
      ["error", "CHANNEL_PARAMETER_MISSING", "/channels/orders/address"],
      ["warning", "CHANNEL_PARAMETER_UNUSED", "/channels/orders/parameters/tier"],
    ]);
  });

  it("requires object headers on messages and message traits", () => {
    expect(codes(mutate((d) => (d.components.messageTraits.CloudEvents.headers = { type: "string" })))).toEqual([
      ["error", "HEADERS_NOT_OBJECT_SCHEMA", "/components/messageTraits/CloudEvents/headers"],
    ]);
    expect(
      codes(
        mutate(
          (d) =>
            (d.components.messages.OrderCreated.headers = {
              schemaFormat: "application/vnd.apache.avro+json;version=1.9.0",
              schema: { type: "record" },
            }),
        ),
      ),
    ).toEqual([["error", "HEADERS_NOT_OBJECT_SCHEMA", "/components/messages/OrderCreated/headers"]]);
  });

  it("rejects component keys AsyncAPI does not allow", () => {
    const doc = mutate((d) => (d.components.securitySchemes = { "bad key": { type: "plain" } }));
    expect(codes(doc)).toEqual([["error", "COMPONENT_KEY_INVALID", "/components/securitySchemes/bad key"]]);
  });

  it("is usable through the EventSpecValidator interface", async () => {
    const validator = new StructuralAsyncApi3Validator();
    expect(validator.name).toBe("structural");
    expect(await validator.validate(valid())).toEqual({ success: true, data: [] });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/unit/lib/event-specs/validator.test.ts`
Expected: FAIL — `Cannot find package '@/lib/event-specs/validator'`.

- [ ] **Step 3: Implement** (`src/lib/event-specs/validator.ts`)

```ts
import { ok, type Result } from "@/types/result";
import type { Diagnostic } from "./types";
import { diagnostic, normalizeDiagnostics } from "./diagnostics";
import { jsonPointer, parseLocalRef, resolveLocalRef } from "./json-pointer";

/**
 * Pluggable document validation (spec §7.1 `validate`, §7.2 step 6).
 *
 * `StructuralAsyncApi3Validator` is the built-in, dependency-free check. The
 * `@asyncapi/parser`-backed validator (Story 18.5, registry-blocked) will be a
 * second `EventSpecValidator` passed to `AsyncApi3Adapter`; it maps parser
 * diagnostics (`path: (string|number)[]`, severity 0–3) onto `Diagnostic`.
 */
export interface EventSpecValidator {
  /** Stable identifier, e.g. "structural" or "asyncapi-parser". */
  readonly name: string;
  /** Never throws; an infrastructure failure is an `err` Result, document problems are diagnostics. */
  validate(document: object): Promise<Result<Diagnostic[]>>;
}

export class StructuralAsyncApi3Validator implements EventSpecValidator {
  readonly name = "structural";

  async validate(document: object): Promise<Result<Diagnostic[]>> {
    return ok(validateAsyncApi3Structure(document));
  }
}

type Obj = Record<string, unknown>;

const isObject = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const isNonEmptyString = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;

/** AsyncAPI 3 components map keys. */
const COMPONENT_KEY = /^[a-zA-Z0-9.\-_]+$/;
const COMPONENT_MAPS = [
  "schemas",
  "servers",
  "channels",
  "operations",
  "messages",
  "securitySchemes",
  "serverVariables",
  "parameters",
  "correlationIds",
  "replies",
  "replyAddresses",
  "externalDocs",
  "tags",
  "operationTraits",
  "messageTraits",
  "serverBindings",
  "channelBindings",
  "operationBindings",
  "messageBindings",
];

function entries(value: unknown): Array<[string, unknown]> {
  return isObject(value) ? Object.entries(value) : [];
}

function addressParameters(address: unknown): string[] {
  if (typeof address !== "string") return [];
  return [...address.matchAll(/\{([^{}]+)\}/g)].map((m) => m[1]);
}

/** Every `$ref` must be local and resolve inside the document. */
function checkRefs(root: Obj, node: unknown, path: Array<string | number>, out: Diagnostic[]): void {
  if (Array.isArray(node)) {
    node.forEach((item, i) => checkRefs(root, item, [...path, i], out));
    return;
  }
  if (!isObject(node)) return;
  const refValue = node.$ref;
  if (typeof refValue === "string") {
    const pointer = jsonPointer(...path);
    if (!refValue.startsWith("#")) {
      out.push(diagnostic("error", "REMOTE_REF", `Only local references are allowed, got "${refValue}"`, pointer));
    } else if (!resolveLocalRef(root, refValue).found) {
      out.push(
        diagnostic("error", "UNRESOLVED_REF", `Reference "${refValue}" does not resolve in this document`, pointer),
      );
    }
  }
  for (const [key, value] of Object.entries(node)) {
    if (key !== "$ref") checkRefs(root, value, [...path, key], out);
  }
}

function checkRoot(doc: Obj, out: Diagnostic[]): void {
  if (doc.asyncapi === undefined) {
    out.push(diagnostic("error", "REQUIRED_FIELD", "asyncapi is required", "/asyncapi"));
  } else if (doc.asyncapi !== "3.0.0") {
    out.push(
      diagnostic(
        "error",
        "UNSUPPORTED_ASYNCAPI_VERSION",
        `Expected asyncapi 3.0.0, got ${JSON.stringify(doc.asyncapi)}`,
        "/asyncapi",
      ),
    );
  }
  if (!isObject(doc.info)) {
    out.push(diagnostic("error", "REQUIRED_FIELD", "info is required", "/info"));
    return;
  }
  if (!isNonEmptyString(doc.info.title))
    out.push(diagnostic("error", "REQUIRED_FIELD", "info.title is required", "/info/title"));
  if (!isNonEmptyString(doc.info.version))
    out.push(diagnostic("error", "REQUIRED_FIELD", "info.version is required", "/info/version"));
}

function checkServers(doc: Obj, out: Diagnostic[]): void {
  for (const [key, server] of entries(doc.servers)) {
    if (!isObject(server)) continue;
    for (const field of ["host", "protocol"]) {
      if (!isNonEmptyString(server[field])) {
        out.push(
          diagnostic(
            "error",
            "REQUIRED_FIELD",
            `servers.${key}.${field} is required`,
            jsonPointer("servers", key, field),
          ),
        );
      }
    }
  }
}

function checkChannels(doc: Obj, out: Diagnostic[]): void {
  for (const [key, channel] of entries(doc.channels)) {
    if (!isObject(channel)) continue;
    const inAddress = addressParameters(channel.address);
    const declared = entries(channel.parameters).map(([name]) => name);
    for (const name of inAddress) {
      if (!declared.includes(name)) {
        out.push(
          diagnostic(
            "error",
            "CHANNEL_PARAMETER_MISSING",
            `Address parameter "{${name}}" has no entry in parameters`,
            jsonPointer("channels", key, "address"),
          ),
        );
      }
    }
    for (const name of declared) {
      if (!inAddress.includes(name)) {
        out.push(
          diagnostic(
            "warning",
            "CHANNEL_PARAMETER_UNUSED",
            `Parameter "${name}" does not appear in the channel address`,
            jsonPointer("channels", key, "parameters", name),
          ),
        );
      }
    }
  }
}

/** `#/channels/<key>` → `<key>`; anything else → null. */
function channelKeyOf(value: unknown): string | null {
  if (!isObject(value) || typeof value.$ref !== "string") return null;
  const segments = parseLocalRef(value.$ref);
  return segments && segments.length === 2 && segments[0] === "channels" ? segments[1] : null;
}

/** True when `value` is `{ $ref: "#/channels/<channelKey>/messages/<name>" }`. */
function isChannelMessageRef(value: unknown, channelKey: string): boolean {
  if (!isObject(value) || typeof value.$ref !== "string") return false;
  const segments = parseLocalRef(value.$ref);
  return (
    !!segments &&
    segments.length === 4 &&
    segments[0] === "channels" &&
    segments[1] === channelKey &&
    segments[2] === "messages"
  );
}

function checkOperations(doc: Obj, out: Diagnostic[]): void {
  for (const [key, op] of entries(doc.operations)) {
    if (!isObject(op)) continue;
    if (op.action === undefined) {
      out.push(
        diagnostic(
          "error",
          "REQUIRED_FIELD",
          `operations.${key}.action is required`,
          jsonPointer("operations", key, "action"),
        ),
      );
    } else if (op.action !== "send" && op.action !== "receive") {
      out.push(
        diagnostic(
          "error",
          "INVALID_ACTION",
          `action must be "send" or "receive"`,
          jsonPointer("operations", key, "action"),
        ),
      );
    }

    let channelKey: string | null = null;
    if (op.channel === undefined) {
      out.push(
        diagnostic(
          "error",
          "REQUIRED_FIELD",
          `operations.${key}.channel is required`,
          jsonPointer("operations", key, "channel"),
        ),
      );
    } else {
      channelKey = channelKeyOf(op.channel);
      if (channelKey === null) {
        out.push(
          diagnostic(
            "error",
            "OPERATION_CHANNEL_REF",
            "channel must be a $ref to #/channels/<key>",
            jsonPointer("operations", key, "channel"),
          ),
        );
      }
    }

    if (Array.isArray(op.messages) && channelKey !== null) {
      op.messages.forEach((message, i) => {
        if (!isChannelMessageRef(message, channelKey as string)) {
          out.push(
            diagnostic(
              "error",
              "OPERATION_MESSAGE_NOT_IN_CHANNEL",
              `Operation messages must reference #/channels/${channelKey}/messages/<name>`,
              jsonPointer("operations", key, "messages", i),
            ),
          );
        }
      });
    }

    if (isObject(op.reply)) {
      const replyKey = op.reply.channel === undefined ? null : channelKeyOf(op.reply.channel);
      if (op.reply.channel !== undefined && replyKey === null) {
        out.push(
          diagnostic(
            "error",
            "OPERATION_CHANNEL_REF",
            "reply.channel must be a $ref to #/channels/<key>",
            jsonPointer("operations", key, "reply", "channel"),
          ),
        );
      }
      if (Array.isArray(op.reply.messages)) {
        op.reply.messages.forEach((message, i) => {
          if (replyKey === null || !isChannelMessageRef(message, replyKey)) {
            out.push(
              diagnostic(
                "error",
                "REPLY_MESSAGE_NOT_IN_CHANNEL",
                "Reply messages must reference messages of the reply channel",
                jsonPointer("operations", key, "reply", "messages", i),
              ),
            );
          }
        });
      }
    }
  }
}

/** Headers (inline, `$ref` or multi-format) must be an object schema. */
function checkHeaders(root: Obj, headers: unknown, pointer: string, out: Diagnostic[]): void {
  if (headers === undefined) return;
  let target: unknown = headers;
  if (isObject(headers) && typeof headers.$ref === "string") {
    const resolved = resolveLocalRef(root, headers.$ref);
    if (!resolved.found) return; // reported as UNRESOLVED_REF
    target = resolved.value;
  }
  const schema = isObject(target) && "schemaFormat" in target && "schema" in target ? target.schema : target;
  if (!isObject(schema) || schema.type !== "object") {
    out.push(diagnostic("error", "HEADERS_NOT_OBJECT_SCHEMA", "headers must be a schema of type object", pointer));
  }
}

function checkComponents(doc: Obj, out: Diagnostic[]): void {
  const components = isObject(doc.components) ? doc.components : {};
  for (const map of COMPONENT_MAPS) {
    for (const [key] of entries(components[map])) {
      if (!COMPONENT_KEY.test(key)) {
        out.push(
          diagnostic(
            "error",
            "COMPONENT_KEY_INVALID",
            `Component key "${key}" must match ${COMPONENT_KEY.source}`,
            jsonPointer("components", map, key),
          ),
        );
      }
    }
  }
  for (const [key, message] of entries(components.messages)) {
    if (isObject(message))
      checkHeaders(doc, message.headers, jsonPointer("components", "messages", key, "headers"), out);
  }
  for (const [key, trait] of entries(components.messageTraits)) {
    if (isObject(trait))
      checkHeaders(doc, trait.headers, jsonPointer("components", "messageTraits", key, "headers"), out);
  }
  for (const [channelKey, channel] of entries(doc.channels)) {
    if (!isObject(channel)) continue;
    for (const [name, message] of entries(channel.messages)) {
      if (isObject(message) && typeof message.$ref !== "string") {
        checkHeaders(doc, message.headers, jsonPointer("channels", channelKey, "messages", name, "headers"), out);
      }
    }
  }
}

/** Pure, synchronous structural check of an AsyncAPI 3.0.0 document. */
export function validateAsyncApi3Structure(document: object): Diagnostic[] {
  const doc = document as Obj;
  const out: Diagnostic[] = [];
  checkRoot(doc, out);
  checkRefs(doc, doc, [], out);
  checkServers(doc, out);
  checkChannels(doc, out);
  checkOperations(doc, out);
  checkComponents(doc, out);
  return normalizeDiagnostics(out);
}
```

- [ ] **Step 4: Run tests — expect PASS**

Run: `npx vitest run tests/unit/lib/event-specs/validator.test.ts`
Expected: PASS — 1 file, 10 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/event-specs/validator.ts tests/unit/lib/event-specs/validator.test.ts
git commit -m "feat(18.4): pluggable EventSpecValidator with built-in structural AsyncAPI 3 checks"
```

---

### Task 11: `EventSpecAdapter` + `AsyncApi3Adapter` + barrel (Story 18.4, spec §7.1)

**Files:**
- Create: `src/lib/event-specs/adapter.ts`
- Create: `src/lib/event-specs/index.ts`
- Test: `tests/unit/lib/event-specs/adapter.test.ts`

**Interfaces:**
- Consumes: `assembleAsyncApi3` (Task 8); `toJson`, `toYaml` (Task 9); `StructuralAsyncApi3Validator`, `EventSpecValidator` (Task 10); `normalizeDiagnostics` (Task 1); `EmitOutput`, `ImportedEventSpec`, `ResolvedEventSpec`, `Diagnostic` (Task 1).
- Produces:
  ```ts
  interface EventSpecAdapter {
    readonly specType: string;                                       // "asyncapi@3.0"
    emit(input: ResolvedEventSpec): Promise<Result<EmitOutput>>;     // EmitOutput = { document, json, yaml, diagnostics }
    validate(document: object): Promise<Result<Diagnostic[]>>;
    import(content: string): Promise<Result<ImportedEventSpec>>;     // NOT_IMPLEMENTED for now
  }
  ```
  `ASYNCAPI_3_SPEC_TYPE = "asyncapi@3.0"`; `type AsyncApi3AdapterOptions = { validators?: EventSpecValidator[] }`; `class AsyncApi3Adapter implements EventSpecAdapter`; `getEventSpecAdapter(specType, options?): Result<EventSpecAdapter>` (error `UNSUPPORTED_SPEC_TYPE`). Adapter errors: `VALIDATOR_FAILED` (a validator threw), a validator's own `err` passed through, `NOT_IMPLEMENTED` (import).
- `index.ts` re-exports the public API of every module in this phase.

- [ ] **Step 1: Write the failing test** (`tests/unit/lib/event-specs/adapter.test.ts`)

```ts
import { describe, it, expect } from "vitest";
import { parse } from "yaml";
import { ok, err, type Result } from "@/types/result";
import { AsyncApi3Adapter, getEventSpecAdapter } from "@/lib/event-specs/adapter";
import type { EventSpecValidator } from "@/lib/event-specs/validator";
import type { Diagnostic } from "@/lib/event-specs/types";
import { checkoutServiceSpec } from "./fixtures/worked-example";
import { message, operation, spec } from "./fixtures/builders";

/** Stand-in for the Story 18.5 @asyncapi/parser validator: same interface, canned output. */
class FakeParserValidator implements EventSpecValidator {
  readonly name = "asyncapi-parser";
  constructor(private readonly result: Result<Diagnostic[]> | Error) {}
  async validate(): Promise<Result<Diagnostic[]>> {
    if (this.result instanceof Error) throw this.result;
    return this.result;
  }
}

describe("AsyncApi3Adapter", () => {
  it("has specType asyncapi@3.0 and is returned by getEventSpecAdapter", () => {
    const res = getEventSpecAdapter("asyncapi@3.0");
    expect(res.success && res.data.specType).toBe("asyncapi@3.0");
    const unknown = getEventSpecAdapter("openapi@3.1");
    expect(unknown.success).toBe(false);
    if (!unknown.success) expect(unknown.error.code).toBe("UNSUPPORTED_SPEC_TYPE");
  });

  it("emit returns the document plus JSON and YAML that parse back to it", async () => {
    const res = await new AsyncApi3Adapter().emit(checkoutServiceSpec);
    expect(res.success).toBe(true);
    if (!res.success) return;
    expect(res.data.diagnostics).toEqual([]);
    expect(JSON.parse(res.data.json)).toEqual(res.data.document);
    expect(parse(res.data.yaml)).toEqual(res.data.document);
  });

  it("merges assembler and validator diagnostics, ordered", async () => {
    const parserWarning: Diagnostic = {
      severity: "warning",
      code: "asyncapi-info-contact",
      message: "add contact",
      pointer: "/info",
    };
    const adapter = new AsyncApi3Adapter({ validators: [new FakeParserValidator(ok([parserWarning]))] });
    const draft = spec({
      channels: checkoutServiceSpec.channels,
      messages: [message({ id: "m", name: "M", unpublished: true })],
      operations: [operation({ key: "o", channelRef: checkoutServiceSpec.channels[0].id, messageRefs: ["m"] })],
    });
    const res = await adapter.emit(draft);
    expect(res.success && res.data.diagnostics.map((d) => d.code)).toEqual([
      "asyncapi-info-contact",
      "UNPUBLISHED_MESSAGE",
    ]);
  });

  it("runs every configured validator in order", async () => {
    const a: Diagnostic = { severity: "error", code: "A", message: "a", pointer: "/a" };
    const b: Diagnostic = { severity: "error", code: "B", message: "b", pointer: "/b" };
    const adapter = new AsyncApi3Adapter({
      validators: [new FakeParserValidator(ok([b])), new FakeParserValidator(ok([a]))],
    });
    expect(await adapter.validate({})).toEqual({ success: true, data: [a, b] });
  });

  it("propagates a validator failure as an err Result", async () => {
    const failing = new AsyncApi3Adapter({
      validators: [new FakeParserValidator(err({ code: "PARSER_UNAVAILABLE", message: "x" }))],
    });
    const res = await failing.emit(checkoutServiceSpec);
    expect(res.success).toBe(false);
    if (!res.success) expect(res.error.code).toBe("PARSER_UNAVAILABLE");
  });

  it("turns a throwing validator into VALIDATOR_FAILED instead of throwing", async () => {
    const throwing = new AsyncApi3Adapter({ validators: [new FakeParserValidator(new Error("boom"))] });
    const res = await throwing.validate({});
    expect(res).toEqual({
      success: false,
      error: { code: "VALIDATOR_FAILED", message: 'Validator "asyncapi-parser" threw: boom' },
    });
  });

  it("import is not implemented yet", async () => {
    const res = await new AsyncApi3Adapter().import("asyncapi: 3.0.0");
    expect(res.success).toBe(false);
    if (!res.success) expect(res.error.code).toBe("NOT_IMPLEMENTED");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/unit/lib/event-specs/adapter.test.ts`
Expected: FAIL — `Cannot find package '@/lib/event-specs/adapter'`.

- [ ] **Step 3: Implement the adapter** (`src/lib/event-specs/adapter.ts`)

```ts
import { ok, err, type Result } from "@/types/result";
import type { Diagnostic, EmitOutput, ImportedEventSpec, ResolvedEventSpec } from "./types";
import { normalizeDiagnostics } from "./diagnostics";
import { assembleAsyncApi3 } from "./assemble";
import { toJson, toYaml } from "./serialize";
import { StructuralAsyncApi3Validator, type EventSpecValidator } from "./validator";

/**
 * Spec §7.1. One adapter per `EventSpec.specType`. A new emission scope (whole
 * spec), separate from the per-entity targets in `src/lib/schema-targets/catalog.ts`.
 */
export interface EventSpecAdapter {
  readonly specType: string;
  emit(input: ResolvedEventSpec): Promise<Result<EmitOutput>>;
  validate(document: object): Promise<Result<Diagnostic[]>>;
  import(content: string): Promise<Result<ImportedEventSpec>>;
}

export const ASYNCAPI_3_SPEC_TYPE = "asyncapi@3.0";

export type AsyncApi3AdapterOptions = {
  /** Run in order; default: the built-in structural validator only. */
  validators?: EventSpecValidator[];
};

export class AsyncApi3Adapter implements EventSpecAdapter {
  readonly specType = ASYNCAPI_3_SPEC_TYPE;
  private readonly validators: EventSpecValidator[];

  constructor(options: AsyncApi3AdapterOptions = {}) {
    this.validators = options.validators ?? [new StructuralAsyncApi3Validator()];
  }

  /**
   * Assemble (steps 3–5) → validate (step 6) → serialize (step 7). Document
   * problems are returned as diagnostics alongside the document — callers decide
   * (publish blocks on any `error`; draft preview shows them). Only a validator
   * failure yields an `err` Result.
   */
  async emit(input: ResolvedEventSpec): Promise<Result<EmitOutput>> {
    const assembled = assembleAsyncApi3(input);
    const validated = await this.validate(assembled.document);
    if (!validated.success) return validated;
    return ok({
      document: assembled.document,
      json: toJson(assembled.document),
      yaml: toYaml(assembled.document),
      diagnostics: normalizeDiagnostics([...assembled.diagnostics, ...validated.data]),
    });
  }

  async validate(document: object): Promise<Result<Diagnostic[]>> {
    const all: Diagnostic[] = [];
    for (const validator of this.validators) {
      let result: Result<Diagnostic[]>;
      try {
        result = await validator.validate(document);
      } catch (e) {
        return err({
          code: "VALIDATOR_FAILED",
          message: `Validator "${validator.name}" threw: ${e instanceof Error ? e.message : String(e)}`,
        });
      }
      if (!result.success) return result;
      all.push(...result.data);
    }
    return ok(normalizeDiagnostics(all));
  }

  async import(content: string): Promise<Result<ImportedEventSpec>> {
    return err({
      code: "NOT_IMPLEMENTED",
      message: "AsyncAPI import is not implemented yet (Epic 19; needs @asyncapi/parser, registry-blocked)",
      details: { receivedBytes: content.length },
    });
  }
}

/** Adapter lookup by `EventSpec.specType` (spec §6.1; more spec types via Story 22.7). */
export function getEventSpecAdapter(specType: string, options?: AsyncApi3AdapterOptions): Result<EventSpecAdapter> {
  if (specType === ASYNCAPI_3_SPEC_TYPE) return ok(new AsyncApi3Adapter(options));
  return err({ code: "UNSUPPORTED_SPEC_TYPE", message: `No event spec adapter for spec type "${specType}"` });
}
```

- [ ] **Step 4: Create the barrel** (`src/lib/event-specs/index.ts`)

```ts
/** Events core — pure AsyncAPI 3 layer (Phase 4a). See spec §6–§7. */
export * from "./types";
export { compareStrings, diagnostic, hasErrors, normalizeDiagnostics } from "./diagnostics";
export { jsonPointer, localRef, parseLocalRef, resolveLocalRef } from "./json-pointer";
export {
  DEFAULT_JSON_SCHEMA_DIALECT,
  SCHEMA_FORMATS,
  formatSuffix,
  normalizeProfile,
  sameProfile,
  schemaFormatFor,
} from "./schema-format";
export {
  downConvertToDraft07,
  rewriteDefsRef,
  DRAFT_07_META_SCHEMA,
  UNSUPPORTED_IN_DRAFT_07,
} from "./json-schema-downconvert";
export type { DownConvertResult, DownConvertWarning } from "./json-schema-downconvert";
export { placeRootMessageFirst, ROOT_NODE_ANNOTATION } from "./proto-root";
export { qualifyNames } from "./qualify";
export type { NameCandidate, QualifiedNames } from "./qualify";
export { headersSchema, kafkaKeyProfile, placeKafkaKey, rebaseLocalRefs, selectArtifact } from "./message-schemas";
export type { SchemaRole, SchemaSelection } from "./message-schemas";
export { resolveEventSpecDocument } from "./resolve";
export type { EventSpecCatalog, ResolveOptions, ResolveProblem } from "./resolve";
export { assembleAsyncApi3, ASYNCAPI_VERSION } from "./assemble";
export type { AssemblyResult } from "./assemble";
export { toJson, toYaml } from "./serialize";
export { StructuralAsyncApi3Validator, validateAsyncApi3Structure } from "./validator";
export type { EventSpecValidator } from "./validator";
export { AsyncApi3Adapter, ASYNCAPI_3_SPEC_TYPE, getEventSpecAdapter } from "./adapter";
export type { AsyncApi3AdapterOptions, EventSpecAdapter } from "./adapter";
```

- [ ] **Step 5: Run tests — expect PASS**

Run: `npx vitest run tests/unit/lib/event-specs/adapter.test.ts`
Expected: PASS — 1 file, 7 tests.
Run: `npx tsc --noEmit` — Expected: no errors (also proves the barrel has no export conflicts).

- [ ] **Step 6: Commit**

```bash
git add src/lib/event-specs/adapter.ts src/lib/event-specs/index.ts tests/unit/lib/event-specs/adapter.test.ts
git commit -m "feat(18.4): EventSpecAdapter and AsyncApi3Adapter (emit, validate, import stub)"
```

---

### Task 12: Golden files for the spec §6.2 worked example (Story 18.4, spec §11)

**Files:**
- Test: `tests/unit/lib/event-specs/golden.test.ts`
- Create: `tests/unit/lib/event-specs/__golden__/checkout-service.asyncapi.yaml`
- Create: `tests/unit/lib/event-specs/__golden__/checkout-service.asyncapi.json`
- Create: `tests/unit/lib/event-specs/__golden__/fraud-scorer.asyncapi.yaml`
- Create: `tests/unit/lib/event-specs/__golden__/fraud-scorer.asyncapi.json`

**Interfaces:**
- Consumes: `AsyncApi3Adapter` (Task 11); `checkoutServiceSpec`, `fraudScorerSpec`, `SPEC_6_2_CHECKOUT_YAML` (Task 7).
- Produces: byte-exact output contract for both worked-example specs. `UPDATE_GOLDEN=1` rewrites goldens deliberately (review the diff — a golden change is an output-contract change).

- [ ] **Step 1: Write the failing test** (`tests/unit/lib/event-specs/golden.test.ts`)

```ts
import { describe, it, expect } from "vitest";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { AsyncApi3Adapter } from "@/lib/event-specs/adapter";
import type { EmitOutput, ResolvedEventSpec } from "@/lib/event-specs/types";
import { SPEC_6_2_CHECKOUT_YAML, checkoutServiceSpec, fraudScorerSpec } from "./fixtures/worked-example";

/**
 * Golden files for the spec §6.2 worked example. Regenerate deliberately with
 *   UPDATE_GOLDEN=1 npx vitest run tests/unit/lib/event-specs/golden.test.ts
 * and review the diff — a golden change is an output-contract change.
 */
const GOLDEN_DIR = path.join(__dirname, "__golden__");

function expectGolden(file: string, actual: string): void {
  const target = path.join(GOLDEN_DIR, file);
  if (process.env.UPDATE_GOLDEN === "1") {
    mkdirSync(GOLDEN_DIR, { recursive: true });
    writeFileSync(target, actual);
  }
  expect(actual).toBe(readFileSync(target, "utf8"));
}

async function emit(spec: ResolvedEventSpec): Promise<EmitOutput> {
  const res = await new AsyncApi3Adapter().emit(spec);
  if (!res.success) throw new Error(res.error.message);
  return res.data;
}

describe("golden: spec §6.2 worked example", () => {
  it("checkout-service@2.0 matches its YAML and JSON goldens", async () => {
    const out = await emit(checkoutServiceSpec);
    expect(out.diagnostics).toEqual([]);
    expectGolden("checkout-service.asyncapi.yaml", out.yaml);
    expectGolden("checkout-service.asyncapi.json", out.json);
  });

  it("checkout-service@2.0 is semantically the document printed in the spec", async () => {
    const out = await emit(checkoutServiceSpec);
    expect(parse(out.yaml)).toEqual(parse(SPEC_6_2_CHECKOUT_YAML));
  });

  it("fraud-scorer@1.0 matches its goldens and shares checkout's channels/components blocks", async () => {
    const out = await emit(fraudScorerSpec);
    expect(out.diagnostics).toEqual([]);
    expectGolden("fraud-scorer.asyncapi.yaml", out.yaml);
    expectGolden("fraud-scorer.asyncapi.json", out.json);

    const checkout = await emit(checkoutServiceSpec);
    expect(out.document.channels).toEqual(checkout.document.channels);
    expect(out.document.components).toEqual(checkout.document.components);
    expect(out.document.operations).toEqual({
      consumeOrderCreated: {
        action: "receive",
        channel: { $ref: "#/channels/orders" },
        messages: [{ $ref: "#/channels/orders/messages/OrderCreated" }],
      },
    });
  });

  it("is byte-stable across repeated emits", async () => {
    const [a, b] = await Promise.all([emit(checkoutServiceSpec), emit(structuredClone(checkoutServiceSpec))]);
    expect(b.yaml).toBe(a.yaml);
    expect(b.json).toBe(a.json);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/unit/lib/event-specs/golden.test.ts`
Expected: FAIL — 2 failed, 2 passed; `ENOENT: no such file or directory, open '…/__golden__/checkout-service.asyncapi.yaml'` (and the fraud-scorer equivalent).

- [ ] **Step 3: Write the goldens exactly as below** (each file ends with exactly one trailing newline; do **not** generate them with `UPDATE_GOLDEN=1` — they are the reviewed contract, and Step 4 must pass against these bytes)

```bash
mkdir -p tests/unit/lib/event-specs/__golden__
cat > tests/unit/lib/event-specs/__golden__/checkout-service.asyncapi.yaml <<'EOF'
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
      kafka:
        partitions: 12
operations:
  publishOrderCreated:
    action: send
    channel:
      $ref: '#/channels/orders'
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
        schema:
          type: record
          name: Order
          namespace: acme.payments.checkout
          fields: []
      bindings:
        kafka:
          key:
            type: string
  messageTraits:
    CloudEvents:
      headers:
        type: object
        properties:
          ce_id:
            type: string
          ce_type:
            type: string
          ce_source:
            type: string
EOF
```

```bash
mkdir -p tests/unit/lib/event-specs/__golden__
cat > tests/unit/lib/event-specs/__golden__/checkout-service.asyncapi.json <<'EOF'
{
  "asyncapi": "3.0.0",
  "info": {
    "title": "checkout-service",
    "version": "2.0"
  },
  "servers": {
    "kafka-prod": {
      "host": "kafka-prod.internal:9092",
      "protocol": "kafka"
    }
  },
  "channels": {
    "orders": {
      "address": "payments.orders.v1",
      "messages": {
        "OrderCreated": {
          "$ref": "#/components/messages/OrderCreated"
        }
      },
      "bindings": {
        "kafka": {
          "partitions": 12
        }
      }
    }
  },
  "operations": {
    "publishOrderCreated": {
      "action": "send",
      "channel": {
        "$ref": "#/channels/orders"
      },
      "messages": [
        {
          "$ref": "#/channels/orders/messages/OrderCreated"
        }
      ]
    }
  },
  "components": {
    "messages": {
      "OrderCreated": {
        "contentType": "avro/binary",
        "traits": [
          {
            "$ref": "#/components/messageTraits/CloudEvents"
          }
        ],
        "payload": {
          "schemaFormat": "application/vnd.apache.avro+json;version=1.9.0",
          "schema": {
            "type": "record",
            "name": "Order",
            "namespace": "acme.payments.checkout",
            "fields": []
          }
        },
        "bindings": {
          "kafka": {
            "key": {
              "type": "string"
            }
          }
        }
      }
    },
    "messageTraits": {
      "CloudEvents": {
        "headers": {
          "type": "object",
          "properties": {
            "ce_id": {
              "type": "string"
            },
            "ce_type": {
              "type": "string"
            },
            "ce_source": {
              "type": "string"
            }
          }
        }
      }
    }
  }
}
EOF
```

```bash
mkdir -p tests/unit/lib/event-specs/__golden__
cat > tests/unit/lib/event-specs/__golden__/fraud-scorer.asyncapi.yaml <<'EOF'
asyncapi: 3.0.0
info:
  title: fraud-scorer
  version: '1.0'
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
      kafka:
        partitions: 12
operations:
  consumeOrderCreated:
    action: receive
    channel:
      $ref: '#/channels/orders'
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
        schema:
          type: record
          name: Order
          namespace: acme.payments.checkout
          fields: []
      bindings:
        kafka:
          key:
            type: string
  messageTraits:
    CloudEvents:
      headers:
        type: object
        properties:
          ce_id:
            type: string
          ce_type:
            type: string
          ce_source:
            type: string
EOF
```

```bash
mkdir -p tests/unit/lib/event-specs/__golden__
cat > tests/unit/lib/event-specs/__golden__/fraud-scorer.asyncapi.json <<'EOF'
{
  "asyncapi": "3.0.0",
  "info": {
    "title": "fraud-scorer",
    "version": "1.0"
  },
  "servers": {
    "kafka-prod": {
      "host": "kafka-prod.internal:9092",
      "protocol": "kafka"
    }
  },
  "channels": {
    "orders": {
      "address": "payments.orders.v1",
      "messages": {
        "OrderCreated": {
          "$ref": "#/components/messages/OrderCreated"
        }
      },
      "bindings": {
        "kafka": {
          "partitions": 12
        }
      }
    }
  },
  "operations": {
    "consumeOrderCreated": {
      "action": "receive",
      "channel": {
        "$ref": "#/channels/orders"
      },
      "messages": [
        {
          "$ref": "#/channels/orders/messages/OrderCreated"
        }
      ]
    }
  },
  "components": {
    "messages": {
      "OrderCreated": {
        "contentType": "avro/binary",
        "traits": [
          {
            "$ref": "#/components/messageTraits/CloudEvents"
          }
        ],
        "payload": {
          "schemaFormat": "application/vnd.apache.avro+json;version=1.9.0",
          "schema": {
            "type": "record",
            "name": "Order",
            "namespace": "acme.payments.checkout",
            "fields": []
          }
        },
        "bindings": {
          "kafka": {
            "key": {
              "type": "string"
            }
          }
        }
      }
    },
    "messageTraits": {
      "CloudEvents": {
        "headers": {
          "type": "object",
          "properties": {
            "ce_id": {
              "type": "string"
            },
            "ce_type": {
              "type": "string"
            },
            "ce_source": {
              "type": "string"
            }
          }
        }
      }
    }
  }
}
EOF
```

Compare with spec §6.2: same keys and `$ref` targets; the only differences are presentation (block style instead of the spec's inline `{ … }` flow mappings), which the "semantically the document printed in the spec" test proves.

- [ ] **Step 4: Run tests — expect PASS**

Run: `npx vitest run tests/unit/lib/event-specs/golden.test.ts`
Expected: PASS — 1 file, 4 tests. If a golden mismatches, fix the implementation, not the golden.

- [ ] **Step 5: Commit**

```bash
git add tests/unit/lib/event-specs/golden.test.ts tests/unit/lib/event-specs/__golden__
git commit -m "test(18.4): golden AsyncAPI documents for the spec 6.2 worked example"
```

---

### Task 13: Full verification

**Files:** none.

- [ ] **Step 1: Whole phase suite** — `npx vitest run tests/unit/lib/event-specs` — Expected: 12 files, 88 tests, all passing.
- [ ] **Step 2: Type check** — `npx tsc --noEmit` — Expected: no errors.
- [ ] **Step 3: Lint the new files** — `npx eslint src/lib/event-specs tests/unit/lib/event-specs` — Expected: no errors, no warnings.
- [ ] **Step 4: Full suite** — `npx vitest run` — Expected: only the 8 baseline failures (see Task 0 Step 3 for environmental integration failures from a shared, drifted DB).
- [ ] **Step 5: Isolation check** — `git diff --stat feat/events-asyncapi...HEAD` — Expected: every path is under `src/lib/event-specs/` or `tests/unit/lib/event-specs/`; no other file changed.
- [ ] **Step 6: Purity check** — `grep -rnE "from \"(@asyncapi/|@/generated/prisma|node:|fs\")|Date\.now|Math\.random" src/lib/event-specs` — Expected: no output (exit code 1).

---

## Phase 4a exit criteria

- `src/lib/event-specs/` implements spec §7.1 (`EventSpecAdapter`, `AsyncApi3Adapter.emit` / `validate`, `import` → `NOT_IMPLEMENTED`) and §7.2 steps 3–7 over in-memory inputs; `schemaFormat` strings exactly per §7.2 step 4.
- The emitted `checkout-service@2.0` document is semantically equal to spec §6.2; goldens for `checkout-service@2.0` and `fraud-scorer@1.0` pass byte-for-byte.
- Story 16.2 and 16.3 pure cores (`downConvertToDraft07`, `placeRootMessageFirst`) are implemented and tested.
- `npx tsc --noEmit` clean; `npx vitest run` → 8 baseline failures only; eslint clean on the new files; diff confined to the two new directories.

## Handoff — how later stories plug in

- **18.1 / 18.4 (DB-backed):** build an `EventSpecCatalog` from `Channel` / `Message(Version)` / `Trait` rows (frozen copies for published specs) and `SchemaArtifact`s from `EntityVersionArtifact` (headers always JSON Schema; keys rendered as Avro + JSON Schema), call `resolveEventSpecDocument(document, catalog, { productSlug, version })`, then `getEventSpecAdapter(spec.specType)` → `emit()`. Publish blocks when `hasErrors(output.diagnostics)`; store `output.document` in `EventSpecVersion.document`.
- **18.5:** add `AsyncApiParserValidator implements EventSpecValidator` (parser + Avro/Protobuf schema parsers, remote `$ref` resolution off) and construct `new AsyncApi3Adapter({ validators: [new StructuralAsyncApi3Validator(), new AsyncApiParserValidator()] })`. Confirm Decision D8 (`$ref` rebasing) against the parser.
- **16.2 / 16.3 rendering:** call `downConvertToDraft07()` when a channel's profile is draft-07 and `placeRootMessageFirst()` on every generated payload `.proto` before storing the artifact.
- **Epic 19:** replace `AsyncApi3Adapter.import()`; extend `ImportedEventSpec`.

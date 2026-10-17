# AsyncAPI Importer and Local JSON Validation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** (A) Let a user create an Event by pasting or uploading an AsyncAPI 3.0 document ("Import existing…" in New Event). (B) Validate the raw-JSON fields of the event builder locally with `codemirror-json-schema`: message examples against their payload/headers entity schema (plus "Generate from payload"), and the raw-JSON binding fields against the AsyncAPI binding schemas.

**Architecture:** (A) A pure, client-safe pipeline (`src/lib/events/import/*`: parse → resolve local `$ref`s → extract payload schemas → map to an `EventDocument`) and a server service that validates with the AsyncAPI parser, creates draft entities for the payload schemas through the existing importers, then creates the event, with compensation on failure; a two-step dialog (paste/upload → preview → import). (B) `JsonEditor` gets a real `schema` prop that lazy-loads `codemirror-json-schema` only when a schema exists; schemas come from (1) a new read action that renders a payload pin to JSON Schema and (2) binding schema fragments inlined at generation time.

**Tech Stack:** Next.js 16 server actions, Prisma 7/PostgreSQL, Vitest, Playwright, CodeMirror 6, `codemirror-json-schema` 0.8.1 (installed, `json-schema-library` 9 inside), `@asyncapi/parser` 3 (installed), `yaml`, `openapi-sampler` 1.7.6 (declared direct dependency for sample generation). **No further packages and no migrations.**

**Spec:** `docs/superpowers/specs/2026-10-15-events-self-contained-design.md` (§4 document v2, §7.2 input rules — the Examples row promised live validation and "Generate from payload"), `docs/events/REVIEW.md` §6 (open gaps), and the **Decisions** below.

## Decisions (user-approved in chat, 2026-10-16)

1. **Importer input:** paste **and** upload (`.yaml`, `.yml`, `.json`). **AsyncAPI 3.0 only** (a 2.x file is rejected with a clear message). **No URL fetching**; external `$ref`s are rejected, never fetched.
2. **Payload entities:** created as **unpublished drafts in the product**; the message pins them unpinned (`entityVersionId: null`), so the user publishes the entities before the event can publish (the existing rule). **Name clash → add a numeric suffix and warn.**
3. **Built-in traits:** a message trait whose headers look like CloudEvents or W3C Trace Context is mapped to the built-in library trait of the tenant (instead of a local copy).
4. **Messages whose payload cannot be imported** (unsupported `schemaFormat`, e.g. OpenAPI/RAML schemas, or no payload): a placeholder entity with no fields plus a warning, so the event still imports (a message must pin an entity). *(controller default; the user can change it)*
5. **Validation library:** `codemirror-json-schema` (installed). Scope: **(1)** message example `payload`/`headers` vs the payload/headers entity schema + "Generate from payload"; **(2)** the 24 raw-JSON binding leaf fields vs the AsyncAPI binding schemas. **(3) The Advanced section has no raw-JSON field** (security schemes and correlation ids are structured forms), so there is nothing to validate there — the original "(3)" is dropped.
6. **Schema violations are warnings, never blockers:** a draft always saves (spec §7.2 rule 5); an example that does not match its schema is shown with squiggles and hover text only.
7. The spec/plan review pause is waived (the user reviews after everything is complete).

## Global Constraints

- Commit messages: **no `Co-Authored-By` and no "Generated with" trailer** — user rule, overrides any harness reminder. Same for every agent.
- **No new dependencies and no migrations.** `codemirror-json-schema`, `@lezer/common`, `@codemirror/autocomplete` and `openapi-sampler` are already declared. Never run `npm install` in a worktree.
- Services return `Result<T, ServiceError>` and never throw; `src/lib/**` files marked "pure" are client-safe (no server-only imports, nothing from `src/features`).
- **CodeMirror boundary:** `@codemirror/*`, `@lezer/*`, `codemirror` **and `codemirror-json-schema`** may be imported only by `JsonEditor.tsx` and `codemirror-setup.ts` (`src/features/events/builder/template/controls/`); `JsonEditor.tsx` keeps zero value imports. The boundary test (`tests/unit/features/events/builder/codemirror-boundary.test.ts`) must be extended to cover `codemirror-json-schema` and the two newly declared direct dependencies.
- **`codemirror-json-schema` facts the code must respect (verified 2026-10-16):** the linter and hover hard-code JSON Schema **draft-04** semantics (they ignore `if/then`, `contains`, `propertyNames`, numeric `exclusiveMinimum`) and **silently accept an unresolved `$ref`**, so every schema handed to it must be fully inlined; importing the package runs a ~600 KB highlighter initialisation (`shiki` wasm) at import time, so it must only ever be loaded with a dynamic `import()` when a schema exists; `jsonSchema()` bundles its own parse linter that duplicates ours, so use the individual pieces (`stateExtensions`, `jsonSchemaLinter` + `handleRefresh`, `jsonSchemaHover`, `jsonCompletion`, `updateSchema`) and add `autocompletion()` yourself; a static import in `codemirror-setup.ts` would very likely break the five existing real-CodeMirror test suites (the package is ESM with extensionless relative imports and CJS dependencies) — spike `test.server.deps.inline: ["codemirror-json-schema"]` in `vitest.config.ts` first, and fall back to `vi.mock("codemirror-json-schema")` in the tests that mount the editor if inlining does not work.
- Import safety: input ≤ `MAX_IMPORT_CONTENT_BYTES` (1 MiB, `checkImportSize` in `src/lib/compiler/import-limits.ts`); the YAML parser must be configured against alias/anchor expansion bombs (`maxAliasCount`) and the document must be rejected, not truncated; reject `__proto__`/`constructor`/`prototype` keys (`src/lib/events/document/own-property.ts`); local `$ref`s only (`src/lib/event-specs/json-pointer.ts` has `resolveLocalRef`/`parseLocalRef`), cycles are an error.
- Names: event names and entity names share one uniqueness line (`src/services/name-registry.service.ts`); entity names and event names must match their existing rules (event: `/^[A-Za-z0-9._-]{1,128}$/`). Document keys: `KEY_PATTERN = /^[a-zA-Z0-9._-]+$/`, ≤ 64 (`types.ts:11-12`), generated with `slugKey`/`uniqueKey` (`src/lib/events/document/keys.ts`).
- Entities must exist before the event document can pin them (`DocMessage.payload` needs a non-empty `entityId`).
- UI copy: new strings in one labels file per feature (`builder/labels.ts` for validation; a new `import-labels.ts` for the importer). Spec §7.2 input rules apply.
- Tests: Vitest in `tests/unit` / `tests/integration` (unique names via `stamp()`, clean up with `cleanupDomains` — **register every domain id**, a leaked `con-*` domain bug was just fixed). Known baseline failures (leave alone): `db-emitter-parity` ×4, `schemas-tab` ×3, `e2e-critical-flows` ×1; TypeSpec-CLI tests and focus-timing tests can fail only under full-suite load. Agents may NOT run Playwright or `next build`: write the specs, make them type-check; the controller runs them.
- Git in worktrees: `/usr/bin/git`, one plain command per call. Per-worktree `npx prisma generate`. zsh: never name a variable `path`.

## Review Focus

Conditions the spec does not spell out that are most likely to bite, each pinned by a named test in the owning package:

1. **A failed import leaves nothing behind.** Entities are created before the event; if event creation or the document save fails, the created entities are deleted (and a failed rollback is reported, not hidden). An invalid AsyncAPI document creates nothing at all (WP-I2).
2. **Hostile input:** >1 MiB, a YAML alias bomb, a `$ref` cycle, an external/URL `$ref`, `__proto__` keys, a 5,000-message document (WP-I1/I2).
3. **Name collisions:** two payloads in one file with the same name, a name that exists in the product, the event title as a taken name, and importing the same file twice (second import renames, never errors) (WP-I2).
4. **Round trip:** an AsyncAPI document emitted by this app imports back into an equivalent event document (WP-I1).
5. **Validation never blocks:** no schema ⇒ the editor behaves exactly as before; a schema violation never makes `JsonControl` treat valid JSON as invalid or stop writing it; a schema object rebuilt on every render does not loop reconfiguration (WP-V1).
6. **No stale schema:** changing a message's payload entity or version replaces the schema used by its examples; a failed schema load removes it instead of keeping the old one (WP-V3).
7. **Bundle:** `codemirror-json-schema` and its highlighter are loaded only when a JSON field with a schema opens — not in the first-load JavaScript of pages that never open one; and a 1,000-property payload schema neither freezes the editor nor exceeds the pin-schema size cap (WP-V1/V3).

## State today (verified 2026-10-16)

| Area | Exists | Missing |
|---|---|---|
| Importer | importers for JSON Schema/Avro/Protobuf (`src/lib/importers/*`, `parseJsonSchemaDocument`, `parseAvroDocument`, `parseProtobufDocument` → `MultiEntityImportResult {entities, rootEntityName, enums, scalars, warnings, sourceFormat}`); `createDomainAssetsFromImportAction(BulkImportPayload)` (`src/app/(dashboard)/schemas/[domainSlug]/actions.ts:~1248`; writes `metadata.sourceFormat`; **skips** a name clash with "already exists — skipped", never renames; returns `entityIds` in creation order, no name→id map); `createEvent` + `updateEventDocument` (`event.service.ts`); AsyncAPI parser with remote refs disabled (`createAsyncApiParser`, `src/lib/event-specs/validation/asyncapi-parser-validator.ts`); `AsyncApi3Adapter.import()` is `NOT_IMPLEMENTED` (`adapter.ts:74`) | everything in WP-I1..I3 |
| Validation | `JsonEditor` with our own JSON parse lint; library installed | `schema` prop ("reserved and ignored", `JsonEditor.tsx:32`), schema sources, example generator, boundary coverage for the library |
| Schema sources | `@asyncapi/specs` 6.11.1 is a devDependency; 64 binding files, draft-07, `$ref`s to absolute `http://asyncapi.com/definitions/3.0.0/*.json` (not self-contained; deep imports possible, the package root loads 3.3 MB — never import it); the generator `scripts/generate-asyncapi-templates.ts` reads binding files with `fs` at generation time and emits no schemas; `ArtifactRenderer.render(subject, "json-schema")` gives an inlined 2020-12 schema for ANY entity (TypeSpec-backed, also Avro/Protobuf), `downConvertToDraft07` (`json-schema-downconvert.ts:64`) gives draft-07 | read action for one pin, inlined binding fragments |
| Raw-JSON fields | message example `headers`/`payload` (`objects.ts:109-113`); 24 generated binding leaves (`anypointmq.message.headers`, `http.operation.query`, `http.message.headers`, `jms.server.properties.value`, `jms.message.headers`, `kafka.operation.groupId`, `kafka.operation.clientId`, `kafka.message.key`, `mqtt.message.correlationData`, `ws.channel.query`, `ws.channel.headers`, `sns.channel.policy.statements.{principal,action,resource}`, `sns.operation.consumers.filterPolicy`, `sqs.*.policy.statements.{principal,action,resource}`) with path `…/bindings/{protocol}/{key}`; `BindingsForm`'s unknown-protocol fallback (no schema) | the control cannot see protocol/target/pin (`TemplateFormContext` is only `{references?, entityOptions?, loadVersions?}`) |

## Work packages and order

| WP | What | Depends on | Wave |
|---|---|---|---|
| V1 | `JsonEditor` schema support (lazy library, warnings, completion, hover, boundary test, vitest strategy) | — | A |
| I1 | AsyncAPI source parsing, local `$ref` resolution, payload extraction, mapping to `EventDocument` (pure) | — | A |
| V2 | Binding field schemas (generator extension, generated map, lookup, wiring) | V1 | B |
| V3 | Examples: pin JSON-Schema read action, hook, context plumbing, "Generate from payload" | V1 | B |
| I2 | Import service + actions (validate, create entities, create event, compensation, preview) | I1 | B |
| I3 | Import UI (dialog, preview, upload) + e2e | I2 (interfaces below) | C |
| D | Docs, memory, full verification, merge | all | C |

Waves A and B packages touch disjoint files except `FieldControl.tsx` / `controls/types.ts` (V2 and V3, resolved at merge).

---

## WP-V1: JsonEditor schema support

**Files:**
- Modify: `src/features/events/builder/template/controls/codemirror-setup.ts`, `JsonEditor.tsx`, `JsonControl.tsx`, `src/features/events/builder/template/FieldControl.tsx` (pass an optional `schema` through), `controls/types.ts` (`ControlProps.schema?`), `tests/unit/features/events/builder/codemirror-boundary.test.ts`, `vitest.config.ts` (only if the inline spike works)
- Test: `tests/unit/components/events/template/json-editor-schema.test.tsx`, extend `json-control-codemirror.test.tsx` and `codemirror-setup.test.tsx`

**Interfaces:**

```ts
// JsonEditor props gain (replacing the stale "reserved and ignored" comment):
schema?: Record<string, unknown> | null;   // fully INLINED draft-07-style JSON Schema; null/undefined = no schema
// codemirror-setup.ts EditorHandle gains:
setSchema(schema: Record<string, unknown> | null): Promise<void>;
// ControlProps gains:
schema?: Record<string, unknown> | null;
```

**Behavior:**
- `schema` non-null + language json + CodeMirror supported ⇒ load the library with `await import("codemirror-json-schema")` (memoised, inside `codemirror-setup.ts` only), then install, in a dedicated `Compartment` so it can be swapped: `stateExtensions(schema)`, `linter(<our wrapper around jsonSchemaLinter()>, { needsRefresh: handleRefresh, delay: 250 })`, `hoverTooltip(jsonSchemaHover())`, `autocompletion()` + `jsonLanguage.data.of({ autocomplete: jsonCompletion() })`. A schema change calls `updateSchema(view, schema)`; `null` removes the compartment's extensions and clears the diagnostics. **Compare schemas structurally** (stable stringify of the object, computed once per change) — never by identity: `sameOptions` uses `===` and a rebuilt object would reconfigure on every render.
- Our wrapper maps every schema diagnostic to severity `"warning"` (spec rule: warnings, never blockers) and keeps parse errors as errors from our own `lintJson`. A schema warning must **not** reach `onErrorChange`, and `JsonControl` keeps writing every syntactically valid value (its existing contract and tests stay green).
- No schema ⇒ nothing about the library is imported and the editor behaves byte-for-byte as before.
- A library load failure (rejected import) leaves the editor working without schema support (no throw, no banner).
- Document in a code comment the draft-04/unresolved-`$ref` limits and that callers must inline.

- [ ] **Step 1 (spike, report the result):** make the library importable under vitest: try `test.server.deps.inline: ["codemirror-json-schema"]` (and, if needed, its CJS dependencies `json-schema-library`, `@sagold/json-query`) in `vitest.config.ts`; mount a real editor with a schema in a test. If that cannot work, use `vi.mock("codemirror-json-schema")` with a faithful fake (export names per the plan) in the editor tests and say so in the report.
- [ ] **Step 2: Write the failing tests** (every body in full): schema → an invalid value yields a warning diagnostic with the schema's message at the right range; a valid value yields none; swapping the schema re-lints; `null` clears markers; the same schema rebuilt as a new object does not call `updateSchema` again; syntax error still reports an error and `onErrorChange` fires, a schema violation does not fire it; no schema ⇒ the library module is not imported (assert with a mock/import counter); a rejected library import leaves the editor usable; `JsonControl` with `schema` writes a valid-but-schema-violating value; completion/hover extensions are installed when a schema exists (assert on the extension list/handle); the boundary test fails if a file other than the two imports `codemirror-json-schema`.
- [ ] **Step 3: Implement.** **Step 4: Run** `npx vitest run tests/unit/components/events/template tests/unit/features/events/builder tests/unit/components/events` (all green, including the five existing real-CodeMirror suites), `npx tsc --noEmit`, `./node_modules/.bin/eslint <changed files>`.
- [ ] **Step 5: Commit** `feat(events): schema-aware JSON editor (codemirror-json-schema, lazy loaded, warnings only)`.

---

## WP-I1: AsyncAPI source parsing, extraction and mapping (pure)

**Files (all new, pure, client-safe):**
- `src/lib/events/import/{types.ts,source.ts,refs.ts,payloads.ts,map-document.ts,builtin-traits.ts,index.ts}`
- Tests: `tests/unit/lib/events/import/{source,refs,payloads,map-document,builtin-traits,roundtrip}.test.ts`
- Fixtures: `tests/fixtures/asyncapi-import/*.yaml|json` — hand-written AsyncAPI 3.0 documents modelled on the official examples (a Kafka "streetlights"-style document with `$ref`s to components and a reply-less send/receive pair; an MQTT one with channel parameters and security schemes; an HTTP/WebSocket minimal one; one with inline messages and traits; one with messageTraits matching CloudEvents and W3C Trace Context headers; one with a `reply`; one with multi-format payloads: AsyncAPI-schema JSON, `application/schema+json;version=draft-07`, Avro (`application/vnd.apache.avro;version=1.9.0`), Protobuf (`application/vnd.google.protobuf;version=3`), and one OpenAPI-schema payload that must produce the "unsupported" warning), plus negatives (2.x, external `$ref`, `$ref` cycle, missing ref, `__proto__`, alias bomb).

**Interfaces:**

```ts
export type ImportWarningCode =
  | "UNSUPPORTED_PAYLOAD_FORMAT" | "NO_PAYLOAD" | "UNSUPPORTED_EXTENSION" | "DROPPED_CONSTRUCT" | "ENTITY_RENAMED"
  | "BUILTIN_TRAIT_MAPPED" | "KEY_ADJUSTED" | "SANITIZED_VALUE";
export interface ImportWarning { pointer: string; code: ImportWarningCode; message: string }
export type RawAsyncApi3 = Record<string, unknown> & { asyncapi: string };

/** YAML or JSON text → plain object. Rejects: not an object, `asyncapi` missing or not 3.x ("AsyncAPI 3.0 only"), forbidden keys, alias expansion over the limit, text over 1 MiB. */
export function parseAsyncApiSource(text: string): Result<RawAsyncApi3>;

/** Every payload and headers schema of every message (component or inline), local $refs already inlined so each schema is self-contained. */
export interface ExtractedPayload {
  messageKey: string;                  // the key the message will get in the document
  role: "payload" | "headers";
  sourcePointer: string;
  format: "json-schema" | "avro" | "protobuf" | "unsupported" | "none";
  raw: unknown;                        // object (json-schema/avro) or string (protobuf source)
  suggestedName: string;               // PascalCase-ish from message name/title/key (+ "Headers" for headers)
}
export function extractPayloads(raw: RawAsyncApi3): Result<ExtractedPayload[]>;

export interface MapContext {
  payloadPins: ReadonlyMap<string, EntityPin>;     // `${messageKey}:payload` / `${messageKey}:headers` → pin
  builtInTraitIds: { cloudEvents?: string; traceContext?: string };
}
export function mapAsyncApiToEventDocument(raw: RawAsyncApi3, ctx: MapContext): Result<{ document: EventDocument; warnings: ImportWarning[] }>;
```

**Behavior (read `types.ts`, `parse.ts`, `parse-objects.ts`, `keys.ts`, `src/lib/events/templates/keys.ts` and `src/lib/event-specs/assemble.ts` first — the mapping is the inverse of the assembler):**
- `source.ts`: parse with the `yaml` package (`maxAliasCount` small, e.g. 100; `uniqueKeys` on), JSON first when the text starts with `{`; size check against `MAX_IMPORT_CONTENT_BYTES`; deep-scan for forbidden keys; error codes `PARSE_ERROR`/`UNSUPPORTED_VERSION`/`TOO_LARGE` with messages a user can act on.
- `refs.ts`: `resolveLocalRefs(raw)` inlines `{ $ref: "#/..." }` using `resolveLocalRef`; **external refs (`http:`, `file:`, relative paths) → error `EXTERNAL_REF`**; a cycle → error `REF_CYCLE` naming the pointer; a missing target → error `REF_NOT_FOUND`. Component identity matters for messages, traits, securitySchemes, parameters, correlationIds: map those by their component key BEFORE inlining (an importer must keep `components.messages.X` as key `X`, not lose it).
- Mapping (all of): `info` (title; description, termsOfService, contact, license `{name}` (url dropped with a warning if the document model has none — check `EventSpecInfo`), tags, externalDocs; `info.version` is dropped — the app assigns versions at publish); `defaultContentType`; `servers` (host, pathname, protocol, protocolVersion, title, summary, description, variables, `security` refs → keys, tags, externalDocs, bindings verbatim); `components.securitySchemes` (supported types only; others dropped with `DROPPED_CONSTRUCT`); `channels` (address, title, summary, description, parameters, bindings, `servers` refs → `serverKeys`, tags, externalDocs, `messages` → `messageKeys`; the channel-local message key equals the component key; inline messages get a generated key); `messages` (name, title, summary, description, contentType, deprecated, correlationId (inline or `components.correlationIds`), tags, externalDocs, bindings, examples, traits, payload/headers → pins from `ctx.payloadPins`); `operations` (action, channel ref → `channelKey`, message refs `#/channels/<c>/messages/<k>` → `messageKeys`, title, summary, description, security, tags, externalDocs, bindings, traits, `reply` with address/channel/messages); `components.messageTraits`/`operationTraits` → local traits (allowed spec keys only: `MESSAGE_TRAIT_SPEC_KEYS` / `OPERATION_TRAIT_SPEC_KEYS`; a trait's inline `headers` schema stays inline in `spec.headers`). Unknown non-`x-` keys in places the document model rejects are **sanitised and reported** (`SANITIZED_VALUE`/`UNSUPPORTED_EXTENSION`), never copied through, so the result always parses.
- `builtin-traits.ts`: `detectBuiltInTrait(spec)` — CloudEvents when the trait's headers define all of `specversion, id, source, type` (and only properties from the built-in's property list), W3C Trace Context when it defines `traceparent` (optionally `tracestate`); a match becomes `{ key, kind: "MESSAGE", libraryTraitId }` using `ctx.builtInTraitIds`, with a `BUILTIN_TRAIT_MAPPED` warning-level note; no id available ⇒ local trait. Use the definitions in `src/lib/events/bundled-traits.ts` (`BUNDLED_TRAITS`) as the source of truth for names.
- Keys: keep a valid component key as is (`KEY_PATTERN`, ≤ 64), else `slugKey` + `uniqueKey` per namespace (channels, messages, traits (one namespace across kinds), operations, servers) with a `KEY_ADJUSTED` warning when it changed.
- The returned document always passes `parseEventDocument`; a test asserts it for every fixture. If the mapped result cannot be made valid, return `VALIDATION_ERROR` with the parser's problems.

- [ ] **Step 1: Write the failing tests** (every body in full): one per fixture asserting the mapped document's key facts and its warnings; the negatives above each return the right error code; extraction finds every payload/headers schema for inline and component messages and inlines local refs; the five format variants are detected; built-in trait detection (positive, negative with a missing required header, local fallback without ids); **round trip:** for each file in `tests/unit/lib/events/document/__golden__/slice1-*.asyncapi.yaml`, the maximal document (`tests/unit/lib/events/document/fixtures/maximal-document.ts`, emitted through the assembler) and `tests/unit/lib/event-specs/__golden__/*.asyncapi.yaml`: parse → extract → fake pins → map → the result parses and a `comparableDocument()` helper (drops pins, `origin`, `representation`, ordering) equals the one of the original document; a 5,000-message synthetic document maps in well under a second and does not blow the stack.
- [ ] **Step 2: Run, verify FAIL.** `npx vitest run tests/unit/lib/events/import`
- [ ] **Step 3: Implement.** **Step 4: Run** the new tests + `tests/unit/lib/events` + `npx tsc --noEmit` + eslint on changed files. **Step 5: Commit** `feat(events): AsyncAPI 3.0 source parsing and mapping to an event document`.

---

## WP-V2: Binding field schemas

**Depends on:** V1.

**Files:**
- Modify: `scripts/generate-asyncapi-templates.ts`, `package.json` script only if the generator needs a flag (it should not), `src/features/events/builder/template/FieldControl.tsx` (pass `schema` to `JsonControl` for json fields), `BindingsForm.tsx` if it needs to forward the protocol/target
- Create: `src/lib/events/templates/binding-json-schemas.generated.ts` (generated, committed), `src/lib/events/templates/binding-schemas.ts` (lookup)
- Test: `tests/unit/lib/events/templates/binding-json-schemas.test.ts` (coverage + stale-file, same pattern as the existing generated-file tests), `tests/unit/components/events/template/binding-json-validation.test.tsx`

**Interfaces:**

```ts
// binding-schemas.ts (pure)
/** The inlined draft-07 schema of one raw-JSON binding leaf, from a control's document pointer, or null. */
export function bindingFieldSchema(pointer: string): Record<string, unknown> | null;
// pointer examples: /channels/0/bindings/ws/query, /operations/2/bindings/kafka/groupId,
// /messages/1/bindings/kafka/key, /servers/0/bindings/jms/properties/3/value, /channels/0/bindings/sns/policy/statements/1/principal
```

**Behavior:**
- Generator: for each `kind: "json"` binding leaf the generator already knows (24 today), read the binding file with `fs` from `@asyncapi/specs/bindings/<protocol>/<version>/<target>.json` (the version the generator already selects), take the property sub-schema at the field's path, **inline every `$ref`** (local `#/definitions/...` and the absolute `http://asyncapi.com/definitions/3.0.0/*.json` ones, resolved from `@asyncapi/specs/definitions/3.0.0/`), drop `$id`/`$schema`, and emit a plain object into `binding-json-schemas.generated.ts` keyed `<protocol>.<target>.<fieldPath>` with array indexes normalised to `[]`. Never import the `@asyncapi/specs` package root. The output must be small (assert a total size budget in the test) and deterministic (stable key order) so the stale-file test can regenerate and compare.
- `bindingFieldSchema(pointer)`: parse `/(servers|channels|messages|operations)/<n>/bindings/<protocol>/<rest…>`; target = the singular of the collection; normalise numeric segments to `[]`; return the generated entry or `null`. The unknown-protocol fallback and anything not in the map ⇒ `null` (no validation).
- `FieldControl` passes `schema={bindingFieldSchema(path)}` for `kind: "json"` fields whose path is a binding path.
- A **coverage test** fails when a `kind: "json"` leaf in `bindings.generated.ts` has no entry (so a regenerated catalog cannot silently lose validation).

- [ ] **Step 1: Write the failing tests** (every body in full): the lookup for each of the 24 leaves (table-driven from `bindings.generated.ts`), pointer normalisation cases (indexes, nested sns/sqs statements, jms `properties/n/value`), unknown protocol/path ⇒ `null`; the coverage test; the stale-file test (regenerate in memory, compare); a mounted `JsonControl` for `kafka.operation.groupId` with a wrong-typed value shows a schema warning and still writes the value; `anypointmq.message.headers` with a valid object shows none.
- [ ] **Step 2: Run, verify FAIL.** **Step 3: Implement + run the generator** (`npx tsx scripts/generate-asyncapi-templates.ts` or the repo's npm script `gen:asyncapi-templates`) and commit the regenerated files. **Step 4: Run** `npx vitest run tests/unit/lib/events/templates tests/unit/components/events/template` + tsc + eslint. **Step 5: Commit** `feat(events): validate raw JSON binding fields against the AsyncAPI binding schemas`.

---

## WP-V3: Message examples — validation and "Generate from payload"

**Depends on:** V1.

**Files:**
- Create: `src/services/events/pin-json-schema.service.ts`, `src/features/events/builder/use-pin-json-schema.ts`, `src/lib/events/example-from-schema.ts` (pure)
- Modify: `src/app/(dashboard)/schemas/[domainSlug]/[productSlug]/event-actions.ts` (one new read action), `src/features/events/builder/template/controls/types.ts` (`TemplateFormContext` gains an optional `pinSchemas`), `sections/MessagesSection.tsx` (`MessageForm` fills the context per message), `FieldControl.tsx`/`controls/JsonControl.tsx` (a "Generate from payload" button for the example `payload`/`headers` fields)
- Test: `tests/integration/services/events/pin-json-schema.service.test.ts`, `tests/unit/app/event-pin-schema-action.test.ts`, `tests/unit/lib/events/example-from-schema.test.ts`, `tests/unit/components/events/message-example-validation.test.tsx`, `tests/e2e/events-example-validation.spec.ts`

**Interfaces:**

```ts
// service (read-only, tenant-scoped)
export function renderPinJsonSchema(ctx: ServiceContext, input: { tenantId: string; pin: EntityPin }, deps?: { renderer?: ArtifactRenderer }): Promise<Result<{ schema: Record<string, unknown> }>>;
// action (event-actions.ts, `readAction` pattern, productId FIRST like the other read actions)
export async function pinJsonSchemaAction(productId: string, pin: EntityPin): Promise<ActionResult<{ schema: Record<string, unknown> }>>;
// pure
export function exampleFromSchema(schema: Record<string, unknown>): Result<unknown>;   // openapi-sampler `sample(schema, { skipReadOnly: true })`, deterministic, depth-limited
// context
interface TemplateFormContext { /* existing */ pinSchemas?: { payload?: Record<string, unknown> | null; headers?: Record<string, unknown> | null } }
```

**Behavior:**
- Service: ownership — the entity of the pin must belong to the caller's tenant (another tenant's entity reads as `NOT_FOUND`, no name leak); render with `getSharedArtifactRenderer(prisma).render(pin.entityVersionId ? { kind: "version", entityVersionId } : { kind: "draft", entityId }, "json-schema")` (an unpinned pin renders the entity's current draft, as the Code panel does); convert with `downConvertToDraft07`; **size cap 512 KB serialized** → `TOO_LARGE`; render failures map to the generic `ARTIFACT_RENDER_FAILED` message (never raw CLI text, as `event-snapshot.ts` does with `USER_FACING_RENDER_CODES`). The returned schema must be fully inlined (the renderer already inlines).
- Hook `usePinJsonSchema(productId, pin)`: keyed by `entityId:entityVersionId`, caches per page session, drops stale answers, never retries a failure in a loop, returns `null` while loading or on failure (**no stale schema is kept when the pin changes**: the previous pin's schema is dropped immediately).
- `MessageForm` passes `pinSchemas` into the example fields' context: `payload` from `message.payload`, `headers` from `message.headers` when present (else `null`). `FieldControl` gives the matching schema to the example `payload` / `headers` `JsonControl`s (paths `/messages/{i}/examples/{n}/payload|headers`).
- "Generate from payload": a small button beside the example payload/headers editor, enabled when a schema is known; it writes `exampleFromSchema(schema)` as pretty JSON; when the field already has content it asks inline first ("Replace the current example?"); a generation failure shows a short inline message; never throws.
- Trait examples and any message without a pin get no schema.

- [ ] **Step 1: Write the failing tests** (every body in full). Service: renders and converts a stubbed pin; a foreign tenant's entity ⇒ `NOT_FOUND`; oversized ⇒ `TOO_LARGE`; render failure ⇒ generic message; an unpinned pin renders the draft subject. Action: `withOwnedTarget`, UNAUTHORIZED/opaque-code handling like its siblings (add the row to `events-actions-tenant-guard.test.ts`'s real-`withOwnedTarget` table). `exampleFromSchema`: objects, arrays, enums, formats, `$ref`-free nested objects, a recursive-looking schema stays bounded, invalid schema ⇒ error Result. Component: an example whose payload violates the schema shows a warning; a valid one does not; changing the message's payload entity swaps the schema (the old schema's violation disappears); a failed load removes validation; Generate fills a value that the editor then reports as valid; the replace-confirm path. E2E (written, unrun): add an Order entity (with fields) and a message that pins it, add an example, press Generate ⇒ no squiggle, edit a field to the wrong type ⇒ a squiggle.
- [ ] **Step 2: Run, verify FAIL.** **Step 3: Implement.** **Step 4: Run** the new tests + `tests/integration/services/events tests/unit/app tests/unit/components/events tests/unit/lib/events` + tsc + eslint. **Step 5: Commit** `feat(events): validate message examples against their payload schema and generate them`.

---

## WP-I2: Import service and actions

**Depends on:** I1.

**Files:**
- Create: `src/services/events/asyncapi-import.service.ts`, `src/services/events/import-payload-entities.ts`
- Modify: `src/app/(dashboard)/schemas/[domainSlug]/[productSlug]/event-actions.ts` (two actions)
- Test: `tests/integration/services/events/asyncapi-import.service.test.ts`, `tests/unit/app/event-import-actions.test.ts`

**Interfaces:**

```ts
export interface AsyncApiImportInput { content: string; fileName?: string; eventName?: string }
export interface AsyncApiImportPreview {
  eventName: string;                      // resolved, unique
  title: string;
  counts: { servers: number; channels: number; messages: number; operations: number; traits: number; securitySchemes: number };
  entities: Array<{ requestedName: string; name: string; renamed: boolean; fields: number; format: "json-schema" | "avro" | "protobuf" | "placeholder" }>;
  builtInTraits: string[];                // e.g. ["CloudEvents"]
  warnings: ImportWarning[];
}
export function previewAsyncApiImport(productId: string, input: AsyncApiImportInput, ctx: ServiceContext): Promise<Result<AsyncApiImportPreview>>;
export function importAsyncApi(productId: string, input: AsyncApiImportInput, ctx: ServiceContext): Promise<Result<{ eventId: string; preview: AsyncApiImportPreview }>>;
// actions (productId FIRST, `readAction` for preview, `runMutation` + `withOwnedTarget` for import)
export async function previewAsyncApiImportAction(productId: string, input: AsyncApiImportInput): Promise<ActionResult<AsyncApiImportPreview>>;
export async function importAsyncApiAction(productId: string, input: AsyncApiImportInput): Promise<ActionResult<{ eventId: string; preview: AsyncApiImportPreview }>>;
```

**Behavior (read first: `import.service.ts` `importSchemaAssets`, `multi-asset.ts`, `import-payload.ts` `buildImportAssetsPayload`, the bulk action `createDomainAssetsFromImportAction` and `createProductEntity` in `schemas/[domainSlug]/actions.ts`, `name-registry.service.ts`, `event.service.ts`, `bundled-traits.service.ts`, `asyncapi-parser-validator.ts`):**
1. Ownership first (`withOwnedTarget`), then `parseAsyncApiSource` (I1; `TOO_LARGE`/`UNSUPPORTED_VERSION`/`PARSE_ERROR` pass through). Then validate with `createAsyncApiParser().validate(content)`: any **error** diagnostic ⇒ `VALIDATION_ERROR` with the diagnostics (message + pointer) in `details`, **nothing created**; warnings/info go to the report. Remote refs stay disabled.
2. `extractPayloads` ⇒ for each payload pick the existing importer by `format`: `json-schema` → `parseJsonSchemaDocument`, `avro` → `parseAvroDocument`, `protobuf` → `parseProtobufDocument`; `MultiEntityImportResult.entities` (root + definitions) become the entities of that payload; `unsupported`/`none`/importer failure ⇒ a **placeholder entity with no fields** + `UNSUPPORTED_PAYLOAD_FORMAT`/`NO_PAYLOAD` warning (decision 4). The root is `rootEntityName`.
3. **Names:** resolve every entity name to a unique one before writing: not taken in the product's uniqueness line (read through `name-registry.service.ts`), not taken by another entity of the same import, valid entity-name characters; a changed name ⇒ suffix `2`, `3`, … and an `ENTITY_RENAMED` warning. The event name = `input.eventName` or the slug of `info.title`, resolved the same way (the event name shares the line with entities, so it is resolved AFTER the entity names).
4. **Create entities** by calling the existing bulk import action/logic once per payload with the already-unique names (so it never hits its "already exists — skipped" path) and `sourceFormat` set, `productId` of the target; then look the created root entity up by `(tenantId, productId, name)` to get its id (the action returns no name→id map). Do not duplicate TypeSpec-source generation. Pins are `{ entityId, entityVersionId: null }`.
5. Built-in trait ids for the tenant via `ensureBundledTraits` + a query on the marker (`bundledMarker(spec)`, `domainId`/`productId` null), never by name.
6. `createEvent` then `updateEventDocument` with the mapped document (I1). **Compensation:** if `createEvent` or `updateEventDocument` fails after entities were created, delete the created entities (`deleteEntity`) in reverse order and, if a delete fails, add that to the error's `details` (never hide it). `previewAsyncApiImport` runs steps 1-3 and 5 without writing anything and returns the preview.
7. All unexpected throws become generic `INTERNAL_ERROR` text; no raw database or parser text reaches the browser.

- [ ] **Step 1: Write the failing integration tests** (stub nothing but the AsyncAPI parser if it is slow; use `createProductScope`, register EVERY domain id for cleanup, clean up created entities/events): importing each I1 fixture end to end creates the entities (unpublished, `metadata.sourceFormat` set, fields present) and an event whose document parses and pins them; **invalid AsyncAPI ⇒ nothing created** (count entities/events before/after); preview writes nothing; two payloads with the same name ⇒ suffixed + warning; importing the same file twice ⇒ second renamed, no error; a name already in the product ⇒ renamed; the event title already taken ⇒ resolved; **compensation:** force `updateEventDocument` to fail (mock/spy on that call) ⇒ the created entities are gone and the error says so; oversize, external ref, alias bomb ⇒ rejected, nothing created; a foreign product/tenant ⇒ FORBIDDEN/NOT_FOUND with no leak; the CloudEvents fixture maps to the built-in trait id of the tenant; an unsupported payload ⇒ placeholder entity + warning; the imported event then publishes after its entities are published (use `publishEntity` then `publishEvent` with the stub renderer — proves the pins work).
- [ ] **Step 2: Run, verify FAIL.** **Step 3: Implement.** **Step 4: Run** `tests/integration/services/events tests/integration/services tests/unit/app tests/unit/lib/events/import` + tsc + eslint. **Step 5: Commit** `feat(events): import an AsyncAPI 3.0 document as an event with draft payload entities`.

---

## WP-I3: Import UI

**Depends on:** I2 (code against the interfaces above; component tests mock the actions, so I3 can start with I2).

**Files:**
- Create: `src/features/events/workspace/ImportAsyncApiDialog.tsx`, `src/features/events/workspace/import-labels.ts`, `src/features/events/workspace/use-asyncapi-import.ts`
- Modify: `src/features/events/workspace/NewEventDialog.tsx` (an "Import existing…" link under the form that opens the import dialog; the spec §3 promised it for when the importer exists), the two callers if needed (`domain-workspace.tsx`, `EventsList.tsx`)
- Test: `tests/unit/components/events/import-asyncapi-dialog.test.tsx`, `tests/e2e/events-import.spec.ts`, fixture `tests/fixtures/asyncapi-import/*.yaml` (shared with I1)

**Behavior:**
- Step 1 (input): a textarea (paste) and an **Upload file** control (`.yaml`, `.yml`, `.json`, read with `FileReader.readAsText`, files over 1 MiB rejected client-side with the same message as the server); a **Preview** button, disabled while empty or busy.
- Step 2 (preview): event name input (prefilled with the resolved name, editable), counts, the entity list with a "renamed" badge, the built-in traits that will be used, the grouped warnings (expandable, with pointers), and a short sentence: "Payload entities are created as drafts in this product. Publish them before you publish the event." A validation failure shows the diagnostics list (message + pointer) and no Import button. **Back** and **Import**.
- Step 3: Import is single-flight; success ⇒ toast, `invalidateDomainsTree()`, navigate to the new event (`assetHref({ kind: "event", … })`, as `NewEventDialog` callers do); failure ⇒ the error text and the sentence "Nothing was created." (the server compensates; if the error carries a rollback failure, say which entities remain).
- Accessible: labelled inputs, focus moves to the first control of each step, Escape closes unless busy, errors in `role="alert"`; strings from `import-labels.ts`; Playwright test ids on every control.

- [ ] **Step 1: Write the failing tests** (every body in full): paste → preview shows the mocked counts/warnings/renamed entities; upload reads a file and fills the textarea; an oversize file is refused; a validation failure shows diagnostics and hides Import; edit event name is sent; success navigates and invalidates; a failed import shows "Nothing was created."; Import is disabled while busy and cannot double-submit; Escape is ignored while busy; "Import existing…" opens the dialog from `NewEventDialog`. E2E `events-import.spec.ts` (written, unrun; reuse `tests/e2e/helpers/event-builder.ts`): open New Event → Import existing… → upload the fixture with `setInputFiles` → the preview shows the counts → Import → lands on the event page, the builder shows the imported server/channel/message/operation, the entities appear in the explorer as unpublished drafts, the Code panel shows the document; a second import of the same file renames; an invalid file shows the diagnostics.
- [ ] **Step 2: Run, verify FAIL.** **Step 3: Implement.** **Step 4: Run** `tests/unit/components/events tests/unit/features/events` + tsc + eslint. **Step 5: Commit** `feat(events): import an AsyncAPI document from the New Event dialog`.

---

## WP-D: Docs, memory, verification, merge

- [ ] `docs/events/REVIEW.md`: §1 (importer, validation), §3 table rows, §4 tests list (new specs), §6 (importer and JSON lint are no longer gaps; AsyncAPI 3.0 only; the "Advanced has no raw JSON" note); the spec header and §3 "Import existing…"; this plan marked done.
- [ ] Memory: `events-self-contained-redesign.md` (what is built, what the user decided).
- [ ] Verification on the merged branch: `npx tsc --noEmit`; repo ESLint JSON count equals `main`'s; full `npx vitest run tests/unit tests/integration` (baseline only); `npx next build --webpack` **and a check that `codemirror-json-schema`/`shiki` are not in the first-load JS of the event page** (compare the build's route size table with `main`); Playwright: the whole `tests/e2e` directory on the integration build (stop the :3000 dev server first, restore it after the merge); open the importer and an example with a schema in a browser and look at them.
- [ ] Merge `--no-ff` into `main` (no trailer; check overlap with main's local uncommitted files first), `npx prisma generate`, restart the dev server, remove the worktrees/branches, archive the ledger and reports to `~/super-schema-backups/`, final summary with every ruling.

## Exit check

- [ ] Every WP's tests pass; baseline failures unchanged; `tsc` and ESLint clean.
- [ ] `git diff main --stat -- prisma package.json package-lock.json` is empty (no migration, no dependency change on the branch).
- [ ] `git log main..HEAD --format=%B | grep -ciE 'co-authored-by|generated with'` prints `0`.
- [ ] Review Focus items 1–7 each map to a passing named test (or, for the bundle item, the build size comparison).

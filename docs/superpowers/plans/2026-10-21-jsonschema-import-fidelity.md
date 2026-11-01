# JSON Schema Import Fidelity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make JSON Schema import lossless and spec-correct: vendor extension
keys (`x-*`) round-trip through TypeSpec, `allOf`/`anyOf`/`oneOf` map per the
JSON Schema 2020-12 spec instead of "take the first member," and `$ref`
targets resolve through a real library (relative paths, URLs, our internal
git hosts) instead of filename-guessing — with unreachable targets flagged
live as dangling references rather than silently mis-named.

**Architecture:** All three problems are fixed inside the existing
`jsonschema.importer.ts` → `MultiEntityImportResult` → `multi-asset.ts` →
`import-payload.ts` → `createImportedEntities`/`createDomainAssetsFromImportAction`
pipeline every importer already shares. No new persistence layer: entity
inheritance (`extends` → `parentEntityId`), union types (`UnionType` Prisma
model), and field decorator extensions (`Field.decorators` JSON) are all
already wired end-to-end for the TypeSpec import path — this plan makes the
JSON Schema importer populate the same fields, plus adds a `$ref`-resolution
step ahead of the importer for remote/cross-file documents.

**Tech Stack:** TypeScript, `@apidevtools/json-schema-ref-parser` (new
dependency), existing TypeSpec compiler/parser/generator, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-20-vendor-extension-roundtrip-design.md`
(three parts + two addenda — read alongside this plan; this plan does not
repeat the spec's reasoning, only the decisions that bind implementation).

## Global Constraints

- No Prisma migration — every new piece of data lands in an existing JSON
  column (`Field.decorators`, `Entity.metadata`) or an existing scalar
  relation (`Entity.parentEntityId`, `UnionType` rows).
- Every generic extension emits **both** `@TypeSpec.JsonSchema.extension(...)`
  and `@TypeSpec.OpenAPI.extension(...)` — never the bare `@extension(...)`
  form for new code (legacy bare form stays readable for backward
  compatibility, per spec Addendum).
- `x-tags` and `x-classification` are always excluded from the generic
  extensions bag — they keep their existing dedicated round-trip
  (`metadata.tags`, field `classification`).
- Before adding any new TypeSpec-side construct, check
  https://typespec.io/docs/language-basics/overview/ (and the specific
  sub-page) for an existing language feature or official `@typespec/*`
  decorator first. Do not hand-roll something TypeSpec or an official
  package already expresses.
- Must not regress `tests/unit/lib/importers/jsonschema.importer.test.ts`,
  `jsonschema-document.test.ts`, `jsonschema-literals.test.ts`, or any
  `typespec.importer`/`typespec-parser`/`typespec-generator` test.
- `@apidevtools/json-schema-ref-parser` is used via `resolve()`/`bundle()`,
  never `dereference()` — dereferencing inlines `$ref` targets, which
  destroys the "each `$ref` target is its own entity" requirement.

## Review Focus

- A document whose root is the `allOf: [{$ref}, {properties}]`
  inheritance shape (real case: Acme's `address.json`) must produce an
  entity with `extends` set *and* fields from the inline member — not just
  the first `allOf` member, which is what today's code does.
- A field-level extension whose value is a nested object
  (`x-visibility: {extent: "EXTERNAL"}`) must survive generate → reparse
  unchanged — not stringified, not flattened to `"[object Object]"`.
- A `$ref` that 404s, or whose host has no configured resolver, must fail
  only that one field (dangling-reference warning) — never the whole import.
- Two files in different directories sharing a basename (common in the
  Acme schema set — e.g. multiple `*_status.json` siblings under different
  parents) must not collide into the same entity now that resolution is by
  real resolved URI instead of guessed basename.
- `oneOf`/`anyOf` members that are a mix of `$ref`s and inline
  primitives/objects (not all named refs) must fall back to today's
  low-confidence single-type behavior, not throw or build a partial/broken
  union.

---

### Task 1: Widen extension value types + generic key capture in the JSON Schema importer

**Files:**
- Modify: `src/lib/importers/types.ts` — `ParsedField.extensions` from
  `Record<string, string>` to `Record<string, unknown>`; add
  `ParsedEntity.extensions?: Record<string, unknown>` and
  `ParsedEntity.extends?: string` (mirrors `TypeSpecImportModel.extends`,
  `typespec.importer.ts:53-60`).
- Modify: `src/lib/importers/jsonschema.importer.ts` — `buildFields`,
  `parseJsonSchemaDocument`/`importJsonSchemaDocument`.
- Test: `tests/unit/lib/importers/jsonschema-extensions.test.ts` (new file).

**Interfaces:**
- Consumes: nothing new from other tasks.
- Produces: `ParsedField.extensions: Record<string, unknown>`,
  `ParsedEntity.extensions?: Record<string, unknown>`,
  `ParsedEntity.extends?: string` — every later task in Part 1 and the
  persistence wiring (Task 4) reads these exact names.

- [ ] **Step 1: Write the failing test** — a root schema with an unknown
  root-level key (`x-links`) and a property with an unknown key
  (`x-deprecated-reason`) imports with `entity.extensions === { "x-links":
  [...] }` and `field.extensions === { "x-deprecated-reason": "..." }`,
  object values preserved as objects (not stringified).

```ts
const result = parseJsonSchemaDocument(JSON.stringify({
  title: "Thing",
  type: "object",
  properties: { name: { type: "string" }, "legacy": { type: "string", "x-deprecated-reason": "use name" } },
  "x-links": [{ rel: "self", href: "https://x" }],
}));
expect(result.data?.entities[0].extensions).toEqual({ "x-links": [{ rel: "self", href: "https://x" }] });
expect(result.data?.entities[0].fields.find(f => f.name === "legacy")?.extensions)
  .toEqual({ "x-deprecated-reason": "use name" });
```

- [ ] **Step 2: Run test to verify it fails** — `npx vitest run tests/unit/lib/importers/jsonschema-extensions.test.ts`. Expected: FAIL (`extensions` undefined).
- [ ] **Step 3: Implement the allow-list and capture.** In
  `jsonschema.importer.ts`, define a `const KNOWN_SCHEMA_KEYWORDS = new
  Set([...])` enumerated from the current `JsonSchemaNode` interface fields
  (`$schema, $id, $ref, title, description, type, format, properties,
  required, items, enum, const, deprecated, default, oneOf, anyOf, allOf,
  minLength, maxLength, pattern, minimum, maximum, exclusiveMinimum,
  exclusiveMaximum, minItems, maxItems, $defs, definitions`) plus
  `"x-tags"` and `"x-classification"` (excluded, not captured generically).
  Add a helper `captureExtensions(node: JsonSchemaNode): Record<string,
  unknown> | undefined` returning every other key verbatim, `undefined`
  when none. Call it in `buildFields` for each property node → `field.extensions`,
  and at the document root (where `properties`/`$defs` are read) →
  `entity.extensions` on the entity this root produces.
- [ ] **Step 4: Run test to verify it passes.**
- [ ] **Step 5: Commit.**

```bash
git add src/lib/importers/types.ts src/lib/importers/jsonschema.importer.ts tests/unit/lib/importers/jsonschema-extensions.test.ts
git commit -m "feat(import): capture unknown JSON Schema keys as extensions"
```

---

### Task 2: TypeSpec generator emits generic `@extension` decorators (field + model)

**Files:**
- Modify: `src/lib/compiler/typespec-generator.ts` — `generateModelDecorators`
  (~L367), `generateFieldDecorators` (~L723-844), `governanceImportLines`
  (~L356-365).
- Test: `tests/unit/lib/compiler/typespec-generator-extensions.test.ts` (new).

**Interfaces:**
- Consumes: `field.decorators.typespec.extensions.openapi:
  Record<string, unknown>` (already populated today via
  `decorator-builder.ts:70-72`); `model.entity.metadata.extensions?.openapi:
  Record<string, unknown>` (new — Task 4 writes this on create; this task
  only needs the shape).
- Produces: a shared helper `typeSpecValueLiteral(value: unknown): string`
  (string → `"..."`, array → `#[...]`, object → `#{...}`, number/boolean →
  bare, `null` → `null`) — exported from `governance-decorators.ts` so
  Task 3's parser work and any future caller use the same literal grammar.

- [ ] **Step 1: Write the failing test** — a `SuperSchemaModel` field with
  `decorators.typespec.extensions.openapi = { "x-visibility": { extent:
  "EXTERNAL" } }` generates both:
  ```
  @TypeSpec.JsonSchema.extension("x-visibility", #{extent: "EXTERNAL"})
  @TypeSpec.OpenAPI.extension("x-visibility", #{extent: "EXTERNAL"})
  ```
  immediately above the field, and the generated document's preamble
  contains `import "@typespec/json-schema";` and `import "@typespec/openapi";`
  exactly once each. A model with `metadata.extensions.openapi` set produces
  the same pair above the `model` line.
- [ ] **Step 2: Run test to verify it fails.**
- [ ] **Step 3: Implement `typeSpecValueLiteral(value: unknown): string`**
  in `governance-decorators.ts` (reuse `escapeTypeSpecString`, follow the
  exact array convention `tagsDecorator` already uses at L121-124). Add
  `genericExtensionDecorators(extensions: Record<string, unknown> | undefined,
  exclude: readonly string[]): string[]` returning the dual-decorator-line
  pairs, skipping `TAGS_EXTENSION_KEY`/`CLASSIFICATION_EXTENSION_KEY`. Call
  it from `generateFieldDecorators` and `generateModelDecorators`. Extend
  `governanceImportLines` to also add `"@typespec/json-schema"` /
  `"@typespec/openapi"` imports whenever any generic extension is present
  (field or model), independent of the `governance.enabled` flag — generic
  extension passthrough is not a governance feature and must not be gated
  by it.
- [ ] **Step 4: Run test to verify it passes.**
- [ ] **Step 5: Commit.**

---

### Task 3: TypeSpec parser widens `@extension` value grammar + model-level capture

**Files:**
- Modify: `src/lib/compiler/typespec-parser.ts` — `parseDecoratorLine`
  (~L930-1080), the model-declaration branch (~L431-460).
- Test: `tests/unit/lib/compiler/typespec-parser-extensions.test.ts` (new).

**Interfaces:**
- Consumes: `typeSpecValueLiteral`'s inverse is needed here — write a
  co-located `parseTypeSpecValueLiteral(raw: string): unknown` in the same
  file (string literal, `#[...]`, `#{...}`, number, boolean, `null`).
- Produces: `ParsedTypeSpecDecorators.extensions: Record<string, unknown>`
  (value type widened from `string` — check every other reader of this
  field in this file compiles against `unknown`), and a new
  `collectModelExtensions(lines, idx): Record<string, unknown> | undefined`
  alongside `collectModelTags`, feeding `ParsedTypeSpecModel.extensions` →
  (Task 5 wires this into `TypeSpecImportModel`/`ParsedEntity`).

- [ ] **Step 1: Write the failing test** — parsing
  `@TypeSpec.JsonSchema.extension("x-visibility", #{extent: "EXTERNAL"})`
  and `@TypeSpec.OpenAPI.extension("x-visibility", #{extent: "EXTERNAL"})`
  (field-level, either one alone or both together) yields
  `decorators.extensions === { "x-visibility": { extent: "EXTERNAL" } }`
  (object, not string). The legacy bare `@extension("k", "v")` form still
  parses to `{ k: "v" }` (regression check for existing behavior).
- [ ] **Step 2: Run test to verify it fails.**
- [ ] **Step 3: Implement.** Extend the `@extension(...)` regex (or switch
  to a small manual split on the first `,` at paren-depth 0, since a
  `#{...}` value can itself contain commas) to accept
  `@extension(...)`, `@TypeSpec.JsonSchema.extension(...)`, and
  `@TypeSpec.OpenAPI.extension(...)` as the same construct, and route the
  second argument through `parseTypeSpecValueLiteral`. Add
  `collectModelExtensions` beside `collectModelTags` (same lookup pattern),
  called from the model-declaration branch, assigned to
  `ParsedTypeSpecModel.extensions`.
- [ ] **Step 4: Run test to verify it passes; run full
  `typespec-parser`/`typespec.importer` suites to confirm no regression**
  (`npx vitest run tests/unit/lib/compiler/typespec-parser.test.ts
  tests/unit/lib/importers/typespec.importer.test.ts`).
- [ ] **Step 5: Commit.**

---

### Task 4: Wire extensions through to persistence (entity + field)

**Files:**
- Modify: `src/lib/importers/typespec.importer.ts` — `TypeSpecImportModel`
  (~L53-60, add `extensions?: Record<string, unknown>`), the model-mapping
  function that builds it from `ParsedTypeSpecModel`.
- Modify: `src/lib/importers/import-payload.ts` — `toModelInput`/`toEntityInput`
  (~L44-59): add `extensions: model.extensions`.
- Modify: `src/services/imported-entities.ts` — `ImportedEntityInput`
  (~L12-19, add `extensions?: Record<string, unknown>`), the `entityMetadata`
  object (~L106-109): add
  `...(entity.extensions && Object.keys(entity.extensions).length > 0 ? { extensions: { openapi: entity.extensions } } : {})`
  (nests under `openapi` to mirror `ExtensionsDecorators.openapi`'s shape so
  `compiler.service.ts`/the generator read entity extensions the same way
  they read field extensions).
- Test: `tests/unit/services/imported-entities-extensions.test.ts` (new, or
  extend an existing imported-entities test file if one already covers this
  loop — check before creating a new file).

**Interfaces:**
- Consumes: `ParsedEntity.extensions` (Task 1), `ParsedField.extensions`
  (Task 1, already flows through `buildDecoratorsFromParsedField` —
  confirm with a test, don't re-wire what already works).
- Produces: `Entity.metadata.extensions.openapi` populated on create,
  readable the same way `compiler.service.ts:88-93` reads
  `metadata.custom.*` today (confirm whether entity-level extensions should
  live under `metadata.custom.extensions` or `metadata.extensions` — check
  `compiler.service.ts`'s `SuperSchemaEntityMetadata` type for the actual
  expected key before picking; match whatever `metadata.custom.tags`'s
  sibling fields do, don't invent a third convention).

- [ ] **Step 1: Write the failing test** — importing a `ParsedEntity` with
  `extensions: { "x-links": [...] }` and a field with
  `extensions: { "x-visibility": {...} }` through
  `createImportedEntities` persists `Entity.metadata` containing the
  entity extensions and `Field.decorators.typespec.extensions.openapi`
  containing the field extensions (field path: confirm by test, not by
  re-reading code, since Task 1/`decorator-builder.ts` should already
  cover it).
- [ ] **Step 2: Run test to verify it fails** (entity side only, if field
  side already passes — note which).
- [ ] **Step 3: Implement the entity-side wiring** per the Files list
  above.
- [ ] **Step 4: Run test to verify it passes.**
- [ ] **Step 5: Commit.**

---

### Task 5: `allOf` → merge semantics + entity-level `extends` detection

**Files:**
- Modify: `src/lib/importers/jsonschema.importer.ts` — `resolveSchemaType`'s
  combinator branch (~L298-321), `isObjectSchema`/`indexDefinitions`/the
  per-document entity-building loop (wherever a `$defs` entry or the
  document root becomes a `ParsedEntity`).
- Test: `tests/unit/lib/importers/jsonschema-allof.test.ts` (new).

**Interfaces:**
- Consumes: `ParsedEntity.extends` (Task 1).
- Produces: nothing new consumed elsewhere; self-contained within the
  importer.

- [ ] **Step 1: Write the failing tests** (several cases, one `it` each):
  1. Root schema `{ allOf: [{$ref: "#/$defs/Base"}, {type: "object",
     properties: {id: {type: "string"}}}] }` with `Base` in `$defs` →
     entity has `extends === "Base"` and a field `id` (not just `Base`'s
     fields, not just the inline member's).
  2. Property-level `{ allOf: [{$ref: "#/$defs/Status"}, {description:
     "the status"}] }` → field resolves as `type: "reference",
     referencedEntityName: "Status"`, `description: "the status"` (today:
     description is silently dropped).
  3. `allOf` with two members both contributing constraints
     (`[{minLength: 1}, {maxLength: 10}]`, no `$ref`) → both constraints
     present on the resolved field.
  4. `allOf: [{$ref: A}, {$ref: B}]` (two refs, no inline object) → entity
     `extends === A`'s name; a warning naming `B` as "not representable as
     a second base, fields not merged" is pushed (don't silently drop B
     either — flag it, per the design's documented approximation).
- [ ] **Step 2: Run tests to verify they fail.**
- [ ] **Step 3: Implement.** Replace the "take first member" combinator
  logic for `allOf` specifically (leave `oneOf`/`anyOf` for Task 6) with:
  split members into annotation-only (`description`, `title`, `deprecated`,
  and anything in Task 1's extension allow-list) vs. constraining
  (everything else); if exactly one constraining member is a `$ref` to an
  object entity and another constraining member has `properties`, this
  node is entity-shaped — surface that back to the caller (the function
  building entities from `$defs`/document-root, not `resolveSchemaType`
  itself, needs to detect this shape before calling `buildFields` normally)
  so it sets `extends` and feeds the inline member's properties through the
  existing `buildFields`; otherwise resolve as today's reference/type
  merge, folding every annotation-only member's keys onto the result.
- [ ] **Step 4: Run tests to verify they pass; run the full
  `jsonschema.importer`/`jsonschema-document` suites.**
- [ ] **Step 5: Commit.**

---

### Task 6: `oneOf`/`anyOf` → `UnionType` wiring

**Files:**
- Modify: `src/lib/importers/types.ts` — add
  `MultiEntityImportResult.unions?: Array<{ name: string; memberTypes:
  string[]; description?: string }>` (same shape as
  `typespec.importer.ts:91` — reuse, don't redefine).
- Modify: `src/lib/importers/jsonschema.importer.ts` — `resolveSchemaType`'s
  `oneOf`/`anyOf` handling.
- Modify: `src/lib/importers/multi-asset.ts` — `toAssetImportResult` (~L103):
  `unions: (doc.unions ?? []).map((u) => ({ ...u }))` instead of the
  hardcoded `[]`.
- Modify: `src/lib/importers/types.ts` — add `ParsedField.unionName?:
  string` (mirrors `enumName`); set `field.type = "union"` when this is
  populated.
- Test: `tests/unit/lib/importers/jsonschema-unions.test.ts` (new).

**Interfaces:**
- Consumes: nothing new.
- Produces: `MultiEntityImportResult.unions`, `ParsedField.unionName`,
  `ParsedField.type === "union"` — Task 9's end-to-end test is the first
  consumer of the full chain through to a generated `.tsp` file.

- [ ] **Step 1: Write the failing test** — a property
  `{ oneOf: [{$ref: "#/$defs/Cat"}, {$ref: "#/$defs/Dog"}] }` (both named
  `$defs` entries) produces: the field has `type: "union"`, `unionName`
  set to a generated name (e.g. `"<EntityName>_<fieldName>_Union"`,
  disambiguated the same way `indexDefinitions` already suffixes
  `_2`/`_3`); `MultiEntityImportResult.unions` contains one entry with
  `memberTypes: ["Cat", "Dog"]`. A second test: `oneOf` with one `$ref`
  member and one inline `{type: "string"}` member (not all named refs) →
  today's low-confidence single-type fallback, no union created.
- [ ] **Step 2: Run test to verify it fails.**
- [ ] **Step 3: Implement** the all-named-refs detection in the
  `oneOf`/`anyOf` branch; push the union onto a result accumulator the
  importer already threads through (same place `enums`/`scalars` get
  collected for the final `MultiEntityImportResult`).
- [ ] **Step 4: Run test to verify it passes.**
- [ ] **Step 5: Verify the generator renders a bare custom type name
  correctly.** Write one more test: a `SuperSchemaField` with
  `type: "union"`-equivalent (check how `enumName`/`referencedEntityName`
  fields currently get their type name into generated TypeSpec via
  `decorator-builder.ts`/`typespec-generator.ts`, and give the union field
  the same treatment) generates `fieldName: UnionName;` in the output
  `.tsp`. If this fails, fix the generator's fallback for an unrecognized
  type string to emit it verbatim as a type reference — this is the one
  step in this task where the existing code's behavior isn't yet confirmed
  and may need a small fix, not just new code.
- [ ] **Step 6: Commit.**

---

### Task 7: Adopt `@apidevtools/json-schema-ref-parser` with a custom internal-git-host resolver

**Files:**
- Modify: `package.json` — add `@apidevtools/json-schema-ref-parser`.
- Create: `src/lib/importers/jsonschema-ref-resolver.ts` — the custom
  resolver plugin + a `resolveJsonSchemaRefs(rootUrl: string, rootContent:
  string): Promise<{ resolved: Map<string, unknown>; unreachable: Map<string,
  string> }>` entry point (`resolved` keyed by absolute URI → parsed JSON;
  `unreachable` keyed by the `$ref` string → failure reason, feeding Task 8's
  dangling-reference handling).
- Test: `tests/unit/lib/importers/jsonschema-ref-resolver.test.ts` (new,
  mock `gh api` calls — do not hit the network in unit tests).

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `resolveJsonSchemaRefs` — Task 8's server action is the only
  consumer.

- [ ] **Step 1: Write the failing test** — using a mocked resolver (inject
  a fake fetch/exec function, don't shell out in the test), resolving a
  root document with one relative `$ref` to a reachable sibling and one to
  an unreachable path returns both the resolved sibling's content in
  `resolved` and the unreachable path in `unreachable`, without throwing.
- [ ] **Step 2: Run test to verify it fails.**
- [ ] **Step 3: Implement.** `resolveJsonSchemaRefs` configures
  `@apidevtools/json-schema-ref-parser`'s `resolve()` with a custom
  `options.resolve` entry per supported scheme: a `github-enterprise`
  resolver matching a configurable list of internal hostnames (start with
  `github.example.com`), translating a resolved URI's path back into
  `gh api --hostname <host> repos/<owner>/<repo>/contents/<path>?ref=<branch>`
  (owner/repo/branch parsed from the *root* document's own source URL,
  passed in by the caller — never hardcoded); a default resolver for plain
  `https://`. A resolution failure (non-2xx, no `gh auth` session, unknown
  host) is caught per-`$ref` and recorded in `unreachable`, never thrown
  to the caller. Cap transitive resolution at a fixed file count (reuse
  the spirit of `MAX_REF_DEPTH`, e.g. 500 files) and reject cycles (the
  library detects these; surface a clear error rather than hanging).
- [ ] **Step 4: Run test to verify it passes.**
- [ ] **Step 5: Commit.**

---

### Task 8: Server action for URL-based import + dangling-reference entity naming

**Files:**
- Create: `src/app/(dashboard)/schemas/[domainSlug]/jsonschema-url-import-actions.ts`
  (`"use server"`, follow the pattern in `openapi-import-actions.ts`:
  size/timeout guard, sanitized errors).
- Modify: `src/lib/importers/jsonschema.importer.ts` — accept an optional
  pre-resolved file map (from Task 7) so each resolved file is run through
  the existing root-schema-to-entity path once, keyed by resolved URI
  instead of guessed basename for cross-file name resolution.
- Test: `tests/unit/lib/importers/jsonschema-url-import.test.ts` (new,
  feeding a hand-built resolved-file map, no network).

**Interfaces:**
- Consumes: `resolveJsonSchemaRefs` (Task 7).
- Produces: `importJsonSchemaFromUrlAction(url: string):
  Promise<Result<MultiEntityImportResult>>` — Task 9's UI calls this.

- [ ] **Step 1: Write the failing test** — a hand-built two-file resolved
  map (root + one sibling reachable, one `$ref` marked unreachable) run
  through the updated importer produces two entities (root + sibling, both
  from real content, not basename stubs) and one field whose
  `referencedEntityName` matches the unreachable `$ref`'s best-effort name
  while `originalType` still carries the full original `$ref` string.
- [ ] **Step 2: Run test to verify it fails.**
- [ ] **Step 3: Implement** the multi-file entity-building loop and the
  server action wrapping `resolveJsonSchemaRefs` + the importer, with a
  timeout (reuse `withCompileTimeout` from `import-limits.ts`) and a
  bounded concurrency setting for the resolver's fetches.
- [ ] **Step 4: Run test to verify it passes.**
- [ ] **Step 5: Commit.**

---

## Amendment 2026-10-22 — follow-on tasks from the user's first hands-on test

Research finding that changes Task 9's original target: `ImportDialog`,
`ImportReviewScreen` and `BulkImportReviewScreen` are NOT mounted anywhere in
`src/`. The live import flow is `SchemaWorkbench` (paste/upload/build) ->
`EntityCreationWizard.handleImportSubmit` -> `FieldPreview` (single entity) or
`TypeSpecImportReviewScreen` (multi-asset via `toAssetImportResult`). All UI
work below targets those, not the dialog. Reusable pieces: `JsonEditor`
(CodeMirror 6, `src/features/events/builder/template/controls/JsonEditor.tsx`
with `codemirror-setup.ts`; props `language`, `readOnly`, `onChange`, `height`;
no other module may import `@codemirror/*`, a test enforces it) and
`src/lib/syntax-highlight.tsx` (`highlightLine(line, lang)`).

User decisions: the classification extension key and value mapping live in a
config module with an env override (no DB migration); a missing target input
(e.g. primary key) is asked at emit time and the answer is SAVED on the
entity's fields.

### Task 9: Syntax-highlighted paste box and Detail Panel

**Files:**
- Modify: `src/components/custom/SchemaWorkbench/SchemaWorkbench.tsx` (paste
  mode, ~L398, plain `<textarea data-testid="workbench-paste-textarea">`) and
  `src/components/custom/SchemaWorkbench/DetailPanel.tsx` (plain transparent
  `<textarea data-testid="detail-panel-textarea">` with a red line-diff
  backdrop from `diffLines` when a baseline exists).
- Modify: `src/features/events/builder/template/controls/codemirror-setup.ts`
  (+ `JsonEditor.tsx` if needed) — add an opt-in line-decoration extension for
  the Detail Panel's changed-line highlight. No other file may import
  `@codemirror/*`.
- Test: `tests/unit/components/schema-workbench.test.tsx` (extend) and the
  JsonEditor tests.

**Interfaces:**
- Consumes: `JsonEditor` props (`language: "json" | "yaml"`, `readOnly`,
  `onChange`, `height`, optional `schema`).
- Produces: nothing downstream; keeps the test ids
  `workbench-paste-textarea` / `detail-panel-textarea` working (jsdom falls
  back to a textarea carrying the same ids so existing unit/e2e tests keep
  passing) and keeps the existing edit/diff behavior of the Detail Panel.

- [ ] **Step 1:** failing tests — the paste area and the Detail Panel render
  through `JsonEditor` (colored tokens in a real browser build; in jsdom the
  textarea fallback with the same test ids), YAML/JSON language follows the
  detected format, the Detail Panel still reports edits (`onChange`) and
  marks changed lines against the baseline.
- [ ] **Step 2:** implement; keep behavior parity (paste, load, review
  buttons, baseline diff). Verify in a browser (start the dev server, load a
  JSON Schema, confirm syntax colors, line numbers and the changed-line
  highlight) — type checks and unit tests do not prove this one; say plainly
  if the browser step could not be run.
- [ ] **Step 3:** run the touched suites; commit.

---

### Task 10: Field-level data security classification as a standard feature (configurable key)

**Files:**
- Create: `src/lib/importers/classification-config.ts` — typed config:
  `getClassificationConfig(env = process.env)` returning
  `{ extensionKey: string; levelField: string; categoryField: string;
  valueMap: Record<string, string> }`, defaults `extensionKey:
  "x-securityClassification"`, `levelField: "data_class"`, `categoryField:
  "data_category"`, empty `valueMap` (identity: the raw `data_class` string is
  used as the classification level name). Env overrides:
  `SCHEMA_CLASSIFICATION_EXTENSION_KEY`, `SCHEMA_CLASSIFICATION_LEVEL_FIELD`,
  `SCHEMA_CLASSIFICATION_CATEGORY_FIELD`, `SCHEMA_CLASSIFICATION_VALUE_MAP`
  (JSON object string; invalid JSON ignored with a console warning, falling
  back to defaults). Add the new variables to `.env.example`.
- Modify: `src/lib/importers/jsonschema.importer.ts` (`buildFields`, and the
  `$defs`/root property walk), `src/lib/importers/types.ts`,
  `src/lib/importers/decorator-builder.ts`, and the generator/compiler
  read-back as needed.
- Test: `tests/unit/lib/importers/jsonschema-classification.test.ts` (new).

**Interfaces:**
- Consumes: Task 1's `captureExtensions` (the block is a generic extension and
  MUST keep round-tripping losslessly through the existing extensions path).
- Produces: `ParsedField.classification` (the mapped level) and
  `ParsedField.governance.dataClass` / `dataCategory` (extend
  `ParsedFieldGovernance`; stored under `decorators.governance` like the
  existing governance keys) for the review screen (Task 11).

- [ ] **Step 1:** failing tests with the user's block
  `"x-securityClassification": {"data_class": "class4", "data_category":
  "Intrinsic"}` on a property: classification becomes `class4` (identity map),
  `governance.dataCategory === "Intrinsic"`, and the block is STILL present in
  the field's extensions (lossless). With
  `SCHEMA_CLASSIFICATION_VALUE_MAP='{"class4":"PII"}'` the level becomes `PII`;
  with `SCHEMA_CLASSIFICATION_EXTENSION_KEY=x-dataClass` only that key is read;
  a malformed block (not an object, missing `data_class`, non-string values,
  `__proto__` keys) never throws and yields no classification; an unknown level
  string is kept as given (admin-defined levels are free strings) and emitted
  by the existing `x-classification` path for non-Enterprise levels.
- [ ] **Step 2:** implement; no per-request mutable state (read config per
  call); keep hostile-input hygiene (`setOwn`, no `obj[userKey]=v`).
- [ ] **Step 3:** run `npx vitest run tests/unit/lib/importers/
  tests/unit/lib/compiler/`; commit.

---

### Task 11: Import review shows everything (considered, preserved, ignored)

**Files:**
- Modify: `src/components/custom/EntityCreationWizard/FieldPreview.tsx` and
  `EntityCreationWizard.tsx` (`handleImportSubmit` ~L203; it currently forces
  `classification: null` (~L272), `nullable: true` (~L379), `isKey: false`
  (~L380) and drops warnings) and
  `src/components/custom/ImportDialog/TypeSpecImportReviewScreen.tsx` (hides
  per-field description, classification, format, constraints, deprecated,
  extensions, confidence, originalType, referencedEntityName, danglingRef,
  enumValues, unionName, and model-level extensions).
- Modify: `src/lib/importers/jsonschema.importer.ts` + `types.ts` — report what
  the importer did NOT use: add `ParsedField.ignoredKeywords?: string[]` and
  `ParsedEntity.ignoredKeywords?: string[]` for JSON Schema keywords the
  importer recognizes but does not map (`not`, `if`/`then`/`else`,
  `$dynamicRef`, `unevaluatedProperties`, `patternProperties`,
  `additionalProperties` objects, `contentEncoding`, etc.) with one warning per
  distinct keyword naming the entity/field (deferred from Task 5).
- Test: `tests/unit/components/entity-creation-wizard-import.test.tsx`
  (extend), `tests/unit/components/` for `TypeSpecImportReviewScreen`, and
  `tests/unit/lib/importers/jsonschema-ignored.test.ts` (new).

**Interfaces:**
- Consumes: Task 8's `danglingRef`, Task 10's classification/governance,
  Task 1's extensions, Task 6's union fields, Task 5's extends.
- Produces: `ParsedField.ignoredKeywords`, `ParsedEntity.ignoredKeywords`; a
  shared presentational component (new file under
  `src/components/custom/ImportDialog/`, e.g. `ParsedFieldDetails.tsx`) both
  screens use.

- [ ] **Step 1:** failing tests: each screen renders, for every field, ALL of
  name, type, original type, nullable/required, key, description, format,
  constraints (min/max/pattern/exclusive bounds), deprecated, classification
  (level + data category), enum values, reference/array/union details, extends,
  extensions (key + JSON value, collapsed by default but present in the DOM),
  confidence, dangling-reference badge with reason, ignored keywords; entity
  level: description, extends, extensions, warnings (all of them, none
  truncated). Imported `nullable`, `isKey` and `classification` are no longer
  overwritten with constants by the wizard. Sections are labeled
  "Used", "Preserved (kept, not interpreted)" and "Ignored (not supported)".
- [ ] **Step 2:** implement the shared details component and wire both
  screens; color-code the three groups consistently with the design tokens
  already used in the app (Tailwind classes with the custom tokens; no new
  palette).
- [ ] **Step 3:** run the touched suites; verify visually in a browser (dev
  server, import the user's `user event` schema) — say plainly if the browser
  step could not be run; commit.

---

### Task 12: Ask for missing target-specific inputs instead of failing

**Files:**
- Create: `src/lib/schema-targets/requirements.ts` — pure
  `getTargetRequirements(targetId, model)` returning
  `{ missing: Array<{ code: "primary-key"; message: string; candidates:
  string[] }> }` (candidates = the entity's field names; a likely default is
  any field named `id` / `<entity>_id` / a required string field), for the
  targets whose emitters require a primary key: `bigquery`, `postgresql`,
  `spanner` (verify against the sibling emitter `lib.ts` diagnostics:
  `missing-primary-key` in all three). Targets with no requirements return an
  empty list.
- Modify: `src/lib/typespec-official/emitter-diagnostics.ts` — expose
  structured diagnostics (`{ code, message }[]`) and map
  `@typespec/*/missing-primary-key` to the same `primary-key` requirement, so
  a failure that slipped past the pre-check still becomes a question.
- Modify: `generateSchemaAction` (`src/app/(dashboard)/schemas/.../[entityId]/actions.ts`
  ~L1294) to return `{ needsInput: [...] }` before emitting, and a new action
  `setEntityPrimaryKeyAction(entityId, fieldNames: string[])` that sets
  `isKey` on exactly those fields (authenticated, scoped to the tenant like
  the sibling actions).
- Modify: the Schemas-tab UI that triggers generation (find the component that
  calls `generateSchemaAction`, e.g. `TechnologyCard.tsx`) — show a small
  dialog "This target needs a primary key" with a multi-select of the entity's
  fields (composite keys allowed) and, on confirm, call
  `setEntityPrimaryKeyAction` then retry generation.
- Modify: the entity-creation review (`FieldPreview` / review input) to
  prompt for the entity name when the importer fell back to the default
  (`ImportedEntity`) — e.g. highlight the name field as "needs a name".
- Test: `tests/unit/lib/schema-targets/requirements.test.ts` (new),
  extend the diagnostics tests, and a component test for the dialog.

**Interfaces:**
- Consumes: `Field.isKey`, `db-source.ts` (which already emits `@primaryKey`
  from `isKey` and `@primaryKey(n)` for composite keys).
- Produces: `getTargetRequirements`, structured diagnostics,
  `setEntityPrimaryKeyAction`.

- [ ] **Step 1:** failing tests: an entity with no key field and target
  `bigquery` -> requirement `primary-key` with the field names as candidates;
  with a key -> none; `avro`/`openapi3`/`json-schema`/`protobuf` -> none; the
  raw emitter error string `@typespec/bigquery/missing-primary-key: Table
  'ImportedEntity' must have...` parses to the same requirement; the action
  rejects field names that do not belong to the entity, other tenants'
  entities, and unauthenticated callers; composite keys set several `isKey`.
- [ ] **Step 2:** implement the pure functions, the action(s) and the dialog;
  keep it generic (a requirement list per target so partition/cluster or other
  required inputs can be added later without UI changes).
- [ ] **Step 3:** run the touched suites; verify in a browser (generate
  BigQuery for an entity with no key -> dialog -> pick `tenant` -> generation
  succeeds) — say plainly if the browser step could not be run; commit.

---

### Task 13: Import by URL in the workbench + dangling-reference indicator

**Files:**
- Modify: `src/components/custom/SchemaWorkbench/SchemaWorkbench.tsx` — add a
  "From URL" mode next to paste/upload/build, calling
  `importJsonSchemaFromUrlAction` (Task 8) and feeding its
  `TypeSpecImportResult` into the existing review flow
  (`EntityCreationWizard.handleImportSubmit` -> the multi-asset review).
- Modify: the review components from Task 11 so dangling refs (`danglingRef`)
  render with `ValidationIndicator` (status `"suggestion"`, tooltip naming the
  unreached `$ref` and the resolver's reason) and the entity stays in DRAFT
  with the pending items listed.
- Test: extend `tests/unit/components/schema-workbench.test.tsx`.

- [ ] **Step 1:** failing tests: URL mode accepts a URL, shows loading and
  error states (the action's sanitized error), and on success passes the
  result to the review; dangling fields show the indicator and reason.
- [ ] **Step 2:** implement; verify in a browser if possible; commit.

---

### Task 14: End-to-end test with the user's `user event` schema (supersedes the original Task 9 test plan)

**Files:**
- Test: `tests/integration/jsonschema-user-event-e2e.test.ts` (new) — the
  acceptance test with the user's schema (fixture inline):
  `{"type":"object","description":"A user event containing user level customer id information used to link a user across different tenants.","properties":{"component":{"type":"string","description":"Name of the source component logging the user event(s).","minLength":1,"maxLength":100,"pattern":"^([A-Za-z0-9-_])+$","x-securityClassification":{"data_class":"class4","data_category":"Intrinsic"}},"tenant":{"type":"string","description":"Name of the adjacency to Acme.","minLength":1,"maxLength":100,"pattern":"^[a-z0-9_]+$","x-securityClassification":{"data_class":"class4","data_category":"OrgCompany"}},"created_time":{"description":"Event creation timestamp.","$ref":"common_components/v4/schema/json/openapi-2.0/date_time.json","x-securityClassification":{"data_class":"class4","data_category":"Intrinsic"}},"user_links":{"type":"array","description":"List of list of users and their customer ids along with tenant information.","minItems":1,"maxItems":100,"items":{"$ref":"user_links.json"}}},"required":["user_links","created_time","tenant"]}`.
- Test (optional, if the Playwright environment can run it):
  `tests/e2e/jsonschema-user-event.spec.ts` extending the pattern in
  `tests/e2e/schema-lifecycle.spec.ts`.

(Original Task 9 text follows; superseded where it conflicts with the
amendment above — `ImportDialog` and the unmounted review screens are not
used; the Acme `address.json` check below still applies as a second
fixture, skipped when `gh auth status --hostname github.example.com` fails.)

**Interfaces:**
- Consumes: everything above.
- Produces: nothing further downstream.

- [ ] **Step 1: Write the end-to-end integration test.** Fetch
  `v1/schema/json/openapi-3.0/components/schemas/address.json` from
  `common-components` via `gh api --hostname
  github.example.com` (same call already verified reachable in this
  session) inside the test's setup (skip the test gracefully if `gh auth
  status --hostname github.example.com` fails, so CI without that
  credential doesn't break), run it through
  `importJsonSchemaFromUrlAction`, and assert: `address` entity has
  `extends` set to the resolved name of `address_portable` (reachable,
  same repo via `../../common_components/...` — note in the test comment
  whether that path turned out reachable or not against the real repo
  layout, and adjust the assertion to match reality rather than the
  doc's guess); `tags`, `confirmation_status`, `confirmation_authority`
  fields are `reference` type fields to their respective sibling files,
  not basename-collided; any field whose target repo/file is genuinely
  unreachable is flagged dangling, not silently mis-named.
- [ ] **Step 2: Run test to verify it fails** (or, if some assertions
  already pass from earlier tasks' work, note which).
- [ ] **Step 3: Implement the UI pieces** per the Files list.
- [ ] **Step 4: Run the full test suite**
  (`npx vitest run`) and confirm no regressions anywhere, not just the new
  files.
- [ ] **Step 5: Commit.**

---

## Self-Review Notes

- **Spec coverage:** Part 1 (extensions) → Tasks 1-4. Addendum A (allOf/
  oneOf/anyOf) → Tasks 5-6. Addendum B (`$ref` resolution, dangling
  reference) → Tasks 7-9. Item-level altitude handling (design's "A+C")
  was folded into Task 5's property-level `allOf` case — on reflection,
  the synthetic-per-usage-model path (A) only matters for `items` carrying
  a sibling extension key, which Task 1's generic capture already handles
  at the field level per the design's own fallback C; keeping this plan
  from building the synthetic-model machinery unless Task 9's real-world
  test against the Acme set actually produces a case needing it avoids
  speculative work the spec itself flagged as unresolved
  (`extends`-vs-spread, unverified against a real compile). If Task 9's
  fixture needs it, add a Task 5b at that point — don't build it blind.
- **Review Focus:** all five items map to an explicit test step above
  (Task 5 steps 1.1/1.2, Task 2/3 object-value tests, Task 7/8
  unreachable-`$ref` tests, Task 8's resolved-URI-keying test, Task 6's
  mixed-member fallback test).

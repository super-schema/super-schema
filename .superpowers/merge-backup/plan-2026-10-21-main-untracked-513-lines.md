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
  inheritance shape (real case: PayPal's `address.json`) must produce an
  entity with `extends` set *and* fields from the inline member — not just
  the first `allOf` member, which is what today's code does.
- A field-level extension whose value is a nested object
  (`x-visibility: {extent: "EXTERNAL"}`) must survive generate → reparse
  unchanged — not stringified, not flattened to `"[object Object]"`.
- A `$ref` that 404s, or whose host has no configured resolver, must fail
  only that one field (dangling-reference warning) — never the whole import.
- Two files in different directories sharing a basename (common in the
  PayPal schema set — e.g. multiple `*_status.json` siblings under different
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
  `github.paypal.com`), translating a resolved URI's path back into
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

### Task 9: UI — import by URL, dangling-reference indicator, end-to-end test

**Files:**
- Modify: `src/components/custom/ImportDialog/ImportDialog.tsx` — add a
  URL input alongside paste/upload, calling
  `importJsonSchemaFromUrlAction` (Task 8).
- Modify: `src/components/custom/ImportDialog/ImportReviewScreen.tsx` (and/or
  `BulkImportReviewScreen.tsx`) — render `ValidationIndicator` (status
  `"suggestion"`, tooltip naming the unreached `$ref`) next to any field
  whose `referencedEntityName` doesn't match an entity in the current
  import batch or product.
- Test: `tests/integration/jsonschema-paypal-import.test.ts` (new) — the
  actual requested acceptance test.

**Interfaces:**
- Consumes: everything above.
- Produces: nothing further downstream.

- [ ] **Step 1: Write the end-to-end integration test.** Fetch
  `v1/schema/json/openapi-3.0/components/schemas/address.json` from
  `identity.CommonComponentsSpecification` via `gh api --hostname
  github.paypal.com` (same call already verified reachable in this
  session) inside the test's setup (skip the test gracefully if `gh auth
  status --hostname github.paypal.com` fails, so CI without that
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
  test against the PayPal set actually produces a case needing it avoids
  speculative work the spec itself flagged as unresolved
  (`extends`-vs-spread, unverified against a real compile). If Task 9's
  fixture needs it, add a Task 5b at that point — don't build it blind.
- **Review Focus:** all five items map to an explicit test step above
  (Task 5 steps 1.1/1.2, Task 2/3 object-value tests, Task 7/8
  unreachable-`$ref` tests, Task 8's resolved-URI-keying test, Task 6's
  mixed-member fallback test).

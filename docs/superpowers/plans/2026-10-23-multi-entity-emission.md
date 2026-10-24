# Multi-entity emission Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generating an entity outputs one file per entity (itself plus its transitive reference closure, anywhere in the tenant) for JSON Schema, OpenAPI, Avro, Protobuf and Java, with fully qualified references, draft/published version rules and optional version pins.

**Architecture:** A tenant-scoped resolver builds the reference closure and picks a definition per entity by mode (published, draft, pinned). One synthesized multi-model TypeSpec program (one namespace per entity, unique model names, qualified reference types) is compiled once; per-target options make the emitters write one file per entity. The run returns a file list stored on the schema version; publish records the versions used.

**Tech Stack:** Next.js, Prisma (PGlite/Postgres), TypeSpec compiler + emitters (`@typespec/json-schema`, `openapi3`, `protobuf`, local sibling `avro` and `java-pojo` in `~/src/my/typespec`), Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-23-multi-entity-emission-design.md` (read it first, including "Calls made by the assistant"). Related earlier work: `docs/superpowers/plans/2026-10-21-jsonschema-import-fidelity.md`.

## Global Constraints

- One output file per entity for every target; DB targets (postgresql, spanner, bigquery) unchanged.
- References are stored fully qualified: domain / product / entity names plus `referencedEntityId`; id is the key. Tenant-less segments use the placeholder `_tenant`. Never resolve across tenants; every closure member passes the same tenant check as the root.
- Published X resolves references to the latest PUBLISHED version of each referenced entity; never a draft. Draft X resolves to latest saved definition (drafts included), output marked preview, not publishable as is. A pin names a PUBLISHED version and overrides both modes.
- A reference carries NO version by default: it means "latest published" (published mode) or "latest saved" (draft mode). A version is stored only when the user pins one; nothing writes a version automatically, and unpinning removes it.
- Bare-name legacy reference matching more than one entity: refuse with candidates (domain / product / entity); only an explicit pick action writes the qualified reference; a generate call never writes it. Zero matches stays dangling as today.
- OpenAPI: one self-contained file per entity (`@service` per entity, referenced entities inlined). Avro: each entity file self-contained, first use inline, later/recursive uses by full name. JSON Schema: `$ref` to sibling file. Protobuf: `import`, one package per entity, cycles share one package plus a warning. Java: separate classes, `import` across packages.
- `SchemaVersion.output` stays the bundled `===== path =====` string of all files; `files` is the structured form, each file tagged by target.
- A stand-alone entity with no references keeps today's package/options/content (only file layout may change).
- Hostile-input hygiene: bounded closure size (error past the cap, default 200 entities), bounded recursion, no throws (`Result<T, ServiceError>`), `setOwn` for user keys.
- Sibling repo work: branch `fix/corpus-emitter-defects` in `~/src/my/typespec`, small commits, not pushed, leave the unrelated uncommitted patch alone, rebuild (`npm run build`) after changes.
- Corpus (`npm run test:corpus`) stays green with an honest registry. No Co-Authored-By trailers in commits. Tests: Vitest in `tests/unit` / `tests/integration`, e2e in `tests/e2e`.

## Review Focus

- Two entities with the same name in different products/domains referenced by bare name: refusal lists both, nothing silently picked (Task 2, 3).
- Reference cycle A→B→A on all five targets, and a self-reference (Task 6, 11).
- Referenced entity deleted after pin or after qualified ref saved: clear refusal / dangling, no crash (Task 2).
- Published X while a referenced entity has only a draft or was never published: blocked with a message naming it (Task 8).
- Entity with no domain/product and entity renamed or moved after the reference was saved (Task 1, 2).

---

### Task 1: Reference identity (qualified reference, id, pin)

**Files:**
- Create: `src/lib/references/entity-reference.ts`
- Modify: `src/lib/compiler/decorator-builder.ts`, `src/lib/compiler/compiler.service.ts` (~224, ~289 where `referencedEntityId` is read), `src/types/super-schema-model.ts` (field reference type)
- Test: `tests/unit/lib/references/entity-reference.test.ts`

**Interfaces:**
- Produces:
  - `type EntityRef = { entityId?: string; domain: string; product: string; entity: string; pinnedVersion?: string }` (domain/product are `"_tenant"` when absent)
  - `qualifiedName(ref: EntityRef): string` returns `domain/product/entity`
  - `parseQualifiedName(s: string): EntityRef | undefined` (no id; rejects empty segments and more/less than 3 segments)
  - `readFieldReference(decorators: unknown): EntityRef | { legacyName: string } | undefined`
  - `writeFieldReference(decorators: Record<string, unknown>, ref: EntityRef): Record<string, unknown>` (writes `referencedEntityId`, `referencedEntityName` kept as the entity segment for old readers, `referencedQualifiedName`, `referencedEntityVersion` when pinned; uses `setOwn`)

- [ ] **Step 1: Write failing tests** `qualifiedName` round trip with `_tenant` placeholders; `parseQualifiedName("a/b")` is undefined; `readFieldReference` of `{referencedEntityName:"Address"}` returns `{legacyName:"Address"}`; of a written ref returns the same `EntityRef`; `__proto__` key in decorators is not polluted.
- [ ] **Step 2: Run** `npx vitest run tests/unit/lib/references/entity-reference.test.ts` — expect FAIL (module missing).
- [ ] **Step 3: Implement** the module; wire `compileEntity`/`extractRelationships` to prefer `referencedEntityId` and expose the full `EntityRef` on the compiled field (keep existing name behaviour for legacy).
- [ ] **Step 4: Run** the new test plus `npx vitest run tests/unit/lib/compiler` — expect PASS.
- [ ] **Step 5: Commit** `feat(refs): fully qualified entity reference with id and optional version pin`.

### Task 2: Closure resolver with version modes

**Files:**
- Create: `src/lib/references/closure.ts`
- Modify: read `src/lib/entity-versioning/` (`reference-targets.ts`, `resolve-source.ts`, version models in `prisma/schema.prisma`) first; reuse `getLatestPublishedVersion` in `src/services/entity-version.service.ts` for the default (unpinned) published lookup
- Test: `tests/unit/lib/references/closure.test.ts`

**Interfaces:**
- Consumes: Task 1 `EntityRef`, `readFieldReference`.
- Produces:
  - `type ResolveMode = "published" | "draft"`
  - `type ClosureEntity = { entityId: string; ref: EntityRef; source: "published" | "draft" | "pinned"; version?: string; fields: PrismaFieldInput[]; entity: PrismaEntityInput }`
  - `type ClosureError = { code: "AMBIGUOUS_REFERENCE"; field: string; name: string; candidates: EntityRef[] } | { code: "PIN_NOT_FOUND"; field: string; ref: EntityRef; version: string } | { code: "NEVER_PUBLISHED"; ref: EntityRef } | { code: "CLOSURE_TOO_LARGE"; limit: number } | { code: "CROSS_TENANT" }`
  - `loadReferenceClosure(db: DbClient, tenantId: string, rootEntityId: string, mode: ResolveMode, opts?: { maxEntities?: number }): Promise<Result<{ root: ClosureEntity; entities: ClosureEntity[]; draftEntities: EntityRef[]; cycles: string[][] }, ClosureError>>`
  - Entities ordered root first, then breadth-first by qualified name (deterministic). `cycles` lists strongly connected groups of size > 1 or self-loops.

- [ ] **Step 1: Write failing tests** (in-memory/PGlite fixtures): chain A→B→C returns [A,B,C]; cycle A→B→A terminates and reports the cycle; same-name `Address` in two products with a bare-name ref returns `AMBIGUOUS_REFERENCE` with both candidates; qualified ref picks the right one; `published` mode uses the latest published version content even when a newer draft exists; `draft` mode uses latest saved; pin overrides both; missing pinned version returns `PIN_NOT_FOUND`; published mode with a never-published referenced entity returns `NEVER_PUBLISHED`; referenced entity of another tenant never appears (`CROSS_TENANT` or dangling); deleted target leaves the field dangling (not in closure, no error); 201-entity chain returns `CLOSURE_TOO_LARGE`.
- [ ] **Step 2: Run** `npx vitest run tests/unit/lib/references/closure.test.ts` — expect FAIL.
- [ ] **Step 3: Implement** `loadReferenceClosure` with BFS plus visited set; resolution order id → qualified name → legacy bare name (tenant-wide); Tarjan or iterative SCC for `cycles`.
- [ ] **Step 4: Run** the test — expect PASS.
- [ ] **Step 5: Commit** `feat(refs): tenant-scoped reference closure with published/draft/pinned resolution`.

### Task 3: Pick action and legacy upgrade

**Files:**
- Modify: `src/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/actions.ts` (new `setFieldReferenceAction`), `src/components/custom/` field editor (`ComplexTypePrompt.tsx:230` writes the qualified ref and id)
- Create: `src/components/custom/ReferencePickDialog/ReferencePickDialog.tsx`
- Test: `tests/unit/app/set-field-reference-action.test.ts`, `tests/unit/components/reference-pick-dialog.test.tsx`

**Interfaces:**
- Consumes: Task 1 `writeFieldReference`, Task 2 `ClosureError`.
- Produces: `setFieldReferenceAction(entityId: string, fieldId: string, ref: { entityId: string; pinnedVersion?: string | null }): Promise<Result<void, ServiceError>>` (validates the target is in the active tenant and, for a pin, that the version exists and is published; stores via `writeFieldReference`); `ReferencePickDialog({ candidates: EntityRef[]; onPick(ref: EntityRef): void; onCancel(): void })`.

- [ ] **Step 1: Write failing tests**: action rejects a cross-tenant target, an unpublished pin and a draft version pin; stores qualified ref + id; clearing the pin removes `referencedEntityVersion`; a bare-name ref resolving to exactly one entity is upgraded to qualified when resolved by the generate path (helper `upgradeLegacyReference` called from Task 7, tested here with a fake db); dialog lists candidates as `domain / product / entity` and calls `onPick` with the chosen one.
- [ ] **Step 2: Run** the two files — expect FAIL.
- [ ] **Step 3: Implement** action, dialog, and update `ComplexTypePrompt` to write id + qualified name on pick (entity search across the tenant).
- [ ] **Step 4: Run** both files plus `npx vitest run tests/unit/components` — expect PASS.
- [ ] **Step 5: Commit** `feat(refs): pick/pin action and dialog, UI writes qualified references`.

### Task 4: Combined multi-entity TypeSpec generation and pin tag

**Files:**
- Modify: `src/lib/compiler/typespec-generator.ts` (reference emission ~935, ~990), `src/lib/compiler/governance-decorators.ts` (or the decorator family used for SuperSchema metadata), `src/lib/compiler/typespec-parser.ts`, `src/lib/typespec-sync/merge-fields.ts`
- Create: `src/lib/compiler/closure-source.ts`
- Test: `tests/unit/lib/compiler/closure-source.test.ts`, `tests/unit/lib/compiler/reference-pin-tag.test.ts`

**Interfaces:**
- Consumes: Task 2 `ClosureEntity`.
- Produces:
  - `uniqueModelName(ref: EntityRef): string` — deterministic, valid TypeSpec identifier from `domain_product_entity` (sanitized, reserved words quoted, collision-proof by suffix hash when sanitizing merges two names).
  - `generateClosureTypeSpec(closure: { entities: ClosureEntity[] }, opts: { target: TargetId }): { source: string; rootModel: string; models: Map<string, string> }` — one `namespace <Domain>.<Product>.<Entity>` per entity, reference fields typed with the qualified model name, `import`/`using` lines as the target needs.
  - Pin tag: a SuperSchema metadata decorator written as `@superSchemaPin("1.2.0")` (exact name chosen to match the existing governance decorator family; document in code) on the reference field; parser and sync read/write it to `referencedEntityVersion`; it is NOT emitted into target schemas (stripped in closure source for emission, kept in the stored canonical source).

- [ ] **Step 1: Write failing tests**: two entities with the same entity name in different products yield distinct model names and namespaces; a reference field is emitted as the qualified model; a self-reference and A↔B cycle compile with the real `@typespec/compiler` (reuse the helper in `tests/unit/lib/compiler/typespec-compiler.test.ts`); a pin tag round-trips through generate → parse → sync; a stand-alone entity's single-entity output is byte-identical to today's (snapshot from current code).
- [ ] **Step 2: Run** the two files — expect FAIL.
- [ ] **Step 3: Implement** with a new `qualifiedRefs`/namespace option on `generateTypeSpec`; keep the default path untouched.
- [ ] **Step 4: Run** the two files plus `npx vitest run tests/unit/lib/compiler tests/unit/lib/typespec-sync` — expect PASS.
- [ ] **Step 5: Commit** `feat(compiler): combined closure TypeSpec with per-entity namespaces and pin tag`.

### Task 5: Sibling emitters — Avro namespaces, Java imports and paths

**Files (in `/Users/jsenjaliya/src/my/typespec/packages/`):**
- Modify: `avro/src/transform.ts` (nested record namespace, ~277-285), `avro/src/emitter.ts`, `java-pojo/src/transform.ts` (~105, ~219-221), `java-pojo/src/emitter.ts`
- Test: each package's own suite (new cases)

**Interfaces:**
- Produces: Avro — a record defined inline inside another keeps its OWN namespace (from its TypeSpec namespace), and file name is unique per namespace-qualified name (`<Namespace>.<Name>.avsc.json` flat or a directory per namespace; pick one and document). Java — `import <pkg>.<Class>;` when a referenced class is in a different package, and output path `<pkg as dirs>/<Class>.java`.

- [ ] **Step 1: Write failing tests** per package: Avro two same-named records in different namespaces both emitted, nested record carries its own namespace, recursion still refers by full name; Java referenced class in another package yields the import and the package directory path, and `javac` compiles the pair (reuse the javac helper pattern from the existing java-pojo tests).
- [ ] **Step 2: Run** each package's tests — expect FAIL.
- [ ] **Step 3: Implement** both patches on the existing branch; rebuild each package.
- [ ] **Step 4: Run** each package's tests and `npm run build` — expect PASS.
- [ ] **Step 5: Commit** one commit per package (`fix(avro): ...`, `fix(java-pojo): ...`).

### Task 6: Closure emission per target

**Files:**
- Modify: `src/lib/typespec-official/emitter.service.ts` (`buildEmitterOptions` ~146, `buildSourceForTarget` ~208, `runTypeSpecEmitterWithWarnings` ~395, `bundleGeneratedFiles` ~555), `src/lib/schema-targets/catalog.ts`
- Create: `src/lib/typespec-official/closure-emit.ts`
- Test: `tests/unit/lib/typespec-official/closure-emit.test.ts`

**Interfaces:**
- Consumes: Task 4 `generateClosureTypeSpec`, Task 2 closure.
- Produces: `emitClosure(closure: Closure, target: TargetId): Promise<Result<{ files: EmittedFile[]; warnings: string[] }, ServiceError>>` where `type EmittedFile = { path: string; content: string; target: TargetId; entityId?: string }`. Per target: json-schema without `bundleId` (one `<Model>.json` per model, keep `emitAllModels`); openapi3 one `@service` namespace per entity, root first; protobuf `@package(name=...)` per entity from the qualified path, cycle groups share one package with a warning; avro/java-pojo with Task 5 behaviour. Files are filtered to the closure and sorted by path. Existing `emitOfficialTypeSpecTargetFromData` keeps working for stand-alone entities by delegating to a one-entity closure.

- [ ] **Step 1: Write failing tests** with a three-entity closure on each of the five targets: JSON Schema output has three files and `Order.json` contains `"$ref":"<Address file>"`; OpenAPI Order file contains `Address` under `components.schemas` and no external ref; Protobuf has `import` lines and a shared package warning for a cycle; Avro Order file contains Address inline once and then by name; Java has the import and compiles with javac; every output is deterministic (run twice, equal); same-named entities in two products produce distinct files.
- [ ] **Step 2: Run** the test — expect FAIL.
- [ ] **Step 3: Implement** `closure-emit.ts`, update options per target, return file lists (keep `bundleGeneratedFiles` for the `output` string).
- [ ] **Step 4: Run** the test plus `npx vitest run tests/unit/lib/typespec-official` — expect PASS; update tests that assert `bundleId`/bundle shape.
- [ ] **Step 5: Commit** `feat(emit): closure emission yields one file per entity on all five targets`.

### Task 7: Generate action, result shape, storage

**Files:**
- Modify: `src/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/actions.ts` (`generateSchemaAction` ~1333-1486), `src/types/` (`SchemaVersion`), `src/app/api/v1/schemas/[id]/emit/route.ts`, `.../validate/route.ts`, `src/lib/emission/emission.service.ts`, `src/lib/entity-versioning/draft-state.ts`
- Test: `tests/unit/app/generate-schema-action-closure.test.ts`, `tests/integration/emit-route-closure.test.ts`

**Interfaces:**
- Consumes: Task 2, 3 (`upgradeLegacyReference`), 6.
- Produces: `SchemaVersion` gains `files?: EmittedFile[]`, `resolution?: { mode: "published" | "draft"; preview: boolean; entities: { ref: EntityRef; version?: string; source: "published" | "draft" | "pinned" }[] }`. `generateSchemaAction(entityId, target, opts?: { mode?: ResolveMode })` returns `{ needsInput }` as today, or `{ needsReference: { field: string; name: string; candidates: EntityRef[] } }` for `AMBIGUOUS_REFERENCE`. Mode defaults to `draft` when generating the entity's current state and `published` when generating from a published version. API routes return `{ output, files }` and a structured `ambiguous` error.

- [ ] **Step 1: Write failing tests**: ambiguous bare name returns `needsReference` and writes nothing; after `setFieldReferenceAction` the same call succeeds; draft generation stores `resolution.preview = true` listing draft references; published-version generation never includes a draft reference; `output` equals the bundled string of `files`; legacy single reference resolving to one entity is upgraded to qualified on success.
- [ ] **Step 2: Run** both files — expect FAIL.
- [ ] **Step 3: Implement** the action path through `loadReferenceClosure` + `emitClosure`; DB targets skip the closure; update routes.
- [ ] **Step 4: Run** both files plus `npx vitest run tests/unit/app tests/unit/lib/emission` — expect PASS.
- [ ] **Step 5: Commit** `feat(generate): closure-based generation with draft/published modes and file lists`.

### Task 8: Publish gate, recorded versions, staleness

**Files:**
- Modify: `src/lib/entity-versioning/resolve-source.ts` (`stubUnresolvedReferences` removed), `src/lib/entity-versioning/publish-plan.ts`, `src/lib/entity-versioning/entity-alerts.ts`, publish action in the entity actions file
- Test: `tests/unit/lib/entity-versioning/publish-closure.test.ts`

**Interfaces:**
- Consumes: Task 2 (`published` mode), Task 7 `resolution`.
- Produces: publish compiles the real closure instead of stubs; the published version stores `referencedVersions: { ref: EntityRef; version: string; pinned: boolean }[]`; `referenceStaleness(version): { ref: EntityRef; recorded: string; latest: string }[]` (unpinned references only) feeding entity alerts. Publish returns a message naming the entity when a closure member was never published or a pin is gone.

- [ ] **Step 1: Write failing tests**: publish blocked with the offending entity named when a referenced entity is draft-only; publish records versions (pinned and latest); newer published referenced version shows staleness only for unpinned refs; a published version never contains draft content of a referenced entity even if a draft exists; no stub models are generated anywhere (grep test on `stubUnresolvedReferences`).
- [ ] **Step 2: Run** — expect FAIL.
- [ ] **Step 3: Implement** and delete `stubUnresolvedReferences`.
- [ ] **Step 4: Run** the new test plus `npx vitest run tests/unit/lib/entity-versioning` — expect PASS.
- [ ] **Step 5: Commit** `feat(publish): publish compiles the real closure and records referenced versions`.

### Task 9: UI — files view, preview badge, pin control

**Files:**
- Modify: `src/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/components/SchemasTab.tsx` (~678), `useGenerateWithInputs.tsx`, field editor for the pin control
- Create: `src/components/custom/SchemaFileSet/SchemaFileSet.tsx`
- Test: `tests/unit/components/schema-file-set.test.tsx`, `tests/unit/components/schemas-tab-closure.test.tsx`

**Interfaces:**
- Consumes: Task 7 `SchemaVersion.files/resolution`, Task 3 dialogs/action.
- Produces: `SchemaFileSet({ files: EmittedFile[]; entityName: string })` — file list, selected file shown in `SchemaCodePreview`, copy per file, "Download all" (zip or sequential download; builder's call). Schemas tab shows a "Preview (drafts used)" badge listing draft references and the version each reference used; `useGenerateWithInputs` handles `needsReference` by opening `ReferencePickDialog`, saving the pick, retrying.

- [ ] **Step 1: Write failing tests**: multi-file version renders a file list and switching files changes the code shown; single-file versions render as before; preview badge appears only when `resolution.preview`; `needsReference` opens the dialog and a pick triggers one retry.
- [ ] **Step 2: Run** — expect FAIL.
- [ ] **Step 3: Implement** the components and wiring.
- [ ] **Step 4: Run** both files plus `npx vitest run tests/unit/components` — expect PASS.
- [ ] **Step 5: Commit** `feat(ui): schema file set view, preview badge, reference pick and pin controls`.

### Task 10: Git export of file sets

**Files:**
- Modify: `src/services/git.service.ts` (`generateExportFiles` ~100, callers ~337 ~455), `src/services/git-pr.service.ts` (~360, ~460)
- Test: `tests/unit/services/git-export-files.test.ts`

**Interfaces:**
- Produces: `generateExportFiles(...)` reads `schemaVersions[target]` (not `emittedOutputs`) and writes `<base>/<domain|_tenant>/<product|_tenant>/<entity>/<target>/<file path>` for every target in the catalog (not only bigquery/avro/openapi), plus the SuperSchema JSON.

- [ ] **Step 1: Write failing tests**: all five closure targets exported with per-file paths; two same-named entities in different products do not collide; legacy `emittedOutputs`-only entities still export.
- [ ] **Step 2: Run** — expect FAIL.
- [ ] **Step 3: Implement** reading `files` (fall back to `output`).
- [ ] **Step 4: Run** the test plus `npx vitest run tests/unit/services` — expect PASS.
- [ ] **Step 5: Commit** `feat(export): git export writes per-entity file sets for all targets`.

### Task 11: TypeSpec tab with qualified references

**Files:**
- Modify: `src/lib/compiler/typespec-parser.ts`, `src/lib/typespec-sync/merge-fields.ts`, TypeSpec tab save action in the entity actions file
- Test: `tests/unit/lib/typespec-sync/qualified-reference-sync.test.ts`

**Interfaces:**
- Consumes: Task 1, 2, 3, 4.
- Produces: saving TypeSpec source whose field type is a qualified model name resolves via the closure resolver, stores `EntityRef`, and keeps the entity saveable; an ambiguous bare name returns `needsReference` (shared dialog); unresolved stays dangling; existing dangling round trip unchanged.

- [ ] **Step 1: Write failing tests**: source referencing `Billing.Payments.Address` syncs to a qualified ref with id; bare `Address` unique → upgraded; bare `Address` ambiguous → `needsReference` with candidates and source unchanged; a self-reference saves; the earlier "entity referencing another model cannot be saved" case now saves.
- [ ] **Step 2: Run** — expect FAIL.
- [ ] **Step 3: Implement** parser/sync/action changes.
- [ ] **Step 4: Run** the test plus `npx vitest run tests/unit/lib/typespec-sync tests/unit/lib/compiler` — expect PASS.
- [ ] **Step 5: Commit** `feat(sync): TypeSpec source references resolve to qualified entity references`.

### Task 12: Corpus, e2e, docs, retire stopgaps

**Files:**
- Modify: `tests/fixtures/corpus/manifest.ts`, `tests/fixtures/corpus/known-issues.ts`, `tests/helpers/corpus/run-case.ts` (~76-81), `tests/helpers/corpus/orchestrate.ts`, `src/lib/schema-targets/default-mappings.ts` (~251 protobuf `lossDescription`), `docs/superpowers/reports/2026-10-22-corpus-matrix.md`
- Create: `tests/e2e/reference-lifecycle.spec.ts`
- Test: corpus + the new spec

**Interfaces:**
- Consumes: Tasks 1-11.
- Produces: corpus cases take sibling entities (a document's `$defs` become closure members) and validate every file with the existing validators; new fixtures for cycles, transitive chains, arrays/maps of references, same-named entities in two products, tenant-level (no product) entities, a pinned reference; `multi-model-emission-gap` entry removed (and `openapi-internal-ref-extension` re-judged).

- [ ] **Step 1: Write failing corpus cases** first (they fail on `invalid-ref` today for the document-level cases); add the e2e spec: create Address (publish), Customer referencing it, generate all five targets as files, change Address draft and see a draft Customer preview include it while a published Customer does not, pin Customer to an Address version and confirm the pin wins, ambiguity prompt with two same-named entities, TypeSpec tab save with a reference.
- [ ] **Step 2: Run** `npm run test:corpus` — expect FAIL on the new reference cases (stale-registry check also red once fixed, by design).
- [ ] **Step 3: Update** the registry honestly (remove only entries whose failures are really gone), the protobuf `lossDescription`, and regenerate the matrix doc.
- [ ] **Step 4: Run** `npm run test:corpus` (expect all green, emulators clean), `npx vitest run tests/unit`, and the Playwright spec per `.superpowers/sdd/2026-10-21-jsonschema-import-fidelity/browser-lifecycle-report.md` (expect PASS; known failures only as declared expectations).
- [ ] **Step 5: Commit** `test(corpus): reference closure cases, retire multi-model gap`.

---

## Self-review notes

- Spec coverage: decisions 1-6 → Tasks 6, 5; qualified refs and ambiguity → Tasks 1-3, 11; version rules and pins → Tasks 2, 3, 4, 7, 8; stored files and UI → Tasks 7, 9; export → Task 10; stopgaps retired → Tasks 8, 12; sibling patches → Task 5.
- Names used across tasks: `EntityRef`, `ClosureEntity`, `ClosureError`, `loadReferenceClosure`, `generateClosureTypeSpec`, `emitClosure`, `EmittedFile`, `setFieldReferenceAction`, `needsReference` — consistent.
- Open builder calls (from the spec): namespace/path layout, UI download mechanics, exact pin decorator name, Avro file layout.

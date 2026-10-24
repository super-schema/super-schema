# Multi-entity emission: one file per entity, references across the tenant

Date: 2026-10-23. Status: draft for approval.

## Intent and why

An entity can reference another entity (a field typed `reference`, or an array/map of references). Today generating such an entity for JSON Schema, OpenAPI, Avro, Protobuf or Java fails with `invalid-ref`, because only the one entity is compiled and the referenced model is never declared. The corpus records this as the `multi-model-emission-gap` known issue (the largest remaining failure class), and the TypeSpec tab cannot save an entity whose source references another model for the same reason.

Entities such as `Address` are shared and always remain separate entities. The generated artifacts must therefore also stay separate and link to each other with each format's own reference mechanism, as a hand-written schema set would.

## Decisions (made with the user)

1. One output file per entity, for every target.
2. Generating entity X outputs X's file plus the file of every entity X references, directly or transitively. The output is a complete set that works on its own. Each referenced file is generated from that entity's own definition. File, class and message names are the entity's own name; an entity is qualified with product (and domain) only when another entity in the same closure would otherwise get the same name, so such a name can differ between two roots whose closures differ (the file's content is otherwise the same). Anything keyed by file path must not assume a stable path across roots; staleness is judged from entity versions.
3. A referenced entity may live in any domain or product of the same tenant. Never across tenants.
4. References are fully qualified, so there is no ambiguity about which entity is meant. A reference is stored as the entity's qualified name (domain / product / entity, plus the entity id as the stable key) and the UI and importers always write it that way. A legacy name-only reference that matches more than one entity in the tenant is refused at generation, and the user is asked to pick one; the pick is saved as the fully qualified reference. A name-only reference with exactly one match is upgraded to the qualified form when it is resolved. (The user asked for fully qualified references; the legacy pick dialog is the assistant's call for old data.)
5. Cross-file mechanism per target (each is that format's supported way):
   - JSON Schema: `$ref` to the sibling file.
   - Protobuf: `import` of the sibling `.proto`.
   - Java: separate classes, `import` where packages differ.
   - Avro: each entity's file is self-contained; the first use of a referenced type is written inline, later or recursive uses refer to it by full name. (The user prefers this for Avro.)
   - OpenAPI: its native model is one self-contained file per service with referenced entities in `components.schemas`; there are no cross-file refs. Each entity gets its own file with the entities it references inlined. This differs from "files pointing at each other" and is accepted as OpenAPI's supported way (the assistant proposed it; the user confirmed "based on the supported way").
6. DB targets (PostgreSQL, Spanner, BigQuery) are unchanged: references remain plain columns.

## Which version of a referenced entity is used (decided with the user)

What is being generated decides what its references resolve to:

- Generating or publishing a PUBLISHED version of X: every referenced entity resolves to its latest PUBLISHED version. A published X can never use a draft of a referenced entity.
- Generating the DRAFT (current saved state) of X: referenced entities resolve to their latest saved definition, which includes drafts. So if `Address` has draft changes, a draft `Customer` generated now sees them. To use a draft `Address`, `Customer` must itself be generated from its draft. Output generated this way is marked as a draft/preview, lists which referenced entities were at draft state, and cannot be published as is.
- Version pin (optional, per reference): a reference can pin a specific PUBLISHED version of the referenced entity. A pin overrides both modes above: generation always uses that exact version, in drafts and in published output, and the output file notes the pinned version. A pin is SuperSchema-level metadata, not a native schema feature: it is stored with the reference on the field (alongside the qualified reference and id), written in the TypeSpec source as a SuperSchema metadata tag (same family as the existing governance and extension decorators), and never written into emitted schemas except as a note or extension where the target allows. Pins can only name a version that exists and is published; if the pinned version is later removed, generation refuses with a clear message naming the reference.
- Publishing X records the exact version of every referenced entity it used (pinned or latest published). Staleness is reported when a referenced entity has a newer published version than the one recorded and the reference is not pinned. (Staleness wording and whether regenerating a published X re-resolves are the assistant's call: regenerating re-resolves latest published unless pinned, and shows the difference.)
- Publishing X is blocked while any entity in its closure has never been published (a published version needs a published version to refer to).

## Approach (the assistant's call, from the code investigation)

Compile ONE synthesized multi-model TypeSpec program holding X and its transitive reference closure, each entity in its own namespace, with reference types rewritten to qualified names. The emitters then write per-entity files. Rejected: compiling each entity alone and patching references afterwards (stub models, text surgery per target, N compiles); bundling everything into one file (does not meet decision 1).

Facts the design rests on:
- Today only one entity is loaded and compiled (`emitOfficialTypeSpecTargetForEntity`, then `buildSourceForTarget`). A reference field is emitted as the bare model name (`typespec-generator.ts`). The publish gate hides the problem with empty stub models (`resolve-source.ts: stubUnresolvedReferences`, written as a stopgap "until the closure lands").
- References are stored only as a name in `Field.decorators.referencedEntityName`; `referencedEntityId` exists in the reader but is never written. Entity names are unique only per product (`@@unique([name, productId])`), so the same name can exist in different products and domains. Tenant-level entities (no product) are not constrained.
- JSON Schema: dropping `bundleId` gives one `<Model>.json` per model with native `$ref` to siblings, cycles fine. Two same-named models in different namespaces collide (`duplicate-id`, file overwritten), so model names in the combined program must be unique.
- OpenAPI: one `@service` namespace per requested entity gives one self-contained file per service.
- Protobuf: one `@package(name)` per entity gives `a/b.proto` files with correct imports. Imports must be acyclic.
- Avro and java-pojo are local sibling packages (`~/src/my/typespec`, symlinked) and may be patched: Avro needs per-namespace naming of nested records; java-pojo needs imports and package-directory paths for cross-package references.

## Parts

1. Reference identity: a reference is the fully qualified entity (domain / product / entity names plus `referencedEntityId`). Write both whenever a reference is created or picked (field editor, importers, the TypeSpec sync, and the TypeSpec text itself, where the reference is written as a qualified name). Renaming or moving an entity must not break references: the id is the key, the qualified name is refreshed from it. Legacy name-only references keep working and are resolved at generate time.
2. Resolver: a tenant-scoped `loadReferenceClosure(tenantId, rootEntityId)` doing a breadth-first walk with a visited set (cycles), resolving by id first, then by qualified name, then (legacy) by bare name across the tenant. Zero matches: the field stays dangling as today. More than one bare-name match: refuse with a "choose which entity" result listing candidates (domain / product / entity); the pick is persisted as the qualified reference, then generation continues.
3. Authorization: every closure member must belong to the active tenant (same check as the root entity).
4. Combined TypeSpec generation: `generateTypeSpec` gains options for a per-entity namespace and qualified reference names; model names are made unique across the closure (domain, product, entity based) so JSON Schema and Avro file names never collide.
5. Per-target projection and options: JSON Schema without `bundleId`; one `@service` per entity for OpenAPI with the root first; `@package` per entity for Protobuf, with reference cycles placed in one package plus a warning; Avro and java-pojo sibling patches as above.
6. Result shape: the run returns a list of files (path, content), not one string. `SchemaVersion` gains `files` and keeps `output` (the bundled string) for compatibility. The version also records the entities and entity versions it included, so stale detection can cover them.
7. UI: the entity Schemas tab shows the files of a version (tree or tabs) with copy per file and download of the set, a draft/preview badge with the list of draft references when applicable, and the version each reference used. A pick-the-reference dialog for the ambiguous case. A "pin version" control on a reference field (choose from the referenced entity's published versions, or unpin). The existing primary-key flow is unchanged.
8. Export and API: git export writes `<domain>/<product>/<entity>/<files>` from the stored files, reads `schemaVersions` (not the legacy `emittedOutputs`), and covers all targets. `emit` and `validate` routes return the file list as well as `output`.
9. Retire the stopgaps: remove stub-model resolution in the publish gate; retire the `multi-model-emission-gap` registry entry (and the dangling-vs-resolved handling: once the target entity exists the marker no longer applies); the TypeSpec tab can save an entity whose source references another model.

## Goals

- Every reference case in the corpus that fails today with `invalid-ref` passes on the five targets.
- Output for a closure is deterministic (same inputs, same files, same order).
- No change to what a stand-alone entity (no references) generates, except file layout where a target switches from bundle to per-entity files.

## Non-goals

- Cross-tenant references.
- Changing DB targets or the reference model (still by field, still name plus id).
- A new UI for browsing the entity graph.
- Making dangling external `$ref`s resolve; they keep today's behavior.

## Anti-goals (a failure even if it "works")

- Silently picking one of several same-named entities.
- Output that compiles but is not self-consistent (a file pointing at a file that is not in the set).
- Generating a referenced entity from stale or stub data.
- Leaking another tenant's entity into a closure.

## Constraints

- Corpus must stay green (tests/integration/corpus), with its registry updated honestly (entries removed only when the failures are really gone).
- Existing unit, integration and e2e tests updated where they assert bundle shape; none deleted to pass.
- Sibling repo changes go on a branch there, small commits, not pushed.
- Hostile-input hygiene from the earlier work applies (bounded recursion and closure size, no throws, `setOwn`).

## Calls made by the assistant (settled from the builder check; change any you disagree with)

- `SchemaVersion.output` stays the bundled string of ALL files in the existing `===== path =====` form, so copy, validate, the API and MCP consumers keep working; `files` is the structured form. Consumers move to `files` over time.
- Non-interactive entry points (`emit` / `validate` routes, publish gate, export, CI) return a structured "ambiguous reference" error with the candidates (domain / product / entity). Only an explicit pick action writes the qualified reference; a generate call never writes it. No backfill script: legacy name-only references resolve at generate time and are upgraded when they resolve to exactly one entity or when the user picks. If a referenced entity is deleted, the field falls back to dangling; if only renamed or moved, the id keeps it valid.
- Entities without a domain or product use a fixed placeholder segment in the namespace, file path and qualified name (for example `_tenant`), so paths stay `<domain|_tenant>/<product|_tenant>/<entity>`.
- "Identical whichever entity pulled it in" holds for JSON Schema, Protobuf and Java. Avro (first use inlined) and OpenAPI (referenced entities inlined per service) vary with the root; staleness is judged from the entity versions recorded on the version, not from file content.
- Protobuf package and Java package derive from the qualified path (domain, product, entity). A stand-alone entity with no references keeps exactly today's package and options.
- Sibling repo: build on the current branch `fix/corpus-emitter-defects`, keep the unrelated uncommitted patch untouched; the sibling packages' own tests plus the app corpus are the gate.
- Corpus: add new fixtures for cycles, transitive chains, arrays and maps of references, same-named entities in different products, and tenant-level entities. Cycles must work for all five targets (Avro by full-name reference, OpenAPI natively, JSON Schema `$ref`, Java same compile unit set, Protobuf shared package plus warning).
- TypeSpec tab: references in the text are qualified names; saving resolves them with the same resolver and the same pick dialog for an ambiguous bare name.
- "All targets" runs return one file list with each file tagged by target.

## Left to the builder

- Exact namespace and unique-model-name scheme, file path layout inside the output set.
- Closure size cap and what happens past it (suggest an error with a clear message).
- UI details of the file list and the pick dialog.
- Whether cycles for Protobuf are handled by one shared package or by an error.
- How stale detection reports an out-of-date referenced entity.

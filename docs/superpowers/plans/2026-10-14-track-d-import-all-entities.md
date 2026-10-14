# Track D — Import all entities (Epic 15) — Implementation Plan

Spec: `docs/superpowers/specs/2026-10-13-events-asyncapi-design.md` §14 Epic 15.
In scope: 15.1, 15.3, 15.4, minimal 15.5, 15.6, partial 15.8 (no migration).
Out: 15.2 (gRPC), 15.7 (bulk persist), 15.9, migrations, AsyncAPI import.

## Design decisions

- **Format-neutral result** (`src/lib/importers/types.ts`):
  `MultiEntityImportResult { sourceFormat; entities: ParsedEntity[]; enums: ParsedEnum[]; scalars: ParsedScalar[]; warnings; namespace? }`.
  Each importer gains `parse<Format>Document()` → `MultiEntityImportResult`; the existing
  `parse<Format>Schema()` stays as the single-entity API (root entity = `entities[0]`) so drift,
  bulk import and the visual-builder round trips keep working.
- **Review adapter** (`src/lib/importers/multi-asset.ts`): `toAssetImportResult()` maps a
  `MultiEntityImportResult` onto the existing `TypeSpecImportResult` shape (+ new optional
  `sourceFormat`) so `TypeSpecImportReviewScreen` + `createDomainAssetsFromImportAction` are reused.
  Every entity is recommended as an entity (the epic is "import all entities").
- **Routing** (`src/services/import.service.ts`): `importSchemaAssets(content, format?)` →
  `{ kind: "single", result: ImportResult } | { kind: "multi", result: TypeSpecImportResult }`;
  multi when `entities + enums + scalars > 1`.
- **Field conventions** (match what the app already reads):
  - reference → `type: "reference"`, `referencedEntityName` (as JSON Schema does today).
  - array → `arrayElementType` (+ `referencedEntityName` when the element is a message/record).
  - map → `mapKeyType` / `mapValueType` decorators (read by `compiler.service` `extractComplexTypeInfo`).
  - enum field → `type: "enum"`, `enumName` decorator + values in `typespec.validation.pattern`
    (`"A|B"`, the generator's enum-value carrier — it skips `@pattern` for enum fields); the enum
    itself becomes a SharedEnum asset.
  - proto field number → `Field.fieldNumber` (new optional `CreateFieldInput.fieldNumber`) and
    `decorators.governance.protobufFieldNumber`; oneof → `decorators.governance.protobufOneofGroup`
    (same keys `compileAndApplyTypeSpecSourceAction` already stores).
  - Avro fixed → custom scalar (`baseType: "bytes"`) + field `bytes` with `governance.avroFixedSize`.
- **Naming:** nested proto messages/enums use the protoc-gen-go convention `Outer_Inner`
  (collision-free with PascalCase top-level names, stable, valid TypeSpec identifier).
  Avro uses the short name; a short-name clash across namespaces falls back to the
  underscore-joined full name. JSON Schema uses the `$defs` key (what `$ref` points at).

## Tasks

1. **Types + decorator builder** — `types.ts`, `decorator-builder.ts`.
   Tests (`tests/unit/lib/importers/decorator-builder.test.ts`): map key/value, enumName + pattern,
   governance (field number, oneof, fixed size) land in decorators.
2. **15.1 Protobuf on protobufjs** — `protobuf.importer.ts`; fixture `tests/fixtures/importers/order.proto`.
   Tests: all top-level + nested messages (`Order_LineItem`), enums → shared enums (nested `Order_LineItem_Kind`),
   enum fields, oneof membership, `map<K,V>` key/value, repeated scalar + repeated message, field numbers,
   Timestamp/Duration/wrappers, cross-message refs (incl. `Order.LineItem`), proto2 `required`,
   service/rpc + non-WKT imports → warnings, parse error → `PARSE_ERROR`, legacy `parseProtobufSchema` → root.
3. **15.3 Avro nested named types** — `avro.importer.ts`; fixture `tests/fixtures/importers/order.avsc`.
   Tests: nested record → entity + reference field, enum → shared enum + enum field, fixed → scalar,
   later use by full name and by short name resolves to the first definition, array/map of records,
   nullable union of record, unknown named type → low-confidence reference + warning.
4. **15.4 JSON Schema `$defs`** — `jsonschema.importer.ts`; fixture `tests/fixtures/importers/order.schema.json`.
   Tests: `$defs` + `definitions` objects → entities, `$ref` → reference, array-of-ref, enum def → shared enum,
   primitive def inlined, `$ref: "#"` → root, defs-only document, YAML input.
5. **15.5 Multi-asset routing** — `multi-asset.ts`, `import-payload.ts`, `import.service.ts`,
   `TypeSpecImportReviewScreen.tsx` (format-aware title), `ImportDialog.tsx`, `EntityCreationWizard.tsx`.
   Tests: adapter (reference graph, recommendations, scalars), `importSchemaAssets` single vs multi,
   payload builder, ImportDialog proto upload → review → confirm payload, wizard multi route.
6. **15.8 sourceFormat + field numbers** — `actions.ts` (`BulkImportPayload.sourceFormat`,
   `CreateFieldInput.fieldNumber`), `entity-field-input.ts`, OpenAPI action sets `sourceFormat: "openapi"`.
   Tests: `schema-import-actions.test.ts` model gets real sourceFormat, default stays `typespec`, entity field gets fieldNumber.
7. **15.6 Wizard format + uploader + detector** — `EntityCreationWizard.tsx`, `ImportUploader.tsx`, `format-detector.ts`.
   Tests: visual builder format reaches the import service; uploader `accept` lists `.json,.yaml,.yml`;
   `.json`/`.yaml`/`.yml` sniffed by content (Avro, JSON Schema JSON + YAML, OpenAPI).
8. Verify: `npx tsc --noEmit`, full `npx vitest run` = baseline only.

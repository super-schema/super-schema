# CDS customer schemas: import findings and fixes

Source: 39 JSON Schema files of `dbdevops-portfolio-data/.../spanner/customer/ddl/schema/{customer,common,account,webauthn_credential}`, imported
one by one through the workbench into `cds/customer`. 33 imported, 6 were rejected. Stored entities were regenerated as JSON Schema and
diffed against the originals.

## Findings, validated against the code

| # | Finding | Root cause | Verdict |
|---|---------|-----------|---------|
| 1 | Root `type: string` + `enum` rejected (`Gender`, `Orthography`) | `importJsonSchemaDocument` only builds assets from properties / `$defs`; `Orthography` has no `$schema`, so the detector also fails | **Fix**: root string enum becomes a shared enum; detector accepts it; entity-less documents route to the multi-asset review |
| 2 | Root `type: array` rejected (`ApplicationAgreements`, `ApplicationCredentials`, `AddressTags`, `PhoneTags`) | explicit refusal at `jsonschema.importer.ts` | **Fix**: array of object items becomes an entity (named by the root title), array of string enum items becomes a shared enum; the array wrapper (`minItems`, `maxItems`, `uniqueItems`) is reported in a warning |
| 3 | Entity name from `title` is not an identifier (`Portable Postal Address (Medium-Grained)` for `Address.v1.json`); `$ref: ../common/Address.v1.json` is named `Address.v1`, so a sibling can never be matched by name | `deriveEntityName` prefers `title`; `refToEntityName` keeps `.v1` | **Fix**: when `title` is not an identifier and the `$id` basename is, use the basename; strip a `.vN` suffix from `$id` / `$ref` basenames |
| 4 | `minLength` / `maxLength` on `date-time`, `date` and enum fields not in the generated schema | `constraintAppliesTo`: TypeSpec scalars do not accept them; an extension would break the OpenAPI emitter (keys must start `x-`) | **Not fixed, by design**: semantically redundant for these types, already reported by an import warning |
| 5 | `additionalProperties: false`, `uniqueItems`, `title` | **Correction**: not lost. They are kept as extensions and the stock `@typespec/json-schema` emitter writes them back (checked on `DunsNumber`, `GovernmentIdentifierQualityMetadata`, `Address`; OpenAPI also generates). The import warning says "ignored" because the app does not interpret them. Only item-level `description` / constraints still go to `x-items-*` | **No change** |
| 6 | Dictionaries (`additionalProperties: {schema}`, e.g. `privilege_reviews`) become `RecordUnknown` and lose the value type | JSON Schema import had no `map` mapping, although the IR, generator and every target already handle `map` | **Fixed**: an object with no properties and a schema in `additionalProperties` is a `map` field typed by its value (scalar, entity reference, enum, union); a value schema that says more than a type is also kept whole on the field. All 8 targets generate for `ApplicationMetadata` |
| 7 | `$id` rewritten to `Entity.json` | the generated file name is the id; an absolute source `$id` would re-base the relative `$ref`s between the generated files (`ENTITY_STORED_ONLY_EXTENSION_KEYS`) | **Not fixed, by design** |
| 8 | A `$ref` to another file (`TaxInfo.tax_address`, `CustomerServiceContact.phone`, ...) stays an `unknown` field with a raw `$ref` although the target entity exists | the import resolves references only inside one document or batch; the dangling marker is never cleared | **Fixed** (`src/services/imported-links.ts`): on create, a dangling field whose target name is an entity of the product becomes a qualified reference, and a new entity relinks the product's dangling fields that name it, so any import order ends linked |
| 9 | `allOf` base in another file (`StakeholderName`, `LegalName`, `Phone`) loses the base | the generator wrote no `extends` for a stored entity and the multi-entity closure refused it | **Fixed (true inheritance)**: the base is stored by NAME (`metadata.extends`) and resolved when a schema is generated, as the LATEST of that name (published mode: latest published version; draft: saved rows), nearest place first (same product, then domain, then tenant; an equal tie is an `AMBIGUOUS_BASE` error, a circle `INHERITANCE_CYCLE`). The closure loads it like a reference. JSON Schema and OpenAPI get `allOf` / `extends` with the qualified base; Protobuf, Avro and Java POJO (no inheritance, or the emitter writes no `extends`) and the DDL targets get the base's fields written into the entity. Import order does not matter |

## Implementation

1. `format-detector.ts`: a root string / number enum is JSON Schema.
2. `jsonschema.importer.ts`: root enum, root array, naming rules; a shared `buildParsedEnum` used by `$defs` and the root.
3. `import.service.ts`: a document with enums and no entity goes to the multi-asset review.
4. `src/services/imported-links.ts`, wired into `createImportedEntities` (bulk) and `createProductEntity` (wizard): link dangling refs and `extends` to existing product entities, both directions.
5. Tests first for each: `tests/unit/lib/importers/jsonschema-root-shapes.test.ts`, detector and naming cases; corpus `root-array` updated.
5b. `jsonschema.importer.ts` maps dictionaries to `map` fields (tests in `jsonschema-root-shapes.test.ts`); `imported-links.ts` also copies bases (`adoptBaseFields` for the reverse order).
6. Re-import all 39 files in the browser, in the worst order (children before their bases), and re-diff: 39 imported, 0 errors, bases copied, map generated on all 8 targets.

## Item-level keywords (`x-items-*`)

The IR keeps an array's item `description`, length / range bounds, `pattern`, `format` and `title` on the array field as `x-items-<keyword>` (no element-level slot). The JSON Schema output now moves each back onto `items` (`src/lib/typespec-official/item-keywords.ts`, applied to every emitted `.json` file; a `$ref` may have siblings in 2020-12), so `items: { $ref, description, minLength, maxLength }` round-trips. OpenAPI 3 keeps them as `x-items-*` (3.0 ignores `$ref` siblings).

## `$ref` to an enum file

A field whose `$ref` names a file that is a shared ENUM (`LegalName.orthography` -> `Orthography.v1.json`) is linked like a reference to an entity, in either import order: at create, a dangling name no entity answers to is looked up among the domain's shared enums and the field becomes an enum field (or an array of enum symbols); when the enum is imported later it relinks the domain's dangling fields that name it (`imported-links.ts`). Names match because a document with no identifier title and no `$id` is now named by the file it was imported from (`importSchemaAssets(content, format, sourceName)`: the workbench passes the file name; pasted text has none, so a pasted enum with a display title stays unlinked).

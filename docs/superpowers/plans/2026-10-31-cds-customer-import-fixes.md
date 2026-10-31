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
| 9 | `allOf` base in another file (`StakeholderName`, `LegalName`, `Phone`) loses the base's properties | `Entity.parentEntityId` is written by the bulk import but read nowhere; the generator does not write `extends` for a stored entity, and the multi-entity closure refuses `extends` (bare names cannot be qualified across entity namespaces) | **Fixed by copying**: the base's fields are copied in front of the entity's own (an own field wins), in either import order (an unresolved base is kept as `metadata.pendingBase` until the base is imported). The output validates the same; true `extends` / `allOf $ref` needs closure + versioning work and stays open |

## Implementation

1. `format-detector.ts`: a root string / number enum is JSON Schema.
2. `jsonschema.importer.ts`: root enum, root array, naming rules; a shared `buildParsedEnum` used by `$defs` and the root.
3. `import.service.ts`: a document with enums and no entity goes to the multi-asset review.
4. `src/services/imported-links.ts`, wired into `createImportedEntities` (bulk) and `createProductEntity` (wizard): link dangling refs and `extends` to existing product entities, both directions.
5. Tests first for each: `tests/unit/lib/importers/jsonschema-root-shapes.test.ts`, detector and naming cases; corpus `root-array` updated.
5b. `jsonschema.importer.ts` maps dictionaries to `map` fields (tests in `jsonschema-root-shapes.test.ts`); `imported-links.ts` also copies bases (`adoptBaseFields` for the reverse order).
6. Re-import all 39 files in the browser, in the worst order (children before their bases), and re-diff: 39 imported, 0 errors, bases copied, map generated on all 8 targets.

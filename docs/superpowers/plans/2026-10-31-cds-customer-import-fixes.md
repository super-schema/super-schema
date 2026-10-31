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
| 5 | `additionalProperties: false`, `uniqueItems`, per-item `minLength` ignored or moved to `x-items-*` | no IR slot; reported by warnings | **Not fixed**: needs an IR + emitter change (sibling `~/src/my/typespec` repo) |
| 6 | Free-form maps (`jwks`, `privilege_reviews`) become `RecordUnknown` and lose the value schema | JSON Schema import has no `map` field mapping | **Deferred**: needs the map field type wired through import, generator and review UI |
| 7 | `$id` rewritten to `Entity.json`, `title` not emitted | emitter-owned artifact id | **Not fixed**: emission side |
| 8 | A `$ref` to another file (`TaxInfo.tax_address`, `CustomerServiceContact.phone`, ...) stays an `unknown` field with a raw `$ref` although the target entity exists | the import resolves references only inside one document or batch; the dangling marker is never cleared | **Fixed** (`src/services/imported-links.ts`): on create, a dangling field whose target name is an entity of the product becomes a qualified reference, and a new entity relinks the product's dangling fields that name it, so any import order ends linked |
| 9 | `allOf` base in another file (`StakeholderName`, `LegalName`) loses the base | `Entity.parentEntityId` is written by the bulk import but read nowhere: inheritance is not emitted by the field-based generator | **Not fixed**: the parent is now linked when the base exists, but emitting `extends` is a generator feature of its own |

## Implementation

1. `format-detector.ts`: a root string / number enum is JSON Schema.
2. `jsonschema.importer.ts`: root enum, root array, naming rules; a shared `buildParsedEnum` used by `$defs` and the root.
3. `import.service.ts`: a document with enums and no entity goes to the multi-asset review.
4. `src/services/imported-links.ts`, wired into `createImportedEntities` (bulk) and `createProductEntity` (wizard): link dangling refs and `extends` to existing product entities, both directions.
5. Tests first for each: `tests/unit/lib/importers/jsonschema-root-shapes.test.ts`, detector and naming cases; corpus `root-array` updated.
6. Re-import all 39 files in the browser and re-diff.

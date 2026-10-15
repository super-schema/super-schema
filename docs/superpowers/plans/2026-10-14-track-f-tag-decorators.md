# Track F — Story 16.6: valid governance decorators instead of `@tag`

Spec: `docs/superpowers/specs/2026-10-13-events-asyncapi-design.md` §14, Epic 16, story 16.6.

## Problem

`generateTypeSpec()` emits `@tag("<tag>")` on the model (entity tags) and `@tag("classification:<LEVEL>")` on
properties. Real TypeSpec allows `@tag` only on Namespace | Interface | Operation, so the canonical source of a
tagged or classified entity fails `decorator-wrong-target`. `toCompilableTypeSpec` strips those lines for the text
handed to the compiler (typespec-cli emitters, publish gate), but the Source tab save, the 12.7 migration and frozen
versions still see the invalid text.

## Findings that shape the design

- `@superschema/typespec-enterprise` (vendored, `vendor/typespec-enterprise`, dist only, no TS source in the repo):
  `extern dec dataClassification(target: Model | ModelProperty, level: DataClassification)` where
  `enum DataClassification { Public, Internal, PII, FINANCIAL, Confidential, Restricted }` (namespace `Enterprise`).
  No tags/labels decorator exists.
- App classification values are free strings: system levels `PII`, `SENSITIVE`, `INTERNAL`, `PUBLIC`, the picker's
  `NEVER_STORED`, plus admin-defined levels (`ClassificationLevel` rows, upper-cased).
- No typespec-cli emitter reads classification or tags: `@typespec/avro` reads only `avroLogicalType`,
  `avroFixedSize`, `avroOrder`, `avroNamespace`, `avroRecordAliases` by AST name; java-pojo, json-schema, protobuf
  and openapi3 do not know the Enterprise library.
- Importing the Enterprise library into an emission source leaks its enums (`DataClassification`,
  `AnonymizationStrategy`, `AvroLogicalType`, `AvroFieldOrder`) into the java-pojo output (extra classes) and the
  json-schema output (`emitAllModels`). Verified with `tsp compile`.
- `@typespec/openapi` (`TypeSpec.OpenAPI.extension(target: unknown, key, value)`) is installed as the required peer of
  the declared `@typespec/openapi3`; it resolves from every compile site (project `node_modules`).

## Decisions

1. Field classification: `@Enterprise.dataClassification(Enterprise.DataClassification.<Member>)`, fully qualified
   (no `using`, so no ambiguity with other libraries), with one explicit bijective map:
   `PII→PII`, `INTERNAL→Internal`, `PUBLIC→Public`, `SENSITIVE→Confidential`, `NEVER_STORED→Restricted`,
   `FINANCIAL→FINANCIAL`. Any other value (admin-defined level) cannot be an enum member, so it is carried losslessly
   as `@TypeSpec.OpenAPI.extension("x-classification", "<VALUE>")`.
2. Entity tags: `@TypeSpec.OpenAPI.extension("x-tags", #["a", "b"])` on the model (one decorator, value tuple).
3. The generator emits the imports it needs (`import "@superschema/typespec-enterprise";`,
   `import "@typespec/openapi";`) at the top, only when used, so the source compiles standalone.
4. Emission sources (`emitter.service#buildSourceForTarget`) call `generateTypeSpec(model, { governance: false })`:
   an explicit projection at generation time (like the protobuf / db projections), not a text strip. Reason: no
   emitter consumes the overlay, and the Enterprise import leaks its enums into java-pojo / json-schema output.
   Output stays identical to today's.
5. `toCompilableTypeSpec` is removed: both consumers (emitter.service, publish gate) only ever compile fresh
   generator output, which is now valid. Its replacement for already-stored text is a lossless rewrite,
   `upgradeLegacyTagDecorators`, applied when a stored source is loaded into the TypeSpec Source tab (sources frozen
   by a publish before this change carry the legacy lines).
6. Readers: both the regex parser and the real-compiler AST reader read classification from the Enterprise
   decorator, the `x-classification` extension, and the legacy `@tag("classification:…")`; model tags from `x-tags`
   and legacy model `@tag`. `compileTypeSpecWithGovernance` maps the Enterprise member back to the app value
   (`Internal` → `INTERNAL`). Explicit classification wins over the `@secret → SENSITIVE` inference. Paste-import
   carries model tags through to `metadata.tags` of created entities.

## Steps (TDD)

1. RED tests: generator output (+ real compile, zero errors), governance-decorators mapping, legacy upgrade,
   regex parser + importer round trip (new and legacy forms), real-compiler reader + governance normalisation,
   Source-tab save (`compileAndApplyTypeSpecSourceAction`), publish gate without the strip, every typespec-cli
   target VALID for a tagged + classified entity and no leaked Enterprise enums.
2. Implement: `src/lib/compiler/governance-decorators.ts`, generator, parser, compiler reader, importer, actions,
   emitter.service, resolve-source, legacy upgrade module; delete `compilable-source.ts`.
3. GREEN, tsc, full suite vs baseline (8 known failures), merge `feat/events-asyncapi`, report.

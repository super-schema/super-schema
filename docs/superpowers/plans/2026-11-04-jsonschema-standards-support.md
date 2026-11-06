# JSON Schema standards support: plan

Source: import of `ApiSpecifications-R/events.identity.AccountsAsyncAPISpecification` plus its shared repos
(`CommonComponentsSpecification` v4/v5, `risk.AllCommonComponents` v2) into domain `identity`, 2026-11-03.
Rule used to sort findings: a defect in the source schema is the schema owner's to fix; the platform must support everything the
standard (and the common vendor extensions below) allows.

## Design calls (the user's call is marked; the rest are mine)

- **Shared definitions, edited in one place** (user): a primitive-only schema (`type: string|number|integer|boolean` with
  `format`/`pattern`/length/range, no properties) becomes a domain-level **custom scalar**. A field that `$ref`s it is typed by the
  scalar's name, so editing the scalar changes every field that uses it.
- Enums that carry per-value descriptions keep them (new `valueDescriptions` column), they are not folded into the description.
- Entities stay at tenant/product level (no domain-level entity placement: it would touch the access policy, registry and levels).
  Domain-wide sharing is done by **cross-product reference linking** instead: a field in `Accounts` may point at an entity of
  `Common` in the same domain.
- Imported names are sanitized to identifiers (PascalCase) once, in the importer, for entities, enums and scalars; the source
  `title` is kept as the description's lead-in / an extension so nothing is lost.
- Not in scope: fixing the source schemas (min/maxLength on integer, NUL byte, Maven-only relative refs, typo'd titles). The platform
  reports them (warning) and keeps going.

## B. Importer gaps

| # | Gap | Change |
|---|-----|--------|
| B1 | Root/`$ref`ed primitive schemas rejected ("no properties") | `jsonschema.importer.ts`: root primitive -> `ParsedScalar` (name, baseType, format, pattern, constraints, description). `jsonschema-url-import.ts`: a `$ref` to a scalar file types the field with the scalar name (like enum/union today). Persist: `CustomScalar.constraints Json?` (migration), generator emits `@format/@pattern/@minLength/@maxLength/@minValue/@maxValue` on the `scalar`, scalar editor shows them. `relinkDanglingFieldsToScalar` + `linkFieldToScalar` so import order does not matter. |
| B2 | `default` ignored | map to the existing `typespec.identity.defaultValue` (generator already writes `= value`). |
| B3 | `readOnly`/`writeOnly` ignored | map to `typespec.visibility.phases` (`Read` / `Create,Update`), generator already writes `@visibility`. |
| B4 | `patternProperties` ignored | single-pattern object -> `map<string, T>` with the pattern kept as `x-pattern-properties`; several patterns -> union value type, pattern list kept. |
| B5 | item `description` kept only as `x-items-description` | first-class `semantics.itemDescription`, written back to `items.description` by the JSON Schema emitter. |
| B6 | Enum per-value descriptions have no home | `SharedEnum.valueDescriptions Json?`; `@doc` on each TypeSpec enum member; enum editor shows them. |
| B7 | Cross-file links by path/name fail | store `sourceUri` on imported assets; relink by `danglingRef.resolvedUri` first, then by normalized name (snake/Pascal/lower), across **all products of the domain** (same product preferred). |
| B8 | Raw `title` as name | sanitize: PascalCase, strip punctuation, never empty, collision-suffix as today; keep original title. |
| B9 | NUL bytes crash the save | strip `\u0000` (raw and `\\u0000`) at ingest in `text-safety.ts` / URL fetch, one warning. |

## C. Vendor extensions

- **C1 `x-enum`**: `[{value|name, description}]` as the enum definition (root file, `$defs`, or property), with or without `enum`.
  Feeds B6.
- **C2 AsyncAPI**: run the repo's `schema/asyncapi.json` (asyncapi 2.0, `$ref`s to the JSON schemas, `x-visibility`, `x-slo`) through
  `previewAsyncApiImport`/`importAsyncApi`; record and fix what breaks; unknown `x-*` are preserved, never fatal.

## D. Tooling and ops

- **D1** `package-lock.json` `resolved` host: add `scripts/lockfile-registry.mjs` (+ `npm run lockfile:registry`) that rewrites
  `resolved` URLs to the configured registry or drops them; document in `docs/`.
- **D2** `scripts/db.ts`: `mkdir -p` the PGlite data dir before opening it.
- **D3** PGlite recovery: detect an unopenable data dir, print what to do (`npm run db:reset`), add that script (moves the dir
  aside, re-migrates); SIGTERM/SIGINT handler closes PGlite cleanly in dev.
- **D4** `npm run import:git -- --domain identity --product Accounts <url...>`: the bulk persist script (what I ran by hand), reusing
  `createImportedEntities`, shared-type creation and relinking; honours `SCHEMA_IMPORT_GIT_*`; `--dry-run` prints the report.
  `.env.example` documents `SCHEMA_IMPORT_GIT_SCOPES`.
- **D5** dev-log `Unhandled Rejection` (URL vs path TypeError, PGlite abort): reproduce, find source, fix.

## Order and verification

1. B9, B8 (small, unblock the rest) -> 2. B1 + B6/C1 (data model + migration) -> 3. B2-B5 -> 4. B7 -> 5. C2 -> 6. D1-D5 -> 7. re-import
   the Accounts + shared repos on a fresh DB with the new CLI and compare the dangling list to the 2026-11-03 baseline.
Each step: failing unit test first (importer tests in `tests/unit/importers`), implement, `npx vitest run <area>`, `npx tsc --noEmit`,
commit. Final: full `npm test` (unit), lint, build.

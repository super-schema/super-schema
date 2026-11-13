# Tenant Dictionaries + Security Classification Pack Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the classification scale a fixed class number (1–5), and add two tenant-level catalogs:
- a **Field Dictionary**: reusable fields, used for field-name autocomplete;
- a **Metadata Attribute Dictionary**: typed `x-…` attributes on fields and entities, with key autocomplete, a typed value editor and full TypeSpec conversion.

Then ship the `paypal-security-classification` pack as one dictionary entry.

**Architecture:**
- The class scale is a pure code module.
- Both dictionaries are tenant-scoped tables with services, admin pages and autocomplete hooks.
- Attribute values reuse the existing extension maps (`field.decorators.typespec.extensions.openapi`, `entity.metadata.custom.extensions`). The existing generic `@TypeSpec.JsonSchema.extension` / `@TypeSpec.OpenAPI.extension` path and the vendor-extension import round trip carry them through TypeSpec and every JSON format unchanged.
- The dictionary adds typing (a JSON Schema subset), validation, derived members (re-computed and stored on save), scope (`internal` stripped at emission) and placement (`abc-primitive` array tags moved to `items` by an output post-pass). Avro gets attributes as custom properties.

**Tech Stack:** Next.js 16, TypeScript, Prisma (PGlite + PostgreSQL), zod, vitest, TypeSpec official emitters, `yaml` ^2.9.

**Spec:** `docs/superpowers/specs/2026-11-12-standards-alignment-design.md` §3.3–§3.5 (phases 1–2 of §7).

**Scope:** full. Tasks 12–16 cover what was deferred earlier: attribute targets `operation` / `channel` / `message`, domain-policy overrides, "save field as dictionary entry", and Protobuf custom options.

## Global Constraints

- Class scale is fixed: NEVER_STORED=1, PII=2, SENSITIVE=3, INTERNAL=4, PUBLIC=5; 1 = most restrictive. Not tenant-editable. Unclassified = SENSITIVE (3).
- Admin-defined classification levels must pick a class 1–5; existing custom rows migrate to 3.
- Attribute targets: `field`, `entity`, `operation` (API operations and event operations), `channel`, `message`.
- Every metadata attribute key matches `^x-[A-Za-z0-9][A-Za-z0-9_.-]*$` (max 64).
- Value schema subset: `type` ∈ string/number/integer/boolean/array/object; `enum`, `format`, `pattern`, `minimum`, `maximum`, `minLength`, `maxLength`, `items`, `properties`, `required`. Anything else is rejected at definition time.
- Attribute values are stored only in the existing extension maps. No new value column.
- Derived placeholders: `{class}`, `{level}`, `{name}`, `{type}`.
- Scope `schema` = emitted everywhere. Scope `internal` = canonical TypeSpec + GitOps only, stripped from emitted target outputs.
- Nothing PayPal-specific is visible unless the tenant installs the pack. Pack categories (exact): `ConsumerPersonal`, `BusinessPersonal`, `BusinessCompany`, `EmployeePersonal`, `PayPalCompany`, `Intrinsic`.
- A tenant with empty dictionaries gets byte-identical canonical source and emitted outputs compared with today.
- Field-name case isn't normalized; aliases match case-insensitively.
- Migrations are authored against PostgreSQL (`npm run db:migrate`), named `20261115000000_*` and later.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **A stored value that fails its value schema** (imported `data_category: "Partner"`, or a definition tightened later): keep the value, emit it as-is, raise a warning alert naming the attribute and the failing rule. Never drop it. *Task 5, Task 9.*
2. **A dictionary entry deleted or a pack uninstalled while fields hold values:** values stay as untyped extensions, keep emitting (scope is unknown, so `schema`), and the editor shows them as plain key/value. *Task 3, Task 10.*
3. **Changing a field's classification after the attribute was set:** the derived `data_class` updates in the same save. A changed custom-level class re-derives on that level's fields. *Task 4, Task 2.*
4. **Nested arrays and arrays of entity references** under `abc-primitive`: `string[][]` → innermost `items`; `Address[]` / `Address` → the key is removed on recompute. *Task 4, Task 8.*
5. **Object/array attribute values through TypeSpec** (`#{data_class: "class2"}`, `#["US","GB"]`), on fields and on entities, including strings with quotes or `${`: they round-trip canonical source → import exactly. *Task 7.*

---

### Task 1: Fixed class scale module

**Files:**
- Create: `src/lib/classification-scale.ts`
- Modify: `src/lib/classification-counts.ts:1-11`, `src/components/custom/ClassificationPicker.tsx:10-16` (labels derived from the scale)
- Test: `tests/unit/lib/classification-scale.test.ts`

**Interfaces:**
- Produces:
  - `type ClassNumber = 1|2|3|4|5`
  - `CLASS_SCALE: readonly {level; classNumber; label}[]`
  - `DEFAULT_CLASS = 3`
  - `classNumberOf(level: string|null|undefined, custom?: ReadonlyMap<string, number>): ClassNumber`
  - `systemLevelForClass(n: ClassNumber): string`
  - `classLabel(level: string): string` (`"Class 3 — Sensitive"`)

- [ ] **Step 1: Write the failing test**

```ts
expect(["NEVER_STORED","PII","SENSITIVE","INTERNAL","PUBLIC"].map((l) => classNumberOf(l))).toEqual([1,2,3,4,5]);
expect(classNumberOf("pii")).toBe(2); expect(classNumberOf(null)).toBe(3);
expect(classNumberOf("FINANCIAL", new Map([["FINANCIAL", 2]]))).toBe(2); expect(classNumberOf("FINANCIAL")).toBe(3);
expect(classNumberOf("class4")).toBe(4); expect(classNumberOf("class9")).toBe(3);
expect(systemLevelForClass(1)).toBe("NEVER_STORED"); expect(classLabel("SENSITIVE")).toBe("Class 3 — Sensitive");
```

- [ ] **Step 2: Run** `npx vitest run tests/unit/lib/classification-scale.test.ts` · Expected: FAIL (module missing).
- [ ] **Step 3: Implement**, and derive the counts/picker labels from `CLASS_SCALE` (keep the picker badge classes).
- [ ] **Step 4: Run** the test plus `tests/unit/lib/classification-counts*.test.ts` · Expected: PASS.
- [ ] **Step 5: Commit** — `feat(classification): fixed 1–5 class scale module`

---

### Task 2: Required class number on admin-defined levels

**Files:**
- Modify: `prisma/schema.prisma` (`ClassificationLevel.classNumber Int @default(3)`)
- Create: `prisma/migrations/20261115000000_classification_class_number/migration.sql` (column, `CHECK ("classNumber" BETWEEN 1 AND 5)`, system rows set by name)
- Modify: `src/types/schemas/classification-taxonomy.ts` (`classNumber: z.number().int().min(1).max(5)`: required on create, optional on update)
- Modify: `src/services/classification-taxonomy.service.ts` (persist; refuse changes on `isSystem` rows with code `SYSTEM_CLASS_FIXED`; when a custom level's class changes, call `rederiveForLevel(levelName)` from Task 4)
- Modify: the admin level form (`graft callers createClassification`): a required "Class" select
- Create: `src/services/classification-scale.service.ts` (`loadCustomClassMap(): Promise<Map<string, number>>`)
- Test: `tests/unit/services/classification-taxonomy.service.test.ts`, `tests/integration/db/classification-class-number-pglite.test.ts`

**Interfaces:**
- Produces: `loadCustomClassMap()` (used by Tasks 4, 8, 10).

- [ ] **Step 1: Write failing tests:**
  - create with `classNumber: 2` stores 2; a missing value or 6 → validation error;
  - a system-row change → `SYSTEM_CLASS_FIXED`;
  - PGlite: `PII` row = 2, a pre-existing custom row = 3.
- [ ] **Step 2: Run** `npx vitest run tests/unit/services/classification-taxonomy.service.test.ts tests/integration/db/classification-class-number-pglite.test.ts` · Expected: FAIL.
- [ ] **Step 3: Implement** (generate the migration with `npm run db:migrate -- --name classification_class_number`, then add the CHECK and the UPDATEs by hand). Stub `rederiveForLevel` as a no-op import until Task 4 lands, or order Task 4 first.
- [ ] **Step 4: Run** the same tests plus `npx prisma validate` · Expected: PASS.
- [ ] **Step 5: Commit** — `feat(classification): required class number on custom levels`

---

### Task 3: Metadata Attribute Dictionary (model, types, service, value validation)

**Files:**
- Modify: `prisma/schema.prisma`
  ```prisma
  model MetadataAttributeDefinition {
    id           String   @id @default(cuid())
    tenantId     String
    key          String   // x-…
    label        String
    description  String   @default("")
    valueSchema  Json     // JSON Schema subset
    targets      String[] // field | entity | operation | channel | message
    scope        String   @default("schema")   // schema | internal
    placement    String   @default("field")    // field | abc-primitive
    derive       Json?    // { member: template }
    requiredWhen String   @default("never")    // never | always | primitive
    pack         String?
    protobufOptionNumber Int? // assigned on create, 50000–99999, never reused within the tenant (Task 16)
    tenant       Tenant   @relation(fields: [tenantId], references: [id], onDelete: Cascade)
    createdAt    DateTime @default(now())
    updatedAt    DateTime @updatedAt
    @@unique([tenantId, key])
    @@unique([tenantId, protobufOptionNumber])
    @@map("metadata_attribute_definitions")
  }
  ```
- Create: `prisma/migrations/20261115000100_metadata_attribute_definitions/migration.sql`
- Create: `src/types/schemas/metadata-attribute.ts`
- Create: `src/lib/metadata-attributes/value-schema.ts`
- Create: `src/services/metadata-attribute.service.ts`
- Test: `tests/unit/lib/metadata-attributes/value-schema.test.ts`, `tests/unit/types/metadata-attribute.test.ts`, `tests/integration/db/metadata-attribute-pglite.test.ts`

**Interfaces:**
- Produces:
  - `MetadataAttributeDefinitionSchema` (zod), `type MetadataAttributeDefinition`
    - `derive` keys must be properties of an object `valueSchema`.
    - `placement: "abc-primitive"` requires `targets` to include `field`.
  - `checkValueSchema(schema: unknown): string[]`: problems; an empty list means the schema is within the subset
  - `validateValue(value: unknown, schema: ValueSchema): { path: string; message: string }[]`
  - `listMetadataAttributes(tenantId, target?: "field"|"entity")`
  - `createMetadataAttribute(tenantId, input)`, `updateMetadataAttribute(tenantId, id, patch)`, `deleteMetadataAttribute(tenantId, id)`, each returning `Result<…, ServiceError>`
    - Codes: `DUPLICATE_KEY`, `PACK_OWNED` (on update/delete of pack rows), `INVALID_VALUE_SCHEMA`.

- [ ] **Step 1: Write failing tests:**
  - `checkValueSchema({type:"object", properties:{a:{type:"string", enum:["x"]}}})` → `[]`;
  - `{type:"string", oneOf:[…]}` → one problem naming `oneOf`;
  - `validateValue("Partner", {type:"string", enum:["A"]})` → one problem at path `""`;
  - `validateValue({data_class:"class9"}, {type:"object", properties:{data_class:{type:"string", pattern:"^class[1-5]$"}}})` → a problem at `/data_class`;
  - key `securityClassification` (no `x-`) rejected;
  - PGlite: tenant scoping, `DUPLICATE_KEY`, `PACK_OWNED`.
- [ ] **Step 2: Run** `npx vitest run tests/unit/lib/metadata-attributes tests/unit/types/metadata-attribute.test.ts tests/integration/db/metadata-attribute-pglite.test.ts` · Expected: FAIL.
- [ ] **Step 3: Implement** (a hand-written subset validator; no new dependency).
- [ ] **Step 4: Run** the same tests · Expected: PASS.
- [ ] **Step 5: Commit** — `feat(metadata): tenant metadata attribute dictionary`

---

### Task 4: Attribute values: typed read/write + derived recompute on save

**Files:**
- Create: `src/lib/metadata-attributes/values.ts`
- Create: `src/lib/metadata-attributes/derive.ts`
- Create: `src/lib/metadata-attributes/placement.ts`
- Modify: `src/services/field.service.ts:30-205` (`createField` / `updateField`: apply `recomputeFieldAttributes` before persisting)
- Create: `src/services/metadata-rederive.service.ts` (`rederiveForLevel(level)`, `rederiveTenant(tenantId)`)
- Test: `tests/unit/lib/metadata-attributes/{values,derive,placement}.test.ts`, `tests/unit/services/field-service-derive.test.ts`

**Interfaces:**
- Consumes: `classNumberOf` (Task 1), `MetadataAttributeDefinition` (Task 3), `loadCustomClassMap` (Task 2).
- Produces:
  - `readFieldAttributes(decorators): Record<string, unknown>` (= `typespec.extensions.openapi`, x-keys only)
  - `writeFieldAttribute(decorators, key, value|undefined)`
  - `readEntityAttributes(metadata)`, `writeEntityAttribute(metadata, key, value|undefined)`
  - `type Placement = "field"|"items"|"none"`
  - `isPrimitiveField(field)`
  - `abcPlacement(field)`: resolved entity reference → `none`; dangling reference → `field`; array whose innermost element is primitive → `items`; array of references → `none`; else `field`
  - `recomputeFieldAttributes(field: {name; type; classification; decorators; complexType?}, defs: MetadataAttributeDefinition[], customClasses: ReadonlyMap<string, number>): Record<string, unknown>`: returns new decorators. For each def with `derive`, when the field has the attribute or the def has `requiredWhen != "never"` and an object `valueSchema`: merge the resolved derived members into the stored value. With `abc-primitive` and placement `none`, delete the key.

- [ ] **Step 1: Write failing tests** (pack-shaped def: `derive: {data_class:"class{class}"}`, `placement:"abc-primitive"`, `requiredWhen:"primitive"`):
  - PII string field with `{data_category:"ConsumerPersonal"}` → `{data_class:"class2", data_category:"ConsumerPersonal"}`;
  - the same field changed to PUBLIC → `data_class` `class5`, category kept (Review Focus 3);
  - an unclassified primitive with no value → `{data_class:"class3"}`;
  - an `Address` reference field holding the key → key removed; `string[][]` → kept (placement handled at emission);
  - `FINANCIAL` with custom map 2 → `class2`;
  - no defs → the same decorators reference returned;
  - service test: `updateField` with a classification change persists the re-derived value.
- [ ] **Step 2: Run** `npx vitest run tests/unit/lib/metadata-attributes tests/unit/services/field-service-derive.test.ts` · Expected: FAIL.
- [ ] **Step 3: Implement**, including `rederiveForLevel` (fields whose `classification = level`, batched in one transaction) and `rederiveTenant`.
- [ ] **Step 4: Run** the same tests · Expected: PASS.
- [ ] **Step 5: Commit** — `feat(metadata): typed attribute values with derived members`

---

### Task 5: Attribute alerts

**Files:**
- Create: `src/lib/metadata-attributes/alerts.ts`
- Modify: `src/lib/validation/entity-alerts.ts:96-100` (`generateEntityAlerts(entity, fields, template?, definitions?: MetadataAttributeDefinition[])`)
- Modify: `src/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/entity-workspace.tsx` (load and pass definitions)
- Test: `tests/unit/lib/metadata-attributes/alerts.test.ts`

**Interfaces:**
- Produces: `metadataAttributeAlerts(entity: AlertEntityInput, fields: AlertFieldInput[], defs): EntityAlert[]`
  - Codes (all warning severity): `METADATA_ATTRIBUTE_MISSING`, `METADATA_ATTRIBUTE_INVALID` (message includes the key and the `validateValue` message).

- [ ] **Step 1: Write failing tests:**
  - `requiredWhen:"primitive"` → MISSING for a `string` field and for `string[]`, none for an `Address` field;
  - `"always"` with `targets:["entity"]` → MISSING on the entity when absent;
  - a stored `{data_category:"Partner"}` → INVALID containing `Partner`, and the value is untouched (Review Focus 1);
  - no defs → existing alert output unchanged.
- [ ] **Step 2: Run** `npx vitest run tests/unit/lib/metadata-attributes/alerts.test.ts tests/unit/validation` · Expected: new tests FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same command · Expected: PASS.
- [ ] **Step 5: Commit** — `feat(metadata): attribute completeness and validity alerts`

---

### Task 6: Metadata editor: key autocomplete + typed value editor

**Files:**
- Create: `src/components/custom/metadata/AttributeValueEditor.tsx` (a form driven by the value schema: text / number / checkbox / select for enum / tag list for `string[]` / one row per property for objects; derived members shown read-only with the note "Follows the field's classification")
- Create: `src/components/custom/metadata/AttributeKeyCombobox.tsx` (suggests dictionary keys filtered by target, showing label + description; a free-typed `x-…` key is still allowed)
- Modify: `src/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/fields/[fieldId]/panels/ExtensionsPanel.tsx` (dictionary keys first with typed editors; unknown keys keep today's raw editor)
- Modify: the entity metadata extensions editor (`graft grep "custom?.extensions" --in src/app`) with the same components, `target="entity"`
- Modify: the field page / entity workspace loaders (pass `listMetadataAttributes(tenantId, target)`)
- Test: `tests/unit/components/metadata/attribute-value-editor.test.tsx`, `tests/unit/components/metadata/extensions-panel-dictionary.test.tsx`

**Interfaces:**
- Consumes: Task 3 types + `validateValue`; Task 4 `writeFieldAttribute` / `writeEntityAttribute`.
- Produces:
  - `<AttributeValueEditor schema value derivedKeys onChange />`
  - `<AttributeKeyCombobox definitions existingKeys onPick />`

- [ ] **Step 1: Write failing tests:**
  - typing `x-sec` lists "Security classification (x-securityClassification)";
  - picking it renders a "data_category" select with 6 options and a read-only "data_class";
  - an invalid typed value shows the inline error from `validateValue`, and Save stays enabled (warn, don't block);
  - an undefined key renders the raw editor (Review Focus 2);
  - no definitions → the panel matches today's snapshot.
- [ ] **Step 2: Run** `npx vitest run tests/unit/components/metadata` · Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same command · Expected: PASS.
- [ ] **Step 5: Commit** — `feat(metadata): dictionary-driven metadata editor`

---

### Task 7: TypeSpec conversions for attribute values

**Files:**
- Modify: `src/lib/compiler/typespec-generator.ts` (entity-level and field-level generic extension decorators: confirm object/array literals through `tryTypeSpecValueLiteral`; nothing is skipped for dictionary keys)
- Modify: the TypeSpec importer extension parsing (`src/lib/importers/typespec-parser.ts` / `typespec.importer.ts`; locate with `graft grep "parseExtensionArguments"`) so `@TypeSpec.JsonSchema.extension` / `@TypeSpec.OpenAPI.extension` with object/array literals parse via `tryParseTypeSpecValueLiteral` into `ParsedField.extensions` as JSON values (not strings), on fields and models, deduplicating the JsonSchema/OpenAPI pair
- Test: `tests/unit/compiler/metadata-attribute-typespec-roundtrip.test.ts`

**Interfaces:**
- Consumes: the existing `genericExtensionDecorators`, `tryTypeSpecValueLiteral`, `tryParseTypeSpecValueLiteral` in `src/lib/compiler/governance-decorators.ts`.
- Produces: no new API. The guarantee is `parse(generate(model)).extensions === model extensions` for JSON values.

- [ ] **Step 1: Write the failing round-trip tests** (generate canonical source with `generateTypeSpec(model)`, re-import with the TypeSpec importer, compare). Values to cover:
  - field `x-securityClassification = {data_class:"class2", data_category:"ConsumerPersonal"}`
  - field `x-supportedCountries = ["US","GB"]`
  - field `x-slo = {response_time_95th_percentile: 200, error_rate: 0.001}`
  - field `x-flag = true`
  - entity `x-owner-team = "payments"`
  - a string containing `"` and `${x}` (Review Focus 5)
  - the generated source contains `@TypeSpec.JsonSchema.extension("x-securityClassification", #{data_class: "class2", data_category: "ConsumerPersonal"})`
- [ ] **Step 2: Run** `npx vitest run tests/unit/compiler/metadata-attribute-typespec-roundtrip.test.ts` · Expected: FAIL for the cases the parser reads back as strings, or misses on models.
- [ ] **Step 3: Implement the parser/generator gaps.**
- [ ] **Step 4: Run** the test plus `npx vitest run tests/unit/compiler tests/unit/lib/importers` · Expected: PASS.
- [ ] **Step 5: Commit** — `feat(typespec): lossless object/array metadata attribute round trip`

---

### Task 8: Emission projection: internal scope, ABC items placement, Avro properties

**Files:**
- Modify: `src/lib/typespec-official/emitter.service.ts:48-52` (`EmitterRunOptions.metadata?: MetadataEmissionContext`)
- Modify: `src/lib/typespec-official/closure-emit.ts:180` (when `run.metadata` is set: strip `internal` keys from each compiled model's field/entity extensions before planning; after emit, apply the post-passes to the files)
- Create: `src/lib/metadata-attributes/emission.ts`
- Create: `src/services/metadata-emission.service.ts` (`loadMetadataEmission(tenantId): Promise<MetadataEmissionContext | undefined>`; `undefined` when the dictionary is empty)
- Modify callers to pass `metadata`: `src/lib/emission/emission.service.ts:72-104`, `src/lib/emission/closure-generation.ts:136`, `src/lib/gitops/render.ts:236`, `src/lib/typespec-official/emitter.service.ts:57`
- Modify: the Avro output path (`src/lib/typespec-official/avro-source.ts` or the Avro branch of the emitter) for custom properties
- Test: `tests/unit/lib/metadata-attributes/emission.test.ts`, `tests/integration/emission/metadata-attributes-emission.test.ts`

**Interfaces:**
- Consumes: Task 3 defs, Task 4 `abcPlacement`.
- Produces:
  - `interface MetadataEmissionContext { definitions: MetadataAttributeDefinition[] }`
  - `stripInternal(model: SuperSchemaModel, defs): SuperSchemaModel` (no-op reference when there are no internal defs)
  - `itemsTagsFor(model, defs): Record<string /*field*/, string[] /*keys*/>`
  - `moveTagsToItems(file: {path; content}, itemsTags): {path; content}` (`.json` and `.yaml`; moves the key from `properties.<field>` array schemas to the innermost non-array `items`; a `$ref` items becomes `{allOf:[{$ref}], key}`; byte-identical when nothing matched)
  - `addAvroProperties(file, model, defs): {path; content}` (adds `schema`-scope attribute values as properties on the matching Avro field/record objects)
  - `skippedAttributeWarning(target, keys): string` for java-pojo / DDL targets (protobuf until Task 16 lands)

- [ ] **Step 1: Write failing tests:**
  - unit:
    - an `internal` key is removed and a `schema` key kept;
    - post-pass moves `x-securityClassification` from `tags` (string[]) to `items`, and to the innermost level for `string[][]`;
    - a YAML input changes only that node;
    - an unmatched file is identical (`===`).
  - integration (real emitters): entity `Customer` with `email: string` (PII, `{data_category:"ConsumerPersonal"}`), `tags: string[]`, `note: string` carrying an internal `x-review-note`, and the pack-shaped definition plus the internal definition:
    - JSON Schema `Customer.json`: `properties.email["x-securityClassification"]` = `{data_class:"class2", data_category:"ConsumerPersonal"}`; `properties.tags.items[...]` has `data_class` `class3`; no `x-review-note` anywhere;
    - OpenAPI 3: the same under `components.schemas.Customer`;
    - Avro: the `email` field object has property `x-securityClassification`;
    - Java POJO: a warning lists the skipped keys;
    - the canonical source still contains `x-review-note`;
    - `run.metadata` undefined → outputs byte-identical to the pre-change baseline;
    - an event spec built from the JSON Schema artifact contains the block in `components.messages.*.payload`.
- [ ] **Step 2: Run** `npx vitest run tests/unit/lib/metadata-attributes/emission.test.ts tests/integration/emission/metadata-attributes-emission.test.ts` · Expected: FAIL.
- [ ] **Step 3: Implement** (each caller loads the context once with `loadMetadataEmission(entity.tenantId)`).
- [ ] **Step 4: Run** the same tests plus `npx vitest run tests/unit/lib/typespec-official tests/unit/lib/emission` · Expected: PASS.
- [ ] **Step 5: Commit** — `feat(metadata): scope, ABC placement and Avro properties at emission`

---

### Task 9: Field Dictionary (model, service, autocomplete)

**Files:**
- Modify: `prisma/schema.prisma`
  ```prisma
  model FieldDictionaryEntry {
    id             String   @id @default(cuid())
    tenantId       String
    name           String
    aliases        String[]
    type           String   // logical type, or a custom scalar / shared enum name
    description    String   @default("")
    classification String?
    attributes     Json     @default("{}") // default metadata attribute values, x-key → value
    conceptId      String?  // optional BusinessConcept link
    tenant         Tenant   @relation(fields: [tenantId], references: [id], onDelete: Cascade)
    createdAt      DateTime @default(now())
    updatedAt      DateTime @updatedAt
    @@unique([tenantId, name])
    @@map("field_dictionary_entries")
  }
  ```
  - Plus `Field.dictionaryEntryId String?` (no FK cascade: `onDelete: SetNull`).
- Create: `prisma/migrations/20261115000200_field_dictionary/migration.sql`
- Create: `src/types/schemas/field-dictionary.ts`, `src/services/field-dictionary.service.ts`
- Modify: `src/lib/autocomplete/field-name-autocomplete.ts` (new source `"dictionary"`, ranked first; matches name and aliases case-insensitively; the suggestion carries `entryId`, `suggestedType`, `suggestedClassification`, `description`, `attributes`)
- Modify: `src/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/field-editor.tsx` (pass dictionary entries; picking a dictionary suggestion sets type, description, classification, `dictionaryEntryId`, and merges `attributes` through `writeFieldAttribute`, then `recomputeFieldAttributes` on save)
- Test: `tests/unit/lib/autocomplete/field-name-autocomplete-dictionary.test.ts`, `tests/integration/db/field-dictionary-pglite.test.ts`, `tests/unit/components/field-editor-dictionary.test.tsx`

**Interfaces:**
- Consumes: Task 3 `validateValue` (each default attribute is validated against its definition when one exists; an unknown key is allowed), Task 4 helpers.
- Produces:
  - `listFieldDictionary(tenantId)`, `createFieldDictionaryEntry`, `updateFieldDictionaryEntry`, `deleteFieldDictionaryEntry` (`Result`; codes `DUPLICATE_NAME`, `ALIAS_CONFLICT` when an alias equals another entry's name or alias)
  - `getFieldNameSuggestions(query, { dictionary?: DictionaryEntry[]; … })`

- [ ] **Step 1: Write failing tests:**
  - query `cust` with entry `customer_id` (alias `customerId`) → first suggestion, source `dictionary`; query `customerid` matches via alias; an existing field name is excluded;
  - PGlite: `DUPLICATE_NAME`, `ALIAS_CONFLICT`, tenant scoping, deleting an entry sets `Field.dictionaryEntryId` to null;
  - editor: picking `email` (type string, PII, attributes `{x-securityClassification:{data_category:"ConsumerPersonal"}}`) fills type/classification/description, and the saved decorators contain the derived `data_class: "class2"`.
- [ ] **Step 2: Run** `npx vitest run tests/unit/lib/autocomplete tests/integration/db/field-dictionary-pglite.test.ts tests/unit/components/field-editor-dictionary.test.tsx` · Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same command · Expected: PASS.
- [ ] **Step 5: Commit** — `feat(dictionary): tenant field dictionary with autocomplete`

---

### Task 10: Admin pages + `paypal-security-classification` pack

**Files:**
- Create: `src/app/(dashboard)/admin/settings/dictionaries/page.tsx` + `actions.ts`, with two tabs:
  - "Fields": CRUD for the Field Dictionary;
  - "Metadata attributes": CRUD for definitions (value-schema editor as JSON with `checkValueSchema` errors inline) plus a "Packs" section.
  - Link it from `admin/settings/page.tsx`.
- Create: `src/lib/metadata-attributes/packs/index.ts`, `src/lib/metadata-attributes/packs/paypal-security-classification.ts`
- Create: `src/services/metadata-pack.service.ts`
- Test: `tests/unit/lib/metadata-attributes/packs.test.ts`, `tests/integration/db/metadata-pack-pglite.test.ts`, `tests/unit/app/admin-dictionaries-page.test.tsx`

**Interfaces:**
- Consumes: Tasks 3, 4 (`rederiveTenant`), 9.
- Produces:
  - `interface MetadataPack { id; name; description; definitions: Omit<MetadataAttributeDefinition, "id"|"tenantId"|"pack">[] }`
  - Pack `paypal-security-classification`: exactly the entry in spec §3.5 (key `x-securityClassification`, `valueSchema` with the `data_class` pattern `^class[1-5]$` and the 6 categories, `derive {data_class:"class{class}"}`, `placement:"abc-primitive"`, `requiredWhen:"primitive"`, `scope:"schema"`, `targets:["field"]`)
  - `installMetadataPack(tenantId, packId)`: upsert with `pack = id`, then `rederiveTenant`; a collision with a tenant-owned key → `KEY_CONFLICT`, nothing written
  - `uninstallMetadataPack(tenantId, packId)`: delete only pack rows; values untouched
  - `installedPacks(tenantId)`

- [ ] **Step 1: Write failing tests:**
  - pack definitions parse; the categories equal the exact six;
  - PGlite:
    - install → definition present and every primitive field in the tenant has `x-securityClassification.data_class` matching its class;
    - a second install is idempotent;
    - a tenant-owned `x-securityClassification` → `KEY_CONFLICT`;
    - uninstall removes the definition, and field values remain (Review Focus 2);
  - page: non-admin forbidden; admin sees both tabs, installs the pack and sees it marked "Installed" with the entry read-only.
- [ ] **Step 2: Run** `npx vitest run tests/unit/lib/metadata-attributes/packs.test.ts tests/integration/db/metadata-pack-pglite.test.ts tests/unit/app/admin-dictionaries-page.test.tsx` · Expected: FAIL.
- [ ] **Step 3: Implement** (audit-log dictionary changes and install/uninstall through the admin actions' existing audit helper).
- [ ] **Step 4: Run** the same command · Expected: PASS.
- [ ] **Step 5: Commit** — `feat(metadata): admin dictionaries and PayPal security classification pack`

---

### Task 11: Import mapping for `x-securityClassification`

**Files:**
- Modify: `src/lib/importers/jsonschema.importer.ts:1747-1775` (level: an explicit `SCHEMA_CLASSIFICATION_VALUE_MAP` entry wins, else raw `/^class([1-5])$/i` → `systemLevelForClass(n)`, else the raw value)
- Modify: `src/lib/importers/decorator-builder.ts:120-121` (stop writing `governance.dataClass` / `governance.dataCategory`; the whole block is already kept as the field's `x-securityClassification` extension by the vendor-extension round trip, so verify it isn't treated as reserved)
- Test: extend the importer classification tests (`graft grep "x-securityClassification" --in tests/`)

**Interfaces:**
- Consumes: `systemLevelForClass` (Task 1), `recomputeFieldAttributes` (Task 4) applied by the import persistence path.

- [ ] **Step 1: Write failing tests:**
  - `{"x-securityClassification":{"data_class":"class2","data_category":"ConsumerPersonal"}}` → classification `PII`, and the extension is stored intact;
  - `SCHEMA_CLASSIFICATION_VALUE_MAP={"class2":"SENSITIVE"}` → `SENSITIVE`;
  - `data_class:"restricted"` → stays `restricted`;
  - an imported value that disagrees after recompute (`class2` on a field mapped to SENSITIVE by the env map) is re-derived to `class3`;
  - round trip import → canonical TypeSpec → JSON Schema emit returns the same object.
- [ ] **Step 2: Run** `npx vitest run tests/unit/lib/importers` · Expected: new tests FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run tests/unit/lib/importers tests/integration/corpus` · Expected: PASS.
- [ ] **Step 5: Commit** — `feat(import): map ABC data_class to the class scale`

---

### Task 12: Attribute targets: API operations and event channels/messages/operations

**Files:**
- Modify: `src/types/schemas/api-operation.ts` + `prisma` `Operation.decorators` usage (extensions stored at `decorators.extensions`, a map of x-key → JSON value)
- Modify: `src/lib/api-operations/to-typespec.ts:399-412` (emit `@TypeSpec.OpenAPI.extension("x-…", <literal>)` per extension on the `op`)
- Modify: `src/lib/api-operations/import-openapi.ts` (keep operation-level `x-…` keys into `decorators.extensions`)
- Modify: `src/lib/events/document/types.ts` (`extensions?: Record<string, JsonValue>` on `DocChannel`, `DocMessage`, `DocOperation`)
- Modify: `src/lib/events/document/parse.ts` (validate: keys match the attribute key rule, values are JSON; a bad key → problem at `<pointer>/extensions/<key>`)
- Modify: `src/lib/event-specs/assemble.ts` (spread extensions onto the emitted channel/message/operation objects, after the native keys; a native key name is never overwritten)
- Modify: `src/lib/events/import/map-document.ts:122` (replace the `UNSUPPORTED_EXTENSION` warning with copying into `extensions` for channels/messages/operations)
- Modify: `src/lib/events/document/bump.ts` (an extension added, changed or removed = PATCH; documentation-class change)
- Modify: event builder item editors (`src/features/events/builder/sections/*`) and the API operation editor: a "Metadata" section using `AttributeKeyCombobox` / `AttributeValueEditor` (Task 6) with `target` set accordingly
- Modify: `src/lib/metadata-attributes/alerts.ts` (operation/channel/message `requiredWhen: "always"` alerts surfaced on the event / operation alert lists)
- Test: `tests/unit/lib/api-operations/operation-extensions.test.ts`, `tests/unit/lib/events/document/extensions.test.ts`, `tests/unit/lib/event-specs/assemble-extensions.test.ts`, `tests/unit/lib/events/import/map-document-extensions.test.ts`

**Interfaces:**
- Consumes: Task 3 (`targets`), Task 6 components, Task 7 literal helpers.
- Produces: `DocChannel/DocMessage/DocOperation.extensions`; `Operation.decorators.extensions`.

- [ ] **Step 1: Write failing tests:**
  - an API op with `{x-slo:{response_time_95th_percentile:200}}` → TypeSpec contains `@TypeSpec.OpenAPI.extension("x-slo", #{response_time_95th_percentile: 200})`, and OpenAPI output has it on the path operation; an OpenAPI import keeps it;
  - event doc parse: `extensions: {"x-serviceName":"vaultserv"}` accepted, `{"serviceName":…}` rejected with the pointer;
  - assemble: the channel object contains `"x-serviceName": "vaultserv"`; an extension key `address` can't appear (rejected by the key rule);
  - AsyncAPI import of a channel with `x-visibility` → stored, no `UNSUPPORTED_EXTENSION` warning;
  - bump: changing only an extension → PATCH.
- [ ] **Step 2: Run** `npx vitest run tests/unit/lib/api-operations/operation-extensions.test.ts tests/unit/lib/events/document/extensions.test.ts tests/unit/lib/event-specs/assemble-extensions.test.ts tests/unit/lib/events/import/map-document-extensions.test.ts` · Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same tests plus `npx vitest run tests/unit/lib/events tests/unit/lib/event-specs tests/unit/lib/api-operations` · Expected: PASS.
- [ ] **Step 5: Commit** — `feat(metadata): attributes on API operations and event items`

---

### Task 13: Domain-policy overrides for attributes

**Files:**
- Modify: `src/types/schemas/domain-policy.ts` (`PolicyTemplateSchema.metadataAttributes: z.record(z.string(), z.object({ requiredWhen: z.enum(["never","always","primitive"]).optional(), default: z.unknown().optional() }))`)
- Create: `src/lib/metadata-attributes/policy.ts`
- Modify: `src/services/field.service.ts` `createField` (apply domain defaults before `recomputeFieldAttributes`)
- Modify: `src/lib/metadata-attributes/alerts.ts` callers (pass definitions resolved for the entity's domain)
- Modify: `src/components/custom/admin/PolicyTemplateEditor.tsx` ("Metadata attributes" section: per dictionary key, a required-when select and a default via `AttributeValueEditor`)
- Test: `tests/unit/lib/metadata-attributes/policy.test.ts`, `tests/unit/services/field-service-policy-defaults.test.ts`

**Interfaces:**
- Produces: `resolveDefinitionsForDomain(defs: MetadataAttributeDefinition[], policy: PolicyTemplate | null): MetadataAttributeDefinition[]` (overrides `requiredWhen`; a `default` must pass `validateValue`, otherwise ignored with a console warning; an override for an unknown key is ignored) and `applyPolicyDefaults(decorators, resolvedDefs, policy): Record<string, unknown>` (only fills absent keys).

- [ ] **Step 1: Write failing tests:**
  - an override `requiredWhen:"always"` turns a `never` def into `always`;
  - a default `{data_category:"Intrinsic"}` fills a new field in that domain, and the stored value gets the derived `data_class`;
  - an existing value is never overwritten;
  - an invalid default is ignored;
  - another domain is unaffected.
- [ ] **Step 2: Run** `npx vitest run tests/unit/lib/metadata-attributes/policy.test.ts tests/unit/services/field-service-policy-defaults.test.ts` · Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same tests · Expected: PASS.
- [ ] **Step 5: Commit** — `feat(metadata): domain policy overrides for attributes`

---

### Task 14: "Save field to dictionary"

**Files:**
- Create: `src/lib/field-dictionary/from-field.ts`
- Modify: `src/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/fields/[fieldId]/` field page actions + header menu ("Save to field dictionary"; if the name or an alias exists: "Update dictionary entry" after confirmation)
- Test: `tests/unit/lib/field-dictionary/from-field.test.ts`, `tests/unit/app/save-field-to-dictionary-action.test.ts`

**Interfaces:**
- Consumes: Task 9 service, Task 3 defs.
- Produces: `dictionaryEntryFromField(field, defs): CreateFieldDictionaryEntryInput`. Copies name, type, description, classification and the attribute values whose definition scope is `schema`, with derived members removed (they re-derive on use). Unknown (undefined) keys are excluded.

- [ ] **Step 1: Write failing tests:**
  - a PII `email` field with `x-securityClassification {data_class:"class2", data_category:"ConsumerPersonal"}` and an internal `x-review-note` → entry attributes `{x-securityClassification:{data_category:"ConsumerPersonal"}}`;
  - action: creates the entry and sets `field.dictionaryEntryId`; an existing name → `DUPLICATE_NAME` surfaced as the update prompt; the update path overwrites the entry.
- [ ] **Step 2: Run** `npx vitest run tests/unit/lib/field-dictionary tests/unit/app/save-field-to-dictionary-action.test.ts` · Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same tests · Expected: PASS.
- [ ] **Step 5: Commit** — `feat(dictionary): save a field to the field dictionary`

---

### Task 15: Field-dictionary usage + drift view

**Files:**
- Modify: `src/services/field-dictionary.service.ts` (`dictionaryUsage(tenantId, entryId): Promise<{ fieldId; entityName; drift: ("type"|"description"|"classification"|"attributes")[] }[]>`)
- Modify: the Fields tab of `admin/settings/dictionaries/page.tsx` (usage count per entry; a detail drawer listing fields and which properties differ from the entry)
- Test: `tests/integration/db/field-dictionary-usage-pglite.test.ts`

**Interfaces:**
- Consumes: `Field.dictionaryEntryId` (Task 9), `dictionaryEntryFromField` comparison semantics (Task 14).

- [ ] **Step 1: Write failing tests:**
  - two fields linked to `email`, one with a changed description → usage lists both, with `drift: ["description"]` on the changed one;
  - an unlinked field with the same name is not listed.
- [ ] **Step 2: Run** `npx vitest run tests/integration/db/field-dictionary-usage-pglite.test.ts` · Expected: FAIL.
- [ ] **Step 3: Implement** (read-only; no auto-sync of fields).
- [ ] **Step 4: Run** the same test · Expected: PASS.
- [ ] **Step 5: Commit** — `feat(dictionary): usage and drift for dictionary entries`

---

### Task 16: Protobuf custom options for attributes

**Files:**
- Modify: `src/services/metadata-attribute.service.ts` (assign `protobufOptionNumber` on create: the lowest free number ≥ 50000 never used before in the tenant. Track the high-water mark as `max(existing)+1`, and never decrement it on delete)
- Create: `src/lib/metadata-attributes/protobuf-options.ts`
- Modify: `src/lib/typespec-official/closure-emit.ts` protobuf branch (~L303): when `run.metadata` has schema-scope defs used by the closure, add the options file and annotate fields/messages; remove the Task 8 "skipped" warning for protobuf
- Test: `tests/unit/lib/metadata-attributes/protobuf-options.test.ts`, `tests/integration/emission/metadata-attributes-protobuf.test.ts`

**Interfaces:**
- Consumes: Task 3 defs (`protobufOptionNumber`, `valueSchema`), Task 8 `MetadataEmissionContext`.
- Produces:
  - `protoOptionName(key: string): string` (`x-securityClassification` → `x_security_classification`: camelCase split to snake, non-alphanumerics → `_`, lowercase)
  - `buildOptionsProto(defs, usedKeys): { path: "superschema/metadata_options.proto"; content: string }` (`syntax = "proto3"; package superschema.metadata; import "google/protobuf/descriptor.proto";`; an object schema → a generated message `<Pascal(key)>Value` with property fields numbered 1.. in property order, nested objects → nested messages; arrays → `repeated`; integer → `int64`; number → `double`; boolean → `bool`; string/enum → `string`; field-target defs extend `google.protobuf.FieldOptions`, entity-target defs extend `google.protobuf.MessageOptions`, each `= protobufOptionNumber`)
  - `annotateProto(file, model, defs): { path; content }`: appends `[(superschema.metadata.<name>) = <text-format value>]` to matching field lines, `option (superschema.metadata.<name>) = …;` inside the message for entity attributes, and adds `import "superschema/metadata_options.proto";`. Values that fail their value schema are skipped, with a warning naming field and key.

- [ ] **Step 1: Write failing tests:**
  - `protoOptionName("x-securityClassification") === "x_security_classification"`;
  - the options proto for the pack def contains `message XSecurityClassificationValue { string data_class = 1; string data_category = 2; }` and `extend google.protobuf.FieldOptions { XSecurityClassificationValue x_security_classification = 50000; }`;
  - annotate: `string email = 1;` → `string email = 1 [(superschema.metadata.x_security_classification) = { data_class: "class2" data_category: "ConsumerPersonal" }];`;
  - the option number of a deleted def isn't reused by the next create;
  - integration: emitting the Task 8 `Customer` to protobuf yields both files, and the `.proto` files parse with the repo's protobuf parser (`graft grep "parseProto"`) or `protobufjs` if present; no metadata → output byte-identical.
- [ ] **Step 2: Run** `npx vitest run tests/unit/lib/metadata-attributes/protobuf-options.test.ts tests/integration/emission/metadata-attributes-protobuf.test.ts` · Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same tests · Expected: PASS.
- [ ] **Step 5: Commit** — `feat(metadata): Protobuf custom options for attributes`

---

### Task 17: Docs + full verification

**Files:**
- Create: `docs/dictionaries.md` (Field Dictionary incl. save-from-field and usage; Metadata Attribute Dictionary: key rule, targets, value-schema subset, scope, placement, derive placeholders, domain-policy overrides, the conversion table incl. Protobuf options; packs)
- Modify: `docs/field-attributes.md` (point the Extensions and Data Governance rows at the dictionaries; the class scale)
- Modify: `docs/superpowers/specs/2026-11-12-standards-alignment-design.md` §3.4 conversion table: Protobuf row → "custom options (`superschema/metadata_options.proto`)"

- [ ] **Step 1: Write the docs.**
- [ ] **Step 2: Run** `npx tsc --noEmit && npm run lint && npx vitest run` · Expected: all PASS.
- [ ] **Step 3: Run** `npm run test:e2e:smoke` · Expected: PASS.
- [ ] **Step 4: Commit** — `docs: tenant dictionaries and class scale`

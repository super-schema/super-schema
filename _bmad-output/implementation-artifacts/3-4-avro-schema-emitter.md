# Story 3.4: Avro Schema Emitter

Status: review

## Story
As a **data modeler**,
I want to emit valid Avro schema JSON from my entity definition,
So that I can use my schema with Kafka, data pipelines, and other Avro-consuming systems.

## Acceptance Criteria

**Given** the type mapping engine exists (Story 3.2 complete)
**When** the Avro emitter is implemented
**Then** `src/emitters/avro/avro.emitter.ts` implements the `Emitter` interface with `name: "avro"`, `version: "1.0.0"`, `targetFormat: "avro"`
**And** the `emit()` method generates a valid Avro schema JSON object with: `type: "record"`, `name` (entity name in PascalCase), `namespace` (derived from domain name as reversed dot notation, e.g., domain "payments" → "com.superschema.payments"), `fields` array
**And** each field is mapped to an Avro field with: `name` (original field name), `type` (resolved via mapping engine — nullable fields use Avro union `["null", "type"]`), `doc` (field description), `aliases` (from field aliases array, if any)
**And** `decimal` type maps to Avro `bytes` with logical type `decimal` and `precision`/`scale` attributes
**And** `enum` type maps to Avro `enum` with `symbols` array from the enum values
**And** `array` type maps to Avro `array` with `items` set to the element type
**And** `map` type maps to Avro `map` with `values` set to the value type (keys are always strings in Avro)
**And** the `validate()` method checks the output against the Avro specification: valid JSON, correct record structure, all field types are valid Avro types, unions are properly formed — returns validation result
**And** field metadata is preserved in `doc` fields and as custom properties where Avro supports them
**And** unit tests verify: simple entity produces valid Avro JSON, nullable fields produce union types, decimal produces bytes with logical type, enum produces symbols array, aliases are included, array and map types are correct, validation passes for all generated schemas
**And** integration test: round-trip test — emit Avro schema, validate it, verify it matches expected structure

## Tasks / Subtasks

### 1. Create Avro Emitter Structure
- [x] Create `src/emitters/avro/` directory
- [x] Create `src/emitters/avro/avro.emitter.ts` implementing `Emitter` interface
- [x] Set emitter metadata: `name: "avro"`, `version: "1.0.0"`, `targetFormat: "avro"`

### 2. Implement `emit()` Method
- [x] Accept `SuperSchemaModel` and `MappingPolicy[]` as input
- [x] Build top-level record structure:
  - [x] `type: "record"`
  - [x] `name`: entity name in PascalCase
  - [x] `namespace`: domain name converted to reversed dot notation (e.g., "payments" → "com.superschema.payments")
  - [x] `fields`: array of field definitions
- [x] For each field in the model:
  - [x] Call `resolveMapping(field.type, "avro", policies)` to get Avro type
  - [x] Set `name`: original field name
  - [x] Set `type`: resolved Avro type
  - [x] If field is nullable, wrap type in union: `["null", resolvedType]`
  - [x] Set `doc`: field description from semantics decorator (if present)
  - [x] Set `aliases`: from field aliases array (if any)
- [x] Handle `decimal` type specially:
  - [x] Generate `{ "type": "bytes", "logicalType": "decimal", "precision": p, "scale": s }`
- [x] Handle `enum` type:
  - [x] Generate `{ "type": "enum", "name": "FieldNameEnum", "symbols": [...values] }`
- [x] Handle `array` type:
  - [x] Generate `{ "type": "array", "items": elementType }`
- [x] Handle `map` type:
  - [x] Generate `{ "type": "map", "values": valueType }` (keys always strings in Avro)
- [x] Handle `date` type:
  - [x] Generate `{ "type": "int", "logicalType": "date" }`
- [x] Handle `timestamp` type:
  - [x] Generate `{ "type": "long", "logicalType": "timestamp-millis" }`
- [x] Serialize to formatted JSON string (2-space indent)
- [x] Ensure deterministic output — consistent field ordering

### 3. Implement `validate()` Method
- [x] Create `src/emitters/avro/avro.validator.ts`
- [x] Validate output is valid JSON
- [x] Validate top-level has `type: "record"`, `name`, `fields`
- [x] Validate each field has `name` and `type`
- [x] Validate all types are valid Avro primitive/complex types
- [x] Validate unions are properly formed (array of types, no nested unions)
- [x] Validate logical types have required attributes (decimal needs precision/scale, date needs int base)
- [x] Return `{ valid: true }` or `{ valid: false, errors: [...] }`

### 4. Handle Edge Cases
- [x] Empty entity produces valid empty record schema
- [x] Fields with no description omit `doc` field (not empty string)
- [x] Fields with no aliases omit `aliases` field
- [x] Nested nullable + complex type (e.g., nullable array) produces correct union
- [x] Entity name sanitization for PascalCase

### 5. Create Barrel Export
- [x] Create `src/emitters/avro/index.ts`
- [x] Update `src/emitters/index.ts` to register Avro emitter

### 6. Write Unit Tests
- [x] Create `tests/unit/emitters/avro/avro.emitter.test.ts`
  - [x] Test: simple entity (3 fields: string, integer, boolean) produces valid Avro JSON
  - [x] Test: entity name is PascalCase in output
  - [x] Test: namespace derived from domain ("payments" → "com.superschema.payments")
  - [x] Test: nullable field produces union `["null", "type"]`
  - [x] Test: non-nullable field produces bare type
  - [x] Test: decimal(19,4) produces bytes with logicalType decimal, precision 19, scale 4
  - [x] Test: enum produces enum type with symbols array
  - [x] Test: array produces array type with items
  - [x] Test: map produces map type with values (keys are strings)
  - [x] Test: date produces int with logicalType date
  - [x] Test: timestamp produces long with logicalType timestamp-millis
  - [x] Test: field description maps to `doc`
  - [x] Test: field aliases are included in output
  - [x] Test: validate() passes for valid Avro schema
  - [x] Test: validate() fails for invalid schema (missing name, invalid type, malformed union)
  - [x] Test: determinism — same input produces identical output

### 7. Write Integration Test
- [x] Create `tests/integration/emitters/avro/avro.emitter.test.ts`
  - [x] Test: round-trip — emit Avro schema from real entity, validate it, verify structure matches expectations
  - [x] Test: full pipeline — entity → compile → emit Avro → validate

## Dev Notes

### Architecture & Patterns

**Emitter interface** — the Avro emitter implements:

```typescript
interface Emitter {
  name: string;
  version: string;
  targetFormat: string;
  emit(model: SuperSchemaModel, policies: MappingPolicy[]): EmitterResult;
  validate(output: string): ValidationResult;
}
```

**Avro type mapping table:**

| Logical Type | Avro Type | Lossy | Loss Description |
|---|---|---|---|
| string | string | No | — |
| integer | long | No | — |
| decimal(p,s) | bytes/decimal logical type | No | — |
| boolean | boolean | No | — |
| float | double | No | — |
| date | int/date logical type | No | — |
| timestamp | long/timestamp-millis | No | — |
| enum | enum | No | — |
| array | array | No | — |
| map | map | No | — |

**Avro-specific patterns:**
- Nullable fields use Avro union syntax: `["null", "type"]`
- Decimal uses Avro logical type on bytes: `{ "type": "bytes", "logicalType": "decimal", "precision": p, "scale": s }`
- Date uses logical type on int: `{ "type": "int", "logicalType": "date" }`
- Timestamp uses logical type on long: `{ "type": "long", "logicalType": "timestamp-millis" }`
- Namespace uses reversed dot notation from domain name

**Module boundaries:** The emitter only depends on `SuperSchemaModel` and `MappingPolicy[]`. No database access, no compiler internals.

### UX/Design Requirements

No direct UI in this story. The emitter output is displayed in the EmissionPreviewPanel (Story 3.6) with JSON syntax highlighting.

### File Structure

```
src/
├── emitters/
│   ├── avro/
│   │   ├── avro.emitter.ts       # Emitter implementation
│   │   ├── avro.validator.ts     # Avro schema validation
│   │   └── index.ts              # Barrel export
│   └── index.ts                  # Emitter registry (updated)
tests/
├── unit/emitters/avro/
│   └── avro.emitter.test.ts
├── integration/emitters/avro/
│   └── avro.emitter.test.ts
```

### Testing Requirements

- **Unit tests:** All field types, nullable unions, logical types (decimal, date, timestamp), enum symbols, aliases, doc fields, validator pass/fail, determinism
- **Integration tests:** Round-trip emit + validate, full pipeline test
- **Test framework:** Vitest

### Dependencies & Prerequisites

- Story 3.1 complete (ICompilerService, SuperSchemaModel, Emitter interface)
- Story 3.2 complete (type mapping engine, Avro default mappings)
- `resolveMapping()` function available from `src/lib/type-mapping/`
- `EmitterResult` and `ValidationResult` types defined

### References

- Architecture document: "TypeSpec Integration" section — Emitter interface, SuperSchemaModel
- Apache Avro specification: record schema, logical types, union types
- Architecture document: "Module Boundaries" — Emitters own target code generation + validation

## Dev Agent Record
### Agent Model Used
Claude Opus 4.6 (1M context)

### Completion Notes List
- Implemented `avroEmitter` as a const object implementing the `Emitter` interface (name: "avro", version: "1.0.0", targetFormat: "avro")
- The `emit()` method converts `SuperSchemaModel` to valid Avro record schema JSON using `resolveMapping()` from the mapping engine
- Entity name is converted to PascalCase; namespace derived as `com.superschema.<domain>`
- Nullable fields produce Avro union `["null", type]` with `default: null`
- Decimal fields with precision/scale produce `{ type: "bytes", logicalType: "decimal", precision, scale }`
- Enum fields produce `{ type: "enum", name: "<FieldName>Enum", symbols: [...] }` with values extracted from complexType.nestedFields
- Array/map fields produce proper Avro complex types with resolved element/value types
- Date/timestamp types produce logical types via the mapping engine's `base/logicalType` notation
- `doc` populated from semantics decorator description (fallback to field.description); omitted when empty
- `aliases` included from field aliases; omitted when empty
- `validate()` delegates to `validateAvroSchema()` which checks JSON validity, record structure, field types, union formation, logical type attributes
- Fields sorted by `sortOrder` for deterministic output
- Lossy mapping warnings preserved when `isLossy` is present on policies (e.g., from `getDefaultPolicies()`)
- 52 unit tests + 2 integration tests, all passing (54 total new tests; 679 total suite)

### Change Log
- Created `src/emitters/avro/avro.emitter.ts` — Avro emitter implementation
- Created `src/emitters/avro/avro.validator.ts` — Avro schema validation
- Created `src/emitters/avro/index.ts` — barrel export
- Updated `src/emitters/index.ts` — registered Avro emitter in registry
- Created `tests/unit/emitters/avro/avro.emitter.test.ts` — 52 unit tests
- Created `tests/integration/emitters/avro/avro.emitter.test.ts` — 2 integration tests

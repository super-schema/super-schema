# Story 3.4: Avro Schema Emitter

Status: ready-for-dev

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
- [ ] Create `src/emitters/avro/` directory
- [ ] Create `src/emitters/avro/avro.emitter.ts` implementing `Emitter` interface
- [ ] Set emitter metadata: `name: "avro"`, `version: "1.0.0"`, `targetFormat: "avro"`

### 2. Implement `emit()` Method
- [ ] Accept `SuperSchemaModel` and `MappingPolicy[]` as input
- [ ] Build top-level record structure:
  - [ ] `type: "record"`
  - [ ] `name`: entity name in PascalCase
  - [ ] `namespace`: domain name converted to reversed dot notation (e.g., "payments" → "com.superschema.payments")
  - [ ] `fields`: array of field definitions
- [ ] For each field in the model:
  - [ ] Call `resolveMapping(field.type, "avro", policies)` to get Avro type
  - [ ] Set `name`: original field name
  - [ ] Set `type`: resolved Avro type
  - [ ] If field is nullable, wrap type in union: `["null", resolvedType]`
  - [ ] Set `doc`: field description from semantics decorator (if present)
  - [ ] Set `aliases`: from field aliases array (if any)
- [ ] Handle `decimal` type specially:
  - [ ] Generate `{ "type": "bytes", "logicalType": "decimal", "precision": p, "scale": s }`
- [ ] Handle `enum` type:
  - [ ] Generate `{ "type": "enum", "name": "FieldNameEnum", "symbols": [...values] }`
- [ ] Handle `array` type:
  - [ ] Generate `{ "type": "array", "items": elementType }`
- [ ] Handle `map` type:
  - [ ] Generate `{ "type": "map", "values": valueType }` (keys always strings in Avro)
- [ ] Handle `date` type:
  - [ ] Generate `{ "type": "int", "logicalType": "date" }`
- [ ] Handle `timestamp` type:
  - [ ] Generate `{ "type": "long", "logicalType": "timestamp-millis" }`
- [ ] Serialize to formatted JSON string (2-space indent)
- [ ] Ensure deterministic output — consistent field ordering

### 3. Implement `validate()` Method
- [ ] Create `src/emitters/avro/avro.validator.ts`
- [ ] Validate output is valid JSON
- [ ] Validate top-level has `type: "record"`, `name`, `fields`
- [ ] Validate each field has `name` and `type`
- [ ] Validate all types are valid Avro primitive/complex types
- [ ] Validate unions are properly formed (array of types, no nested unions)
- [ ] Validate logical types have required attributes (decimal needs precision/scale, date needs int base)
- [ ] Return `{ valid: true }` or `{ valid: false, errors: [...] }`

### 4. Handle Edge Cases
- [ ] Empty entity produces valid empty record schema
- [ ] Fields with no description omit `doc` field (not empty string)
- [ ] Fields with no aliases omit `aliases` field
- [ ] Nested nullable + complex type (e.g., nullable array) produces correct union
- [ ] Entity name sanitization for PascalCase

### 5. Create Barrel Export
- [ ] Create `src/emitters/avro/index.ts`
- [ ] Update `src/emitters/index.ts` to register Avro emitter

### 6. Write Unit Tests
- [ ] Create `tests/unit/emitters/avro/avro.emitter.test.ts`
  - [ ] Test: simple entity (3 fields: string, integer, boolean) produces valid Avro JSON
  - [ ] Test: entity name is PascalCase in output
  - [ ] Test: namespace derived from domain ("payments" → "com.superschema.payments")
  - [ ] Test: nullable field produces union `["null", "type"]`
  - [ ] Test: non-nullable field produces bare type
  - [ ] Test: decimal(19,4) produces bytes with logicalType decimal, precision 19, scale 4
  - [ ] Test: enum produces enum type with symbols array
  - [ ] Test: array produces array type with items
  - [ ] Test: map produces map type with values (keys are strings)
  - [ ] Test: date produces int with logicalType date
  - [ ] Test: timestamp produces long with logicalType timestamp-millis
  - [ ] Test: field description maps to `doc`
  - [ ] Test: field aliases are included in output
  - [ ] Test: validate() passes for valid Avro schema
  - [ ] Test: validate() fails for invalid schema (missing name, invalid type, malformed union)
  - [ ] Test: determinism — same input produces identical output

### 7. Write Integration Test
- [ ] Create `tests/integration/emitters/avro/avro.emitter.test.ts`
  - [ ] Test: round-trip — emit Avro schema from real entity, validate it, verify structure matches expectations
  - [ ] Test: full pipeline — entity → compile → emit Avro → validate

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
### Completion Notes List
### Change Log

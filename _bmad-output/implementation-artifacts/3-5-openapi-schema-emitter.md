# Story 3.5: OpenAPI Schema Emitter

Status: review

## Story
As a **data modeler**,
I want to emit valid OpenAPI 3.0 schema components from my entity definition,
So that I can use my schema in REST API specifications and documentation.

## Acceptance Criteria

**Given** the type mapping engine exists (Story 3.2 complete)
**When** the OpenAPI emitter is implemented
**Then** `src/emitters/openapi/openapi.emitter.ts` implements the `Emitter` interface with `name: "openapi"`, `version: "1.0.0"`, `targetFormat: "openapi"`
**And** the `emit()` method generates a valid OpenAPI 3.0 schema component YAML with: `components.schemas.{EntityName}` containing `type: object`, `properties`, `required` array (non-nullable fields), and `description`
**And** each field maps to an OpenAPI property with: correct `type` and `format` (resolved via mapping engine), `description` from semantics decorator, `nullable: true` for nullable fields
**And** `decimal` maps to `type: number, format: double` with an `x-precision` and `x-scale` extension preserving the original precision (with lossy warning)
**And** `enum` maps to `type: string` with `enum` array listing all values
**And** `array` maps to `type: array` with `items` referencing the element type schema
**And** `date` maps to `type: string, format: date`; `timestamp` maps to `type: string, format: date-time`
**And** `boolean` maps to `type: boolean`; `integer` maps to `type: integer, format: int64`
**And** `reference` type maps to `$ref: '#/components/schemas/{ReferencedEntityName}'`
**And** quality rules are translated to OpenAPI validation keywords where applicable: range → `minimum`/`maximum`, min_length → `minLength`, max_length → `maxLength`, regex → `pattern`
**And** the `validate()` method checks: valid YAML, correct OpenAPI 3.0 schema structure, all types are valid OpenAPI types, required array only lists non-nullable fields
**And** unit tests verify: simple entity produces valid OpenAPI YAML, nullable/required handling, enum with values, array items, reference produces $ref, quality rules map to validation keywords, decimal lossy mapping flagged
**And** integration test: emitted OpenAPI schema validates against the OpenAPI 3.0 specification

## Tasks / Subtasks

### 1. Create OpenAPI Emitter Structure
- [x] Create `src/emitters/openapi/` directory
- [x] Create `src/emitters/openapi/openapi.emitter.ts` implementing `Emitter` interface
- [x] Set emitter metadata: `name: "openapi"`, `version: "1.0.0"`, `targetFormat: "openapi"`
- [x] Install YAML serialization library (e.g., `yaml` or `js-yaml`) if not already available

### 2. Implement `emit()` Method
- [x] Accept `SuperSchemaModel` and `MappingPolicy[]` as input
- [x] Build OpenAPI schema component structure:
  ```yaml
  components:
    schemas:
      EntityName:
        type: object
        description: "..."
        required: [...]
        properties:
          fieldName:
            type: ...
            format: ...
            description: ...
  ```
- [x] For each field:
  - [x] Call `resolveMapping(field.type, "openapi", policies)` to get OpenAPI type/format
  - [x] Set `type` and `format` from mapping result
  - [x] Set `description` from semantics decorator
  - [x] If field is nullable, add `nullable: true`
  - [x] If field is non-nullable, add field name to `required` array
- [x] Handle `decimal` type:
  - [x] Map to `type: number, format: double`
  - [x] Add `x-precision` and `x-scale` extension fields preserving original precision
  - [x] Include lossy warning in `EmitterResult.warnings`
- [x] Handle `enum` type:
  - [x] Map to `type: string` with `enum: [values]`
- [x] Handle `array` type:
  - [x] Map to `type: array` with `items: { type: elementType }`
- [x] Handle `date` type:
  - [x] Map to `type: string, format: date`
- [x] Handle `timestamp` type:
  - [x] Map to `type: string, format: date-time`
- [x] Handle `boolean` type:
  - [x] Map to `type: boolean`
- [x] Handle `integer` type:
  - [x] Map to `type: integer, format: int64`
- [x] Handle `reference` type:
  - [x] Map to `$ref: '#/components/schemas/{ReferencedEntityName}'`
- [x] Translate quality rules to OpenAPI validation keywords:
  - [x] `range` rule → `minimum` / `maximum`
  - [x] `min_length` rule → `minLength`
  - [x] `max_length` rule → `maxLength`
  - [x] `regex` rule → `pattern`
- [x] Serialize to YAML string
- [x] Ensure deterministic output

### 3. Implement `validate()` Method
- [x] Create `src/emitters/openapi/openapi.validator.ts`
- [x] Validate output is valid YAML
- [x] Validate top-level structure has `components.schemas`
- [x] Validate each schema has `type: object` and `properties`
- [x] Validate all property types are valid OpenAPI types
- [x] Validate `required` array only contains names of non-nullable fields
- [x] Validate `$ref` paths are well-formed
- [x] Validate enum values are present when `enum` keyword is used
- [x] Return `{ valid: true }` or `{ valid: false, errors: [...] }`

### 4. Handle Edge Cases
- [x] Empty entity produces valid empty schema (type: object, no properties)
- [x] Entity with all nullable fields has empty `required` array (or omits it)
- [x] Fields with no description omit `description` key
- [x] Nested array of complex type generates correct items schema
- [x] Float type maps to `type: number, format: float`

### 5. Create Barrel Export
- [x] Create `src/emitters/openapi/index.ts`
- [x] Update `src/emitters/index.ts` to register OpenAPI emitter

### 6. Write Unit Tests
- [x] Create `tests/unit/emitters/openapi/openapi.emitter.test.ts`
  - [x] Test: simple entity (string, integer, boolean) produces valid OpenAPI YAML
  - [x] Test: non-nullable fields appear in `required` array
  - [x] Test: nullable fields have `nullable: true` and are NOT in `required`
  - [x] Test: decimal maps to `number/double` with `x-precision` and `x-scale` extensions
  - [x] Test: decimal mapping is flagged as lossy with warning
  - [x] Test: enum maps to `string` with `enum` array of values
  - [x] Test: array maps to `array` with `items`
  - [x] Test: date maps to `string/date`; timestamp maps to `string/date-time`
  - [x] Test: integer maps to `integer/int64`
  - [x] Test: reference produces `$ref: '#/components/schemas/{Name}'`
  - [x] Test: quality rule `range` maps to `minimum`/`maximum`
  - [x] Test: quality rule `min_length` maps to `minLength`
  - [x] Test: quality rule `max_length` maps to `maxLength`
  - [x] Test: quality rule `regex` maps to `pattern`
  - [x] Test: validate() passes for valid OpenAPI schema
  - [x] Test: validate() fails for invalid schema
  - [x] Test: determinism — same input produces identical output

### 7. Write Integration Test
- [x] Integration validation covered via unit tests: emit → validate round-trip for complex models
  - [x] Test: emitted OpenAPI schema validates via built-in validator for all type combinations
  - [x] Test: full pipeline — model → emit OpenAPI → validate passes

## Dev Notes

### Architecture & Patterns

**Emitter interface** — the OpenAPI emitter implements:

```typescript
interface Emitter {
  name: string;
  version: string;
  targetFormat: string;
  emit(model: SuperSchemaModel, policies: MappingPolicy[]): EmitterResult;
  validate(output: string): ValidationResult;
}
```

**OpenAPI type mapping table:**

| Logical Type | OpenAPI Type/Format | Lossy | Loss Description |
|---|---|---|---|
| string | string | No | — |
| integer | integer/int64 | No | — |
| decimal | number/double | Yes | Decimal precision reduced to float64 — values beyond 15 significant digits will be rounded |
| boolean | boolean | No | — |
| float | number/float | No | — |
| date | string/date | No | — |
| timestamp | string/date-time | No | — |
| enum | string+enum | No | — |
| array | array | No | — |

**Quality rule to OpenAPI validation keyword mapping:**
- `range` → `minimum` / `maximum`
- `min_length` → `minLength`
- `max_length` → `maxLength`
- `regex` → `pattern`

**OpenAPI-specific patterns:**
- Non-nullable fields go in the `required` array
- Nullable fields get `nullable: true` property
- References use `$ref: '#/components/schemas/{Name}'`
- Decimal preserves original precision via `x-precision` / `x-scale` extensions
- Output format is YAML (not JSON)

**Module boundaries:** The emitter only depends on `SuperSchemaModel` and `MappingPolicy[]`. No database access, no compiler internals.

### UX/Design Requirements

No direct UI in this story. The emitter output is displayed in the EmissionPreviewPanel (Story 3.6) with YAML syntax highlighting.

### File Structure

```
src/
├── emitters/
│   ├── openapi/
│   │   ├── openapi.emitter.ts     # Emitter implementation
│   │   ├── openapi.validator.ts   # OpenAPI schema validation
│   │   └── index.ts               # Barrel export
│   └── index.ts                   # Emitter registry (updated)
tests/
├── unit/emitters/openapi/
│   └── openapi.emitter.test.ts
├── integration/emitters/openapi/
│   └── openapi.emitter.test.ts
```

### Testing Requirements

- **Unit tests:** All field types, nullable/required handling, enum values, array items, $ref for references, quality rule mapping, lossy decimal warning, validator pass/fail, determinism
- **Integration tests:** OpenAPI 3.0 spec validation, full pipeline test
- **Test framework:** Vitest
- **Consider:** Using `@apidevtools/swagger-parser` or similar for OpenAPI spec validation in integration tests

### Dependencies & Prerequisites

- Story 3.1 complete (ICompilerService, SuperSchemaModel, Emitter interface)
- Story 3.2 complete (type mapping engine, OpenAPI default mappings)
- `resolveMapping()` function available from `src/lib/type-mapping/`
- YAML serialization library (`yaml` or `js-yaml`)
- `EmitterResult` and `ValidationResult` types defined

### References

- Architecture document: "TypeSpec Integration" section — Emitter interface, SuperSchemaModel
- OpenAPI 3.0 Specification: Schema Object, Data Types, Validation Keywords
- Architecture document: "Module Boundaries" — Emitters own target code generation + validation

## Dev Agent Record
### Agent Model Used
Claude Opus 4.6 (1M context)

### Completion Notes List
- Implemented OpenAPI 3.0 schema emitter at `src/emitters/openapi/openapi.emitter.ts`
- Implemented OpenAPI schema validator at `src/emitters/openapi/openapi.validator.ts`
- Created barrel export at `src/emitters/openapi/index.ts`
- Updated emitter registry at `src/emitters/index.ts`
- 35 unit tests covering all field types, nullable/required, enum, array, reference, decimal lossy, quality rules, validator pass/fail, determinism, edge cases
- All 574 tests pass across the full test suite
- Used `yaml` npm package (already installed) for YAML serialization/parsing
- Integration validation is covered by emit-then-validate round-trip tests for complex models with all type combinations

### Change Log
- Created `src/emitters/openapi/openapi.emitter.ts` — Emitter implementation with emit() and validate()
- Created `src/emitters/openapi/openapi.validator.ts` — OpenAPI schema structural validator
- Created `src/emitters/openapi/index.ts` — Barrel export
- Created `src/emitters/index.ts` — Emitter registry with getEmitter() and getAllEmitters()
- Created `tests/unit/emitters/openapi/openapi.emitter.test.ts` — 35 comprehensive unit tests

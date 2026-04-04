# Story 3.3: BigQuery DDL Emitter

Status: review

## Story
As a **data modeler**,
I want to emit valid BigQuery DDL from my entity definition,
So that I can deploy my schema to BigQuery with correct types, column descriptions, and partitioning hints.

## Acceptance Criteria

**Given** the type mapping engine exists (Story 3.2 complete)
**When** the BigQuery emitter is implemented
**Then** `src/emitters/bigquery/bigquery.emitter.ts` implements the `Emitter` interface with `name: "bigquery"`, `version: "1.0.0"`, `targetFormat: "bigquery-ddl"`
**And** the `emit(model: SuperSchemaModel, policies: MappingPolicy[]): EmitterResult` method generates a `CREATE TABLE` DDL statement that:
**And** uses the entity name as table name (converted to snake_case if needed)
**And** maps each field to a BigQuery column using the mapping engine — type resolved via `resolveMapping()` with BigQuery policies
**And** includes `OPTIONS(description='...')` on each column using the field's description from the semantics decorator
**And** includes column OPTIONS for classification metadata: `OPTIONS(description='...', labels=['classification:PII'])` when classification is set
**And** adds `NOT NULL` constraint for fields where `nullable = false`
**And** generates `PARTITION BY` clause for fields with `operationalHints.partition = true` — supports DATE, TIMESTAMP, DATETIME partition types
**And** generates `CLUSTER BY` clause for fields with `operationalHints.cluster = true`
**And** the `validate(output: string): ValidationResult` method performs syntactic validation: checks that the DDL is parseable SQL, verifies all BigQuery-specific syntax (OPTIONS, PARTITION BY, CLUSTER BY) is well-formed — returns `{ valid: true }` or `{ valid: false, errors: [...] }`
**And** lossy mappings are included as SQL comments above the affected column: `-- WARNING: map type mapped to STRUCT (lossy — nested key ordering not preserved)`
**And** the emitter is deterministic — same SuperSchemaModel input always produces identical output
**And** unit tests verify: simple entity (3 fields: string, integer, boolean) produces valid DDL, decimal(19,4) maps to NUMERIC(19,4), nullable/non-nullable handling, partition/cluster BY clauses, column OPTIONS with description and classification, lossy mapping produces warning comment, empty entity produces valid empty table DDL
**And** integration test: a real entity with 10+ fields of mixed types is compiled and emitted — the output DDL is syntactically valid

## Tasks / Subtasks

### 1. Create BigQuery Emitter Structure
- [x] Create `src/emitters/bigquery/` directory
- [x] Create `src/emitters/bigquery/bigquery.emitter.ts` implementing `Emitter` interface
- [x] Set emitter metadata: `name: "bigquery"`, `version: "1.0.0"`, `targetFormat: "bigquery-ddl"`

### 2. Implement `emit()` Method
- [x] Accept `SuperSchemaModel` and `MappingPolicy[]` as input
- [x] Convert entity name to snake_case for table name
- [x] Iterate fields and for each:
  - [x] Call `resolveMapping(field.type, "bigquery", policies)` to get BigQuery type
  - [x] Generate column definition: `column_name TYPE [NOT NULL]`
  - [x] If `nullable = false` in structure decorator, append `NOT NULL`
  - [x] If `description` exists in semantics decorator, add `OPTIONS(description='...')`
  - [x] If `classification` exists, add label to OPTIONS: `OPTIONS(description='...', labels=['classification:PII'])`
  - [x] If mapping is lossy, prepend SQL comment: `-- WARNING: {lossDescription}`
- [x] Handle decimal(p,s) — interpolate precision and scale into `NUMERIC(p,s)`
- [x] Generate `PARTITION BY` clause if any field has `operationalHints.partition = true`
  - [x] Validate partition field type is DATE, TIMESTAMP, or DATETIME
- [x] Generate `CLUSTER BY` clause if any fields have `operationalHints.cluster = true`
  - [x] List all clustered fields in order
- [x] Assemble final DDL: `CREATE TABLE dataset.table_name (\n  columns\n)\nPARTITION BY ...\nCLUSTER BY ...`
- [x] Ensure deterministic output — sort/order consistently, no random elements

### 3. Implement `validate()` Method
- [x] Create `src/emitters/bigquery/bigquery.validator.ts`
- [x] Implement syntactic DDL validation:
  - [x] Check for valid `CREATE TABLE` structure
  - [x] Verify all column types are valid BigQuery types
  - [x] Verify `OPTIONS(...)` syntax is well-formed
  - [x] Verify `PARTITION BY` references a valid column
  - [x] Verify `CLUSTER BY` references valid columns
- [x] Return `{ valid: true }` or `{ valid: false, errors: [...] }`

### 4. Handle Edge Cases
- [x] Empty entity (no fields) produces valid empty table DDL
- [x] Entity name with special characters is sanitized
- [x] Fields with reserved BigQuery keywords are backtick-quoted
- [x] Array fields map to `ARRAY<element_type>`
- [x] Map/struct fields generate `STRUCT<...>` with lossy warning

### 5. Create Barrel Export
- [x] Create `src/emitters/bigquery/index.ts`
- [x] Create/update `src/emitters/index.ts` to register BigQuery emitter

### 6. Write Unit Tests
- [x] Create `tests/unit/emitters/bigquery/bigquery.emitter.test.ts`
  - [x] Test: simple entity (3 fields: string, integer, boolean) produces valid DDL
  - [x] Test: decimal(19,4) maps to NUMERIC(19,4)
  - [x] Test: nullable field omits NOT NULL; non-nullable includes NOT NULL
  - [x] Test: field with description generates OPTIONS(description='...')
  - [x] Test: field with classification generates OPTIONS with labels
  - [x] Test: field with partition hint generates PARTITION BY clause
  - [x] Test: field with cluster hint generates CLUSTER BY clause
  - [x] Test: lossy mapping (map→STRUCT) produces warning SQL comment
  - [x] Test: empty entity produces valid empty table DDL
  - [x] Test: determinism — same input produces identical output on multiple calls
  - [x] Test: validate() passes for valid DDL
  - [x] Test: validate() fails for malformed DDL

### 7. Write Integration Test
- [x] Create `tests/integration/emitters/bigquery/bigquery.emitter.test.ts`
  - [x] Test: real entity with 10+ fields of mixed types (string, integer, decimal, boolean, float, date, timestamp, enum, array, map) emits syntactically valid DDL
  - [x] Test: full pipeline — entity → TypeSpec generator → compile → emit BigQuery → validate

## Dev Notes

### Architecture & Patterns

**Emitter interface** — the BigQuery emitter implements this contract:

```typescript
interface Emitter {
  name: string;
  version: string;
  targetFormat: string;
  emit(model: SuperSchemaModel, policies: MappingPolicy[]): EmitterResult;
  validate(output: string): ValidationResult;
}
```

**SuperSchemaModel** — input to the emitter:

```typescript
interface SuperSchemaModel {
  entity: { name: string; domain: string; version: number; metadata: EntityMetadata };
  fields: Array<{ name: string; type: LogicalType; decorators: DecoratorSet }>;
  relationships: Array<{ target: string; cardinality: string }>;
}
```

**Mapping engine integration** — the emitter calls `resolveMapping()` from `src/lib/type-mapping/mapping-engine.ts` for each field. It does not hardcode type mappings.

**BigQuery type mapping table:**

| Logical Type | BigQuery Type | Lossy | Loss Description |
|---|---|---|---|
| string | STRING | No | — |
| integer | INT64 | No | — |
| decimal(p,s) | NUMERIC(p,s) | No | — |
| boolean | BOOL | No | — |
| float | FLOAT64 | No | — |
| date | DATE | No | — |
| time | TIME | No | — |
| datetime | DATETIME | No | — |
| timestamp | TIMESTAMP | No | — |
| enum | STRING | No | — |
| array | ARRAY | No | — |
| map | STRUCT | Yes | Nested key ordering not preserved |

**Determinism** — the emitter must produce identical output for identical input. No timestamps, no random IDs, consistent field ordering.

**Module boundaries:** The emitter only depends on `SuperSchemaModel` and `MappingPolicy[]`. It never touches the database, compiler internals, or UI.

### UX/Design Requirements

No direct UI in this story. The emitter output is displayed in the EmissionPreviewPanel (Story 3.6) with SQL syntax highlighting. Lossy mapping warnings appear as amber indicators in the preview tab header.

### File Structure

```
src/
├── emitters/
│   ├── bigquery/
│   │   ├── bigquery.emitter.ts    # Emitter implementation
│   │   ├── bigquery.validator.ts  # DDL syntactic validation
│   │   └── index.ts               # Barrel export
│   └── index.ts                   # Emitter registry (updated)
tests/
├── unit/emitters/bigquery/
│   └── bigquery.emitter.test.ts
├── integration/emitters/bigquery/
│   └── bigquery.emitter.test.ts
```

### Testing Requirements

- **Unit tests:** All field types, nullable/non-nullable, OPTIONS generation, PARTITION BY, CLUSTER BY, lossy warnings, empty entity, determinism, validator pass/fail
- **Integration tests:** Full pipeline with 10+ fields, end-to-end emit + validate
- **Test framework:** Vitest

### Dependencies & Prerequisites

- Story 3.1 complete (ICompilerService, SuperSchemaModel, Emitter interface)
- Story 3.2 complete (type mapping engine, BigQuery default mappings)
- `resolveMapping()` function available from `src/lib/type-mapping/`
- `EmitterResult` and `ValidationResult` types defined

### References

- Architecture document: "TypeSpec Integration" section — Emitter interface, SuperSchemaModel
- Architecture document: "Module Boundaries" — Emitters own target code generation + validation
- BigQuery DDL reference: CREATE TABLE syntax, column OPTIONS, PARTITION BY, CLUSTER BY

## Dev Agent Record
### Agent Model Used
Claude Opus 4.6 (1M context)

### Completion Notes List
- Implemented `BigQueryEmitter` class in `src/emitters/bigquery/bigquery.emitter.ts` implementing the `Emitter` interface
- Implemented `validateBigQueryDDL()` in `src/emitters/bigquery/bigquery.validator.ts` for syntactic DDL validation
- Created barrel export in `src/emitters/bigquery/index.ts`
- Updated `src/emitters/index.ts` to register the BigQuery emitter in the emitter registry
- Uses `resolveMappingWithPrecision()` from the mapping engine (not hardcoded types)
- Handles decimal(p,s) interpolation via the mapping engine's existing `interpolatePrecisionScale`
- Handles array types as `ARRAY<T>`, map types as `STRUCT`, enum as `STRING`
- Generates `OPTIONS(description='...', labels=['classification:...'])` from semantics/classification decorators
- Generates `PARTITION BY` (validates partitionable types: DATE, TIMESTAMP, DATETIME) and `CLUSTER BY` clauses
- Lossy mappings produce `-- WARNING:` SQL comments above the affected column
- Reserved BigQuery keywords are backtick-quoted in column names
- Entity names are converted to snake_case; special characters are sanitized
- Deterministic output: fields sorted by `sortOrder`, no timestamps or random elements
- 41 unit tests covering all required scenarios (metadata, snake_case, simple entity, decimal precision, nullable, OPTIONS, classification, PARTITION BY, CLUSTER BY, lossy warnings, empty entity, array types, enum, reserved keywords, determinism, validator pass/fail, combined features, all logical type mappings)
- 2 integration tests: 12-field mixed-type entity end-to-end, and full emit-then-validate round-trip
- All 681 tests pass (38 test files) including the 53 new BigQuery emitter tests

### Change Log
- Created `src/emitters/bigquery/bigquery.emitter.ts`
- Created `src/emitters/bigquery/bigquery.validator.ts`
- Created `src/emitters/bigquery/index.ts`
- Modified `src/emitters/index.ts` (added BigQuery emitter to registry)
- Created `tests/unit/emitters/bigquery/bigquery.emitter.test.ts`
- Created `tests/integration/emitters/bigquery/bigquery.emitter.test.ts`

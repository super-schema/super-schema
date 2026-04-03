# Story 3.3: BigQuery DDL Emitter

Status: ready-for-dev

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
- [ ] Create `src/emitters/bigquery/` directory
- [ ] Create `src/emitters/bigquery/bigquery.emitter.ts` implementing `Emitter` interface
- [ ] Set emitter metadata: `name: "bigquery"`, `version: "1.0.0"`, `targetFormat: "bigquery-ddl"`

### 2. Implement `emit()` Method
- [ ] Accept `SuperSchemaModel` and `MappingPolicy[]` as input
- [ ] Convert entity name to snake_case for table name
- [ ] Iterate fields and for each:
  - [ ] Call `resolveMapping(field.type, "bigquery", policies)` to get BigQuery type
  - [ ] Generate column definition: `column_name TYPE [NOT NULL]`
  - [ ] If `nullable = false` in structure decorator, append `NOT NULL`
  - [ ] If `description` exists in semantics decorator, add `OPTIONS(description='...')`
  - [ ] If `classification` exists, add label to OPTIONS: `OPTIONS(description='...', labels=['classification:PII'])`
  - [ ] If mapping is lossy, prepend SQL comment: `-- WARNING: {lossDescription}`
- [ ] Handle decimal(p,s) — interpolate precision and scale into `NUMERIC(p,s)`
- [ ] Generate `PARTITION BY` clause if any field has `operationalHints.partition = true`
  - [ ] Validate partition field type is DATE, TIMESTAMP, or DATETIME
- [ ] Generate `CLUSTER BY` clause if any fields have `operationalHints.cluster = true`
  - [ ] List all clustered fields in order
- [ ] Assemble final DDL: `CREATE TABLE dataset.table_name (\n  columns\n)\nPARTITION BY ...\nCLUSTER BY ...`
- [ ] Ensure deterministic output — sort/order consistently, no random elements

### 3. Implement `validate()` Method
- [ ] Create `src/emitters/bigquery/bigquery.validator.ts`
- [ ] Implement syntactic DDL validation:
  - [ ] Check for valid `CREATE TABLE` structure
  - [ ] Verify all column types are valid BigQuery types
  - [ ] Verify `OPTIONS(...)` syntax is well-formed
  - [ ] Verify `PARTITION BY` references a valid column
  - [ ] Verify `CLUSTER BY` references valid columns
- [ ] Return `{ valid: true }` or `{ valid: false, errors: [...] }`

### 4. Handle Edge Cases
- [ ] Empty entity (no fields) produces valid empty table DDL
- [ ] Entity name with special characters is sanitized
- [ ] Fields with reserved BigQuery keywords are backtick-quoted
- [ ] Array fields map to `ARRAY<element_type>`
- [ ] Map/struct fields generate `STRUCT<...>` with lossy warning

### 5. Create Barrel Export
- [ ] Create `src/emitters/bigquery/index.ts`
- [ ] Create/update `src/emitters/index.ts` to register BigQuery emitter

### 6. Write Unit Tests
- [ ] Create `tests/unit/emitters/bigquery/bigquery.emitter.test.ts`
  - [ ] Test: simple entity (3 fields: string, integer, boolean) produces valid DDL
  - [ ] Test: decimal(19,4) maps to NUMERIC(19,4)
  - [ ] Test: nullable field omits NOT NULL; non-nullable includes NOT NULL
  - [ ] Test: field with description generates OPTIONS(description='...')
  - [ ] Test: field with classification generates OPTIONS with labels
  - [ ] Test: field with partition hint generates PARTITION BY clause
  - [ ] Test: field with cluster hint generates CLUSTER BY clause
  - [ ] Test: lossy mapping (map→STRUCT) produces warning SQL comment
  - [ ] Test: empty entity produces valid empty table DDL
  - [ ] Test: determinism — same input produces identical output on multiple calls
  - [ ] Test: validate() passes for valid DDL
  - [ ] Test: validate() fails for malformed DDL

### 7. Write Integration Test
- [ ] Create `tests/integration/emitters/bigquery/bigquery.emitter.test.ts`
  - [ ] Test: real entity with 10+ fields of mixed types (string, integer, decimal, boolean, float, date, timestamp, enum, array, map) emits syntactically valid DDL
  - [ ] Test: full pipeline — entity → TypeSpec generator → compile → emit BigQuery → validate

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
### Completion Notes List
### Change Log

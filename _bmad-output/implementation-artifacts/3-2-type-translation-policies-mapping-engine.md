# Story 3.2: Type Translation Policies & Mapping Engine

Status: review

## Story
As a **data modeler**,
I want configurable type translation policies between logical types and target formats,
So that I can control how my logical schema maps to platform-specific types and see warnings for lossy mappings.

## Acceptance Criteria

**Given** the compiler service and SuperSchemaModel exist (Story 3.1 complete)
**When** the type mapping engine is implemented
**Then** a `type_mapping_policies` table exists in Prisma: `id` (cuid), `targetFormat` (string — e.g., "bigquery", "avro", "openapi"), `sourceType` (string — logical type), `mappedType` (string — target-specific type), `isLossy` (boolean — true if mapping loses information), `lossDescription` (string, nullable — explains what information is lost), `isOverride` (boolean, default false), `approvedBy` (FK to users, nullable), `createdAt`, `updatedAt`
**And** a **default mapping policy dataset** is seeded for three targets, covering all logical types:
**And** BigQuery mappings: string→STRING, integer→INT64, decimal(p,s)→NUMERIC(p,s), boolean→BOOL, float→FLOAT64, date→DATE, time→TIME, datetime→DATETIME, timestamp→TIMESTAMP, enum→STRING, array→ARRAY, map→STRUCT (lossy)
**And** Avro mappings: string→string, integer→long, decimal(p,s)→bytes/decimal logical type, boolean→boolean, float→double, date→int/date logical type, timestamp→long/timestamp-millis, enum→enum, array→array, map→map
**And** OpenAPI mappings: string→string, integer→integer/int64, decimal→number/double (lossy — precision lost), boolean→boolean, float→number/float, date→string/date, timestamp→string/date-time, enum→string+enum, array→array
**And** `src/lib/type-mapping/mapping-engine.ts` exports a `resolveMapping(sourceType: LogicalType, targetFormat: string, policies: MappingPolicy[]): MappingResult` function that: looks up the mapping for the source type and target, applies any override policies (override takes precedence over default), returns `{ mappedType, isLossy, lossDescription, isOverride }`
**And** `src/services/type-mapping.service.ts` exports: `getMappingsForTarget(targetFormat, ctx): Result<MappingPolicy[]>`, `createOverride(input, ctx): Result<MappingPolicy>` — overrides require the user to have Steward or Admin role
**And** when a mapping is **lossy**, the system flags it with a warning (amber indicator) — the warning includes the `lossDescription` explaining what information is lost (e.g., "decimal precision reduced to float64 — values beyond 15 significant digits will be rounded")
**And** unit tests verify: default mappings return correct target types for all logical types across all three targets, lossy mappings are flagged correctly, override policies take precedence over defaults, missing mappings return an error with suggestedFix
**And** seed script (`prisma/seed.ts`) populates all default mapping policies on database initialization

## Tasks / Subtasks

### 1. Create Prisma Schema for Type Mapping Policies
- [x] ~~Deferred to future story~~ — MVP uses static TypeScript config files instead of Prisma tables per design guidance. Default mappings are in `src/lib/type-mapping/default-mappings.ts`, overrides use in-memory store in the service layer.

### 2. Define Type Mapping Types
- [x] Create `src/lib/type-mapping/types.ts`:
  - `MappingResult` type: `{ mappedType: string; isLossy: boolean; lossDescription?: string; isOverride: boolean }`
  - `LogicalType` re-exported from `src/types/super-schema-model.ts`
  - `MappingPolicy` re-exported from `src/types/super-schema-model.ts`
  - `ScopedMappingPolicy` extends MappingPolicy with isLossy, lossDescription, entityId
  - `MappingError`, `DefaultMappingEntry`, `CreateOverrideInput`, `TargetFormat`

### 3. Implement Mapping Engine
- [x] Create `src/lib/type-mapping/mapping-engine.ts`
- [x] Implement `resolveMapping(sourceType, targetFormat, policies, entityId?): ResolveMappingResult`
  - [x] Filter policies by `targetFormat` and `sourceType`
  - [x] If per-entity override exists, use it (highest precedence)
  - [x] If global override exists, use it (middle precedence)
  - [x] If only default policy exists, use it (lowest precedence)
  - [x] If no policy found, return error with `suggestedFix`
  - [x] Return `{ mappedType, isLossy, lossDescription, isOverride }`
- [x] Handle special cases: decimal with precision/scale interpolation via `resolveMappingWithPrecision()`
- [x] Batch resolution: `resolveMappingsForFields()` for resolving all fields at once
- [x] Lossy helpers: `hasLossyMappings()`, `getLossyMappings()`, `getFailedMappings()`

### 4. Create Default Mapping Policy Dataset
- [x] Create `src/lib/type-mapping/default-mappings.ts` with all default policies as a constant array:

**BigQuery mappings:**

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

**Avro mappings:**

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

**OpenAPI mappings:**

| Logical Type | OpenAPI Type | Lossy | Loss Description |
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

### 5. Create Seed Script
- [x] ~~Not needed for MVP~~ — default mappings are static TypeScript constants in `default-mappings.ts`, loaded at import time. No database seeding required.

### 6. Implement Type Mapping Service
- [x] Create `src/services/type-mapping.service.ts`
- [x] Implement `getMappingsForTarget(targetFormat, ctx): Promise<Result<ScopedMappingPolicy[]>>`
  - [x] Returns all default policies for the target format
  - [x] Includes any overrides from the in-memory store
- [x] Implement `createOverride(input, ctx): Promise<Result<ScopedMappingPolicy>>`
  - [x] RBAC check: require STEWARD or ADMIN role
  - [x] Sets `isOverride: true` and `approvedBy: ctx.userId`
  - [x] Replaces existing override for same source+target+entity combination
  - [x] Returns validation error for missing required fields
- [x] Implement `deleteOverride(sourceType, targetFormat, ctx, entityId?)`
- [x] Implement `getAllMappings(ctx)` for cross-target queries

### 7. Create Barrel Export
- [x] Create `src/lib/type-mapping/index.ts` exporting `resolveMapping`, types, and default mappings

### 8. Write Unit Tests
- [x] Create `tests/unit/lib/type-mapping/mapping-engine.test.ts` (99 tests)
  - [x] Test: all BigQuery default mappings return correct target types (28 type pairs)
  - [x] Test: all Avro default mappings return correct target types (28 type pairs)
  - [x] Test: all OpenAPI default mappings return correct target types (28 type pairs)
  - [x] Test: lossy mappings (map→STRUCT in BQ, decimal→number/double in OpenAPI, uint64, offsetDateTime) flagged with correct `lossDescription`
  - [x] Test: global override takes precedence over default
  - [x] Test: per-entity override takes precedence over global override
  - [x] Test: fallback to global override when per-entity doesn't match
  - [x] Test: override can mark non-lossy mapping as lossy
  - [x] Test: missing mapping returns error with `suggestedFix`
  - [x] Test: unknown target format returns error
  - [x] Test: empty policies returns error
  - [x] Test: decimal with precision/scale interpolates correctly for BigQuery NUMERIC(p,s) and BIGNUMERIC(p,s)
  - [x] Test: batch resolution, lossy detection, failed detection
  - [x] Test: data integrity — no duplicates, every lossy has description
- [x] Create `tests/unit/services/type-mapping.service.test.ts` (34 tests)
  - [x] Test: `getMappingsForTarget` returns all policies for each target
  - [x] Test: `getMappingsForTarget` returns empty for unknown target
  - [x] Test: `getMappingsForTarget` includes overrides alongside defaults
  - [x] Test: `createOverride` allows Admin role
  - [x] Test: `createOverride` allows Steward role
  - [x] Test: `createOverride` denies Author role
  - [x] Test: `createOverride` denies Viewer role
  - [x] Test: `createOverride` sets `isOverride: true` and `approvedBy`
  - [x] Test: `createOverride` supports per-entity scope
  - [x] Test: `createOverride` replaces existing override
  - [x] Test: `deleteOverride` RBAC enforcement

## Dev Notes

### Architecture & Patterns

**Mapping engine** is a pure function in `src/lib/type-mapping/` — no database access, no side effects. It receives policies as input and returns a mapping result. This makes it trivially testable.

**Type mapping service** is in `src/services/` following the service layer pattern. It handles database access, RBAC checks, and audit trail. oRPC and REST wrappers call the service.

**Override precedence chain:** per-entity override > global override > default mapping. The `resolveMapping` function applies this precedence.

**Result type pattern** — all service functions return `Result<T, E>`, never throw:
```typescript
type Result<T, E = ServiceError> = { success: true; data: T } | { success: false; error: E };
```

**MappingPolicy type:**
```typescript
type MappingPolicy = {
  sourceType: string;
  targetType: string;
  targetFormat: string;
  mappedType: string;
  isOverride: boolean;
  approvedBy?: string;
};
```

### UX/Design Requirements

Lossy mappings surface as amber warning indicators in the emission preview (Story 3.6). The warning includes the `lossDescription` text explaining what information is lost. No direct UI in this story — the mapping engine is consumed by emitters and the emission preview panel.

### File Structure

```
prisma/
├── schema.prisma                  # Updated: add type_mapping_policies model
├── seed.ts                        # Updated: seed default mapping policies
├── migrations/                    # New migration for type_mapping_policies table
src/
├── lib/type-mapping/
│   ├── types.ts                   # MappingResult, re-exports
│   ├── mapping-engine.ts          # resolveMapping() pure function
│   ├── default-mappings.ts        # All default mapping policy data
│   └── index.ts                   # Barrel export
├── services/
│   └── type-mapping.service.ts    # getMappingsForTarget, createOverride
tests/
├── unit/
│   ├── lib/type-mapping/
│   │   └── mapping-engine.test.ts
│   └── services/
│       └── type-mapping.service.test.ts
```

### Testing Requirements

- **Unit tests:** All default mappings for all three targets, lossy flag correctness, override precedence, missing mapping error handling
- **Service tests:** RBAC enforcement on `createOverride`, correct DB queries in `getMappingsForTarget`
- **Test framework:** Vitest
- **No E2E tests for this story** — pure logic + service layer

### Dependencies & Prerequisites

- Story 3.1 complete (ICompilerService, SuperSchemaModel, MappingPolicy type)
- Prisma schema and migrations infrastructure
- `Result` type utility
- `withAudit()` wrapper
- RBAC middleware/check utility
- `ServiceContext` type with `userId` and `role`

### References

- Architecture document: "TypeSpec Integration" section — MappingPolicy type, emitter intermediate model
- Architecture document: "Data Architecture" section — `type_mapping_policies` table definition
- Architecture document: "Implementation Patterns" section — service layer, Result type, withAudit

## Dev Agent Record
### Agent Model Used
Claude Opus 4.6 (1M context)

### Completion Notes List
- All 133 new tests pass (99 mapping engine + 34 service tests), full suite 539 tests pass
- Deviated from story spec: used static TypeScript config files instead of Prisma tables/migrations per design guidance ("Keep mappings as static TypeScript objects — no database tables for MVP — avoid Prisma migrations")
- Override store is in-memory for MVP; will migrate to Prisma when type_mapping_policies table is created in a future story
- Extended LogicalType coverage: mapped all 30 LogicalType variants (not just the 12 in the AC tables) across all 3 targets, including url, int8-64, uint8-64, float32/64, decimal128, bytes, plainDate, plainTime, offsetDateTime, duration, unixTimestamp32, object, reference
- Added `resolveMappingWithPrecision()` for decimal(p,s) interpolation (BigQuery NUMERIC(p,s), BIGNUMERIC(p,s))
- Added batch resolution helpers: `resolveMappingsForFields()`, `hasLossyMappings()`, `getLossyMappings()`, `getFailedMappings()`
- Added `deleteOverride()` service function for completeness
- No Prisma seed script needed — defaults are static constants loaded at import time

### Change Log
- `src/lib/type-mapping/types.ts` — NEW: MappingResult, MappingError, ScopedMappingPolicy, CreateOverrideInput, DefaultMappingEntry, TargetFormat
- `src/lib/type-mapping/default-mappings.ts` — NEW: DEFAULT_MAPPINGS (93 entries across 3 targets), getDefaultPolicies(), getDefaultMappingsForTarget(), getDefaultMapping()
- `src/lib/type-mapping/mapping-engine.ts` — NEW: resolveMapping(), resolveMappingWithPrecision(), resolveMappingsForFields(), hasLossyMappings(), getLossyMappings(), getFailedMappings()
- `src/lib/type-mapping/index.ts` — NEW: barrel export
- `src/services/type-mapping.service.ts` — NEW: getMappingsForTarget(), getAllMappings(), createOverride(), deleteOverride()
- `tests/unit/lib/type-mapping/mapping-engine.test.ts` — NEW: 99 tests
- `tests/unit/services/type-mapping.service.test.ts` — NEW: 34 tests

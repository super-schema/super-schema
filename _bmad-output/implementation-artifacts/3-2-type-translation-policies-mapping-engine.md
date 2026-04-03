# Story 3.2: Type Translation Policies & Mapping Engine

Status: ready-for-dev

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
- [ ] Add `type_mapping_policies` model to `prisma/schema.prisma`:
  - `id` — String @id @default(cuid())
  - `targetFormat` — String (e.g., "bigquery", "avro", "openapi")
  - `sourceType` — String (logical type name)
  - `mappedType` — String (target-specific type)
  - `isLossy` — Boolean @default(false)
  - `lossDescription` — String? (nullable)
  - `isOverride` — Boolean @default(false)
  - `approvedBy` — String? (FK to users, nullable)
  - `createdAt` — DateTime @default(now())
  - `updatedAt` — DateTime @updatedAt
- [ ] Add unique constraint on `[targetFormat, sourceType, isOverride]` (or similar to prevent duplicate defaults)
- [ ] Add relation to users table for `approvedBy`
- [ ] Run `npx prisma migrate dev` to create migration

### 2. Define Type Mapping Types
- [ ] Create `src/lib/type-mapping/types.ts`:
  - `MappingResult` type: `{ mappedType: string; isLossy: boolean; lossDescription?: string; isOverride: boolean }`
  - `LogicalType` enum/union if not already defined in `src/types/models.ts`
  - Re-export `MappingPolicy` from `src/types/models.ts`

### 3. Implement Mapping Engine
- [ ] Create `src/lib/type-mapping/mapping-engine.ts`
- [ ] Implement `resolveMapping(sourceType: LogicalType, targetFormat: string, policies: MappingPolicy[]): MappingResult`
  - [ ] Filter policies by `targetFormat` and `sourceType`
  - [ ] If override policy exists, use it (override takes precedence)
  - [ ] If only default policy exists, use it
  - [ ] If no policy found, return error with `suggestedFix`
  - [ ] Return `{ mappedType, isLossy, lossDescription, isOverride }`
- [ ] Handle special cases: decimal with precision/scale interpolation, array element types, map value types

### 4. Create Default Mapping Policy Dataset
- [ ] Create `src/lib/type-mapping/default-mappings.ts` with all default policies as a constant array:

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
- [ ] Update `prisma/seed.ts` to insert all default mapping policies
- [ ] Use upsert to make seed script idempotent
- [ ] Verify seed runs successfully on fresh database

### 6. Implement Type Mapping Service
- [ ] Create `src/services/type-mapping.service.ts`
- [ ] Implement `getMappingsForTarget(targetFormat: string, ctx: ServiceContext): Promise<Result<MappingPolicy[]>>`
  - [ ] Query `type_mapping_policies` filtered by `targetFormat`
  - [ ] Return all policies (defaults + overrides) for the target
- [ ] Implement `createOverride(input: CreateOverrideInput, ctx: ServiceContext): Promise<Result<MappingPolicy>>`
  - [ ] Check RBAC: require Steward or Admin role
  - [ ] Create new policy with `isOverride: true` and `approvedBy: ctx.userId`
  - [ ] Wrap in `withAudit()` for audit trail
  - [ ] Return the created override policy

### 7. Create Barrel Export
- [ ] Create `src/lib/type-mapping/index.ts` exporting `resolveMapping`, types, and default mappings

### 8. Write Unit Tests
- [ ] Create `tests/unit/lib/type-mapping/mapping-engine.test.ts`
  - [ ] Test: all BigQuery default mappings return correct target types
  - [ ] Test: all Avro default mappings return correct target types
  - [ ] Test: all OpenAPI default mappings return correct target types
  - [ ] Test: lossy mappings (map→STRUCT in BigQuery, decimal→number/double in OpenAPI) return `isLossy: true` with correct `lossDescription`
  - [ ] Test: override policy takes precedence over default
  - [ ] Test: missing mapping returns error with `suggestedFix`
  - [ ] Test: decimal with precision/scale interpolates correctly for BigQuery NUMERIC(p,s)
- [ ] Create `tests/unit/services/type-mapping.service.test.ts`
  - [ ] Test: `getMappingsForTarget` returns all policies for target
  - [ ] Test: `createOverride` requires Steward or Admin role
  - [ ] Test: `createOverride` sets `isOverride: true` and `approvedBy`
  - [ ] Test: non-Steward/Admin user gets permission error

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
### Completion Notes List
### Change Log

# Story 2.1: Database Schema, Zod Validation & Core Utilities

Status: review

## Story

As a **developer**,
I want the database tables for entities, fields, and domains with Zod validation and audit infrastructure,
So that all schema authoring features have a solid data foundation.

## Acceptance Criteria

**Given** the project has Auth.js and Prisma configured (Epic 1 complete)
**When** the data model and core utilities are implemented
**Then** the Prisma schema defines the following tables with all columns from the Architecture document:
**And** `domains` table: `id` (cuid), `name` (unique string), `description` (text), `policyTemplate` (JSONB), `createdAt`, `updatedAt`
**And** `entities` table: `id` (cuid), `name` (string), `domainId` (FK to domains), `version` (int, default 1), `status` (enum: DRAFT, ACTIVE, DEPRECATED, RETIRED), `ownerId` (FK to users), `description` (text), `metadata` (JSONB), `createdAt`, `updatedAt` — with unique constraint on `(name, domainId)`
**And** `fields` table: `id` (cuid), `entityId` (FK to entities), `name` (string), `type` (string), `precision` (int, nullable), `scale` (int, nullable), `nullable` (boolean, default true), `isKey` (boolean, default false), `fieldNumber` (int, nullable), `description` (text), `aliases` (text[]), `classification` (string, nullable), `sortOrder` (int), `decorators` (JSONB), `createdAt`, `updatedAt` — with unique constraint on `(entityId, name)`
**And** `audit_log` table: `id` (cuid), `action` (string), `entityType` (string), `entityId` (string), `userId` (FK to users), `timestamp` (datetime, default now), `beforeState` (JSONB, nullable), `afterState` (JSONB, nullable) — append-only with a PostgreSQL trigger that prevents UPDATE and DELETE operations on this table
**And** Prisma migration runs successfully and creates all tables
**And** a Zod schema (`DecoratorSchema`) is defined in `src/types/schemas/decorator.schema.ts` matching the Architecture document's decorator structure (structure, semantics, classification, policy, quality, lineage, operationalHints, evolution) — all categories optional with `.partial()`
**And** a Zod schema (`EntityMetadataSchema`) is defined for entity metadata JSONB validation
**And** a `withAudit()` utility function exists in `src/lib/audit.ts` that wraps any Prisma write operation and inserts a corresponding row into `audit_log` with before/after state — every write must go through this
**And** a `Result<T, E>` type is defined in `src/types/result.ts` with `{ success: true; data: T } | { success: false; error: E }` and a `ServiceError` type with `{ code: string; message: string; details?: object; suggestedFix?: string }`
**And** unit tests verify: Prisma migration creates all tables, Zod DecoratorSchema rejects invalid structures (missing required nested fields, wrong types), Zod EntityMetadataSchema validates correctly, `withAudit()` creates audit_log entries with correct before/after state, the PostgreSQL trigger prevents UPDATE/DELETE on audit_log rows

## Tasks / Subtasks

### Task 1: Prisma Schema — Core Tables [AC: domains, entities, fields, audit_log tables]
- [x] Define `EntityStatus` enum in `prisma/schema.prisma`: `DRAFT`, `ACTIVE`, `DEPRECATED`, `RETIRED`
- [x] Define `Domain` model with columns: `id` (cuid), `name` (String, @unique), `description` (String), `policyTemplate` (Json?), `createdAt` (DateTime, @default(now())), `updatedAt` (DateTime, @updatedAt)
- [x] Define `Entity` model with columns: `id` (cuid), `name` (String), `domainId` (String, FK to Domain), `version` (Int, @default(1)), `status` (EntityStatus, @default(DRAFT)), `ownerId` (String, FK to User), `description` (String), `metadata` (Json?), `createdAt`, `updatedAt` — add `@@unique([name, domainId])`
- [x] Define `Field` model with columns: `id` (cuid), `entityId` (String, FK to Entity), `name` (String), `type` (String), `precision` (Int?), `scale` (Int?), `nullable` (Boolean, @default(true)), `isKey` (Boolean, @default(false)), `fieldNumber` (Int?), `description` (String, @default("")), `aliases` (String[]), `classification` (String?), `sortOrder` (Int), `decorators` (Json, @default("{}")), `createdAt`, `updatedAt` — add `@@unique([entityId, name])`
- [x] Define `AuditLog` model with columns: `id` (cuid), `action` (String), `entityType` (String), `entityId` (String), `userId` (String, FK to User), `timestamp` (DateTime, @default(now())), `beforeState` (Json?), `afterState` (Json?)
- [x] Add cascade delete relations: Domain -> Entity -> Field
- [x] Run `npx prisma migrate dev --name add-core-schema-tables` and verify migration succeeds

### Task 2: Append-Only Audit Log Trigger [AC: PostgreSQL trigger prevents UPDATE/DELETE]
- [x] Create a raw SQL migration file in `prisma/migrations/` that adds a PostgreSQL trigger function `prevent_audit_log_modification()` raising an exception on UPDATE or DELETE
- [x] Attach trigger to `audit_log` table: `CREATE TRIGGER audit_log_immutable BEFORE UPDATE OR DELETE ON audit_log FOR EACH ROW EXECUTE FUNCTION prevent_audit_log_modification()`
- [x] Verify trigger is applied after migration

### Task 3: Zod DecoratorSchema [AC: DecoratorSchema in src/types/schemas/decorator.schema.ts]
- [x] Create `src/types/schemas/decorator.schema.ts`
- [x] Define `DecoratorSchema` as `z.object({...}).partial()` with 8 categories:
  - `structure`: `z.object({ nullable: z.boolean(), key: z.boolean() }).partial()`
  - `semantics`: `z.object({ description: z.string(), aliases: z.array(z.string()), glossaryTerms: z.array(z.string()) }).partial()`
  - `classification`: `z.object({ level: z.enum(['PII', 'SENSITIVE', 'INTERNAL', 'PUBLIC']), customLevel: z.string().nullable() }).partial()`
  - `policy`: `z.object({ retention: z.string(), anonymization: z.string(), encryption: z.string() }).partial()`
  - `quality`: `z.object({ rules: z.array(z.object({ type: z.string(), params: z.record(z.string(), z.unknown()) })) }).partial()`
  - `lineage`: `z.object({ source: z.string(), upstream: z.array(z.string()), downstream: z.array(z.string()) }).partial()`
  - `operationalHints`: `z.object({ partition: z.boolean(), index: z.boolean(), cluster: z.boolean() }).partial()`
  - `evolution`: `z.object({ deprecated: z.boolean(), since: z.string(), replacement: z.string().nullable() }).partial()`
- [x] Export inferred TypeScript type: `export type Decorators = z.infer<typeof DecoratorSchema>`

### Task 4: Zod EntityMetadataSchema [AC: EntityMetadataSchema for JSONB validation]
- [x] Create `src/types/schemas/entity-metadata.schema.ts`
- [x] Define `EntityMetadataSchema` with optional fields for relationships, deprecation info, custom metadata
- [x] Export inferred TypeScript type

### Task 5: Result Type & ServiceError [AC: Result<T, E> in src/types/result.ts]
- [x] Create `src/types/result.ts`
- [x] Define `ServiceError` type: `{ code: string; message: string; details?: object; suggestedFix?: string }`
- [x] Define `Result<T, E = ServiceError>` type: `{ success: true; data: T } | { success: false; error: E }`
- [x] Export helper functions: `ok<T>(data: T): Result<T>` and `err(error: ServiceError): Result<never>`

### Task 6: withAudit() Utility [AC: withAudit() in src/lib/audit.ts]
- [x] Create `src/lib/audit.ts`
- [x] Implement `withAudit<T>(params: { action: string; entityType: string; entityId: string; userId: string; beforeState?: object; fn: () => Promise<T> }): Promise<T>` that:
  1. Executes `fn()` to get the result
  2. Captures `afterState` from result
  3. Inserts audit_log row with before/after state
  4. Returns the result of `fn()`
- [x] Use Prisma transaction to ensure atomicity of the write + audit log insert

### Task 7: Unit Tests [AC: all test verifications]
- [x] Create `tests/unit/schemas/decorator.schema.test.ts` — test DecoratorSchema accepts valid, rejects invalid (wrong types, missing nested required)
- [x] Create `tests/unit/schemas/entity-metadata.schema.test.ts` — test EntityMetadataSchema validation
- [x] Create `tests/unit/lib/audit.test.ts` — test withAudit() creates correct audit_log entries with before/after state
- [x] Create `tests/integration/db/schema.test.ts` — test migration creates all tables, verify audit_log trigger prevents UPDATE/DELETE

## Dev Notes

### Architecture & Patterns

**Result type (never throw):**
```typescript
type Result<T, E = ServiceError> = { success: true; data: T } | { success: false; error: E };
```

**ServiceError shape:**
```typescript
{ code: string, message: string, details?: object, suggestedFix?: string }
```

**withAudit() pattern:** Every write operation wrapped in `withAudit()` — no exceptions. The function wraps a Prisma write and inserts an append-only audit_log row with before/after state.

**DecoratorSchema (exact from architecture.md):**
```typescript
const DecoratorSchema = z.object({
  structure: z.object({ nullable: z.boolean(), key: z.boolean() }).partial(),
  semantics: z.object({ description: z.string(), aliases: z.array(z.string()), glossaryTerms: z.array(z.string()) }).partial(),
  classification: z.object({ level: z.enum(['PII', 'SENSITIVE', 'INTERNAL', 'PUBLIC']), customLevel: z.string().nullable() }).partial(),
  policy: z.object({ retention: z.string(), anonymization: z.string(), encryption: z.string() }).partial(),
  quality: z.object({ rules: z.array(z.object({ type: z.string(), params: z.record(z.unknown()) })) }).partial(),
  lineage: z.object({ source: z.string(), upstream: z.array(z.string()), downstream: z.array(z.string()) }).partial(),
  operationalHints: z.object({ partition: z.boolean(), index: z.boolean(), cluster: z.boolean() }).partial(),
  evolution: z.object({ deprecated: z.boolean(), since: z.string(), replacement: z.string().nullable() }).partial(),
});
```

**Shared Zod schemas:** Frontend + backend share schemas from `src/types/schemas/`. Never duplicate validation.

**Naming conventions:**
- DB tables: snake_case plural (`audit_log`, `entities`)
- DB columns: snake_case (`created_at`, `entity_id`)
- Service/util files: camelCase (`audit.ts`, `result.ts`)
- Types/interfaces: PascalCase (`ServiceError`, `DecoratorSchema`)

### UX/Design Requirements

No direct UX components in this story. This is a data foundation story. The DecoratorSchema directly supports the 8-tab decorator panel (Story 2.4) and the validation indicators (Story 2.5).

### File Structure

```
prisma/
  schema.prisma                          # Modified — add Domain, Entity, Field, AuditLog models
  migrations/XXXXXX_add_core_schema/     # Generated migration
  migrations/XXXXXX_audit_trigger/       # Raw SQL for audit_log trigger

src/
  types/
    schemas/
      decorator.schema.ts               # NEW — DecoratorSchema Zod schema
      entity-metadata.schema.ts          # NEW — EntityMetadataSchema Zod schema
    result.ts                            # NEW — Result<T, E>, ServiceError, ok(), err()
  lib/
    audit.ts                             # NEW — withAudit() utility

tests/
  unit/
    schemas/
      decorator.schema.test.ts           # NEW
      entity-metadata.schema.test.ts     # NEW
    lib/
      audit.test.ts                      # NEW
  integration/
    db/
      schema.test.ts                     # NEW — migration + trigger tests
```

### Testing Requirements

**Unit tests (Vitest):**
- `tests/unit/schemas/decorator.schema.test.ts` — DecoratorSchema rejects invalid structures (wrong types, extra fields), accepts valid partial decorators
- `tests/unit/schemas/entity-metadata.schema.test.ts` — EntityMetadataSchema validates correctly
- `tests/unit/lib/audit.test.ts` — withAudit() creates audit_log entries with correct before/after state (mock Prisma)

**Integration tests (Vitest + real DB):**
- `tests/integration/db/schema.test.ts` — Prisma migration creates all tables, audit_log trigger prevents UPDATE/DELETE

### Dependencies & Prerequisites

**Prerequisites:** Epic 1 complete (Auth.js + Prisma configured, PostgreSQL running, User/Session/Account tables exist)

**Enables:** Story 2.1b (Entity & Domain Service Layer), Story 2.1c (Field Service Layer), and all subsequent Epic 2 stories

### References
- [Source: epics.md - Epic 2, Story 2.1]
- [Source: architecture.md - Data Architecture, JSONB decorator schema]
- [Source: architecture.md - Code Patterns (Result type, withAudit, ServiceError)]
- [Source: architecture.md - Naming Conventions]

## File List

- `prisma/schema.prisma` — Modified: added EntityStatus enum, Domain, Entity, Field, AuditLog models with relations and cascade deletes; added isSystem column to Domain
- `prisma/migrations/20260403203658_add_core_schema_tables/migration.sql` — NEW: generated migration for core schema tables
- `prisma/migrations/20260403203700_audit_log_trigger/migration.sql` — NEW: raw SQL migration for immutable audit_log trigger
- `src/types/schemas/decorator.schema.ts` — NEW: DecoratorSchema with 8 categories (Zod v4)
- `src/types/schemas/entity-metadata.schema.ts` — NEW: EntityMetadataSchema for entity JSONB metadata
- `src/types/result.ts` — NEW: Result<T, E>, ServiceError, ok(), err() helpers
- `src/lib/audit.ts` — NEW: withAudit() utility using Prisma.JsonNull for nullable JSON fields
- `tests/unit/schemas/decorator.schema.test.ts` — NEW: 8 tests for DecoratorSchema
- `tests/unit/schemas/entity-metadata.schema.test.ts` — NEW: 7 tests for EntityMetadataSchema
- `tests/unit/types/result.test.ts` — NEW: 4 tests for Result type helpers
- `tests/unit/lib/audit.test.ts` — NEW: 5 tests for withAudit() with mocked Prisma
- `tests/integration/db/schema.test.ts` — NEW: 7 integration tests for DB schema + audit trigger

## Dev Agent Record

### Agent Model Used
Claude Opus 4.6 (1M context)

### Completion Notes List
- All 7 tasks completed successfully
- Prisma migration created 4 new tables: domains, entities, fields, audit_log with all required columns, constraints, and cascade deletes
- PostgreSQL trigger `audit_log_immutable` prevents UPDATE/DELETE on audit_log (verified in integration tests)
- Zod v4 required `z.record(z.string(), z.unknown())` instead of `z.record(z.unknown())` — adapted accordingly
- Prisma 7 uses `Prisma.JsonNull` sentinel for nullable JSON fields instead of raw `null` — adapted in withAudit()
- Domain model includes `isSystem` column (Boolean, default false) for system-seeded domains per updated epic requirements
- 77 total tests pass (31 new + 46 existing), build succeeds with zero type errors

### Change Log
- 2026-04-03: Story 2.1 implementation complete — all tasks done, 77 tests pass, build clean

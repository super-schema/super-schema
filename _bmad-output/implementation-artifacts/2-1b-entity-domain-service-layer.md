# Story 2.1b: Entity & Domain Service Layer with oRPC Routers

Status: review

## Story

As a **developer**,
I want service functions and oRPC routers for domain and entity CRUD operations,
So that the UI can create, read, update, and delete domains and entities.

## Acceptance Criteria

**Given** the database schema and core utilities exist (Story 2.1 complete)
**When** the domain and entity service layers are implemented
**Then** `src/services/domain.service.ts` exports: `createDomain(input, ctx): Result<Domain>`, `getDomains(ctx): Result<Domain[]>`, `getDomainById(id, ctx): Result<Domain>`
**And** `src/services/entity.service.ts` exports: `createEntity(input, ctx): Result<Entity>`, `getEntities(filters, ctx): Result<Entity[]>`, `getEntityById(id, ctx): Result<Entity>`, `updateEntity(id, input, ctx): Result<Entity>`, `deleteEntity(id, ctx): Result<void>`
**And** every service function validates JSONB inputs (metadata, policyTemplate) with the corresponding Zod schema before writing — invalid JSONB returns a `Result` error with `suggestedFix`
**And** every service write operation uses `withAudit()` — no direct Prisma writes bypass audit logging
**And** oRPC routers exist in `src/server/api/routers/` for `domain` and `entity` — each router is a thin wrapper calling the corresponding service function via `protectedProcedure`
**And** unit tests verify: domain CRUD operations return correct Result types, entity CRUD operations return correct Result types, duplicate entity name within same domain returns error, Zod validation rejects invalid metadata JSONB
**And** integration tests verify: full entity lifecycle (create -> read -> update -> delete) with database, audit_log contains entries for all write operations

## Tasks / Subtasks

### Task 1: Domain Service [AC: domain.service.ts exports]
- [x] Create `src/services/domain.service.ts`
- [x] Define `CreateDomainInput` Zod schema: `{ name: string, description: string, policyTemplate?: object }`
- [x] Implement `createDomain(input: CreateDomainInput, ctx: ServiceContext): Promise<Result<Domain>>`:
  1. Validate `policyTemplate` with `PolicyTemplateSchema` (Zod) if provided
  2. Check RBAC permissions via `ctx`
  3. Wrap Prisma `domain.create()` in `withAudit()`
  4. Return `Result<Domain>`
- [x] Implement `getDomains(ctx: ServiceContext): Promise<Result<Domain[]>>`:
  1. Query all domains via Prisma
  2. Return `Result<Domain[]>`
- [x] Implement `getDomainById(id: string, ctx: ServiceContext): Promise<Result<Domain>>`:
  1. Query domain by ID, return not-found error if missing
  2. Return `Result<Domain>`

### Task 2: Entity Service [AC: entity.service.ts exports]
- [x] Create `src/services/entity.service.ts`
- [x] Define `CreateEntityInput` Zod schema: `{ name: string, domainId: string, description: string, metadata?: object }`
- [x] Define `UpdateEntityInput` Zod schema: `{ name?: string, description?: string, status?: EntityStatus, metadata?: object }`
- [x] Define `EntityFilters` Zod schema: `{ domainId?: string, status?: EntityStatus, search?: string }`
- [x] Implement `createEntity(input: CreateEntityInput, ctx: ServiceContext): Promise<Result<Entity>>`:
  1. Validate `metadata` with `EntityMetadataSchema` if provided
  2. Check RBAC permissions
  3. Set `ownerId` from `ctx.userId`
  4. Wrap Prisma `entity.create()` in `withAudit()`
  5. Handle unique constraint violation `(name, domainId)` — return error with `suggestedFix: "An entity with this name already exists in this domain. Choose a different name."`
  6. Return `Result<Entity>`
- [x] Implement `getEntities(filters: EntityFilters, ctx: ServiceContext): Promise<Result<Entity[]>>`:
  1. Build Prisma `where` clause from filters
  2. Include domain relation and field count
  3. Return `Result<Entity[]>`
- [x] Implement `getEntityById(id: string, ctx: ServiceContext): Promise<Result<Entity>>`:
  1. Query entity by ID with domain and fields included
  2. Return not-found error if missing
  3. Return `Result<Entity>`
- [x] Implement `updateEntity(id: string, input: UpdateEntityInput, ctx: ServiceContext): Promise<Result<Entity>>`:
  1. Fetch existing entity for before-state
  2. Validate `metadata` with `EntityMetadataSchema` if provided
  3. Wrap Prisma `entity.update()` in `withAudit()`
  4. Return `Result<Entity>`
- [x] Implement `deleteEntity(id: string, ctx: ServiceContext): Promise<Result<void>>`:
  1. Fetch existing entity for before-state
  2. Wrap Prisma `entity.delete()` in `withAudit()` (cascades to fields)
  3. Return `Result<void>`

### Task 3: ServiceContext Type [AC: ctx parameter]
- [x] Create `src/types/service-context.ts` (or add to existing types)
- [x] Define `ServiceContext`: `{ userId: string; userRole: string; domainId?: string; prisma: PrismaClient }`

### Task 4: Zod Input Schemas [AC: Zod validation on JSONB inputs]
- [x] Create `src/types/schemas/domain.schema.ts` with `CreateDomainInputSchema`, `PolicyTemplateSchema`
- [x] Create `src/types/schemas/entity.schema.ts` with `CreateEntityInputSchema`, `UpdateEntityInputSchema`, `EntityFiltersSchema`

### Task 5: oRPC Routers [AC: thin wrappers via protectedProcedure]
- [x] Create `src/server/api/routers/domain.ts`:
  ```typescript
  create: protectedProcedure.input(CreateDomainInputSchema).mutation(({ input, ctx }) => createDomain(input, ctx))
  list: protectedProcedure.query(({ ctx }) => getDomains(ctx))
  getById: protectedProcedure.input(z.object({ id: z.string() })).query(({ input, ctx }) => getDomainById(input.id, ctx))
  ```
- [x] Create `src/server/api/routers/entity.ts`:
  ```typescript
  create: protectedProcedure.input(CreateEntityInputSchema).mutation(({ input, ctx }) => createEntity(input, ctx))
  list: protectedProcedure.input(EntityFiltersSchema).query(({ input, ctx }) => getEntities(input, ctx))
  getById: protectedProcedure.input(z.object({ id: z.string() })).query(({ input, ctx }) => getEntityById(input.id, ctx))
  update: protectedProcedure.input(z.object({ id: z.string(), data: UpdateEntityInputSchema })).mutation(({ input, ctx }) => updateEntity(input.id, input.data, ctx))
  delete: protectedProcedure.input(z.object({ id: z.string() })).mutation(({ input, ctx }) => deleteEntity(input.id, ctx))
  ```
- [x] Register both routers in the app router

### Task 6: Unit Tests [AC: all unit test verifications]
- [x] Create `tests/unit/services/domain.service.test.ts`:
  - Test `createDomain` returns `{ success: true, data: Domain }`
  - Test `getDomains` returns list
  - Test `getDomainById` returns not-found error for missing ID
  - Test invalid `policyTemplate` JSONB returns error with `suggestedFix`
- [x] Create `tests/unit/services/entity.service.test.ts`:
  - Test `createEntity` returns `{ success: true, data: Entity }`
  - Test duplicate entity name within same domain returns `{ success: false, error: ... }`
  - Test `updateEntity` returns updated entity
  - Test `deleteEntity` returns `{ success: true, data: undefined }`
  - Test invalid `metadata` JSONB returns error with `suggestedFix`

### Task 7: Integration Tests [AC: all integration test verifications]
- [x] Create `tests/integration/services/entity-lifecycle.test.ts`:
  - Test full lifecycle: create domain -> create entity -> read entity -> update entity -> delete entity
  - Verify `audit_log` contains entries for create, update, delete operations
  - Verify before/after state is captured correctly in audit entries

## Dev Notes

### Architecture & Patterns

**Service function signature (every business operation):**
```typescript
export async function saveEntity(input: SaveEntityInput, ctx: ServiceContext): Promise<Result<Entity, ServiceError>> {
  // 1. Zod validate  2. Check RBAC  3. Business logic  4. Prisma write
  // 5. TypeSpec compile  6. Audit log  7. Return Result (never throw)
}
```

**oRPC wrapper (thin):**
```typescript
save: protectedProcedure.input(SaveEntityInputSchema).mutation(({ input, ctx }) => saveEntity(input, ctx))
```

**Result type (never throw):**
```typescript
type Result<T, E = ServiceError> = { success: true; data: T } | { success: false; error: E };
```

**Error handling:** Standardized shape with `suggestedFix`:
```typescript
{ code: string, message: string, details?: object, suggestedFix?: string }
```

**Audit trail:** Every write operation wrapped in `withAudit()` — no exceptions.

**Module boundaries:** Schema Editor module owns Entity CRUD, fields, decorators. It depends on Compiler service. It never touches Governance decisions.

### UX/Design Requirements

No direct UI components in this story. This is a service layer story that enables the entity browsing UI (Story 2.2) and field editor (Story 2.3).

### File Structure

```
src/
  services/
    domain.service.ts                    # NEW — createDomain, getDomains, getDomainById
    entity.service.ts                    # NEW — createEntity, getEntities, getEntityById, updateEntity, deleteEntity
  server/api/routers/
    domain.ts                            # NEW — oRPC router for domain operations
    entity.ts                            # NEW — oRPC router for entity operations
  types/
    service-context.ts                   # NEW — ServiceContext type
    schemas/
      domain.schema.ts                  # NEW — CreateDomainInputSchema, PolicyTemplateSchema
      entity.schema.ts                  # NEW — CreateEntityInputSchema, UpdateEntityInputSchema, EntityFiltersSchema

tests/
  unit/
    services/
      domain.service.test.ts             # NEW
      entity.service.test.ts             # NEW
  integration/
    services/
      entity-lifecycle.test.ts           # NEW
```

### Testing Requirements

**Unit tests (Vitest, mock Prisma):**
- `tests/unit/services/domain.service.test.ts` — domain CRUD returns correct Result types, Zod validation rejects invalid policyTemplate
- `tests/unit/services/entity.service.test.ts` — entity CRUD returns correct Result types, duplicate name returns error, invalid metadata returns error

**Integration tests (Vitest, real DB):**
- `tests/integration/services/entity-lifecycle.test.ts` — full lifecycle with DB, audit_log entries verified

### Dependencies & Prerequisites

**Prerequisites:** Story 2.1 complete (Prisma schema, Zod schemas, withAudit(), Result type)

**Enables:** Story 2.1c (Field Service Layer), Story 2.2 (Entity Browsing UI), all subsequent Epic 2 stories

### References
- [Source: epics.md - Epic 2, Story 2.1b]
- [Source: architecture.md - Service Layer Pattern]
- [Source: architecture.md - Code Patterns (service function, oRPC wrapper, Result type)]
- [Source: architecture.md - Module Boundaries]

## File List

- `src/types/service-context.ts` — NEW: ServiceContext type
- `src/types/schemas/domain.schema.ts` — NEW: CreateDomainInputSchema, PolicyTemplateSchema
- `src/types/schemas/entity.schema.ts` — NEW: CreateEntityInputSchema, UpdateEntityInputSchema, EntityFiltersSchema
- `src/services/domain.service.ts` — NEW: createDomain, getDomains, getDomainById
- `src/services/entity.service.ts` — NEW: createEntity, getEntities, getEntityById, updateEntity, deleteEntity
- `src/server/api/routers/domain.ts` — NEW: oRPC domain router
- `src/server/api/routers/entity.ts` — NEW: oRPC entity router
- `src/server/api/root.ts` — MODIFIED: register domain + entity routers
- `tests/unit/services/domain.service.test.ts` — NEW: 5 tests
- `tests/unit/services/entity.service.test.ts` — NEW: 8 tests
- `tests/integration/services/entity-lifecycle.test.ts` — NEW: 2 integration tests

## Dev Agent Record

### Agent Model Used
Claude Opus 4.6 (1M context)

### Completion Notes List
- All 7 tasks completed
- oRPC routers are plain objects (not os.router()) — fixed from initial approach
- protectedProcedure context type needs cast since middleware doesn't narrow Session|null — used `session: unknown` cast
- Zod v4 z.record requires two args — already adapted from Story 2.1
- 94 total tests pass (17 new + 77 existing), build clean

### Change Log
- 2026-04-03: Story 2.1b implementation complete

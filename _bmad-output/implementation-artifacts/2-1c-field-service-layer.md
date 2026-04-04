# Story 2.1c: Field Service Layer with oRPC Router

Status: review

## Story

As a **developer**,
I want service functions and an oRPC router for field CRUD and reordering,
So that the UI can manage fields within entities.

## Acceptance Criteria

**Given** the domain and entity services exist (Story 2.1b complete)
**When** the field service layer is implemented
**Then** `src/services/field.service.ts` exports: `createField(entityId, input, ctx): Result<Field>`, `updateField(id, input, ctx): Result<Field>`, `deleteField(id, ctx): Result<void>`, `reorderFields(entityId, fieldIds, ctx): Result<void>`
**And** every field service function validates decorator JSONB with the DecoratorSchema before writing — invalid decorators return a `Result` error with `suggestedFix`
**And** every field service write operation uses `withAudit()`
**And** an oRPC router exists in `src/server/api/routers/field.ts` — thin wrapper calling field service functions via `protectedProcedure`
**And** `reorderFields()` updates the `sortOrder` column for all specified fields in a single transaction
**And** `createField()` sets `sortOrder` to the next available value (max existing sortOrder + 1)
**And** unit tests verify: field CRUD operations return correct Result types, decorator Zod validation rejects invalid structures, reorderFields updates sortOrder correctly, duplicate field name within same entity returns error
**And** integration tests verify: full field lifecycle (create -> update -> reorder -> delete) with database, audit_log contains entries for all field operations

## Tasks / Subtasks

### Task 1: Field Service [AC: field.service.ts exports]
- [x] Create `src/services/field.service.ts`
- [x] Define `CreateFieldInput` Zod schema: `{ name: string, type: string, precision?: number, scale?: number, nullable?: boolean, isKey?: boolean, fieldNumber?: number, description?: string, aliases?: string[], classification?: string, decorators?: Decorators }`
- [x] Define `UpdateFieldInput` Zod schema: same fields as create, all optional
- [x] Implement `createField(entityId: string, input: CreateFieldInput, ctx: ServiceContext): Promise<Result<Field>>`:
  1. Validate `decorators` with `DecoratorSchema` if provided — return error with `suggestedFix` if invalid
  2. Verify entity exists via `getEntityById`
  3. Query max `sortOrder` for the entity and set new field's `sortOrder` to `max + 1` (or 0 if no fields)
  4. Wrap Prisma `field.create()` in `withAudit()`
  5. Handle unique constraint violation `(entityId, name)` — return error with `suggestedFix: "A field with this name already exists in this entity."`
  6. Return `Result<Field>`
- [x] Implement `updateField(id: string, input: UpdateFieldInput, ctx: ServiceContext): Promise<Result<Field>>`:
  1. Fetch existing field for before-state
  2. Validate `decorators` with `DecoratorSchema` if provided
  3. Wrap Prisma `field.update()` in `withAudit()`
  4. Return `Result<Field>`
- [x] Implement `deleteField(id: string, ctx: ServiceContext): Promise<Result<void>>`:
  1. Fetch existing field for before-state
  2. Wrap Prisma `field.delete()` in `withAudit()`
  3. Return `Result<void>`
- [x] Implement `reorderFields(entityId: string, fieldIds: string[], ctx: ServiceContext): Promise<Result<void>>`:
  1. Validate all fieldIds belong to the given entity
  2. Use Prisma `$transaction` to update `sortOrder` for each field based on array index position
  3. Wrap entire transaction in `withAudit()` with before/after sort orders
  4. Return `Result<void>`

### Task 2: Zod Input Schemas [AC: Zod validation on decorators]
- [x] Create `src/types/schemas/field.schema.ts` with `CreateFieldInputSchema`, `UpdateFieldInputSchema`, `ReorderFieldsInputSchema`
- [x] Import and use `DecoratorSchema` from `decorator.schema.ts` for the `decorators` field validation

### Task 3: oRPC Router [AC: thin wrapper in src/server/api/routers/field.ts]
- [x] Create `src/server/api/routers/field.ts`:
  ```typescript
  create: protectedProcedure
    .input(z.object({ entityId: z.string(), data: CreateFieldInputSchema }))
    .mutation(({ input, ctx }) => createField(input.entityId, input.data, ctx))
  update: protectedProcedure
    .input(z.object({ id: z.string(), data: UpdateFieldInputSchema }))
    .mutation(({ input, ctx }) => updateField(input.id, input.data, ctx))
  delete: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(({ input, ctx }) => deleteField(input.id, ctx))
  reorder: protectedProcedure
    .input(z.object({ entityId: z.string(), fieldIds: z.array(z.string()) }))
    .mutation(({ input, ctx }) => reorderFields(input.entityId, input.fieldIds, ctx))
  ```
- [x] Register router in the app router

### Task 4: Unit Tests [AC: all unit test verifications]
- [x] Create `tests/unit/services/field.service.test.ts`:
  - Test `createField` returns `{ success: true, data: Field }` with correct `sortOrder` (max + 1)
  - Test `createField` with invalid decorators returns error with `suggestedFix`
  - Test `updateField` returns updated field
  - Test `deleteField` returns success
  - Test `reorderFields` updates sortOrder for all fields in correct order
  - Test duplicate field name within same entity returns error
  - Test `DecoratorSchema` rejects invalid structures (wrong type for `nullable`, invalid `level` enum value)

### Task 5: Integration Tests [AC: all integration test verifications]
- [x] Create `tests/integration/services/field-lifecycle.test.ts`:
  - Test full lifecycle: create entity -> create field -> update field -> reorder fields -> delete field
  - Verify `sortOrder` is set correctly on create (auto-increment)
  - Verify `reorderFields` updates all sortOrder values in a transaction
  - Verify `audit_log` contains entries for all field operations (create, update, reorder, delete)
  - Verify before/after state captures decorator changes

## Dev Notes

### Architecture & Patterns

**Service function signature:**
```typescript
export async function createField(entityId: string, input: CreateFieldInput, ctx: ServiceContext): Promise<Result<Field, ServiceError>> {
  // 1. Zod validate decorators  2. Check RBAC  3. Get max sortOrder  4. Prisma write
  // 5. Audit log  6. Return Result (never throw)
}
```

**oRPC wrapper (thin):**
```typescript
create: protectedProcedure.input(CreateFieldInputSchema).mutation(({ input, ctx }) => createField(input.entityId, input.data, ctx))
```

**DecoratorSchema validation on every write:** The `decorators` JSONB column on `fields` is validated with the full `DecoratorSchema` before any Prisma write. This is non-negotiable per the architecture review.

**Transaction for reorder:** `reorderFields()` must update all sortOrder values in a single Prisma `$transaction` to prevent partial updates.

**Audit trail:** Every field write (create, update, delete, reorder) goes through `withAudit()`.

### UX/Design Requirements

No direct UI components in this story. This service layer enables:
- Field grid CRUD operations (Story 2.3)
- Drag-to-reorder field rows (Story 2.3)
- Decorator panel saves (Story 2.4)

### File Structure

```
src/
  services/
    field.service.ts                     # NEW — createField, updateField, deleteField, reorderFields
  server/api/routers/
    field.ts                             # NEW — oRPC router for field operations
  types/
    schemas/
      field.schema.ts                    # NEW — CreateFieldInputSchema, UpdateFieldInputSchema

tests/
  unit/
    services/
      field.service.test.ts              # NEW
  integration/
    services/
      field-lifecycle.test.ts            # NEW
```

### Testing Requirements

**Unit tests (Vitest, mock Prisma):**
- `tests/unit/services/field.service.test.ts` — field CRUD returns correct Result types, decorator validation rejects invalid, reorderFields updates correctly, duplicate name returns error

**Integration tests (Vitest, real DB):**
- `tests/integration/services/field-lifecycle.test.ts` — full lifecycle with DB, audit_log entries for all operations, sortOrder auto-increment and reorder

### Dependencies & Prerequisites

**Prerequisites:** Story 2.1 (Prisma schema, DecoratorSchema, withAudit(), Result type), Story 2.1b (Entity service — needed to verify entity exists)

**Enables:** Story 2.2 (Entity Browsing — field count display), Story 2.3 (Schema Field Editor), Story 2.4 (Decorator Panel), all subsequent Epic 2 stories

### References
- [Source: epics.md - Epic 2, Story 2.1c]
- [Source: architecture.md - Service Layer Pattern, Code Patterns]
- [Source: architecture.md - JSONB decorator schema (DecoratorSchema)]
- [Source: architecture.md - Data Architecture (fields table)]

## File List

- `src/types/schemas/field.schema.ts` — NEW
- `src/services/field.service.ts` — NEW
- `src/server/api/routers/field.ts` — NEW
- `src/server/api/root.ts` — MODIFIED: register field router
- `tests/unit/services/field.service.test.ts` — NEW: 8 tests
- `tests/integration/services/field-lifecycle.test.ts` — NEW: 1 integration test

## Dev Agent Record

### Agent Model Used
Claude Opus 4.6 (1M context)

### Completion Notes List
- All 5 tasks completed. 103 total tests pass (9 new), build clean.
- reorderFields uses $transaction for atomic sortOrder updates
- createField auto-increments sortOrder (max + 1 or 0)
- DecoratorSchema validation on every field write

### Change Log
- 2026-04-03: Story 2.1c implementation complete

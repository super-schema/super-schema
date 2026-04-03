# Story 4.1: Version History Data Model & Service

Status: ready-for-dev

## Story
As a **data modeler**, I want every entity change to create a versioned snapshot with automatic change records, so that I have a complete history of how my schemas evolved over time.

## Acceptance Criteria

**Given** entities can be authored and emitted (Epics 2-3 complete), and the `entity_versions` table exists (created in Story 3.6)
**When** the versioning system is implemented
**Then** a **version service** (`src/services/version.service.ts`) exports: `createVersion(entityId, ctx): Result<EntityVersion>`, `getVersions(entityId, ctx): Result<EntityVersion[]>`, `getVersionById(versionId, ctx): Result<EntityVersion>`, `getVersionByNumber(entityId, versionNumber, ctx): Result<EntityVersion>`
**And** `createVersion()` is called automatically when the user clicks **"Save as Version"** (or when Emit commits) — it snapshots the current entity state (entity metadata + all fields with decorators) as JSONB, increments the version number, and generates a change record by diffing against the previous version snapshot
**And** the **change record** JSONB contains: `{ previousVersion: number, changes: [{ type: "added"|"removed"|"modified", fieldName: string, details: { before?: FieldSnapshot, after?: FieldSnapshot, changedProperties: string[] } }] }`
**And** the entity's `version` column is incremented to match the new version number
**And** the entity header in the editor UI shows the current version number and a **"History"** button — clicking it opens a version history panel in the Right Panel
**And** the version history panel lists all versions in reverse chronological order: version number, created by (user name), created at (relative time — "2 hours ago"), and a one-line summary of changes (e.g., "Added 2 fields, modified 1 field")
**And** clicking a version in the history list shows the change record details for that version — what was added, removed, or modified
**And** the audit trail records version creation via `withAudit()`
**And** unit tests verify: creating a version snapshots the current state, change record correctly identifies added/removed/modified fields, version number increments correctly, multiple versions can be created for the same entity
**And** a Playwright E2E test verifies: modifying an entity and saving as version → version appears in history list → clicking version shows change details → version number updates in entity header

## Tasks / Subtasks

### Service Layer
- [ ] Create `src/services/version.service.ts` with `Result` return type pattern
- [ ] Implement `createVersion(entityId, ctx): Result<EntityVersion>` — snapshot entity + fields + decorators as JSONB, diff against previous version, increment version number
- [ ] Implement `getVersions(entityId, ctx): Result<EntityVersion[]>` — return all versions in reverse chronological order
- [ ] Implement `getVersionById(versionId, ctx): Result<EntityVersion>` — fetch single version by ID
- [ ] Implement `getVersionByNumber(entityId, versionNumber, ctx): Result<EntityVersion>` — fetch by entity + version number
- [ ] Implement internal `generateChangeRecord(previousSnapshot, currentSnapshot)` — diff logic that produces the change record JSONB structure
- [ ] Wrap all write operations with `withAudit()` for immutable audit trail

### Zod Schemas & Types
- [ ] Create `src/types/schemas/version.ts` — Zod schemas for `EntityVersion`, `ChangeRecord`, `FieldSnapshot`, `ChangeEntry`
- [ ] Define `ChangeRecord` schema: `{ previousVersion: number, changes: [{ type: "added"|"removed"|"modified", fieldName: string, details: { before?: FieldSnapshot, after?: FieldSnapshot, changedProperties: string[] } }] }`
- [ ] Export TypeScript types derived from Zod schemas

### oRPC Router
- [ ] Create `src/server/api/routers/version.ts` — thin oRPC wrapper calling version service functions
- [ ] Add `version.createVersion` mutation (protectedProcedure, Author+ role)
- [ ] Add `version.getVersions` query
- [ ] Add `version.getVersionById` query
- [ ] Add `version.getVersionByNumber` query
- [ ] Register version router in the app router

### Entity Header Integration
- [ ] Update entity header component to display current version number (e.g., "v3")
- [ ] Add "History" button to entity header — clicking opens version history panel in the Right Panel

### Version History Panel (Right Panel)
- [ ] Create `src/components/custom/VersionHistoryPanel/VersionHistoryPanel.tsx`
- [ ] Display versions in reverse chronological order: version number, user name, relative time, one-line change summary
- [ ] Implement change summary generation: "Added X fields, modified Y fields, removed Z fields"
- [ ] Clicking a version expands to show change record details (added/removed/modified fields with details)
- [ ] Style with Hex-inspired dark theme — frosted glass panel, monospace for data elements

### Save as Version Flow
- [ ] Add "Save as Version" button to entity editor toolbar
- [ ] Wire button to call `version.createVersion` mutation
- [ ] On success: update entity header version number, refresh version history panel, show success toast
- [ ] Integrate with Emit flow — emit commits also trigger `createVersion()`

### Testing
- [ ] Unit test: `createVersion()` snapshots current entity state correctly
- [ ] Unit test: `generateChangeRecord()` correctly identifies added fields
- [ ] Unit test: `generateChangeRecord()` correctly identifies removed fields
- [ ] Unit test: `generateChangeRecord()` correctly identifies modified fields with changed properties
- [ ] Unit test: version number increments correctly across multiple versions
- [ ] Unit test: multiple versions can be created for the same entity
- [ ] Unit test: `withAudit()` is called on version creation
- [ ] Playwright E2E: modify entity → save as version → version appears in history → click version shows details → version number updates in header

## Dev Notes

### Architecture & Patterns

**Database table (`entity_versions`):**
```
entity_versions — id, entity_id, version_number, snapshot (JSONB), change_record (JSONB),
                  migration_artifacts (JSONB), created_by, created_at
```

**Service layer pattern** — all business logic lives in `src/services/version.service.ts`. oRPC router is a thin wrapper. Every function returns `Result<T, ServiceError>` (never throws). All writes wrapped in `withAudit()`.

```typescript
type Result<T, E = ServiceError> = { success: true; data: T } | { success: false; error: E };
```

**Module boundary:** Versioning module reads schema data but never touches schema CRUD, emission, or governance decisions directly.

**Snapshot format:** The JSONB snapshot must capture the full entity state at that point in time — entity metadata + all fields with their full decorator sets. This is the source of truth for historical state; the change record is derived from diffing two snapshots.

**Change record diff algorithm:**
1. Index fields by name from both snapshots
2. Fields in current but not previous = "added"
3. Fields in previous but not current = "removed"
4. Fields in both = compare all properties; if any differ = "modified" with `changedProperties` listing what changed

### UX/Design Requirements

- Entity header shows version number (e.g., "v3") and "History" button
- Version history panel renders in the Right Panel (same panel that shows decorator details)
- Hex-inspired dark theme: frosted glass background (`--glass-bg: rgba(28, 28, 38, 0.8)`), `backdrop-filter: blur(12px)`
- Relative timestamps ("2 hours ago") with absolute time on hover
- Monospace font (`--mono-size: 13px`) for version numbers and field names
- Spring animation (`cubic-bezier(0.34, 1.56, 0.64, 1)`) for panel open/close transitions

### File Structure
```
src/services/version.service.ts              — Business logic
src/types/schemas/version.ts                 — Zod schemas + TS types
src/server/api/routers/version.ts            — oRPC thin wrapper
src/components/custom/VersionHistoryPanel/
  ├── VersionHistoryPanel.tsx                 — Panel component
  ├── VersionHistoryPanel.types.ts            — Props & types
  ├── useVersionHistoryPanel.ts               — Logic hook
  └── index.ts                               — Re-export
tests/unit/services/version.service.test.ts  — Unit tests
tests/e2e/version-history.spec.ts            — Playwright E2E
```

### Testing Requirements
- **Unit tests (Vitest):** Mock Prisma client. Test snapshot generation, change record diffing, version number incrementing, audit trail integration.
- **E2E tests (Playwright):** Full flow from entity modification through version creation to history panel viewing.

### Dependencies & Prerequisites
- Epic 2 (Schema Authoring) complete — entities can be created and saved
- Epic 3 (Emission) complete — `entity_versions` table exists (Story 3.6)
- `withAudit()` utility available
- `Result` type defined in shared types
- Prisma schema includes `entity_versions` table

### References
- Architecture: Service layer pattern, Result type, withAudit()
- Architecture: `entity_versions` table schema
- Architecture: Module boundaries — Versioning reads schema data, never touches CRUD
- UX Spec: Right Panel pattern, Hex theme tokens

## Dev Agent Record
### Agent Model Used
### Completion Notes List
### Change Log

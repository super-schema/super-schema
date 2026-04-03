# Story 2.8: Entity & Field Lifecycle — Deprecation, Retirement & Status Management

Status: ready-for-dev

## Story

As a **data modeler**,
I want to deprecate and retire entities and fields with replacement references,
So that I can manage the full lifecycle of schema definitions and guide consumers to updated versions.

## Acceptance Criteria

**Given** entities and fields can be fully authored (Stories 2.1-2.7 complete)
**When** lifecycle management is implemented
**Then** the entity header includes a **status dropdown**: DRAFT, ACTIVE, DEPRECATED, RETIRED — with the current status displayed as a colored badge (green=ACTIVE, amber=DRAFT, orange=DEPRECATED, gray=RETIRED)
**And** changing entity status to **DEPRECATED** opens an inline form: "Deprecated since" date picker (defaults to today), "Replacement entity" searchable dropdown (all active entities), optional "Migration notes" textarea — all stored in entity metadata JSONB
**And** changing entity status to **RETIRED** requires the entity to be in DEPRECATED status first — attempting to retire a non-deprecated entity shows an error: "Entity must be deprecated before it can be retired"
**And** **DEPRECATED** entities display a persistent amber banner at the top of the editor: "This entity is deprecated since {date}. Replacement: {entity name}" with a link to the replacement entity
**And** **RETIRED** entities display a persistent gray banner: "This entity is retired since {date}. It is read-only." — all editing is disabled for retired entities (field grid is view-only, add field button hidden, decorator panel shows values but inputs are disabled)
**And** in the **sidebar**, deprecated entities show an orange dot indicator and retired entities show a gray dot with strikethrough text
**And** the **Evolution tab** in the decorator detail panel supports field-level deprecation: deprecated toggle, "since" date picker, "replacement" field reference input (entity.field format with autocomplete to other fields in any entity)
**And** deprecated fields display with a strikethrough visual treatment on the field name in the grid and an orange "Deprecated" badge
**And** the entity service validates status transitions: DRAFT->ACTIVE, ACTIVE->DEPRECATED, DEPRECATED->RETIRED are allowed; all other transitions are rejected with an error
**And** status changes are recorded in the audit trail via `withAudit()`
**And** unit tests verify: valid status transitions succeed, invalid transitions are rejected, deprecated entity stores replacement reference, retired entity blocks edits, field-level deprecation stores correctly
**And** a Playwright E2E test verifies: changing entity status to DEPRECATED shows the deprecation form and banner, retired entity is read-only, deprecated fields show strikethrough

## Tasks / Subtasks

### Task 1: Status Dropdown in Entity Header [AC: status dropdown, colored badge]
- [ ] Add status `Select` dropdown to EntityHeader component
- [ ] Status options: DRAFT, ACTIVE, DEPRECATED, RETIRED
- [ ] Display current status as colored `Badge`:
  - ACTIVE: green `#5bc27a`
  - DRAFT: amber `#e5a93b`
  - DEPRECATED: orange — use `#e5a93b` with orange tint or custom `#e88a3b`
  - RETIRED: gray `#8a8694`
- [ ] On status change: call `entity.update` oRPC mutation with new status

### Task 2: Status Transition Validation [AC: valid transitions only]
- [ ] Add status transition validation to `updateEntity()` in `entity.service.ts`
- [ ] Allowed transitions:
  - DRAFT -> ACTIVE
  - ACTIVE -> DEPRECATED
  - DEPRECATED -> RETIRED
- [ ] All other transitions rejected with error: `{ code: 'INVALID_TRANSITION', message: 'Cannot transition from {current} to {target}', suggestedFix: 'Entity must be {required} before it can be {target}' }`
- [ ] Attempting DRAFT -> RETIRED: "Entity must be deprecated before it can be retired"
- [ ] Attempting RETIRED -> ACTIVE: "Retired entities cannot be reactivated"
- [ ] Status changes recorded via `withAudit()`

### Task 3: Deprecation Inline Form [AC: date picker, replacement entity, migration notes]
- [ ] When status changes to DEPRECATED, show inline form below status dropdown:
  - "Deprecated since" date picker (defaults to today) — Shadcn date picker
  - "Replacement entity" searchable `Combobox` dropdown (all active entities)
  - "Migration notes" `Textarea` (optional)
- [ ] Store deprecation info in entity metadata JSONB:
  ```json
  { "deprecation": { "since": "2026-04-02", "replacementEntityId": "clxxx", "migrationNotes": "..." } }
  ```
- [ ] Save via `entity.update` oRPC mutation

### Task 4: Deprecation Banner [AC: persistent amber banner on deprecated entities]
- [ ] Create deprecation banner component for entity editor
- [ ] Amber banner (`bg-[rgba(229,169,59,0.15)]`, `border-warning`):
  - Text: "This entity is deprecated since {date}. Replacement: {entity name}"
  - Link to replacement entity (navigates to `/schemas/[replacementId]`)
- [ ] Display persistently at the top of the editor, below entity header

### Task 5: Retired Entity — Read-Only Mode [AC: gray banner, editing disabled]
- [ ] Create retirement banner: gray (`bg-muted`, `text-muted-foreground`):
  - Text: "This entity is retired since {date}. It is read-only."
- [ ] Disable all editing for retired entities:
  - Field grid: view-only (no inline editing, no click-to-edit)
  - "+" Add Field button: hidden
  - Decorator panel: show values but all inputs disabled (`disabled` attribute)
  - Entity header: name and description not editable
  - Status dropdown: only shows current status (no changes allowed from RETIRED)
- [ ] Implement via a `isReadOnly` flag derived from entity status === RETIRED

### Task 6: Sidebar Status Indicators [AC: orange/gray dots, strikethrough]
- [ ] Update Sidebar entity items:
  - DEPRECATED: orange dot indicator (same color as DEPRECATED badge)
  - RETIRED: gray dot + `line-through` text decoration on entity name
- [ ] Existing: ACTIVE = green, DRAFT = amber (from Story 2.2)

### Task 7: Field-Level Deprecation in Evolution Tab [AC: deprecated toggle, since, replacement]
- [ ] Update EvolutionTab in DecoratorPanel:
  - Deprecated `Switch` toggle
  - "Since" date picker — shown when deprecated=true
  - "Replacement" field reference `Input` with autocomplete (entity.field format)
- [ ] Autocomplete: query all entities and their fields, format as "EntityName.fieldName"
- [ ] Store in field decorators JSONB under `evolution` key (already in DecoratorSchema)

### Task 8: Deprecated Field Visual Treatment [AC: strikethrough name, orange badge]
- [ ] In SchemaFieldRow, check `decorators.evolution.deprecated`
- [ ] If deprecated:
  - Field name: `line-through` text decoration
  - Orange "Deprecated" `Badge` next to field name
  - Badge color: same as DEPRECATED entity badge

### Task 9: Audit Trail for Status Changes [AC: withAudit()]
- [ ] Verify all entity status changes go through `withAudit()` (should already be the case via entity.service.ts)
- [ ] Verify before/after state captures status change: `{ before: { status: "ACTIVE" }, after: { status: "DEPRECATED" } }`
- [ ] Verify field-level deprecation changes are also audited via field.update -> withAudit()

### Task 10: Unit Tests [AC: all unit test verifications]
- [ ] Create `tests/unit/features/lifecycle.test.ts`:
  - Test DRAFT -> ACTIVE transition succeeds
  - Test ACTIVE -> DEPRECATED transition succeeds
  - Test DEPRECATED -> RETIRED transition succeeds
  - Test DRAFT -> DEPRECATED transition rejected with error
  - Test DRAFT -> RETIRED transition rejected with error
  - Test RETIRED -> ACTIVE transition rejected
  - Test deprecated entity stores replacement reference in metadata
  - Test retired entity read-only flag
  - Test field-level deprecation stores in decorators.evolution

### Task 11: Playwright E2E Tests [AC: all E2E verifications]
- [ ] Create `tests/e2e/lifecycle.spec.ts`:
  - Test changing entity status to DEPRECATED shows deprecation form (date, replacement, notes)
  - Test deprecated entity shows amber banner with replacement link
  - Test changing to RETIRED shows gray banner and disables editing
  - Test retired entity: add field button hidden, fields not editable
  - Test deprecated fields show strikethrough name and orange badge
  - Test sidebar shows orange dot for deprecated, gray dot + strikethrough for retired

## Dev Notes

### Architecture & Patterns

**Status transition validation in service layer:**
```typescript
const VALID_TRANSITIONS: Record<EntityStatus, EntityStatus[]> = {
  DRAFT: ['ACTIVE'],
  ACTIVE: ['DEPRECATED'],
  DEPRECATED: ['RETIRED'],
  RETIRED: [],
};

function validateTransition(current: EntityStatus, target: EntityStatus): Result<void> {
  if (!VALID_TRANSITIONS[current].includes(target)) {
    return err({ code: 'INVALID_TRANSITION', message: `...`, suggestedFix: `...` });
  }
  return ok(undefined);
}
```

**Deprecation metadata in entity JSONB:**
```typescript
// EntityMetadataSchema update
deprecation: z.object({
  since: z.string(), // ISO date
  replacementEntityId: z.string().nullable(),
  migrationNotes: z.string().nullable(),
}).optional()
```

**Audit trail:** All status changes wrapped in `withAudit()` — captures before/after status.

### UX/Design Requirements

**Status badge colors:**
- ACTIVE: green `#5bc27a`
- DRAFT: amber `#e5a93b`
- DEPRECATED: orange (distinct from DRAFT amber) — approximately `#e88a3b` or use amber with orange tint
- RETIRED: gray `#8a8694`

**Deprecation banner:**
- Background: `rgba(229,169,59,0.15)` (amber translucent)
- Border: `border-warning` (`#e5a93b`)
- Border radius: 12px
- Replacement link: `text-info` (`#6ba3e8`), clickable

**Retirement banner:**
- Background: `bg-muted` (`#2a2a36`)
- Text: `text-muted-foreground` (`#8a8694`)
- No border, subtle

**Retired entity disabled state:**
- All inputs: `disabled` attribute, `opacity-50`, `cursor-not-allowed`
- Add field button: `display: none`

**Deprecated field treatment:**
- Name: `line-through` text decoration
- Badge: orange "Deprecated" in caption (11px/500)

**Error patterns (from UX spec):** "Errors are opportunities. Every validation failure includes a path forward." — transition errors include `suggestedFix`.

### File Structure

```
src/
  services/
    entity.service.ts                    # MODIFIED — add status transition validation
  features/
    schema-editor/
      EntityHeader.tsx                   # MODIFIED — add status dropdown
      DeprecationBanner.tsx              # NEW — amber banner for deprecated entities
      RetirementBanner.tsx               # NEW — gray banner for retired entities
      tabs/
        EvolutionTab.tsx                 # MODIFIED — field-level deprecation UI
  components/
    custom/
      SchemaFieldRow/
        SchemaFieldRow.tsx               # MODIFIED — strikethrough + deprecated badge
    layout/
      Sidebar/
        Sidebar.tsx                      # MODIFIED — orange/gray dots, strikethrough
  types/
    schemas/
      entity-metadata.schema.ts          # MODIFIED — add deprecation object

tests/
  unit/
    features/
      lifecycle.test.ts                  # NEW
  e2e/
    lifecycle.spec.ts                    # NEW
```

### Testing Requirements

**Unit tests (Vitest):**
- `tests/unit/features/lifecycle.test.ts` — status transition validation (all valid/invalid combos), deprecation metadata storage, read-only flag, field deprecation

**E2E tests (Playwright):**
- `tests/e2e/lifecycle.spec.ts` — deprecation form + banner, retirement read-only, field strikethrough, sidebar indicators

### Dependencies & Prerequisites

**Prerequisites:** Stories 2.1-2.7 complete (full entity/field authoring, decorator panel Evolution tab, entity metadata JSONB)

**Enables:** Story 2.10 (Lineage DAG — deprecated entities shown with muted edges), Epic 3 (emission gating based on entity status)

### References
- [Source: epics.md - Epic 2, Story 2.8]
- [Source: architecture.md - Data Architecture (EntityStatus enum, entity metadata JSONB)]
- [Source: architecture.md - Code Patterns (withAudit, Result type, ServiceError with suggestedFix)]
- [Source: ux-design-specification.md - Error Handling Patterns ("Errors are opportunities")]
- [Source: ux-design-specification.md - Color System (status colors, classification badges)]

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### Change Log

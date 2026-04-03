# Story 3.7: Type Mapping Overrides with Governance

Status: ready-for-dev

## Story
As a **data steward**,
I want to create governed overrides for type mappings when the default translation isn't suitable,
So that I can control how specific types map to targets with full audit trail.

## Acceptance Criteria

**Given** the emission pipeline and type mapping engine work (Stories 3.2, 3.6 complete)
**When** type mapping override governance is implemented
**Then** when a **lossy mapping warning** appears in the emission preview, clicking the warning opens an **override dialog** (Sheet from right panel) showing: source type, target format, current mapped type, loss description, and options
**And** the override dialog allows the steward to: accept the lossy mapping (acknowledge warning — dismisses it for this entity), create a **global override** (changes the mapping for all entities — requires Steward or Admin role), or create a **per-entity override** (changes the mapping for this entity only)
**And** creating an override requires: new mapped type (text input with autocomplete from valid target types), justification text (required), and is logged with the approver's user ID
**And** override mappings are stored in `type_mapping_policies` with `isOverride: true` and `approvedBy` set to the current user
**And** overrides are displayed in the emission preview with a blue "Override" badge next to the affected line
**And** the `withAudit()` wrapper records all override creation/modification in the audit trail
**And** only users with **Steward** or **Admin** role can create global overrides — Author role can only create per-entity overrides; Viewer role cannot create any overrides
**And** unit tests verify: override takes precedence over default mapping, per-entity override takes precedence over global override, non-Steward users cannot create global overrides, audit trail records override creation
**And** a Playwright E2E test verifies: clicking a lossy warning opens override dialog, creating an override updates the emission preview, override badge is displayed

## Tasks / Subtasks

### 1. Extend Prisma Schema for Override Support
- [ ] Add `entityId` field to `type_mapping_policies` (nullable — null means global, non-null means per-entity)
- [ ] Add `justification` field (String, required for overrides)
- [ ] Add `acknowledged` field (Boolean, default false — for "accept lossy" use case)
- [ ] Add unique constraint on `[targetFormat, sourceType, entityId, isOverride]`
- [ ] Run migration

### 2. Extend Type Mapping Service
- [ ] Update `src/services/type-mapping.service.ts`:
- [ ] Implement `createGlobalOverride(input: CreateGlobalOverrideInput, ctx: ServiceContext): Promise<Result<MappingPolicy>>`
  - [ ] Check RBAC: require Steward or Admin role
  - [ ] Validate `newMappedType` is a valid type for the target format
  - [ ] Create policy with `isOverride: true`, `entityId: null`, `approvedBy: ctx.userId`
  - [ ] Wrap in `withAudit()`
- [ ] Implement `createEntityOverride(input: CreateEntityOverrideInput, ctx: ServiceContext): Promise<Result<MappingPolicy>>`
  - [ ] Check RBAC: require Author, Steward, or Admin role
  - [ ] Validate `newMappedType` is a valid type for the target format
  - [ ] Create policy with `isOverride: true`, `entityId: input.entityId`, `approvedBy: ctx.userId`
  - [ ] Wrap in `withAudit()`
- [ ] Implement `acknowledgeLossyMapping(input: AcknowledgeInput, ctx: ServiceContext): Promise<Result<void>>`
  - [ ] Check RBAC: require Author, Steward, or Admin role
  - [ ] Create/update acknowledgment record for this entity + mapping
  - [ ] Wrap in `withAudit()`
- [ ] Implement `getOverridesForEntity(entityId: string, ctx: ServiceContext): Promise<Result<MappingPolicy[]>>`

### 3. Update Mapping Engine for Override Precedence
- [ ] Update `resolveMapping()` in `src/lib/type-mapping/mapping-engine.ts`:
  - [ ] Accept optional `entityId` parameter
  - [ ] Precedence chain: per-entity override > global override > default mapping
  - [ ] If per-entity override exists, use it and set `isOverride: true`
  - [ ] Mark result with override source (global vs per-entity)
- [ ] Update `MappingResult` type to include `overrideSource?: 'global' | 'per-entity'`

### 4. Create oRPC Router for Overrides
- [ ] Add procedures to `src/server/api/routers/emission.ts` (or create dedicated override router):
  - [ ] `override.createGlobal` — mutation, Steward/Admin only
  - [ ] `override.createEntity` — mutation, Author/Steward/Admin
  - [ ] `override.acknowledge` — mutation, Author/Steward/Admin
  - [ ] `override.listForEntity` — query

### 5. Build Override Dialog Component
- [ ] Create `src/components/custom/OverrideDialog/` directory
- [ ] Create `OverrideDialog.tsx` — Sheet component sliding from right panel
- [ ] Display current mapping info:
  - [ ] Source type (e.g., "decimal")
  - [ ] Target format (e.g., "OpenAPI")
  - [ ] Current mapped type (e.g., "number/double")
  - [ ] Loss description (e.g., "Decimal precision reduced to float64...")
- [ ] Three action options:
  - [ ] "Accept Lossy Mapping" — acknowledge for this entity, dismisses warning
  - [ ] "Create Global Override" — visible only to Steward/Admin
  - [ ] "Create Per-Entity Override" — visible to Author/Steward/Admin
- [ ] Override form fields:
  - [ ] New mapped type — text input with autocomplete from valid target types
  - [ ] Justification — required textarea
- [ ] Submit button with loading state
- [ ] Create `OverrideDialog.types.ts` — props and types
- [ ] Create `useOverrideDialog.ts` — logic hook
- [ ] Create `index.ts` — barrel export

### 6. Implement Valid Target Type Autocomplete
- [ ] Create list of valid types per target format:
  - [ ] BigQuery: STRING, INT64, FLOAT64, NUMERIC, BOOL, DATE, TIME, DATETIME, TIMESTAMP, BYTES, ARRAY, STRUCT, GEOGRAPHY, JSON
  - [ ] Avro: null, boolean, int, long, float, double, bytes, string, enum, array, map, fixed
  - [ ] OpenAPI: string, number, integer, boolean, array, object
- [ ] Implement autocomplete/combobox for the "new mapped type" field

### 7. Display Override Badge in Emission Preview
- [ ] Update EmissionPreviewPanel to detect override mappings in emitted output
- [ ] Display blue "Override" badge next to affected lines
- [ ] Badge shows tooltip on hover: "Global override by {username}" or "Per-entity override by {username}"
- [ ] Override lines have subtle blue left border highlight

### 8. Wire Warning Click to Override Dialog
- [ ] In EmissionPreviewPanel warning summary, make each warning clickable
- [ ] Clicking a warning:
  - [ ] Highlights the affected line in the code viewer
  - [ ] Opens the OverrideDialog Sheet with the relevant mapping context pre-filled

### 9. Update Emission Pipeline for Overrides
- [ ] Update `previewEmission()` to include per-entity overrides when resolving mappings
- [ ] Update `commitEmission()` to persist override references in emission_targets
- [ ] After override creation, automatically re-run preview to show updated emission

### 10. Write Unit Tests
- [ ] Create `tests/unit/services/type-mapping-override.test.ts`
  - [ ] Test: override takes precedence over default mapping in `resolveMapping()`
  - [ ] Test: per-entity override takes precedence over global override
  - [ ] Test: non-Steward user cannot create global override (returns permission error)
  - [ ] Test: Author can create per-entity override
  - [ ] Test: Viewer cannot create any override
  - [ ] Test: audit trail records override creation (withAudit called)
  - [ ] Test: acknowledge lossy mapping marks it as acknowledged
- [ ] Create `tests/unit/components/OverrideDialog.test.tsx`
  - [ ] Test: dialog displays current mapping info
  - [ ] Test: global override option hidden for non-Steward users
  - [ ] Test: justification is required
  - [ ] Test: autocomplete shows valid target types

### 11. Write E2E Test
- [ ] Create `tests/e2e/type-mapping-override.spec.ts` (Playwright)
  - [ ] Test: lossy warning appears in emission preview
  - [ ] Test: clicking warning opens override dialog with correct context
  - [ ] Test: creating per-entity override updates emission preview
  - [ ] Test: override badge is displayed next to affected line
  - [ ] Test: acknowledging lossy mapping dismisses the warning

## Dev Notes

### Architecture & Patterns

**Override precedence chain:**
```
per-entity override > global override > default mapping
```

The `resolveMapping()` function applies this precedence. When an override is active, the `MappingResult` includes `isOverride: true` and `overrideSource: 'global' | 'per-entity'`.

**RBAC for overrides:**

| Role | Per-Entity Override | Global Override | Acknowledge Lossy |
|---|---|---|---|
| Viewer | No | No | No |
| Author | Yes | No | Yes |
| Steward | Yes | Yes | Yes |
| Admin | Yes | Yes | Yes |

**Key interfaces:**

```typescript
type MappingPolicy = {
  sourceType: string;
  targetType: string;
  targetFormat: string;
  mappedType: string;
  isOverride: boolean;
  approvedBy?: string;
};

interface MappingResult {
  mappedType: string;
  isLossy: boolean;
  lossDescription?: string;
  isOverride: boolean;
  overrideSource?: 'global' | 'per-entity';
}
```

**Audit trail:** Every override creation/modification is wrapped in `withAudit()`. The audit log records: action, entity_type, entity_id, user_id, before_state, after_state.

**Result type pattern:** All service functions return `Result<T, E>`, never throw.

### UX/Design Requirements

**Override Dialog** — a Sheet component sliding from the right panel (Shadcn Sheet, frosted glass background):

- Displays source type, target format, current mapped type, and loss description
- Three action options: Accept Lossy, Global Override (Steward/Admin only), Per-Entity Override
- Form: new mapped type (combobox with autocomplete), justification (required textarea)
- Submit button: primary (amethyst fill), loading state spinner

**Override Badge** — blue badge displayed inline next to affected lines in EmissionPreviewPanel:
- Text: "Override"
- Tooltip on hover: "Global override by {username}" or "Per-entity override by {username}"
- Subtle blue left border on the affected line

**Warning interaction:**
- Warning summary below tabs is clickable
- Click highlights affected line and opens OverrideDialog

**Design tokens:**
- Override badge: blue accent color
- Warning: amber indicator (`--field-suggestion`)
- Frosted glass: `rgba(28, 28, 38, 0.8)` with `backdrop-filter: blur(12px)`

### File Structure

```
prisma/
├── schema.prisma                  # Updated: entityId, justification, acknowledged on type_mapping_policies
├── migrations/                    # New migration
src/
├── services/
│   └── type-mapping.service.ts    # Updated: global/entity override, acknowledge
├── lib/type-mapping/
│   └── mapping-engine.ts          # Updated: override precedence with entityId
├── server/api/routers/
│   └── emission.ts                # Updated: override procedures (or new override router)
├── components/custom/OverrideDialog/
│   ├── OverrideDialog.tsx         # Sheet component
│   ├── OverrideDialog.types.ts    # Props & types
│   ├── useOverrideDialog.ts       # Logic hook
│   └── index.ts                   # Barrel export
├── components/custom/EmissionPreviewPanel/
│   └── EmissionPreviewPanel.tsx   # Updated: warning click → override dialog, override badge
tests/
├── unit/
│   ├── services/
│   │   └── type-mapping-override.test.ts
│   └── components/
│       └── OverrideDialog.test.tsx
├── e2e/
│   └── type-mapping-override.spec.ts  # Playwright
```

### Testing Requirements

- **Unit tests (Vitest):** Override precedence, RBAC enforcement (per role), audit trail logging, acknowledgment, component rendering, form validation
- **E2E tests (Playwright):** Warning click → dialog → create override → preview update → badge display
- **Test framework:** Vitest + Playwright

### Dependencies & Prerequisites

- Story 3.2 complete (type mapping engine, mapping policies table)
- Story 3.6 complete (emission pipeline, EmissionPreviewPanel with warnings)
- RBAC middleware/check utility
- `withAudit()` wrapper
- Shadcn components: Sheet, Input, Textarea, Button, Badge, Combobox, Tooltip
- `ValidationIndicator` component

### References

- Architecture document: "TypeSpec Integration" section — MappingPolicy type, emitter intermediate model
- Architecture document: "Data Architecture" section — type_mapping_policies table
- Architecture document: "Authentication & Security" section — RBAC roles and permissions
- UX Design Specification: Sheet component, form patterns, feedback patterns

## Dev Agent Record
### Agent Model Used
### Completion Notes List
### Change Log

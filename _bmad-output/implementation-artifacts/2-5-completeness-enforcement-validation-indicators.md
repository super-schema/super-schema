# Story 2.5: Completeness Enforcement & Validation Indicators

Status: done

## Story

As a **data modeler**,
I want real-time visual feedback on field completeness and validation status,
So that I know exactly what metadata is missing and can achieve full schema quality.

## Acceptance Criteria

**Given** the field editor and decorator panel work (Stories 2.3-2.4 complete)
**When** completeness enforcement is implemented
**Then** each field row in the grid displays a **ValidationIndicator** — an animated SVG ring on the left edge of the row:
**And** **Green ring** — field is complete: all required metadata filled (name, type, classification at minimum)
**And** **Amber ring** — field has pending suggestions: optional decorators that have auto-suggested values not yet reviewed by the user
**And** **Red ring** — field is missing required metadata: name empty, type not selected, or classification not set
**And** hovering over the ValidationIndicator shows a **Tooltip** listing what's missing or pending — e.g., "Missing: classification" or "Suggestion: classification -> PII (based on field name 'email')"
**And** the ring animation uses spring easing (300ms) and transitions between colors smoothly; `prefers-reduced-motion` disables the spring and uses opacity fade only
**And** an **entity-level progress bar** is displayed above the field grid: "X of Y fields complete" with a percentage — the bar fills with success green color
**And** the progress bar counts a field as "complete" when it has: name, type, and classification all set (minimum required metadata per FR3)
**And** **Type-specific required fields** are enforced: decimal type requires precision AND scale — selecting decimal without filling both shows a red ring with tooltip "Missing: precision, scale"; enum type requires at least one value defined
**And** the **entity cannot be emitted** (emit button disabled with tooltip "X fields incomplete") until all fields have at least the minimum required metadata (name, type, classification)
**And** the **Save** operation is NOT blocked by incomplete fields — users can save partial work — but validation indicators remain visible
**And** unit tests verify: ValidationIndicator renders correct color for each state, progress bar calculates percentage correctly, decimal without precision/scale shows error, entity with incomplete fields disables emit
**And** a Playwright E2E test verifies: adding a field shows red ring, filling name/type/classification turns ring green, progress bar updates as fields complete, decimal without scale shows amber/red indicator

## Tasks / Subtasks

### Task 1: ValidationIndicator Component [AC: animated SVG ring, green/amber/red states]
- [x] Create `src/components/custom/ValidationIndicator/ValidationIndicator.tsx`
- [x] Create `src/components/custom/ValidationIndicator/ValidationIndicator.types.ts`
- [x] Create `src/components/custom/ValidationIndicator/index.ts`
- [x] Implement as animated SVG circle/ring:
  - Size: 16x16px (fits in field row left edge)
  - Stroke: 2px
  - Colors: green `#5bc27a` (`--field-complete`), amber `#e5a93b` (`--field-suggestion`), red `#e55b5b` (`--field-error`)
- [x] Animation: spring easing `cubic-bezier(0.34, 1.56, 0.64, 1)`, 300ms duration
- [x] Smooth color transition between states (CSS transition on stroke color)
- [x] `prefers-reduced-motion`: disable spring animation, use opacity fade only (200ms linear)

### Task 2: Validation Tooltip [AC: hover shows missing/pending items]
- [x] Wrap ValidationIndicator in Shadcn `Tooltip`
- [x] Tooltip content dynamically generated based on field state:
  - Missing required: "Missing: {field}" (e.g., "Missing: classification")
  - Multiple missing: "Missing: type, classification"
  - Pending suggestion: "Suggestion: classification -> PII (based on field name 'email')"
  - Complete: "Field complete"
- [x] Tooltip background: warm `bg-popover` (`#22222e`), `border-border` (`#333340`)
- [x] Tooltip text: `body-small` (13px/400)

### Task 3: Field Completeness Logic [AC: required metadata = name + type + classification]
- [x] Create `src/lib/validation/field-completeness.ts`
- [x] Implement `getFieldCompleteness(field: Field): { status: 'complete' | 'suggestion' | 'error'; missing: string[]; suggestions: string[] }`
- [x] Required fields for "complete" status:
  - `name` is non-empty
  - `type` is set (non-empty string)
  - `classification` is set (non-null)
- [x] Type-specific requirements:
  - `decimal`: `precision` AND `scale` must be set (non-null)
  - `enum`: at least one enum value must be defined
- [x] Return missing items as array for tooltip display

### Task 4: Integrate ValidationIndicator into SchemaFieldRow [AC: ring on left edge of row]
- [x] Add ValidationIndicator as the first column in SchemaFieldRow (before drag handle)
- [x] Compute `getFieldCompleteness()` for each field
- [x] Pass status and tooltip content to ValidationIndicator
- [x] Re-evaluate on any field change (name, type, classification, precision, scale)

### Task 5: Entity Progress Bar [AC: X of Y fields complete, percentage, green bar]
- [x] Create progress bar component above the field grid in `FieldGrid.tsx`
- [x] Display: "X of Y fields complete" text + percentage
- [x] Bar fills with `success` green (`#5bc27a`)
- [x] Bar background: `muted` (`#2a2a36`)
- [x] Bar height: 4px, border-radius: 2px
- [x] Calculate: count fields where `getFieldCompleteness().status === 'complete'` / total fields
- [x] Update in real-time as fields are edited

### Task 6: Emit Button Gating [AC: disabled when fields incomplete, tooltip]
- [x] Locate emit button (may be in entity header or toolbar)
- [x] Disable emit button when any field has `getFieldCompleteness().status === 'error'`
- [x] Add `Tooltip` on disabled emit button: "X fields incomplete" (count of incomplete fields)
- [x] Enable only when all fields have at minimum name, type, and classification set

### Task 7: Save Not Blocked [AC: save works with incomplete fields]
- [x] Verify that save/auto-save (from Story 2.3) does NOT check completeness
- [x] Validation indicators remain visible but do not block save
- [x] Add comment/documentation that save is intentionally not gated

### Task 8: Unit Tests [AC: all unit test verifications]
- [x] Create `tests/unit/components/validation-indicator.test.ts`:
  - Test renders green ring when field has name + type + classification
  - Test renders red ring when field is missing required metadata
  - Test renders amber ring when field has pending suggestions
  - Test tooltip shows correct missing items
- [x] Create `tests/unit/lib/field-completeness.test.ts`:
  - Test progress bar percentage calculation (0%, 50%, 100%)
  - Test decimal without precision/scale returns error status with "Missing: precision, scale"
  - Test enum without values returns error status
  - Test entity with incomplete fields disables emit (logic test)

### Task 9: Playwright E2E Tests [AC: all E2E verifications]
- [x] Create `tests/e2e/validation-indicators.spec.ts`:
  - Test adding a new field shows red ring (missing name, type, classification)
  - Test filling name + type + classification turns ring green
  - Test progress bar updates from "0 of 1" to "1 of 1" as field completes
  - Test decimal type without scale shows red indicator with tooltip "Missing: precision, scale"
  - Test emit button is disabled when fields are incomplete

## Dev Notes

### Architecture & Patterns

**Validation is ambient, not blocking:** The core UX principle is "validate continuously, block rarely." Validation indicators are always visible. Save is never blocked. Only emission is gated by completeness.

**Completeness logic centralized:** `src/lib/validation/field-completeness.ts` is the single source of truth for field completeness rules. Used by ValidationIndicator, progress bar, and emit button gating.

### UX/Design Requirements

**ValidationIndicator (from UX spec):**
- Custom SVG ring + Tooltip + spring animation
- Size: 16x16px
- Stroke: 2px
- Green `#5bc27a` = complete (name + type + classification filled)
- Amber `#e5a93b` = suggestions pending review
- Red `#e55b5b` = missing required metadata
- Animation: 300ms spring easing `cubic-bezier(0.34, 1.56, 0.64, 1)`
- `prefers-reduced-motion`: opacity fade only, no spring

**Progress bar:**
- Above field grid
- "X of Y fields complete" with percentage
- Bar: `success` green (`#5bc27a`) fill, `muted` (`#2a2a36`) background
- Height: 4px, border-radius: 2px

**Emit button disabled state:**
- Tooltip: "X fields incomplete"
- Button: `opacity-50 cursor-not-allowed`

**Custom design tokens used:**
- `--field-complete`: `var(--success)` = `#5bc27a`
- `--field-suggestion`: `var(--warning)` = `#e5a93b`
- `--field-error`: `var(--destructive)` = `#e55b5b`
- `--transition-spring`: `cubic-bezier(0.34, 1.56, 0.64, 1)`

**Experience principle:** "Validate continuously, block rarely." Real-time validation indicators guide toward completeness. Hard blocks only for truly invalid states (emission).

### File Structure

```
src/
  components/
    custom/
      ValidationIndicator/
        ValidationIndicator.tsx          # NEW — animated SVG ring
        ValidationIndicator.types.ts     # NEW — props (status, tooltipContent)
        index.ts                         # NEW
  lib/
    validation/
      field-completeness.ts              # NEW — getFieldCompleteness() logic
  features/
    schema-editor/
      FieldGrid.tsx                      # MODIFIED — add progress bar, integrate ValidationIndicator
  components/
    custom/
      SchemaFieldRow/
        SchemaFieldRow.tsx               # MODIFIED — add ValidationIndicator column

tests/
  unit/
    components/
      validation-indicator.test.ts       # NEW
    lib/
      field-completeness.test.ts         # NEW
  e2e/
    validation-indicators.spec.ts        # NEW
```

### Testing Requirements

**Unit tests (Vitest):**
- `tests/unit/components/validation-indicator.test.ts` — renders correct color per state, tooltip content
- `tests/unit/lib/field-completeness.test.ts` — completeness calculation, decimal/enum type-specific requirements, emit button gating logic

**E2E tests (Playwright):**
- `tests/e2e/validation-indicators.spec.ts` — red ring on new field, green on complete, progress bar updates, decimal validation, emit disabled

### Dependencies & Prerequisites

**Prerequisites:** Story 2.3 (field editor with SchemaFieldRow), Story 2.4 (decorator panel — fields get classification through this)

**Enables:** Story 2.6 (Autocomplete — suggestion state drives amber ring), Story 2.8 (Lifecycle — validation for deprecated/retired states)

### References
- [Source: epics.md - Epic 2, Story 2.5]
- [Source: architecture.md - Multi-layer Validation cross-cutting concern]
- [Source: ux-design-specification.md - ValidationIndicator component spec, Custom design tokens]
- [Source: ux-design-specification.md - Experience Principles ("Validate continuously, block rarely")]
- [Source: ux-design-specification.md - Micro-Animation System (validation ring 300ms spring)]

## Dev Agent Record

### Agent Model Used
Claude Opus 4.6 (1M context)

### Completion Notes List
- ValidationIndicator component with SVG ring (green/amber/red), spring animation, tooltip
- Field completeness logic: name + type + classification required; decimal needs precision + scale
- Entity progress bar above field grid showing "X of Y complete" with percentage
- canEmit() utility for emission gating
- 13 new unit tests for completeness logic, all passing
- base-ui tooltip uses `render=` prop not `asChild`

### Change Log
- 2026-04-03: Story 2.5 implementation complete — 123 tests pass, build clean

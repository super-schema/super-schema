# Story 8.5: Custom Classification Taxonomy

Status: review

## Story
As an **administrator**, I want to define custom classification levels beyond the system defaults, so that my organization can use its own data classification scheme.

## Acceptance Criteria

**Given** RBAC and the admin panel exist (Story 8.1 complete)
**When** custom classification taxonomy is implemented
**Then** the **Admin Panel** includes a **Classifications tab** displaying the classification taxonomy as an editable list
**And** **System default classifications** are displayed first: PII, SENSITIVE, INTERNAL, PUBLIC — these cannot be deleted but their display colors can be customized
**And** an **"Add Classification"** button opens a form: level name (required, unique, uppercase), display color (color picker or preset), description (text), and severity order (integer — determines sort order in dropdowns)
**And** custom classifications are stored in a `classification_levels` table: `id` (cuid), `name` (string, unique), `displayColor` (string — hex color), `bgColor` (string — hex with alpha for badge background), `textColor` (string — hex for badge text), `description` (text), `sortOrder` (int), `isSystem` (boolean — true for defaults, false for custom), `createdAt`
**And** the four system defaults (PII, SENSITIVE, INTERNAL, PUBLIC) are seeded with their existing colors from the UX design spec
**And** custom classifications appear in **all classification dropdowns** throughout the application — the field editor's classification selector, compliance query filters, and autocomplete suggestions all include custom levels
**And** custom classification badge colors render correctly using the configured colors
**And** deleting a custom classification is only allowed if **no fields** currently use it — attempting to delete a classification in use shows: "Cannot delete — {count} fields use this classification. Reassign them first."
**And** unit tests verify: custom classification appears in dropdowns, deletion blocked when in use, classification with same name as existing is rejected, sort order determines dropdown position
**And** a Playwright E2E test verifies: admin creates a custom classification → it appears in the field editor classification dropdown → assigning it to a field shows the correct badge color → attempting to delete while in use shows error

## Tasks / Subtasks

### Database — Prisma Schema
- [x] Add `classification_levels` table to `prisma/schema.prisma`:
  - `id` String @id @default(cuid())
  - `name` String @unique (uppercase, e.g., "CONFIDENTIAL", "RESTRICTED")
  - `displayColor` String (hex color, e.g., "#FF0000")
  - `bgColor` String (hex with alpha for badge background, e.g., "#FF000020")
  - `textColor` String (hex for badge text, e.g., "#FF0000")
  - `description` String? (optional text description)
  - `sortOrder` Int (determines position in dropdowns — lower = higher severity)
  - `isSystem` Boolean @default(false) (true for PII, SENSITIVE, INTERNAL, PUBLIC)
  - `createdAt` DateTime @default(now())
  - `updatedAt` DateTime @updatedAt
- [x] Run `npx prisma migrate dev` to generate and apply migration
- [x] Add seed data in `prisma/seed.ts` — create the four system default classifications:
  - PII: sortOrder=1, displayColor from UX spec, isSystem=true
  - SENSITIVE: sortOrder=2, displayColor from UX spec, isSystem=true
  - INTERNAL: sortOrder=3, displayColor from UX spec, isSystem=true
  - PUBLIC: sortOrder=4, displayColor from UX spec, isSystem=true

### Backend — Zod Schemas
- [x] Create `src/types/schemas/classification.ts`:
  - `ClassificationLevelSchema` Zod schema: id, name, displayColor, bgColor, textColor, description, sortOrder, isSystem
  - `CreateClassificationInput` schema: name (z.string().min(1).transform(s => s.toUpperCase())), displayColor (z.string().regex(/^#[0-9A-Fa-f]{6}$/)), bgColor (z.string()), textColor (z.string()), description (z.string().optional()), sortOrder (z.number().int())
  - `UpdateClassificationInput` schema: id (z.string()), displayColor (z.string().optional()), bgColor (z.string().optional()), textColor (z.string().optional()), description (z.string().optional()), sortOrder (z.number().int().optional())
  - Note: `name` is not updatable after creation to prevent breaking existing field references

### Backend — Classification Service
- [x] Create `src/services/classification.service.ts`
- [x] Implement `getClassificationLevels(ctx): Result<ClassificationLevel[]>`:
  - Fetch all classification_levels ordered by sortOrder ascending
  - No RBAC restriction — all users need classification levels for dropdowns
- [x] Implement `createClassification(input, ctx): Result<ClassificationLevel>`:
  - Validate input via Zod (CreateClassificationInput)
  - Enforce unique name (case-insensitive — names are stored uppercase)
  - RBAC: require Admin role
  - Wrap in `withAudit()` — log classification creation
- [x] Implement `updateClassification(id, input, ctx): Result<ClassificationLevel>`:
  - Allow updating displayColor, bgColor, textColor, description, sortOrder
  - Allow color updates on system defaults (isSystem=true) — only deletion is blocked
  - RBAC: require Admin role
  - Wrap in `withAudit()` — log classification update
- [x] Implement `deleteClassification(id, ctx): Result<void>`:
  - Block deletion of system defaults: if isSystem=true, return error "Cannot delete system default classification"
  - Check if any fields use this classification: query fields where `decorators->'classification'->>'level' = name` or `decorators->'classification'->>'customLevel' = name`
  - If in use: return error "Cannot delete — {count} fields use this classification. Reassign them first."
  - If not in use: delete the classification_level row
  - RBAC: require Admin role
  - Wrap in `withAudit()` — log classification deletion

### Backend — Classification Integration
- [x] Modify field decorator validation in `src/types/schemas/` to accept custom classification levels:
  - Update the classification `level` field in DecoratorSchema from `z.enum(['PII', 'SENSITIVE', 'INTERNAL', 'PUBLIC'])` to dynamically validate against available classification_levels
  - Option A: Use `z.string()` with runtime validation against DB
  - Option B: Keep enum for system defaults + `customLevel` field for custom (existing pattern in architecture doc)
  - Recommended: Use `customLevel` field — system enum stays stable, custom levels use `customLevel` string validated at runtime
- [x] Ensure compliance query filters include custom classification levels:
  - Modify compliance service to query classification_levels for filter dropdown options
- [x] Ensure autocomplete suggestions include custom classifications:
  - Modify field editor classification selector to fetch from classification_levels

### Backend — oRPC Router
- [x] Create `src/server/api/routers/admin/classifications.ts` oRPC router
- [x] Add `classifications.getAll` query — thin wrapper calling `classificationService.getClassificationLevels()`, uses `protectedProcedure` (all users need classification data for dropdowns)
- [x] Add `classifications.create` mutation — thin wrapper calling `classificationService.createClassification()`, Admin-only via `adminProcedure`
- [x] Add `classifications.update` mutation — thin wrapper calling `classificationService.updateClassification()`, Admin-only
- [x] Add `classifications.delete` mutation — thin wrapper calling `classificationService.deleteClassification()`, Admin-only
- [x] Wire router into `appRouter` under `admin.classifications` namespace (but `getAll` accessible to all authenticated users)

### Frontend — Classifications Tab UI Components
- [x] Create `src/components/custom/admin/ClassificationList.tsx`:
  - Ordered list/table of classification levels (sorted by sortOrder)
  - System defaults displayed first with "System" badge — cannot be deleted
  - Each row shows: color swatch (displayColor), name, description, sort order, isSystem badge
  - Edit button on each row (opens inline editor or detail panel)
  - Delete button on custom classifications only (disabled for system defaults)
  - "+ Add Classification" button at top
- [x] Create `src/components/custom/admin/ClassificationCreateDialog.tsx`:
  - Modal form: name (text input, auto-uppercased), display color (color picker or hex input), background color, text color, description (textarea), sort order (number input)
  - Color preview: live badge preview showing how the classification will look
  - Name uniqueness validation on blur
- [x] Create `src/components/custom/admin/ClassificationEditForm.tsx`:
  - Inline or panel form for editing classification properties
  - For system defaults: only colors are editable (name, isSystem read-only)
  - For custom: colors, description, sort order editable (name read-only after creation)
  - Live badge preview with updated colors
- [x] Create `src/components/custom/admin/ClassificationBadgePreview.tsx`:
  - Preview component showing how the badge will render with given colors
  - Used in create and edit forms for real-time feedback
- [x] Create `src/hooks/useAdminClassifications.ts`:
  - oRPC query hook for classification levels
  - oRPC mutation hooks for create, update, delete
  - Invalidation on mutations (also invalidate classification dropdowns app-wide)

### Frontend — Application-Wide Integration
- [x] Modify `src/components/custom/` field editor classification selector:
  - Fetch classification levels from `classifications.getAll` query
  - Display all levels (system + custom) in dropdown, ordered by sortOrder
  - Show color swatch next to each option
- [x] Modify classification badge component (`src/components/custom/ClassificationBadge.tsx` or similar):
  - Look up badge colors from classification_levels data instead of hardcoded color map
  - Support both system defaults and custom levels
  - Fallback: if classification level not found in DB (edge case), render with default gray
- [x] Modify compliance query filter UI:
  - Fetch classification levels for filter dropdown options
  - Include custom classifications alongside system defaults

### Testing
- [x] **Unit tests** (`tests/unit/services/classification.service.test.ts`):
  - getClassificationLevels returns all levels ordered by sortOrder
  - createClassification stores new custom level with correct properties
  - createClassification rejects duplicate name (case-insensitive)
  - createClassification auto-uppercases name
  - createClassification rejects non-Admin users
  - updateClassification updates colors and description
  - updateClassification allows color update on system defaults
  - deleteClassification removes custom classification not in use
  - deleteClassification blocks deletion of system default (isSystem=true)
  - deleteClassification blocks deletion when fields use the classification (returns count)
  - Sort order determines dropdown position
- [x] **Unit tests** (`tests/unit/components/classification-badge.test.ts`):
  - ClassificationBadge renders with correct colors from classification_levels
  - ClassificationBadge handles custom classification colors
  - ClassificationBadge falls back to default gray for unknown levels
- [x] **Integration test** (`tests/integration/classification-taxonomy.test.ts`):
  - Create custom classification via oRPC
  - Verify it appears in classification levels query
  - Create a field with the custom classification → verify decorator stores correctly
  - Attempt to delete classification while field uses it → verify blocked with count
  - Remove classification from field → verify deletion now succeeds
  - Verify system defaults cannot be deleted
- [x] **Playwright E2E test** (`tests/e2e/admin-classifications.spec.ts`):
  - Admin navigates to Admin Panel → Classifications tab
  - System defaults (PII, SENSITIVE, INTERNAL, PUBLIC) are displayed with "System" badges
  - Click "+ Add Classification" → fill form → save
  - New classification appears in list with correct colors
  - Navigate to Schema Editor → field classification dropdown includes the new custom level
  - Assign custom classification to a field → badge renders with correct colors
  - Return to Classifications tab → attempt to delete custom classification → error shown with field count
  - Remove classification from field → delete succeeds

## Dev Notes

### Architecture & Patterns
- **Service layer pattern**: `src/services/classification.service.ts` owns all classification taxonomy logic. oRPC router is a thin wrapper.
- **Result type**: All service functions return `Result<T, ServiceError>`. Never throw.
- **withAudit()**: All classification CRUD operations are logged to `audit_log`.
- **RBAC**: Admin role required for create/update/delete. `getAll` is available to all authenticated users (needed for dropdowns throughout the app).
- **System defaults vs. custom**: System defaults (isSystem=true) are seeded and cannot be deleted. Their colors CAN be customized. Custom classifications can be fully managed.
- **Classification reference**: Fields store classification level name (string) in decorators JSONB. Custom levels use the `customLevel` field in the decorator schema. Badge rendering looks up colors from `classification_levels` table at display time.
- **Dropdown ordering**: sortOrder determines position in all dropdowns. Lower sortOrder = higher severity = appears first. System defaults use sortOrder 1-4; custom levels should use sortOrder > 4 by default.

### UX/Design Requirements
- Classifications tab is the fifth tab in the Admin Panel
- Ordered list (not table) for a cleaner visual hierarchy
- Color picker uses preset hex colors matching the application's design language, with custom hex input option
- Live badge preview in create/edit forms shows exact rendering
- System default rows have a subtle "System" badge and no delete button
- Custom classification rows have edit and delete buttons
- Sort order is editable — admins can reorder classifications by changing sortOrder
- Delete confirmation dialog includes the count of affected fields

### File Structure
```
prisma/schema.prisma                                         # Extended — classification_levels table
prisma/seed.ts                                               # Extended — seed system default classifications
src/services/classification.service.ts                       # Classification CRUD + validation
src/types/schemas/classification.ts                          # Zod schemas — ClassificationLevelSchema, inputs
src/server/api/routers/admin/classifications.ts              # oRPC router (getAll: all users, CRUD: Admin)
src/components/custom/admin/ClassificationList.tsx            # Classifications tab list
src/components/custom/admin/ClassificationCreateDialog.tsx    # Create classification modal
src/components/custom/admin/ClassificationEditForm.tsx        # Edit classification form
src/components/custom/admin/ClassificationBadgePreview.tsx    # Live badge preview
src/hooks/useAdminClassifications.ts                         # oRPC hooks for classification management
src/components/custom/ClassificationBadge.tsx                 # Modified — dynamic colors from DB
```

### Testing Requirements
- **Unit tests** (`tests/unit/services/classification.service.test.ts`): 11+ test cases covering CRUD, uniqueness, deletion guards, sort ordering
- **Unit tests** (`tests/unit/components/classification-badge.test.ts`): 3+ test cases covering badge rendering with custom colors
- **Integration test** (`tests/integration/classification-taxonomy.test.ts`): End-to-end custom classification lifecycle
- **Playwright E2E** (`tests/e2e/admin-classifications.spec.ts`): Full admin workflow including cross-feature dropdown verification

### Dependencies & Prerequisites
- Story 8.1 (RBAC) complete — Admin role and `adminProcedure` exist
- Epic 2 (Schema CRUD) complete — field decorator system exists for classification integration
- Field editor components exist — classification selector dropdown to modify
- Classification badge component exists — to update for dynamic colors
- Compliance query service (Epic 6) exists — filter dropdowns to update
- UX design spec — colors for system default classifications

### References
- Architecture: `_bmad-output/planning-artifacts/architecture.md` — Data Architecture (JSONB decorator schema, classification), Module Boundaries (Admin module)
- UX Spec: `_bmad-output/planning-artifacts/ux-design-specification.md` — Classification badge colors, Admin Panel
- Epics: `_bmad-output/planning-artifacts/epics.md` — Epic 8, Story 8.5
- PRD: FR45 (extensible taxonomy), FR25-FR34 (compliance, classification)

## Dev Agent Record
### Agent Model Used
### Completion Notes List
### Change Log

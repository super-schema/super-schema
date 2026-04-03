# Story 9.2: Drift Detection Engine

Status: ready-for-dev

## Story
As a **data engineer**, I want to detect drift between my logical schema and registered implementation schemas, so that I know when production schemas have diverged from the source of truth.

## Acceptance Criteria

**Given** schema import and emission exist (Stories 9.1, Epic 3 complete)
**When** drift detection is implemented
**Then** a **drift service** (`src/services/drift.service.ts`) exports: `detectDrift(entityId, ctx): Result<DriftReport>`, `detectDriftForAll(ctx): Result<DriftReport[]>`
**And** `DriftReport` contains: `{ entityId, entityName, targets: [{ targetFormat, driftStatus: "in-sync"|"drifted"|"unknown", differences: DriftDifference[] }] }` where `DriftDifference = { fieldName, type: "added"|"removed"|"type-mismatch"|"metadata-mismatch", logicalValue, implementationValue }`
**And** drift is detected by comparing: the **current emitted output** for each target (from `emission_targets.emittedOutput`) against the **imported/registered implementation** (from entity metadata `importedFrom.originalContent`)
**And** comparison logic uses the same parsers from the import service — parse both the emitted output and the registered implementation into a normalized field list, then diff them
**And** **In-sync**: all fields match (name, type, nullability) between logical emission and registered implementation
**And** **Drifted**: differences exist — added fields (in logical but not implementation), removed fields (in implementation but not logical), type mismatches, metadata mismatches
**And** the drift report is stored in the `deployment_tracking` table: `id`, `emissionTargetId` (FK), `environment` (string), `status` (DEPLOYED/STAGED/DRIFTED), `deployedVersionId` (FK to entity_versions, nullable), `driftReport` (JSONB), `checkedAt`
**And** drift detection runs **on-demand** (user clicks "Check Drift" on an entity) and can also be triggered via the API (`POST /api/v1/schemas/:id/drift`)
**And** drift indicators are displayed in the UI:
**And** **Sidebar**: entities with drift show an amber dot next to their name
**And** **Entity header**: a "Drift" badge shows per-target drift status (green/amber per target)
**And** **Deployment section** in the Right Panel (new tab): shows per-target drift status with expandable diff details
**And** a **notification** (type: DRIFT_ALERT) is created when drift is detected — sent to the entity owner
**And** unit tests verify: in-sync schemas produce no differences, added/removed fields are detected, type mismatches are detected, drift status is correctly categorized, drift report is stored
**And** a Playwright E2E test verifies: importing a schema → modifying the entity → running drift detection → drift badge appears → expanding shows differences

## Tasks / Subtasks

### Database — Prisma Schema
- [ ] Add `deployment_tracking` table to `prisma/schema.prisma`:
  - `id` String @id @default(cuid())
  - `emissionTargetId` String (FK to emission_targets)
  - `environment` String (e.g., "production", "staging", "development")
  - `status` String — enum: "DEPLOYED", "STAGED", "DRIFTED", "UNKNOWN"
  - `deployedVersionId` String? (nullable FK to entity_versions)
  - `driftReport` Json? (nullable JSONB — stores DriftReport)
  - `checkedAt` DateTime @default(now())
  - `createdAt` DateTime @default(now())
  - `updatedAt` DateTime @updatedAt
  - Relation: emissionTarget (EmissionTarget)
  - Relation: deployedVersion (EntityVersion, optional)
  - Index on (emissionTargetId, environment)
  - Unique constraint on (emissionTargetId, environment) — one tracking record per target+environment
- [ ] Add `DRIFT_ALERT` to notification type enum/constants (in `src/types/schemas/notification.ts` or equivalent)
- [ ] Run `npx prisma migrate dev` to generate and apply migration

### Backend — Drift Comparison Engine
- [ ] Create `src/lib/drift/drift-comparator.ts`:
  - Define `NormalizedField` type: `{ name: string, type: string, nullable: boolean, description?: string, fieldNumber?: number }`
  - Implement `normalizeFieldList(parsedFields: ParsedField[]): NormalizedField[]` — converts parsed fields to a normalized comparable format, sorting by name for consistent comparison
  - Implement `compareFieldLists(logical: NormalizedField[], implementation: NormalizedField[]): DriftDifference[]`:
    - Find fields in logical but not in implementation → `type: "added"`
    - Find fields in implementation but not in logical → `type: "removed"`
    - Find fields in both with different types → `type: "type-mismatch"` with `logicalValue` and `implementationValue`
    - Find fields in both with different nullability/description → `type: "metadata-mismatch"`
    - Return empty array if all fields match (in-sync)
  - Implement `determineDriftStatus(differences: DriftDifference[]): "in-sync" | "drifted" | "unknown"`:
    - No differences → "in-sync"
    - Any differences → "drifted"
    - Parse failure → "unknown"

### Backend — Drift Service
- [ ] Create `src/services/drift.service.ts`
- [ ] Implement `detectDrift(entityId, ctx): Result<DriftReport>`:
  - Fetch entity with emission targets and metadata from database
  - Check if entity has `importedFrom` metadata — if not, return "unknown" status for all targets
  - Parse the registered implementation content using the appropriate importer (from `importedFrom.format`)
  - For each emission target with `emittedOutput`:
    - Parse the emitted output using the appropriate importer (detect format from target type)
    - Normalize both field lists
    - Compare and generate `DriftDifference[]`
    - Determine drift status
  - Build `DriftReport`: `{ entityId, entityName, targets: [...] }`
  - Store/update the drift report in `deployment_tracking` table (upsert by emissionTargetId + environment)
  - If drift is detected, create a DRIFT_ALERT notification for the entity owner
  - Wrap in `withAudit()`
  - Return `Result<DriftReport>`
- [ ] Implement `detectDriftForAll(ctx): Result<DriftReport[]>`:
  - Fetch all entities that have `importedFrom` metadata
  - Call `detectDrift()` for each entity
  - Collect and return all drift reports
  - Wrap in `withAudit()`
- [ ] Implement `getDriftStatus(entityId, ctx): Result<DriftReport | null>`:
  - Fetch the most recent drift report from `deployment_tracking` for the entity
  - Return null if no drift check has been performed
  - Does not re-run drift detection — returns cached result
- [ ] Implement `getDriftStatusBulk(entityIds, ctx): Result<Map<string, DriftReport>>`:
  - Fetch drift reports for multiple entities in a single query
  - Used by sidebar and deployment overview for efficient batch loading

### Backend — oRPC Router
- [ ] Create `src/server/api/routers/drift.ts` oRPC router
- [ ] Add `drift.detect` mutation — thin wrapper calling `driftService.detectDrift()`, accepts `{ entityId: string }`, requires Author role via `protectedProcedure`
- [ ] Add `drift.detectAll` mutation — thin wrapper calling `driftService.detectDriftForAll()`, requires Admin role via `adminProcedure`
- [ ] Add `drift.getStatus` query — thin wrapper calling `driftService.getDriftStatus()`, accepts `{ entityId: string }`, requires Viewer role via `protectedProcedure`
- [ ] Add `drift.getStatusBulk` query — thin wrapper calling `driftService.getDriftStatusBulk()`, accepts `{ entityIds: string[] }`, requires Viewer role via `protectedProcedure`
- [ ] Wire router into `appRouter`

### Backend — REST API Endpoint
- [ ] Create `src/app/api/v1/schemas/[id]/drift/route.ts`:
  - POST handler: calls `driftService.detectDrift(id, ctx)` — triggers drift detection
  - GET handler: calls `driftService.getDriftStatus(id, ctx)` — returns cached drift report
  - Auth: require valid API key or session (consistent with existing REST API auth pattern)
  - Return JSON response with drift report

### Backend — Zod Schemas
- [ ] Create `src/types/schemas/drift.ts`:
  - `DriftDifferenceSchema` — z.object({ fieldName, type: z.enum(["added", "removed", "type-mismatch", "metadata-mismatch"]), logicalValue: z.string().nullable(), implementationValue: z.string().nullable() })
  - `DriftTargetStatusSchema` — z.object({ targetFormat: z.string(), driftStatus: z.enum(["in-sync", "drifted", "unknown"]), differences: z.array(DriftDifferenceSchema) })
  - `DriftReportSchema` — z.object({ entityId: z.string(), entityName: z.string(), targets: z.array(DriftTargetStatusSchema) })
  - `DeploymentTrackingStatusSchema` — z.enum(["DEPLOYED", "STAGED", "DRIFTED", "UNKNOWN"])
  - `DetectDriftInput` — z.object({ entityId: z.string().cuid() })
  - `DetectDriftBulkInput` — z.object({ entityIds: z.array(z.string().cuid()) })

### Backend — Notification Integration
- [ ] Modify `src/services/drift.service.ts` — when drift is detected:
  - Create a DRIFT_ALERT notification via notification service
  - Notification recipient: entity owner (from `entities.owner`)
  - Notification title: "Drift detected: {entityName}"
  - Notification body: summary of differences (e.g., "3 field differences found across 2 targets")
  - Entity reference: link to the entity
- [ ] If webhook service exists (Story 7.3), dispatch `drift.detected` webhook event with drift report data

### Frontend — UI Components
- [ ] Create `src/components/custom/DriftBadge/DriftBadge.tsx`:
  - Visual badge showing drift status per target
  - Props: `status: "in-sync" | "drifted" | "unknown"`, `targetFormat?: string`
  - "in-sync": green badge with checkmark
  - "drifted": amber badge with warning icon
  - "unknown": gray badge with question mark
  - Tooltip with target format name and last checked time
- [ ] Create `src/components/custom/DriftPanel/DriftPanel.tsx`:
  - New tab content for the Right Panel — "Deployment" tab
  - Displays per-target drift status in a list
  - Each target row: format icon, target name, drift status badge, last checked timestamp
  - "Check Drift" button per target — calls `drift.detect` mutation for the entity
  - Expandable section per target showing diff details when drifted
- [ ] Create `src/components/custom/DriftPanel/DriftDiffView.tsx`:
  - Expandable diff view showing individual field differences
  - Table with columns: Field Name, Difference Type, Logical Value, Implementation Value
  - Color-coded rows: green for added, red for removed, amber for type-mismatch/metadata-mismatch
  - Clear visual distinction between "in logical but not implementation" vs "in implementation but not logical"
- [ ] Modify sidebar entity list component (`src/components/layout/Sidebar.tsx` or `src/features/schema-editor/`):
  - Fetch drift status for visible entities via `drift.getStatusBulk` query
  - Display amber dot next to entity name if any target has `driftStatus: "drifted"`
  - No dot if all targets are "in-sync" or no drift check performed
- [ ] Modify entity header component:
  - Display "Drift" badge in entity header area
  - Badge shows aggregate drift status across all targets
  - Clicking badge scrolls to / opens the Deployment tab in Right Panel
- [ ] Add "Deployment" tab to Right Panel:
  - New tab alongside existing tabs (Properties, Emission, etc.)
  - Tab content renders `DriftPanel` component
  - Tab icon shows amber indicator if drift is detected
- [ ] Create `src/hooks/useDrift.ts`:
  - Hook wrapping oRPC queries/mutations for drift operations
  - Provides: `driftStatus` (cached), `detectDrift` (mutation), `isChecking` (loading state)
  - Auto-refetch drift status after successful detection

### Testing
- [ ] **Unit tests** (`tests/unit/lib/drift/drift-comparator.test.ts`):
  - Two identical field lists produce no differences (in-sync)
  - Field in logical but not implementation → "added" difference
  - Field in implementation but not logical → "removed" difference
  - Same field name with different types → "type-mismatch" with both values
  - Same field name with different nullability → "metadata-mismatch"
  - Multiple differences across multiple fields
  - Empty field lists produce no differences
  - determineDriftStatus returns "in-sync" for empty differences
  - determineDriftStatus returns "drifted" for non-empty differences
- [ ] **Unit tests** (`tests/unit/services/drift.service.test.ts`):
  - detectDrift returns "unknown" for entity without importedFrom metadata
  - detectDrift parses imported content and emitted output correctly
  - detectDrift stores drift report in deployment_tracking table
  - detectDrift creates DRIFT_ALERT notification when drift detected
  - detectDrift does NOT create notification when in-sync
  - detectDriftForAll processes all entities with importedFrom
  - getDriftStatus returns cached drift report
  - getDriftStatus returns null for unchecked entity
  - getDriftStatusBulk returns map of drift reports
  - RBAC: Author required for detect, Viewer sufficient for getStatus
- [ ] **Integration test** (`tests/integration/drift-detection.test.ts`):
  - Import a schema (Avro) → entity created with importedFrom metadata
  - Modify entity fields (add/remove/change type)
  - Emit the entity to Avro target
  - Run drift detection → drift report shows differences
  - Verify deployment_tracking record created with correct status
  - Verify DRIFT_ALERT notification created for entity owner
- [ ] **E2E test** (`tests/e2e/drift-detection.spec.ts`):
  - Import an Avro schema via import dialog
  - Modify entity (change a field type)
  - Click "Check Drift" in Deployment tab
  - Drift badge appears in entity header (amber)
  - Sidebar shows amber dot next to entity name
  - Expand drift details — field difference is shown correctly

## Dev Notes

### Architecture & Patterns
- **Service layer pattern**: `src/services/drift.service.ts` owns all drift detection business logic. oRPC router and REST endpoint are thin wrappers.
- **Result type**: All service functions return `Result<T, ServiceError>`. Parse failures return error Results with descriptive messages, never throw.
- **withAudit()**: Drift detection operations (detect, detectAll) are logged to `audit_log` with before/after drift status.
- **Reuses import parsers**: The drift comparator reuses the same parser functions from `src/lib/importers/` (Story 9.1) to normalize both the emitted output and the registered implementation into comparable field lists. This ensures consistency — the same parsing logic is used for import and drift detection.
- **Upsert pattern**: `deployment_tracking` records are upserted by (emissionTargetId, environment) — running drift detection again updates the existing record rather than creating duplicates.
- **Notification integration**: Drift detection creates DRIFT_ALERT notifications using the existing notification service (Epic 7). If webhook infrastructure exists (Story 7.3), it also dispatches `drift.detected` webhook events.
- **RBAC**: Author role required to trigger drift detection (write operation). Viewer role sufficient to read drift status (read-only). Admin role required for detectAll (system-wide operation). Enforced via `protectedProcedure` and `adminProcedure` in oRPC middleware.
- **Caching**: `getDriftStatus` returns the most recent stored drift report without re-running detection. Detection is always on-demand — no background polling for MVP.

### UX/Design Requirements
- Drift badges follow the same color system as confidence badges from Story 9.1: green (in-sync), amber (drifted), gray (unknown)
- "Check Drift" button uses the existing Shadcn Button component with loading spinner during detection
- Drift diff view uses a simple table layout — not a full diff editor. Color-coded rows for quick scanning.
- Sidebar amber dot is small (6px) and positioned to the right of the entity name — does not shift layout
- Deployment tab in Right Panel follows the same tab pattern as existing tabs (Properties, Emission, etc.)

### File Structure
```
src/lib/drift/drift-comparator.ts                     # Field comparison + diff engine
src/services/drift.service.ts                          # Drift detection orchestration
src/types/schemas/drift.ts                             # Zod schemas — DriftReport, DriftDifference, etc.
src/server/api/routers/drift.ts                        # oRPC router (Author+ for detect, Viewer+ for read)
src/app/api/v1/schemas/[id]/drift/route.ts             # REST API endpoint for CI/CD integration
src/components/custom/DriftBadge/DriftBadge.tsx         # Drift status badge (green/amber/gray)
src/components/custom/DriftPanel/DriftPanel.tsx         # Right Panel Deployment tab content
src/components/custom/DriftPanel/DriftDiffView.tsx      # Expandable field diff view
src/components/custom/DriftPanel/index.ts               # Re-exports
src/hooks/useDrift.ts                                   # React hook for drift state + mutations
prisma/schema.prisma                                    # Extended — deployment_tracking table
src/types/schemas/notification.ts                       # Modified — add DRIFT_ALERT type
```

### Testing Requirements
- **Unit tests** (`tests/unit/lib/drift/drift-comparator.test.ts`): Comparison engine — field matching, difference detection, status categorization
- **Unit tests** (`tests/unit/services/drift.service.test.ts`): Service orchestration — parser routing, report storage, notification creation, RBAC
- **Integration test** (`tests/integration/drift-detection.test.ts`): Full flow — import → modify → emit → detect drift → verify report + notification
- **E2E test** (`tests/e2e/drift-detection.spec.ts`): UI flow — import → modify → check drift → badges appear → diff details visible

### Dependencies & Prerequisites
- Story 9.1 (Schema Import) complete — import parsers exist in `src/lib/importers/`
- Epic 3 (Emission Pipeline) complete — emission targets with `emittedOutput` exist
- Epic 7, Story 7.1 (Notification System) complete — notification service exists for DRIFT_ALERT
- Entity metadata includes `importedFrom` field (from Story 9.1)
- Right Panel component exists with tab infrastructure

### References
- Architecture: `_bmad-output/planning-artifacts/architecture.md` — Service Layer Pattern, Data Architecture (deployment_tracking table), Module Boundaries
- Epics: `_bmad-output/planning-artifacts/epics.md` — Epic 9, Story 9.2
- PRD: FR24 (Drift Detection), FR35-FR37 (Deployment Tracking)
- Story 9.1: `_bmad-output/implementation-artifacts/9-1-schema-import-bulk-import.md` — Import parsers reused for drift comparison

## Dev Agent Record
### Agent Model Used
### Completion Notes List
### Change Log

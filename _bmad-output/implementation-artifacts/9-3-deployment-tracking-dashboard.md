# Story 9.3: Deployment Tracking Dashboard

Status: ready-for-dev

## Story
As a **data engineer**, I want to see which schema versions are deployed to which systems with drift status, so that I have a single view of schema state across all target systems.

## Acceptance Criteria

**Given** drift detection exists (Story 9.2 complete)
**When** the deployment tracking dashboard is implemented
**Then** the **entity editor** includes a "Deployment" tab in the Right Panel showing per-target deployment status
**And** each target row shows: target format icon + name, currently emitted version (e.g., "v3"), deployed version (e.g., "v2" if tracking is available, or "Unknown" if not tracked), drift status badge (In Sync/Drifted/Unknown), last checked timestamp
**And** a **"Check Drift"** button per target runs drift detection for that specific target and updates the status
**And** a **"Mark as Deployed"** button per target allows the user to manually mark a version as deployed to a target/environment — this is a manual tracking mechanism for MVP (automated deployment detection deferred to Phase 2)
**And** the **"Mark as Deployed"** dialog asks for: environment name (dropdown or text: "production", "staging", "development"), and confirms the version being marked
**And** the deployment status is tracked in the `deployment_tracking` table with the environment and version
**And** the **Status Bar** shows a compact deployment summary for the current entity: "Emitted: v3 | Deployed: BigQuery v3 ✓, Avro v2 ⚠️" — green check for in-sync, amber warning for version mismatch or drift
**And** a **system-wide deployment overview** is accessible from the Activity Bar → a new "Deployments" section under Schema Editor — this shows a DataTable of all entities with columns: Entity, Domain, Current Version, and per-target columns showing deployed version + drift status (color-coded)
**And** the deployment overview DataTable is sortable and filterable: filter by domain, drift status, target
**And** unit tests verify: marking a version as deployed updates tracking, drift status reflects correct version comparison, deployment overview shows all entities with correct status
**And** a Playwright E2E test verifies: entity Deployment tab shows per-target status, marking as deployed updates the display, Check Drift updates drift status, deployment overview shows system-wide status

## Tasks / Subtasks

### Database — Prisma Schema
- [ ] Verify `deployment_tracking` table exists from Story 9.2 with all required fields:
  - `id`, `emissionTargetId`, `environment`, `status`, `deployedVersionId`, `driftReport`, `checkedAt`, `createdAt`, `updatedAt`
- [ ] Add `markedDeployedAt` DateTime? (nullable) to `deployment_tracking` table — timestamp when user manually marked as deployed
- [ ] Add `markedDeployedBy` String? (nullable FK to users) to `deployment_tracking` table — user who marked as deployed
- [ ] Run `npx prisma migrate dev` to generate and apply migration

### Backend — Deployment Tracking Service
- [ ] Create `src/services/deployment.service.ts`
- [ ] Implement `markAsDeployed(input, ctx): Result<DeploymentTracking>`:
  - Input: `{ emissionTargetId: string, environment: string, versionId: string }`
  - Validate that the emission target exists and belongs to the user's accessible entities
  - Validate that the version exists (FK to entity_versions)
  - Upsert `deployment_tracking` record: set `status: "DEPLOYED"`, `deployedVersionId`, `markedDeployedAt: now()`, `markedDeployedBy: ctx.userId`
  - If the deployed version differs from the currently emitted version, set status to "STAGED" (version mismatch, not yet drifted)
  - RBAC: require Author role on the entity's domain
  - Wrap in `withAudit()`
- [ ] Implement `getDeploymentStatus(entityId, ctx): Result<DeploymentStatus[]>`:
  - Fetch all emission targets for the entity
  - For each target, fetch all deployment_tracking records (one per environment)
  - Join with entity_versions to get version numbers
  - Join with drift report data (from Story 9.2)
  - Return `DeploymentStatus[]`: `{ targetFormat, targetId, emittedVersion, environments: [{ name, deployedVersion, status, driftStatus, lastChecked }] }`
  - RBAC: require Viewer role
- [ ] Implement `getDeploymentOverview(filters, ctx): Result<DeploymentOverviewRow[]>`:
  - Fetch all entities with their emission targets and deployment tracking records
  - Apply filters: domain, driftStatus, targetFormat
  - Return `DeploymentOverviewRow[]`: `{ entityId, entityName, domain, currentVersion, targets: [{ format, deployedVersion, driftStatus }] }`
  - Support pagination (offset + limit)
  - RBAC: require Viewer role
- [ ] Implement `unmarkDeployment(emissionTargetId, environment, ctx): Result<void>`:
  - Remove the deployment tracking record (or set status to "UNKNOWN")
  - RBAC: require Author role
  - Wrap in `withAudit()`

### Backend — oRPC Router
- [ ] Create `src/server/api/routers/deployment.ts` oRPC router
- [ ] Add `deployment.markAsDeployed` mutation — thin wrapper calling `deploymentService.markAsDeployed()`, accepts `{ emissionTargetId: string, environment: string, versionId: string }`, requires Author role via `protectedProcedure`
- [ ] Add `deployment.getStatus` query — thin wrapper calling `deploymentService.getDeploymentStatus()`, accepts `{ entityId: string }`, requires Viewer role via `protectedProcedure`
- [ ] Add `deployment.getOverview` query — thin wrapper calling `deploymentService.getDeploymentOverview()`, accepts `{ filters?: { domain?: string, driftStatus?: string, targetFormat?: string }, offset?: number, limit?: number }`, requires Viewer role via `protectedProcedure`
- [ ] Add `deployment.unmark` mutation — thin wrapper calling `deploymentService.unmarkDeployment()`, accepts `{ emissionTargetId: string, environment: string }`, requires Author role via `protectedProcedure`
- [ ] Wire router into `appRouter`

### Backend — Zod Schemas
- [ ] Create `src/types/schemas/deployment.ts`:
  - `MarkAsDeployedInput` — z.object({ emissionTargetId: z.string().cuid(), environment: z.string().min(1), versionId: z.string().cuid() })
  - `GetDeploymentStatusInput` — z.object({ entityId: z.string().cuid() })
  - `DeploymentOverviewFilters` — z.object({ domain: z.string().optional(), driftStatus: z.enum(["in-sync", "drifted", "unknown"]).optional(), targetFormat: z.string().optional() })
  - `GetDeploymentOverviewInput` — z.object({ filters: DeploymentOverviewFilters.optional(), offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(100).default(25) })
  - `UnmarkDeploymentInput` — z.object({ emissionTargetId: z.string().cuid(), environment: z.string().min(1) })
  - `EnvironmentSchema` — z.enum(["production", "staging", "development"]).or(z.string().min(1)) — allows predefined + custom environments
  - `DeploymentStatusSchema` — Zod schema for the DeploymentStatus response type
  - `DeploymentOverviewRowSchema` — Zod schema for the DeploymentOverviewRow response type

### Frontend — Deployment Tab (Right Panel)
- [ ] Enhance `src/components/custom/DriftPanel/DriftPanel.tsx` (created in Story 9.2):
  - Rename component/file to `DeploymentPanel` if appropriate, or extend existing panel
  - Add per-target deployment information: emitted version, deployed version, environment
  - Each target row now shows: format icon + name, emitted version badge (e.g., "v3"), deployed version badge (e.g., "v2" or "Unknown"), drift status badge (from Story 9.2), last checked timestamp
  - Add **"Mark as Deployed"** button per target row — opens MarkAsDeployedDialog
  - Add **"Check Drift"** button per target row (from Story 9.2) — triggers drift detection
  - Multiple environments per target: if a target is deployed to multiple environments, show sub-rows for each environment
- [ ] Create `src/components/custom/DeploymentPanel/MarkAsDeployedDialog.tsx`:
  - Modal dialog for marking a version as deployed
  - Environment selector: dropdown with predefined options ("production", "staging", "development") + custom text input
  - Version confirmation: displays the version being marked (e.g., "v3 — emitted at 2024-01-15")
  - "Confirm" button — calls `deployment.markAsDeployed` mutation
  - "Cancel" button — closes dialog
  - Success toast: "Marked {entityName} as deployed to {environment}"
- [ ] Create `src/components/custom/DeploymentPanel/VersionBadge.tsx`:
  - Compact version display badge (e.g., "v3")
  - Color-coded: green if deployed version matches emitted version, amber if version mismatch
  - "Unknown" variant: gray badge when no deployment tracking exists

### Frontend — Status Bar Integration
- [ ] Modify Status Bar component (`src/components/layout/StatusBar.tsx`):
  - Add deployment summary section for the currently selected entity
  - Format: "Emitted: v3 | Deployed: BigQuery v3 ✓, Avro v2 ⚠️"
  - Green checkmark (✓) for in-sync targets
  - Amber warning (⚠️) for drifted or version-mismatched targets
  - Fetch deployment status via `deployment.getStatus` query using the current entity ID
  - Only show when an entity is selected
  - Compact format — truncate if more than 3 targets (show count)

### Frontend — System-Wide Deployment Overview
- [ ] Create `src/app/(dashboard)/deployments/page.tsx`:
  - New page accessible from Activity Bar → "Deployments" section
  - Page title: "Deployment Overview"
  - DataTable component showing all entities with deployment status
- [ ] Create `src/components/custom/DeploymentOverview/DeploymentOverviewTable.tsx`:
  - DataTable (using Shadcn DataTable pattern) with columns:
    - Entity (name, clickable link to entity editor)
    - Domain (entity's domain name)
    - Current Version (latest version number)
    - Per-target columns (one column per unique target format across all entities): deployed version + drift status badge
  - Color-coded cells: green background for in-sync, amber for drifted, gray for unknown/untracked
  - Sortable columns: entity name, domain, current version, drift status
  - Header row with target format icons
- [ ] Create `src/components/custom/DeploymentOverview/DeploymentOverviewFilters.tsx`:
  - Filter bar above the DataTable
  - Domain filter: dropdown of all domains
  - Drift status filter: dropdown ("All", "In Sync", "Drifted", "Unknown")
  - Target format filter: dropdown of all target formats ("BigQuery", "Avro", "Protobuf", etc.)
  - Filters update URL query params for shareability
  - Clear filters button
- [ ] Create `src/components/custom/DeploymentOverview/index.ts`:
  - Re-exports for DeploymentOverviewTable and DeploymentOverviewFilters
- [ ] Add "Deployments" entry to Activity Bar (`src/components/layout/ActivityBar.tsx`):
  - New icon (deployment/rocket icon) in the Activity Bar
  - Position: below Schema Editor section
  - Links to `/deployments` page
  - Badge showing count of drifted entities (if any)

### Frontend — Hooks
- [ ] Create `src/hooks/useDeployment.ts`:
  - Hook wrapping oRPC queries/mutations for deployment operations
  - Provides: `deploymentStatus` (query for current entity), `markAsDeployed` (mutation), `unmarkDeployment` (mutation), `isMarking` (loading state)
  - Auto-refetch deployment status after successful mark/unmark
- [ ] Create `src/hooks/useDeploymentOverview.ts`:
  - Hook wrapping oRPC query for deployment overview
  - Provides: `overview` (paginated query result), `filters` (current filter state), `setFilters`, `isLoading`
  - Supports pagination: `fetchNextPage`, `hasNextPage`

### Testing
- [ ] **Unit tests** (`tests/unit/services/deployment.service.test.ts`):
  - markAsDeployed creates deployment_tracking record with correct status and version
  - markAsDeployed upserts — updating existing record for same target+environment
  - markAsDeployed sets status to "STAGED" when deployed version differs from emitted version
  - markAsDeployed sets status to "DEPLOYED" when deployed version matches emitted version
  - markAsDeployed rejects users without Author role
  - getDeploymentStatus returns all targets with environment details
  - getDeploymentStatus returns "Unknown" for targets without tracking
  - getDeploymentOverview returns all entities with correct deployment data
  - getDeploymentOverview applies domain filter correctly
  - getDeploymentOverview applies driftStatus filter correctly
  - getDeploymentOverview applies targetFormat filter correctly
  - getDeploymentOverview supports pagination (offset + limit)
  - unmarkDeployment removes tracking record
  - unmarkDeployment rejects users without Author role
  - All write operations logged via withAudit()
- [ ] **Integration test** (`tests/integration/deployment-tracking.test.ts`):
  - Create entity with emission targets
  - Emit to a target (creates emittedOutput)
  - Mark as deployed to "production" environment
  - Verify deployment_tracking record created with correct data
  - Run drift detection — verify status reflects accurate comparison
  - Mark different version as deployed — verify status updates
  - Query deployment overview — verify entity appears with correct data
- [ ] **E2E test** (`tests/e2e/deployment-tracking.spec.ts`):
  - Navigate to entity Deployment tab in Right Panel
  - Verify per-target status rows are displayed
  - Click "Mark as Deployed" on a target → select "production" environment → confirm
  - Verify deployed version badge updates to show the marked version
  - Click "Check Drift" on a target → verify drift status updates
  - Navigate to Deployment Overview page via Activity Bar
  - Verify DataTable shows all entities with deployment columns
  - Apply domain filter → verify table updates
  - Apply drift status filter → verify table updates
  - Verify Status Bar shows compact deployment summary for selected entity

## Dev Notes

### Architecture & Patterns
- **Service layer pattern**: `src/services/deployment.service.ts` owns all deployment tracking business logic. oRPC router is a thin wrapper.
- **Result type**: All service functions return `Result<T, ServiceError>`. Never throw.
- **withAudit()**: All deployment write operations (markAsDeployed, unmarkDeployment) are logged to `audit_log`.
- **Upsert pattern**: Deployment tracking records are upserted by (emissionTargetId, environment). Marking the same target+environment again updates the existing record.
- **RBAC**: Author role required for write operations (mark/unmark). Viewer role sufficient for read operations (getStatus, getOverview). Enforced via `protectedProcedure` in oRPC middleware.
- **Manual tracking for MVP**: Deployment marking is manual — users click "Mark as Deployed" to record what is deployed where. Automated deployment detection (CI/CD integration, API-driven marking) is deferred to Phase 2.
- **Status determination**: "DEPLOYED" = deployed version matches emitted version. "STAGED" = version marked but differs from current emission. "DRIFTED" = drift detection found field differences (from Story 9.2). "UNKNOWN" = no tracking data.
- **Builds on Story 9.2**: This story enhances the DriftPanel from Story 9.2 with deployment tracking UI. The `deployment_tracking` table was created in Story 9.2 — this story adds columns and builds the full dashboard experience.

### UX/Design Requirements
- Deployment tab in Right Panel follows existing tab pattern — this story adds deployment-specific content around the drift status from Story 9.2
- "Mark as Deployed" dialog is a simple modal (Shadcn Dialog) — not a multi-step wizard
- Environment selector uses Shadcn Select with creatable option for custom environment names
- Version badges are compact (e.g., "v3") with color coding — green for matched, amber for mismatched
- Status Bar deployment summary is compact text — fits in the existing status bar layout without expanding it
- Deployment Overview page uses the same DataTable component pattern as other list views in the app (Compliance, Governance, etc.)
- Color-coded cells in the overview table use subtle background colors (not bold fills) — consistent with the hex-inspired dark theme
- Activity Bar "Deployments" icon uses a deployment/ship/rocket metaphor — consistent with other Activity Bar icons

### File Structure
```
src/services/deployment.service.ts                             # Deployment tracking CRUD + overview queries
src/types/schemas/deployment.ts                                # Zod schemas — MarkAsDeployedInput, DeploymentStatus, etc.
src/server/api/routers/deployment.ts                           # oRPC router (Author+ for write, Viewer+ for read)
src/components/custom/DeploymentPanel/MarkAsDeployedDialog.tsx  # Mark as deployed modal
src/components/custom/DeploymentPanel/VersionBadge.tsx          # Version display badge (green/amber/gray)
src/components/custom/DeploymentPanel/DriftPanel.tsx            # Enhanced — deployment info added to drift panel
src/components/custom/DeploymentPanel/index.ts                  # Re-exports
src/components/custom/DeploymentOverview/DeploymentOverviewTable.tsx    # System-wide DataTable
src/components/custom/DeploymentOverview/DeploymentOverviewFilters.tsx  # Filter bar
src/components/custom/DeploymentOverview/index.ts               # Re-exports
src/app/(dashboard)/deployments/page.tsx                        # Deployment overview page
src/hooks/useDeployment.ts                                      # React hook for deployment status + mutations
src/hooks/useDeploymentOverview.ts                              # React hook for overview DataTable
src/components/layout/StatusBar.tsx                             # Modified — add deployment summary
src/components/layout/ActivityBar.tsx                           # Modified — add Deployments entry
prisma/schema.prisma                                            # Modified — add columns to deployment_tracking
```

### Testing Requirements
- **Unit tests** (`tests/unit/services/deployment.service.test.ts`): Service logic — marking, status determination, overview queries, filtering, RBAC, audit
- **Integration test** (`tests/integration/deployment-tracking.test.ts`): Full flow — emit → mark deployed → drift check → overview query
- **E2E test** (`tests/e2e/deployment-tracking.spec.ts`): UI flow — Deployment tab, mark deployed dialog, drift check, overview page, filters, status bar

### Dependencies & Prerequisites
- Story 9.2 (Drift Detection Engine) complete — drift service, deployment_tracking table, DriftPanel component exist
- Story 9.1 (Schema Import) complete — import parsers and importedFrom metadata exist
- Epic 3 (Emission Pipeline) complete — emission targets with emittedOutput exist
- Epic 4 (Versioning) complete — entity_versions table exists for version references
- Epic 7, Story 7.1 (Notification System) complete — notification service exists
- Right Panel component exists with tab infrastructure
- Activity Bar component exists with section pattern
- Status Bar component exists
- Shadcn DataTable, Dialog, Select, Badge components available

### References
- Architecture: `_bmad-output/planning-artifacts/architecture.md` — Service Layer Pattern, Data Architecture (deployment_tracking table), Frontend Architecture (Status Bar, Activity Bar, Right Panel)
- UX Spec: `_bmad-output/planning-artifacts/ux-design-specification.md` — Right Panel tabs, Status Bar layout, Activity Bar sections
- Epics: `_bmad-output/planning-artifacts/epics.md` — Epic 9, Story 9.3
- PRD: FR35-FR37 (Deployment Tracking)
- Story 9.2: `_bmad-output/implementation-artifacts/9-2-drift-detection-engine.md` — Drift service and DriftPanel base
- Story 9.1: `_bmad-output/implementation-artifacts/9-1-schema-import-bulk-import.md` — Import parsers and metadata

## Dev Agent Record
### Agent Model Used
### Completion Notes List
### Change Log

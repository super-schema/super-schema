# Story 5.4: Per-Target Staged Emission

Status: ready-for-dev

## Story
As a **data steward**, I want to emit a schema change to some targets while holding others pending approval or readiness, so that I can stage deployments progressively without blocking all targets.

## Acceptance Criteria

**Given** governance and impact reports work (Stories 5.2-5.3 complete)
**When** per-target staged emission is implemented
**Then** the **Emit dialog** (triggered by clicking Emit on an entity with a breaking change) shows a **per-target checklist** instead of emitting to all targets at once
**And** the checklist shows each enabled target with: target name, compatibility status (badge), migration complexity, and a checkbox to include/exclude from this emission batch
**And** targets that are **non-breaking compatible** are pre-checked by default; targets that are **breaking** are unchecked with an amber warning
**And** the user can check/uncheck individual targets — clicking "Emit Selected" emits only to the checked targets
**And** the `emission_targets` table tracks per-target emission status: targets that were emitted in this batch get updated with the new output and `lastEmittedAt`; targets that were held keep their previous emitted output
**And** the entity's **deployment tracking** (Status Bar and entity header) shows a per-target status: "v3 emitted" (green), "v2 current, v3 staged" (amber), helping the user see which targets have the latest version
**And** a **"Stage for Later"** option allows the user to mark a target for deferred emission — this creates a record indicating the target is awaiting readiness, and the governance request remains open for that target
**And** when a staged target is later ready, the user can return to the Emit dialog and emit to the remaining targets — the emission uses the same version snapshot (not the current entity state, which may have changed further)
**And** unit tests verify: partial emission only writes to selected targets, unselected targets retain previous output, staged emission stores the version snapshot for later use, emitting staged targets uses the correct snapshot
**And** a Playwright E2E test verifies: breaking change → Emit shows per-target checklist → unchecking one target → emitting → checked targets show v3 → unchecked target shows v2 → returning later and emitting the remaining target

## Tasks / Subtasks

### Emit Dialog — Per-Target Checklist
- [ ] Create `src/features/emission/StagedEmitDialog/StagedEmitDialog.tsx` — modal dialog with per-target checklist
- [ ] Display each enabled target as a row with: checkbox, target name, compatibility status badge, migration complexity badge
- [ ] Pre-check targets that are non-breaking compatible; uncheck targets that are breaking with amber warning indicator
- [ ] Add "Emit Selected" button (primary) — emits only to checked targets
- [ ] Add "Stage for Later" option per unchecked target — marks for deferred emission
- [ ] Add "Cancel" button (ghost)

### Emit Dialog Trigger Logic
- [ ] Update Emit button behavior: when a breaking change exists (governance approved), clicking Emit opens the StagedEmitDialog instead of emitting to all targets
- [ ] For non-breaking changes, emit to all targets directly (existing behavior, no dialog needed)
- [ ] Pass impact report per-target data to the dialog for compatibility/complexity display

### Partial Emission Service
- [ ] Update emission service to support target selection: `emitToTargets(entityId, versionId, targetIds: string[], ctx): Result<EmissionResult[]>`
- [ ] For each selected target: run emitter, validate output, update `emission_targets` row with new output and `lastEmittedAt`
- [ ] For unselected targets: do not modify their `emission_targets` rows — they retain previous output
- [ ] Wrap with `withAudit()` — record which targets were emitted

### Staged Emission Records
- [ ] Create a mechanism to track staged/deferred targets: add `staged_version_id` column to `emission_targets` (or create a `staged_emissions` table)
- [ ] When "Stage for Later" is selected for a target: store the version_id snapshot reference so the correct version is used when eventually emitted
- [ ] Keep governance request open for staged targets (partial approval tracking)

### Snapshot-Based Deferred Emission
- [ ] When emitting a previously staged target: retrieve the version snapshot from `entity_versions` using the stored `staged_version_id`
- [ ] Emit using that snapshot's state, NOT the current entity state (which may have changed)
- [ ] After emission, clear the staged marker and update `emission_targets` with new output

### Per-Target Status Display
- [ ] Update entity header to show per-target emission status indicators
- [ ] Update Status Bar to show per-target version status
- [ ] Status states:
  - "v3 emitted" (green) — target has the latest version
  - "v2 current, v3 staged" (amber) — target is behind, new version staged for later
  - "v1 current" (muted) — target is behind, no staged version

### Deployment Tracking Integration
- [ ] Update `deployment_tracking` queries to reflect per-target version differences
- [ ] Entity detail view shows which targets are at which version

### Emit Dialog — Return for Remaining Targets
- [ ] When returning to an entity with staged targets: Emit button shows "Emit Staged (X targets)" with a count
- [ ] Clicking opens the StagedEmitDialog showing only the staged targets (pre-checked)
- [ ] Emitting staged targets uses the stored snapshot version

### oRPC Router Updates
- [ ] Add `emission.emitToTargets` mutation — input: entityId, versionId, targetIds[]
- [ ] Add `emission.getStagedTargets` query — returns targets with staged versions for an entity
- [ ] Add `emission.emitStagedTarget` mutation — emits a staged target using its snapshot

### Testing
- [ ] Unit test: partial emission only writes to selected targets
- [ ] Unit test: unselected targets retain their previous emitted output unchanged
- [ ] Unit test: staged emission stores the version snapshot reference correctly
- [ ] Unit test: emitting a staged target uses the correct version snapshot, not current state
- [ ] Unit test: per-target status correctly shows "emitted" vs "staged" vs "behind"
- [ ] Unit test: emitting all staged targets clears staged markers
- [ ] Playwright E2E: breaking change → Emit shows per-target checklist → uncheck one target → emit → checked targets show v3 → unchecked shows v2 → return later → emit remaining target → all show v3

## Dev Notes

### Architecture & Patterns

**Database tables involved:**
```
emission_targets    — id, entity_id, target_type, emitted_output (text), validation_status,
                      validation_details (JSONB), last_emitted_at, version_id
entity_versions     — id, entity_id, version_number, snapshot (JSONB), ...
```

**New column or table for staging:** Consider adding `staged_version_id` (nullable FK to entity_versions) to `emission_targets`. When non-null, it indicates a deferred emission is pending for that target using that version's snapshot. Alternatively, a separate `staged_emissions` junction table could be used.

**Service pattern:** Partial emission extends the existing emission service. The core pattern remains: emitter receives `SuperSchemaModel` (from the intermediate model), generates output, validates, stores. The difference is target selection and snapshot pinning.

**Snapshot pinning:** Critical architectural requirement — staged emissions must use the version snapshot at the time of staging, not the current entity state. This prevents inconsistency where a target gets emitted with a different schema version than what was approved.

**Module boundary:** Per-target staged emission bridges emission and governance modules. The governance module tracks which targets still need approval/emission. The emission module handles the actual emit operations. The staging mechanism links the two via version snapshot references.

**Error handling:** If emission to one target fails, other successful targets should still be recorded. Use individual Result wrapping per target. Surface failures clearly in the UI.

### UX/Design Requirements

**Emit dialog layout:**
- Modal dialog (Shadcn Dialog component)
- Title: "Emit Schema — Select Targets"
- Per-target rows in a list/table format
- Each row: checkbox | target icon + name | compatibility badge | complexity badge
- Non-breaking targets: pre-checked, green status
- Breaking targets: unchecked, amber warning, "Stage for Later" link
- Footer: "Emit Selected" (primary), "Cancel" (ghost)

**Compatibility badges:**
- Compatible: green "Compatible" badge
- Migration required: amber "Migration Required" badge
- Breaking: red "Breaking" badge

**Complexity badges:**
- Trivial: green "Trivial" badge
- Moderate: amber "Moderate" badge
- Complex: red "Complex" badge

**Per-target status in entity header:**
- Use small colored dots or mini badges next to target icons
- Green dot: latest version emitted
- Amber dot: staged, awaiting emission
- Muted dot: behind, no staged version

**Status Bar:** Show aggregated per-target status. e.g., "BQ: v3 | Avro: v2 (staged) | OpenAPI: v3"

**Button patterns:**
- "Emit Selected" — Primary button (Amethyst fill). Only one primary per dialog.
- "Cancel" — Ghost button
- "Stage for Later" — text link or ghost button per target row

### File Structure
```
src/features/emission/StagedEmitDialog/
  ├── StagedEmitDialog.tsx                               — Modal dialog component
  ├── StagedEmitDialog.types.ts                          — Props & types
  ├── useStagedEmitDialog.ts                             — Logic hook (target selection state)
  └── index.ts                                           — Re-export
src/features/emission/TargetStatusIndicator/
  ├── TargetStatusIndicator.tsx                          — Per-target version status display
  └── index.ts                                           — Re-export
src/services/emission.service.ts                         — Update with emitToTargets(), staged logic
src/server/api/routers/emission.ts                       — Add emitToTargets, getStagedTargets mutations
prisma/schema.prisma                                     — Add staged_version_id to emission_targets (or staged_emissions table)
tests/unit/services/emission.service.test.ts             — Add staged emission unit tests
tests/e2e/staged-emission.spec.ts                        — Playwright E2E
```

### Testing Requirements
- **Unit tests (Vitest):** Mock Prisma and emitter services. Test partial emission targeting, snapshot pinning for staged targets, status tracking, staged marker cleanup.
- **E2E tests (Playwright):** Full flow: breaking change → selective emission → verify per-target status → return and emit remaining → verify all targets at latest version.

### Dependencies & Prerequisites
- Story 5.2 complete — governance workflow with approval
- Story 5.3 complete — impact reports with per-target compatibility data
- Story 4.4 complete — migration artifact generator
- Emission service exists (from Epic 3) and supports per-target emission
- `emission_targets` table exists with version tracking
- Entity header and Status Bar components exist and are extensible

### References
- Architecture: `emission_targets` table schema
- Architecture: `entity_versions` snapshot for deferred emission
- Architecture: Service layer pattern, Result type, withAudit()
- Architecture: SuperSchemaModel intermediate model — emitters receive this, not raw DB data
- UX Spec: Button patterns — Primary (Emit Selected), Ghost (Cancel)
- UX Spec: Status Bar pattern (VS Code-inspired)
- FR29: Per-target staged emission

## Dev Agent Record
### Agent Model Used
### Completion Notes List
### Change Log

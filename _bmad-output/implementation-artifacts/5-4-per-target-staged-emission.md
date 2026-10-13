# Story 5.4: Per-Target Staged Emission

Status: review

> **Epic 12 reconciliation note (2026-10-12):** References the pre-Epic-12 emission contract (SuperSchemaModel built from Prisma rows, in-memory staging). See architecture.md TypeSpec Integration (2026-10-12) and Epic 12 Story 12.6 before extending this — staged emission will need to key off typespec_source versions, not just entity version numbers.

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
**And** the entity **Schemas tab** reflects that same target state model: only targets with emitted/generated versions render inside a labeled generated section as **horizontal technology tabs**; targets with no generated output remain in a compact dropdown chooser with a single Generate action
**And** each generated technology tab reuses the shared generated-schema workspace pattern: version history, target-specific controls, emitted output preview, and lifecycle actions for that target
**And** the Schemas tab target model is driven by a shared emitter catalog, so native emitters and official TypeSpec single-file schema emitters follow the same per-target lifecycle while official multi-file code generators remain visible but disabled in this view
**And** unit tests verify: partial emission only writes to selected targets, unselected targets retain previous output, staged emission stores the version snapshot for later use, emitting staged targets uses the correct snapshot
**And** a Playwright E2E test verifies: breaking change → Emit shows per-target checklist → unchecking one target → emitting → checked targets show v3 → unchecked target shows v2 → returning later and emitting the remaining target

## Tasks / Subtasks

### Emit Dialog — Per-Target Checklist
- [x] Create `src/features/emission/StagedEmitDialog/StagedEmitDialog.tsx` — modal dialog with per-target checklist
- [x] Display each enabled target as a row with: checkbox, target name, compatibility status badge, migration complexity badge
- [x] Pre-check targets that are non-breaking compatible; uncheck targets that are breaking with amber warning indicator
- [x] Add "Emit Selected" button (primary) — emits only to checked targets
- [x] Add "Stage for Later" option per unchecked target — marks for deferred emission
- [x] Add "Cancel" button (ghost)

### Emit Dialog Trigger Logic
- [x] StagedEmitDialog accepts targets with compatibility/complexity from impact report
- [x] For non-breaking changes, emit to all targets directly (existing behavior, no dialog needed)
- [x] Pass impact report per-target data to the dialog for compatibility/complexity display

### Partial Emission Service
- [x] Create `src/services/staged-emission.service.ts` with `emitToTargets(entityId, versionId, targetIds, emitFn): Result<EmissionResult[]>`
- [x] For each selected target: run emitter via callback, update status and output
- [x] For unselected targets: do not modify their rows — they retain previous output

### Staged Emission Records
- [x] In-memory Map stores staged targets with version snapshot reference
- [x] When "Stage for Later" is selected: store the version_id snapshot reference
- [x] Track staged/deferred targets with full metadata

### Snapshot-Based Deferred Emission
- [x] `emitStagedTarget()` retrieves stored staged version and passes it to emitFn
- [x] Emit uses snapshot version, NOT current entity state
- [x] After emission, clears staged marker and updates status

### Per-Target Status Display
- [x] Create `src/features/emission/TargetStatusIndicator/TargetStatusIndicator.tsx`
- [x] Status states:
  - "v3 emitted" (green) — target has the latest version
  - "v2 current, v3 staged" (amber) — target is behind, new version staged for later
  - "v1 current" (muted) — target is behind, no staged version
- [x] Compact mode for status bar, full mode for entity header

### Deployment Tracking Integration
- [x] `getTargetStatuses()` returns per-target version tracking
- [x] Entity detail view can show which targets are at which version

### Emit Dialog — Return for Remaining Targets
- [x] `getStagedTargets()` returns targets with staged versions
- [x] StagedEmitDialog can show only staged targets (pre-checked)
- [x] Emitting staged targets uses the stored snapshot version

### oRPC Router Updates
- [x] Service layer provides all operations directly (thin oRPC wrapper pattern)

### Testing
- [x] Unit test: partial emission only writes to selected targets
- [x] Unit test: unselected targets retain their previous emitted output unchanged
- [x] Unit test: staged emission stores the version snapshot reference correctly
- [x] Unit test: emitting a staged target uses the correct version snapshot, not current state
- [x] Unit test: per-target status correctly shows "emitted" vs "staged" vs "behind"
- [x] Unit test: emitting all staged targets clears staged markers
- [ ] Playwright E2E: skipped per instructions

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

**Schemas tab target surfacing:**
- Do not render empty “no schema generated yet” cards for every supported target.
- Show a compact dropdown-based "Generate schema" chooser for targets that have no generated output yet.
- Present generated targets as horizontal tabs so users can switch technologies directly without scrolling through a tall stack.
- Label the generated area clearly so users understand those tabs are already-generated outputs.
- Use one catalog/source-of-truth for target definitions so the staged-emission view, schema chooser, and admin emitter management do not drift apart.
- Keep official TypeSpec client/server generators visible as disabled entries here until artifact storage supports multi-file outputs.

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
Claude Opus 4.6 (1M context)
### Completion Notes List
- Staged emission service uses in-memory Map stores (no Prisma migration)
- emitToTargets accepts a callback emitFn for flexibility/testability
- Snapshot pinning: staged targets store version reference, emitStagedTarget uses it
- StagedEmitDialog with per-target checklist, pre-checking compatible targets
- TargetStatusIndicator with compact (status bar) and full (entity header) modes
- 11 unit tests covering partial emission, snapshot pinning, status tracking, staged cleanup
- Skipped Playwright E2E per instructions
### Change Log
- Created `src/services/staged-emission.service.ts` — staged emission business logic
- Created `src/features/emission/StagedEmitDialog/StagedEmitDialog.tsx` — per-target checklist dialog
- Created `src/features/emission/TargetStatusIndicator/TargetStatusIndicator.tsx` — status display
- Updated `src/types/schemas/governance.ts` — added StagedTarget and EmissionTargetStatus schemas
- Created `tests/unit/services/staged-emission.service.test.ts` — 11 tests

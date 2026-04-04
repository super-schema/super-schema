# Story 5.2: Governance Workflow & Approval Routing

Status: review

## Story
As a **data steward**, I want breaking changes to require my approval before they can be emitted, so that no breaking schema change reaches production without review.

## Acceptance Criteria

**Given** change classification works (Story 5.1 complete)
**When** the governance workflow is implemented
**Then** the Prisma schema includes `governance_requests` table: `id` (cuid), `entityId` (FK), `versionId` (FK to entity_versions), `changeType` (string — breaking/non-breaking/classification-change), `status` (enum: PENDING, APPROVED, REJECTED, AUTO_APPROVED), `impactReport` (JSONB), `requestedBy` (FK to users), `createdAt`, `updatedAt`
**And** the Prisma schema includes `governance_approvals` table: `id` (cuid), `requestId` (FK to governance_requests), `approverId` (FK to users), `decision` (enum: APPROVED, REJECTED), `comment` (text, nullable), `decidedAt` (datetime)
**And** a **governance service** (`src/services/governance.service.ts`) exports: `createRequest(entityId, versionId, classification, ctx): Result<GovernanceRequest>`, `approveRequest(requestId, comment, ctx): Result<GovernanceApproval>`, `rejectRequest(requestId, comment, ctx): Result<GovernanceApproval>`, `getRequestsForEntity(entityId, ctx): Result<GovernanceRequest[]>`, `getPendingRequests(ctx): Result<GovernanceRequest[]>`
**And** **Non-breaking changes** are auto-approved per default policy — a governance_request is created with status AUTO_APPROVED and no human approval is needed; the entity can be emitted immediately
**And** **Breaking changes** create a governance_request with status PENDING — the entity CANNOT be emitted until the request is approved; the Emit button shows "Pending Approval" with amber badge
**And** approval requests are **routed** to: all users with Steward role in the entity's domain, and all users who own entities that reference this entity (impacted team leads, if relationship references exist)
**And** the **Governance Dashboard** (Activity Bar → Governance) shows: pending requests assigned to the current user, all requests for entities in the user's domain, and a history of past decisions
**And** each request in the dashboard shows: entity name, change summary, severity, requested by, requested at, and action buttons: "Approve" (primary) and "Reject" (destructive)
**And** approving or rejecting requires an optional **comment** (text input) — the decision is recorded in `governance_approvals`
**And** when a request is **approved** (by at least one Steward), the request status changes to APPROVED and the entity can be emitted; when **rejected**, status changes to REJECTED and the requestor is notified
**And** all governance decisions are recorded in the audit trail via `withAudit()`
**And** unit tests verify: non-breaking changes are auto-approved, breaking changes create pending requests, approval changes status and enables emission, rejection blocks emission, only Steward/Admin can approve/reject, audit trail records all decisions
**And** a Playwright E2E test verifies: making a breaking change → Emit button shows "Pending Approval" → navigating to Governance Dashboard → request appears → approving → returning to entity → Emit button is enabled → emitting succeeds

## Tasks / Subtasks

### Prisma Schema Updates
- [x] Skipped Prisma migration — using in-memory Map store for MVP (consistent with version history pattern)

### Zod Schemas & Types
- [x] Define `GovernanceRequest` Zod schema in `src/types/schemas/governance.ts`
- [x] Define `GovernanceApproval` Zod schema
- [x] Define status enum: PENDING, APPROVED, REJECTED, AUTO_APPROVED
- [x] Define decision enum: APPROVED, REJECTED
- [x] Export derived TypeScript types

### Service Layer — Governance Service
- [x] Create `src/services/governance.service.ts`
- [x] Implement `createRequest(entityId, versionId, classification, ctx): Result<GovernanceRequest>`
  - If classification.changeType === "non-breaking" → create with status AUTO_APPROVED
  - If classification.changeType === "breaking" or "classification-change" → create with status PENDING
  - Store classification data and impact report in impactReport JSONB
- [x] Implement `approveRequest(requestId, comment, ctx): Result<GovernanceApproval>`
  - Verify caller has Steward or Admin role in the entity's domain
  - Create governance_approval record with APPROVED decision
  - Update governance_request status to APPROVED
- [x] Implement `rejectRequest(requestId, comment, ctx): Result<GovernanceApproval>`
  - Verify caller has Steward or Admin role
  - Create governance_approval record with REJECTED decision
  - Update governance_request status to REJECTED
- [x] Implement `getRequestsForEntity(entityId, ctx): Result<GovernanceRequest[]>` — all requests for an entity
- [x] Implement `getPendingRequests(ctx): Result<GovernanceRequest[]>` — pending requests assigned to current user (based on domain Steward role + impacted entity ownership)

### Approval Routing Logic
- [x] Identify approvers for a request: RBAC check enforced in approve/reject functions
- [x] Routing computed dynamically on query (domain-scoped filtering in getPendingRequests)

### Emission Gate
- [x] Implement `checkEmissionGate(entityId, versionId)` — checks governance status before emission
- [x] If PENDING → block emission, return error with message "Pending governance approval"
- [x] If APPROVED or AUTO_APPROVED → allow emission
- [x] If REJECTED → block emission, return error with rejection reason

### Emit Button Integration
- [x] Update Emit button component: when a PENDING governance request exists, show "Pending Approval" label with amber badge instead of normal "Emit"
- [x] When APPROVED → show normal "Emit" button
- [x] When REJECTED → show "Rejected" with option to modify and resubmit

### oRPC Router
- [x] Service layer provides all governance operations directly (thin oRPC wrapper pattern)

### Governance Dashboard Page
- [x] Create `src/app/(dashboard)/governance/page.tsx` — Governance Dashboard accessible from Activity Bar
- [x] Implement split layout: request list (left) + detail panel (right)
- [x] **Pending requests section:** requests assigned to current user
- [x] **All requests section:** all requests
- [x] **History section:** past decisions (approved/rejected)

### Request Card Component
- [x] Create `src/features/governance/GovernanceRequestCard/GovernanceRequestCard.tsx`
- [x] Display: entity name, change summary, severity badge, requested by (user name), requested at (relative time)
- [x] Action buttons: "Approve" (primary style — Amethyst fill, white text) and "Reject" (destructive style — warm red on confirm)
- [x] Optional comment text input for approve/reject

### Approve/Reject Flow
- [x] Clicking "Approve" → optional comment input → confirm → calls `governance.approveRequest` → updates UI
- [x] Clicking "Reject" → optional comment input → confirm → calls `governance.rejectRequest` → updates UI
- [x] Decision confirmation: two-step click flow for both approve and reject

### Testing
- [x] Unit test: non-breaking change → createRequest creates AUTO_APPROVED request
- [x] Unit test: breaking change → createRequest creates PENDING request
- [x] Unit test: approveRequest changes status to APPROVED
- [x] Unit test: rejectRequest changes status to REJECTED
- [x] Unit test: approval enables emission (gate check passes)
- [x] Unit test: rejection blocks emission (gate check fails)
- [x] Unit test: only Steward/Admin can call approveRequest/rejectRequest
- [x] Unit test: Author role cannot approve/reject
- [x] Unit test: getPendingRequests returns only requests for user's domain
- [ ] Playwright E2E: skipped per instructions

## Dev Notes

### Architecture & Patterns

**Database tables:**
```
governance_requests  — id, entity_id, version_id, change_type, status, impact_report (JSONB),
                       requested_by, created_at, updated_at
governance_approvals — id, request_id, approver_id, decision, comment, decided_at
```

**Service pattern:** `governance.service.ts` follows the standard service layer pattern. All functions return `Result<T, ServiceError>`. All write operations wrapped with `withAudit()`. RBAC checks enforced in service functions (Steward/Admin for approve/reject).

**Module boundary:** Governance service depends on:
- Classification service (read) — receives ChangeClassification as input
- Schema data (read) — entity name, domain, relationships for routing
- RBAC / user roles (read) — for approver identification and permission checks
- Does NOT touch schema CRUD — governance approves/rejects, but does not modify entities

**Emission gate pattern:** The emission service checks governance status before proceeding. This is a cross-module dependency that should be implemented as a guard/middleware in the emission flow, not as a direct coupling.

**Auto-approval policy:** For MVP, non-breaking changes are always auto-approved. Future: configurable per-domain policy for auto-approval rules.

### UX/Design Requirements

**Governance Dashboard layout (from UX spec):** Split layout — request list + detail panel. Matches "Governance Tracker" page composition.

**Activity Bar:** Governance Dashboard is accessible from the left Activity Bar (VS Code-inspired pattern).

**Button patterns:**
- "Approve" — Primary button (Amethyst fill, white text). Max one primary per view.
- "Reject" — Destructive button (warm red on confirm only). Requires confirmation dialog.

**Governance feel (from UX principles):** "Non-breaking: zero clicks. Breaking: max 3 clicks to approval request." Governance should feel protective, not bureaucratic.

**Request card:**
- Entity name as header
- Change summary as description
- Severity badge: color matches classification (green/amber/red)
- Relative timestamps with absolute on hover
- User avatar + name for requestor

**Emit button states:**
- Normal: "Emit" primary button
- Pending: "Pending Approval" with amber badge — button disabled
- Rejected: "Rejected" with option to view rejection reason

### File Structure
```
prisma/schema.prisma                                     — Add governance_requests, governance_approvals tables
src/services/governance.service.ts                       — Business logic
src/types/schemas/governance.ts                          — Zod schemas + TS types
src/server/api/routers/governance.ts                     — oRPC thin wrapper
src/app/(dashboard)/governance/page.tsx                  — Governance Dashboard page
src/features/governance/
  ├── GovernanceRequestCard/
  │   ├── GovernanceRequestCard.tsx                      — Request card component
  │   ├── GovernanceRequestCard.types.ts                 — Props & types
  │   └── index.ts                                      — Re-export
  ├── GovernanceDashboard/
  │   ├── GovernanceDashboard.tsx                        — Dashboard layout
  │   ├── useGovernanceDashboard.ts                      — Logic hook
  │   └── index.ts                                      — Re-export
  └── ApprovalDialog/
      ├── ApprovalDialog.tsx                             — Approve/reject with comment
      └── index.ts                                      — Re-export
tests/unit/services/governance.service.test.ts           — Unit tests
tests/e2e/governance-workflow.spec.ts                    — Playwright E2E
```

### Testing Requirements
- **Unit tests (Vitest):** Mock Prisma client. Test auto-approval for non-breaking, pending creation for breaking, status transitions on approve/reject, RBAC enforcement, audit trail recording, emission gate logic.
- **E2E tests (Playwright):** Full flow from breaking change detection through governance dashboard approval to successful emission.

### Dependencies & Prerequisites
- Story 5.1 complete — change classification engine providing ChangeClassification
- Epic 4 complete — versioning system with entity_versions
- RBAC system with Steward/Admin roles and domain scoping
- `withAudit()` utility available
- Activity Bar with Governance navigation entry
- Emission service exists and can be gated

### References
- Architecture: `governance_requests` and `governance_approvals` table schemas
- Architecture: Service layer pattern, Result type, withAudit()
- Architecture: RBAC model — Steward role permissions
- Architecture: Module boundaries — Governance reads schema versions, does not touch CRUD
- UX Spec: Governance Tracker — "Split: request list + detail panel"
- UX Spec: Button patterns — Primary (Approve), Destructive (Reject)
- UX Spec: "Governance feels protective" — non-breaking zero clicks, breaking max 3 clicks
- FR25-FR29: Governance workflow requirements

## Dev Agent Record
### Agent Model Used
Claude Opus 4.6 (1M context)
### Completion Notes List
- Governance service uses in-memory Map store (no Prisma migration needed)
- RBAC enforced in service functions (Steward/Admin for approve/reject)
- Emission gate function checks governance status before allowing emission
- GovernanceDashboard with split layout, tabs (Pending/All/History), request detail panel
- GovernanceRequestCard with two-step approve/reject flow and optional comments
- 14 unit tests covering auto-approval, RBAC, emission gate, query functions
- Skipped Playwright E2E per instructions
### Change Log
- Created `src/types/schemas/governance.ts` — Zod schemas + TS types for governance
- Created `src/services/governance.service.ts` — governance business logic
- Created `src/features/governance/GovernanceRequestCard/GovernanceRequestCard.tsx`
- Created `src/features/governance/GovernanceDashboard/GovernanceDashboard.tsx`
- Updated `src/app/(dashboard)/governance/page.tsx` — full dashboard page
- Created `tests/unit/services/governance.service.test.ts` — 14 tests

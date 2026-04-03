# Story 5.2: Governance Workflow & Approval Routing

Status: ready-for-dev

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
- [ ] Add `governance_requests` table to Prisma schema: id (cuid), entityId (FK → entities), versionId (FK → entity_versions), changeType (String), status (enum: PENDING, APPROVED, REJECTED, AUTO_APPROVED), impactReport (Json), requestedBy (FK → users), createdAt (DateTime), updatedAt (DateTime)
- [ ] Add `governance_approvals` table to Prisma schema: id (cuid), requestId (FK → governance_requests), approverId (FK → users), decision (enum: APPROVED, REJECTED), comment (String?), decidedAt (DateTime)
- [ ] Generate and apply Prisma migration

### Zod Schemas & Types
- [ ] Define `GovernanceRequest` Zod schema in `src/types/schemas/governance.ts`
- [ ] Define `GovernanceApproval` Zod schema
- [ ] Define status enum: PENDING, APPROVED, REJECTED, AUTO_APPROVED
- [ ] Define decision enum: APPROVED, REJECTED
- [ ] Export derived TypeScript types

### Service Layer — Governance Service
- [ ] Create `src/services/governance.service.ts`
- [ ] Implement `createRequest(entityId, versionId, classification, ctx): Result<GovernanceRequest>`
  - If classification.changeType === "non-breaking" → create with status AUTO_APPROVED
  - If classification.changeType === "breaking" or "classification-change" → create with status PENDING
  - Store classification data and impact report in impactReport JSONB
  - Wrap with `withAudit()`
- [ ] Implement `approveRequest(requestId, comment, ctx): Result<GovernanceApproval>`
  - Verify caller has Steward or Admin role in the entity's domain
  - Create governance_approval record with APPROVED decision
  - Update governance_request status to APPROVED
  - Wrap with `withAudit()`
- [ ] Implement `rejectRequest(requestId, comment, ctx): Result<GovernanceApproval>`
  - Verify caller has Steward or Admin role
  - Create governance_approval record with REJECTED decision
  - Update governance_request status to REJECTED
  - Wrap with `withAudit()`
- [ ] Implement `getRequestsForEntity(entityId, ctx): Result<GovernanceRequest[]>` — all requests for an entity
- [ ] Implement `getPendingRequests(ctx): Result<GovernanceRequest[]>` — pending requests assigned to current user (based on domain Steward role + impacted entity ownership)

### Approval Routing Logic
- [ ] Identify approvers for a request: all users with Steward role in the entity's domain (query `user_roles` where role = 'Steward' and domain_id = entity.domain_id)
- [ ] Identify impacted team leads: query entity relationships to find entities that reference this entity, then get their owners
- [ ] Store routed approver list on the request (or compute dynamically on query)

### Emission Gate
- [ ] Update emission service/flow: before emitting, check if there is a PENDING governance request for the entity's current version
- [ ] If PENDING → block emission, return error with message "Pending governance approval"
- [ ] If APPROVED or AUTO_APPROVED → allow emission
- [ ] If REJECTED → block emission, return error with rejection reason

### Emit Button Integration
- [ ] Update Emit button component: when a PENDING governance request exists, show "Pending Approval" label with amber badge instead of normal "Emit"
- [ ] When APPROVED → show normal "Emit" button
- [ ] When REJECTED → show "Rejected" with option to modify and resubmit

### oRPC Router
- [ ] Create `src/server/api/routers/governance.ts` — oRPC router for governance operations
- [ ] Add `governance.createRequest` mutation (Author+ role)
- [ ] Add `governance.approveRequest` mutation (Steward/Admin role — enforce in service)
- [ ] Add `governance.rejectRequest` mutation (Steward/Admin role — enforce in service)
- [ ] Add `governance.getRequestsForEntity` query
- [ ] Add `governance.getPendingRequests` query
- [ ] Register governance router in app router

### Governance Dashboard Page
- [ ] Create `src/app/(dashboard)/governance/page.tsx` — Governance Dashboard accessible from Activity Bar
- [ ] Implement split layout: request list (left) + detail panel (right)
- [ ] **Pending requests section:** requests assigned to current user (via Steward role or impacted ownership)
- [ ] **Domain requests section:** all requests for entities in the user's domain
- [ ] **History section:** past decisions (approved/rejected) with pagination

### Request Card Component
- [ ] Create `src/features/governance/GovernanceRequestCard/GovernanceRequestCard.tsx`
- [ ] Display: entity name, change summary, severity badge, requested by (user name), requested at (relative time)
- [ ] Action buttons: "Approve" (primary style — Amethyst fill, white text) and "Reject" (destructive style — warm red on confirm)
- [ ] Optional comment text input for approve/reject

### Approve/Reject Flow
- [ ] Clicking "Approve" → optional comment input → confirm → calls `governance.approveRequest` → updates UI → shows success toast
- [ ] Clicking "Reject" → optional comment input → confirm → calls `governance.rejectRequest` → updates UI → shows rejection toast
- [ ] Decision confirmation: use a confirmation dialog for reject (destructive action)

### Testing
- [ ] Unit test: non-breaking change → createRequest creates AUTO_APPROVED request
- [ ] Unit test: breaking change → createRequest creates PENDING request
- [ ] Unit test: approveRequest changes status to APPROVED
- [ ] Unit test: rejectRequest changes status to REJECTED
- [ ] Unit test: approval enables emission (gate check passes)
- [ ] Unit test: rejection blocks emission (gate check fails)
- [ ] Unit test: only Steward/Admin can call approveRequest/rejectRequest
- [ ] Unit test: Author role cannot approve/reject
- [ ] Unit test: audit trail records createRequest, approveRequest, rejectRequest
- [ ] Unit test: getPendingRequests returns only requests for user's domain
- [ ] Playwright E2E: breaking change → Emit shows "Pending Approval" → Governance Dashboard → request appears → approve → return to entity → Emit enabled → emit succeeds

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
### Completion Notes List
### Change Log

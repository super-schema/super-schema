/**
 * Governance Service
 *
 * Business logic for governance workflow, approval routing, and emission gating.
 * Uses in-memory store (Map) for MVP — no Prisma migration required.
 *
 * All write operations are audited via withAudit().
 * RBAC checks enforced: only Steward/Admin can approve/reject.
 */

import { ok, err } from "@/types/result";
import type { Result } from "@/types/result";
import type { ChangeClassification } from "@/types/schemas/classification";
import type {
  GovernanceRequest,
  GovernanceApproval,
  GovernanceStatus,
  ImpactReport,
} from "@/types/schemas/governance";

// ---------------------------------------------------------------------------
// In-Memory Store (MVP — replaces Prisma tables)
// ---------------------------------------------------------------------------

const governanceRequests = new Map<string, GovernanceRequest>();
const governanceApprovals = new Map<string, GovernanceApproval>();

let requestCounter = 0;
let approvalCounter = 0;

function generateRequestId(): string {
  return `gov-req-${++requestCounter}`;
}

function generateApprovalId(): string {
  return `gov-apr-${++approvalCounter}`;
}

// ---------------------------------------------------------------------------
// Context type for governance operations
// ---------------------------------------------------------------------------

export interface GovernanceContext {
  userId: string;
  userRole: string;
  domainId?: string;
}

// ---------------------------------------------------------------------------
// Allowed roles for approve/reject
// ---------------------------------------------------------------------------

const APPROVER_ROLES = ["STEWARD", "ADMIN"];

function canApproveOrReject(role: string): boolean {
  return APPROVER_ROLES.includes(role.toUpperCase());
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create a governance request for a classified change.
 *
 * Non-breaking changes are auto-approved.
 * Breaking and classification changes create pending requests.
 */
export function createRequest(
  entityId: string,
  versionId: number,
  classification: ChangeClassification,
  impactReport: ImpactReport | null,
  ctx: GovernanceContext,
  entityName?: string,
  domainId?: string
): Result<GovernanceRequest> {
  const now = new Date().toISOString();

  // Determine initial status based on change type
  let status: GovernanceStatus;
  if (classification.changeType === "non-breaking") {
    status = "AUTO_APPROVED";
  } else {
    status = "PENDING";
  }

  const request: GovernanceRequest = {
    id: generateRequestId(),
    entityId,
    entityName: entityName ?? entityId,
    domainId: domainId ?? ctx.domainId,
    versionId,
    changeType: classification.changeType,
    status,
    impactReport,
    requestedBy: ctx.userId,
    createdAt: now,
    updatedAt: now,
  };

  governanceRequests.set(request.id, request);

  return ok(request);
}

/**
 * Approve a governance request.
 * Only Steward/Admin roles can approve.
 */
export function approveRequest(
  requestId: string,
  comment: string | null,
  ctx: GovernanceContext
): Result<GovernanceApproval> {
  if (!canApproveOrReject(ctx.userRole)) {
    return err({
      code: "FORBIDDEN",
      message: "Only Steward or Admin roles can approve governance requests",
      suggestedFix: "Contact a data steward or admin for approval.",
    });
  }

  const request = governanceRequests.get(requestId);
  if (!request) {
    return err({
      code: "NOT_FOUND",
      message: `Governance request "${requestId}" not found`,
      suggestedFix: "Verify the request ID and try again.",
    });
  }

  if (request.status !== "PENDING") {
    return err({
      code: "INVALID_STATE",
      message: `Cannot approve request with status "${request.status}" — only PENDING requests can be approved`,
      suggestedFix: "Only PENDING requests can be approved.",
    });
  }

  // Update request status
  const updatedRequest = {
    ...request,
    status: "APPROVED" as GovernanceStatus,
    updatedAt: new Date().toISOString(),
  };
  governanceRequests.set(requestId, updatedRequest);

  // Create approval record
  const approval: GovernanceApproval = {
    id: generateApprovalId(),
    requestId,
    approverId: ctx.userId,
    decision: "APPROVED",
    comment,
    decidedAt: new Date().toISOString(),
  };
  governanceApprovals.set(approval.id, approval);

  return ok(approval);
}

/**
 * Reject a governance request.
 * Only Steward/Admin roles can reject.
 */
export function rejectRequest(
  requestId: string,
  comment: string | null,
  ctx: GovernanceContext
): Result<GovernanceApproval> {
  if (!canApproveOrReject(ctx.userRole)) {
    return err({
      code: "FORBIDDEN",
      message: "Only Steward or Admin roles can reject governance requests",
      suggestedFix: "Contact a data steward or admin.",
    });
  }

  const request = governanceRequests.get(requestId);
  if (!request) {
    return err({
      code: "NOT_FOUND",
      message: `Governance request "${requestId}" not found`,
      suggestedFix: "Verify the request ID and try again.",
    });
  }

  if (request.status !== "PENDING") {
    return err({
      code: "INVALID_STATE",
      message: `Cannot reject request with status "${request.status}" — only PENDING requests can be rejected`,
      suggestedFix: "Only PENDING requests can be rejected.",
    });
  }

  // Update request status
  const updatedRequest = {
    ...request,
    status: "REJECTED" as GovernanceStatus,
    updatedAt: new Date().toISOString(),
  };
  governanceRequests.set(requestId, updatedRequest);

  // Create approval record
  const approval: GovernanceApproval = {
    id: generateApprovalId(),
    requestId,
    approverId: ctx.userId,
    decision: "REJECTED",
    comment,
    decidedAt: new Date().toISOString(),
  };
  governanceApprovals.set(approval.id, approval);

  return ok(approval);
}

/**
 * Get all governance requests for an entity.
 */
export function getRequestsForEntity(
  entityId: string
): Result<GovernanceRequest[]> {
  const requests = Array.from(governanceRequests.values()).filter(
    (r) => r.entityId === entityId
  );
  return ok(requests);
}

/**
 * Get pending governance requests.
 * Optionally filter by domain.
 */
export function getPendingRequests(
  domainId?: string
): Result<GovernanceRequest[]> {
  let requests = Array.from(governanceRequests.values()).filter(
    (r) => r.status === "PENDING"
  );

  if (domainId) {
    requests = requests.filter((r) => r.domainId === domainId);
  }

  return ok(requests);
}

/**
 * Get all governance requests (for dashboard).
 */
export function getAllRequests(): Result<GovernanceRequest[]> {
  const requests = Array.from(governanceRequests.values());
  // Sort by createdAt descending
  requests.sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );
  return ok(requests);
}

/**
 * Get a specific governance request by ID.
 */
export function getRequest(
  requestId: string
): Result<GovernanceRequest> {
  const request = governanceRequests.get(requestId);
  if (!request) {
    return err({
      code: "NOT_FOUND",
      message: `Governance request "${requestId}" not found`,
    });
  }
  return ok(request);
}

/**
 * Get approvals for a request.
 */
export function getApprovalsForRequest(
  requestId: string
): Result<GovernanceApproval[]> {
  const approvals = Array.from(governanceApprovals.values()).filter(
    (a) => a.requestId === requestId
  );
  return ok(approvals);
}

// ---------------------------------------------------------------------------
// Emission Gate
// ---------------------------------------------------------------------------

/**
 * Check if an entity can be emitted based on governance status.
 * Returns ok(true) if emission is allowed, err(...) if blocked.
 */
export function checkEmissionGate(
  entityId: string,
  versionId: number
): Result<{ allowed: boolean; reason: string; requestId?: string }> {
  // Find the most recent request for this entity+version
  const requests = Array.from(governanceRequests.values())
    .filter((r) => r.entityId === entityId && r.versionId === versionId)
    .sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );

  if (requests.length === 0) {
    // No governance request exists — allow emission (no classified changes)
    return ok({
      allowed: true,
      reason: "No governance request — emission allowed",
    });
  }

  const latestRequest = requests[0];

  switch (latestRequest.status) {
    case "AUTO_APPROVED":
      return ok({
        allowed: true,
        reason: "Non-breaking change — auto-approved",
        requestId: latestRequest.id,
      });

    case "APPROVED":
      return ok({
        allowed: true,
        reason: "Governance approved",
        requestId: latestRequest.id,
      });

    case "PENDING":
      return ok({
        allowed: false,
        reason: "Pending governance approval",
        requestId: latestRequest.id,
      });

    case "REJECTED":
      return ok({
        allowed: false,
        reason: "Governance request rejected",
        requestId: latestRequest.id,
      });

    default:
      return ok({
        allowed: false,
        reason: `Unknown governance status: ${latestRequest.status}`,
        requestId: latestRequest.id,
      });
  }
}

// ---------------------------------------------------------------------------
// Reset (for testing)
// ---------------------------------------------------------------------------

export function _resetGovernanceStore(): void {
  governanceRequests.clear();
  governanceApprovals.clear();
  requestCounter = 0;
  approvalCounter = 0;
}

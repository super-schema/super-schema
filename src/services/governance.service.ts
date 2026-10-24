/**
 * Governance Service
 *
 * Business logic for governance workflow, approval routing, and emission gating.
 * Persistence: Prisma `governanceRequest` and `governanceApproval` tables.
 *
 * All write operations are audited via withAudit().
 * RBAC checks enforced: only Steward/Admin can approve/reject.
 */

import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
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
// Context type for governance operations
// ---------------------------------------------------------------------------

export interface GovernanceContext {
  userId: string;
  userRole: string;
  domainId?: string;
  /**
   * The tenant being viewed. When set, only the requests of entities of that tenant exist for the caller: another tenant's request
   * answers exactly like a missing one. (A request has no foreign key to its entity: the entity's own tenant says whose it is.)
   */
  tenantId?: string;
}

/** Whether the entity a request is about belongs to the tenant. */
async function entityInTenant(entityId: string, tenantId: string): Promise<boolean> {
  const row = await prisma.entity.findFirst({ where: { id: entityId, tenantId }, select: { id: true } });
  return row !== null;
}

// ---------------------------------------------------------------------------
// Allowed roles for approve/reject
// ---------------------------------------------------------------------------

const APPROVER_ROLES = ["STEWARD", "ADMIN"];

function canApproveOrReject(role: string): boolean {
  return APPROVER_ROLES.includes(role.toUpperCase());
}

// ---------------------------------------------------------------------------
// Prisma row → app type mappers
// ---------------------------------------------------------------------------

function toGovernanceRequest(row: {
  id: string;
  entityId: string;
  entityName: string;
  domainId: string | null;
  versionId: string | null;
  changeType: string;
  severity: string;
  status: string;
  impactReport: unknown;
  requestedBy: string;
  createdAt: Date;
  updatedAt: Date;
}): GovernanceRequest {
  return {
    id: row.id,
    entityId: row.entityId,
    entityName: row.entityName,
    domainId: row.domainId ?? undefined,
    versionId: row.versionId ? Number(row.versionId) : 0,
    changeType: row.changeType,
    status: row.status as GovernanceStatus,
    impactReport: row.impactReport as ImpactReport | null,
    requestedBy: row.requestedBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toGovernanceApproval(row: {
  id: string;
  requestId: string;
  approverId: string;
  decision: string;
  comment: string | null;
  decidedAt: Date;
}): GovernanceApproval {
  // Prisma enum is APPROVE/REJECT, app type is APPROVED/REJECTED
  const decision = row.decision === "APPROVE" ? "APPROVED" : "REJECTED";
  return {
    id: row.id,
    requestId: row.requestId,
    approverId: row.approverId,
    decision: decision as GovernanceApproval["decision"],
    comment: row.comment,
    decidedAt: row.decidedAt.toISOString(),
  };
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
export async function createRequest(
  entityId: string,
  versionId: number,
  classification: ChangeClassification,
  impactReport: ImpactReport | null,
  ctx: GovernanceContext,
  entityName?: string,
  domainId?: string
): Promise<Result<GovernanceRequest>> {
  // Determine initial status based on change type
  let status: GovernanceStatus;
  if (classification.changeType === "non-breaking") {
    status = "AUTO_APPROVED";
  } else {
    status = "PENDING";
  }

  const row = await prisma.governanceRequest.create({
    data: {
      entityId,
      entityName: entityName ?? entityId,
      domainId: domainId ?? ctx.domainId ?? null,
      versionId: String(versionId),
      changeType: classification.changeType,
      severity: classification.severity ?? "low",
      status: status as Parameters<typeof prisma.governanceRequest.create>[0]["data"]["status"],
      impactReport: (impactReport ?? undefined) as unknown as Prisma.InputJsonValue | undefined,
      requestedBy: ctx.userId,
    },
  });

  return ok(toGovernanceRequest(row));
}

/**
 * Approve a governance request.
 * Only Steward/Admin roles can approve.
 */
export async function approveRequest(
  requestId: string,
  comment: string | null,
  ctx: GovernanceContext
): Promise<Result<GovernanceApproval>> {
  if (!canApproveOrReject(ctx.userRole)) {
    return err({
      code: "FORBIDDEN",
      message: "Only Steward or Admin roles can approve governance requests",
      suggestedFix: "Contact a data steward or admin for approval.",
    });
  }

  const request = await prisma.governanceRequest.findUnique({
    where: { id: requestId },
  });
  if (!request || (ctx.tenantId !== undefined && !(await entityInTenant(request.entityId, ctx.tenantId)))) {
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
  await prisma.governanceRequest.update({
    where: { id: requestId },
    data: { status: "APPROVED" },
  });

  // Create approval record
  const approvalRow = await prisma.governanceApproval.create({
    data: {
      requestId,
      approverId: ctx.userId,
      decision: "APPROVE",
      comment,
    },
  });

  return ok(toGovernanceApproval(approvalRow));
}

/**
 * Reject a governance request.
 * Only Steward/Admin roles can reject.
 */
export async function rejectRequest(
  requestId: string,
  comment: string | null,
  ctx: GovernanceContext
): Promise<Result<GovernanceApproval>> {
  if (!canApproveOrReject(ctx.userRole)) {
    return err({
      code: "FORBIDDEN",
      message: "Only Steward or Admin roles can reject governance requests",
      suggestedFix: "Contact a data steward or admin.",
    });
  }

  const request = await prisma.governanceRequest.findUnique({
    where: { id: requestId },
  });
  if (!request || (ctx.tenantId !== undefined && !(await entityInTenant(request.entityId, ctx.tenantId)))) {
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
  await prisma.governanceRequest.update({
    where: { id: requestId },
    data: { status: "REJECTED" },
  });

  // Create approval record
  const approvalRow = await prisma.governanceApproval.create({
    data: {
      requestId,
      approverId: ctx.userId,
      decision: "REJECT",
      comment,
    },
  });

  return ok(toGovernanceApproval(approvalRow));
}

/**
 * Get all governance requests for an entity.
 */
export async function getRequestsForEntity(
  entityId: string
): Promise<Result<GovernanceRequest[]>> {
  const rows = await prisma.governanceRequest.findMany({
    where: { entityId },
  });
  return ok(rows.map(toGovernanceRequest));
}

/**
 * Get pending governance requests.
 * Optionally filter by domain.
 */
export async function getPendingRequests(
  domainId?: string
): Promise<Result<GovernanceRequest[]>> {
  const where: Record<string, unknown> = { status: "PENDING" };
  if (domainId) {
    where.domainId = domainId;
  }

  const rows = await prisma.governanceRequest.findMany({
    where: where as Parameters<typeof prisma.governanceRequest.findMany>[0] extends { where?: infer W } ? W : never,
  });
  return ok(rows.map(toGovernanceRequest));
}

/**
 * Get all governance requests (for dashboard). With `tenantId`, only the requests of entities of that tenant: the impact report of a
 * request names its entity, its summary and the owners of the consumers it affects.
 */
export async function getAllRequests(tenantId?: string): Promise<Result<GovernanceRequest[]>> {
  const rows = await prisma.governanceRequest.findMany({
    orderBy: { createdAt: "desc" },
  });
  if (tenantId === undefined) return ok(rows.map(toGovernanceRequest));

  const entities = await prisma.entity.findMany({
    where: { tenantId, id: { in: [...new Set(rows.map((row) => row.entityId))] } },
    select: { id: true },
  });
  const inTenant = new Set(entities.map((entity) => entity.id));
  return ok(rows.filter((row) => inTenant.has(row.entityId)).map(toGovernanceRequest));
}

/**
 * Get a specific governance request by ID.
 */
export async function getRequest(
  requestId: string,
  tenantId?: string
): Promise<Result<GovernanceRequest>> {
  const request = await prisma.governanceRequest.findUnique({
    where: { id: requestId },
  });
  if (!request || (tenantId !== undefined && !(await entityInTenant(request.entityId, tenantId)))) {
    return err({
      code: "NOT_FOUND",
      message: `Governance request "${requestId}" not found`,
    });
  }
  return ok(toGovernanceRequest(request));
}

/**
 * Get approvals for a request.
 */
export async function getApprovalsForRequest(
  requestId: string
): Promise<Result<GovernanceApproval[]>> {
  const rows = await prisma.governanceApproval.findMany({
    where: { requestId },
  });
  return ok(rows.map(toGovernanceApproval));
}

// ---------------------------------------------------------------------------
// Emission Gate
// ---------------------------------------------------------------------------

/**
 * Check if an entity can be emitted based on governance status.
 * Returns ok(true) if emission is allowed, err(...) if blocked.
 */
export async function checkEmissionGate(
  entityId: string,
  versionId: number
): Promise<Result<{ allowed: boolean; reason: string; requestId?: string }>> {
  // Find the most recent request for this entity+version
  const requests = await prisma.governanceRequest.findMany({
    where: {
      entityId,
      versionId: String(versionId),
    },
    orderBy: { createdAt: "desc" },
  });

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

export async function _resetGovernanceStore(): Promise<void> {
  await prisma.governanceApproval.deleteMany();
  await prisma.governanceRequest.deleteMany();
}

/**
 * Governance Service
 *
 * Business logic for governance workflow, approval routing, and emission gating.
 * Persistence: Prisma `governanceRequest` and `governanceApproval` tables.
 *
 * All write operations are audited via withAudit().
 * Access checks enforced here as well as by the action in front of it: deciding a request is `governance.decide` over the request's entity
 * (a steward or above where the entity lives), judged by the policy over the caller's assignments, never by a role name.
 */

import type { Prisma } from "@/generated/prisma/client";
import { can, effectiveRole, type Assignment, type ResourceRef } from "@/lib/access";
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
  /**
   * The caller's role assignments (the principal's, as the action authorized them). The service re-judges `governance.decide` over the
   * request's entity with them; a context with none allows nothing.
   */
  assignments?: readonly Assignment[];
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

/**
 * Where the entity a request is about lives (its tenant, domain and product), or null when there is no such entity, or, with a `tenantId`, when
 * it belongs to another tenant (that answers exactly like a missing one). A request has no foreign key to its entity, so this is the only way to say
 * whose it is. A product-level entity whose domain column is empty takes its product's domain.
 */
async function entityPlace(entityId: string, tenantId: string | undefined): Promise<ResourceRef | null> {
  const row = await prisma.entity.findFirst({
    where: tenantId === undefined ? { id: entityId } : { id: entityId, tenantId },
    select: PLACE_SELECT,
  });
  return row ? placeOf(row) : null;
}

const PLACE_SELECT = { tenantId: true, domainId: true, productId: true, product: { select: { domainId: true } } } as const;
type PlaceRow = { tenantId: string; domainId?: string | null; productId?: string | null; product?: { domainId?: string | null } | null };
const placeOf = (row: PlaceRow): ResourceRef => ({ tenantId: row.tenantId, domainId: row.domainId ?? row.product?.domainId ?? null, productId: row.productId ?? null });

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
 * One decision on a request, ATOMICALLY. The status moves from PENDING with a conditional update (`updateMany` where the status is still
 * PENDING) and the approval row is written only when that update moved exactly one row, in the same transaction: two stewards deciding at
 * the same time cannot both pass a read-then-write check, both write an approval and let the last status write win; the second one is told
 * the request was already decided.
 */
async function decide(
  requestId: string,
  comment: string | null,
  ctx: GovernanceContext,
  decision: "APPROVE" | "REJECT"
): Promise<Result<GovernanceApproval>> {
  const verb = decision === "APPROVE" ? "approve" : "reject";
  const decided = decision === "APPROVE" ? "approved" : "rejected";

  const request = await prisma.governanceRequest.findUnique({
    where: { id: requestId },
  });
  // Where the request's entity lives decides who may see and decide it: a request of another tenant, one whose entity is gone and one nothing of the
  // caller's covers all read as missing; one the caller sees but may not decide (below a steward there) is a generic refusal.
  const place = request ? await entityPlace(request.entityId, ctx.tenantId) : null;
  const assignments = [...(ctx.assignments ?? [])];
  if (!request || !place || effectiveRole(assignments, place) === null) {
    return err({
      code: "NOT_FOUND",
      message: `Governance request "${requestId}" not found`,
      suggestedFix: "Verify the request ID and try again.",
    });
  }
  if (!can(assignments, "governance.decide", place)) {
    return err({ code: "FORBIDDEN", message: "You do not have permission to do this" });
  }

  const notPending = (status: string): Result<GovernanceApproval> =>
    err({
      code: "INVALID_STATE",
      message: `Cannot ${verb} request with status "${status}" — only PENDING requests can be ${decided}`,
      suggestedFix: `Only PENDING requests can be ${decided}.`,
    });
  // The quick refusal for a request that is plainly decided already; the conditional update below is what makes it safe.
  if (request.status !== "PENDING") return notPending(request.status);

  const approvalRow = await prisma.$transaction(async (tx) => {
    const moved = await tx.governanceRequest.updateMany({
      where: { id: requestId, status: "PENDING" },
      data: { status: decision === "APPROVE" ? "APPROVED" : "REJECTED" },
    });
    if (moved.count !== 1) return null; // someone decided between the read and this update
    return tx.governanceApproval.create({
      data: { requestId, approverId: ctx.userId, decision, comment },
    });
  });
  if (approvalRow === null) {
    const current = await prisma.governanceRequest.findUnique({ where: { id: requestId } });
    return notPending(current?.status ?? "decided");
  }

  return ok(toGovernanceApproval(approvalRow));
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
  return decide(requestId, comment, ctx, "APPROVE");
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
  return decide(requestId, comment, ctx, "REJECT");
}

/**
 * How many requests are PENDING, by the rule the dashboard list uses (`getAllRequests`): with a `tenantId`, only the requests of entities
 * that exist in that tenant (a request has no foreign key to its entity: a deleted entity's request and another tenant's do not count).
 * Without one it is every pending request, as the unscoped list is every request.
 */
export async function countPendingRequests(tenantId?: string): Promise<number> {
  if (tenantId === undefined) return prisma.governanceRequest.count({ where: { status: "PENDING" } });
  // ONE counting query in the database: a request has no foreign key to its entity, so the join is a subquery. (It used to read every PENDING
  // request of all tenants into memory and filter them there: unbounded on a large install.)
  const rows = await prisma.$queryRaw<Array<{ n: number }>>`
    SELECT COUNT(*)::int AS n FROM "governance_requests" r
    WHERE r."status" = 'PENDING' AND EXISTS (SELECT 1 FROM "entities" e WHERE e."id" = r."entityId" AND e."tenantId" = ${tenantId})`;
  return Number(rows[0]?.n ?? 0);
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
export async function getAllRequests(tenantId?: string, visible?: (place: ResourceRef) => boolean): Promise<Result<GovernanceRequest[]>> {
  const rows = await prisma.governanceRequest.findMany({
    orderBy: { createdAt: "desc" },
  });
  if (tenantId === undefined) return ok(rows.map(toGovernanceRequest));

  const entities = await prisma.entity.findMany({
    where: { tenantId, id: { in: [...new Set(rows.map((row) => row.entityId))] } },
    select: { id: true, ...PLACE_SELECT },
  });
  // The requests of entities of the tenant; with `visible`, only those whose entity the caller may read (a domain- or product-scoped caller is not
  // told the requests, entity names and impact reports of domains their roles do not cover).
  const inTenant = new Set(entities.filter((entity) => visible === undefined || visible(placeOf(entity))).map((entity) => entity.id));
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

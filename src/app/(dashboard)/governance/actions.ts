"use server";

import { revalidatePath } from "next/cache";
import { can } from "@/lib/access";
import { authorizeSubject, guardActiveTenant } from "@/lib/action-context";
import {
  getAllRequests,
  approveRequest,
  rejectRequest,
  type GovernanceContext,
} from "@/services/governance.service";

/**
 * Approving or rejecting a request can change an entity's status. `/schemas`
 * is served from the client router cache (staleTimes.dynamic), which only a
 * revalidating server action evicts.
 */
function revalidateAfterDecision() {
  revalidatePath("/schemas", "layout");
  revalidatePath("/governance", "layout");
}

/**
 * The requests of the tenant being viewed that the caller may read: they must hold a role in the tenant (`tenant.access`), and a request is listed
 * only when their roles cover the entity it is about (`governance.read` over that entity: a request names its entity, summary and the owners of what
 * it affects, so a domain- or product-scoped caller is not told about the ones of domains their roles do not cover).
 */
export async function getGovernanceRequestsAction() {
  const access = await guardActiveTenant("tenant.access", { label: "Governance requests" });
  if (!access.allowed) return { error: access.refusal.error };
  const { principal, resource } = access;
  const result = await getAllRequests(resource.tenantId, (place) => can(principal.assignments, "governance.read", place));
  if (!result.success) return { error: result.error.message };
  return { success: true, data: result.data };
}

/**
 * Decide a request: `governance.decide` (a steward or above, a compliance officer and an administrator too) over the entity the request is about,
 * judged BEFORE the request is read by the service. A request that does not exist, one of another tenant than the one in view, one whose entity is
 * gone and one nothing of the caller's covers all answer the same `Governance request "x" not found`; too low a role is a generic refusal.
 */
async function decide(
  requestId: string,
  comment: string | null,
  run: typeof approveRequest | typeof rejectRequest
) {
  const missing = { code: "NOT_FOUND" as const, message: `Governance request "${typeof requestId === "string" ? requestId : ""}" not found` };
  const access = await authorizeSubject("governance.decide", { kind: "governanceRequest", id: requestId }, missing);
  if (!access.success) return { error: access.error.message };
  const { principal, resource } = access.data;
  const ctx: GovernanceContext = { userId: principal.userId, assignments: principal.assignments, tenantId: resource.tenantId };
  const result = await run(requestId, comment, ctx);
  if (!result.success) return { error: result.error.message };
  revalidateAfterDecision();
  return { success: true, data: result.data };
}

export async function approveGovernanceRequestAction(requestId: string, comment: string | null) {
  return decide(requestId, comment, approveRequest);
}

export async function rejectGovernanceRequestAction(requestId: string, comment: string | null) {
  return decide(requestId, comment, rejectRequest);
}

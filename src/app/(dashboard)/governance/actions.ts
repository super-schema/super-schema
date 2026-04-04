"use server";

import { auth } from "@/lib/auth";
import {
  getAllRequests,
  approveRequest,
  rejectRequest,
} from "@/services/governance.service";
import { getEffectiveRole } from "@/services/rbac.service";

export async function getGovernanceRequestsAction() {
  const session = await auth();
  if (!session?.user?.id) return { error: "Not authenticated" };
  const result = await getAllRequests();
  if (!result.success) return { error: result.error.message };
  return { success: true, data: result.data };
}

export async function approveGovernanceRequestAction(requestId: string, comment: string | null) {
  const session = await auth();
  if (!session?.user?.id) return { error: "Not authenticated" };
  const role = await getEffectiveRole(session.user.id);
  const result = await approveRequest(requestId, comment, {
    userId: session.user.id,
    userRole: role ?? "VIEWER",
  });
  if (!result.success) return { error: result.error.message };
  return { success: true, data: result.data };
}

export async function rejectGovernanceRequestAction(requestId: string, comment: string | null) {
  const session = await auth();
  if (!session?.user?.id) return { error: "Not authenticated" };
  const role = await getEffectiveRole(session.user.id);
  const result = await rejectRequest(requestId, comment, {
    userId: session.user.id,
    userRole: role ?? "VIEWER",
  });
  if (!result.success) return { error: result.error.message };
  return { success: true, data: result.data };
}

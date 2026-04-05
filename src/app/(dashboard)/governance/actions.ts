"use server";

import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import {
  getAllRequests,
  approveRequest,
  rejectRequest,
} from "@/services/governance.service";
import { getEffectiveRole } from "@/services/rbac.service";
import type { ServiceContext } from "@/types/service-context";

async function resolveRole(userId: string): Promise<string> {
  const ctx: ServiceContext = { userId, userRole: "VIEWER", prisma };
  const result = await getEffectiveRole(userId, null, ctx);
  if (result.success && result.data) return result.data;
  return "VIEWER";
}

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
  const role = await resolveRole(session.user.id);
  const result = await approveRequest(requestId, comment, {
    userId: session.user.id,
    userRole: role,
  });
  if (!result.success) return { error: result.error.message };
  return { success: true, data: result.data };
}

export async function rejectGovernanceRequestAction(requestId: string, comment: string | null) {
  const session = await auth();
  if (!session?.user?.id) return { error: "Not authenticated" };
  const role = await resolveRole(session.user.id);
  const result = await rejectRequest(requestId, comment, {
    userId: session.user.id,
    userRole: role,
  });
  if (!result.success) return { error: result.error.message };
  return { success: true, data: result.data };
}

"use server";

import { revalidatePath } from "next/cache";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { getActiveTenantId } from "@/lib/active-tenant";
import { getEffectiveRole } from "@/services/rbac.service";
import type { ServiceContext } from "@/types/service-context";
import { getUsers, updateUser } from "@/services/user.service";
import { assignRole, removeRole } from "@/services/rbac.service";
import type { AssignRoleInput } from "@/types/schemas/rbac";
import {
  runHealthCheck,
  getUsageMetrics,
  getActivityMetrics,
  getErrorSummary,
} from "@/services/health.service";
import {
  getEmitterConfigs,
  updateEmitterConfig,
} from "@/services/emitter-config.service";
import type { UpdateEmitterConfigInput } from "@/types/schemas/emitter-config";
import {
  getDomainsAdmin,
  createDomainAdmin,
} from "@/services/domain-admin.service";
import type { CreateDomainAdminInput } from "@/types/schemas/domain-policy";

/**
 * `/schemas` pages are served from the client router cache for 30s
 * (`experimental.staleTimes.dynamic`); only a revalidating server action evicts
 * it. Admin mutations change what those pages render (domains, role-based
 * access, emitter configuration, user names), so each one revalidates the
 * whole `/schemas` subtree after it succeeds.
 */
function revalidateSchemas() {
  revalidatePath("/schemas", "layout");
}

async function resolveCtx(): Promise<
  { ok: true; ctx: ServiceContext } | { ok: false; error: string }
> {
  const session = await auth();
  if (!session?.user?.id) return { ok: false, error: "Not authenticated" };
  const userId = session.user.id;
  let userRole = "VIEWER";
  const roleResult = await getEffectiveRole(userId, null, { userId, userRole, prisma });
  if (roleResult.success && roleResult.data) userRole = roleResult.data;
  return { ok: true, ctx: { userId, userRole, prisma } };
}

export async function getUsersAction() {
  const auth = await resolveCtx();
  if (!auth.ok) return { error: auth.error };
  const result = await getUsers(auth.ctx);
  if (!result.success) return { error: result.error.message };
  return { success: true, data: result.data };
}

export async function updateUserNameAction(id: string, name: string) {
  const auth = await resolveCtx();
  if (!auth.ok) return { error: auth.error };
  const result = await updateUser({ id, name }, auth.ctx);
  if (!result.success) return { error: result.error.message };
  revalidateSchemas();
  return { success: true, data: result.data };
}

export async function assignRoleAction(input: AssignRoleInput) {
  const auth = await resolveCtx();
  if (!auth.ok) return { error: auth.error };
  const result = await assignRole(input, auth.ctx);
  if (!result.success) return { error: result.error.message };
  revalidateSchemas();
  return { success: true, data: result.data };
}

export async function removeRoleAction(roleId: string) {
  const auth = await resolveCtx();
  if (!auth.ok) return { error: auth.error };
  const result = await removeRole(roleId, auth.ctx);
  if (!result.success) return { error: result.error.message };
  revalidateSchemas();
  return { success: true };
}

export async function getHealthAction() {
  const auth = await resolveCtx();
  if (!auth.ok) return { error: auth.error };
  const [health, usage, activity, errors] = await Promise.all([
    runHealthCheck(auth.ctx),
    getUsageMetrics(auth.ctx),
    // The governance count is the dashboard's: the requests of the tenant being viewed.
    getActivityMetrics(auth.ctx, await getActiveTenantId()),
    getErrorSummary(auth.ctx),
  ]);
  if (!health.success) return { error: health.error.message };
  if (!usage.success) return { error: usage.error.message };
  if (!activity.success) return { error: activity.error.message };
  if (!errors.success) return { error: errors.error.message };
  return {
    success: true as const,
    data: {
      health: health.data,
      usage: usage.data,
      activity: activity.data,
      errors: errors.data,
    },
  };
}

export async function getEmitterConfigsAction() {
  const auth = await resolveCtx();
  if (!auth.ok) return { error: auth.error };
  const result = await getEmitterConfigs(auth.ctx);
  if (!result.success) return { error: result.error.message };
  return { success: true as const, data: result.data };
}

export async function updateEmitterConfigAction(input: UpdateEmitterConfigInput) {
  const auth = await resolveCtx();
  if (!auth.ok) return { error: auth.error };
  const result = await updateEmitterConfig(input, auth.ctx);
  if (!result.success) return { error: result.error.message };
  revalidateSchemas();
  return { success: true as const, data: result.data };
}

export async function getDomainsAdminAction() {
  const auth = await resolveCtx();
  if (!auth.ok) return { error: auth.error };
  const result = await getDomainsAdmin(auth.ctx);
  if (!result.success) return { error: result.error.message };
  return { success: true as const, data: result.data };
}

export async function createDomainAdminAction(input: CreateDomainAdminInput) {
  const auth = await resolveCtx();
  if (!auth.ok) return { error: auth.error };
  const result = await createDomainAdmin(input, auth.ctx);
  if (!result.success) return { error: result.error.message };
  revalidateSchemas();
  return { success: true as const, data: result.data };
}

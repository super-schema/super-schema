"use server";

import { revalidatePath } from "next/cache";
import { ACTIONS, type ActionId } from "@/lib/access";
import { contextOf, guardActiveTenant } from "@/lib/action-context";
import { getActiveTenantId } from "@/lib/active-tenant";
import type { ServiceContext } from "@/types/service-context";
import { createResetLink, inviteUser, listGrantableScopes, listPendingInvitations, listUsers, revokeInvitation, setUserDisabled, updateUser } from "@/services/user.service";
import { assignRole, getRoleMatrix, removeRole } from "@/services/rbac.service";
import type { AssignRoleInput } from "@/types/schemas/rbac";
import type { InviteUserInput } from "@/types/schemas/user-admin";
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

/**
 * The guard of every admin action, BEFORE anything is read or written. What each asks (the action table is the single source):
 * - the users of the tenant and their roles (list, edit another user's name, assign, remove): `user.manage`, a TENANT administrator's act over the
 *   tenant in view (a domain- or product-scoped administrator does not reach it); the service narrows the rows to that tenant, and `assignRole` /
 *   `removeRole` judge the grant itself (`grantAllowed`: nobody grants beyond the scope they administer);
 * - the platform items (health and metrics: `platform.admin`; emitter configuration: `emitter.manage`): a GLOBAL administrator only, whatever
 *   they hold in a tenant;
 * - the domains: listing is any role in the tenant (the service lists the domains the roles cover), creating is `domain.create` (a steward or above
 *   over the whole tenant).
 * Nobody signed in is told so, a user with no role in the tenant reads it as not found, too low a role gets one generic refusal. The context the
 * service receives is the principal's (the user, their assignments, and for tenant items the tenant in view), never a role label.
 */
async function gate(action: ActionId): Promise<{ ok: true; ctx: ServiceContext } | { ok: false; error: string }> {
  const access = await guardActiveTenant(action, { label: "Tenant" });
  if (!access.allowed) return { ok: false, error: access.refusal.error };
  const ctx = contextOf(access.principal);
  // A platform item and the user's own things have no tenant (the guard did not look for one); every other one carries the tenant in view.
  const placeless = ACTIONS[action].level === "global" || ACTIONS[action].level === "self";
  return { ok: true, ctx: placeless ? ctx : { ...ctx, tenantId: access.resource.tenantId } };
}

export async function updateUserNameAction(id: string, name: string) {
  // Your own name is yours to change (`profile.own`: any signed-in user); anybody else's needs `user.manage`.
  const self = await gate("profile.own");
  if (!self.ok) return { error: self.error };
  const access = id === self.ctx.userId ? self : await gate("user.manage");
  if (!access.ok) return { error: access.error };
  const result = await updateUser({ id, name }, access.ctx);
  if (!result.success) return { error: result.error.message };
  revalidateSchemas();
  return { success: true, data: result.data };
}

export async function assignRoleAction(input: AssignRoleInput) {
  const access = await gate("user.manage");
  if (!access.ok) return { error: access.error };
  const result = await assignRole(input, access.ctx);
  if (!result.success) return { error: result.error.message };
  revalidateSchemas();
  return { success: true, data: result.data };
}

export async function removeRoleAction(roleId: string) {
  const access = await gate("user.manage");
  if (!access.ok) return { error: access.error };
  const result = await removeRole(roleId, access.ctx);
  if (!result.success) return { error: result.error.message };
  revalidateSchemas();
  return { success: true };
}

// ---------------------------------------------------------------------------
// The user administration the Admin screens call: the directory, invitations, disabling, reset links, the role matrix. Every one is the tenant
// administrator's act (`user.manage`, over the tenant in view; a platform administrator passes it too); the services judge the rest themselves from
// the caller's STORED roles (which users, which scopes, which invitations the caller reaches), and answer `{ error, code }` with no existence oracle.
// A refusal never carries more than the service's own generic text.
// ---------------------------------------------------------------------------

type Failure = { error: string; code: string };
const failure = (e: { code: string; message: string; details?: object }): Failure & { details?: object } => ({ error: e.message, code: e.code, ...(e.details ? { details: e.details } : {}) });

/** The users and pending invitations the caller reaches, with status, last sign-in and the roles by the names of their scopes. */
export async function listUsersAction(options?: { tenantId?: string }) {
  const access = await gate("user.manage");
  if (!access.ok) return { error: access.error };
  const result = await listUsers(access.ctx, options);
  if (!result.success) return failure(result.error);
  return { success: true as const, data: result.data };
}

/** Users by scopes for one tenant (the tenant in view when none is named). */
export async function getRoleMatrixAction(tenantId?: string) {
  const access = await gate("user.manage");
  if (!access.ok) return { error: access.error };
  const result = await getRoleMatrix(tenantId ?? (access.ctx.tenantId as string), access.ctx);
  if (!result.success) return failure(result.error);
  return { success: true as const, data: result.data };
}

/** The places the caller may grant a role in (tenants, domains, products, with the roles accepted there) and whether platform scope is theirs to grant: fills the scope pickers. */
export async function getGrantableScopesAction() {
  const access = await gate("user.manage");
  if (!access.ok) return { error: access.error };
  const result = await listGrantableScopes(access.ctx);
  if (!result.success) return failure(result.error);
  return { success: true as const, data: result.data };
}

export async function listPendingInvitationsAction() {
  const access = await gate("user.manage");
  if (!access.ok) return { error: access.error };
  const result = await listPendingInvitations(access.ctx);
  if (!result.success) return failure(result.error);
  return { success: true as const, data: result.data };
}

/** Invite a person by link: the answer carries the one-time link (shown once) and its expiry. */
export async function inviteUserAction(input: InviteUserInput) {
  const access = await gate("user.manage");
  if (!access.ok) return { error: access.error };
  const result = await inviteUser(input, access.ctx);
  if (!result.success) return failure(result.error);
  revalidateSchemas();
  return { success: true as const, data: result.data };
}

export async function revokeInvitationAction(invitationId: string) {
  const access = await gate("user.manage");
  if (!access.ok) return { error: access.error };
  const result = await revokeInvitation(invitationId, access.ctx);
  if (!result.success) return failure(result.error);
  revalidateSchemas();
  return { success: true as const };
}

/** Disable (true) or enable (false) an account. Accounts are never deleted. */
export async function setUserDisabledAction(userId: string, disabled: boolean) {
  const access = await gate("user.manage");
  if (!access.ok) return { error: access.error };
  const result = await setUserDisabled(userId, disabled, access.ctx);
  if (!result.success) return failure(result.error);
  revalidateSchemas();
  return { success: true as const, data: result.data };
}

/** A one-hour link for a person to set a new password: the answer carries it (shown once). */
export async function createResetLinkAction(userId: string) {
  const access = await gate("user.manage");
  if (!access.ok) return { error: access.error };
  const result = await createResetLink(userId, access.ctx);
  if (!result.success) return failure(result.error);
  return { success: true as const, data: result.data };
}

export async function getHealthAction() {
  const access = await gate("platform.admin");
  if (!access.ok) return { error: access.error };
  const { ctx } = access;
  const [health, usage, activity, errors] = await Promise.all([
    runHealthCheck(ctx, { detail: "admin" }),
    getUsageMetrics(ctx),
    // The governance count is the dashboard's: the requests of the tenant being viewed.
    getActivityMetrics(ctx, await getActiveTenantId()),
    getErrorSummary(ctx),
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
  const access = await gate("emitter.manage");
  if (!access.ok) return { error: access.error };
  const result = await getEmitterConfigs(access.ctx);
  if (!result.success) return { error: result.error.message };
  return { success: true as const, data: result.data };
}

export async function updateEmitterConfigAction(input: UpdateEmitterConfigInput) {
  const access = await gate("emitter.manage");
  if (!access.ok) return { error: access.error };
  const result = await updateEmitterConfig(input, access.ctx);
  if (!result.success) return { error: result.error.message };
  revalidateSchemas();
  return { success: true as const, data: result.data };
}

export async function getDomainsAdminAction() {
  const access = await gate("tenant.access");
  if (!access.ok) return { error: access.error };
  const result = await getDomainsAdmin(access.ctx);
  if (!result.success) return { error: result.error.message };
  return { success: true as const, data: result.data };
}

export async function createDomainAdminAction(input: CreateDomainAdminInput) {
  const access = await gate("domain.create");
  if (!access.ok) return { error: access.error };
  const result = await createDomainAdmin(input, access.ctx);
  if (!result.success) return { error: result.error.message };
  revalidateSchemas();
  return { success: true as const, data: result.data };
}

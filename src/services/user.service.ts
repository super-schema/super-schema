/**
 * User Management Service — user reads and name edits, with role data, for whoever administers users (`user.manage`).
 *
 * Who sees whom: a PLATFORM administrator (global ADMIN) sees every user with every role; a TENANT administrator sees the users who hold a role
 * somewhere in the tenant in view (`ctx.tenantId`) and, of those, only the roles held in that tenant, never another tenant's or a platform role.
 * A user outside the tenant reads exactly like a missing one. A context with no tenant in view and no platform role is refused.
 *
 * Users and their roles live in the database (`users`, `user_roles`) and are read through `ctx.prisma`; the service keeps no
 * state of its own, so what the Admin page lists is what the database holds, across requests and restarts.
 * All service functions return Result<T>.
 */

import { ctxCan } from "@/lib/access";
import { loadActorAssignments } from "@/lib/access/granter";
import { AuditUserMissingError, withAudit } from "@/lib/audit";
import { resetLink } from "@/lib/auth/links";
import { insertResetToken } from "@/lib/auth/tokens";
import { runSerializable } from "@/lib/serializable-transaction";
import { ok, err } from "@/types/result";
import type { Result } from "@/types/result";
import type { ServiceContext } from "@/types/service-context";
import type { UserWithRoles } from "@/types/schemas/rbac";
import type { Role } from "@/types/schemas/rbac";
import { UpdateUserInputSchema, type UpdateUserInput } from "@/types/schemas/user";
import type { ResetLinkResult, SetUserDisabledResult } from "@/types/schemas/user-admin";
import {
  GRANTING_ROLE,
  administeredBy,
  administersSomething,
  answering,
  commonTenantId,
  forbidden as genericForbidden,
  isAdministrative,
  reaches,
  userNotFound as genericUserNotFound,
} from "./admin-shared";

// The administration of the user list and of invitations lives next to this file and is re-exported here, so the one place to import from is this one.
export { inviteUser, listPendingInvitations, revokeInvitation } from "./invitation.service";
export { getRoleMatrix, listUsers } from "./user-directory.service";

/** The columns a user row exposes here. Never the password hash. */
export interface UserRecord {
  id: string;
  name: string | null;
  email: string;
  image: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const USER_SELECT = { id: true, name: true, email: true, image: true, createdAt: true } as const;

type RoleRow = { id: string; userId: string; role: string; domainId: string | null; domain: { name: string } | null };

const forbidden = () =>
  err({
    code: "FORBIDDEN",
    message: "Requires ADMIN role",
    suggestedFix: "Contact your administrator",
  });

const userNotFound = (id: string) =>
  err({
    code: "NOT_FOUND",
    message: `User with ID "${id}" not found`,
    suggestedFix: "Verify the user ID and try again.",
  });

function toRoles(rows: RoleRow[]): UserWithRoles["roles"] {
  return rows.map((r) => ({
    id: r.id,
    role: r.role as Role,
    domainId: r.domainId,
    // A system-level role has no domain, so no name.
    domainName: r.domain?.name,
  }));
}

/**
 * What the caller may administer: a platform administrator everything (`tenantId` null), a tenant administrator the tenant in view, nobody
 * else (null: refused). The answer names the tenant the user rows and role rows are restricted to.
 */
function administeredScope(ctx: ServiceContext): { tenantId: string | null } | null {
  if (ctxCan(ctx, "platform.admin")) return { tenantId: null };
  if (ctx.tenantId !== undefined && ctxCan(ctx, "user.manage", { tenantId: ctx.tenantId })) return { tenantId: ctx.tenantId };
  return null;
}

/** The role rows of the given users, with the name of the domain a role is scoped to; with a tenant, only the roles held in that tenant. */
async function loadRoles(ctx: ServiceContext, userIds: string[], tenantId: string | null): Promise<RoleRow[]> {
  if (userIds.length === 0) return [];
  return ctx.prisma.userRole.findMany({
    where: { userId: { in: userIds }, ...(tenantId !== null && { tenantId }) },
    include: { domain: { select: { name: true } } },
    orderBy: { createdAt: "asc" },
  });
}

// ---------------------------------------------------------------------------
// getUsers — fetch all users with their roles (Admin only)
// ---------------------------------------------------------------------------

export async function getUsers(
  ctx: ServiceContext
): Promise<Result<UserWithRoles[]>> {
  const scope = administeredScope(ctx);
  if (!scope) return forbidden();

  const users = await ctx.prisma.user.findMany({
    where: scope.tenantId === null ? {} : { roles: { some: { tenantId: scope.tenantId } } },
    select: USER_SELECT,
    orderBy: { createdAt: "asc" },
  });
  const roles = await loadRoles(
    ctx,
    users.map((u) => u.id),
    scope.tenantId
  );

  return ok(
    users.map((u) => ({
      id: u.id,
      name: u.name,
      email: u.email,
      image: u.image,
      createdAt: u.createdAt,
      roles: toRoles(roles.filter((r) => r.userId === u.id)),
    }))
  );
}

// ---------------------------------------------------------------------------
// getUserById — fetch single user with roles (Admin only)
// ---------------------------------------------------------------------------

export async function getUserById(
  id: string,
  ctx: ServiceContext
): Promise<Result<UserWithRoles>> {
  const scope = administeredScope(ctx);
  if (!scope) return forbidden();

  // A user of no role in the tenant in view is, to a tenant administrator, a user that does not exist.
  const user = await ctx.prisma.user.findFirst({
    where: scope.tenantId === null ? { id } : { id, roles: { some: { tenantId: scope.tenantId } } },
    select: USER_SELECT,
  });
  if (!user) return userNotFound(id);

  const roles = await loadRoles(ctx, [user.id], scope.tenantId);
  return ok({
    id: user.id,
    name: user.name,
    email: user.email,
    image: user.image,
    createdAt: user.createdAt,
    roles: toRoles(roles),
  });
}

// ---------------------------------------------------------------------------
// updateUser — update user name (Admin only)
// ---------------------------------------------------------------------------

export async function updateUser(
  input: UpdateUserInput,
  ctx: ServiceContext
): Promise<Result<UserRecord>> {
  // Nobody learns what a valid input looks like without the right to change a name: your own is yours (`profile.own`), another's needs `user.manage`.
  const namesSelf = typeof input === "object" && input !== null && (input as { id?: unknown }).id === ctx.userId;
  if (!namesSelf && !administeredScope(ctx)) return forbidden();

  const parsed = UpdateUserInputSchema.safeParse(input);
  if (!parsed.success) {
    return err({
      code: "VALIDATION_ERROR",
      message: parsed.error.issues[0].message,
      suggestedFix: "Check the user input fields.",
    });
  }

  // Your own name is yours to change (`profile.own`); another user's is for whoever administers users (`user.manage`), and for a tenant
  // administrator only a user who holds a role in the tenant in view (any other reads as missing).
  const isSelf = parsed.data.id === ctx.userId;
  const scope = isSelf ? { tenantId: null } : administeredScope(ctx);
  if (!scope) return forbidden();

  const existing = await ctx.prisma.user.findFirst({
    where: scope.tenantId === null ? { id: parsed.data.id } : { id: parsed.data.id, roles: { some: { tenantId: scope.tenantId } } },
    select: { id: true, name: true },
  });
  if (!existing) return userNotFound(parsed.data.id);

  try {
    // A change of a user's name is audited like the other admin changes: the entry carries the name as it was.
    const updated = await withAudit({
      action: "UPDATE",
      entityType: "User",
      entityId: existing.id,
      userId: ctx.userId,
      // The tenant a tenant administrator acts in; a platform administrator's (and your own) rename is a platform-level entry.
      tenantId: scope.tenantId,
      beforeState: { name: existing.name },
      fn: () =>
        ctx.prisma.user.update({
          where: { id: existing.id },
          data: parsed.data.name !== undefined ? { name: parsed.data.name } : {},
          select: { ...USER_SELECT, updatedAt: true },
        }),
    });
    return ok(updated);
  } catch (e: unknown) {
    // The session of the acting admin names a user that no longer exists: the audit entry cannot be written.
    if (e instanceof AuditUserMissingError) {
      return err({ code: "UNAUTHORIZED", message: "Your session is stale. Sign out and sign in again, then retry.", suggestedFix: "Sign out and sign in again." });
    }
    // P2025: "an operation failed because it depends on one or more records that were required but not found" (deleted since the read).
    if (typeof e === "object" && e !== null && (e as { code?: unknown }).code === "P2025") return userNotFound(parsed.data.id);
    throw e;
  }
}

// ---------------------------------------------------------------------------
// The life cycle of an account: disable / enable, and a link to set a new password
//
// An account is NEVER deleted by this service or any other: audit rows point at their user and are immutable, so a user who has done anything cannot be
// removed. A person who must lose access is DISABLED (they are refused at sign-in and on the next request: the principal loader checks `disabledAt`).
//
// Who may do this to whom: a platform administrator to anyone; a tenant administrator to a user who holds at least one role in a tenant they administer and
// whose EVERY role lies in tenants they administer (`reaches`). A user outside that reach answers exactly like a user that does not exist. The actor is read
// from the database inside the SERIALIZABLE transaction that decides, like `assignRole`, and the entry that records the change is written in it.
// ---------------------------------------------------------------------------

/**
 * Disables (`disabled` true) or enables (false) an account. Refusals: `FORBIDDEN` (the actor administers nothing, or tries to disable THEMSELVES, or to
 * disable the LAST enabled platform administrator: the platform must keep one), `NOT_FOUND` (no such user, or one outside the actor's reach: one answer).
 * Disabling also ends the user's outstanding reset links (a disabled account cannot be reset, and a link must not outlive the decision). Doing what is
 * already done changes nothing and writes nothing (`changed: false`). Audited as `USER_DISABLED` / `USER_ENABLED`, by the actor, in the tenant the
 * user's roles share (none when they span tenants or hold a platform role).
 */
export async function setUserDisabled(userId: string, disabled: boolean, ctx: ServiceContext): Promise<Result<SetUserDisabledResult>> {
  if (typeof disabled !== "boolean") {
    return err({ code: "VALIDATION_ERROR", message: "Say whether the account is to be disabled or enabled.", suggestedFix: "Pass true to disable, false to enable." });
  }
  return answering("setUserDisabled", () =>
    runSerializable(async (tx): Promise<Result<SetUserDisabledResult>> => {
      const actor = await loadActorAssignments(tx, ctx.userId);
      const administered = actor ? administeredBy(actor) : null;
      if (!actor || !administered || !administersSomething(administered)) return genericForbidden();

      // Nobody disables themselves (an administrator who locks themselves out cannot undo it): said before any look-up, it reveals nothing about anyone.
      if (disabled && userId === ctx.userId) {
        return err({ code: "FORBIDDEN", message: "You cannot disable your own account", suggestedFix: "Ask another administrator." });
      }

      const target =
        typeof userId === "string" && userId.trim() !== ""
          ? await tx.user.findUnique({ where: { id: userId }, select: { id: true, disabledAt: true, roles: { select: { role: true, scopeKey: true, tenantId: true } } } })
          : null;
      if (!target || !reaches(administered, target.roles)) return genericUserNotFound();

      if ((target.disabledAt !== null) === disabled) return ok({ userId: target.id, disabled, changed: false, revokedResetLinks: 0 });

      if (disabled && target.roles.some((row) => row.scopeKey === "G" && isAdministrative(row.role))) {
        // The platform keeps one enabled administrator. Read inside this SERIALIZABLE transaction: two administrators disabling each other at the same
        // moment cannot both pass (one of them is run again, finds the other already disabled, and is refused).
        const others = await tx.userRole.count({ where: { role: GRANTING_ROLE, scopeKey: "G", userId: { not: target.id }, user: { disabledAt: null } } });
        if (others < 1) {
          return err({
            code: "FORBIDDEN",
            message: "Cannot disable the last platform administrator: at least one must stay enabled",
            suggestedFix: "Make another user a platform administrator first.",
          });
        }
      }

      const now = new Date();
      await tx.user.update({ where: { id: target.id }, data: { disabledAt: disabled ? now : null } });
      let revokedResetLinks = 0;
      if (disabled) {
        revokedResetLinks = await tx.authToken.count({ where: { userId: target.id, kind: "RESET", usedAt: null, expiresAt: { gt: now } } });
        await tx.authToken.updateMany({ where: { userId: target.id, kind: "RESET", usedAt: null }, data: { usedAt: now } });
      }
      await tx.auditLog.create({
        data: {
          action: disabled ? "USER_DISABLED" : "USER_ENABLED",
          entityType: "User",
          entityId: target.id,
          userId: ctx.userId,
          tenantId: commonTenantId(target.roles.map((row) => row.tenantId)),
          beforeState: { disabledAt: target.disabledAt ? target.disabledAt.toISOString() : null },
          afterState: { disabledAt: disabled ? now.toISOString() : null, ...(disabled ? { revokedResetLinks } : {}) },
        },
      });
      return ok({ userId: target.id, disabled, changed: true, revokedResetLinks });
    })
  );
}

/**
 * A link that lets a person set a new password (valid one hour; there is no e-mail service, so the administrator hands it over). Same authority as
 * `setUserDisabled`; any earlier reset link of that user stops working (only one is ever live). A DISABLED account cannot be reset (its link would be dead
 * on use): enable it first. Audited (`PASSWORD_RESET_ISSUED`, by the actor, in the tenant the user's roles share), the token only ever shown here.
 */
export async function createResetLink(userId: string, ctx: ServiceContext): Promise<Result<ResetLinkResult>> {
  return answering("createResetLink", () =>
    runSerializable(async (tx): Promise<Result<ResetLinkResult>> => {
      const actor = await loadActorAssignments(tx, ctx.userId);
      const administered = actor ? administeredBy(actor) : null;
      if (!actor || !administered || !administersSomething(administered)) return genericForbidden();

      const target =
        typeof userId === "string" && userId.trim() !== ""
          ? await tx.user.findUnique({ where: { id: userId }, select: { id: true, disabledAt: true, roles: { select: { role: true, scopeKey: true, tenantId: true } } } })
          : null;
      if (!target || !reaches(administered, target.roles)) return genericUserNotFound();
      if (target.disabledAt !== null) {
        return err({ code: "VALIDATION_ERROR", message: "This account is disabled. Enable it before making a reset link.", suggestedFix: "Enable the account, then make the link." });
      }

      const made = await insertResetToken(tx, {
        userId: target.id,
        issuedById: ctx.userId,
        tenantId: commonTenantId(target.roles.map((row) => row.tenantId)),
        revokeOthers: true,
      });
      if (!made.success) return genericUserNotFound();
      return ok({ userId: target.id, token: made.data.token, ...resetLink(made.data.token), expiresAt: made.data.expiresAt, invalidatedLinks: made.data.invalidatedLinks });
    })
  );
}

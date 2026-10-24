/**
 * User Management Service — Admin-only user reads and name edits, with role data.
 *
 * Users and their roles live in the database (`users`, `user_roles`) and are read through `ctx.prisma`; the service keeps no
 * state of its own, so what the Admin page lists is what the database holds, across requests and restarts.
 * All service functions return Result<T>.
 */

import { AuditUserMissingError, withAudit } from "@/lib/audit";
import { ok, err } from "@/types/result";
import type { Result } from "@/types/result";
import type { ServiceContext } from "@/types/service-context";
import type { UserWithRoles } from "@/types/schemas/rbac";
import type { Role } from "@/types/schemas/rbac";
import { UpdateUserInputSchema, type UpdateUserInput } from "@/types/schemas/user";

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

/** The role rows of the given users, with the name of the domain a role is scoped to. */
async function loadRoles(ctx: ServiceContext, userIds: string[]): Promise<RoleRow[]> {
  if (userIds.length === 0) return [];
  return ctx.prisma.userRole.findMany({
    where: { userId: { in: userIds } },
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
  if (ctx.userRole !== "ADMIN") return forbidden();

  const users = await ctx.prisma.user.findMany({ select: USER_SELECT, orderBy: { createdAt: "asc" } });
  const roles = await loadRoles(
    ctx,
    users.map((u) => u.id)
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
  if (ctx.userRole !== "ADMIN") return forbidden();

  const user = await ctx.prisma.user.findUnique({ where: { id }, select: USER_SELECT });
  if (!user) return userNotFound(id);

  const roles = await loadRoles(ctx, [user.id]);
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
  if (ctx.userRole !== "ADMIN") return forbidden();

  const parsed = UpdateUserInputSchema.safeParse(input);
  if (!parsed.success) {
    return err({
      code: "VALIDATION_ERROR",
      message: parsed.error.issues[0].message,
      suggestedFix: "Check the user input fields.",
    });
  }

  const existing = await ctx.prisma.user.findUnique({ where: { id: parsed.data.id }, select: { id: true, name: true } });
  if (!existing) return userNotFound(parsed.data.id);

  try {
    // A change of a user's name is audited like the other admin changes: the entry carries the name as it was.
    const updated = await withAudit({
      action: "UPDATE",
      entityType: "User",
      entityId: existing.id,
      userId: ctx.userId,
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

/**
 * RBAC Service — Role-Based Access Control business logic.
 *
 * Manages user roles, permission checks, and the bootstrap mechanism
 * for the first admin user. All service functions return Result<T>.
 *
 * Persistence: Prisma `userRole` table.
 */

import { prisma } from "@/lib/db";
import { ok, err } from "@/types/result";
import type { Result } from "@/types/result";
import type { ServiceContext } from "@/types/service-context";
import {
  ROLE_HIERARCHY,
  SYSTEM_ONLY_ROLES,
  DOMAIN_SCOPED_ROLES,
  AssignRoleInputSchema,
  type Role,
  type UserRole,
  type AssignRoleInput,
} from "@/types/schemas/rbac";

// ---------------------------------------------------------------------------
// Test helpers (no-ops — Prisma is mocked in tests)
// ---------------------------------------------------------------------------

/** Reset store — no-op, kept for backward compatibility with tests. */
export async function _resetRoleStore(): Promise<void> {
  await prisma.userRole.deleteMany();
}

/** Direct access to store — for testing only. Returns all roles from DB. */
export async function _getRoleStore(): Promise<UserRole[]> {
  const rows = await prisma.userRole.findMany();
  return rows.map(toUserRole);
}

// ---------------------------------------------------------------------------
// Prisma row → app UserRole mapper
// ---------------------------------------------------------------------------

function toUserRole(row: {
  id: string;
  userId: string;
  role: string;
  domainId: string | null;
  createdAt: Date;
}): UserRole {
  return {
    id: row.id,
    userId: row.userId,
    role: row.role as Role,
    domainId: row.domainId,
    createdAt: row.createdAt,
  };
}

// ---------------------------------------------------------------------------
// getUserRoles — fetch all roles for a user
// ---------------------------------------------------------------------------

export async function getUserRoles(
  userId: string,
  _ctx: ServiceContext
): Promise<Result<UserRole[]>> {
  const rows = await prisma.userRole.findMany({ where: { userId } });
  return ok(rows.map(toUserRole));
}

// ---------------------------------------------------------------------------
// assignRole — assign a role to a user
// ---------------------------------------------------------------------------

export async function assignRole(
  input: AssignRoleInput,
  ctx: ServiceContext
): Promise<Result<UserRole>> {
  // Validate input
  const parsed = AssignRoleInputSchema.safeParse(input);
  if (!parsed.success) {
    return err({
      code: "VALIDATION_ERROR",
      message: parsed.error.issues[0].message,
      suggestedFix: "Check the role assignment input fields.",
    });
  }

  const { userId, role, domainId } = parsed.data;

  // RBAC: require Admin role
  if (ctx.userRole !== "ADMIN") {
    return err({
      code: "FORBIDDEN",
      message: "Requires ADMIN role",
      suggestedFix: "Contact your administrator",
    });
  }

  // Enforce: COMPLIANCE_OFFICER and ADMIN must be system-level
  if (SYSTEM_ONLY_ROLES.includes(role as Role) && domainId) {
    return err({
      code: "VALIDATION_ERROR",
      message: `${role} must be a system-level role (no domainId)`,
      suggestedFix: `Remove the domainId when assigning ${role} role.`,
    });
  }

  // Enforce: VIEWER, AUTHOR, STEWARD require domainId
  if (DOMAIN_SCOPED_ROLES.includes(role as Role) && !domainId) {
    return err({
      code: "VALIDATION_ERROR",
      message: `${role} requires a domainId`,
      suggestedFix: `Provide a domainId when assigning ${role} role.`,
    });
  }

  // The role row has a foreign key to its domain: a domain that does not exist is said, not left to the database to refuse.
  if (domainId) {
    const domain = await prisma.domain.findUnique({ where: { id: domainId }, select: { id: true } });
    if (!domain) {
      return err({
        code: "NOT_FOUND",
        message: `Domain "${domainId}" not found`,
        suggestedFix: "Use the id of an existing domain.",
      });
    }
  }

  // Prevent duplicate role assignments
  const existing = await prisma.userRole.findFirst({
    where: {
      userId,
      role,
      domainId: domainId ?? null,
    },
  });
  if (existing) {
    return err({
      code: "DUPLICATE",
      message: `User already has ${role} role${domainId ? ` for domain ${domainId}` : " at system level"}`,
      suggestedFix: "This role assignment already exists.",
    });
  }

  const created = await prisma.userRole.create({
    data: {
      userId,
      role,
      domainId: domainId ?? null,
    },
  });

  return ok(toUserRole(created));
}

// ---------------------------------------------------------------------------
// removeRole — remove a role assignment
// ---------------------------------------------------------------------------

export async function removeRole(
  id: string,
  ctx: ServiceContext
): Promise<Result<void>> {
  // RBAC: require Admin role
  if (ctx.userRole !== "ADMIN") {
    return err({
      code: "FORBIDDEN",
      message: "Requires ADMIN role",
      suggestedFix: "Contact your administrator",
    });
  }

  const roleRow = await prisma.userRole.findUnique({ where: { id } });
  if (!roleRow) {
    return err({
      code: "NOT_FOUND",
      message: "Role assignment not found",
      suggestedFix: "Verify the role assignment ID.",
    });
  }

  // Safety: admin cannot remove their own Admin role
  if (roleRow.role === "ADMIN" && roleRow.userId === ctx.userId) {
    return err({
      code: "FORBIDDEN",
      message: "Cannot remove your own admin role",
      suggestedFix: "Ask another admin to remove your role if needed.",
    });
  }

  // Safety: ensure at least one Admin remains
  if (roleRow.role === "ADMIN") {
    const adminCount = await prisma.userRole.count({
      where: { role: "ADMIN" },
    });
    if (adminCount <= 1) {
      return err({
        code: "FORBIDDEN",
        message: "Cannot remove the last admin role — at least one admin must remain",
        suggestedFix: "Assign another user as Admin before removing this one.",
      });
    }
  }

  await prisma.userRole.delete({ where: { id } });
  return ok(undefined);
}

// ---------------------------------------------------------------------------
// getEffectiveRole — determine the most permissive role for a user + domain
// ---------------------------------------------------------------------------

export async function getEffectiveRole(
  userId: string,
  domainId: string | null,
  _ctx: ServiceContext
): Promise<Result<Role | null>> {
  const userRoles = await prisma.userRole.findMany({
    where: { userId },
  });

  if (userRoles.length === 0) {
    return ok(null);
  }

  // Filter to applicable roles:
  // - system-level roles (domainId === null) apply everywhere
  // - domain-specific roles apply only within their domain
  const applicable = userRoles.filter(
    (r) => r.domainId === null || r.domainId === domainId
  );

  if (applicable.length === 0) {
    return ok(null);
  }

  // Return the most permissive (highest in hierarchy)
  let maxIndex = -1;
  let maxRole: Role | null = null;

  for (const r of applicable) {
    const idx = ROLE_HIERARCHY.indexOf(r.role as Role);
    if (idx > maxIndex) {
      maxIndex = idx;
      maxRole = r.role as Role;
    }
  }

  return ok(maxRole);
}

// ---------------------------------------------------------------------------
// hasPermission — check if user has at least the required role level
// ---------------------------------------------------------------------------

export async function hasPermission(
  userId: string,
  requiredRole: Role,
  domainId: string | null,
  ctx: ServiceContext
): Promise<Result<boolean>> {
  const effectiveResult = await getEffectiveRole(userId, domainId, ctx);
  if (!effectiveResult.success) return effectiveResult;

  const effectiveRole = effectiveResult.data;
  if (!effectiveRole) return ok(false);

  const effectiveIndex = ROLE_HIERARCHY.indexOf(effectiveRole);
  const requiredIndex = ROLE_HIERARCHY.indexOf(requiredRole);

  return ok(effectiveIndex >= requiredIndex);
}

// ---------------------------------------------------------------------------
// bootstrapFirstAdmin — assign ADMIN to first user if none exist
// ---------------------------------------------------------------------------

export async function bootstrapFirstAdmin(
  userId: string,
  _ctx: ServiceContext
): Promise<Result<void>> {
  const adminCount = await prisma.userRole.count({
    where: { role: "ADMIN" },
  });
  if (adminCount > 0) {
    return ok(undefined);
  }

  await prisma.userRole.create({
    data: {
      userId,
      role: "ADMIN",
      domainId: null,
    },
  });

  return ok(undefined);
}

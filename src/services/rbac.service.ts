/**
 * RBAC Service — Role-Based Access Control business logic.
 *
 * Manages user roles and permission checks. All service functions return Result<T>. The first
 * administrator is NOT made here (or by any request): see `src/lib/admin-bootstrap.ts`.
 *
 * Persistence: Prisma `userRole` table. A row's scope is its `scopeKey` (`G`, `T:<tenantId>`, `D:<domainId>`, `P:<productId>`,
 * src/lib/access/scope.ts); this legacy service still deals in the global and domain scopes only (the scoped role screens, Task 7).
 */

import { prisma } from "@/lib/db";
import { scopeKey } from "@/lib/access/scope";
import { assignmentsFromRows } from "@/lib/access/assignments";
import { effectiveRole as policyRole, globalRole, roleAtLeast } from "@/lib/access/policy";
import { ok, err } from "@/types/result";
import type { Result } from "@/types/result";
import type { ServiceContext } from "@/types/service-context";
import {
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
  // Its tenant is read here too: a domain-scoped row carries its tenant (the key and the columns must say the same scope).
  let key = scopeKey({ kind: "GLOBAL" });
  let tenantId: string | null = null;
  if (domainId) {
    const domain = await prisma.domain.findUnique({ where: { id: domainId }, select: { id: true, tenantId: true } });
    if (!domain) {
      return err({
        code: "NOT_FOUND",
        message: `Domain "${domainId}" not found`,
        suggestedFix: "Use the id of an existing domain.",
      });
    }
    tenantId = domain.tenantId;
    key = scopeKey({ kind: "DOMAIN", tenantId: domain.tenantId, domainId: domain.id });
  }

  // The role row has a foreign key to its user too: an id that is nobody's is said, and not thrown out of the action as the database's P2003.
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
  if (!user) {
    return err({
      code: "NOT_FOUND",
      message: `User "${userId}" not found`,
      suggestedFix: "Use the id of an existing user.",
    });
  }

  // Prevent duplicate role assignments
  const existing = await prisma.userRole.findFirst({
    where: {
      userId,
      role,
      scopeKey: key,
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
      scopeKey: key,
      tenantId,
      domainId: domainId ?? null,
      grantedById: ctx.userId,
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

  // Safety: ensure at least one global (platform) Admin remains
  if (roleRow.role === "ADMIN" && roleRow.scopeKey === scopeKey({ kind: "GLOBAL" })) {
    const adminCount = await prisma.userRole.count({
      where: { role: "ADMIN", scopeKey: roleRow.scopeKey },
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
// getEffectiveRole — the role a user holds, by the policy engine
// ---------------------------------------------------------------------------

/**
 * The highest role the user holds over a domain (`domainId`) or, with no domain, at the platform (global) scope. A thin reading of the
 * policy (`@/lib/access`): the user's valid assignments, judged by `effectiveRole` against the domain and the tenant it lives in, so a
 * global role applies everywhere, a tenant role in every domain of its tenant, a domain role in its domain, and nothing across tenants.
 * A disabled user holds no role. New code asks `authorize` (src/lib/action-context.ts) for a decision; this stays for the callers that
 * still read a role (Task 5 migrates them).
 */
export async function getEffectiveRole(
  userId: string,
  domainId: string | null,
  _ctx: ServiceContext
): Promise<Result<Role | null>> {
  const userRoles = await prisma.userRole.findMany({
    where: { userId, user: { disabledAt: null } },
  });

  const assignments = assignmentsFromRows(userRoles);
  if (assignments.length === 0) {
    return ok(null);
  }

  // No domain asked about, or nothing but platform roles: the global role is the answer, no look-up needed.
  if (!domainId || assignments.every((a) => a.scope.kind === "GLOBAL")) {
    return ok(globalRole(assignments));
  }

  const domain = await prisma.domain.findUnique({ where: { id: domainId }, select: { tenantId: true } });
  if (!domain) {
    return ok(globalRole(assignments));
  }
  return ok(policyRole(assignments, { tenantId: domain.tenantId, domainId }));
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

  return ok(roleAtLeast(effectiveResult.data, requiredRole));
}

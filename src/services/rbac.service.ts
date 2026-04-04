/**
 * RBAC Service — Role-Based Access Control business logic.
 *
 * Manages user roles, permission checks, and the bootstrap mechanism
 * for the first admin user. All service functions return Result<T>.
 */

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
// In-memory role store (MVP — skipping Prisma migration per instructions)
// ---------------------------------------------------------------------------

let roleStore: UserRole[] = [];
let nextId = 1;

/** Reset store — for testing only */
export function _resetRoleStore(): void {
  roleStore = [];
  nextId = 1;
}

/** Direct access to store — for testing only */
export function _getRoleStore(): UserRole[] {
  return roleStore;
}

// ---------------------------------------------------------------------------
// getUserRoles — fetch all roles for a user
// ---------------------------------------------------------------------------

export async function getUserRoles(
  userId: string,
  _ctx: ServiceContext
): Promise<Result<UserRole[]>> {
  const roles = roleStore.filter((r) => r.userId === userId);
  return ok(roles);
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

  // Prevent duplicate role assignments
  const existing = roleStore.find(
    (r) =>
      r.userId === userId &&
      r.role === role &&
      r.domainId === (domainId ?? null)
  );
  if (existing) {
    return err({
      code: "DUPLICATE",
      message: `User already has ${role} role${domainId ? ` for domain ${domainId}` : " at system level"}`,
      suggestedFix: "This role assignment already exists.",
    });
  }

  const userRole: UserRole = {
    id: `role-${nextId++}`,
    userId,
    role: role as Role,
    domainId: domainId ?? null,
    createdAt: new Date(),
  };

  roleStore.push(userRole);
  return ok(userRole);
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

  const roleIndex = roleStore.findIndex((r) => r.id === id);
  if (roleIndex === -1) {
    return err({
      code: "NOT_FOUND",
      message: "Role assignment not found",
      suggestedFix: "Verify the role assignment ID.",
    });
  }

  const role = roleStore[roleIndex];

  // Safety: admin cannot remove their own Admin role
  if (role.role === "ADMIN" && role.userId === ctx.userId) {
    return err({
      code: "FORBIDDEN",
      message: "Cannot remove your own admin role",
      suggestedFix: "Ask another admin to remove your role if needed.",
    });
  }

  // Safety: ensure at least one Admin remains
  if (role.role === "ADMIN") {
    const adminCount = roleStore.filter((r) => r.role === "ADMIN").length;
    if (adminCount <= 1) {
      return err({
        code: "FORBIDDEN",
        message: "Cannot remove the last admin role — at least one admin must remain",
        suggestedFix: "Assign another user as Admin before removing this one.",
      });
    }
  }

  roleStore.splice(roleIndex, 1);
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
  const userRoles = roleStore.filter((r) => r.userId === userId);

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
    const idx = ROLE_HIERARCHY.indexOf(r.role);
    if (idx > maxIndex) {
      maxIndex = idx;
      maxRole = r.role;
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
  ctx: ServiceContext
): Promise<Result<void>> {
  const hasAdmin = roleStore.some((r) => r.role === "ADMIN");
  if (hasAdmin) {
    return ok(undefined);
  }

  const adminRole: UserRole = {
    id: `role-${nextId++}`,
    userId,
    role: "ADMIN",
    domainId: null,
    createdAt: new Date(),
  };

  roleStore.push(adminRole);
  return ok(undefined);
}

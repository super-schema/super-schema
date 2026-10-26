/**
 * RBAC Service — Role-Based Access Control business logic.
 *
 * Manages user roles and permission checks. All service functions return Result<T> and never throw. The first
 * administrator is NOT made here (or by any request): see `src/lib/admin-bootstrap.ts`.
 *
 * Persistence: Prisma `userRole` table. A row's scope is its `scopeKey` (`G`, `T:<tenantId>`, `D:<domainId>`, `P:<productId>`,
 * src/lib/access/scope.ts). `assignRole` and `removeRole` (`revokeRole`) decide for themselves whether the CALLER may grant or revoke: they read the
 * caller's assignments by id inside their transaction and ask the policy (`grantAllowed`), whatever label or context the caller hands in. Every grant
 * and revoke writes an audit entry (`ROLE_ASSIGNED` / `ROLE_REMOVED`) in the SAME transaction: the change and its record commit or roll back together.
 * The role matrix (users x scopes) is `getRoleMatrix` (`./user-directory.service`).
 */

import { prisma } from "@/lib/db";
import { scopeKey } from "@/lib/access/scope";
import { assignmentsFromRows } from "@/lib/access/assignments";
import { loadActorAssignments } from "@/lib/access/granter";
import { effectiveRole as policyRole, globalRole, grantAllowed, roleAtLeast } from "@/lib/access/policy";
import { isValidAssignment } from "@/lib/access/scope";
import { runSerializable } from "@/lib/serializable-transaction";
import { ok, err } from "@/types/result";
import type { Result } from "@/types/result";
import type { ServiceContext } from "@/types/service-context";
import { AssignRoleInputSchema, type Role, type UserRole, type AssignRoleInput } from "@/types/schemas/rbac";
import {
  GRANTING_ROLE,
  answering,
  describeScope,
  forbidden,
  holdsGrantingRole,
  isAdministrative,
  isPlatformAdmin,
  resolveTarget,
  roleSummary,
  scopeColumns,
} from "./admin-shared";

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

/**
 * Assign `role` to a user at the scope the input names (platform when it names none). The CALLER is judged here, from their own stored
 * assignments (`ctx.userId` only: neither `ctx.userRole` nor anything else the caller passes counts): only an ADMIN whose scope covers the
 * target scope grants there, nobody grants above their own role (`grantAllowed`), and a platform (GLOBAL) assignment is valid for ADMIN only
 * (`isValidAssignment`). The scope is completed from the stored rows (a domain or product that does not exist, or that is not in the tenant the input
 * says, is a NOT_FOUND for a platform administrator and the generic refusal for anyone else). One SERIALIZABLE transaction, run again when it loses a
 * race, so a grant judged against a granter who is demoted at the same moment is judged again; the audit entry is written in it.
 */
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

  const { userId, role, tenantId, domainId, productId } = parsed.data;

  return answering("assignRole", () =>
    runSerializable(async (tx): Promise<Result<UserRole>> => {
      // WHO is granting: their stored assignments. Nobody holding the granting role anywhere is refused before any look-up of the target.
      const granter = await loadActorAssignments(tx, ctx.userId);
      if (!granter || !holdsGrantingRole(granter)) return forbidden();

      // WHERE: the scope the ids name, completed from the rows.
      const target = await resolveTarget(tx, { tenantId, domainId, productId }, isPlatformAdmin(granter));
      if (!target.success) return target;
      const scope = target.data;

      if (!isValidAssignment(role, scope)) {
        return err({
          code: "VALIDATION_ERROR",
          message: `${role} cannot be assigned at system level; only ${GRANTING_ROLE} can`,
          suggestedFix: `Choose a tenant, a domain or a product for ${role}.`,
        });
      }
      // WHETHER: only an administrator whose scope covers the target, never above their own role.
      if (!grantAllowed(granter, role, scope)) return forbidden();

      // The role row has a foreign key to its user too: an id that is nobody's is said, and not thrown out of the action as the database's P2003.
      const user = await tx.user.findUnique({ where: { id: userId }, select: { id: true } });
      if (!user) {
        return err({
          code: "NOT_FOUND",
          message: `User "${userId}" not found`,
          suggestedFix: "Use the id of an existing user.",
        });
      }

      // Prevent duplicate role assignments
      const key = scopeKey(scope);
      const existing = await tx.userRole.findFirst({ where: { userId, role, scopeKey: key } });
      if (existing) {
        return err({
          code: "DUPLICATE",
          message: `User already has ${role} role ${describeScope(scope)}`,
          suggestedFix: "This role assignment already exists.",
        });
      }

      // What the user held before: the audit entry says what changed, not only that something did.
      const before = await tx.userRole.findMany({ where: { userId }, orderBy: { createdAt: "asc" }, select: { role: true, scopeKey: true } });

      const created = await tx.userRole.create({
        data: { userId, role, scopeKey: key, ...scopeColumns(scope), grantedById: ctx.userId },
      });

      await tx.auditLog.create({
        data: {
          action: "ROLE_ASSIGNED",
          entityType: "User",
          entityId: userId,
          userId: ctx.userId,
          tenantId: scope.kind === "GLOBAL" ? null : scope.tenantId,
          beforeState: { roles: roleSummary(before) },
          afterState: { roleId: created.id, role, scopeKey: key, roles: roleSummary([...before, { role, scopeKey: key }]) },
        },
      });
      return ok(toUserRole(created));
    })
  );
}

// ---------------------------------------------------------------------------
// removeRole — remove a role assignment
// ---------------------------------------------------------------------------

/**
 * Remove a role assignment. The CALLER is judged from their own stored assignments (as in `assignRole`): revoking needs the authority to
 * grant that very role at that very scope (`grantAllowed`), so a tenant administrator removes nothing outside their tenant, and an assignment
 * they hold no authority over answers exactly like one that does not exist. Two rules protect the administrators: nobody removes their OWN
 * administrator assignment, and the last enabled global administrator is never removed. Both are decided inside one SERIALIZABLE
 * transaction (run again when it loses a race), so two administrators removing each other at the same moment leave exactly one. The audit entry
 * (`ROLE_REMOVED`, about the user who lost the role) is written in the same transaction.
 */
export async function removeRole(
  id: string,
  ctx: ServiceContext
): Promise<Result<void>> {
  return answering("removeRole", () =>
    runSerializable(async (tx): Promise<Result<void>> => {
      const granter = await loadActorAssignments(tx, ctx.userId);
      if (!granter || !holdsGrantingRole(granter)) return forbidden();

      const notFound = (): Result<void> =>
        err({ code: "NOT_FOUND", message: "Role assignment not found", suggestedFix: "Verify the role assignment ID." });

      const roleRow = typeof id === "string" && id.trim() !== "" ? await tx.userRole.findUnique({ where: { id } }) : null;
      if (!roleRow) return notFound();

      // The authority over THAT assignment: the scope the row really has. A row that is not a valid assignment (a legacy row) is for a platform
      // administrator to clear and for nobody else; a row the caller has no authority over is a row that does not exist to them.
      const [assignment] = assignmentsFromRows([roleRow]);
      const authorized = assignment ? grantAllowed(granter, assignment.role, assignment.scope) : isPlatformAdmin(granter);
      if (!authorized) return notFound();

      // Safety: an administrator cannot remove their own administrator assignment, at any scope
      if (isAdministrative(roleRow.role) && roleRow.userId === ctx.userId) {
        return err({
          code: "FORBIDDEN",
          message: "Cannot remove your own admin role",
          suggestedFix: "Ask another admin to remove your role if needed.",
        });
      }

      // Safety: at least one ENABLED global (platform) administrator remains once this row is gone
      if (isAdministrative(roleRow.role) && roleRow.scopeKey === scopeKey({ kind: "GLOBAL" })) {
        const remaining = await tx.userRole.count({
          where: { role: roleRow.role, scopeKey: roleRow.scopeKey, id: { not: roleRow.id }, user: { disabledAt: null } },
        });
        if (remaining < 1) {
          return err({
            code: "FORBIDDEN",
            message: "Cannot remove the last admin role — at least one admin must remain",
            suggestedFix: "Assign another user as Admin before removing this one.",
          });
        }
      }

      const before = await tx.userRole.findMany({ where: { userId: roleRow.userId }, orderBy: { createdAt: "asc" }, select: { id: true, role: true, scopeKey: true } });
      await tx.userRole.delete({ where: { id } });

      await tx.auditLog.create({
        data: {
          action: "ROLE_REMOVED",
          entityType: "User",
          entityId: roleRow.userId,
          userId: ctx.userId,
          tenantId: roleRow.tenantId ?? null,
          beforeState: { roleId: roleRow.id, role: roleRow.role, scopeKey: roleRow.scopeKey, roles: roleSummary(before) },
          afterState: { roles: roleSummary(before.filter((row) => row.id !== roleRow.id)) },
        },
      });
      return ok(undefined);
    })
  );
}

/** The plan's name for `removeRole`: the same function. */
export const revokeRole = removeRole;

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

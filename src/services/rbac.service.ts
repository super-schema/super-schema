/**
 * RBAC Service — Role-Based Access Control business logic.
 *
 * Manages user roles and permission checks. All service functions return Result<T>. The first
 * administrator is NOT made here (or by any request): see `src/lib/admin-bootstrap.ts`.
 *
 * Persistence: Prisma `userRole` table. A row's scope is its `scopeKey` (`G`, `T:<tenantId>`, `D:<domainId>`, `P:<productId>`,
 * src/lib/access/scope.ts). `assignRole` and `removeRole` decide for themselves whether the CALLER may grant or revoke: they read the
 * caller's assignments by id and ask the policy (`grantAllowed`), whatever label or context the caller hands in. The full scoped screens
 * are Task 7; the rules are enforced here now.
 */

import { prisma } from "@/lib/db";
import { scopeKey } from "@/lib/access/scope";
import { ROLE_ROW_SELECT, assignmentsFromRows } from "@/lib/access/assignments";
import { ACTIONS } from "@/lib/access/actions";
import { can, effectiveRole as policyRole, globalRole, grantAllowed, roleAtLeast } from "@/lib/access/policy";
import { isValidAssignment } from "@/lib/access/scope";
import { runSerializable } from "@/lib/serializable-transaction";
import { ok, err } from "@/types/result";
import type { Result } from "@/types/result";
import type { ServiceContext } from "@/types/service-context";
import {
  AssignRoleInputSchema,
  type Assignment,
  type Role,
  type Scope,
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
// Who may grant and revoke (access-control design, decision 5)
// ---------------------------------------------------------------------------

/** One text for every refusal of the caller's authority: it names no role, scope, tenant or id, so it cannot be used to probe for them. */
const forbidden = <T>(): Result<T> => err({ code: "FORBIDDEN", message: "You do not have permission to do this", suggestedFix: "Contact your administrator" });

/** The role that carries the power to assign and revoke roles (read from the action table, never spelled out here). */
const GRANTING_ROLE = ACTIONS["role.assign"].minRole;

/** Is `role` the role that can assign roles (what "an administrator" means for the self-removal and last-administrator rules)? */
const isAdministrative = (role: string): boolean => roleAtLeast(role as Role, GRANTING_ROLE);

/** A platform (GLOBAL) administrator: the policy's reading of the assignments, not a role name. */
const isPlatformAdmin = (assignments: Assignment[]): boolean => can(assignments, "platform.admin", { tenantId: "-" });

/**
 * The assignments of the user who is granting or revoking, read INSIDE the transaction (so a demotion that commits while a grant is being
 * decided makes one of the two retry). `null` for a user who does not exist or is disabled: nobody grants anything.
 */
async function granterAssignments(tx: Pick<typeof prisma, "user">, userId: string): Promise<Assignment[] | null> {
  if (typeof userId !== "string" || userId.trim() === "") return null;
  const user = await tx.user.findUnique({ where: { id: userId }, select: { disabledAt: true, roles: { select: ROLE_ROW_SELECT } } });
  if (!user || user.disabledAt) return null;
  return assignmentsFromRows(user.roles);
}

/** Nothing the caller may assign anywhere unless some assignment of theirs holds the granting role: checked before any look-up. */
const holdsGrantingRole = (assignments: Assignment[]): boolean => assignments.some((entry) => roleAtLeast(entry.role, GRANTING_ROLE));

/** The columns a role row carries for a scope (the CHECK constraint ties them to the scope key). */
function scopeColumns(scope: Scope): { tenantId: string | null; domainId: string | null; productId: string | null } {
  switch (scope.kind) {
    case "GLOBAL":
      return { tenantId: null, domainId: null, productId: null };
    case "TENANT":
      return { tenantId: scope.tenantId, domainId: null, productId: null };
    case "DOMAIN":
      return { tenantId: scope.tenantId, domainId: scope.domainId, productId: null };
    case "PRODUCT":
      return { tenantId: scope.tenantId, domainId: scope.domainId, productId: scope.productId };
  }
}

function describeScope(scope: Scope): string {
  switch (scope.kind) {
    case "GLOBAL":
      return "at system level";
    case "TENANT":
      return `for tenant ${scope.tenantId}`;
    case "DOMAIN":
      return `for domain ${scope.domainId}`;
    case "PRODUCT":
      return `for product ${scope.productId}`;
  }
}

type Target = { tenantId?: string; domainId?: string; productId?: string };

/**
 * The full scope the ids name, completed from the stored rows (a domain role carries the domain's own tenant, a product role its product's
 * domain and tenant: never the caller's word for it). Ids that name nothing, or that disagree with each other, are one outcome: for a
 * platform administrator a "not found" that says what is missing, for anyone else the generic refusal, the very one a target they hold no
 * authority over gets, so an id of another tenant cannot be told from one that does not exist.
 */
async function resolveTarget(tx: Pick<typeof prisma, "tenant" | "domain" | "product">, target: Target, platformAdmin: boolean): Promise<Result<Scope>> {
  const missing = (label: string, id: string): Result<Scope> =>
    platformAdmin
      ? err({ code: "NOT_FOUND", message: `${label} "${id}" not found`, suggestedFix: `Use the id of an existing ${label.toLowerCase()}.` })
      : forbidden();

  if (target.productId) {
    const product = await tx.product.findUnique({ where: { id: target.productId }, select: { id: true, domainId: true, domain: { select: { tenantId: true } } } });
    if (!product || (target.domainId && target.domainId !== product.domainId) || (target.tenantId && target.tenantId !== product.domain.tenantId)) {
      return missing("Product", target.productId);
    }
    return ok({ kind: "PRODUCT", tenantId: product.domain.tenantId, domainId: product.domainId, productId: product.id });
  }
  if (target.domainId) {
    const domain = await tx.domain.findUnique({ where: { id: target.domainId }, select: { id: true, tenantId: true } });
    if (!domain || (target.tenantId && target.tenantId !== domain.tenantId)) return missing("Domain", target.domainId);
    return ok({ kind: "DOMAIN", tenantId: domain.tenantId, domainId: domain.id });
  }
  if (target.tenantId) {
    const tenant = await tx.tenant.findUnique({ where: { id: target.tenantId }, select: { id: true } });
    if (!tenant) return missing("Tenant", target.tenantId);
    return ok({ kind: "TENANT", tenantId: tenant.id });
  }
  return ok({ kind: "GLOBAL" });
}

// ---------------------------------------------------------------------------
// assignRole — assign a role to a user
// ---------------------------------------------------------------------------

/**
 * Assign `role` to a user at the scope the input names (platform when it names none). The CALLER is judged here, from their own stored
 * assignments (`ctx.userId` only: neither `ctx.userRole` nor anything else the caller passes counts): only an ADMIN whose scope covers the
 * target scope grants there, nobody grants above their own role (`grantAllowed`), and a platform (GLOBAL) assignment is valid for ADMIN only
 * (`isValidAssignment`). One SERIALIZABLE transaction, run again when it loses a race, so a grant judged against a granter who is demoted at
 * the same moment is judged again.
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

  return runSerializable(async (tx): Promise<Result<UserRole>> => {
    // WHO is granting: their stored assignments. Nobody holding the granting role anywhere is refused before any look-up of the target.
    const granter = await granterAssignments(tx, ctx.userId);
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

    const created = await tx.userRole.create({
      data: { userId, role, scopeKey: key, ...scopeColumns(scope), grantedById: ctx.userId },
    });
    return ok(toUserRole(created));
  });
}

// ---------------------------------------------------------------------------
// removeRole — remove a role assignment
// ---------------------------------------------------------------------------

/**
 * Remove a role assignment. The CALLER is judged from their own stored assignments (as in `assignRole`): revoking needs the authority to
 * grant that very role at that very scope (`grantAllowed`), so a tenant administrator removes nothing outside their tenant, and an assignment
 * they hold no authority over answers exactly like one that does not exist. Two rules protect the administrators: nobody removes their OWN
 * administrator assignment, and the last enabled global administrator is never removed. Both are decided inside one SERIALIZABLE
 * transaction (run again when it loses a race), so two administrators removing each other at the same moment leave exactly one.
 */
export async function removeRole(
  id: string,
  ctx: ServiceContext
): Promise<Result<void>> {
  return runSerializable(async (tx): Promise<Result<void>> => {
    const granter = await granterAssignments(tx, ctx.userId);
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

    await tx.userRole.delete({ where: { id } });
    return ok(undefined);
  });
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

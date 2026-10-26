/**
 * What the administration services share (roles, invitations, disabling, reset links, the user list): the refusals, who counts as an
 * administrator of what, how a scope named by ids is completed from the stored rows, and how a failure of the database becomes an answer.
 *
 * Two rules every function built on this keeps:
 *  - WHO is acting is read from the database inside the transaction (`loadActorAssignments`), never taken from the context the caller hands in.
 *  - A target the actor has no authority over answers EXACTLY like one that does not exist: nothing here lets a tenant administrator probe for the
 *    users, roles, invitations or scopes of another tenant.
 */

import { ACTIONS } from "@/lib/access/actions";
import { can, roleAtLeast } from "@/lib/access/policy";
import type { Prisma } from "@/generated/prisma/client";
import { isSerializationFailure } from "@/lib/serializable-transaction";
import { err, ok, type Result } from "@/types/result";
import type { Assignment, Role, Scope } from "@/types/schemas/rbac";

export type Tx = Prisma.TransactionClient;

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------------------------------------------------------------------------

/** One text for every refusal of the caller's authority: it names no role, scope, tenant or id, so it cannot be used to probe for them. */
export const forbidden = <T>(): Result<T> => err({ code: "FORBIDDEN", message: "You do not have permission to do this", suggestedFix: "Contact your administrator" });

/** A user that is missing, or that the actor has no authority over: one answer, byte for byte. */
export const userNotFound = <T>(): Result<T> => err({ code: "NOT_FOUND", message: "User not found", suggestedFix: "Verify the user and try again." });

/** An invitation that is missing, already used, expired, or not the actor's to touch: one answer. */
export const invitationNotFound = <T>(): Result<T> => err({ code: "NOT_FOUND", message: "Invitation not found", suggestedFix: "Verify the invitation and try again." });

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Who is an administrator of what
// ---------------------------------------------------------------------------------------------------------------------------------------------

/** The role that carries the power to assign roles (read from the action table, never spelled out here). */
export const GRANTING_ROLE: Role = ACTIONS["role.assign"].minRole;

/** Is `role` the role that can assign roles (what "an administrator" means for the self-removal and last-administrator rules)? */
export const isAdministrative = (role: string): boolean => roleAtLeast(role as Role, GRANTING_ROLE);

/** A platform (GLOBAL) administrator: the policy's reading of the assignments, not a role name. */
export const isPlatformAdmin = (assignments: readonly Assignment[]): boolean => can([...assignments], "platform.admin", { tenantId: "-" });

/** Does some assignment hold the granting role (anywhere)? Nothing may be assigned, invited or listed unless it does: checked before any look-up. */
export const holdsGrantingRole = (assignments: readonly Assignment[]): boolean => assignments.some((entry) => roleAtLeast(entry.role, GRANTING_ROLE));

/** What an administrator administers: everything (`platform`), or the tenants where they hold the tenant administrator's act (`user.manage`). */
export type Administered = { platform: boolean; tenantIds: ReadonlySet<string> };

export function administeredBy(assignments: readonly Assignment[]): Administered {
  const held = [...assignments];
  const platform = isPlatformAdmin(held);
  const tenantIds = new Set<string>();
  for (const entry of held) {
    if (entry.scope.kind === "GLOBAL") continue;
    const tenantId = entry.scope.tenantId;
    if (!tenantIds.has(tenantId) && can(held, "user.manage", { tenantId })) tenantIds.add(tenantId);
  }
  return { platform, tenantIds };
}

/** Does the actor administer anything at all (a platform administrator, or a tenant administrator of at least one tenant)? */
export const administersSomething = (administered: Administered): boolean => administered.platform || administered.tenantIds.size > 0;

/** Does the actor administer this tenant? A platform administrator administers every one. */
export const administersTenant = (administered: Administered, tenantId: string | null | undefined): boolean =>
  administered.platform || (typeof tenantId === "string" && administered.tenantIds.has(tenantId));

/** A stored role row, as far as reach is concerned: the scope key and the tenant column the database keeps consistent with it. */
export type RoleRowLike = { scopeKey: string; tenantId?: string | null };

/**
 * May the actor administer a user who holds `rows` (ALL of the user's stored rows, even the ones the actor cannot see)? A platform administrator
 * administers every user. A tenant administrator administers a user who holds at least one role in a tenant they administer AND whose every role lies
 * in a tenant they administer: a user with a platform role, or a role in a tenant they do not administer, is out of reach, and so is a user with no role
 * at all (nobody but a platform administrator may touch an account that no tenant has a stake in).
 */
export function reaches(administered: Administered, rows: readonly RoleRowLike[]): boolean {
  if (administered.platform) return true;
  if (rows.length === 0) return false;
  return rows.every((row) => row.scopeKey !== "G" && typeof row.tenantId === "string" && administered.tenantIds.has(row.tenantId));
}

/** The tenant an audit entry belongs to: the one tenant every scope names, or none. */
export function commonTenantId(tenantIds: ReadonlyArray<string | null | undefined>): string | null {
  const ids = new Set(tenantIds.map((id) => id ?? null));
  return ids.size === 1 && !ids.has(null) ? ([...ids][0] as string) : null;
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Scopes named by ids
// ---------------------------------------------------------------------------------------------------------------------------------------------

/** The columns a role row carries for a scope (the CHECK constraint ties them to the scope key). */
export function scopeColumns(scope: Scope): { tenantId: string | null; domainId: string | null; productId: string | null } {
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

export function describeScope(scope: Scope): string {
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

/** Where a role is to be granted, by the ids the caller names: `productId` (a product), else `domainId`, else `tenantId`, else nothing (platform scope). */
export type Target = { tenantId?: string; domainId?: string; productId?: string };

/**
 * The full scope the ids name, completed from the stored rows (a domain role carries the domain's own tenant, a product role its product's domain and
 * tenant: never the caller's word for it). Ids that name nothing, or that disagree with each other, are one outcome: for a platform administrator a
 * "not found" that says what is missing, for anyone else the generic refusal, the very one a target they hold no authority over gets, so an id of
 * another tenant cannot be told from one that does not exist.
 */
export async function resolveTarget(tx: Pick<Tx, "tenant" | "domain" | "product">, target: Target, platformAdmin: boolean): Promise<Result<Scope>> {
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

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Failures of the database are answers
// ---------------------------------------------------------------------------------------------------------------------------------------------

const codeOf = (error: unknown): unknown => (typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined);

/**
 * Runs a service body and turns a failure of the database into an answer: a unique key lost to a concurrent request is `DUPLICATE`, a row deleted
 * between a look-up and a write (a foreign key) is `NOT_FOUND`, a SERIALIZABLE transaction that lost its race on every round is `CONFLICT`, and
 * anything else is a generic `INTERNAL_ERROR` (logged). A service answers `Result`; it never throws.
 */
export async function answering<T>(name: string, work: () => Promise<Result<T>>): Promise<Result<T>> {
  try {
    return await work();
  } catch (error) {
    const code = codeOf(error);
    if (code === "P2002") {
      return err({ code: "DUPLICATE", message: "This was already done, possibly by someone else a moment ago", suggestedFix: "Reload and check the current state." });
    }
    if (code === "P2003" || code === "P2025") {
      return err({ code: "NOT_FOUND", message: "Something this change refers to no longer exists", suggestedFix: "Reload and try again." });
    }
    if (isSerializationFailure(error)) {
      console.error(`[admin] ${name}: the transaction kept losing a race`, error);
      return err({ code: "CONFLICT", message: "Other changes were being made at the same time. Please try again.", suggestedFix: "Try again in a moment." });
    }
    console.error(`[admin] ${name} failed`, error);
    return err({ code: "INTERNAL_ERROR", message: "Something went wrong. Please try again." });
  }
}

/** The roles of a user as the audit trail keeps them: the role and its scope key, nothing else (no ids of the rows, no e-mail). */
export const roleSummary = (rows: ReadonlyArray<{ role: string; scopeKey: string }>): Array<{ role: string; scopeKey: string }> =>
  rows.map((row) => ({ role: row.role, scopeKey: row.scopeKey }));

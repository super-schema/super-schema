/**
 * The authorization policy: which role a principal holds over a resource, whether it may perform an action, and whether it may grant a
 * role (access-control design, decisions 2 to 5). Pure: no I/O, no throws, bounded (work is linear in the number of assignments, constant
 * per assignment). Deny by default: anything unknown or malformed (an action id, a role, a scope, a resource, an assignment list) is a "no".
 *
 * The ladder and the action table are the single sources: roles are ranked by `ROLE_HIERARCHY` (`@/types/schemas/rbac`), actions by
 * `ACTIONS` (`./actions`). Nothing here, and nothing elsewhere, hard-codes a role name to decide a permission.
 */

import { ROLE_HIERARCHY, isRole, type Assignment, type ResourceRef, type Role, type Scope } from "@/types/schemas/rbac";
import { ACTIONS, isActionId, type ActionId, type ActionSpec } from "./actions";
import { covers, isAssignment, isResourceRef, isValidAssignment, scopeContains } from "./scope";

/** Is `role` at least `min` on the ladder? `null` (no role) and anything that is not a role are below everything. */
export function roleAtLeast(role: Role | null | undefined, min: Role): boolean {
  return isRole(role) && isRole(min) && ROLE_HIERARCHY.indexOf(role) >= ROLE_HIERARCHY.indexOf(min);
}

/**
 * The highest ladder rank among the valid assignments whose scope satisfies `applies`, or -1 when there is none. An entry that is not a
 * well-formed assignment (junk, an unknown role, a malformed scope, a GLOBAL scope for a role other than ADMIN) is skipped, never an error:
 * a bad row must not shadow a good one, and must never grant anything.
 */
function bestRank(assignments: readonly Assignment[], applies: (scope: Scope) => boolean): number {
  if (!Array.isArray(assignments)) return -1;
  let best = -1;
  for (const entry of assignments) {
    if (!isAssignment(entry)) continue;
    const rank = ROLE_HIERARCHY.indexOf(entry.role);
    if (rank > best && applies(entry.scope)) best = rank;
  }
  return best;
}

/**
 * The role a principal holds over a resource: the highest among the assignments whose scope contains it (decision 2). `null` when no
 * assignment does, and for a malformed resource. An assignment of another tenant never applies; a GLOBAL assignment (ADMIN only) applies
 * everywhere; a DOMAIN assignment does not reach a sibling domain or a tenant-level resource.
 */
export function effectiveRole(assignments: Assignment[], resource: ResourceRef): Role | null {
  if (!isResourceRef(resource)) return null;
  const best = bestRank(assignments, (scope) => covers(scope, resource));
  return best < 0 ? null : (ROLE_HIERARCHY[best] ?? null);
}

/**
 * May the principal holding `assignments` perform `action` on `resource`? Judged by the action's level in the table (see `./actions`):
 * `resource` against the scopes containing the resource, `tenant` against TENANT and GLOBAL assignments of the resource's tenant only,
 * `anywhere` against any assignment inside that tenant or a global one, `global` against GLOBAL only, `self` always (any active
 * principal, role or not). An unknown action id, a malformed resource or a missing role answers false.
 */
export function can(assignments: Assignment[], action: ActionId, resource: ResourceRef): boolean {
  if (!isActionId(action)) return false;
  const spec: ActionSpec = ACTIONS[action];
  if (spec.level === "self") return true;

  const required = ROLE_HIERARCHY.indexOf(spec.minRole);
  if (required < 0) return false; // a table entry naming no role would otherwise be satisfied by "no assignment" (-1 >= -1)

  if (spec.level === "global") return bestRank(assignments, (scope) => scope.kind === "GLOBAL") >= required;

  if (!isResourceRef(resource)) return false;
  switch (spec.level) {
    case "resource":
      return bestRank(assignments, (scope) => covers(scope, resource)) >= required;
    case "tenant": {
      // The tenant as a whole: the scopes containing a resource that is the tenant itself (no domain, no product): TENANT of this tenant, GLOBAL.
      const tenant: ResourceRef = { tenantId: resource.tenantId };
      return bestRank(assignments, (scope) => covers(scope, tenant)) >= required;
    }
    case "anywhere":
      return bestRank(assignments, (scope) => scope.kind === "GLOBAL" || scope.tenantId === resource.tenantId) >= required;
  }
}

/**
 * May the principal holding `granter` assign `role` at the scope `target` (decision 5)? Only an ADMIN whose scope contains the target scope
 * (the role `role.assign` needs in the table); nobody grants above their own role there; the assignment itself must be valid (GLOBAL only for
 * ADMIN). A tenant ADMIN grants within the tenant (its domains and products) and nowhere else, a domain ADMIN within the domain and its products.
 * Last-admin and self-demotion protection are not decided here: they need the stored assignments.
 */
export function grantAllowed(granter: Assignment[], role: Role, target: Scope): boolean {
  if (!isValidAssignment(role, target)) return false;
  const required = ROLE_HIERARCHY.indexOf(ACTIONS["role.assign"].minRole);
  if (required < 0) return false;
  // What the granter is over the target scope: the best valid assignment whose scope contains it.
  const authority = bestRank(granter, (scope) => scopeContains(scope, target));
  return authority >= required && ROLE_HIERARCHY.indexOf(role) <= authority;
}

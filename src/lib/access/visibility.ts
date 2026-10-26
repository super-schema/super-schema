/**
 * What of the domain / product STRUCTURE a principal may see (navigation: the domain list, the explorer tree). Pure, no I/O, no throws.
 *
 * `domain.read` is judged over ONE resource: a role at a DOMAIN scope covers its domain and everything under it, a role at a PRODUCT scope covers
 * that product only. A user whose only role is a PRODUCT one must still be able to reach that product, so its domain is shown (as a
 * parent, name only: never the siblings of the product, never the domain's own assets or the other products' entities). These helpers answer
 * "may this be listed" for a domain and a product, from every assignment scope (TENANT, DOMAIN, PRODUCT), and never beyond the product.
 *
 * They are for READS of the structure only. Writes are judged by `can` over the row (a product-scoped author cannot write at its domain).
 */

import type { ActionId } from "./actions";
import { can } from "./policy";
import { isAssignment, type Assignment } from "./scope";

/** The (domain, product) pairs of the PRODUCT-scoped assignments held inside `tenantId` (whatever the role: it only decides what to list). */
export function productScopesIn(assignments: readonly Assignment[], tenantId: string): Array<{ domainId: string; productId: string }> {
  const found: Array<{ domainId: string; productId: string }> = [];
  if (!Array.isArray(assignments)) return found;
  for (const entry of assignments) {
    if (isAssignment(entry) && entry.scope.kind === "PRODUCT" && entry.scope.tenantId === tenantId) {
      found.push({ domainId: entry.scope.domainId, productId: entry.scope.productId });
    }
  }
  return found;
}

/**
 * May the domain be LISTED: a role covers the domain itself (`domain.read`: tenant, global or the domain's own scope) or a role at one of its
 * products does (the product's parent, so the product can be reached).
 */
export function canListDomain(assignments: readonly Assignment[], resource: { tenantId: string; domainId: string }): boolean {
  if (can([...assignments], "domain.read", { tenantId: resource.tenantId, domainId: resource.domainId })) return true;
  return productScopesIn(assignments, resource.tenantId).some((scope) => scope.domainId === resource.domainId);
}

/** May the product be LISTED: a role covers it (`domain.read` over the product: tenant, global, its domain or the product itself). */
export function canListProduct(assignments: readonly Assignment[], resource: { tenantId: string; domainId: string; productId: string }): boolean {
  return can([...assignments], "domain.read", { tenantId: resource.tenantId, domainId: resource.domainId, productId: resource.productId });
}

/**
 * Does the principal see the WHOLE domain (a tenant, global or domain role), as opposed to only some of its products through PRODUCT roles?
 * A domain listed only as a parent shows only what the product roles reach: the caller counts or lists through `productScopesIn`.
 */
export function seesWholeDomain(assignments: readonly Assignment[], resource: { tenantId: string; domainId: string }): boolean {
  return can([...assignments], "domain.read", { tenantId: resource.tenantId, domainId: resource.domainId });
}

/**
 * Which rows of a TENANT-WIDE list the principal may read for `action`: every row of the tenant (a tenant or global role that reaches the action),
 * or only the rows under the listed domains and products (the DOMAIN and PRODUCT scopes that reach it). A loader that lists across the tenant
 * (the external-reference picker, the usage lookup) restricts its query to this instead of filtering after a page was cut. An assignment whose role
 * is too low for the action contributes nothing; another tenant's assignment contributes nothing.
 */
export type ReadableScopes = { all: true } | { all: false; domainIds: string[]; productIds: string[] };

/**
 * `readableScopes` as a `where` fragment for a table whose rows carry `domainId` and `productId` columns (entities, data types, APIs, traits, events):
 * nothing added for a tenant or platform role (every row of the tenant), else the rows under the domains and products the caller's narrower roles cover.
 * An empty `in` matches no row, so a caller that reaches nothing reads nothing: the fragment is always a restriction, never a "no filter" by accident.
 * A fresh object each call (the caller adds `tenantId` and more to it).
 */
export function readableWhere(
  assignments: readonly Assignment[],
  action: ActionId,
  tenantId: string
): { OR?: Array<{ domainId: { in: string[] } } | { productId: { in: string[] } }> } {
  const scopes = readableScopes(assignments, action, tenantId);
  return scopes.all ? {} : { OR: [{ domainId: { in: scopes.domainIds } }, { productId: { in: scopes.productIds } }] };
}

export function readableScopes(assignments: readonly Assignment[], action: ActionId, tenantId: string): ReadableScopes {
  const domainIds = new Set<string>();
  const productIds = new Set<string>();
  if (Array.isArray(assignments)) {
    for (const entry of assignments) {
      if (!isAssignment(entry)) continue;
      const { scope } = entry;
      if (scope.kind === "GLOBAL" || (scope.kind === "TENANT" && scope.tenantId === tenantId)) {
        if (can([entry], action, { tenantId })) return { all: true };
        continue;
      }
      if (scope.kind === "TENANT" || scope.tenantId !== tenantId) continue;
      if (scope.kind === "DOMAIN" && can([entry], action, { tenantId, domainId: scope.domainId })) domainIds.add(scope.domainId);
      if (scope.kind === "PRODUCT" && can([entry], action, { tenantId, domainId: scope.domainId, productId: scope.productId })) productIds.add(scope.productId);
    }
  }
  return { all: false, domainIds: [...domainIds], productIds: [...productIds] };
}

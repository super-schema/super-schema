/**
 * Scopes as people read them: the names of the tenant, domain and product a scope key points at, not their ids. Three reads for any number of
 * scopes (the distinct ids of each kind), never one per row. A scope whose tenant, domain or product no longer exists keeps its key and shows what is
 * left of it (a cascade deletes the role rows with them, so this is for an invitation that names a place that has since gone).
 */

import { scopeKey } from "@/lib/access/scope";
import type { Scope } from "@/types/schemas/rbac";
import type { ScopeLabel } from "@/types/schemas/user-admin";
import type { Tx } from "./admin-shared";

const unique = (ids: ReadonlyArray<string | null | undefined>): string[] => [...new Set(ids.filter((id): id is string => typeof id === "string"))];

/** The labels of `scopes`, by scope key. */
export async function labelScopes(db: Pick<Tx, "tenant" | "domain" | "product">, scopes: readonly Scope[]): Promise<Map<string, ScopeLabel>> {
  const tenantIds = unique(scopes.map((scope) => (scope.kind === "GLOBAL" ? null : scope.tenantId)));
  const domainIds = unique(scopes.map((scope) => (scope.kind === "DOMAIN" || scope.kind === "PRODUCT" ? scope.domainId : null)));
  const productIds = unique(scopes.map((scope) => (scope.kind === "PRODUCT" ? scope.productId : null)));

  const [tenants, domains, products] = await Promise.all([
    tenantIds.length ? db.tenant.findMany({ where: { id: { in: tenantIds } }, select: { id: true, name: true } }) : [],
    domainIds.length ? db.domain.findMany({ where: { id: { in: domainIds } }, select: { id: true, name: true } }) : [],
    productIds.length ? db.product.findMany({ where: { id: { in: productIds } }, select: { id: true, name: true } }) : [],
  ]);
  const tenantName = new Map(tenants.map((row) => [row.id, row.name]));
  const domainName = new Map(domains.map((row) => [row.id, row.name]));
  const productName = new Map(products.map((row) => [row.id, row.name]));

  const labels = new Map<string, ScopeLabel>();
  for (const scope of scopes) {
    const key = scopeKey(scope);
    if (labels.has(key)) continue;
    const tenantId = scope.kind === "GLOBAL" ? null : scope.tenantId;
    const domainId = scope.kind === "DOMAIN" || scope.kind === "PRODUCT" ? scope.domainId : null;
    const productId = scope.kind === "PRODUCT" ? scope.productId : null;
    const names = [
      tenantId === null ? null : (tenantName.get(tenantId) ?? "(removed tenant)"),
      domainId === null ? null : (domainName.get(domainId) ?? "(removed domain)"),
      productId === null ? null : (productName.get(productId) ?? "(removed product)"),
    ];
    labels.set(key, {
      kind: scope.kind,
      scopeKey: key,
      tenantId,
      tenantName: names[0],
      domainId,
      domainName: names[1],
      productId,
      productName: names[2],
      label: scope.kind === "GLOBAL" ? "Platform" : names.filter((name): name is string => name !== null).join(" / "),
    });
  }
  return labels;
}

import type { Role } from "@/types/schemas/rbac";
import type { GrantableScope, GrantableScopes, ListedRole, ListedUser, ScopeLabel } from "@/types/schemas/user-admin";

/**
 * Fixtures for the Admin screens' component tests: the answers the server actions give (grantable scopes, listed users and roles), built the way the
 * services build them, so a component is tested against the real shapes.
 */

export const ALL_ROLES: Role[] = ["VIEWER", "AUTHOR", "STEWARD", "COMPLIANCE_OFFICER", "ADMIN"];

type Names = { tenant: [string, string]; domain?: [string, string]; product?: [string, string] };

export function scopeLabel(names: Names, platform = false): ScopeLabel {
  if (platform) return { kind: "GLOBAL" as never, scopeKey: "G", tenantId: null, tenantName: null, domainId: null, domainName: null, productId: null, productName: null, label: "Platform" };
  const [tenantId, tenantName] = names.tenant;
  const kind = names.product ? "PRODUCT" : names.domain ? "DOMAIN" : "TENANT";
  const key = names.product ? `P:${names.product[0]}` : names.domain ? `D:${names.domain[0]}` : `T:${tenantId}`;
  return {
    kind,
    scopeKey: key,
    tenantId,
    tenantName,
    domainId: names.domain?.[0] ?? null,
    domainName: names.domain?.[1] ?? null,
    productId: names.product?.[0] ?? null,
    productName: names.product?.[1] ?? null,
    label: [tenantName, names.domain?.[1], names.product?.[1]].filter(Boolean).join(" / "),
  };
}

/** A tenant with one domain and two products under it, each offered with `roles`. */
export function tenantScopes(id: string, name: string, roles: Role[] = ALL_ROLES): GrantableScope[] {
  const domain: [string, string] = [`${id}-dom`, `${name} Payments`];
  return [
    { ...(scopeLabel({ tenant: [id, name] }) as ScopeLabel), kind: "TENANT", depth: 0, roles },
    { ...(scopeLabel({ tenant: [id, name], domain }) as ScopeLabel), kind: "DOMAIN", depth: 1, roles },
    { ...(scopeLabel({ tenant: [id, name], domain, product: [`${id}-checkout`, "Checkout"] }) as ScopeLabel), kind: "PRODUCT", depth: 2, roles },
    { ...(scopeLabel({ tenant: [id, name], domain, product: [`${id}-ledger`, "Ledger"] }) as ScopeLabel), kind: "PRODUCT", depth: 2, roles },
  ];
}

/** A platform administrator: two tenants, and platform scope. */
export const GLOBAL_ADMIN_SCOPES: GrantableScopes = { scopes: [...tenantScopes("t1", "Alpha"), ...tenantScopes("t2", "Beta")], canGrantPlatform: true, truncated: false };
/** A tenant administrator of one tenant: that tenant only, no platform scope. */
export const TENANT_ADMIN_SCOPES: GrantableScopes = { scopes: tenantScopes("t1", "Alpha"), canGrantPlatform: false, truncated: false };

export function listedRole(role: Role, names: Names | "platform", over: Partial<ListedRole> = {}): ListedRole {
  const scope = names === "platform" ? scopeLabel({ tenant: ["", ""] }, true) : scopeLabel(names);
  return { id: `role-${role}-${scope.scopeKey}`, role, scope, removeBlockedReason: null, ...over };
}

export function listedUser(over: Partial<ListedUser> & { email: string }): ListedUser {
  return {
    kind: "user",
    id: `u-${over.email}`,
    userId: `u-${over.email}`,
    invitationId: null,
    name: null,
    status: "active",
    lastLoginAt: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    roles: [],
    expiresAt: null,
    manageable: true,
    isSelf: false,
    disableBlockedReason: null,
    ...over,
  };
}

export function listedInvitation(email: string, roles: ListedRole[] = [], over: Partial<ListedUser> = {}): ListedUser {
  return listedUser({
    email,
    kind: "invitation",
    id: `inv-${email}`,
    userId: null,
    invitationId: `inv-${email}`,
    status: "invited",
    roles: roles.map((role) => ({ ...role, id: null })),
    expiresAt: new Date("2026-02-01T00:00:00Z"),
    manageable: false,
    disableBlockedReason: "An invitation is revoked, not disabled",
    ...over,
  });
}

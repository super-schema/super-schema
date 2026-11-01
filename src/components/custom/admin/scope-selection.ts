/**
 * The choice a scope picker holds, and the rules that turn it into what the services take (`inviteUser` / `assignRole`: ids, narrowest first). Pure and
 * client-safe. The list it works on is `getGrantableScopesAction`'s: only places the caller may grant at least one role in, each with the roles accepted
 * there, so the picker can only offer what the service will accept (the service judges again on submit).
 */

import { ROLE_HIERARCHY, type Role } from "@/types/schemas/rbac";
import type { GrantableScope } from "@/types/schemas/user-admin";

/** A person's reading of each role (the screens never show the raw enum name). */
export const ROLE_LABELS: Record<Role, string> = {
  VIEWER: "Viewer",
  AUTHOR: "Author",
  STEWARD: "Steward",
  COMPLIANCE_OFFICER: "Compliance officer",
  ADMIN: "Admin",
};

export const roleLabel = (role: Role): string => ROLE_LABELS[role] ?? role;

/** The role the platform scope may carry (the policy: only ADMIN is valid there). */
export const PLATFORM_ROLES: readonly Role[] = ["ADMIN"];

export type ScopeSelection = {
  /** Platform scope (no tenant): a platform administrator granting ADMIN. */
  platform: boolean;
  tenantId: string;
  /** Empty: the whole tenant. */
  domainId: string;
  /** Empty: the whole domain. */
  productId: string;
};

export const EMPTY_SCOPE: ScopeSelection = Object.freeze({ platform: false, tenantId: "", domainId: "", productId: "" });

/** What `inviteUser` / `assignRole` take: the narrowest id chosen with its parents; `{}` is platform scope. */
export type ScopeInput = { tenantId?: string; domainId?: string; productId?: string };

const offeredFor = (scopes: readonly GrantableScope[], role: Role) => scopes.filter((scope) => scope.roles.includes(role));

export const tenantOptions = (scopes: readonly GrantableScope[], role: Role) => offeredFor(scopes, role).filter((scope) => scope.kind === "TENANT");

export const domainOptions = (scopes: readonly GrantableScope[], role: Role, tenantId: string) =>
  offeredFor(scopes, role).filter((scope) => scope.kind === "DOMAIN" && scope.tenantId === tenantId);

export const productOptions = (scopes: readonly GrantableScope[], role: Role, domainId: string) =>
  offeredFor(scopes, role).filter((scope) => scope.kind === "PRODUCT" && scope.domainId === domainId);

/** May `role` be granted at platform scope by this caller (offered to a platform administrator only, and only for the role the platform scope takes)? */
export const platformOffered = (canGrantPlatform: boolean, role: Role): boolean => canGrantPlatform && PLATFORM_ROLES.includes(role);

/**
 * `selection` kept valid for `role`: whatever is no longer offered (the platform scope for a role that is not ADMIN, a tenant, domain or product the role
 * cannot be granted in) is cleared, narrowest first, so a role change never leaves a choice the service would refuse.
 */
export function reconcileSelection(selection: ScopeSelection, scopes: readonly GrantableScope[], canGrantPlatform: boolean, role: Role): ScopeSelection {
  if (selection.platform) return platformOffered(canGrantPlatform, role) ? selection : EMPTY_SCOPE;
  if (!selection.tenantId || !tenantOptions(scopes, role).some((scope) => scope.tenantId === selection.tenantId)) return EMPTY_SCOPE;
  if (!selection.domainId || !domainOptions(scopes, role, selection.tenantId).some((scope) => scope.domainId === selection.domainId)) {
    return { platform: false, tenantId: selection.tenantId, domainId: "", productId: "" };
  }
  if (!selection.productId || !productOptions(scopes, role, selection.domainId).some((scope) => scope.productId === selection.productId)) {
    return { ...selection, productId: "" };
  }
  return selection;
}

/** The only tenant on offer is chosen for the person (a tenant administrator of one tenant has nothing to pick), else nothing. */
export function defaultSelection(scopes: readonly GrantableScope[], role: Role): ScopeSelection {
  const tenants = tenantOptions(scopes, role);
  return tenants.length === 1 ? { platform: false, tenantId: tenants[0].tenantId ?? "", domainId: "", productId: "" } : EMPTY_SCOPE;
}

/** The ids to send, or `null` while the choice is not complete (no tenant chosen yet). */
export function selectionToInput(selection: ScopeSelection): ScopeInput | null {
  if (selection.platform) return {};
  if (!selection.tenantId) return null;
  if (selection.productId) {
    if (!selection.domainId) return null;
    return { tenantId: selection.tenantId, domainId: selection.domainId, productId: selection.productId };
  }
  if (selection.domainId) return { tenantId: selection.tenantId, domainId: selection.domainId };
  return { tenantId: selection.tenantId };
}

/** The place named in words: `Platform`, or the names of the narrowest scope chosen (`Acme / Payments / Checkout`). */
export function describeSelection(scopes: readonly GrantableScope[], selection: ScopeSelection): string | null {
  if (selection.platform) return "Platform (every tenant)";
  const key = selection.productId ? `P:${selection.productId}` : selection.domainId ? `D:${selection.domainId}` : selection.tenantId ? `T:${selection.tenantId}` : null;
  if (key === null) return null;
  return scopes.find((scope) => scope.scopeKey === key)?.label ?? null;
}

/** The roles of the ladder, lowest first: what the role selects list (which of them a place accepts is the picker's business, `tenantOptions` and the like). */
export const ASSIGNABLE_ROLES: readonly Role[] = ROLE_HIERARCHY;

/**
 * Scopes: where a role applies, and what a scope contains (access-control design, decisions 2 and 3).
 *
 * Containment is GLOBAL ⊃ TENANT ⊃ DOMAIN ⊃ PRODUCT ⊃ entity. A tenant-level entity (no domain, no product) is contained by TENANT and
 * GLOBAL scopes only; a domain-level asset (no product) by its DOMAIN, its TENANT and GLOBAL.
 *
 * Pure: no I/O, no throws, bounded. Every function treats malformed input (it may come from a hand-edited row or the wire) as "no":
 * an invalid scope contains nothing and is contained by nothing, and an invalid assignment never applies. Ids are checked against
 * `SCOPE_ID_PATTERN` and `SCOPE_ID_MAX_LENGTH`, so no check does more than constant work per id.
 */

import {
  GLOBAL_SCOPE_ROLES,
  SCOPE_ID_MAX_LENGTH,
  SCOPE_ID_PATTERN,
  isRole,
  type Assignment,
  type ResourceRef,
  type Role,
  type Scope,
} from "@/types/schemas/rbac";

export type { Assignment, ResourceRef, Scope } from "@/types/schemas/rbac";

/**
 * What a scope key names. A key carries ONE id (`D:<domainId>`, `P:<productId>`), not the parents a full `Scope` needs, so a parsed key is
 * a part of a scope: the caller completes it from the database (a domain's tenant, a product's domain and tenant) before using it as a `Scope`.
 */
export type ParsedScopeKey =
  | { kind: "GLOBAL" }
  | { kind: "TENANT"; tenantId: string }
  | { kind: "DOMAIN"; domainId: string }
  | { kind: "PRODUCT"; productId: string };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** A usable id: a non-empty string of at most `SCOPE_ID_MAX_LENGTH` characters with no whitespace, control character or ":". */
export function isScopeId(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= SCOPE_ID_MAX_LENGTH && SCOPE_ID_PATTERN.test(value);
}

function isOptionalScopeId(value: unknown): value is string | null | undefined {
  return value === undefined || value === null || isScopeId(value);
}

/** True when `scope` is a complete scope: a known kind carrying every id it needs (a domain scope names its tenant, a product scope its domain and tenant). */
export function isValidScope(scope: unknown): scope is Scope {
  if (!isObject(scope)) return false;
  switch (scope.kind) {
    case "GLOBAL":
      return true;
    case "TENANT":
      return isScopeId(scope.tenantId);
    case "DOMAIN":
      return isScopeId(scope.tenantId) && isScopeId(scope.domainId);
    case "PRODUCT":
      return isScopeId(scope.tenantId) && isScopeId(scope.domainId) && isScopeId(scope.productId);
    default:
      return false;
  }
}

/** True when `resource` names its tenant, and its domain and product are absent or ids. */
export function isResourceRef(resource: unknown): resource is ResourceRef {
  return isObject(resource) && isScopeId(resource.tenantId) && isOptionalScopeId(resource.domainId) && isOptionalScopeId(resource.productId);
}

/**
 * The stored key of a scope: `G`, `T:<tenantId>`, `D:<domainId>`, `P:<productId>` (the `user_roles.scopeKey` column). A malformed scope has
 * no key: the answer is the empty string, which `parseScopeKey` refuses and the column's shape check rejects.
 */
export function scopeKey(scope: Scope): string {
  if (!isValidScope(scope)) return "";
  switch (scope.kind) {
    case "GLOBAL":
      return "G";
    case "TENANT":
      return `T:${scope.tenantId}`;
    case "DOMAIN":
      return `D:${scope.domainId}`;
    case "PRODUCT":
      return `P:${scope.productId}`;
  }
}

/** The part of a scope a key names, or `undefined` for anything that is not exactly `G`, `T:<id>`, `D:<id>` or `P:<id>` (see `ParsedScopeKey`). */
export function parseScopeKey(key: string): ParsedScopeKey | undefined {
  if (typeof key !== "string") return undefined;
  if (key === "G") return { kind: "GLOBAL" };
  // "<letter>:<id>": the id is everything after the separator and must itself be a clean id (so "T:a:b" and "T:a b" are refused).
  if (key.length < 3 || key.length > 2 + SCOPE_ID_MAX_LENGTH || key.charAt(1) !== ":") return undefined;
  const id = key.slice(2);
  if (!isScopeId(id)) return undefined;
  switch (key.charAt(0)) {
    case "T":
      return { kind: "TENANT", tenantId: id };
    case "D":
      return { kind: "DOMAIN", domainId: id };
    case "P":
      return { kind: "PRODUCT", productId: id };
    default:
      return undefined;
  }
}

/**
 * Does `scope` contain `resource`? GLOBAL contains everything; TENANT every resource of that tenant; DOMAIN the resources of that domain
 * (its own assets, its products and their entities) but not a tenant-level resource nor a sibling domain; PRODUCT the resources of that
 * product only. A resource of another tenant is contained by no scope but GLOBAL, whatever its domain and product ids say. A malformed
 * scope or resource is contained by nothing.
 */
export function covers(scope: Scope, resource: ResourceRef): boolean {
  if (!isValidScope(scope) || !isResourceRef(resource)) return false;
  switch (scope.kind) {
    case "GLOBAL":
      return true;
    case "TENANT":
      return scope.tenantId === resource.tenantId;
    case "DOMAIN":
      return scope.tenantId === resource.tenantId && scope.domainId === resource.domainId;
    case "PRODUCT":
      return scope.tenantId === resource.tenantId && scope.domainId === resource.domainId && scope.productId === resource.productId;
  }
}

/**
 * Does the scope `outer` contain the scope `inner` (is `inner` the same scope or somewhere inside it)? This is the question a grant asks:
 * an administrator of `outer` may assign roles at `inner`. GLOBAL contains every scope, a tenant its domains and products, a domain its
 * products, and every scope itself; nothing contains a scope above or beside it. A malformed scope is contained by nothing and contains nothing.
 */
export function scopeContains(outer: Scope, inner: Scope): boolean {
  if (!isValidScope(outer) || !isValidScope(inner)) return false;
  switch (outer.kind) {
    case "GLOBAL":
      return true;
    case "TENANT":
      return inner.kind !== "GLOBAL" && inner.tenantId === outer.tenantId;
    case "DOMAIN":
      return (inner.kind === "DOMAIN" || inner.kind === "PRODUCT") && inner.tenantId === outer.tenantId && inner.domainId === outer.domainId;
    case "PRODUCT":
      return inner.kind === "PRODUCT" && inner.tenantId === outer.tenantId && inner.domainId === outer.domainId && inner.productId === outer.productId;
  }
}

/**
 * May `role` be held at `scope`? Any role at a tenant, domain or product scope (decision 3: COMPLIANCE_OFFICER and ADMIN at tenant scope are
 * allowed); the GLOBAL (platform) scope only for ADMIN. An unknown role or a malformed scope is not a valid assignment. This replaces the
 * legacy `SYSTEM_ONLY_ROLES` / `DOMAIN_SCOPED_ROLES` rule, which tied roles to a domain id.
 */
export function isValidAssignment(role: Role, scope: Scope): boolean {
  if (!isRole(role) || !isValidScope(scope)) return false;
  return scope.kind !== "GLOBAL" || GLOBAL_SCOPE_ROLES.includes(role);
}

/** True for a well-formed assignment (an object carrying a valid role at a valid scope); the policy ignores any other entry of an assignment list. */
export function isAssignment(value: unknown): value is Assignment {
  return isObject(value) && isValidAssignment(value.role as Role, value.scope as Scope);
}

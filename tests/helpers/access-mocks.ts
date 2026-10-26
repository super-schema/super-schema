import { vi } from "vitest";
import { can, type Assignment, type Scope } from "@/lib/access";
import type { Principal } from "@/lib/access/principal";
import type { Role } from "@/types/schemas/rbac";

/**
 * Shared fixtures for the unit tests of everything that asks "who is this and what may they do": assignment builders, principals, the
 * rows the principal loader reads, and a stand-in for the principal module. The ONE place the tests learn how to be signed in, so a test
 * does not hand-roll `auth` / `getEffectiveRole` / `resolveCurrentUserId` mocks (the old way, ~30 files) and the day the loader changes only
 * this file and the loader's own tests change.
 *
 * Mocking the principal module in a test file (the factory must be dynamic: `vi.mock` is hoisted above the imports):
 *
 *   vi.mock("@/lib/access/principal", async () => (await import("../../helpers/access-mocks")).principalModule);
 *   import { principalModule, signInAs, signedOut, globalAdmin } from "../../helpers/access-mocks";
 *   beforeEach(() => signInAs(globalAdmin()));
 *
 * Mocking only the session and the database instead (to exercise the real loader), see `userRow` and `sessionOf`.
 */

export const T1 = "tenant-1";
export const T2 = "tenant-2";

/** Assignment builders: `assign.domain("AUTHOR", "tenant-1", "dom-a")`. */
export const assign = {
  global: (role: Role = "ADMIN"): Assignment => ({ role, scope: { kind: "GLOBAL" } }),
  tenant: (role: Role, tenantId: string = T1): Assignment => ({ role, scope: { kind: "TENANT", tenantId } }),
  domain: (role: Role, tenantId: string, domainId: string): Assignment => ({ role, scope: { kind: "DOMAIN", tenantId, domainId } }),
  product: (role: Role, tenantId: string, domainId: string, productId: string): Assignment => ({
    role,
    scope: { kind: "PRODUCT", tenantId, domainId, productId },
  }),
};

/** A principal holding exactly `assignments`; `isGlobalAdmin` is derived the way the loader derives it (through the policy, not a role name). */
export function principalOf(assignments: Assignment[], overrides: Partial<Principal> = {}): Principal {
  return {
    userId: "user-1",
    email: "user@example.test",
    assignments,
    isGlobalAdmin: can(assignments, "platform.admin", { tenantId: T1 }),
    ...overrides,
  };
}

/** A global (platform) administrator. */
export const globalAdmin = (userId = "admin-1"): Principal => principalOf([assign.global()], { userId, email: "admin@example.test" });
/** A signed-in user holding no role at all. */
export const roleless = (userId = "nobody-1"): Principal => principalOf([], { userId, email: "nobody@example.test" });
/** A signed-in user with one role at tenant scope. */
export const tenantMember = (role: Role, tenantId: string = T1, userId = "member-1"): Principal =>
  principalOf([assign.tenant(role, tenantId)], { userId, email: "member@example.test" });

/** The columns of a stored `user_roles` row for an assignment (the scope key and the ids the columns carry, consistent with each other). */
export function roleRowOf(assignment: Assignment) {
  const scope: Scope = assignment.scope;
  const key =
    scope.kind === "GLOBAL" ? "G" : scope.kind === "TENANT" ? `T:${scope.tenantId}` : scope.kind === "DOMAIN" ? `D:${scope.domainId}` : `P:${scope.productId}`;
  return {
    role: assignment.role,
    scopeKey: key,
    tenantId: scope.kind === "GLOBAL" ? null : scope.tenantId,
    domainId: scope.kind === "DOMAIN" || scope.kind === "PRODUCT" ? scope.domainId : null,
    productId: scope.kind === "PRODUCT" ? scope.productId : null,
  };
}

/** What the principal loader's `prisma.user.findUnique` returns for a user holding `assignments`. */
export function userRow(assignments: Assignment[], overrides: Partial<{ id: string; email: string; disabledAt: Date | null }> = {}) {
  return { id: "user-1", email: "user@example.test", disabledAt: null as Date | null, ...overrides, roles: assignments.map(roleRowOf) };
}

/** An Auth.js session for the user id. */
export const sessionOf = (id: string, email = "user@example.test") => ({ user: { id, email }, expires: "2999-01-01" });

/**
 * A stand-in for `@/lib/access/principal` (see the usage above): `getPrincipal` is a spy the test steers with `signInAs` / `signedOut`;
 * `loadPrincipalById` answers the same principal when the id matches.
 */
export const principalModule = {
  getPrincipal: vi.fn<() => Promise<Principal | null>>(async () => null),
  loadPrincipalById: vi.fn<(userId: unknown) => Promise<Principal | null>>(async () => null),
};

/** Make the mocked principal module answer `principal` (null = nobody signed in, or a disabled / unknown user). */
export function signInAs(principal: Principal | null): void {
  principalModule.getPrincipal.mockResolvedValue(principal);
  principalModule.loadPrincipalById.mockImplementation(async (userId: unknown) => (principal && principal.userId === userId ? principal : null));
}

/** `signInAs(null)`. */
export const signedOut = () => signInAs(null);

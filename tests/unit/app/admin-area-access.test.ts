// @vitest-environment node
/**
 * Access control over the admin actions. The REAL guard runs; what is replaced is the services behind the actions, which are the "effects" a
 * refused caller must never reach (and, for the user and role actions, what the service receives).
 *
 * The table: the users of the tenant and their roles (list, another user's name, assign, remove) are `user.manage`, a TENANT administrator's act over
 * the tenant in view; your own name is `profile.own` (anybody signed in); health and metrics are `platform.admin` and the emitter configuration
 * `emitter.manage`, a GLOBAL administrator's whatever they hold in a tenant; the admin domain list is any role in the tenant and creating a domain
 * `domain.create`, a steward's act over the whole tenant. For each: nobody signed in, a user with no role, the ladder at tenant scope, a role in
 * another tenant than the one in view, a domain- and a product-scoped administrator, a global administrator.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { assign, principalOf, roleless, signInAs, signedOut, tenantMember } from "../../helpers/access-mocks";
import { ROLE_HIERARCHY, type Role } from "@/types/schemas/rbac";
import { roleAtLeast } from "@/lib/access";

const T = "tenant-1";
const OTHER = "tenant-2";

const h = vi.hoisted(() => {
  const fn = () => vi.fn();
  return {
    activeTenant: fn(), revalidatePath: fn(),
    getUsers: fn(), updateUser: fn(), assignRole: fn(), removeRole: fn(),
    runHealthCheck: fn(), getUsageMetrics: fn(), getActivityMetrics: fn(), getErrorSummary: fn(),
    getEmitterConfigs: fn(), updateEmitterConfig: fn(), getDomainsAdmin: fn(), createDomainAdmin: fn(),
  };
});

vi.mock("next/cache", () => ({ revalidatePath: h.revalidatePath }));
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/db", () => ({ prisma: { tag: "prisma" } }));
vi.mock("@/lib/access/principal", async () => (await import("../../helpers/access-mocks")).principalModule);
vi.mock("@/lib/active-tenant", () => ({ getActiveTenantId: h.activeTenant }));
vi.mock("@/services/user.service", () => ({ getUsers: h.getUsers, updateUser: h.updateUser }));
vi.mock("@/services/rbac.service", () => ({ assignRole: h.assignRole, removeRole: h.removeRole }));
vi.mock("@/services/health.service", () => ({
  runHealthCheck: h.runHealthCheck, getUsageMetrics: h.getUsageMetrics, getActivityMetrics: h.getActivityMetrics, getErrorSummary: h.getErrorSummary,
}));
vi.mock("@/services/emitter-config.service", () => ({ getEmitterConfigs: h.getEmitterConfigs, updateEmitterConfig: h.updateEmitterConfig }));
vi.mock("@/services/domain-admin.service", () => ({ getDomainsAdmin: h.getDomainsAdmin, createDomainAdmin: h.createDomainAdmin }));

import * as admin from "@/app/(dashboard)/admin/actions";

const GENERIC_FORBIDDEN = "You do not have permission to do this";
const SERVICES = [
  h.getUsers, h.updateUser, h.assignRole, h.removeRole, h.runHealthCheck, h.getUsageMetrics, h.getActivityMetrics, h.getErrorSummary,
  h.getEmitterConfigs, h.updateEmitterConfig, h.getDomainsAdmin, h.createDomainAdmin, h.revalidatePath,
];
const reached = () => SERVICES.filter((service) => service.mock.calls.length > 0);
const errorOf = (answer: unknown) => (answer as { error?: string } | null)?.error;

type Op = { label: string; call: () => Promise<unknown>; kind: "tenant-admin" | "platform" | "steward" | "member" };

const OPS: Op[] = [
  { label: "getUsersAction", call: () => admin.getUsersAction(), kind: "tenant-admin" },
  { label: "updateUserNameAction (another user)", call: () => admin.updateUserNameAction("someone-else", "New"), kind: "tenant-admin" },
  { label: "assignRoleAction", call: () => admin.assignRoleAction({ userId: "u2", role: "VIEWER", tenantId: T }), kind: "tenant-admin" },
  { label: "removeRoleAction", call: () => admin.removeRoleAction("role-1"), kind: "tenant-admin" },
  { label: "getHealthAction", call: () => admin.getHealthAction(), kind: "platform" },
  { label: "getEmitterConfigsAction", call: () => admin.getEmitterConfigsAction(), kind: "platform" },
  { label: "updateEmitterConfigAction", call: () => admin.updateEmitterConfigAction({} as never), kind: "platform" },
  { label: "createDomainAdminAction", call: () => admin.createDomainAdminAction({ name: "D" } as never), kind: "steward" },
  { label: "getDomainsAdminAction", call: () => admin.getDomainsAdminAction(), kind: "member" },
];

const MIN: Record<Op["kind"], Role | null> = { "tenant-admin": "ADMIN", platform: null, steward: "STEWARD", member: "VIEWER" };

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  signInAs(tenantMember("ADMIN", T));
  h.activeTenant.mockResolvedValue(T);
  for (const service of SERVICES) service.mockResolvedValue({ success: true, data: { id: "x" } });
});

describe.each(OPS)("$label", (op) => {
  it("answers nobody signed in 'Not authenticated' and reaches nothing", async () => {
    signedOut();
    expect(errorOf(await op.call())).toBe("Not authenticated");
    expect(reached()).toHaveLength(0);
  });

  it("answers a user with no role at all as not found (a platform item: refused) and reaches nothing", async () => {
    signInAs(roleless());
    const message = errorOf(await op.call());
    expect(message).toBe(op.kind === "platform" ? GENERIC_FORBIDDEN : "Tenant not found");
    expect(reached()).toHaveLength(0);
  });

  it("follows the ladder at tenant scope: the minimum role may, below it is refused with the one generic text, nothing reached", async () => {
    for (const role of ROLE_HIERARCHY) {
      vi.clearAllMocks();
      signInAs(tenantMember(role, T));
      h.activeTenant.mockResolvedValue(T);
      for (const service of SERVICES) service.mockResolvedValue({ success: true, data: { id: "x" } });
      const message = errorOf(await op.call());
      const min = MIN[op.kind];
      if (min !== null && roleAtLeast(role, min)) {
        expect(message, role).toBeUndefined();
        expect(reached(), role).not.toHaveLength(0);
      } else {
        expect(message, role).toBe(GENERIC_FORBIDDEN);
        expect(reached(), `${role} reached an effect`).toHaveLength(0);
      }
    }
  });

  it("a platform administrator may", async () => {
    signInAs(principalOf([assign.global()]));
    expect(errorOf(await op.call())).toBeUndefined();
  });

  it(op.kind === "platform" ? "a tenant administrator of EVERY tenant still does not reach a platform item" : "a role in another tenant than the one in view gives nothing", async () => {
    signInAs(op.kind === "platform" ? principalOf([assign.tenant("ADMIN", T), assign.tenant("ADMIN", OTHER)]) : tenantMember("ADMIN", OTHER));
    expect(errorOf(await op.call())).toBe(op.kind === "platform" ? GENERIC_FORBIDDEN : "Tenant not found");
    expect(reached()).toHaveLength(0);
  });

  if (op.kind !== "platform") {
    it("a domain- or product-scoped administrator does not reach a tenant-wide act (the tenant is theirs to see, not to administer)", async () => {
      if (op.kind === "member") return; // any role in the tenant opens the list: the service lists only what the roles cover
      for (const assignments of [[assign.domain("ADMIN", T, "dom-a")], [assign.product("ADMIN", T, "dom-a", "prod-a")]]) {
        signInAs(principalOf(assignments));
        expect(errorOf(await op.call()), JSON.stringify(assignments)).toBe(GENERIC_FORBIDDEN);
      }
      expect(reached()).toHaveLength(0);
    });
  }
});

describe("the context the user and role services receive", () => {
  it("is the principal's: the user, the assignments and the tenant in view, never a role label", async () => {
    const assignments = [assign.tenant("ADMIN", T)];
    signInAs(principalOf(assignments, { userId: "admin-9" }));
    await admin.getUsersAction();
    await admin.assignRoleAction({ userId: "u2", role: "VIEWER", tenantId: T });
    await admin.removeRoleAction("role-1");
    for (const service of [h.getUsers, h.assignRole, h.removeRole]) {
      const ctx = service.mock.calls[0].find((arg: unknown) => typeof arg === "object" && arg !== null && "assignments" in arg);
      expect(ctx).toMatchObject({ userId: "admin-9", assignments, tenantId: T });
    }
  });

  it("a platform item carries no tenant (nothing was looked up for one)", async () => {
    signInAs(principalOf([assign.global()], { userId: "root" }));
    await admin.getEmitterConfigsAction();
    expect(h.getEmitterConfigs.mock.calls[0][0]).toEqual(expect.objectContaining({ userId: "root", assignments: [assign.global()] }));
    expect(h.getEmitterConfigs.mock.calls[0][0].tenantId).toBeUndefined();
  });

  it("the health page counts the governance requests of the tenant in view", async () => {
    signInAs(principalOf([assign.global()]));
    await admin.getHealthAction();
    expect(h.getActivityMetrics).toHaveBeenCalledWith(expect.anything(), T);
  });
});

describe("updateUserNameAction", () => {
  it("lets anybody signed in change THEIR OWN name (profile.own), a roleless user included, with no tenant needed", async () => {
    signInAs(roleless("nobody-1"));
    expect(errorOf(await admin.updateUserNameAction("nobody-1", "Me"))).toBeUndefined();
    expect(h.updateUser).toHaveBeenCalledWith({ id: "nobody-1", name: "Me" }, expect.objectContaining({ userId: "nobody-1" }));
  });

  it("lets nobody change another user's name without user.manage", async () => {
    signInAs(tenantMember("AUTHOR", T, "author-1"));
    expect(errorOf(await admin.updateUserNameAction("someone-else", "x"))).toBe(GENERIC_FORBIDDEN);
    expect(h.updateUser).not.toHaveBeenCalled();
  });
});

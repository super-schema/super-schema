// @vitest-environment node
/**
 * Tenant membership. The `active_tenant` cookie is a CHOICE, not an entitlement: it counts only when the principal may access that
 * tenant; else the first tenant they can access; and when there is none, a typed `NoTenantAccess` (the pages turn it into the
 * "no access yet" screen). `accessibleTenants` is the list the switcher and `/api/tenants` show.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { assign, globalAdmin, principalOf, roleless, signInAs, signedOut, tenantMember } from "../../helpers/access-mocks";

const mocks = vi.hoisted(() => ({
  cookieValue: undefined as string | undefined,
  prisma: { tenant: { findUnique: vi.fn(), findFirst: vi.fn(), findMany: vi.fn() } },
}));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: (name: string) => (name === "active_tenant" && mocks.cookieValue ? { value: mocks.cookieValue } : undefined) }) }));
vi.mock("@/lib/db", () => ({ prisma: mocks.prisma }));
vi.mock("@/lib/access/principal", async () => (await import("../../helpers/access-mocks")).principalModule);

import { NoTenantAccess, isNoTenantAccess } from "@/lib/access/no-tenant-access";
import { DEFAULT_TENANT_ID } from "@/lib/org-defaults";
import { accessibleTenants, getActiveTenantId, requireActiveTenantId } from "@/lib/active-tenant";

const ORDER = [{ isSystem: "desc" }, { name: "asc" }];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.cookieValue = undefined;
  mocks.prisma.tenant.findUnique.mockResolvedValue(null);
  mocks.prisma.tenant.findFirst.mockResolvedValue(null);
  mocks.prisma.tenant.findMany.mockResolvedValue([]);
});

describe("NoTenantAccess", () => {
  it("is a typed error that can be told from any other, also when the class was loaded twice", () => {
    const error = new NoTenantAccess();
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("NoTenantAccess");
    expect(isNoTenantAccess(error)).toBe(true);
    expect(isNoTenantAccess(Object.assign(new Error("x"), { name: "NoTenantAccess" }))).toBe(true);
    expect(isNoTenantAccess(new Error("No tenant access"))).toBe(false);
    for (const other of [null, undefined, "NoTenantAccess", 5, {}]) expect(isNoTenantAccess(other)).toBe(false);
  });
});

describe("getActiveTenantId", () => {
  it("throws NoTenantAccess for nobody (signed out, a disabled user, a stale session)", async () => {
    signedOut();
    mocks.cookieValue = "t1";
    await expect(getActiveTenantId()).rejects.toBeInstanceOf(NoTenantAccess);
    expect(mocks.prisma.tenant.findUnique).not.toHaveBeenCalled();
  });

  it("throws NoTenantAccess for a user with no role, however the cookie is set, and asks the database nothing", async () => {
    signInAs(roleless());
    for (const cookie of [undefined, "t1", "default-tenant", "no-such-tenant"]) {
      mocks.cookieValue = cookie;
      await expect(getActiveTenantId(), String(cookie)).rejects.toBeInstanceOf(NoTenantAccess);
    }
    expect(mocks.prisma.tenant.findUnique).not.toHaveBeenCalled();
    expect(mocks.prisma.tenant.findFirst).not.toHaveBeenCalled();
  });

  it("returns the cookie tenant when the user holds a role in it (a tenant switch with an assignment works)", async () => {
    signInAs(principalOf([assign.tenant("VIEWER", "t1"), assign.tenant("AUTHOR", "t2")]));
    mocks.cookieValue = "t2";
    await expect(getActiveTenantId()).resolves.toBe("t2");
    mocks.cookieValue = "t1";
    await expect(getActiveTenantId()).resolves.toBe("t1");
  });

  it("counts a role at ANY depth in the tenant: a domain-scoped or product-scoped role is membership of its tenant", async () => {
    signInAs(principalOf([assign.domain("AUTHOR", "t1", "d1")]));
    mocks.cookieValue = "t1";
    await expect(getActiveTenantId()).resolves.toBe("t1");
    signInAs(principalOf([assign.product("VIEWER", "t3", "d9", "p9")]));
    mocks.cookieValue = "t3";
    await expect(getActiveTenantId()).resolves.toBe("t3");
  });

  it("ignores a cookie for a tenant the user holds no role in, and takes the first tenant they can access (system first, then by name)", async () => {
    signInAs(principalOf([assign.tenant("VIEWER", "t1"), assign.domain("AUTHOR", "t2", "d2")]));
    mocks.cookieValue = "forbidden-tenant";
    mocks.prisma.tenant.findFirst.mockResolvedValue({ id: "t2" });

    await expect(getActiveTenantId()).resolves.toBe("t2");

    expect(mocks.prisma.tenant.findFirst).toHaveBeenCalledTimes(1);
    const query = mocks.prisma.tenant.findFirst.mock.calls[0][0];
    expect(query.orderBy).toEqual(ORDER);
    expect(query.where.isActive).toBe(true);
    expect([...query.where.id.in].sort()).toEqual(["t1", "t2"]);
  });

  it("takes the first accessible tenant when there is no cookie, and throws NoTenantAccess when none of the tenants they hold roles in is active", async () => {
    signInAs(tenantMember("VIEWER", "t1"));
    mocks.prisma.tenant.findFirst.mockResolvedValueOnce({ id: "t1" });
    await expect(getActiveTenantId()).resolves.toBe("t1");
    mocks.prisma.tenant.findFirst.mockResolvedValueOnce(null);
    await expect(getActiveTenantId()).rejects.toBeInstanceOf(NoTenantAccess);
  });

  it("never returns a tenant of the cookie for a user whose only role is in another tenant, even when that tenant exists", async () => {
    signInAs(tenantMember("ADMIN", "t1"));
    mocks.cookieValue = "t2";
    mocks.prisma.tenant.findUnique.mockResolvedValue({ id: "t2" });
    mocks.prisma.tenant.findFirst.mockResolvedValue({ id: "t1" });
    await expect(getActiveTenantId()).resolves.toBe("t1");
  });

  it("a global administrator may work in any tenant that exists: the cookie tenant, else the first active one, else the default", async () => {
    signInAs(globalAdmin());
    mocks.cookieValue = "any-tenant";
    mocks.prisma.tenant.findUnique.mockResolvedValue({ id: "any-tenant" });
    await expect(getActiveTenantId()).resolves.toBe("any-tenant");

    mocks.prisma.tenant.findUnique.mockResolvedValue(null); // the cookie names a tenant that no longer exists
    mocks.prisma.tenant.findFirst.mockResolvedValue({ id: "first-active" });
    await expect(getActiveTenantId()).resolves.toBe("first-active");
    expect(mocks.prisma.tenant.findFirst).toHaveBeenCalledWith({ where: { isActive: true }, orderBy: ORDER, select: { id: true } });

    mocks.cookieValue = undefined;
    mocks.prisma.tenant.findFirst.mockResolvedValue(null);
    await expect(getActiveTenantId()).resolves.toBe(DEFAULT_TENANT_ID);
  });
});

describe("requireActiveTenantId (for pages)", () => {
  it("is getActiveTenantId, and sends a user with no tenant access to /no-access", async () => {
    signInAs(tenantMember("VIEWER", "t1"));
    mocks.cookieValue = "t1";
    await expect(requireActiveTenantId()).resolves.toBe("t1");

    signInAs(roleless());
    await expect(requireActiveTenantId()).rejects.toMatchObject({ digest: expect.stringContaining("NEXT_REDIRECT") });
  });

  it("does not hide any other failure", async () => {
    signInAs(globalAdmin());
    mocks.cookieValue = "t1";
    mocks.prisma.tenant.findUnique.mockRejectedValue(new Error("connection lost"));
    await expect(requireActiveTenantId()).rejects.toThrow("connection lost");
  });
});

describe("accessibleTenants", () => {
  it("is empty for a user with no role, without a query", async () => {
    await expect(accessibleTenants(roleless())).resolves.toEqual([]);
    expect(mocks.prisma.tenant.findMany).not.toHaveBeenCalled();
  });

  it("lists only the active tenants the user holds a role in, at any depth, each once", async () => {
    const rows = [{ id: "t1", name: "A", _count: { domains: 2 } }];
    mocks.prisma.tenant.findMany.mockResolvedValue(rows);
    const principal = principalOf([assign.tenant("VIEWER", "t1"), assign.domain("AUTHOR", "t1", "d1"), assign.product("VIEWER", "t2", "d2", "p2")]);

    await expect(accessibleTenants(principal)).resolves.toBe(rows);

    const query = mocks.prisma.tenant.findMany.mock.calls[0][0];
    expect(query.where.isActive).toBe(true);
    expect([...query.where.id.in].sort()).toEqual(["t1", "t2"]);
    expect(query.orderBy).toEqual(ORDER);
    expect(query.include).toEqual({ _count: { select: { domains: true } } });
  });

  it("is every active tenant for a global administrator", async () => {
    await accessibleTenants(globalAdmin());
    expect(mocks.prisma.tenant.findMany).toHaveBeenCalledWith({ where: { isActive: true }, orderBy: ORDER, include: { _count: { select: { domains: true } } } });
  });
});

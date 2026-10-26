// @vitest-environment node
/**
 * GET /api/tenants lists the tenants the signed-in user may access and the one that is active: nothing for a user with no role (an empty
 * list, not an error: the shell shows its "no access" state), never a tenant they hold no role in.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { assign, globalAdmin, principalOf, roleless, signInAs, signedOut } from "../../helpers/access-mocks";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  activeTenant: vi.fn(),
  prisma: { tenant: { findMany: vi.fn() } },
}));
vi.mock("@/lib/auth", () => ({ auth: mocks.auth }));
vi.mock("@/lib/db", () => ({ prisma: mocks.prisma }));
vi.mock("@/lib/access/principal", async () => (await import("../../helpers/access-mocks")).principalModule);
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }) }));

import { NoTenantAccess } from "@/lib/access/no-tenant-access";

// The route reads the active tenant through the module under test elsewhere (tests/unit/lib/active-tenant.test.ts); here only its outcome matters.
vi.mock("@/lib/active-tenant", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/active-tenant")>();
  return { ...original, getActiveTenantId: mocks.activeTenant };
});

import { GET } from "@/app/api/tenants/route";

const row = (id: string, domains = 1) => ({ id, name: `Tenant ${id}`, slug: id, description: "", isSystem: false, _count: { domains } });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockResolvedValue({ user: { id: "user-1" }, expires: "2999-01-01" });
  signInAs(principalOf([assign.tenant("VIEWER", "t1")]));
  mocks.activeTenant.mockResolvedValue("t1");
  mocks.prisma.tenant.findMany.mockResolvedValue([row("t1", 3)]);
});

describe("GET /api/tenants", () => {
  it("is a 401 without a session, as before, and reads nothing", async () => {
    mocks.auth.mockResolvedValue(null);
    signedOut();
    const response = await GET();
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Not authenticated" });
    expect(mocks.prisma.tenant.findMany).not.toHaveBeenCalled();
  });

  it("lists the tenants the user holds a role in, with the active one", async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      activeTenantId: "t1",
      tenants: [{ id: "t1", name: "Tenant t1", slug: "t1", description: "", isSystem: false, domainCount: 3 }],
    });
    const query = mocks.prisma.tenant.findMany.mock.calls[0][0];
    expect(query.where.id.in).toEqual(["t1"]);
  });

  it("is an empty list for a user with no role at all (200, no active tenant), and queries no tenant", async () => {
    signInAs(roleless());
    mocks.activeTenant.mockRejectedValue(new NoTenantAccess());
    const response = await GET();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ activeTenantId: null, tenants: [] });
    expect(mocks.prisma.tenant.findMany).not.toHaveBeenCalled();
  });

  it("lists every active tenant for a global administrator", async () => {
    signInAs(globalAdmin());
    mocks.prisma.tenant.findMany.mockResolvedValue([row("t1"), row("t2")]);
    const body = await (await GET()).json();
    expect(body.tenants.map((t: { id: string }) => t.id)).toEqual(["t1", "t2"]);
    expect(mocks.prisma.tenant.findMany.mock.calls[0][0].where).toEqual({ isActive: true });
  });

  it("does not hide a failure that is not 'no access'", async () => {
    mocks.activeTenant.mockRejectedValue(new Error("connection lost"));
    await expect(GET()).rejects.toThrow("connection lost");
  });
});

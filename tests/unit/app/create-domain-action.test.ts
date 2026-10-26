import { beforeEach, describe, expect, it, vi } from "vitest";

// `createDomainAction` (the Domains page): any signed-in user may make a domain, and the row is made by the same function the Admin tab
// uses, so it has the same rules: a name with no letter or digit has no slug ("!!!" used to be created with the slug ""), and a name
// the tenant has in another case is a duplicate (the old pre-check was the database's case-sensitive index alone).
const h = vi.hoisted(() => ({
  auth: vi.fn(),
  revalidatePath: vi.fn(),
  prisma: {
    domain: { findFirst: vi.fn(), create: vi.fn() },
    tenant: { findUnique: vi.fn(), upsert: vi.fn() },
    user: { findUnique: vi.fn() },
    auditLog: { create: vi.fn() },
  },
}));
vi.mock("@/lib/db", () => ({ prisma: h.prisma }));
vi.mock("@/lib/access/principal", async () => (await import("../../helpers/access-mocks")).sessionPrincipalModule);
vi.mock("@/lib/auth", () => ({ auth: h.auth }));
vi.mock("next/cache", () => ({ revalidatePath: h.revalidatePath }));
vi.mock("@/lib/active-tenant", () => ({ getActiveTenantId: vi.fn(async () => "tenant-a") }));
vi.mock("@/lib/access-control", () => ({ resolveGlobalAdminAccess: vi.fn() }));
vi.mock("@/lib/action-context", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/action-context")>()),
  isInActiveTenant: vi.fn(),
}));

import { createDomainAction } from "@/app/(dashboard)/schemas/actions";

const form = (name: string, description?: string) => {
  const fd = new FormData();
  fd.set("name", name);
  if (description !== undefined) fd.set("description", description);
  return fd;
};

describe("createDomainAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.auth.mockResolvedValue({ user: { id: "user-1" } });
    h.prisma.tenant.findUnique.mockResolvedValue({ id: "tenant_default" });
    h.prisma.user.findUnique.mockResolvedValue({ id: "user-1" });
    h.prisma.auditLog.create.mockResolvedValue({ id: "audit-1" });
    h.prisma.domain.findFirst.mockResolvedValue(null);
    h.prisma.domain.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: "dom-1", ...data }));
  });

  it("makes the domain in the active tenant for a signed-in user (no role asked), audits it and revalidates /schemas", async () => {
    const result = await createDomainAction(form("Payments", "Money"));

    expect(result).toEqual({ success: true });
    expect(h.prisma.domain.create).toHaveBeenCalledWith({ data: { name: "Payments", slug: "payments", description: "Money", tenantId: "tenant-a" } });
    expect(h.prisma.auditLog.create).toHaveBeenCalledTimes(1);
    expect(h.prisma.auditLog.create.mock.calls[0][0].data).toMatchObject({ action: "CREATE", entityType: "Domain", userId: "user-1" });
    expect(h.revalidatePath).toHaveBeenCalledWith("/schemas");
  });

  it("refuses a visitor with no session", async () => {
    h.auth.mockResolvedValue(null);
    expect(await createDomainAction(form("Payments"))).toEqual({ error: "You must be logged in" });
    expect(h.prisma.domain.create).not.toHaveBeenCalled();
  });

  it.each([
    ["!!!", "Domain name must contain at least one letter or digit"],
    ["   ", "Domain name is required"],
    ["x".repeat(65), "Domain name must be 64 characters or less"],
    ["Type Mappings", '"type-mappings" is reserved for a schemas utility page'],
  ])("refuses the name %j with %j and creates nothing", async (name, error) => {
    expect(await createDomainAction(form(name))).toEqual({ error });
    expect(h.prisma.domain.create).not.toHaveBeenCalled();
    expect(h.revalidatePath).not.toHaveBeenCalled();
  });

  it("refuses a name the tenant has in another case, by name and before writing", async () => {
    h.prisma.domain.findFirst.mockResolvedValue({ id: "dom-existing" });

    expect(await createDomainAction(form("PAYMENTS"))).toEqual({ error: 'A domain named "PAYMENTS" already exists' });
    expect(h.prisma.domain.findFirst).toHaveBeenCalledWith({ where: { tenantId: "tenant-a", name: { equals: "PAYMENTS", mode: "insensitive" } }, select: { id: true } });
    expect(h.prisma.domain.create).not.toHaveBeenCalled();
  });

  it("answers a unique-index clash the pre-check missed as a duplicate", async () => {
    h.prisma.domain.create.mockRejectedValue(Object.assign(new Error("Unique constraint failed on the fields: (`slug`,`tenantId`)"), { code: "P2002" }));
    expect(await createDomainAction(form("order-data"))).toEqual({ error: 'A domain named "order-data" already exists' });
  });

  it("tells a session whose user is gone to sign in again", async () => {
    h.prisma.user.findUnique.mockResolvedValue(null);
    expect(await createDomainAction(form("Payments"))).toEqual({ error: "Your session is stale. Sign out and sign in again, then create the domain." });
    expect(h.prisma.domain.create).not.toHaveBeenCalled();
  });
});

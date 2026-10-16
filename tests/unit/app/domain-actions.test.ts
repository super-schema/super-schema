import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockAuth, mockPrisma, mockRevalidatePath } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockRevalidatePath: vi.fn(),
  mockPrisma: {
    user: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
    },
    userRole: {
      findFirst: vi.fn(),
      create: vi.fn(),
    },
    domain: {
      findUnique: vi.fn(),
      delete: vi.fn(),
    },
    // Cross-domain event reference lookup (findCrossProductEventRefs): empty unless a test says otherwise.
    schemaReference: { findMany: vi.fn() },
    eventSpecVersion: { findMany: vi.fn() },
    eventSpec: { findMany: vi.fn() },
    auditLog: {
      create: vi.fn(),
    },
  },
}));

vi.mock("@/lib/auth", () => ({
  auth: mockAuth,
}));

vi.mock("@/lib/db", () => ({
  prisma: mockPrisma,
}));

vi.mock("next/cache", () => ({
  revalidatePath: mockRevalidatePath,
}));

vi.mock("@/lib/active-tenant", () => ({ getActiveTenantId: vi.fn().mockResolvedValue("tenant-1") }));

import { deleteDomainAction } from "@/app/(dashboard)/schemas/actions";

const EMPTY_COUNTS = {
  entities: 0,
  products: 0,
  modelDefinitions: 0,
  decoratorDefinitions: 0,
  sharedEnums: 0,
  customScalars: 0,
  unionTypes: 0,
  services: 0,
  interfaces: 0,
  userRoles: 0,
  traits: 0,
  eventSpecs: 0,
};

describe("deleteDomainAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({
      user: { id: "admin-1", email: "admin@example.com" },
    });
    mockPrisma.user.findUnique.mockImplementation(async (args) =>
      args.select?.roles
        ? { id: "admin-1", roles: [{ id: "admin-role" }] }
        : { id: "admin-1" }
    );
    mockPrisma.userRole.findFirst.mockResolvedValue({
      userId: "existing-admin",
    });
    mockPrisma.user.findFirst.mockResolvedValue({ id: "admin-1" });
    mockPrisma.userRole.create.mockResolvedValue({ id: "admin-role" });
    mockPrisma.domain.findUnique.mockResolvedValue({
      id: "domain-1",
      tenantId: "tenant-1",
      name: "Orders",
      slug: "orders",
      description: "Order schemas",
      isSystem: false,
      policyTemplate: null,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
      _count: { ...EMPTY_COUNTS, modelDefinitions: 2, sharedEnums: 1 },
    });
    mockPrisma.domain.delete.mockResolvedValue({ id: "domain-1" });
    mockPrisma.auditLog.create.mockResolvedValue({ id: "audit-1" });
    mockPrisma.schemaReference.findMany.mockResolvedValue([]);
    mockPrisma.eventSpecVersion.findMany.mockResolvedValue([]);
    mockPrisma.eventSpec.findMany.mockResolvedValue([]);
  });

  it("rejects authenticated users without a global Admin role", async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ id: "viewer-1", roles: [] });
    mockAuth.mockResolvedValue({
      user: { id: "viewer-1", email: "viewer@example.com" },
    });

    const result = await deleteDomainAction("domain-1");

    expect(result).toEqual({
      error: "Administrator access is required to delete domains",
    });
    expect(mockPrisma.domain.findUnique).not.toHaveBeenCalled();
    expect(mockPrisma.domain.delete).not.toHaveBeenCalled();
  });

  it("bootstraps the first registered user when no Admin exists", async () => {
    mockPrisma.user.findUnique.mockImplementation(async (args) =>
      args.select?.roles
        ? { id: "admin-1", roles: [] }
        : { id: "admin-1" }
    );
    mockPrisma.userRole.findFirst.mockResolvedValue(null);

    const result = await deleteDomainAction("domain-1");

    expect(result).toEqual({ success: true });
    expect(mockPrisma.userRole.create).toHaveBeenCalledWith({
      data: {
        id: "system-bootstrap-global-admin",
        userId: "admin-1",
        role: "ADMIN",
        domainId: null,
      },
    });
  });

  it("loads every cascaded asset count before an Admin deletes the domain", async () => {
    const result = await deleteDomainAction("domain-1");

    expect(result).toEqual({ success: true });
    expect(mockPrisma.domain.findUnique).toHaveBeenCalledWith({
      where: { id: "domain-1" },
      include: {
        _count: {
          select: {
            entities: true,
            products: true,
            modelDefinitions: true,
            decoratorDefinitions: true,
            sharedEnums: true,
            customScalars: true,
            unionTypes: true,
            services: true,
            interfaces: true,
            userRoles: true,
            traits: true,
            eventSpecs: true,
          },
        },
      },
    });
    expect(mockPrisma.domain.delete).toHaveBeenCalledWith({
      where: { id: "domain-1" },
    });
    expect(mockPrisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ userId: "admin-1" }),
      })
    );
    expect(mockRevalidatePath).toHaveBeenCalledWith("/schemas");
  });

  it("blocks deletion when the current database count includes entities", async () => {
    mockPrisma.domain.findUnique.mockResolvedValue({
      id: "domain-1",
      tenantId: "tenant-1",
      name: "Orders",
      slug: "orders",
      description: "Order schemas",
      isSystem: false,
      _count: { ...EMPTY_COUNTS, entities: 1 },
    });

    const result = await deleteDomainAction("domain-1");

    expect(result).toEqual({
      error:
        "Cannot delete - 1 entity exists in this domain or its products. Move or delete it first.",
    });
    expect(mockPrisma.domain.delete).not.toHaveBeenCalled();
  });
  describe("Events assets", () => {
    const domainWith = (counts: Partial<typeof EMPTY_COUNTS>) =>
      mockPrisma.domain.findUnique.mockResolvedValue({
        id: "domain-1",
        tenantId: "tenant-1",
        name: "Orders",
        slug: "orders",
        description: "Order schemas",
        isSystem: false,
        _count: { ...EMPTY_COUNTS, ...counts },
      });

    it.each([
      ["traits", { traits: 3 }, "Cannot delete - 3 traits exist in this domain or its products. Move or delete them first."],
      ["an event", { eventSpecs: 1 }, "Cannot delete - 1 event exists in this domain or its products. Move or delete it first."],
      ["events", { eventSpecs: 4 }, "Cannot delete - 4 events exist in this domain or its products. Move or delete them first."],
    ])("blocks deletion while the domain or its products own %s", async (_kind, counts, error) => {
      domainWith(counts);

      const result = await deleteDomainAction("domain-1");

      expect(result).toEqual({ error });
      expect(mockPrisma.domain.delete).not.toHaveBeenCalled();
      expect(mockPrisma.auditLog.create).not.toHaveBeenCalled();
      expect(mockRevalidatePath).not.toHaveBeenCalled();
    });

    it("keeps cascading the non-blocking assets when no entity and no Events asset exists", async () => {
      domainWith({ products: 2, sharedEnums: 3, services: 1, modelDefinitions: 1, userRoles: 1 });

      expect(await deleteDomainAction("domain-1")).toEqual({ success: true });
      expect(mockPrisma.domain.delete).toHaveBeenCalledTimes(1);
      // a domain without events has no event version for anyone to reference: the lookup is skipped
      expect(mockPrisma.eventSpecVersion.findMany).not.toHaveBeenCalled();
    });

    const spec = { id: "s-out", name: "fraud-consumer", domainId: "dom-9", productId: "prd-9", domain: { name: "Risk" }, product: { name: "Fraud" } };
    /** An event of ANOTHER domain holds a draft reference to a published version of an event of this domain. */
    function referencedByAnotherDomainsEvent() {
      mockPrisma.eventSpecVersion.findMany.mockResolvedValue([{ id: "sv-in", major: 2, minor: 1 }]);
      mockPrisma.schemaReference.findMany.mockResolvedValue([{ fromKind: "EVENT_SPEC", fromId: "s-out", toId: "sv-in" }]);
      mockPrisma.eventSpec.findMany.mockResolvedValue([spec]);
    }

    it("reports entities, events and the referencing events of other domains together", async () => {
      domainWith({ entities: 1, eventSpecs: 2 });
      referencedByAnotherDomainsEvent();

      const result = await deleteDomainAction("domain-1");

      expect(result).toEqual({
        error:
          "Cannot delete - 1 entity and 2 events exist in this domain or its products. Move or delete them first. " +
          "Domain \"Orders\" cannot be deleted: other domains' events reference its events: fraud-consumer (Risk/Fraud).",
      });
      expect(mockPrisma.domain.delete).not.toHaveBeenCalled();
    });

    it("names the referencing event even though the count message is the only other blocker", async () => {
      domainWith({ eventSpecs: 1 });
      referencedByAnotherDomainsEvent();

      const result = (await deleteDomainAction("domain-1")) as { error: string };

      expect(result.error).toContain("other domains' events reference its events: fraud-consumer (Risk/Fraud).");
      expect(mockPrisma.domain.delete).not.toHaveBeenCalled();
    });

    it("scopes the reference lookup to the domain's tenant and to the published versions of the domain's own events", async () => {
      domainWith({ eventSpecs: 1 });
      referencedByAnotherDomainsEvent();

      await deleteDomainAction("domain-1");

      expect(mockPrisma.eventSpecVersion.findMany.mock.calls[0][0]).toMatchObject({
        where: { eventSpec: { tenantId: "tenant-1", domainId: "domain-1" } },
      });
      expect(mockPrisma.eventSpec.findMany.mock.calls[0][0]).toMatchObject({ where: { id: { in: ["s-out"] }, tenantId: "tenant-1" } });
    });

    it("does not look at events for non-admins", async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ id: "viewer-1", roles: [] });
      mockAuth.mockResolvedValue({ user: { id: "viewer-1", email: "viewer@example.com" } });
      await deleteDomainAction("domain-1");
      expect(mockPrisma.eventSpecVersion.findMany).not.toHaveBeenCalled();
    });
  });
});

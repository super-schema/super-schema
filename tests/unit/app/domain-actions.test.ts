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
    // Cross-product pin lookup (findCrossProductPins): empty unless a test says otherwise.
    messageVersion: { findMany: vi.fn() },
    channel: { findMany: vi.fn() },
    trait: { findMany: vi.fn() },
    schemaReference: { findMany: vi.fn() },
    eventSpecVersion: { findMany: vi.fn() },
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
  channels: 0,
  messages: 0,
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
    mockPrisma.messageVersion.findMany.mockResolvedValue([]);
    mockPrisma.channel.findMany.mockResolvedValue([]);
    mockPrisma.trait.findMany.mockResolvedValue([]);
    mockPrisma.schemaReference.findMany.mockResolvedValue([]);
    mockPrisma.eventSpecVersion.findMany.mockResolvedValue([]);
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
            channels: true,
            messages: true,
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
      ["channels", { channels: 2 }, "Cannot delete - 2 channels exist in this domain or its products. Move or delete them first."],
      ["messages", { messages: 1 }, "Cannot delete - 1 message exists in this domain or its products. Move or delete it first."],
      ["traits", { traits: 3 }, "Cannot delete - 3 traits exist in this domain or its products. Move or delete them first."],
      ["event specs", { eventSpecs: 1 }, "Cannot delete - 1 event spec exists in this domain or its products. Move or delete it first."],
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
    });

    it("reports entities, Events assets and the referencing specs of other products together", async () => {
      domainWith({ entities: 1, channels: 1, messages: 2 });
      mockPrisma.messageVersion.findMany.mockResolvedValue([{ id: "mv-1", message: { id: "m-1", name: "OrderCreated" } }]);
      mockPrisma.channel.findMany.mockResolvedValue([{ id: "c-1", name: "orders" }]);
      mockPrisma.eventSpecVersion.findMany.mockResolvedValue([
        {
          id: "sv-1",
          major: 2,
          minor: 1,
          messageVersionIds: ["mv-1"],
          frozenChannels: [{ id: "c-1" }],
          frozenTraits: [],
          eventSpec: { id: "s-1", name: "fraud-consumer", productId: "prd-9", product: { id: "prd-9", name: "Fraud" } },
        },
      ]);

      const result = await deleteDomainAction("domain-1");

      expect(result).toEqual({
        error:
          "Cannot delete - 1 entity, 1 channel and 2 messages exist in this domain or its products. Move or delete them first. " +
          'A published event spec in another product references assets owned here: "fraud-consumer" (product "Fraud", v2.1) ' +
          'references Message "OrderCreated" and Channel "orders". Delete that event spec first (published versions cannot be changed), then retry.',
      });
      expect(mockPrisma.domain.delete).not.toHaveBeenCalled();
    });

    it("blocks on a cross-product pin even when the counts alone would allow the delete", async () => {
      domainWith({});
      mockPrisma.messageVersion.findMany.mockResolvedValue([{ id: "mv-1", message: { id: "m-1", name: "OrderCreated" } }]);
      mockPrisma.eventSpecVersion.findMany.mockResolvedValue([
        {
          id: "sv-1",
          major: 1,
          minor: 0,
          messageVersionIds: ["mv-1"],
          frozenChannels: [],
          frozenTraits: [],
          eventSpec: { id: "s-1", name: "fraud-consumer", productId: "prd-9", product: { id: "prd-9", name: "Fraud" } },
        },
      ]);

      const result = await deleteDomainAction("domain-1");

      expect(result).toEqual({
        error:
          'A published event spec in another product references assets owned here: "fraud-consumer" (product "Fraud", v1.0) ' +
          'references Message "OrderCreated". Delete that event spec first (published versions cannot be changed), then retry.',
      });
      expect(mockPrisma.domain.delete).not.toHaveBeenCalled();
    });

    it("scopes the pin lookup to the domain's tenant and to specs outside the domain", async () => {
      domainWith({});
      mockPrisma.channel.findMany.mockResolvedValue([{ id: "c-1", name: "orders" }]);

      await deleteDomainAction("domain-1");

      expect(mockPrisma.messageVersion.findMany.mock.calls[0][0]).toMatchObject({ where: { message: { domainId: "domain-1" } } });
      expect(mockPrisma.channel.findMany.mock.calls[0][0]).toMatchObject({ where: { domainId: "domain-1" } });
      expect(mockPrisma.trait.findMany.mock.calls[0][0]).toMatchObject({ where: { domainId: "domain-1" } });
      expect(mockPrisma.eventSpecVersion.findMany.mock.calls[0][0]).toMatchObject({
        where: { eventSpec: { tenantId: "tenant-1", domainId: { not: "domain-1" } } },
      });
    });

    it("does not look at Events assets for non-admins", async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ id: "viewer-1", roles: [] });
      mockAuth.mockResolvedValue({ user: { id: "viewer-1", email: "viewer@example.com" } });
      await deleteDomainAction("domain-1");
      expect(mockPrisma.channel.findMany).not.toHaveBeenCalled();
    });
  });
});

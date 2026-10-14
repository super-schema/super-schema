import { describe, expect, it, vi, beforeEach } from "vitest";

const { mockAuth, mockPrisma, mockTx, mockAssertNameAvailable } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockPrisma: {
    user: {
      findUnique: vi.fn(),
    },
    $transaction: vi.fn(),
  },
  mockTx: {
    modelDefinition: {
      create: vi.fn(),
    },
    entity: {
      create: vi.fn(),
      findMany: vi.fn(),
    },
    product: {
      findUnique: vi.fn(),
      create: vi.fn(),
    },
    domain: {
      findUnique: vi.fn(),
    },
    serviceDefinition: {
      create: vi.fn(),
    },
    sharedEnum: {
      create: vi.fn(),
    },
    customScalar: {
      create: vi.fn(),
    },
    unionType: {
      create: vi.fn(),
    },
    $executeRaw: vi.fn(),
  },
  mockAssertNameAvailable: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  auth: mockAuth,
}));

vi.mock("@/lib/db", () => ({
  prisma: mockPrisma,
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

vi.mock("@/services/name-registry.service", () => ({
  assertNameAvailable: mockAssertNameAvailable,
}));

import { createDomainAssetsFromImportAction } from "@/app/(dashboard)/schemas/[domainSlug]/actions";

describe("schema import actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({
      user: { id: "missing-user", email: "stale@example.com" },
    });
    mockPrisma.$transaction.mockImplementation(async (fn) => fn(mockTx));
    mockTx.modelDefinition.create.mockImplementation(async ({ data }) => ({
      id: `model-${data.name}`,
    }));
    mockTx.entity.create.mockImplementation(async ({ data }) => ({
      id: `entity-${data.name}`,
    }));
    mockTx.domain.findUnique.mockResolvedValue({ id: "domain-1", tenantId: "tenant-1" });
    mockTx.product.findUnique.mockResolvedValue({
      id: "prd-default",
      domainId: "domain-1",
      domain: { tenantId: "tenant-1" },
    });
    mockTx.product.create.mockResolvedValue({ id: "prd-default" });
    mockAssertNameAvailable.mockResolvedValue({ success: true, data: undefined });
    mockTx.sharedEnum.create.mockImplementation(async ({ data }) => ({ id: `enum-${data.name}` }));
    mockTx.customScalar.create.mockImplementation(async ({ data }) => ({ id: `scalar-${data.name}` }));
    mockTx.unionType.create.mockImplementation(async ({ data }) => ({ id: `union-${data.name}` }));
    mockTx.entity.findMany.mockResolvedValue([]);
    mockTx.serviceDefinition.create.mockImplementation(async ({ data }) => ({
      id: `service-${data.name}`,
    }));
  });

  it("rejects imports before opening a transaction when the session user no longer exists", async () => {
    mockPrisma.user.findUnique.mockResolvedValue(null);

    const result = await createDomainAssetsFromImportAction({
      domainId: "domain-1",
      namespace: "Test",
      models: [],
      entities: [
        {
          name: "Customer",
          description: "",
          fields: [],
        },
      ],
      sharedEnums: [],
      customScalars: [],
      unionTypes: [],
      services: [],
      decoratorDefinitions: [],
    });

    expect(result).toMatchObject({
      modelsCreated: 0,
      entitiesCreated: 0,
      errors: [
        "Your session is stale. Sign out and sign in again, then retry the import.",
      ],
    });
    expect(mockPrisma.user.findUnique).toHaveBeenCalledWith({
      where: { id: "missing-user" },
      select: { id: true },
    });
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it("creates entities only for explicit entity registrations, not every selected model", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "user-1", email: "user@example.com" },
    });
    mockPrisma.user.findUnique.mockResolvedValue({ id: "user-1" });

    const result = await createDomainAssetsFromImportAction({
      domainId: "domain-1",
      namespace: "Test",
      models: [
        {
          name: "Customer",
          description: "",
          fields: [],
        },
        {
          name: "Address",
          description: "",
          fields: [],
        },
      ],
      entities: [
        {
          name: "Customer",
          description: "",
          fields: [],
        },
      ],
      sharedEnums: [],
      customScalars: [],
      unionTypes: [],
      services: [],
      decoratorDefinitions: [],
    });

    expect(result.modelsCreated).toBe(2);
    expect(result.entitiesCreated).toBe(1);
    expect(result.errors).toEqual([]);
    expect(mockTx.modelDefinition.create).toHaveBeenCalledTimes(2);
    expect(mockTx.entity.create).toHaveBeenCalledTimes(1);
    expect(mockTx.entity.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          name: "Customer",
          ownerId: "user-1",
          tenantId: "tenant-1",
        }),
      })
    );
  });

  it("resolves an entity-scoped service against an entity that already existed before this import", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "user-1", email: "user@example.com" },
    });
    mockPrisma.user.findUnique.mockResolvedValue({ id: "user-1" });
    mockTx.entity.findMany.mockResolvedValue([{ id: "entity-existing-1", name: "Order" }]);

    const result = await createDomainAssetsFromImportAction({
      domainId: "domain-1",
      namespace: "Test",
      models: [],
      entities: [],
      sharedEnums: [],
      customScalars: [],
      unionTypes: [],
      services: [
        {
          name: "OrderApi",
          scope: "entity",
          entityName: "Order",
          operations: [],
        },
      ],
      decoratorDefinitions: [],
    });

    expect(result.errors).toEqual([]);
    expect(result.servicesCreated).toBe(1);
    expect(mockTx.entity.findMany).toHaveBeenCalledWith({
      where: { domainId: "domain-1", name: { in: ["Order"] } },
      select: { id: true, name: true },
    });
    expect(mockTx.serviceDefinition.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          scope: "ENTITY",
          entityId: "entity-existing-1",
        }),
      })
    );
  });

  describe("name registry", () => {
    const emptyPayload = {
      domainId: "domain-1",
      namespace: "Test",
      models: [],
      entities: [],
      sharedEnums: [],
      customScalars: [],
      unionTypes: [],
      services: [],
      decoratorDefinitions: [],
    };

    beforeEach(() => {
      mockAuth.mockResolvedValue({ user: { id: "user-1", email: "user@example.com" } });
      mockPrisma.user.findUnique.mockResolvedValue({ id: "user-1" });
    });

    it("takes the tenant advisory lock before the first registry check", async () => {
      await createDomainAssetsFromImportAction({
        ...emptyPayload,
        sharedEnums: [{ name: "Status", values: ["A"] }],
      });

      expect(mockTx.$executeRaw).toHaveBeenCalledTimes(1);
      expect(mockTx.$executeRaw.mock.calls[0].slice(1)).toEqual(["tenant-1"]);
      expect(mockTx.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(
        mockAssertNameAvailable.mock.invocationCallOrder[0]
      );
    });

    it("checks data types and APIs at domain level and entities at product level", async () => {
      await createDomainAssetsFromImportAction({
        ...emptyPayload,
        sharedEnums: [{ name: "Status", values: ["A"] }],
        customScalars: [{ name: "Money", baseType: "decimal" }],
        unionTypes: [{ name: "Either", memberTypes: ["A"] }],
        entities: [{ name: "Customer", fields: [] }],
        services: [{ name: "CustomerApi", operations: [] }],
      });

      const domainScope = { tenantId: "tenant-1", domainId: "domain-1", productId: null };
      const productScope = { tenantId: "tenant-1", domainId: "domain-1", productId: "prd-default" };
      expect(mockAssertNameAvailable.mock.calls.map(([, candidate]) => candidate)).toEqual([
        { name: "Status", ...domainScope },
        { name: "Money", ...domainScope },
        { name: "Either", ...domainScope },
        { name: "Customer", ...productScope },
        { name: "CustomerApi", ...domainScope },
      ]);
      mockAssertNameAvailable.mock.calls.forEach(([tx]) => expect(tx).toBe(mockTx));
    });

    it("aborts the whole import with the conflict message when the registry reports one", async () => {
      mockAssertNameAvailable.mockResolvedValue({
        success: false,
        error: { code: "NAME_CONFLICT", message: "dup" },
      });

      const result = await createDomainAssetsFromImportAction({
        ...emptyPayload,
        models: [{ name: "Customer", fields: [] }],
        entities: [{ name: "Customer", fields: [] }],
      });

      expect(result).toEqual({
        modelsCreated: 0,
        entitiesCreated: 0,
        enumsCreated: 0,
        scalarsCreated: 0,
        unionsCreated: 0,
        servicesCreated: 0,
        decoratorsCreated: 0,
        entityIds: [],
        modelIds: [],
        errors: ["dup"],
      });
      expect(mockTx.entity.create).not.toHaveBeenCalled();
    });

    it("treats two assets sharing a name inside one batch as a conflict", async () => {
      const taken = new Set<string>();
      mockTx.sharedEnum.create.mockImplementation(async ({ data }) => {
        taken.add(data.name.toLowerCase());
        return { id: `enum-${data.name}` };
      });
      mockAssertNameAvailable.mockImplementation(async (_tx, candidate) =>
        taken.has(candidate.name.toLowerCase())
          ? { success: false, error: { code: "NAME_CONFLICT", message: `"${candidate.name}" taken` } }
          : { success: true, data: undefined }
      );

      const result = await createDomainAssetsFromImportAction({
        ...emptyPayload,
        sharedEnums: [{ name: "Status", values: ["A"] }],
        customScalars: [{ name: "status", baseType: "string" }],
      });

      expect(result.errors).toEqual(['"status" taken']);
      expect(result.enumsCreated).toBe(0);
      expect(result.scalarsCreated).toBe(0);
      expect(mockTx.customScalar.create).not.toHaveBeenCalled();
    });
  });
});

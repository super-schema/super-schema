import { describe, expect, it, vi, beforeEach } from "vitest";

const { mockAuth, mockPrisma, mockTx } = vi.hoisted(() => ({
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
    },
    product: {
      findUnique: vi.fn(),
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
  revalidatePath: vi.fn(),
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
    mockTx.product.findUnique.mockResolvedValue({ id: "prd-default" });
    mockTx.product.create.mockResolvedValue({ id: "prd-default" });
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
        }),
      })
    );
  });
});

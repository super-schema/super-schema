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
});

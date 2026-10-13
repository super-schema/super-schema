import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockAuth, mockPrisma } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockPrisma: {
    user: {
      findUnique: vi.fn(),
    },
    entity: {
      create: vi.fn(),
    },
    product: {
      findUnique: vi.fn().mockResolvedValue({ id: "prd-default" }),
      create: vi.fn().mockResolvedValue({ id: "prd-default" }),
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
  revalidatePath: vi.fn(),
}));

import { createEntityWithFieldsAction } from "@/app/(dashboard)/schemas/[domainSlug]/actions";

describe("createEntityWithFieldsAction session reconciliation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({
      user: { id: "stale-user-id", email: "owner@example.com" },
    });
    mockPrisma.auditLog.create.mockResolvedValue({ id: "audit-1" });
    mockPrisma.entity.create.mockResolvedValue({ id: "entity-1" });
  });

  it("uses the current user row when the session id is stale but email still matches", async () => {
    mockPrisma.user.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: "current-user-id" })
      .mockResolvedValueOnce({ id: "current-user-id" });

    const result = await createEntityWithFieldsAction("domain-1", {
      name: "Customer",
      description: "Customer entity",
      fields: [],
    });

    expect(result).toEqual({ success: true, entityId: "entity-1" });
    expect(mockPrisma.user.findUnique).toHaveBeenNthCalledWith(1, {
      where: { id: "stale-user-id" },
      select: { id: true },
    });
    expect(mockPrisma.user.findUnique).toHaveBeenNthCalledWith(2, {
      where: { email: "owner@example.com" },
      select: { id: true },
    });
    expect(mockPrisma.entity.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ ownerId: "current-user-id" }),
      })
    );
    expect(mockPrisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ userId: "current-user-id" }),
      })
    );
  });
});

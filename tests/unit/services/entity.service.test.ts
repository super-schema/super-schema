import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    entity: {
      create: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    product: {
      findUnique: vi.fn().mockResolvedValue({ id: "prd-default" }),
      create: vi.fn().mockResolvedValue({ id: "prd-default" }),
    },
    domain: {
      findUniqueOrThrow: vi.fn().mockResolvedValue({ tenantId: "tenant-1" }),
    },
    auditLog: {
      create: vi.fn().mockResolvedValue({ id: "audit-1" }),
    },
  },
}));

import {
  createEntity,
  getEntities,
  getEntityById,
  updateEntity,
  deleteEntity,
} from "@/services/entity.service";
import { prisma } from "@/lib/db";
import type { ServiceContext } from "@/types/service-context";

const mockCtx: ServiceContext = {
  userId: "user-1",
  userRole: "AUTHOR",
  prisma: prisma as unknown as ServiceContext["prisma"],
};

describe("Entity Service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("createEntity", () => {
    it("returns success result on valid input", async () => {
      const mockEntity = {
        id: "ent-1",
        name: "Customer",
        domainId: "dom-1",
        version: 1,
        status: "DRAFT",
      };
      vi.mocked(prisma.entity.create).mockResolvedValue(mockEntity as never);

      const result = await createEntity(
        { name: "Customer", domainId: "dom-1", description: "Customer entity" },
        mockCtx
      );

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.name).toBe("Customer");
      }
      expect(prisma.entity.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ domainId: "dom-1", tenantId: "tenant-1" }),
        })
      );
    });

    it("returns error for duplicate entity name in same domain", async () => {
      vi.mocked(prisma.entity.create).mockRejectedValue(
        new Error("Unique constraint failed on the constraint: `entities_name_domainId_key`")
      );

      const result = await createEntity(
        { name: "Customer", domainId: "dom-1", description: "Duplicate" },
        mockCtx
      );

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe("DUPLICATE");
        expect(result.error.suggestedFix).toContain("different name");
      }
    });

    it("returns error for invalid metadata JSONB", async () => {
      const result = await createEntity(
        {
          name: "Test",
          domainId: "dom-1",
          description: "Test",
          metadata: { relationships: [{ targetEntityId: "x", type: "invalid-type" }] } as never,
        },
        mockCtx
      );

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe("VALIDATION_ERROR");
        expect(result.error.suggestedFix).toBeDefined();
      }
    });
  });

  describe("getEntities", () => {
    it("returns filtered entity list", async () => {
      const mockEntities = [{ id: "ent-1", name: "Customer" }];
      vi.mocked(prisma.entity.findMany).mockResolvedValue(mockEntities as never);

      const result = await getEntities({ domainId: "dom-1" }, mockCtx);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toHaveLength(1);
      }
    });
  });

  describe("getEntityById", () => {
    it("returns entity when found", async () => {
      vi.mocked(prisma.entity.findUnique).mockResolvedValue({
        id: "ent-1",
        name: "Customer",
      } as never);

      const result = await getEntityById("ent-1", mockCtx);
      expect(result.success).toBe(true);
    });

    it("returns not-found error for missing entity", async () => {
      vi.mocked(prisma.entity.findUnique).mockResolvedValue(null);

      const result = await getEntityById("nonexistent", mockCtx);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe("NOT_FOUND");
      }
    });
  });

  describe("updateEntity", () => {
    it("returns updated entity", async () => {
      const existing = { id: "ent-1", name: "Customer", version: 1 };
      vi.mocked(prisma.entity.findUnique).mockResolvedValue(existing as never);
      vi.mocked(prisma.entity.update).mockResolvedValue({
        ...existing,
        name: "CustomerV2",
      } as never);

      const result = await updateEntity(
        "ent-1",
        { name: "CustomerV2" },
        mockCtx
      );

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.name).toBe("CustomerV2");
      }
    });
  });

  describe("deleteEntity", () => {
    it("returns success on delete", async () => {
      vi.mocked(prisma.entity.findUnique).mockResolvedValue({
        id: "ent-1",
        name: "Customer",
      } as never);
      vi.mocked(prisma.entity.delete).mockResolvedValue({} as never);

      const result = await deleteEntity("ent-1", mockCtx);
      expect(result.success).toBe(true);
    });

    it("returns not-found error for missing entity", async () => {
      vi.mocked(prisma.entity.findUnique).mockResolvedValue(null);

      const result = await deleteEntity("nonexistent", mockCtx);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe("NOT_FOUND");
      }
    });
  });
});

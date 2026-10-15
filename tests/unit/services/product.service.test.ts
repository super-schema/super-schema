import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    product: {
      create: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    auditLog: {
      create: vi.fn().mockResolvedValue({ id: "audit-1" }),
    },
  },
}));

import { createProduct, deleteProduct, updateProduct } from "@/services/product.service";
import { prisma } from "@/lib/db";
import type { ServiceContext } from "@/types/service-context";

const mockCtx: ServiceContext = {
  userId: "user-1",
  userRole: "AUTHOR",
  prisma: prisma as unknown as ServiceContext["prisma"],
};

describe("Product Service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("createProduct", () => {
    it("returns success result on valid input", async () => {
      const mockProduct = { id: "prd-1", name: "Checkout", slug: "checkout" };
      vi.mocked(prisma.product.create).mockResolvedValue(mockProduct as never);

      const result = await createProduct(
        { domainId: "dom-1", name: "Checkout", description: "Checkout flow" },
        mockCtx
      );

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.name).toBe("Checkout");
      }
    });

    it("rejects product named 'Traits' (reserved for domain-level route)", async () => {
      const result = await createProduct(
        { domainId: "dom-1", name: "Traits", description: "Reserved route" },
        mockCtx
      );

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe("VALIDATION_ERROR");
        expect(result.error.message).toContain("traits");
        expect(result.error.message).toContain("reserved");
      }
      expect(prisma.product.create).not.toHaveBeenCalled();
    });

    it("returns validation error for empty name", async () => {
      const result = await createProduct(
        { domainId: "dom-1", name: "", description: "Test" },
        mockCtx
      );

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe("VALIDATION_ERROR");
      }
    });
  });

  describe("updateProduct", () => {
    it("rejects renaming to 'Traits' (reserved for domain-level route)", async () => {
      vi.mocked(prisma.product.findUnique).mockResolvedValue({
        id: "prd-1",
        name: "Checkout",
      } as never);

      const result = await updateProduct(
        "prd-1",
        { name: "Traits" },
        mockCtx
      );

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe("VALIDATION_ERROR");
        expect(result.error.message).toContain("traits");
        expect(result.error.message).toContain("reserved");
      }
      expect(prisma.product.update).not.toHaveBeenCalled();
    });
  });

  describe("deleteProduct", () => {
    const counts = {
      entities: 0,
      sharedEnums: 0,
      customScalars: 0,
      unionTypes: 0,
      services: 0,
    };

    it("counts product-level Data Types and APIs, not just entities", async () => {
      vi.mocked(prisma.product.findUnique).mockResolvedValue({
        id: "prd-1",
        isSystem: false,
        _count: counts,
      } as never);
      vi.mocked(prisma.product.delete).mockResolvedValue({ id: "prd-1" } as never);

      const result = await deleteProduct("prd-1", mockCtx);

      expect(result.success).toBe(true);
      expect(prisma.product.findUnique).toHaveBeenCalledWith({
        where: { id: "prd-1" },
        include: {
          _count: {
            select: {
              entities: true,
              sharedEnums: true,
              customScalars: true,
              unionTypes: true,
              services: true,
            },
          },
        },
      });
    });

    it("blocks deleting a product that still owns Data Types (they would cascade)", async () => {
      vi.mocked(prisma.product.findUnique).mockResolvedValue({
        id: "prd-1",
        isSystem: false,
        _count: { ...counts, sharedEnums: 1, unionTypes: 1 },
      } as never);

      const result = await deleteProduct("prd-1", mockCtx);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe("VALIDATION_ERROR");
        expect(result.error.message).toBe(
          "Delete the product's 2 Data Types before removing it"
        );
      }
      expect(prisma.product.delete).not.toHaveBeenCalled();
    });

    it("blocks deleting a product that still owns APIs", async () => {
      vi.mocked(prisma.product.findUnique).mockResolvedValue({
        id: "prd-1",
        isSystem: false,
        _count: { ...counts, services: 1 },
      } as never);

      const result = await deleteProduct("prd-1", mockCtx);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.message).toBe(
          "Delete the product's 1 API before removing it"
        );
      }
      expect(prisma.product.delete).not.toHaveBeenCalled();
    });
  });
});

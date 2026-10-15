import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    product: {
      create: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    // Cross-product pin lookup (findCrossProductPins): empty unless a test says otherwise.
    messageVersion: { findMany: vi.fn().mockResolvedValue([]) },
    channel: { findMany: vi.fn().mockResolvedValue([]) },
    trait: { findMany: vi.fn().mockResolvedValue([]) },
    schemaReference: { findMany: vi.fn().mockResolvedValue([]) },
    eventSpecVersion: { findMany: vi.fn().mockResolvedValue([]) },
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
    // clearAllMocks keeps implementations, but a test may have queued one-off return values.
    vi.mocked(prisma.messageVersion.findMany).mockResolvedValue([]);
    vi.mocked(prisma.channel.findMany).mockResolvedValue([]);
    vi.mocked(prisma.trait.findMany).mockResolvedValue([]);
    vi.mocked(prisma.schemaReference.findMany).mockResolvedValue([]);
    vi.mocked(prisma.eventSpecVersion.findMany).mockResolvedValue([]);
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
      channels: 0,
      messages: 0,
      traits: 0,
      eventSpecs: 0,
    };
    const domain = { tenantId: "tenant-1" };

    it("counts product-level Data Types, APIs and Events assets, not just entities", async () => {
      vi.mocked(prisma.product.findUnique).mockResolvedValue({
        id: "prd-1",
        isSystem: false,
        domain,
        _count: counts,
      } as never);
      vi.mocked(prisma.product.delete).mockResolvedValue({ id: "prd-1" } as never);

      const result = await deleteProduct("prd-1", mockCtx);

      expect(result.success).toBe(true);
      expect(prisma.product.findUnique).toHaveBeenCalledWith({
        where: { id: "prd-1" },
        include: {
          domain: { select: { tenantId: true } },
          _count: {
            select: {
              entities: true,
              sharedEnums: true,
              customScalars: true,
              unionTypes: true,
              services: true,
              channels: true,
              messages: true,
              traits: true,
              eventSpecs: true,
            },
          },
        },
      });
      expect(prisma.product.delete).toHaveBeenCalledWith({ where: { id: "prd-1" } });
    });

    it("blocks deleting a product that still owns Data Types (they would cascade)", async () => {
      vi.mocked(prisma.product.findUnique).mockResolvedValue({
        id: "prd-1",
        isSystem: false,
        domain,
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
        domain,
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

    it.each([
      ["channels", { channels: 2 }, "Delete the product's 2 channels before removing it"],
      ["messages", { messages: 1 }, "Delete the product's 1 message before removing it"],
      ["traits", { traits: 3 }, "Delete the product's 3 traits before removing it"],
      ["event specs", { eventSpecs: 1 }, "Delete the product's 1 event spec before removing it"],
    ])("blocks deleting a product that still owns %s (they would cascade); nothing is deleted or audited", async (_kind, extra, message) => {
      vi.mocked(prisma.product.findUnique).mockResolvedValue({
        id: "prd-1",
        isSystem: false,
        domain,
        _count: { ...counts, ...extra },
      } as never);

      const result = await deleteProduct("prd-1", mockCtx);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe("VALIDATION_ERROR");
        expect(result.error.message).toBe(message);
        expect(result.error.suggestedFix).toMatch(/Events assets/);
      }
      expect(prisma.product.delete).not.toHaveBeenCalled();
      expect(prisma.auditLog.create).not.toHaveBeenCalled();
    });

    it("lists every kind that blocks, in one message", async () => {
      vi.mocked(prisma.product.findUnique).mockResolvedValue({
        id: "prd-1",
        isSystem: false,
        domain,
        _count: { ...counts, entities: 1, channels: 2, messages: 1, eventSpecs: 1 },
      } as never);

      const result = await deleteProduct("prd-1", mockCtx);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.message).toBe(
          "Delete the product's 1 entity, 2 channels, 1 message and 1 event spec before removing it"
        );
      }
    });

    describe("cross-product pins", () => {
      const withEventsAssets = () =>
        vi.mocked(prisma.product.findUnique).mockResolvedValue({
          id: "prd-1",
          isSystem: false,
          domain,
          _count: { ...counts, messages: 1, channels: 1 },
        } as never);

      function pinnedByAnotherProductsSpec() {
        vi.mocked(prisma.messageVersion.findMany).mockResolvedValue([
          { id: "mv-1", message: { id: "m-1", name: "OrderCreated" } },
        ] as never);
        vi.mocked(prisma.channel.findMany).mockResolvedValue([{ id: "c-1", name: "orders" }] as never);
        vi.mocked(prisma.eventSpecVersion.findMany).mockResolvedValue([
          {
            id: "sv-1",
            major: 1,
            minor: 0,
            messageVersionIds: ["mv-1"],
            frozenChannels: [{ id: "c-1" }],
            frozenTraits: [],
            eventSpec: { id: "s-1", name: "fraud-consumer", productId: "prd-2", product: { id: "prd-2", name: "Fraud" } },
          },
        ] as never);
      }

      it("names the referencing spec and product together with the content counts", async () => {
        withEventsAssets();
        pinnedByAnotherProductsSpec();

        const result = await deleteProduct("prd-1", mockCtx);

        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error.code).toBe("VALIDATION_ERROR");
          expect(result.error.message).toBe(
            "Delete the product's 1 channel and 1 message before removing it. " +
              'A published event spec in another product references assets owned here: "fraud-consumer" (product "Fraud", v1.0) ' +
              'references Message "OrderCreated" and Channel "orders". Delete that event spec first (published versions cannot be changed), then retry.'
          );
          expect(result.error.details).toEqual({
            eventSpecs: [
              {
                specId: "s-1",
                specName: "fraud-consumer",
                productId: "prd-2",
                productName: "Fraud",
                versions: ["1.0"],
                assets: [
                  { kind: "Message", name: "OrderCreated" },
                  { kind: "Channel", name: "orders" },
                ],
              },
            ],
          });
        }
        expect(prisma.product.delete).not.toHaveBeenCalled();
      });

      it("blocks on a cross-product pin even when the counts alone would allow the delete", async () => {
        vi.mocked(prisma.product.findUnique).mockResolvedValue({ id: "prd-1", isSystem: false, domain, _count: counts } as never);
        vi.mocked(prisma.messageVersion.findMany).mockResolvedValue([{ id: "mv-1", message: { id: "m-1", name: "OrderCreated" } }] as never);
        vi.mocked(prisma.eventSpecVersion.findMany).mockResolvedValue([
          {
            id: "sv-1",
            major: 2,
            minor: 0,
            messageVersionIds: ["mv-1"],
            frozenChannels: [],
            frozenTraits: [],
            eventSpec: { id: "s-1", name: "fraud-consumer", productId: "prd-2", product: { id: "prd-2", name: "Fraud" } },
          },
        ] as never);

        const result = await deleteProduct("prd-1", mockCtx);

        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error.message).toBe(
            'A published event spec in another product references assets owned here: "fraud-consumer" (product "Fraud", v2.0) ' +
              'references Message "OrderCreated". Delete that event spec first (published versions cannot be changed), then retry.'
          );
        }
        expect(prisma.product.delete).not.toHaveBeenCalled();
        expect(prisma.auditLog.create).not.toHaveBeenCalled();
      });

      it("looks only inside the product's tenant and at specs of other products", async () => {
        withEventsAssets();
        pinnedByAnotherProductsSpec();

        await deleteProduct("prd-1", mockCtx);

        const query = vi.mocked(prisma.eventSpecVersion.findMany).mock.calls[0][0] as { where: { eventSpec: unknown } };
        expect(query.where.eventSpec).toEqual({ tenantId: "tenant-1", productId: { not: "prd-1" } });
        expect(vi.mocked(prisma.messageVersion.findMany).mock.calls[0][0]).toMatchObject({ where: { message: { productId: "prd-1" } } });
        expect(vi.mocked(prisma.channel.findMany).mock.calls[0][0]).toMatchObject({ where: { productId: "prd-1" } });
        expect(vi.mocked(prisma.trait.findMany).mock.calls[0][0]).toMatchObject({ where: { productId: "prd-1" } });
      });

      it("deletes an empty product without looking for anything that references it", async () => {
        vi.mocked(prisma.product.findUnique).mockResolvedValue({ id: "prd-1", isSystem: false, domain, _count: counts } as never);
        vi.mocked(prisma.product.delete).mockResolvedValue({ id: "prd-1" } as never);

        const result = await deleteProduct("prd-1", mockCtx);

        expect(result.success).toBe(true);
        expect(prisma.eventSpecVersion.findMany).not.toHaveBeenCalled();
      });
    });
  });
});

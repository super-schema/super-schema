import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    product: {
      create: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    // Cross-product event reference lookup (findCrossProductEventRefs): empty unless a test says otherwise.
    schemaReference: { findMany: vi.fn().mockResolvedValue([]) },
    eventSpecVersion: { findMany: vi.fn().mockResolvedValue([]) },
    eventSpec: { findMany: vi.fn().mockResolvedValue([]) },
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
    vi.mocked(prisma.schemaReference.findMany).mockResolvedValue([]);
    vi.mocked(prisma.eventSpecVersion.findMany).mockResolvedValue([]);
    vi.mocked(prisma.eventSpec.findMany).mockResolvedValue([]);
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

  describe("product contacts", () => {
    function fieldErrorsOf(result: Awaited<ReturnType<typeof createProduct>>): Record<string, string> {
      expect(result.success).toBe(false);
      if (result.success) return {};
      expect(result.error.code).toBe("VALIDATION_ERROR");
      return (result.error.details as { fieldErrors: Record<string, string> }).fieldErrors;
    }

    describe("createProduct", () => {
      it("saves no contacts (null mailboxes, empty team list) when none are given", async () => {
        vi.mocked(prisma.product.create).mockResolvedValue({ id: "prd-1" } as never);

        const result = await createProduct({ domainId: "dom-1", name: "Checkout" }, mockCtx);

        expect(result.success).toBe(true);
        expect(prisma.product.create).toHaveBeenCalledWith({
          data: expect.objectContaining({ engineeringLead: null, manager: null, teamEmails: [] }),
        });
      });

      it("saves the contacts as canonical mailbox text", async () => {
        vi.mocked(prisma.product.create).mockResolvedValue({ id: "prd-1" } as never);

        const result = await createProduct(
          {
            domainId: "dom-1",
            name: "Checkout",
            engineeringLead: '  "Doe, Jane"   <jane@acme.com>  ',
            manager: "<mo@acme.com>",
            teamEmails: ["Platform Team <platform@acme.com>", "oncall@acme.com"],
          },
          mockCtx
        );

        expect(result.success).toBe(true);
        expect(prisma.product.create).toHaveBeenCalledWith({
          data: expect.objectContaining({
            name: "Checkout",
            engineeringLead: '"Doe, Jane" <jane@acme.com>',
            manager: "mo@acme.com",
            teamEmails: ["Platform Team <platform@acme.com>", "oncall@acme.com"],
          }),
        });
      });

      it("treats blank mailboxes as none and collapses duplicate team emails case-insensitively", async () => {
        vi.mocked(prisma.product.create).mockResolvedValue({ id: "prd-1" } as never);

        await createProduct(
          { domainId: "dom-1", name: "Checkout", engineeringLead: "  ", manager: null, teamEmails: ["Ops <ops@acme.com>", "OPS@ACME.COM"] },
          mockCtx
        );

        expect(prisma.product.create).toHaveBeenCalledWith({
          data: expect.objectContaining({ engineeringLead: null, manager: null, teamEmails: ["Ops <ops@acme.com>"] }),
        });
      });

      it("rejects malformed contacts with a message per field, and creates nothing", async () => {
        const result = await createProduct(
          { domainId: "dom-1", name: "Checkout", engineeringLead: "jane", manager: "mo@", teamEmails: ["ok@acme.com", "broken"] },
          mockCtx
        );

        const errors = fieldErrorsOf(result);
        expect(Object.keys(errors).sort()).toEqual(["engineeringLead", "manager", "teamEmails"]);
        expect(errors.teamEmails).toContain("broken");
        expect(prisma.product.create).not.toHaveBeenCalled();
        expect(prisma.auditLog.create).not.toHaveBeenCalled();
      });

      it("reports only the field that is wrong", async () => {
        const result = await createProduct({ domainId: "dom-1", name: "Checkout", engineeringLead: "ok@acme.com", teamEmails: ["x"] }, mockCtx);
        expect(Object.keys(fieldErrorsOf(result))).toEqual(["teamEmails"]);
      });

      it("still reports the missing name first when the name and a contact are both wrong", async () => {
        const result = await createProduct({ domainId: "dom-1", name: "", manager: "nope" }, mockCtx);
        expect(result.success).toBe(false);
        if (!result.success) expect(result.error.message).toBe("Product name is required");
      });
    });

    describe("updateProduct", () => {
      beforeEach(() => {
        vi.mocked(prisma.product.findUnique).mockResolvedValue({ id: "prd-1", name: "Checkout" } as never);
        vi.mocked(prisma.product.update).mockResolvedValue({ id: "prd-1" } as never);
      });

      it("updates only the contact fields that are given", async () => {
        const result = await updateProduct("prd-1", { manager: "Mo <mo@acme.com>" }, mockCtx);

        expect(result.success).toBe(true);
        expect(prisma.product.update).toHaveBeenCalledWith({ where: { id: "prd-1" }, data: { manager: "Mo <mo@acme.com>" } });
      });

      it("saves canonical text for every contact field", async () => {
        await updateProduct(
          "prd-1",
          { engineeringLead: '"Doe, Jane" <j@x.com>', manager: "  mo@acme.com ", teamEmails: ["A <a@acme.com>", "a@ACME.com", "b@acme.com"] },
          mockCtx
        );

        expect(prisma.product.update).toHaveBeenCalledWith({
          where: { id: "prd-1" },
          data: { engineeringLead: '"Doe, Jane" <j@x.com>', manager: "mo@acme.com", teamEmails: ["A <a@acme.com>", "b@acme.com"] },
        });
      });

      it("clears a mailbox with null or blank text and the team list with an empty array", async () => {
        await updateProduct("prd-1", { engineeringLead: null, manager: "   ", teamEmails: [] }, mockCtx);

        expect(prisma.product.update).toHaveBeenCalledWith({
          where: { id: "prd-1" },
          data: { engineeringLead: null, manager: null, teamEmails: [] },
        });
      });

      it("does not touch the contacts when an update names none", async () => {
        await updateProduct("prd-1", { description: "New" }, mockCtx);

        expect(prisma.product.update).toHaveBeenCalledWith({ where: { id: "prd-1" }, data: { description: "New" } });
      });

      it("rejects malformed contacts with field-level messages, and updates nothing", async () => {
        const result = await updateProduct("prd-1", { engineeringLead: "Doe, Jane <j@x.com>", teamEmails: ["bad"] }, mockCtx);

        const errors = fieldErrorsOf(result);
        expect(errors.engineeringLead).toMatch(/quotes/i);
        expect(errors.teamEmails).toContain("bad");
        expect(prisma.product.update).not.toHaveBeenCalled();
      });

      it("answers NOT_FOUND for a missing product before it validates the contacts", async () => {
        vi.mocked(prisma.product.findUnique).mockResolvedValue(null);

        const result = await updateProduct("prd-9", { manager: "nope" }, mockCtx);

        expect(result.success).toBe(false);
        if (!result.success) expect(result.error.code).toBe("NOT_FOUND");
        expect(prisma.product.update).not.toHaveBeenCalled();
      });
    });
  });

  describe("deleteProduct", () => {
    const counts = {
      entities: 0,
      sharedEnums: 0,
      customScalars: 0,
      unionTypes: 0,
      services: 0,
      traits: 0,
      eventSpecs: 0,
    };
    const domain = { tenantId: "tenant-1" };

    it("counts product-level Data Types, APIs and events, not just entities", async () => {
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
      ["traits", { traits: 3 }, "Delete the product's 3 traits before removing it"],
      ["events", { eventSpecs: 1 }, "Delete the product's 1 event before removing it"],
      ["events (plural)", { eventSpecs: 2 }, "Delete the product's 2 events before removing it"],
    ])("blocks deleting a product that still owns %s (they would cascade); nothing is deleted or audited", async (_kind, extra, message) => {
      vi.mocked(prisma.product.findUnique).mockResolvedValue({
        id: "prd-1",
        name: "Checkout",
        isSystem: false,
        domain,
        _count: { ...counts, ...extra },
      } as never);

      const result = await deleteProduct("prd-1", mockCtx);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe("VALIDATION_ERROR");
        expect(result.error.message).toBe(message);
        expect(result.error.suggestedFix).toBe("Remove or move the product's entities, Data Types, APIs and events, then delete the product.");
      }
      expect(prisma.product.delete).not.toHaveBeenCalled();
      expect(prisma.auditLog.create).not.toHaveBeenCalled();
    });

    it("lists every kind that blocks, in one message", async () => {
      vi.mocked(prisma.product.findUnique).mockResolvedValue({
        id: "prd-1",
        name: "Checkout",
        isSystem: false,
        domain,
        _count: { ...counts, entities: 1, traits: 1, eventSpecs: 2 },
      } as never);

      const result = await deleteProduct("prd-1", mockCtx);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.message).toBe("Delete the product's 1 entity, 1 trait and 2 events before removing it");
      }
    });

    describe("cross-product event references", () => {
      const spec = { id: "s-out", name: "fraud-consumer", domainId: "dom-2", productId: "prd-2", domain: { name: "Risk" }, product: { name: "Fraud" } };
      const withEvents = () =>
        vi.mocked(prisma.product.findUnique).mockResolvedValue({
          id: "prd-1",
          name: "Checkout",
          isSystem: false,
          domain,
          _count: { ...counts, eventSpecs: 1 },
        } as never);

      /** An event of ANOTHER product holds a draft reference to a published version of this product's event. */
      function referencedByAnotherProductsEvent() {
        vi.mocked(prisma.eventSpecVersion.findMany).mockResolvedValue([{ id: "sv-in", major: 1, minor: 0 }] as never);
        vi.mocked(prisma.schemaReference.findMany).mockResolvedValue([{ fromKind: "EVENT_SPEC", fromId: "s-out", toId: "sv-in" }] as never);
        vi.mocked(prisma.eventSpec.findMany).mockResolvedValue([spec] as never);
      }

      it("names the referencing event and product together with the content counts, with the structured details", async () => {
        withEvents();
        referencedByAnotherProductsEvent();

        const result = await deleteProduct("prd-1", mockCtx);

        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error.code).toBe("VALIDATION_ERROR");
          expect(result.error.message).toBe(
            "Delete the product's 1 event before removing it. " +
              "Product \"Checkout\" cannot be deleted: other products' events reference its events: fraud-consumer (Risk/Fraud)."
          );
          expect(result.error.details).toMatchObject({
            events: { truncated: false, referrers: [{ eventId: "s-out", name: "fraud-consumer", domain: "Risk", product: "Fraud", draft: true, published: false }] },
          });
        }
        expect(prisma.product.delete).not.toHaveBeenCalled();
        expect(prisma.auditLog.create).not.toHaveBeenCalled();
      });

      it("looks only inside the product's tenant and at the published versions of the product's own events", async () => {
        withEvents();
        referencedByAnotherProductsEvent();

        await deleteProduct("prd-1", mockCtx);

        const query = vi.mocked(prisma.eventSpecVersion.findMany).mock.calls[0][0] as { where: { eventSpec: unknown } };
        expect(query.where.eventSpec).toEqual({ tenantId: "tenant-1", productId: "prd-1" });
        expect(vi.mocked(prisma.eventSpec.findMany).mock.calls[0][0]).toMatchObject({ where: { id: { in: ["s-out"] }, tenantId: "tenant-1" } });
      });

      it("ignores references from the product's own events", async () => {
        withEvents();
        referencedByAnotherProductsEvent();
        vi.mocked(prisma.eventSpec.findMany).mockResolvedValue([{ ...spec, domainId: "dom-1", productId: "prd-1" }] as never);

        const result = await deleteProduct("prd-1", mockCtx);

        // only the content count blocks, with no `details.events`
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error.message).toBe("Delete the product's 1 event before removing it");
          expect(result.error.details).toBeUndefined();
        }
      });

      it("a failing reference read is a DB_ERROR Result, not a throw", async () => {
        withEvents();
        vi.mocked(prisma.eventSpecVersion.findMany).mockRejectedValueOnce(new Error("connection lost"));

        const result = await deleteProduct("prd-1", mockCtx);

        expect(result).toMatchObject({ success: false, error: { code: "DB_ERROR" } });
        expect(prisma.product.delete).not.toHaveBeenCalled();
      });

      it("deletes an empty product without looking for anything that references it", async () => {
        vi.mocked(prisma.product.findUnique).mockResolvedValue({ id: "prd-1", name: "Checkout", isSystem: false, domain, _count: counts } as never);
        vi.mocked(prisma.product.delete).mockResolvedValue({ id: "prd-1" } as never);

        const result = await deleteProduct("prd-1", mockCtx);

        expect(result.success).toBe(true);
        expect(prisma.eventSpecVersion.findMany).not.toHaveBeenCalled();
      });
    });
  });
});

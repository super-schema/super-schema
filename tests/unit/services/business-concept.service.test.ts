import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    businessConcept: {
      create: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    fieldConceptLink: {
      create: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
      delete: vi.fn(),
    },
    field: {
      findUnique: vi.fn(),
    },
    auditLog: { create: vi.fn().mockResolvedValue({ id: "audit-1" }) },
  },
}));

import {
  createConcept,
  updateConcept,
  deleteConcept,
  getConcepts,
  searchConcepts,
  linkFieldToConcept,
  unlinkFieldFromConcept,
  getConceptsForField,
  suggestConceptsForField,
  getConceptUsage,
} from "@/services/business-concept.service";
import { prisma } from "@/lib/db";
import type { ServiceContext } from "@/types/service-context";
import { getConceptById } from "@/services/business-concept.service";
import { assign } from "../../helpers/access-mocks";

const mockCtx: ServiceContext = {
  userId: "user-1",
  userRole: "AUTHOR",
  prisma: prisma as unknown as ServiceContext["prisma"],
};

describe("the field links of a concept are listed only for what the caller may read", () => {
  const ctxFor = (assignments: ServiceContext["assignments"], tenantId: string | undefined = "tenant-1"): ServiceContext => ({ ...mockCtx, assignments, tenantId });
  const linksWhere = () => vi.mocked(prisma.businessConcept.findMany).mock.calls[0][0]?.include as { fieldLinks: { where: unknown } };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.businessConcept.findMany).mockResolvedValue([]);
  });

  it("with no tenant in the context nothing is filtered (a caller that is not a page)", async () => {
    await getConcepts(undefined, mockCtx);
    expect(linksWhere().fieldLinks.where).toBeUndefined();
  });

  it("a tenant-wide role sees the links of the tenant in view, never another tenant's", async () => {
    await getConcepts(undefined, ctxFor([assign.tenant("VIEWER", "tenant-1")]));
    expect(linksWhere().fieldLinks.where).toEqual({ field: { entity: { tenantId: "tenant-1" } } });
  });

  it("a domain- or product-scoped role sees only the links of fields of its domains and products", async () => {
    await getConcepts(undefined, ctxFor([assign.domain("VIEWER", "tenant-1", "dom-a"), assign.product("AUTHOR", "tenant-1", "dom-b", "prod-x")]));
    expect(linksWhere().fieldLinks.where).toEqual({
      field: { entity: { tenantId: "tenant-1", OR: [{ domainId: { in: ["dom-a"] } }, { productId: { in: ["prod-x"] } }] } },
    });
  });

  it("a caller whose roles reach nothing in the tenant sees no link at all (an empty scope matches nothing)", async () => {
    await getConcepts(undefined, ctxFor([]));
    expect(linksWhere().fieldLinks.where).toEqual({ field: { entity: { tenantId: "tenant-1", OR: [{ domainId: { in: [] } }, { productId: { in: [] } }] } } });
  });

  it("the by-id read names fields, entities and domains only of what the caller may read", async () => {
    vi.mocked(prisma.businessConcept.findUnique).mockResolvedValue({ id: "c1", fieldLinks: [] } as never);
    await getConceptById("c1", ctxFor([assign.tenant("VIEWER", "tenant-1")]));
    const include = vi.mocked(prisma.businessConcept.findUnique).mock.calls[0][0]?.include as { fieldLinks: { where: unknown } };
    expect(include.fieldLinks.where).toEqual({ field: { entity: { tenantId: "tenant-1" } } });
  });
});

describe("Business Concept Service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── CRUD Operations ──

  describe("createConcept", () => {
    it("returns success with valid input", async () => {
      const mockConcept = {
        id: "bc-1",
        name: "Customer Identifier",
        domain: "Identity",
        definition: "Unique customer ID",
        synonyms: ["cust_id"],
        canonicalType: "string",
        classification: "PII",
        tags: ["identity"],
        ownerId: "user-1",
      };
      vi.mocked(prisma.businessConcept.create).mockResolvedValue(mockConcept as never);

      const result = await createConcept(
        {
          name: "Customer Identifier",
          domain: "Identity",
          definition: "Unique customer ID",
          synonyms: ["cust_id"],
          canonicalType: "string",
          classification: "PII",
          tags: ["identity"],
        },
        mockCtx
      );

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.name).toBe("Customer Identifier");
        expect(result.data.domain).toBe("Identity");
      }
    });

    it("returns validation error for empty name", async () => {
      const result = await createConcept(
        { name: "", domain: "Core", definition: "", synonyms: [], tags: [] },
        mockCtx
      );

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe("VALIDATION_ERROR");
      }
    });

    it("returns duplicate error for unique constraint violation", async () => {
      vi.mocked(prisma.businessConcept.create).mockRejectedValue(
        new Error("Unique constraint failed on the constraint: `business_concepts_name_key`")
      );

      const result = await createConcept(
        { name: "Customer Identifier", domain: "Core", definition: "", synonyms: [], tags: [] },
        mockCtx
      );

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe("DUPLICATE");
      }
    });
  });

  describe("updateConcept", () => {
    it("returns updated concept", async () => {
      vi.mocked(prisma.businessConcept.findUnique).mockResolvedValue({
        id: "bc-1",
        name: "Customer ID",
      } as never);
      vi.mocked(prisma.businessConcept.update).mockResolvedValue({
        id: "bc-1",
        name: "Customer Identifier",
        definition: "Updated definition",
      } as never);

      const result = await updateConcept(
        "bc-1",
        { name: "Customer Identifier", definition: "Updated definition" },
        mockCtx
      );

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.name).toBe("Customer Identifier");
      }
    });

    it("returns not-found for missing concept", async () => {
      vi.mocked(prisma.businessConcept.findUnique).mockResolvedValue(null);

      const result = await updateConcept(
        "nonexistent",
        { name: "Test" },
        mockCtx
      );

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe("NOT_FOUND");
      }
    });
  });

  describe("deleteConcept", () => {
    it("returns success when no linked fields", async () => {
      vi.mocked(prisma.businessConcept.findUnique).mockResolvedValue({
        id: "bc-1",
        name: "Test",
        fieldLinks: [],
      } as never);
      vi.mocked(prisma.businessConcept.delete).mockResolvedValue({} as never);

      const result = await deleteConcept("bc-1", mockCtx);
      expect(result.success).toBe(true);
    });

    it("returns error when concept has linked fields (deletion guard)", async () => {
      vi.mocked(prisma.businessConcept.findUnique).mockResolvedValue({
        id: "bc-1",
        name: "Customer Identifier",
        fieldLinks: [{ id: "link-1", fieldId: "fld-1", conceptId: "bc-1" }],
      } as never);

      const result = await deleteConcept("bc-1", mockCtx);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe("HAS_DEPENDENCIES");
        expect(result.error.message).toContain("linked to 1 field");
      }
    });

    it("returns not-found for missing concept", async () => {
      vi.mocked(prisma.businessConcept.findUnique).mockResolvedValue(null);

      const result = await deleteConcept("nonexistent", mockCtx);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe("NOT_FOUND");
      }
    });
  });

  // ── Search ──

  describe("searchConcepts", () => {
    it("searches by name, definition, and synonyms", async () => {
      const mockConcepts = [
        { id: "bc-1", name: "Customer Identifier", synonyms: ["cust_id"] },
      ];
      vi.mocked(prisma.businessConcept.findMany).mockResolvedValue(mockConcepts as never);

      const result = await searchConcepts("customer", mockCtx);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toHaveLength(1);
      }

      expect(prisma.businessConcept.findMany).toHaveBeenCalledWith({
        where: {
          OR: [
            { name: { contains: "customer", mode: "insensitive" } },
            { definition: { contains: "customer", mode: "insensitive" } },
            { synonyms: { has: "customer" } },
          ],
        },
        orderBy: { name: "asc" },
      });
    });

    it("returns validation error for empty query", async () => {
      const result = await searchConcepts("", mockCtx);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe("VALIDATION_ERROR");
      }
    });
  });

  describe("getConcepts", () => {
    it("returns all concepts without filters", async () => {
      const mockConcepts = [
        { id: "bc-1", name: "A", fieldLinks: [] },
        { id: "bc-2", name: "B", fieldLinks: [] },
      ];
      vi.mocked(prisma.businessConcept.findMany).mockResolvedValue(mockConcepts as never);

      const result = await getConcepts(undefined, mockCtx);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toHaveLength(2);
      }
    });

    it("filters by domain", async () => {
      vi.mocked(prisma.businessConcept.findMany).mockResolvedValue([] as never);

      await getConcepts({ domain: "Finance" }, mockCtx);

      expect(prisma.businessConcept.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ domain: "Finance" }),
        })
      );
    });

    it("filters by tag", async () => {
      vi.mocked(prisma.businessConcept.findMany).mockResolvedValue([] as never);

      await getConcepts({ tag: "financial" }, mockCtx);

      expect(prisma.businessConcept.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ tags: { has: "financial" } }),
        })
      );
    });
  });

  // ── Field Linking ──

  describe("linkFieldToConcept", () => {
    it("creates a link between field and concept", async () => {
      vi.mocked(prisma.field.findUnique).mockResolvedValue({ id: "fld-1" } as never);
      vi.mocked(prisma.businessConcept.findUnique).mockResolvedValue({ id: "bc-1" } as never);
      vi.mocked(prisma.fieldConceptLink.create).mockResolvedValue({
        id: "link-1",
        fieldId: "fld-1",
        conceptId: "bc-1",
        confidence: 0.95,
        linkedBy: "user-1",
      } as never);

      const result = await linkFieldToConcept("fld-1", "bc-1", mockCtx, 0.95);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.confidence).toBe(0.95);
        expect(result.data.linkedBy).toBe("user-1");
      }
    });

    it("returns not-found when field does not exist", async () => {
      vi.mocked(prisma.field.findUnique).mockResolvedValue(null);

      const result = await linkFieldToConcept("nonexistent", "bc-1", mockCtx);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe("NOT_FOUND");
      }
    });

    it("returns not-found when concept does not exist", async () => {
      vi.mocked(prisma.field.findUnique).mockResolvedValue({ id: "fld-1" } as never);
      vi.mocked(prisma.businessConcept.findUnique).mockResolvedValue(null);

      const result = await linkFieldToConcept("fld-1", "nonexistent", mockCtx);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe("NOT_FOUND");
      }
    });

    it("returns duplicate error for existing link", async () => {
      vi.mocked(prisma.field.findUnique).mockResolvedValue({ id: "fld-1" } as never);
      vi.mocked(prisma.businessConcept.findUnique).mockResolvedValue({ id: "bc-1" } as never);
      vi.mocked(prisma.fieldConceptLink.create).mockRejectedValue(
        new Error("Unique constraint failed")
      );

      const result = await linkFieldToConcept("fld-1", "bc-1", mockCtx);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe("DUPLICATE");
      }
    });
  });

  describe("unlinkFieldFromConcept", () => {
    it("removes the link", async () => {
      vi.mocked(prisma.fieldConceptLink.findUnique).mockResolvedValue({
        id: "link-1",
        fieldId: "fld-1",
        conceptId: "bc-1",
      } as never);
      vi.mocked(prisma.fieldConceptLink.delete).mockResolvedValue({} as never);

      const result = await unlinkFieldFromConcept("fld-1", "bc-1", mockCtx);

      expect(result.success).toBe(true);
    });

    it("returns not-found when link does not exist", async () => {
      vi.mocked(prisma.fieldConceptLink.findUnique).mockResolvedValue(null);

      const result = await unlinkFieldFromConcept("fld-1", "bc-1", mockCtx);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe("NOT_FOUND");
      }
    });
  });

  describe("getConceptsForField", () => {
    it("returns concepts linked to a field", async () => {
      const mockLinks = [
        {
          id: "link-1",
          fieldId: "fld-1",
          conceptId: "bc-1",
          confidence: 1.0,
          concept: { id: "bc-1", name: "Customer Identifier" },
        },
      ];
      vi.mocked(prisma.fieldConceptLink.findMany).mockResolvedValue(mockLinks as never);

      const result = await getConceptsForField("fld-1", mockCtx);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toHaveLength(1);
        expect(result.data[0].concept.name).toBe("Customer Identifier");
      }
    });
  });

  // ── Suggestions ──

  describe("suggestConceptsForField", () => {
    it("suggests concepts based on field name matching synonyms", async () => {
      vi.mocked(prisma.businessConcept.findMany).mockResolvedValue([
        {
          id: "bc-1",
          name: "Customer Identifier",
          synonyms: ["cust_id", "customer_number", "CustomerNo"],
          canonicalType: "string",
          tags: [],
        },
        {
          id: "bc-2",
          name: "Transaction Amount",
          synonyms: ["amount", "txn_amount"],
          canonicalType: "decimal",
          tags: [],
        },
      ] as never);

      const result = await suggestConceptsForField("cust_id", "string", mockCtx);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.length).toBeGreaterThan(0);
        expect(result.data[0].concept.name).toBe("Customer Identifier");
        expect(result.data[0].score).toBeGreaterThanOrEqual(0.9);
      }
    });

    it("returns empty for empty field name", async () => {
      const result = await suggestConceptsForField("", "string", mockCtx);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toHaveLength(0);
      }
    });

    it("suggests concepts based on partial name match", async () => {
      vi.mocked(prisma.businessConcept.findMany).mockResolvedValue([
        {
          id: "bc-1",
          name: "Email Address",
          synonyms: ["email", "email_addr", "emailAddress"],
          canonicalType: "string",
          tags: [],
        },
      ] as never);

      const result = await suggestConceptsForField("email", "string", mockCtx);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.length).toBeGreaterThan(0);
        expect(result.data[0].concept.name).toBe("Email Address");
      }
    });

    it("returns no suggestions for unrelated field name", async () => {
      vi.mocked(prisma.businessConcept.findMany).mockResolvedValue([
        {
          id: "bc-1",
          name: "Customer Identifier",
          synonyms: ["cust_id"],
          canonicalType: "string",
          tags: [],
        },
      ] as never);

      const result = await suggestConceptsForField("zzzz_unrelated", "string", mockCtx);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toHaveLength(0);
      }
    });
  });

  // ── Concept Usage ──

  describe("getConceptUsage", () => {
    it("returns usage with linked fields and domain info", async () => {
      vi.mocked(prisma.businessConcept.findUnique).mockResolvedValue({
        id: "bc-1",
        name: "Customer Identifier",
        fieldLinks: [
          {
            id: "link-1",
            fieldId: "fld-1",
            conceptId: "bc-1",
            confidence: 1.0,
            field: {
              id: "fld-1",
              name: "customer_id",
              entity: {
                id: "ent-1",
                name: "Customer",
                domain: { name: "Identity" },
              },
            },
          },
          {
            id: "link-2",
            fieldId: "fld-2",
            conceptId: "bc-1",
            confidence: 0.8,
            field: {
              id: "fld-2",
              name: "cust_id",
              entity: {
                id: "ent-2",
                name: "Order",
                domain: { name: "Commerce" },
              },
            },
          },
        ],
      } as never);

      const result = await getConceptUsage("bc-1", mockCtx);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.usageCount).toBe(2);
        expect(result.data.fields).toHaveLength(2);
        expect(result.data.fields[0].fieldName).toBe("customer_id");
        expect(result.data.fields[0].domainName).toBe("Identity");
        expect(result.data.fields[1].entityName).toBe("Order");
      }
    });

    it("returns not-found for missing concept", async () => {
      vi.mocked(prisma.businessConcept.findUnique).mockResolvedValue(null);

      const result = await getConceptUsage("nonexistent", mockCtx);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe("NOT_FOUND");
      }
    });

    it("returns zero usage for concept with no links", async () => {
      vi.mocked(prisma.businessConcept.findUnique).mockResolvedValue({
        id: "bc-1",
        name: "Empty Concept",
        fieldLinks: [],
      } as never);

      const result = await getConceptUsage("bc-1", mockCtx);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.usageCount).toBe(0);
        expect(result.data.fields).toHaveLength(0);
      }
    });
  });
});

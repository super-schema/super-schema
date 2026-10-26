import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock prisma
vi.mock("@/lib/db", () => ({
  prisma: {
    field: {
      findMany: vi.fn(),
      count: vi.fn(),
    },
    auditLog: {
      create: vi.fn().mockResolvedValue({ id: "audit-1", timestamp: new Date() }),
      findMany: vi.fn(),
      count: vi.fn(),
    },
  },
}));

import {
  queryFields,
  detectGaps,
  queryAuditTrail,
  exportAuditTrail,
  generateChangeSummary,
  parseRetentionToYears,
} from "@/services/compliance.service";
import { prisma } from "@/lib/db";
import type { ServiceContext } from "@/types/service-context";
import { assign } from "../../helpers/access-mocks";

// A platform administrator (the compliance rules over the caller's assignments: the role rules themselves are pinned in compliance-service-access.test.ts).
const mockCtx: ServiceContext = {
  userId: "user-1",
  userRole: "ADMIN",
  assignments: [assign.global()],
  prisma: prisma as unknown as ServiceContext["prisma"],
};

// Somebody who holds a role in the tenant but not one that reaches the compliance pages.
const unauthorizedCtx: ServiceContext = {
  userId: "user-1",
  userRole: "VIEWER",
  assignments: [assign.tenant("VIEWER", "tenant-1")],
  tenantId: "tenant-1",
  prisma: prisma as unknown as ServiceContext["prisma"],
};

// Helper to make a field with domain + entity info
function makeField(overrides: Record<string, unknown> = {}) {
  return {
    id: "fld-1",
    name: "email",
    type: "string",
    classification: null,
    decorators: {},
    entity: {
      id: "ent-1",
      name: "Customer",
      slug: "customer",
      domain: { id: "dom-1", name: "Commerce", slug: "commerce" },
      product: { slug: "orders" },
    },
    ...overrides,
  };
}

describe("Compliance Service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // The Query and Gaps tabs show the tenant being viewed: a field has no tenant of its own, its entity does. (The audit trail has no
  // tenant column: KD-016.)
  describe("tenant scope", () => {
    const inTenant: ServiceContext = { ...mockCtx, tenantId: "tenant-a" };

    it("queryFields asks for the fields of entities of the tenant, for the count and for the page", async () => {
      vi.mocked(prisma.field.count).mockResolvedValue(0);
      vi.mocked(prisma.field.findMany).mockResolvedValue([]);

      await queryFields({}, undefined, inTenant);

      expect(vi.mocked(prisma.field.count).mock.calls[0][0]).toEqual({ where: { entity: { tenantId: "tenant-a" } } });
      expect(vi.mocked(prisma.field.findMany).mock.calls[0][0]?.where).toEqual({ entity: { tenantId: "tenant-a" } });
    });

    it("queryFields keeps the domain filter and the tenant together", async () => {
      vi.mocked(prisma.field.count).mockResolvedValue(0);
      vi.mocked(prisma.field.findMany).mockResolvedValue([]);

      await queryFields({ domains: ["dom-1"], classifications: ["PII"] }, undefined, inTenant);

      expect(vi.mocked(prisma.field.findMany).mock.calls[0][0]?.where).toEqual({
        classification: { in: ["PII"] },
        entity: { domainId: { in: ["dom-1"] }, tenantId: "tenant-a" },
      });
    });

    it("queryFields without a tenant (not a page) filters nothing, as before", async () => {
      vi.mocked(prisma.field.count).mockResolvedValue(0);
      vi.mocked(prisma.field.findMany).mockResolvedValue([]);

      await queryFields({}, undefined, mockCtx);

      expect(vi.mocked(prisma.field.findMany).mock.calls[0][0]?.where).toEqual({});
    });

    it("detectGaps reads only the fields of the tenant, alone and with a domain filter", async () => {
      vi.mocked(prisma.field.findMany).mockResolvedValue([]);

      await detectGaps({}, inTenant);
      await detectGaps({ domains: ["dom-1"] }, inTenant);
      await detectGaps({}, mockCtx);

      const wheres = vi.mocked(prisma.field.findMany).mock.calls.map((call) => call[0]?.where);
      expect(wheres).toEqual([{ entity: { tenantId: "tenant-a" } }, { entity: { domainId: { in: ["dom-1"] }, tenantId: "tenant-a" } }, {}]);
    });

    it("the role gate is the same in a tenant: a viewer is refused before anything is read", async () => {
      const result = await queryFields({}, undefined, { ...unauthorizedCtx, tenantId: "tenant-a" });
      expect(!result.success && result.error.code).toBe("FORBIDDEN");
      expect(prisma.field.findMany).not.toHaveBeenCalled();
    });
  });

  // ============================================================
  // Story 6.1 — queryFields
  // ============================================================
  describe("queryFields", () => {
    it("returns all fields when no filters applied", async () => {
      vi.mocked(prisma.field.count).mockResolvedValue(2);
      vi.mocked(prisma.field.findMany).mockResolvedValue([
        makeField({ id: "fld-1", name: "email", classification: "PII" }),
        makeField({ id: "fld-2", name: "status", classification: "INTERNAL" }),
      ] as never);

      const result = await queryFields({}, { page: 1, pageSize: 25, sortBy: "entityName", sortOrder: "asc" }, mockCtx);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.fields).toHaveLength(2);
        expect(result.data.total).toBe(2);
      }
    });

    it("narrows results by classification filter", async () => {
      vi.mocked(prisma.field.count).mockResolvedValue(1);
      vi.mocked(prisma.field.findMany).mockResolvedValue([
        makeField({ classification: "PII" }),
      ] as never);

      const result = await queryFields(
        { classifications: ["PII"] },
        { page: 1, pageSize: 25, sortBy: "entityName", sortOrder: "asc" },
        mockCtx
      );

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.fields).toHaveLength(1);
        expect(result.data.fields[0].classification).toBe("PII");
      }
      expect(prisma.field.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            classification: { in: ["PII"] },
          }),
        })
      );
    });

    it("narrows results by domain filter", async () => {
      vi.mocked(prisma.field.count).mockResolvedValue(1);
      vi.mocked(prisma.field.findMany).mockResolvedValue([
        makeField(),
      ] as never);

      const result = await queryFields(
        { domains: ["dom-1"] },
        { page: 1, pageSize: 25, sortBy: "entityName", sortOrder: "asc" },
        mockCtx
      );

      expect(result.success).toBe(true);
      expect(prisma.field.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            entity: expect.objectContaining({
              domainId: { in: ["dom-1"] },
            }),
          }),
        })
      );
    });

    it("narrows results by text search", async () => {
      vi.mocked(prisma.field.count).mockResolvedValue(1);
      vi.mocked(prisma.field.findMany).mockResolvedValue([
        makeField({ name: "email" }),
      ] as never);

      const result = await queryFields(
        { textSearch: "email" },
        { page: 1, pageSize: 25, sortBy: "entityName", sortOrder: "asc" },
        mockCtx
      );

      expect(result.success).toBe(true);
      expect(prisma.field.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            OR: expect.arrayContaining([
              expect.objectContaining({ name: { contains: "email", mode: "insensitive" } }),
            ]),
          }),
        })
      );
    });

    it("applies AND logic for combined filters", async () => {
      vi.mocked(prisma.field.count).mockResolvedValue(1);
      vi.mocked(prisma.field.findMany).mockResolvedValue([
        makeField({ classification: "PII", name: "email" }),
      ] as never);

      const result = await queryFields(
        { classifications: ["PII"], textSearch: "email", domains: ["dom-1"] },
        { page: 1, pageSize: 25, sortBy: "entityName", sortOrder: "asc" },
        mockCtx
      );

      expect(result.success).toBe(true);
      expect(prisma.field.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            classification: { in: ["PII"] },
            entity: expect.objectContaining({
              domainId: { in: ["dom-1"] },
            }),
          }),
        })
      );
    });

    it("returns correct pagination results", async () => {
      vi.mocked(prisma.field.count).mockResolvedValue(50);
      vi.mocked(prisma.field.findMany).mockResolvedValue(
        Array.from({ length: 25 }, (_, i) =>
          makeField({ id: `fld-${i}`, name: `field_${i}` })
        ) as never
      );

      const result = await queryFields(
        {},
        { page: 2, pageSize: 25, sortBy: "entityName", sortOrder: "asc" },
        mockCtx
      );

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.total).toBe(50);
        expect(result.data.fields).toHaveLength(25);
      }
      expect(prisma.field.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          skip: 25,
          take: 25,
        })
      );
    });

    it("applies sorting by fieldName", async () => {
      vi.mocked(prisma.field.count).mockResolvedValue(1);
      vi.mocked(prisma.field.findMany).mockResolvedValue([makeField()] as never);

      await queryFields(
        {},
        { page: 1, pageSize: 25, sortBy: "fieldName", sortOrder: "desc" },
        mockCtx
      );

      expect(prisma.field.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          orderBy: { name: "desc" },
        })
      );
    });

    it("rejects unauthorized roles", async () => {
      const result = await queryFields({}, { page: 1, pageSize: 25, sortBy: "entityName", sortOrder: "asc" }, unauthorizedCtx);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe("FORBIDDEN");
      }
    });

    it("extracts classification from decorators JSONB when field.classification is null", async () => {
      vi.mocked(prisma.field.count).mockResolvedValue(1);
      vi.mocked(prisma.field.findMany).mockResolvedValue([
        makeField({
          classification: null,
          decorators: { classification: { level: "PII" } },
        }),
      ] as never);

      const result = await queryFields({}, { page: 1, pageSize: 25, sortBy: "entityName", sortOrder: "asc" }, mockCtx);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.fields[0].classification).toBe("PII");
      }
    });

    it("extracts policy from decorators JSONB", async () => {
      vi.mocked(prisma.field.count).mockResolvedValue(1);
      vi.mocked(prisma.field.findMany).mockResolvedValue([
        makeField({
          decorators: {
            policy: { retention: "3 years", anonymization: "hash", encryption: "AES-256" },
          },
        }),
      ] as never);

      const result = await queryFields({}, { page: 1, pageSize: 25, sortBy: "entityName", sortOrder: "asc" }, mockCtx);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.fields[0].retention).toBe("3 years");
        expect(result.data.fields[0].anonymization).toBe("hash");
        expect(result.data.fields[0].encryption).toBe("AES-256");
      }
    });

    it("filters by anonymization method", async () => {
      vi.mocked(prisma.field.count).mockResolvedValue(2);
      vi.mocked(prisma.field.findMany).mockResolvedValue([
        makeField({
          id: "fld-1",
          decorators: { policy: { anonymization: "hash" } },
        }),
        makeField({
          id: "fld-2",
          decorators: { policy: { anonymization: "mask" } },
        }),
      ] as never);

      const result = await queryFields(
        { anonymization: "hash" },
        { page: 1, pageSize: 25, sortBy: "entityName", sortOrder: "asc" },
        mockCtx
      );

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.fields).toHaveLength(1);
        expect(result.data.fields[0].anonymization).toBe("hash");
      }
    });
  });

  // ============================================================
  // parseRetentionToYears
  // ============================================================
  describe("parseRetentionToYears", () => {
    it("parses years correctly", () => {
      expect(parseRetentionToYears("3 years")).toBe(3);
      expect(parseRetentionToYears("1 year")).toBe(1);
      expect(parseRetentionToYears("7 years")).toBe(7);
    });

    it("parses months correctly", () => {
      expect(parseRetentionToYears("6 months")).toBe(0.5);
      expect(parseRetentionToYears("12 months")).toBe(1);
    });

    it("parses days correctly", () => {
      expect(parseRetentionToYears("365 days")).toBe(1);
      expect(parseRetentionToYears("90 days")).toBeCloseTo(0.2466, 1);
    });

    it("returns null for invalid input", () => {
      expect(parseRetentionToYears("forever")).toBeNull();
      expect(parseRetentionToYears("")).toBeNull();
    });
  });

  // ============================================================
  // Route slugs for entity links (assetHref consumers)
  // ============================================================
  describe("route slugs", () => {
    const tenantLevelEntity = {
      id: "ent-t",
      name: "Customer",
      slug: "customer",
      domain: null,
      product: null,
    };

    it("queryFields carries the placed entity's real domain and product slugs", async () => {
      vi.mocked(prisma.field.count).mockResolvedValue(1);
      vi.mocked(prisma.field.findMany).mockResolvedValue([makeField()] as never);

      const result = await queryFields({}, { page: 1, pageSize: 25, sortBy: "entityName", sortOrder: "asc" }, mockCtx);

      expect(result.success && result.data.fields[0]).toMatchObject({
        entitySlug: "customer",
        domainSlug: "commerce",
        productSlug: "orders",
      });
    });

    it("queryFields carries null slugs for a tenant-level entity", async () => {
      vi.mocked(prisma.field.count).mockResolvedValue(1);
      vi.mocked(prisma.field.findMany).mockResolvedValue([makeField({ entity: tenantLevelEntity })] as never);

      const result = await queryFields({}, { page: 1, pageSize: 25, sortBy: "entityName", sortOrder: "asc" }, mockCtx);

      expect(result.success && result.data.fields[0]).toMatchObject({
        domain: "Enterprise",
        domainSlug: null,
        productSlug: null,
      });
    });

    it("detectGaps carries null slugs for a tenant-level entity", async () => {
      vi.mocked(prisma.field.findMany).mockResolvedValue([makeField({ entity: tenantLevelEntity })] as never);

      const result = await detectGaps({}, mockCtx);

      expect(result.success && result.data.gaps[0]).toMatchObject({
        entitySlug: "customer",
        domainSlug: null,
        productSlug: null,
      });
    });
  });

  // ============================================================
  // Story 6.2 — detectGaps
  // ============================================================
  describe("detectGaps", () => {
    it("detects PII fields without anonymization as CRITICAL", async () => {
      vi.mocked(prisma.field.findMany).mockResolvedValue([
        makeField({
          classification: "PII",
          decorators: { classification: { level: "PII" }, policy: {} },
        }),
      ] as never);

      const result = await detectGaps({}, mockCtx);

      expect(result.success).toBe(true);
      if (result.success) {
        const piiGaps = result.data.gaps.filter(
          (g) => g.gapType === "PII_NO_ANONYMIZATION"
        );
        expect(piiGaps).toHaveLength(1);
        expect(piiGaps[0].severity).toBe("CRITICAL");
        expect(piiGaps[0].suggestedFix).toContain("anonymization");
      }
    });

    it("detects SENSITIVE fields without encryption as WARNING", async () => {
      vi.mocked(prisma.field.findMany).mockResolvedValue([
        makeField({
          classification: "SENSITIVE",
          decorators: { classification: { level: "SENSITIVE" }, policy: {} },
        }),
      ] as never);

      const result = await detectGaps({}, mockCtx);

      expect(result.success).toBe(true);
      if (result.success) {
        const encGaps = result.data.gaps.filter(
          (g) => g.gapType === "SENSITIVE_NO_ENCRYPTION"
        );
        expect(encGaps).toHaveLength(1);
        expect(encGaps[0].severity).toBe("WARNING");
        expect(encGaps[0].suggestedFix).toContain("encryption");
      }
    });

    it("detects unclassified fields as CRITICAL", async () => {
      vi.mocked(prisma.field.findMany).mockResolvedValue([
        makeField({ classification: null, decorators: {} }),
      ] as never);

      const result = await detectGaps({}, mockCtx);

      expect(result.success).toBe(true);
      if (result.success) {
        const unclassified = result.data.gaps.filter(
          (g) => g.gapType === "UNCLASSIFIED"
        );
        expect(unclassified).toHaveLength(1);
        expect(unclassified[0].severity).toBe("CRITICAL");
      }
    });

    it("detects PII/SENSITIVE fields without retention as WARNING", async () => {
      vi.mocked(prisma.field.findMany).mockResolvedValue([
        makeField({
          classification: "PII",
          decorators: {
            classification: { level: "PII" },
            policy: { anonymization: "hash" },
          },
        }),
      ] as never);

      const result = await detectGaps({}, mockCtx);

      expect(result.success).toBe(true);
      if (result.success) {
        const retentionGaps = result.data.gaps.filter(
          (g) => g.gapType === "NO_RETENTION"
        );
        expect(retentionGaps).toHaveLength(1);
        expect(retentionGaps[0].severity).toBe("WARNING");
      }
    });

    it("produces no gaps for fully compliant fields", async () => {
      vi.mocked(prisma.field.findMany).mockResolvedValue([
        makeField({
          classification: "PII",
          decorators: {
            classification: { level: "PII" },
            policy: {
              anonymization: "hash",
              encryption: "AES-256",
              retention: "3 years",
            },
          },
        }),
      ] as never);

      const result = await detectGaps({}, mockCtx);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.gaps).toHaveLength(0);
        expect(result.data.summary.criticalCount).toBe(0);
        expect(result.data.summary.warningCount).toBe(0);
      }
    });

    it("computes correct gap summary", async () => {
      vi.mocked(prisma.field.findMany).mockResolvedValue([
        makeField({
          id: "fld-1",
          classification: null,
          decorators: {},
          entity: { id: "ent-1", name: "Customer", slug: "customer", domain: { id: "dom-1", name: "Commerce", slug: "commerce" }, product: { slug: "orders" } },
        }),
        makeField({
          id: "fld-2",
          classification: "PII",
          decorators: { classification: { level: "PII" }, policy: {} },
          entity: { id: "ent-2", name: "Order", slug: "order", domain: { id: "dom-1", name: "Commerce", slug: "commerce" }, product: { slug: "orders" } },
        }),
        makeField({
          id: "fld-3",
          classification: "SENSITIVE",
          decorators: { classification: { level: "SENSITIVE" }, policy: {} },
          entity: { id: "ent-2", name: "Order", slug: "order", domain: { id: "dom-1", name: "Commerce", slug: "commerce" }, product: { slug: "orders" } },
        }),
      ] as never);

      const result = await detectGaps({}, mockCtx);

      expect(result.success).toBe(true);
      if (result.success) {
        // fld-1: UNCLASSIFIED (critical)
        // fld-2: PII_NO_ANONYMIZATION (critical) + NO_RETENTION (warning)
        // fld-3: SENSITIVE_NO_ENCRYPTION (warning) + NO_RETENTION (warning)
        expect(result.data.summary.criticalCount).toBe(2);
        expect(result.data.summary.warningCount).toBe(3);
        expect(result.data.summary.affectedEntityCount).toBe(2);
        expect(result.data.summary.countsByGapType.UNCLASSIFIED).toBe(1);
        expect(result.data.summary.countsByGapType.PII_NO_ANONYMIZATION).toBe(1);
      }
    });

    it("narrows gap detection by domain filter", async () => {
      vi.mocked(prisma.field.findMany).mockResolvedValue([] as never);

      await detectGaps({ domains: ["dom-2"] }, mockCtx);

      expect(prisma.field.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            entity: { domainId: { in: ["dom-2"] } },
          }),
        })
      );
    });

    it("rejects unauthorized roles", async () => {
      const result = await detectGaps({}, unauthorizedCtx);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe("FORBIDDEN");
      }
    });
  });

  // ============================================================
  // Story 6.5 — generateChangeSummary
  // ============================================================
  describe("generateChangeSummary", () => {
    it("returns 'Created new record' when before is null", () => {
      expect(generateChangeSummary(null, { name: "test" })).toBe(
        "Created new record"
      );
    });

    it("returns 'Deleted record' when after is null", () => {
      expect(generateChangeSummary({ name: "test" }, null)).toBe(
        "Deleted record"
      );
    });

    it("returns 'No changes recorded' when both are null", () => {
      expect(generateChangeSummary(null, null)).toBe("No changes recorded");
    });

    it("identifies changed fields correctly", () => {
      const result = generateChangeSummary(
        { name: "old", type: "string", status: "DRAFT" },
        { name: "new", type: "string", status: "ACTIVE" }
      );
      expect(result).toBe("Updated 2 fields: name, status");
    });

    it("identifies added fields", () => {
      const result = generateChangeSummary(
        { name: "test" },
        { name: "test", newField: "value" }
      );
      expect(result).toBe("Updated 1 field: newField");
    });

    it("identifies removed fields", () => {
      const result = generateChangeSummary(
        { name: "test", removed: "value" },
        { name: "test" }
      );
      expect(result).toBe("Updated 1 field: removed");
    });

    it("returns 'No fields changed' when objects are identical", () => {
      const result = generateChangeSummary(
        { name: "test", type: "string" },
        { name: "test", type: "string" }
      );
      expect(result).toBe("No fields changed");
    });
  });

  // ============================================================
  // Story 6.5 — queryAuditTrail
  // ============================================================
  describe("queryAuditTrail", () => {
    const mockAuditEntry = {
      id: "al-1",
      action: "CREATE",
      entityType: "Field",
      entityId: "fld-1",
      userId: "user-1",
      timestamp: new Date("2026-04-01T10:00:00Z"),
      beforeState: null,
      afterState: { name: "email", type: "string" },
      user: { id: "user-1", name: "John", image: null },
    };

    it("returns entries in reverse chronological order", async () => {
      vi.mocked(prisma.auditLog.count).mockResolvedValue(1);
      vi.mocked(prisma.auditLog.findMany).mockResolvedValue([
        mockAuditEntry,
      ] as never);

      const result = await queryAuditTrail(
        {},
        { page: 1, pageSize: 50 },
        mockCtx
      );

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.entries).toHaveLength(1);
        expect(result.data.entries[0].action).toBe("CREATE");
        expect(result.data.entries[0].userName).toBe("John");
      }
      expect(prisma.auditLog.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          orderBy: { timestamp: "desc" },
        })
      );
    });

    it("filters by action type", async () => {
      vi.mocked(prisma.auditLog.count).mockResolvedValue(1);
      vi.mocked(prisma.auditLog.findMany).mockResolvedValue([mockAuditEntry] as never);

      await queryAuditTrail(
        { actionTypes: ["CREATE"] },
        { page: 1, pageSize: 50 },
        mockCtx
      );

      expect(prisma.auditLog.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            action: { in: ["CREATE"] },
          }),
        })
      );
    });

    it("filters by user", async () => {
      vi.mocked(prisma.auditLog.count).mockResolvedValue(1);
      vi.mocked(prisma.auditLog.findMany).mockResolvedValue([mockAuditEntry] as never);

      await queryAuditTrail(
        { userId: "user-1" },
        { page: 1, pageSize: 50 },
        mockCtx
      );

      expect(prisma.auditLog.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            userId: "user-1",
          }),
        })
      );
    });

    it("filters by entity type", async () => {
      vi.mocked(prisma.auditLog.count).mockResolvedValue(1);
      vi.mocked(prisma.auditLog.findMany).mockResolvedValue([mockAuditEntry] as never);

      await queryAuditTrail(
        { entityType: "Field" },
        { page: 1, pageSize: 50 },
        mockCtx
      );

      expect(prisma.auditLog.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            entityType: "Field",
          }),
        })
      );
    });

    it("filters by date range", async () => {
      const from = new Date("2026-04-01T00:00:00Z");
      const to = new Date("2026-04-02T00:00:00Z");
      vi.mocked(prisma.auditLog.count).mockResolvedValue(1);
      vi.mocked(prisma.auditLog.findMany).mockResolvedValue([mockAuditEntry] as never);

      await queryAuditTrail(
        { dateRange: { from, to } },
        { page: 1, pageSize: 50 },
        mockCtx
      );

      expect(prisma.auditLog.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            timestamp: { gte: from, lte: to },
          }),
        })
      );
    });

    it("paginates correctly", async () => {
      vi.mocked(prisma.auditLog.count).mockResolvedValue(100);
      vi.mocked(prisma.auditLog.findMany).mockResolvedValue([mockAuditEntry] as never);

      const result = await queryAuditTrail(
        {},
        { page: 3, pageSize: 50 },
        mockCtx
      );

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.total).toBe(100);
      }
      expect(prisma.auditLog.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          skip: 100,
          take: 50,
        })
      );
    });

    it("generates change summary", async () => {
      vi.mocked(prisma.auditLog.count).mockResolvedValue(1);
      vi.mocked(prisma.auditLog.findMany).mockResolvedValue([
        {
          ...mockAuditEntry,
          beforeState: { name: "old" },
          afterState: { name: "new" },
        },
      ] as never);

      const result = await queryAuditTrail({}, { page: 1, pageSize: 50 }, mockCtx);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.entries[0].changeSummary).toBe(
          "Updated 1 field: name"
        );
      }
    });

    it("rejects unauthorized roles", async () => {
      const result = await queryAuditTrail({}, { page: 1, pageSize: 50 }, unauthorizedCtx);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe("FORBIDDEN");
      }
    });
  });

  // ============================================================
  // Story 6.5 — exportAuditTrail
  // ============================================================
  describe("exportAuditTrail", () => {
    it("returns all filtered entries without pagination limit", async () => {
      vi.mocked(prisma.auditLog.count).mockResolvedValue(3);
      vi.mocked(prisma.auditLog.findMany).mockResolvedValue([
        {
          id: "al-1",
          action: "CREATE",
          entityType: "Field",
          entityId: "fld-1",
          userId: "user-1",
          timestamp: new Date(),
          beforeState: null,
          afterState: {},
          user: { id: "user-1", name: "John", image: null },
        },
        {
          id: "al-2",
          action: "UPDATE",
          entityType: "Field",
          entityId: "fld-2",
          userId: "user-1",
          timestamp: new Date(),
          beforeState: {},
          afterState: {},
          user: { id: "user-1", name: "John", image: null },
        },
        {
          id: "al-3",
          action: "DELETE",
          entityType: "Entity",
          entityId: "ent-1",
          userId: "user-1",
          timestamp: new Date(),
          beforeState: {},
          afterState: null,
          user: { id: "user-1", name: "John", image: null },
        },
      ] as never);

      const result = await exportAuditTrail({}, mockCtx);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toHaveLength(3);
      }
    });
  });
});

describe("compliance services: an unexpected failure is answered in fixed words and logged", () => {
  const DRIVER = 'Invalid `prisma.field.count()` invocation in /srv/app/src/services/compliance.service.ts:81:36\n\nERROR: invalid byte sequence for encoding "UTF8": 0x00';

  it.each([
    ["queryFields", () => queryFields({}, undefined, mockCtx), "Failed to query fields", () => vi.mocked(prisma.field.count).mockRejectedValueOnce(new Error(DRIVER))],
    ["detectGaps", () => detectGaps({}, mockCtx), "Failed to detect gaps", () => vi.mocked(prisma.field.findMany).mockRejectedValueOnce(new Error(DRIVER))],
    ["queryAuditTrail", () => queryAuditTrail({}, undefined, mockCtx), "Failed to query audit trail", () => vi.mocked(prisma.auditLog.count).mockRejectedValueOnce(new Error(DRIVER))],
  ])("%s never returns the driver's text", async (label, run, message, arrange) => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    arrange();
    const result = await run();
    expect(result).toEqual({ success: false, error: { code: "INTERNAL_ERROR", message } });
    expect(JSON.stringify(result)).not.toMatch(/prisma|invocation|UTF8|srv\/app/i);
    // the details are logged server-side, under the name of the service
    expect(spy.mock.calls.flat().join(" ")).toContain("invalid byte sequence");
    expect(spy.mock.calls.flat().join(" ")).toContain(label);
    spy.mockRestore();
  });
});

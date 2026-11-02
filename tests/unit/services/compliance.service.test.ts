import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock prisma
vi.mock("@/lib/db", () => ({
  prisma: {
    field: {
      findMany: vi.fn(),
      count: vi.fn(),
    },
    entity: {
      findMany: vi.fn(),
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
  exportFields,
  generateChangeSummary,
  parseRetentionToYears,
} from "@/services/compliance.service";
import { prisma } from "@/lib/db";
import { MAX_EXPORT_ROWS } from "@/types/schemas/compliance";
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

/** The database filter of a classification filter: the column, or no column and the legacy level in the decorators. */
const classificationWhere = (levels: string[]) => ({
  AND: [
    {
      OR: [
        { classification: { in: levels } },
        { classification: null, OR: levels.map((level) => ({ decorators: { path: ["classification", "level"], equals: level } })) },
      ],
    },
  ],
});

describe("Compliance Service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.entity.findMany).mockResolvedValue([]);
  });

  // The Query and Gaps tabs show the tenant being viewed: a field has no tenant of its own, its entity does. The audit trail has one
  // (`audit_log.tenantId`, KD-016): see "queryAuditTrail > tenant scope" below.
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
        ...classificationWhere(["PII"]),
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
          where: expect.objectContaining(classificationWhere(["PII"])),
        })
      );
    });

    it("a classification filter asks for the legacy level in the decorators as well as the column (the database answers it: see tests/integration/compliance)", async () => {
      vi.mocked(prisma.field.count).mockResolvedValue(0);
      vi.mocked(prisma.field.findMany).mockResolvedValue([]);

      await queryFields({ classifications: ["PII", "SENSITIVE"] }, undefined, mockCtx);

      const where = vi.mocked(prisma.field.findMany).mock.calls[0][0]?.where as { AND: Array<{ OR: unknown[] }> };
      expect(where).toEqual(classificationWhere(["PII", "SENSITIVE"]));
      expect(where.AND[0].OR[1]).toEqual({
        classification: null,
        OR: [
          { decorators: { path: ["classification", "level"], equals: "PII" } },
          { decorators: { path: ["classification", "level"], equals: "SENSITIVE" } },
        ],
      });
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
            ...classificationWhere(["PII"]),
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
          orderBy: [{ name: "desc" }, { id: "asc" }],
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
          orderBy: [{ timestamp: "desc" }, { id: "desc" }],
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
            timestamp: { gte: from, lt: to },
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

    // The audit trail has a tenant (KD-016): the rows of the tenant in view, for the count and for the page, and nothing of another tenant's.
    describe("tenant scope (audit_log.tenantId)", () => {
      const officerOf = (tenantId: string): ServiceContext => ({ ...mockCtx, userRole: "COMPLIANCE_OFFICER", assignments: [assign.tenant("COMPLIANCE_OFFICER", tenantId)], tenantId });
      const adminOf = (tenantId: string): ServiceContext => ({ ...mockCtx, assignments: [assign.global()], tenantId });
      const whereOfPage = () => vi.mocked(prisma.auditLog.findMany).mock.calls.at(-1)?.[0]?.where;
      const whereOfCount = () => vi.mocked(prisma.auditLog.count).mock.calls.at(-1)?.[0]?.where;

      beforeEach(() => {
        vi.mocked(prisma.auditLog.count).mockResolvedValue(0);
        vi.mocked(prisma.auditLog.findMany).mockResolvedValue([]);
      });

      it("a tenant's compliance officer reads only the rows of that tenant: the count and the page ask for it", async () => {
        const result = await queryAuditTrail({}, { page: 1, pageSize: 50 }, officerOf("tenant-a"));
        expect(result.success).toBe(true);
        expect(whereOfPage()).toEqual({ tenantId: "tenant-a" });
        expect(whereOfCount()).toEqual({ tenantId: "tenant-a" });
      });

      it("keeps every filter next to the tenant (a filter never widens the scope)", async () => {
        await queryAuditTrail({ actionTypes: ["CREATE"], userId: "u1", entityType: "Field", entityName: "fld" }, { page: 1, pageSize: 50 }, officerOf("tenant-a"));
        expect(whereOfPage()).toEqual({ tenantId: "tenant-a", action: { in: ["CREATE"] }, userId: "u1", entityType: "Field", entityId: { contains: "fld", mode: "insensitive" } });
      });

      it("a platform administrator also reads the rows no tenant owns (what was written before the column, or about the platform): the tenant in view's AND the null ones", async () => {
        await queryAuditTrail({}, { page: 1, pageSize: 50 }, adminOf("tenant-a"));
        expect(whereOfPage()).toEqual({ OR: [{ tenantId: "tenant-a" }, { tenantId: null }] });
        expect(whereOfCount()).toEqual({ OR: [{ tenantId: "tenant-a" }, { tenantId: null }] });
      });

      it("a tenant's officer never reads the unowned (null) rows", async () => {
        await queryAuditTrail({}, { page: 1, pageSize: 50 }, officerOf("tenant-a"));
        expect(JSON.stringify(whereOfPage())).not.toContain("null");
      });

      it("the export is scoped the same way", async () => {
        await exportAuditTrail({}, officerOf("tenant-b"));
        expect(whereOfPage()).toEqual({ tenantId: "tenant-b" });
        expect(whereOfCount()).toEqual({ tenantId: "tenant-b" });
        await exportAuditTrail({}, adminOf("tenant-b"));
        expect(whereOfPage()).toEqual({ OR: [{ tenantId: "tenant-b" }, { tenantId: null }] });
      });

      it("a role in ANOTHER tenant than the one in view reads nothing of either: refused before anything is read", async () => {
        vi.mocked(prisma.auditLog.findMany).mockClear();
        const ctx = { ...officerOf("tenant-a"), tenantId: "tenant-b" };
        const result = await queryAuditTrail({}, { page: 1, pageSize: 50 }, ctx);
        expect(result.success).toBe(false);
        expect(prisma.auditLog.findMany).not.toHaveBeenCalled();
        expect((await exportAuditTrail({}, ctx)).success).toBe(false);
      });

      it("with no tenant in view only a platform administrator reads, across every tenant (and the unowned rows)", async () => {
        await queryAuditTrail({}, { page: 1, pageSize: 50 }, mockCtx);
        expect(whereOfPage()).toEqual({});
      });
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
        expect(result.data.entries).toHaveLength(3);
        expect(result.data).toMatchObject({ total: 3, truncated: false });
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
    ["exportAuditTrail", () => exportAuditTrail({}, mockCtx), "Failed to export the audit trail", () => vi.mocked(prisma.auditLog.count).mockRejectedValueOnce(new Error(DRIVER))],
    ["exportFields", () => exportFields({}, undefined, mockCtx), "Failed to export fields", () => vi.mocked(prisma.field.count).mockRejectedValueOnce(new Error(DRIVER))],
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

// ============================================================
// The protection values the product stores (the Data Protection section, the entity's retention policy), and the queries that filter on them
// ============================================================

// (The describes above clear the mocks in their own beforeEach; these read the calls of a mock, so they clear it for every test of the file.)
beforeEach(() => {
  vi.clearAllMocks();
});

const PERIOD_2_YEARS = { strategy: "age-based", period: 2, periodUnit: "years", referenceField: "created_at", action: "delete" };
const SIX_MONTHS = { strategy: "age-based", period: 6, periodUnit: "months", referenceField: "created_at", action: "delete" };
const PAGE = { page: 1, pageSize: 25, sortBy: "entityName", sortOrder: "asc" } as const;

/** The entity of a field, with the metadata the retention page stores on it. */
const entityWith = (metadata: Record<string, unknown>) => ({
  id: "ent-1",
  name: "Customer",
  slug: "customer",
  metadata,
  domain: { id: "dom-1", name: "Commerce", slug: "commerce" },
  product: { slug: "orders" },
});

/**
 * Answers the field queries as the database would for these rows: the read of a page (`where.id.in`) gets the rows named, in the order the
 * database returns them (reversed here, so that a service that trusts that order is caught); a protection filter's read of the candidates
 * (`select`) gets their id, decorators and entity id only; every other read gets all the rows. The entities are the rows' entities, once each.
 */
function mockFieldRows(rows: Array<Record<string, unknown>>, options: { reversePages?: boolean } = {}) {
  vi.mocked(prisma.field.count).mockResolvedValue(rows.length);
  vi.mocked(prisma.field.findMany).mockImplementation((async (args: { where?: { id?: { in?: string[] } }; select?: unknown }) => {
    const ids = args.where?.id?.in;
    if (!ids) {
      if (args.select === undefined) return rows;
      return rows.map((row) => ({ id: row.id, decorators: row.decorators, entityId: (row.entity as { id: string }).id }));
    }
    const wanted = new Set(ids);
    const found = rows.filter((row) => wanted.has(row.id as string));
    return options.reversePages ? found.reverse() : found;
  }) as never);
  const entities = new Map(rows.map((row) => [(row.entity as { id: string }).id, { id: (row.entity as { id: string }).id, metadata: (row.entity as { metadata: unknown }).metadata }]));
  vi.mocked(prisma.entity.findMany).mockResolvedValue([...entities.values()] as never);
}

const idsOf = (result: Awaited<ReturnType<typeof queryFields>>) => (result.success ? result.data.fields.map((field) => field.fieldId) : []);

describe("protection values: the keys the product writes", () => {
  it("queryFields shows the anonymization and encryption the Data Protection section stored, and the retention of the entity", async () => {
    mockFieldRows([
      makeField({
        classification: "PII",
        decorators: { typespec: { governance: { anonymization: "hash", encryption: "AES-256" } } },
        entity: entityWith({ retentionPolicy: PERIOD_2_YEARS }),
      }),
    ]);

    const result = await queryFields({}, PAGE, mockCtx);

    expect(result.success && result.data.fields[0]).toMatchObject({
      anonymization: "hash",
      encryption: "AES-256",
      retention: "Delete after 2 years (created_at)",
    });
  });

  it("the @anonymization of a TypeSpec source (decorators.governance, written by the sync) is the field's anonymization: no gap, and the column shows it", async () => {
    mockFieldRows([makeField({ classification: "PII", decorators: { governance: { anonymization: "hash" } }, entity: entityWith({ retentionPolicy: PERIOD_2_YEARS }) })]);

    const query = await queryFields({ anonymization: "hash" }, PAGE, mockCtx);
    expect(query.success && query.data.fields.map((field) => field.anonymization)).toEqual(["hash"]);

    vi.mocked(prisma.field.findMany).mockResolvedValue([
      makeField({ classification: "PII", decorators: { governance: { anonymization: "hash" } }, entity: entityWith({ retentionPolicy: PERIOD_2_YEARS }) }),
    ] as never);
    const gaps = await detectGaps({}, mockCtx);
    expect(gaps.success && gaps.data.gaps).toEqual([]);
  });

  it("detectGaps: a PII field the panel gave an anonymization, in an entity with a retention policy, has no gap", async () => {
    vi.mocked(prisma.field.findMany).mockResolvedValue([
      makeField({
        classification: "PII",
        decorators: { typespec: { governance: { anonymization: "mask" } } },
        entity: entityWith({ retentionPolicy: PERIOD_2_YEARS }),
      }),
    ] as never);

    const result = await detectGaps({}, mockCtx);

    expect(result.success && result.data.gaps).toEqual([]);
  });

  it("detectGaps: the panel's none is a gap, and so is a field of an entity with no retention policy", async () => {
    vi.mocked(prisma.field.findMany).mockResolvedValue([
      makeField({
        classification: "PII",
        decorators: { typespec: { governance: { anonymization: null } } },
        entity: entityWith({}),
      }),
      makeField({
        id: "fld-2",
        classification: "SENSITIVE",
        decorators: { typespec: { governance: { encryption: "field-level" } } },
        entity: entityWith({}),
      }),
    ] as never);

    const result = await detectGaps({}, mockCtx);

    expect(result.success && result.data.gaps.map((gap) => `${gap.fieldId}:${gap.gapType}`).sort()).toEqual([
      "fld-1:NO_RETENTION",
      "fld-1:PII_NO_ANONYMIZATION",
      "fld-2:NO_RETENTION",
    ]);
  });

  it("the anonymization filter matches the stored value, and none matches the fields with no value", async () => {
    mockFieldRows([
      makeField({ id: "fld-1", decorators: { typespec: { governance: { anonymization: "hash" } } } }),
      makeField({ id: "fld-2", decorators: { typespec: { governance: { anonymization: null } } } }),
      makeField({ id: "fld-3", decorators: {} }),
      makeField({ id: "fld-4", decorators: { typespec: { governance: { anonymization: "mask" } } } }),
    ]);

    expect(idsOf(await queryFields({ anonymization: "hash" }, PAGE, mockCtx))).toEqual(["fld-1"]);
    expect(idsOf(await queryFields({ anonymization: "none" }, PAGE, mockCtx))).toEqual(["fld-2", "fld-3"]);
  });

  it("the encryption filter matches the method under the enum's name (AES-256)", async () => {
    mockFieldRows([
      makeField({ id: "fld-1", decorators: { typespec: { governance: { encryption: "AES-256" } } } }),
      makeField({ id: "fld-2", decorators: { typespec: { governance: { encryption: "field-level" } } } }),
    ]);

    expect(idsOf(await queryFields({ encryption: "AES-256" }, PAGE, mockCtx))).toEqual(["fld-1"]);
  });

  it("the retention filter reads the entity's policy: 6 months is under a year, 2 years is in 1-3, indefinite is in no range", async () => {
    mockFieldRows([
      makeField({ id: "short", entity: { ...entityWith({ retentionPolicy: SIX_MONTHS }), id: "ent-short" } }),
      makeField({ id: "two", entity: { ...entityWith({ retentionPolicy: PERIOD_2_YEARS }), id: "ent-two" } }),
      makeField({ id: "forever", entity: { ...entityWith({ retentionPolicy: { strategy: "indefinite", action: "notify-only" } }), id: "ent-forever" } }),
      makeField({ id: "none", entity: { ...entityWith({}), id: "ent-none" } }),
    ]);

    expect(idsOf(await queryFields({ retention: "lt_1_year" }, PAGE, mockCtx))).toEqual(["short"]);
    expect(idsOf(await queryFields({ retention: "1_to_3_years" }, PAGE, mockCtx))).toEqual(["two"]);
    expect(idsOf(await queryFields({ retention: "gt_7_years" }, PAGE, mockCtx))).toEqual([]);
  });
});

describe("a protection filter is applied before the page is cut", () => {
  // Sixty fields, each in its own entity; the 3rd, the 10th and the 40th are in an entity that keeps its data six months.
  const rows = Array.from({ length: 60 }, (_, i) =>
    makeField({
      id: `fld-${i}`,
      name: `field_${i}`,
      entity: { ...entityWith(i === 2 || i === 9 || i === 39 ? { retentionPolicy: SIX_MONTHS } : {}), id: `ent-${i}` },
    })
  );

  it("total is the number of matching fields, and every page holds matching fields only", async () => {
    mockFieldRows(rows);
    const sort = { page: 1, pageSize: 2, sortBy: "entityName", sortOrder: "asc" } as const;

    const first = await queryFields({ retention: "lt_1_year" }, sort, mockCtx);
    const second = await queryFields({ retention: "lt_1_year" }, { ...sort, page: 2 }, mockCtx);
    const third = await queryFields({ retention: "lt_1_year" }, { ...sort, page: 3 }, mockCtx);
    const past = await queryFields({ retention: "lt_1_year" }, { ...sort, page: 9 }, mockCtx);

    expect(first.success && first.data.total).toBe(3);
    expect(idsOf(first)).toEqual(["fld-2", "fld-9"]);
    expect(idsOf(second)).toEqual(["fld-39"]);
    expect(idsOf(third)).toEqual([]);
    expect(idsOf(past)).toEqual([]);
    expect(past.success && past.data.total).toBe(3);
  });

  it("the rows of a page come in the order of the sort, whatever order the database hands the page back in", async () => {
    mockFieldRows(rows, { reversePages: true });

    const result = await queryFields({ retention: "lt_1_year" }, { ...PAGE, pageSize: 25 }, mockCtx);

    expect(idsOf(result)).toEqual(["fld-2", "fld-9", "fld-39"]);
  });

  it("the protection filter is judged on the stored values and leaves the database's own filters in the query", async () => {
    mockFieldRows(rows);
    await queryFields({ retention: "lt_1_year", classifications: ["PII"] }, PAGE, mockCtx);
    const candidateRead = vi.mocked(prisma.field.findMany).mock.calls[0][0] as { where: unknown; select?: unknown };
    expect(candidateRead.where).toEqual(classificationWhere(["PII"]));
    // the candidates carry their values and their entity's id: the entity's metadata is read once per entity, apart
    expect(candidateRead.select).toEqual({ id: true, decorators: true, entityId: true });
  });

  it("each entity's metadata is read once, for the entities in the scope of the fields (not once per field)", async () => {
    mockFieldRows(rows);
    await queryFields({ retention: "lt_1_year" }, PAGE, { ...mockCtx, tenantId: "tenant-a" });
    expect(prisma.entity.findMany).toHaveBeenCalledTimes(1);
    expect(vi.mocked(prisma.entity.findMany).mock.calls[0][0]).toEqual({ where: { tenantId: "tenant-a" }, select: { id: true, metadata: true } });
  });
});

describe("exportFields: every field the filters select, not the page on the screen", () => {
  it("exports all the matching fields, with the same sort the list uses (and the list's access)", async () => {
    const rows = Array.from({ length: 300 }, (_, i) => makeField({ id: `fld-${i}`, name: `field_${i}` }));
    mockFieldRows(rows);

    const result = await exportFields({}, { sortBy: "fieldName", sortOrder: "desc" }, mockCtx);

    expect(result.success && result.data.fields).toHaveLength(300);
    expect(result.success && result.data).toMatchObject({ total: 300, truncated: false });
    expect(vi.mocked(prisma.field.findMany).mock.calls[0][0]).toMatchObject({ take: MAX_EXPORT_ROWS, orderBy: [{ name: "desc" }, { id: "asc" }] });
  });

  it("exports every match of a protection filter, not only the ones in the first page", async () => {
    const rows = Array.from({ length: 500 }, (_, i) =>
      makeField({ id: `fld-${i}`, entity: { ...entityWith(i % 4 === 0 ? { retentionPolicy: SIX_MONTHS } : {}), id: `ent-${i}` } })
    );
    mockFieldRows(rows);

    const result = await exportFields({ retention: "lt_1_year" }, undefined, mockCtx);

    expect(result.success && result.data.fields).toHaveLength(125);
    expect(result.success && result.data.total).toBe(125);
  });

  it("stops at the documented cap and says so: the total is every match, the rows are the cap", async () => {
    vi.mocked(prisma.field.count).mockResolvedValue(MAX_EXPORT_ROWS + 5);
    vi.mocked(prisma.field.findMany).mockResolvedValue(Array.from({ length: MAX_EXPORT_ROWS }, (_, i) => makeField({ id: `fld-${i}` })) as never);

    const result = await exportFields({}, undefined, mockCtx);

    expect(result.success && result.data).toMatchObject({ total: MAX_EXPORT_ROWS + 5, truncated: true });
    expect(result.success && result.data.fields).toHaveLength(MAX_EXPORT_ROWS);
  });

  it("stops at the cap with a protection filter as well: the total is every match, the rows the first ones of the sort, and it is said", async () => {
    const matches = MAX_EXPORT_ROWS + 3;
    const rows = Array.from({ length: matches + 5 }, (_, i) =>
      makeField({ id: `fld-${i}`, entity: { ...entityWith(i < matches ? { retentionPolicy: SIX_MONTHS } : {}), id: `ent-${i}` } })
    );
    mockFieldRows(rows);

    const result = await exportFields({ retention: "lt_1_year" }, undefined, mockCtx);

    expect(result.success && result.data).toMatchObject({ total: matches, truncated: true });
    expect(result.success && result.data.fields).toHaveLength(MAX_EXPORT_ROWS);
    expect(result.success && result.data.fields[0].fieldId).toBe("fld-0");
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ afterState: expect.objectContaining({ rows: MAX_EXPORT_ROWS, total: matches, truncated: true }) }) })
    );
  });

  it("is refused to a role that does not read the list, and reads nothing", async () => {
    const result = await exportFields({}, undefined, unauthorizedCtx);
    expect(result.success).toBe(false);
    expect(prisma.field.findMany).not.toHaveBeenCalled();
  });

  it("writes a compliance.export audit entry, in the tenant the export was made in, with what was exported", async () => {
    mockFieldRows([makeField()]);

    await exportFields({ classifications: ["PII"] }, undefined, { ...mockCtx, tenantId: "tenant-a" });

    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "compliance.export",
          entityType: "Compliance",
          entityId: "fields",
          userId: "user-1",
          tenantId: "tenant-a",
          afterState: expect.objectContaining({ rows: 1, total: 1, truncated: false }),
        }),
      })
    );
  });

  it("an export that cannot be audited is not handed out", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mockFieldRows([makeField()]);
    vi.mocked(prisma.auditLog.create).mockRejectedValueOnce(new Error("audit write failed"));

    const result = await exportFields({}, undefined, mockCtx);

    expect(result.success).toBe(false);
    spy.mockRestore();
  });
});

describe("the audit trail's date range and its export", () => {
  const where = () => vi.mocked(prisma.auditLog.findMany).mock.calls.at(-1)?.[0]?.where;

  beforeEach(() => {
    vi.mocked(prisma.auditLog.count).mockResolvedValue(0);
    vi.mocked(prisma.auditLog.findMany).mockResolvedValue([]);
  });

  it("from is inclusive and to is exclusive: the day is whole when to is the start of the next day", async () => {
    const from = new Date(2026, 9, 1);
    const nextDay = new Date(2026, 10, 1);
    await queryAuditTrail({ dateRange: { from, to: nextDay } }, { page: 1, pageSize: 50 }, mockCtx);
    expect(where()).toMatchObject({ timestamp: { gte: from, lt: nextDay } });
  });

  it("from alone is a lower bound and to alone an upper bound: neither is invented", async () => {
    const from = new Date(2026, 9, 1);
    const to = new Date(2026, 10, 1);
    await queryAuditTrail({ dateRange: { from } }, { page: 1, pageSize: 50 }, mockCtx);
    expect(where()).toMatchObject({ timestamp: { gte: from } });
    expect(JSON.stringify(where())).not.toContain('"lt"');
    await queryAuditTrail({ dateRange: { to } }, { page: 1, pageSize: 50 }, mockCtx);
    expect(where()).toMatchObject({ timestamp: { lt: to } });
    expect(JSON.stringify(where())).not.toContain('"gte"');
  });

  it("exports every row of the filter up to the cap, with the total, and says when the cap is hit", async () => {
    vi.mocked(prisma.auditLog.count).mockResolvedValue(MAX_EXPORT_ROWS + 1);
    vi.mocked(prisma.auditLog.findMany).mockResolvedValue(
      Array.from({ length: MAX_EXPORT_ROWS }, (_, i) => ({ id: `al-${i}`, action: "UPDATE", entityType: "Field", entityId: "f", userId: "u", timestamp: new Date(0), beforeState: null, afterState: {}, user: null })) as never
    );

    const result = await exportAuditTrail({}, mockCtx);

    expect(vi.mocked(prisma.auditLog.findMany).mock.calls.at(-1)?.[0]).toMatchObject({ take: MAX_EXPORT_ROWS });
    expect(result.success && result.data).toMatchObject({ total: MAX_EXPORT_ROWS + 1, truncated: true });
    expect(result.success && result.data.entries).toHaveLength(MAX_EXPORT_ROWS);
    // the file's columns only: the states of 10,000 entries are not carried
    expect(result.success && Object.keys(result.data.entries[0]).sort()).toEqual(["action", "changeSummary", "entityId", "entityType", "timestamp", "userName"]);
  });

  it("writes a compliance.export audit entry for the export of the audit trail", async () => {
    await exportAuditTrail({ actionTypes: ["CREATE"] }, officerOfTenant("tenant-a"));
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: "compliance.export", entityType: "Compliance", entityId: "audit-trail", tenantId: "tenant-a" }) })
    );
  });
});

function officerOfTenant(tenantId: string): ServiceContext {
  return { ...mockCtx, userRole: "COMPLIANCE_OFFICER", assignments: [assign.tenant("COMPLIANCE_OFFICER", tenantId)], tenantId };
}

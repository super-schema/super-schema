import { describe, it, expect, beforeEach, vi } from "vitest";

// ---------------------------------------------------------------------------
// In-memory stores to simulate Prisma behavior
// ---------------------------------------------------------------------------

let overrideRows: Array<{
  id: string;
  sourceType: string;
  targetFormat: string;
  mappedType: string;
  isLossy: boolean;
  lossDescription: string | null;
  justification: string | null;
  approvedBy: string | null;
  entityId: string | null;
  createdAt: Date;
  updatedAt: Date;
}> = [];

let nextId = 1;

vi.mock("@/lib/db", () => ({
  prisma: {
    typeMappingOverride: {
      findMany: vi.fn().mockImplementation(async (args?: { where?: { targetFormat?: string; OR?: Array<{ entityId: string | null }> } }) => {
        if (!args?.where) return overrideRows;
        if (args.where.targetFormat) {
          return overrideRows.filter((r) => r.targetFormat === args.where!.targetFormat);
        }
        if (args.where.OR) {
          return overrideRows.filter((r) =>
            args.where!.OR!.some((cond) => {
              if (cond.entityId === null) return r.entityId === null;
              return r.entityId === cond.entityId;
            })
          );
        }
        return overrideRows;
      }),
      upsert: vi.fn().mockImplementation(async (args: {
        where: { sourceType_targetFormat_entityId: { sourceType: string; targetFormat: string; entityId: string | null } };
        create: Record<string, unknown>;
        update: Record<string, unknown>;
      }) => {
        const { sourceType, targetFormat, entityId } = args.where.sourceType_targetFormat_entityId;
        const existingIndex = overrideRows.findIndex(
          (r) => r.sourceType === sourceType && r.targetFormat === targetFormat && r.entityId === entityId
        );
        if (existingIndex >= 0) {
          overrideRows[existingIndex] = {
            ...overrideRows[existingIndex],
            ...(args.update as Record<string, unknown>),
            updatedAt: new Date(),
          } as typeof overrideRows[0];
          return overrideRows[existingIndex];
        }
        const row = {
          id: `override-${nextId++}`,
          ...(args.create as Record<string, unknown>),
          createdAt: new Date(),
          updatedAt: new Date(),
        } as typeof overrideRows[0];
        overrideRows.push(row);
        return row;
      }),
      delete: vi.fn().mockImplementation(async (args: {
        where: { sourceType_targetFormat_entityId: { sourceType: string; targetFormat: string; entityId: string | null } };
      }) => {
        const { sourceType, targetFormat, entityId } = args.where.sourceType_targetFormat_entityId;
        const index = overrideRows.findIndex(
          (r) => r.sourceType === sourceType && r.targetFormat === targetFormat && r.entityId === entityId
        );
        if (index === -1) {
          throw new Error("Record not found");
        }
        const deleted = overrideRows[index];
        overrideRows.splice(index, 1);
        return deleted;
      }),
    },
    lossyMappingAck: {
      upsert: vi.fn().mockResolvedValue({}),
      count: vi.fn().mockResolvedValue(0),
    },
  },
}));

import {
  getMappingsForTarget,
  getAllMappings,
  createOverride,
  deleteOverride,
  _resetOverrideStore,
} from "@/services/type-mapping.service";
import { prisma } from "@/lib/db";
import type { ServiceContext } from "@/types/service-context";

// ---------------------------------------------------------------------------
// Mock contexts
// ---------------------------------------------------------------------------

const adminCtx: ServiceContext = {
  userId: "admin-1",
  userRole: "ADMIN",
  prisma: {} as ServiceContext["prisma"],
};

const stewardCtx: ServiceContext = {
  userId: "steward-1",
  userRole: "STEWARD",
  prisma: {} as ServiceContext["prisma"],
};

const authorCtx: ServiceContext = {
  userId: "author-1",
  userRole: "AUTHOR",
  prisma: {} as ServiceContext["prisma"],
};

const viewerCtx: ServiceContext = {
  userId: "viewer-1",
  userRole: "VIEWER",
  prisma: {} as ServiceContext["prisma"],
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Type Mapping Service", () => {
  beforeEach(() => {
    overrideRows = [];
    nextId = 1;
    vi.clearAllMocks();
    _resetOverrideStore();
  });

  // -------------------------------------------------------------------------
  // getMappingsForTarget
  // -------------------------------------------------------------------------

  describe("getMappingsForTarget", () => {
    it("returns all default policies for bigquery", async () => {
      const result = await getMappingsForTarget("bigquery", adminCtx);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.length).toBeGreaterThan(0);
        expect(
          result.data.every((p) => p.targetFormat === "bigquery")
        ).toBe(true);
      }
    });

    it("returns all default policies for avro", async () => {
      const result = await getMappingsForTarget("avro", adminCtx);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.length).toBeGreaterThan(0);
        expect(
          result.data.every((p) => p.targetFormat === "avro")
        ).toBe(true);
      }
    });

    it("returns all default policies for openapi", async () => {
      const result = await getMappingsForTarget("openapi", adminCtx);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.length).toBeGreaterThan(0);
        expect(
          result.data.every((p) => p.targetFormat === "openapi")
        ).toBe(true);
      }
    });

    it("returns empty array for unknown target", async () => {
      const result = await getMappingsForTarget("snowflake", adminCtx);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toHaveLength(0);
      }
    });

    it("includes overrides alongside defaults", async () => {
      await createOverride(
        {
          sourceType: "string",
          targetFormat: "bigquery",
          mappedType: "BYTES",
          isLossy: false,
        },
        adminCtx
      );

      const result = await getMappingsForTarget("bigquery", adminCtx);
      expect(result.success).toBe(true);
      if (result.success) {
        const overrides = result.data.filter((p) => p.isOverride);
        expect(overrides.length).toBeGreaterThanOrEqual(1);
        expect(overrides.some((p) => p.mappedType === "BYTES")).toBe(true);
      }
    });
  });

  // -------------------------------------------------------------------------
  // getAllMappings
  // -------------------------------------------------------------------------

  describe("getAllMappings", () => {
    it("returns all default policies", async () => {
      const result = await getAllMappings(adminCtx);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.length).toBeGreaterThan(0);
      }
    });
  });

  // -------------------------------------------------------------------------
  // createOverride — RBAC
  // -------------------------------------------------------------------------

  describe("createOverride RBAC", () => {
    const overrideInput = {
      sourceType: "string",
      targetFormat: "bigquery",
      mappedType: "BYTES",
      isLossy: false,
    };

    it("allows Admin to create override", async () => {
      const result = await createOverride(overrideInput, adminCtx);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.isOverride).toBe(true);
        expect(result.data.approvedBy).toBe("admin-1");
      }
    });

    it("allows Steward to create override", async () => {
      const result = await createOverride(overrideInput, stewardCtx);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.isOverride).toBe(true);
        expect(result.data.approvedBy).toBe("steward-1");
      }
    });

    it("denies Author from creating global override", async () => {
      const result = await createOverride(overrideInput, authorCtx);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe("PERMISSION_DENIED");
        expect(result.error.suggestedFix).toContain("AUTHOR");
      }
    });

    it("denies Viewer from creating override", async () => {
      const result = await createOverride(overrideInput, viewerCtx);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe("PERMISSION_DENIED");
      }
    });
  });

  // -------------------------------------------------------------------------
  // createOverride — behavior
  // -------------------------------------------------------------------------

  describe("createOverride behavior", () => {
    it("sets isOverride to true", async () => {
      const result = await createOverride(
        {
          sourceType: "integer",
          targetFormat: "bigquery",
          mappedType: "FLOAT64",
          isLossy: true,
          lossDescription: "Precision reduced to float64",
        },
        adminCtx
      );

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.isOverride).toBe(true);
        expect(result.data.mappedType).toBe("FLOAT64");
        expect(result.data.isLossy).toBe(true);
        expect(result.data.lossDescription).toContain("float64");
      }
    });

    it("sets approvedBy to the current user", async () => {
      const result = await createOverride(
        {
          sourceType: "string",
          targetFormat: "openapi",
          mappedType: "string/byte",
          isLossy: false,
        },
        stewardCtx
      );

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.approvedBy).toBe("steward-1");
      }
    });

    it("supports per-entity override scope", async () => {
      const result = await createOverride(
        {
          sourceType: "string",
          targetFormat: "bigquery",
          mappedType: "BYTES",
          isLossy: false,
          entityId: "entity-123",
        },
        adminCtx
      );

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.entityId).toBe("entity-123");
      }
    });

    it("replaces existing override for same source+target+entity", async () => {
      await createOverride(
        {
          sourceType: "string",
          targetFormat: "bigquery",
          mappedType: "BYTES",
          isLossy: false,
        },
        adminCtx
      );

      await createOverride(
        {
          sourceType: "string",
          targetFormat: "bigquery",
          mappedType: "JSON",
          isLossy: false,
        },
        adminCtx
      );

      const all = await getMappingsForTarget("bigquery", adminCtx);
      if (all.success) {
        const overrides = all.data.filter(
          (p) => p.isOverride && p.sourceType === "string"
        );
        expect(overrides).toHaveLength(1);
        expect(overrides[0].mappedType).toBe("JSON");
      }
    });

    it("returns validation error for missing fields", async () => {
      const result = await createOverride(
        {
          sourceType: "",
          targetFormat: "bigquery",
          mappedType: "BYTES",
          isLossy: false,
        },
        adminCtx
      );

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe("VALIDATION_ERROR");
      }
    });
  });

  // -------------------------------------------------------------------------
  // deleteOverride
  // -------------------------------------------------------------------------

  describe("deleteOverride", () => {
    it("deletes an existing override", async () => {
      await createOverride(
        {
          sourceType: "string",
          targetFormat: "bigquery",
          mappedType: "BYTES",
          isLossy: false,
        },
        adminCtx
      );

      const result = await deleteOverride("string", "bigquery", adminCtx);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.deleted).toBe(true);
      }

      const mappings = await getMappingsForTarget("bigquery", adminCtx);
      if (mappings.success) {
        const overrides = mappings.data.filter(
          (p) => p.isOverride && p.sourceType === "string"
        );
        expect(overrides).toHaveLength(0);
      }
    });

    it("returns false when no override exists to delete", async () => {
      const result = await deleteOverride(
        "nonexistent",
        "bigquery",
        adminCtx
      );
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.deleted).toBe(false);
      }
    });

    it("denies Author from deleting override", async () => {
      const result = await deleteOverride("string", "bigquery", authorCtx);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe("PERMISSION_DENIED");
      }
    });
  });
});

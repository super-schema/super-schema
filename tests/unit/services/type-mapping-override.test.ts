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

let ackRows: Array<{
  id: string;
  entityId: string;
  sourceType: string;
  targetFormat: string;
  userId: string;
  acknowledgedAt: Date;
}> = [];

let nextId = 1;

vi.mock("@/lib/db", () => ({
  prisma: {
    typeMappingOverride: {
      findMany: vi.fn().mockImplementation(async (args?: { where?: Record<string, unknown> }) => {
        if (!args?.where) return overrideRows;
        if (args.where.targetFormat) {
          return overrideRows.filter((r) => r.targetFormat === args.where!.targetFormat);
        }
        if (args.where.OR) {
          const conditions = args.where.OR as Array<{ entityId: string | null }>;
          return overrideRows.filter((r) =>
            conditions.some((cond) => {
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
        if (index === -1) throw new Error("Record not found");
        const deleted = overrideRows[index];
        overrideRows.splice(index, 1);
        return deleted;
      }),
    },
    // Where the entity of a per-entity override lives (the service judges the caller's roles over it).
    entity: {
      findUnique: vi.fn().mockResolvedValue({ tenantId: "tenant-1", domainId: "dom-1", productId: null, product: null }),
      findMany: vi.fn().mockResolvedValue([]),
    },
    lossyMappingAck: {
      upsert: vi.fn().mockImplementation(async (args: {
        where: { entityId_sourceType_targetFormat_userId: { entityId: string; sourceType: string; targetFormat: string; userId: string } };
        create: Record<string, unknown>;
        update: Record<string, unknown>;
      }) => {
        const { entityId, sourceType, targetFormat, userId } = args.where.entityId_sourceType_targetFormat_userId;
        const existingIndex = ackRows.findIndex(
          (r) => r.entityId === entityId && r.sourceType === sourceType && r.targetFormat === targetFormat && r.userId === userId
        );
        if (existingIndex >= 0) {
          ackRows[existingIndex].acknowledgedAt = new Date();
          return ackRows[existingIndex];
        }
        const row = {
          id: `ack-${nextId++}`,
          entityId,
          sourceType,
          targetFormat,
          userId,
          acknowledgedAt: new Date(),
        };
        ackRows.push(row);
        return row;
      }),
      count: vi.fn().mockImplementation(async (args: { where: { entityId: string; sourceType: string; targetFormat: string } }) => {
        return ackRows.filter(
          (r) => r.entityId === args.where.entityId && r.sourceType === args.where.sourceType && r.targetFormat === args.where.targetFormat
        ).length;
      }),
    },
  },
}));

import {
  createOverride,
  createGlobalOverride,
  createEntityOverride,
  acknowledgeLossyMapping,
  isLossyMappingAcknowledged,
  getOverridesForEntity,
  _resetOverrideStore,
  getAllMappings,
} from "@/services/type-mapping.service";
import { resolveMapping } from "@/lib/type-mapping/mapping-engine";
import { getDefaultPolicies } from "@/lib/type-mapping/default-mappings";
import type { ServiceContext } from "@/types/service-context";
import { assign } from "../../helpers/access-mocks";

// ---------------------------------------------------------------------------
// Mock contexts
// ---------------------------------------------------------------------------

const adminCtx: ServiceContext = {
  userId: "admin-1",
  userRole: "ADMIN",
  assignments: [assign.global()],
  prisma: {} as ServiceContext["prisma"],
};

const stewardCtx: ServiceContext = {
  userId: "steward-1",
  userRole: "STEWARD",
  assignments: [assign.tenant("STEWARD", "tenant-1")],
  prisma: {} as ServiceContext["prisma"],
};

const authorCtx: ServiceContext = {
  userId: "author-1",
  userRole: "AUTHOR",
  assignments: [assign.tenant("AUTHOR", "tenant-1")],
  prisma: {} as ServiceContext["prisma"],
};

const viewerCtx: ServiceContext = {
  userId: "viewer-1",
  userRole: "VIEWER",
  assignments: [assign.tenant("VIEWER", "tenant-1")],
  prisma: {} as ServiceContext["prisma"],
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Type Mapping Override Governance", () => {
  beforeEach(() => {
    overrideRows = [];
    ackRows = [];
    nextId = 1;
    vi.clearAllMocks();
    _resetOverrideStore();
  });

  // -------------------------------------------------------------------------
  // Override precedence in resolveMapping()
  // -------------------------------------------------------------------------

  describe("Override precedence in resolveMapping", () => {
    it("override takes precedence over default mapping", async () => {
      const defaults = getDefaultPolicies();

      const defaultResult = resolveMapping("string", "bigquery", defaults);
      expect(defaultResult.success).toBe(true);
      if (defaultResult.success) {
        expect(defaultResult.result.mappedType).toBe("STRING");
        expect(defaultResult.result.isOverride).toBe(false);
      }

      await createOverride(
        {
          sourceType: "string",
          targetFormat: "bigquery",
          mappedType: "BYTES",
          isLossy: false,
        },
        adminCtx
      );

      const allMappings = await getAllMappings(adminCtx);
      expect(allMappings.success).toBe(true);
      if (!allMappings.success) return;

      const overrideResult = resolveMapping("string", "bigquery", allMappings.data);
      expect(overrideResult.success).toBe(true);
      if (overrideResult.success) {
        expect(overrideResult.result.mappedType).toBe("BYTES");
        expect(overrideResult.result.isOverride).toBe(true);
        expect(overrideResult.result.overrideSource).toBe("global");
      }
    });

    it("per-entity override takes precedence over global override", async () => {
      const entityId = "entity-abc";

      await createOverride(
        {
          sourceType: "decimal",
          targetFormat: "openapi",
          mappedType: "string",
          isLossy: false,
        },
        adminCtx
      );

      await createOverride(
        {
          sourceType: "decimal",
          targetFormat: "openapi",
          mappedType: "integer/int64",
          isLossy: true,
          lossDescription: "Decimal to integer loses fractional part",
          entityId,
        },
        adminCtx
      );

      const allMappings = await getAllMappings(adminCtx);
      if (!allMappings.success) return;

      const globalResult = resolveMapping(
        "decimal",
        "openapi",
        allMappings.data
      );
      expect(globalResult.success).toBe(true);
      if (globalResult.success) {
        expect(globalResult.result.mappedType).toBe("string");
        expect(globalResult.result.isOverride).toBe(true);
        expect(globalResult.result.overrideSource).toBe("global");
      }

      const entityResult = resolveMapping(
        "decimal",
        "openapi",
        allMappings.data,
        entityId
      );
      expect(entityResult.success).toBe(true);
      if (entityResult.success) {
        expect(entityResult.result.mappedType).toBe("integer/int64");
        expect(entityResult.result.isOverride).toBe(true);
        expect(entityResult.result.overrideSource).toBe("per-entity");
      }
    });

    it("default mapping used when no override exists for entity", async () => {
      const entityId = "entity-no-override";

      await createOverride(
        {
          sourceType: "integer",
          targetFormat: "bigquery",
          mappedType: "INT32",
          isLossy: true,
        },
        adminCtx
      );

      const allMappings = await getAllMappings(adminCtx);
      if (!allMappings.success) return;

      const result = resolveMapping(
        "string",
        "bigquery",
        allMappings.data,
        entityId
      );
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.result.mappedType).toBe("STRING");
        expect(result.result.isOverride).toBe(false);
        expect(result.result.overrideSource).toBeUndefined();
      }
    });
  });

  // -------------------------------------------------------------------------
  // RBAC enforcement
  // -------------------------------------------------------------------------

  describe("RBAC enforcement", () => {
    it("a tenant Steward cannot create a global override (it changes every tenant's mapping: a platform administrator's act)", async () => {
      const result = await createGlobalOverride(
        {
          sourceType: "string",
          targetFormat: "bigquery",
          mappedType: "BYTES",
          isLossy: false,
          justification: "Need BYTES for binary data",
        },
        stewardCtx
      );
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.code).toBe("PERMISSION_DENIED");
    });

    it("Admin can create global override", async () => {
      const result = await createGlobalOverride(
        {
          sourceType: "string",
          targetFormat: "bigquery",
          mappedType: "BYTES",
          isLossy: false,
          justification: "Admin override",
        },
        adminCtx
      );
      expect(result.success).toBe(true);
    });

    it("Author cannot create global override", async () => {
      const result = await createGlobalOverride(
        {
          sourceType: "string",
          targetFormat: "bigquery",
          mappedType: "BYTES",
          isLossy: false,
          justification: "Author attempt",
        },
        authorCtx
      );
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe("PERMISSION_DENIED");
      }
    });

    it("Author can create per-entity override", async () => {
      const result = await createEntityOverride(
        {
          sourceType: "string",
          targetFormat: "bigquery",
          mappedType: "BYTES",
          isLossy: false,
          justification: "Entity-specific need",
          entityId: "entity-123",
        },
        authorCtx
      );
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.entityId).toBe("entity-123");
        expect(result.data.approvedBy).toBe("author-1");
      }
    });

    it("Viewer cannot create any override", async () => {
      const globalResult = await createGlobalOverride(
        {
          sourceType: "string",
          targetFormat: "bigquery",
          mappedType: "BYTES",
          isLossy: false,
          justification: "Viewer attempt",
        },
        viewerCtx
      );
      expect(globalResult.success).toBe(false);
      if (!globalResult.success) {
        expect(globalResult.error.code).toBe("PERMISSION_DENIED");
      }

      const entityResult = await createEntityOverride(
        {
          sourceType: "string",
          targetFormat: "bigquery",
          mappedType: "BYTES",
          isLossy: false,
          justification: "Viewer attempt",
          entityId: "entity-123",
        },
        viewerCtx
      );
      expect(entityResult.success).toBe(false);
      if (!entityResult.success) {
        expect(entityResult.error.code).toBe("PERMISSION_DENIED");
      }
    });

    it("Viewer cannot acknowledge lossy mapping", async () => {
      const result = await acknowledgeLossyMapping(
        {
          entityId: "entity-123",
          sourceType: "decimal",
          targetFormat: "openapi",
        },
        viewerCtx
      );
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe("PERMISSION_DENIED");
      }
    });
  });

  // -------------------------------------------------------------------------
  // Justification requirement
  // -------------------------------------------------------------------------

  describe("Justification requirement", () => {
    it("global override requires justification", async () => {
      const result = await createGlobalOverride(
        {
          sourceType: "string",
          targetFormat: "bigquery",
          mappedType: "BYTES",
          isLossy: false,
          justification: "",
        },
        adminCtx
      );
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe("VALIDATION_ERROR");
        expect(result.error.message).toContain("Justification");
      }
    });

    it("per-entity override requires justification", async () => {
      const result = await createEntityOverride(
        {
          sourceType: "string",
          targetFormat: "bigquery",
          mappedType: "BYTES",
          isLossy: false,
          justification: "  ",
          entityId: "entity-123",
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
  // Target type validation
  // -------------------------------------------------------------------------

  describe("Target type validation", () => {
    it("rejects invalid mapped type for target format", async () => {
      const result = await createOverride(
        {
          sourceType: "string",
          targetFormat: "bigquery",
          mappedType: "INVALID_TYPE_XYZ",
          isLossy: false,
        },
        adminCtx
      );
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe("VALIDATION_ERROR");
        expect(result.error.message).toContain("INVALID_TYPE_XYZ");
      }
    });

    it("accepts valid mapped type for target format", async () => {
      const result = await createOverride(
        {
          sourceType: "string",
          targetFormat: "bigquery",
          mappedType: "BYTES",
          isLossy: false,
        },
        adminCtx
      );
      expect(result.success).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Acknowledge lossy mapping
  // -------------------------------------------------------------------------

  describe("Acknowledge lossy mapping", () => {
    it("marks a lossy mapping as acknowledged", async () => {
      const entityId = "entity-ack";

      expect(
        await isLossyMappingAcknowledged(entityId, "decimal", "openapi")
      ).toBe(false);

      const result = await acknowledgeLossyMapping(
        {
          entityId,
          sourceType: "decimal",
          targetFormat: "openapi",
        },
        authorCtx
      );
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.acknowledged).toBe(true);
      }

      expect(
        await isLossyMappingAcknowledged(entityId, "decimal", "openapi")
      ).toBe(true);
    });

    it("Author can acknowledge lossy mapping", async () => {
      const result = await acknowledgeLossyMapping(
        {
          entityId: "entity-ack",
          sourceType: "decimal",
          targetFormat: "openapi",
        },
        authorCtx
      );
      expect(result.success).toBe(true);
    });

    it("acknowledgment is entity-specific", async () => {
      await acknowledgeLossyMapping(
        {
          entityId: "entity-1",
          sourceType: "decimal",
          targetFormat: "openapi",
        },
        authorCtx
      );

      expect(await isLossyMappingAcknowledged("entity-1", "decimal", "openapi")).toBe(true);
      expect(await isLossyMappingAcknowledged("entity-2", "decimal", "openapi")).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // getOverridesForEntity
  // -------------------------------------------------------------------------

  describe("getOverridesForEntity", () => {
    it("returns both entity-specific and global overrides", async () => {
      const entityId = "entity-get";

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
          sourceType: "integer",
          targetFormat: "bigquery",
          mappedType: "INT64",
          isLossy: false,
          entityId,
        },
        adminCtx
      );

      // Override for a different entity
      await createOverride(
        {
          sourceType: "boolean",
          targetFormat: "bigquery",
          mappedType: "STRING",
          isLossy: true,
          entityId: "other-entity",
        },
        adminCtx
      );

      const result = await getOverridesForEntity(entityId, adminCtx);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.length).toBe(2);
        const sources = result.data.map((p) => p.sourceType).sort();
        expect(sources).toEqual(["integer", "string"]);
      }
    });
  });

  // -------------------------------------------------------------------------
  // Justification is stored
  // -------------------------------------------------------------------------

  describe("Override stores justification", () => {
    it("stores justification in the policy", async () => {
      const result = await createEntityOverride(
        {
          sourceType: "string",
          targetFormat: "bigquery",
          mappedType: "BYTES",
          isLossy: false,
          justification: "Binary data stored in this field",
          entityId: "entity-just",
        },
        stewardCtx
      );
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.justification).toBe("Binary data stored in this field");
      }
    });
  });
});

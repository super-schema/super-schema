import { describe, it, expect, beforeEach } from "vitest";
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
import type { ScopedMappingPolicy } from "@/lib/type-mapping/types";

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

describe("Type Mapping Override Governance", () => {
  beforeEach(() => {
    _resetOverrideStore();
  });

  // -------------------------------------------------------------------------
  // Override precedence in resolveMapping()
  // -------------------------------------------------------------------------

  describe("Override precedence in resolveMapping", () => {
    it("override takes precedence over default mapping", async () => {
      const defaults = getDefaultPolicies();

      // Default: string -> bigquery = STRING
      const defaultResult = resolveMapping("string", "bigquery", defaults);
      expect(defaultResult.success).toBe(true);
      if (defaultResult.success) {
        expect(defaultResult.result.mappedType).toBe("STRING");
        expect(defaultResult.result.isOverride).toBe(false);
      }

      // Create a global override
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

      // Create a global override
      await createOverride(
        {
          sourceType: "decimal",
          targetFormat: "openapi",
          mappedType: "string",
          isLossy: false,
        },
        adminCtx
      );

      // Create a per-entity override
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

      // Without entityId, should get global override
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

      // With entityId, should get per-entity override
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

      // Create a global override for a different type
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

      // string -> bigquery should still use default (no override for string)
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
    it("Steward can create global override", async () => {
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
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.approvedBy).toBe("steward-1");
      }
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
        isLossyMappingAcknowledged(entityId, "decimal", "openapi")
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
        isLossyMappingAcknowledged(entityId, "decimal", "openapi")
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

      expect(isLossyMappingAcknowledged("entity-1", "decimal", "openapi")).toBe(true);
      expect(isLossyMappingAcknowledged("entity-2", "decimal", "openapi")).toBe(false);
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
        // Should include entity-specific + global, but not other-entity's
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

import { describe, it, expect, beforeEach } from "vitest";
import {
  getEmitterConfigs,
  getEmitterConfigByName,
  updateEmitterConfig,
  testEmitter,
  getEnabledEmitters,
  getTypeMappingsForTarget,
  createTypeMappingOverride,
  updateTypeMapping,
  deleteTypeMappingOverride,
  _resetEmitterConfigStore,
  _seedTypeMappings,
} from "@/services/emitter-config.service";
import type { ServiceContext } from "@/types/service-context";

const adminCtx: ServiceContext = {
  userId: "admin-1",
  userRole: "ADMIN",
  prisma: null as unknown as ServiceContext["prisma"],
};

const viewerCtx: ServiceContext = {
  userId: "viewer-1",
  userRole: "VIEWER",
  prisma: null as unknown as ServiceContext["prisma"],
};

describe("Emitter Config Service", () => {
  beforeEach(() => {
    _resetEmitterConfigStore();
  });

  describe("getEmitterConfigs", () => {
    it("returns all emitter configs with stats", async () => {
      const result = await getEmitterConfigs(adminCtx);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.length).toBeGreaterThanOrEqual(3);
        expect(result.data.map((c) => c.emitterName)).toContain("bigquery");
        expect(result.data.map((c) => c.emitterName)).toContain("avro");
        expect(result.data.map((c) => c.emitterName)).toContain("openapi");
      }
    });

    it("rejects non-Admin users", async () => {
      const result = await getEmitterConfigs(viewerCtx);
      expect(result.success).toBe(false);
    });
  });

  describe("getEmitterConfigByName", () => {
    it("returns config for existing emitter", async () => {
      const result = await getEmitterConfigByName("bigquery", adminCtx);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.emitterName).toBe("bigquery");
        expect(result.data.enabled).toBe(true);
      }
    });

    it("returns NOT_FOUND for unknown emitter", async () => {
      const result = await getEmitterConfigByName("nonexistent", adminCtx);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe("NOT_FOUND");
      }
    });
  });

  describe("updateEmitterConfig", () => {
    it("toggles emitter enabled status", async () => {
      // Ensure defaults loaded
      await getEmitterConfigs(adminCtx);

      const result = await updateEmitterConfig(
        { emitterName: "bigquery", enabled: false },
        adminCtx
      );
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.enabled).toBe(false);
      }
    });

    it("records updatedBy on change", async () => {
      await getEmitterConfigs(adminCtx);

      const result = await updateEmitterConfig(
        { emitterName: "avro", enabled: false },
        adminCtx
      );
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.updatedBy).toBe("admin-1");
      }
    });

    it("rejects non-Admin users", async () => {
      const result = await updateEmitterConfig(
        { emitterName: "bigquery", enabled: false },
        viewerCtx
      );
      expect(result.success).toBe(false);
    });
  });

  describe("getEnabledEmitters", () => {
    it("returns only enabled emitter names", async () => {
      // All default to enabled
      const result = await getEnabledEmitters(adminCtx);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toContain("bigquery");
        expect(result.data).toContain("avro");
        expect(result.data).toContain("openapi");
      }
    });

    it("excludes disabled emitters", async () => {
      await getEmitterConfigs(adminCtx);
      await updateEmitterConfig(
        { emitterName: "avro", enabled: false },
        adminCtx
      );

      const result = await getEnabledEmitters(adminCtx);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toContain("bigquery");
        expect(result.data).not.toContain("avro");
      }
    });
  });

  describe("testEmitter", () => {
    it("runs emitter against entity and returns output", async () => {
      await getEmitterConfigs(adminCtx);

      const result = await testEmitter("bigquery", "entity-1", adminCtx);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.output).toBeTruthy();
        expect(result.data.valid).toBe(true);
        expect(result.data.compilationTimeMs).toBeGreaterThanOrEqual(0);
      }
    });

    it("rejects non-Admin users", async () => {
      const result = await testEmitter("bigquery", "entity-1", viewerCtx);
      expect(result.success).toBe(false);
    });
  });

  describe("Type Mapping Administration", () => {
    it("creates override mapping", async () => {
      const result = await createTypeMappingOverride(
        { targetFormat: "bigquery", sourceType: "decimal", mappedType: "NUMERIC" },
        adminCtx
      );
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.isOverride).toBe(true);
        expect(result.data.sourceType).toBe("decimal");
        expect(result.data.mappedType).toBe("NUMERIC");
      }
    });

    it("retrieves type mappings for target", async () => {
      await createTypeMappingOverride(
        { targetFormat: "bigquery", sourceType: "decimal", mappedType: "NUMERIC" },
        adminCtx
      );

      const result = await getTypeMappingsForTarget("bigquery", adminCtx);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toHaveLength(1);
      }
    });

    it("updates mapped type", async () => {
      const created = await createTypeMappingOverride(
        { targetFormat: "bigquery", sourceType: "decimal", mappedType: "NUMERIC" },
        adminCtx
      );
      expect(created.success).toBe(true);
      if (!created.success) return;

      const result = await updateTypeMapping(
        created.data.id,
        "BIGNUMERIC",
        adminCtx
      );
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.mappedType).toBe("BIGNUMERIC");
      }
    });

    it("deletes override mapping", async () => {
      const created = await createTypeMappingOverride(
        { targetFormat: "bigquery", sourceType: "decimal", mappedType: "NUMERIC" },
        adminCtx
      );
      expect(created.success).toBe(true);
      if (!created.success) return;

      const result = await deleteTypeMappingOverride(created.data.id, adminCtx);
      expect(result.success).toBe(true);
    });

    it("rejects deletion of system default mappings", async () => {
      _seedTypeMappings([{
        id: "default-1",
        targetFormat: "bigquery",
        sourceType: "string",
        mappedType: "STRING",
        isLossy: false,
        isOverride: false,
      }]);

      const result = await deleteTypeMappingOverride("default-1", adminCtx);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.message).toContain("system default");
      }
    });

    it("all CRUD operations require Admin role", async () => {
      const getResult = await getTypeMappingsForTarget("bigquery", viewerCtx);
      expect(getResult.success).toBe(false);

      const createResult = await createTypeMappingOverride(
        { targetFormat: "bigquery", sourceType: "int", mappedType: "INT64" },
        viewerCtx
      );
      expect(createResult.success).toBe(false);
    });
  });
});

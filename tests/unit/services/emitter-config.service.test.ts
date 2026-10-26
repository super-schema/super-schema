import { describe, it, expect, beforeEach, vi } from "vitest";

// ---------------------------------------------------------------------------
// In-memory stores to simulate Prisma behavior
// ---------------------------------------------------------------------------

let configRows: Array<{
  id: string;
  emitterName: string;
  enabled: boolean;
  configOverrides: Record<string, unknown> | null;
  version: string;
  targetFormat: string;
  description: string;
  updatedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}> = [];

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

function seedDefaults() {
  if (configRows.length > 0) return;
  const defaults = [
    { name: "bigquery", format: "SQL", version: "1.0.0", description: "Google BigQuery SQL DDL emitter" },
    { name: "avro", format: "JSON", version: "1.0.0", description: "Apache Avro schema emitter" },
    { name: "openapi", format: "YAML", version: "1.0.0", description: "OpenAPI 3.0 specification emitter" },
  ];
  for (const d of defaults) {
    configRows.push({
      id: `emitter-${nextId++}`,
      emitterName: d.name,
      enabled: true,
      configOverrides: null,
      version: d.version,
      targetFormat: d.format,
      description: d.description,
      updatedBy: "system",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }
}

vi.mock("@/lib/db", () => ({
  prisma: {
    emitterConfig: {
      count: vi.fn().mockImplementation(async () => configRows.length),
      findMany: vi.fn().mockImplementation(async (args?: { where?: { enabled?: boolean }; select?: Record<string, boolean> }) => {
        seedDefaults();
        let rows = configRows;
        if (args?.where?.enabled !== undefined) {
          rows = rows.filter((r) => r.enabled === args.where!.enabled);
        }
        if (args?.select?.emitterName) {
          return rows.map((r) => ({ emitterName: r.emitterName }));
        }
        return rows;
      }),
      findUnique: vi.fn().mockImplementation(async (args: { where: { emitterName?: string; id?: string } }) => {
        seedDefaults();
        if (args.where.emitterName) {
          return configRows.find((r) => r.emitterName === args.where.emitterName) ?? null;
        }
        if (args.where.id) {
          return configRows.find((r) => r.id === args.where.id) ?? null;
        }
        return null;
      }),
      update: vi.fn().mockImplementation(async (args: { where: { emitterName: string }; data: Record<string, unknown> }) => {
        const index = configRows.findIndex((r) => r.emitterName === args.where.emitterName);
        if (index === -1) throw new Error("Not found");
        configRows[index] = {
          ...configRows[index],
          ...(args.data as Record<string, unknown>),
          updatedAt: new Date(),
        } as typeof configRows[0];
        return configRows[index];
      }),
      upsert: vi.fn().mockImplementation(async (args: { where: { emitterName: string }; create: Record<string, unknown>; update: Record<string, unknown> }) => {
        const existing = configRows.find((r) => r.emitterName === args.where.emitterName);
        if (existing) return existing;
        const row = {
          id: `emitter-${nextId++}`,
          ...args.create,
          createdAt: new Date(),
          updatedAt: new Date(),
        } as typeof configRows[0];
        configRows.push(row);
        return row;
      }),
    },
    typeMappingOverride: {
      findMany: vi.fn().mockImplementation(async (args?: { where?: { targetFormat?: string } }) => {
        if (!args?.where) return overrideRows;
        if (args.where.targetFormat) {
          return overrideRows.filter((r) => r.targetFormat === args.where!.targetFormat);
        }
        return overrideRows;
      }),
      findUnique: vi.fn().mockImplementation(async (args: { where: { id: string } }) => {
        return overrideRows.find((r) => r.id === args.where.id) ?? null;
      }),
      create: vi.fn().mockImplementation(async (args: { data: Record<string, unknown> }) => {
        const row = {
          id: `mapping-${nextId++}`,
          ...(args.data as Record<string, unknown>),
          lossDescription: null,
          justification: null,
          approvedBy: null,
          entityId: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        } as typeof overrideRows[0];
        overrideRows.push(row);
        return row;
      }),
      update: vi.fn().mockImplementation(async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        const index = overrideRows.findIndex((r) => r.id === args.where.id);
        if (index === -1) throw new Error("Not found");
        overrideRows[index] = {
          ...overrideRows[index],
          ...(args.data as Record<string, unknown>),
          updatedAt: new Date(),
        } as typeof overrideRows[0];
        return overrideRows[index];
      }),
      delete: vi.fn().mockImplementation(async (args: { where: { id: string } }) => {
        const index = overrideRows.findIndex((r) => r.id === args.where.id);
        if (index === -1) throw new Error("Not found");
        const deleted = overrideRows[index];
        overrideRows.splice(index, 1);
        return deleted;
      }),
    },
  },
}));

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
import { assign } from "../../helpers/access-mocks";

const adminCtx: ServiceContext = {
  userId: "admin-1",
  userRole: "ADMIN", assignments: [assign.global()],
  prisma: null as unknown as ServiceContext["prisma"],
};

const viewerCtx: ServiceContext = {
  userId: "viewer-1",
  userRole: "VIEWER", assignments: [assign.tenant("VIEWER", "tenant-1")],
  prisma: null as unknown as ServiceContext["prisma"],
};

describe("Emitter Config Service", () => {
  beforeEach(() => {
    configRows = [];
    overrideRows = [];
    nextId = 1;
    vi.clearAllMocks();
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
      // Seed a "default" mapping with an ID starting with "default-"
      overrideRows.push({
        id: "default-1",
        targetFormat: "bigquery",
        sourceType: "string",
        mappedType: "STRING",
        isLossy: false,
        lossDescription: null,
        justification: null,
        approvedBy: null,
        entityId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

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

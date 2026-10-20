/**
 * Tests for SchemasTab workflow — server action layer.
 *
 * These tests verify the schema version lifecycle:
 * generateSchemaAction, publishSchemaAction, deploySchemaAction,
 * getSchemaVersionsAction, and version numbering.
 *
 * Mocks Prisma and NextAuth; exercises the actual action functions.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock: Prisma client
// ---------------------------------------------------------------------------

const { mockPrisma } = vi.hoisted(() => {
  return {
    mockPrisma: {
      entity: {
        create: vi.fn(),
        findUnique: vi.fn(),
        findMany: vi.fn(),
        update: vi.fn(),
        delete: vi.fn(),
      },
      field: {
        create: vi.fn(),
        findFirst: vi.fn(),
        findUnique: vi.fn(),
        findMany: vi.fn(),
        update: vi.fn(),
        delete: vi.fn(),
      },
      auditLog: {
        create: vi.fn().mockResolvedValue({ id: "audit-1" }),
      },
      typeMappingOverride: {
        findMany: vi.fn().mockResolvedValue([]),
      },
    },
  };
});

vi.mock("@/lib/db", () => ({ prisma: mockPrisma }));

// ---------------------------------------------------------------------------
// Mock: NextAuth session
// ---------------------------------------------------------------------------

vi.mock("@/lib/auth", () => ({
  auth: vi.fn().mockResolvedValue({
    user: { id: "user-1", email: "test@example.com", name: "Test User" },
  }),
}));

// ---------------------------------------------------------------------------
// Mock: next/cache
// ---------------------------------------------------------------------------

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

// Entity actions are scoped to the caller's active tenant (the cookie is not available outside a request).
vi.mock("@/lib/active-tenant", () => ({
  getActiveTenantId: vi.fn().mockResolvedValue("tenant-1"),
}));

// ---------------------------------------------------------------------------
// Mock: RBAC service
// ---------------------------------------------------------------------------

vi.mock("@/services/rbac.service", () => ({
  getEffectiveRole: vi.fn().mockResolvedValue({
    success: true,
    data: "AUTHOR",
  }),
}));

// ---------------------------------------------------------------------------
// Mock: the official TypeSpec emitter service
// ---------------------------------------------------------------------------
// Every Schemas-tab target (bigquery, avro, ...) routes through `emitOfficialTypeSpecTargetForEntity` (runtime
// "typespec-cli"); `emitEntity` is only the path of a "native" target, and none is left. This is a unit test of the
// version lifecycle, so the emitter is canned: the real `tsp` shell-out is covered by db-emitter-parity and
// e2e-critical-flows (Flow 2), which an entity without a primary key (these fixtures) cannot be emitted through anyway.

vi.mock("@/lib/typespec-official/emitter.service", () => ({
  emitOfficialTypeSpecTargetForEntity: vi.fn(async () => ({
    output: "CREATE TABLE `dataset.TestEntity` (\n  id STRING NOT NULL\n);",
    validationStatus: "VALID",
    warnings: [],
    errors: [],
  })),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import {
  generateSchemaAction,
  publishSchemaAction,
  deploySchemaAction,
  getSchemaVersionsAction,
  saveSchemaFieldTypeOverrideAction,
} from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/actions";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.auditLog.create.mockResolvedValue({ id: "audit-1" });
  mockPrisma.field.findMany.mockResolvedValue([]);
  if (mockPrisma.typeMappingOverride) {
    mockPrisma.typeMappingOverride.findMany.mockResolvedValue([]);
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SchemasTab Workflow", () => {
  // -------------------------------------------------------------------------
  // 1. generateSchemaAction creates a draft version in metadata
  // -------------------------------------------------------------------------
  describe("generateSchemaAction", () => {
    it("creates a draft version in entity metadata", async () => {
      mockPrisma.entity.findUnique.mockResolvedValue({
        id: "ent-1",
        tenantId: "tenant-1",
        name: "TestEntity",
        version: 1,
        metadata: {},
        fields: [],
      });
      mockPrisma.entity.update.mockResolvedValue({ id: "ent-1" });

      const result = await generateSchemaAction("ent-1", "bigquery");

      expect(result.success).toBe(true);
      expect(result.schemaVersion).toBeDefined();
      expect(result.schemaVersion!.status).toBe("draft");
      expect(result.schemaVersion!.version).toBe(1);
      expect(result.schemaVersion!.output).toContain("CREATE TABLE");
      expect(result.schemaVersion!.entityVersion).toBe(1);
      expect(result.schemaVersion!.generatedAt).toBeDefined();

      // Verify metadata was updated with schemaVersions
      const updateCall = mockPrisma.entity.update.mock.calls[0][0];
      const meta = updateCall.data.metadata as Record<string, unknown>;
      const versions = (meta.schemaVersions as Record<string, unknown[]>).bigquery;
      expect(versions).toHaveLength(1);
      expect((versions[0] as { status: string }).status).toBe("draft");
    });

    it("stores precision-aware field type mapping snapshots", async () => {
      const decimalField = {
        id: "field-amount",
        name: "amount",
        type: "decimal",
        precision: 10,
        scale: 2,
        nullable: false,
        isKey: false,
        fieldNumber: null,
        description: "",
        classification: null,
        aliases: [],
        decorators: {},
        sortOrder: 0,
      };
      mockPrisma.entity.findUnique.mockResolvedValue({
        id: "ent-1",
        tenantId: "tenant-1",
        name: "TestEntity",
        version: 1,
        metadata: {},
        fields: [decimalField],
      });
      mockPrisma.field.findMany.mockResolvedValue([decimalField]);
      mockPrisma.entity.update.mockResolvedValue({ id: "ent-1" });

      const result = await generateSchemaAction("ent-1", "bigquery");

      expect(result.success).toBe(true);
      expect(result.schemaVersion!.fieldTypeMappings).toEqual([
        { fieldName: "amount", sourceType: "decimal", targetType: "NUMERIC(10,2)" },
      ]);
    });

    it("returns the emitter's reason and stores no version when a target cannot be generated", async () => {
      mockPrisma.entity.findUnique.mockResolvedValue({
        id: "ent-1",
        tenantId: "tenant-1",
        name: "TestEntity",
        version: 1,
        metadata: {},
        fields: [],
      });
      const reason = "@typespec/bigquery/missing-primary-key: Table 'TestEntity' must have at least one @primaryKey property.";
      vi.mocked((await import("@/lib/typespec-official/emitter.service")).emitOfficialTypeSpecTargetForEntity).mockResolvedValueOnce({
        output: "",
        validationStatus: "INVALID",
        warnings: [],
        errors: [{ message: reason }],
      });

      const result = await generateSchemaAction("ent-1", "bigquery");

      expect(result).toEqual({ error: reason });
      expect(mockPrisma.entity.update).not.toHaveBeenCalled();
    });

    describe("a WARNING result (generated, with warnings)", () => {
      const entityWithNoVersions = {
        id: "ent-1",
        tenantId: "tenant-1",
        name: "TestEntity",
        version: 1,
        metadata: {},
        fields: [],
      };
      const emitterAnswers = async (warnings: unknown[]) => {
        mockPrisma.entity.findUnique.mockResolvedValue(entityWithNoVersions);
        mockPrisma.entity.update.mockResolvedValue({ id: "ent-1" });
        vi.mocked((await import("@/lib/typespec-official/emitter.service")).emitOfficialTypeSpecTargetForEntity).mockResolvedValueOnce({
          output: "CREATE TABLE `dataset.TestEntity` (\n  `order` STRING NOT NULL\n);",
          validationStatus: "WARNING",
          warnings: warnings as string[],
          errors: [],
        });
      };

      it("is a success that stores the draft and returns the status and the warnings unchanged", async () => {
        const warnings = [
          'The column "order" is a reserved word in BigQuery and the generated DDL does not quote it, so it will not run as is. Rename the field, or quote the name in the DDL by hand.',
          "@typespec/bigquery/unsupported-type: Type 'x' is not supported by the BigQuery emitter and will be skipped.",
        ];
        await emitterAnswers(warnings);

        const result = await generateSchemaAction("ent-1", "bigquery");

        expect(result.success).toBe(true);
        expect(result.validationStatus).toBe("WARNING");
        expect(result.warnings).toEqual(warnings);
        expect(result.schemaVersion!.status).toBe("draft");
        expect(mockPrisma.entity.update).toHaveBeenCalledTimes(1);
      });

      it("passes at most 20 warnings of at most 300 characters each to the client", async () => {
        await emitterAnswers(Array.from({ length: 25 }, (_, i) => `${i}: ${"w".repeat(400)}`));

        const result = await generateSchemaAction("ent-1", "bigquery");

        expect(result.warnings).toHaveLength(20);
        expect(result.warnings!.every((warning) => warning.length <= 300)).toBe(true);
        expect(result.warnings![0].startsWith("0: www")).toBe(true);
        expect(result.warnings![0].endsWith("…")).toBe(true);
      });

      it("always hands over plain strings (a warning object is read by its message; empty ones are dropped)", async () => {
        await emitterAnswers([{ message: "from an object" }, "  ", "plain", {}]);

        const result = await generateSchemaAction("ent-1", "bigquery");

        expect(result.warnings).toEqual(["from an object", "plain"]);
      });
    });
  });

  // -------------------------------------------------------------------------
  // 2. publishSchemaAction changes draft -> published
  // -------------------------------------------------------------------------
  describe("publishSchemaAction", () => {
    it("changes draft to published", async () => {
      mockPrisma.entity.findUnique.mockResolvedValue({
        id: "ent-1",
        tenantId: "tenant-1",
        metadata: {
          schemaVersions: {
            bigquery: [
              {
                version: 1,
                status: "draft",
                output: "CREATE TABLE ...",
                generatedAt: "2026-04-05T10:00:00.000Z",
                entityVersion: 1,
              },
            ],
          },
        },
      });
      mockPrisma.entity.update.mockResolvedValue({ id: "ent-1" });

      const result = await publishSchemaAction("ent-1", "bigquery", 1);

      expect(result.success).toBe(true);

      const updateCall = mockPrisma.entity.update.mock.calls[0][0];
      const meta = updateCall.data.metadata as Record<string, unknown>;
      const versions = (meta.schemaVersions as Record<string, unknown[]>).bigquery as Array<{ status: string; publishedAt?: string }>;
      expect(versions[0].status).toBe("published");
      expect(versions[0].publishedAt).toBeDefined();
    });

    it("rejects publishing an already-published version", async () => {
      mockPrisma.entity.findUnique.mockResolvedValue({
        id: "ent-1",
        tenantId: "tenant-1",
        metadata: {
          schemaVersions: {
            bigquery: [
              {
                version: 1,
                status: "published",
                output: "CREATE TABLE ...",
                generatedAt: "2026-04-05T10:00:00.000Z",
                entityVersion: 1,
                publishedAt: "2026-04-05T11:00:00.000Z",
              },
            ],
          },
        },
      });

      const result = await publishSchemaAction("ent-1", "bigquery", 1);

      expect(result.error).toContain("not a draft");
      expect(mockPrisma.entity.update).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // 3. deploySchemaAction changes published -> deployed
  // -------------------------------------------------------------------------
  describe("deploySchemaAction", () => {
    it("changes published to deployed", async () => {
      mockPrisma.entity.findUnique.mockResolvedValue({
        id: "ent-1",
        tenantId: "tenant-1",
        metadata: {
          schemaVersions: {
            bigquery: [
              {
                version: 1,
                status: "published",
                output: "CREATE TABLE ...",
                generatedAt: "2026-04-05T10:00:00.000Z",
                entityVersion: 1,
                publishedAt: "2026-04-05T11:00:00.000Z",
              },
            ],
          },
        },
      });
      mockPrisma.entity.update.mockResolvedValue({ id: "ent-1" });

      const result = await deploySchemaAction("ent-1", "bigquery", 1);

      expect(result.success).toBe(true);

      const updateCall = mockPrisma.entity.update.mock.calls[0][0];
      const meta = updateCall.data.metadata as Record<string, unknown>;
      const versions = (meta.schemaVersions as Record<string, unknown[]>).bigquery as Array<{ status: string; deployedAt?: string }>;
      expect(versions[0].status).toBe("deployed");
      expect(versions[0].deployedAt).toBeDefined();
    });

    it("rejects deploying a draft version", async () => {
      mockPrisma.entity.findUnique.mockResolvedValue({
        id: "ent-1",
        tenantId: "tenant-1",
        metadata: {
          schemaVersions: {
            bigquery: [
              {
                version: 1,
                status: "draft",
                output: "CREATE TABLE ...",
                generatedAt: "2026-04-05T10:00:00.000Z",
                entityVersion: 1,
              },
            ],
          },
        },
      });

      const result = await deploySchemaAction("ent-1", "bigquery", 1);

      expect(result.error).toContain("not published");
      expect(mockPrisma.entity.update).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // 4. getSchemaVersionsAction returns correct structure
  // -------------------------------------------------------------------------
  describe("getSchemaVersionsAction", () => {
    it("returns schema versions map from entity metadata", async () => {
      const schemaVersions = {
        bigquery: [
          {
            version: 2,
            status: "draft",
            output: "CREATE TABLE v2 ...",
            generatedAt: "2026-04-05T12:00:00.000Z",
            entityVersion: 2,
          },
          {
            version: 1,
            status: "published",
            output: "CREATE TABLE v1 ...",
            generatedAt: "2026-04-05T10:00:00.000Z",
            entityVersion: 1,
            publishedAt: "2026-04-05T11:00:00.000Z",
          },
        ],
        avro: [
          {
            version: 1,
            status: "draft",
            output: '{"type": "record", ...}',
            generatedAt: "2026-04-05T10:30:00.000Z",
            entityVersion: 1,
          },
        ],
      };

      mockPrisma.entity.findUnique.mockResolvedValue({
        id: "ent-1",
        tenantId: "tenant-1",
        metadata: { schemaVersions },
      });

      const result = await getSchemaVersionsAction("ent-1");

      expect(result.success).toBe(true);
      expect(result.schemaVersions).toBeDefined();
      expect(result.schemaVersions!.bigquery).toHaveLength(2);
      expect(result.schemaVersions!.avro).toHaveLength(1);
      expect(result.schemaVersions!.bigquery[0].version).toBe(2);
      expect(result.schemaVersions!.bigquery[1].status).toBe("published");
    });

    it("returns empty map when no schema versions exist", async () => {
      mockPrisma.entity.findUnique.mockResolvedValue({
        id: "ent-1",
        tenantId: "tenant-1",
        metadata: {},
        fields: [],
      });

      const result = await getSchemaVersionsAction("ent-1");

      expect(result.success).toBe(true);
      expect(result.schemaVersions).toEqual({});
    });

    it("returns error for non-existent entity", async () => {
      mockPrisma.entity.findUnique.mockResolvedValue(null);

      const result = await getSchemaVersionsAction("nonexistent");

      expect(result.error).toBe("Entity not found");
    });
  });

  describe("saveSchemaFieldTypeOverrideAction", () => {
    it("rejects physical target types outside the selected target catalog", async () => {
      mockPrisma.entity.findUnique.mockResolvedValue({
        id: "ent-1",
        tenantId: "tenant-1",
        metadata: {},
      });
      mockPrisma.field.findMany.mockResolvedValue([
        {
          id: "field-1",
          name: "displayName",
          type: "string",
          precision: null,
          scale: null,
          nullable: false,
          isKey: false,
          fieldNumber: null,
          description: "",
          classification: null,
          aliases: [],
          decorators: {},
          sortOrder: 0,
        },
      ]);

      const result = await saveSchemaFieldTypeOverrideAction({
        entityId: "ent-1",
        target: "bigquery",
        fieldId: "field-1",
        mappedType: "STRING); DROP TABLE users; --",
      });

      expect(result.error).toContain("Invalid BigQuery DDL target type");
      expect(mockPrisma.entity.update).not.toHaveBeenCalled();
    });
  });


  // -------------------------------------------------------------------------
  // 5. Version numbering increments correctly
  // -------------------------------------------------------------------------
  describe("Version numbering", () => {
    it("increments version number from existing versions", async () => {
      mockPrisma.entity.findUnique.mockResolvedValue({
        id: "ent-1",
        tenantId: "tenant-1",
        name: "TestEntity",
        version: 3,
        metadata: {
          schemaVersions: {
            bigquery: [
              {
                version: 2,
                status: "published",
                output: "CREATE TABLE v2 ...",
                generatedAt: "2026-04-05T11:00:00.000Z",
                entityVersion: 2,
                publishedAt: "2026-04-05T12:00:00.000Z",
              },
              {
                version: 1,
                status: "deployed",
                output: "CREATE TABLE v1 ...",
                generatedAt: "2026-04-05T10:00:00.000Z",
                entityVersion: 1,
                publishedAt: "2026-04-05T10:30:00.000Z",
                deployedAt: "2026-04-05T11:00:00.000Z",
              },
            ],
          },
        },
        fields: [],
      });
      mockPrisma.entity.update.mockResolvedValue({ id: "ent-1" });

      const result = await generateSchemaAction("ent-1", "bigquery");

      expect(result.success).toBe(true);
      expect(result.schemaVersion!.version).toBe(3);
      expect(result.schemaVersion!.entityVersion).toBe(3);
    });

    it("starts at version 1 for a new target", async () => {
      mockPrisma.entity.findUnique.mockResolvedValue({
        id: "ent-1",
        tenantId: "tenant-1",
        name: "TestEntity",
        version: 1,
        metadata: {
          schemaVersions: {
            bigquery: [
              {
                version: 1,
                status: "draft",
                output: "CREATE TABLE ...",
                generatedAt: "2026-04-05T10:00:00.000Z",
                entityVersion: 1,
              },
            ],
          },
        },
        fields: [],
      });
      mockPrisma.entity.update.mockResolvedValue({ id: "ent-1" });

      // Generate for a different target (avro) — should start at version 1
      vi.mocked((await import("@/lib/typespec-official/emitter.service")).emitOfficialTypeSpecTargetForEntity).mockResolvedValueOnce({
        output: '{"type":"record","name":"TestEntity","fields":[]}',
        validationStatus: "VALID",
        warnings: [],
        errors: [],
      });

      const result = await generateSchemaAction("ent-1", "avro");

      expect(result.success).toBe(true);
      expect(result.schemaVersion!.version).toBe(1);
    });
  });
});

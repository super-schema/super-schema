/**
 * E2E-style integration tests for critical flows.
 *
 * These tests exercise the full server-side action layer without a browser,
 * mocking only Prisma (database) and NextAuth (session). They verify
 * end-to-end data flow through entity creation, schema generation,
 * publishing, field updates, and status transitions.
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
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { createEntityWithFieldsAction } from "@/app/(dashboard)/schemas/[domainSlug]/actions";
import {
  addFieldAction,
  updateFieldAction,
  updateEntityStatusAction,
  generateSchemaAction,
  publishSchemaAction,
  getSchemaVersionsAction,
} from "@/app/(dashboard)/schemas/[domainSlug]/[entityId]/actions";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.auditLog.create.mockResolvedValue({ id: "audit-1" });
});

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("E2E Critical Flows", () => {
  // -------------------------------------------------------------------------
  // 1. Create entity with 3 fields -> verify entity+fields created
  // -------------------------------------------------------------------------
  describe("Flow 1: Create entity with 3 fields", () => {
    it("creates entity with 3 fields and verifies correct data", async () => {
      const mockEntity = {
        id: "ent-e2e-1",
        name: "Order",
        slug: "order",
        domainId: "dom-1",
        description: "Customer order",
        status: "DRAFT",
        version: 1,
      };

      mockPrisma.entity.create.mockResolvedValue(mockEntity);

      const result = await createEntityWithFieldsAction("dom-1", {
        name: "Order",
        description: "Customer order",
        fields: [
          {
            name: "order_id",
            type: "string",
            nullable: false,
            isKey: true,
            description: "Primary key",
            classification: null,
            precision: null,
            scale: null,
          },
          {
            name: "customer_name",
            type: "string",
            nullable: false,
            isKey: false,
            description: "Customer name",
            classification: "PII",
            precision: null,
            scale: null,
          },
          {
            name: "total_amount",
            type: "decimal",
            nullable: true,
            isKey: false,
            description: "Order total",
            classification: null,
            precision: 18,
            scale: 2,
          },
        ],
      });

      // Verify success
      expect(result.success).toBe(true);
      expect(result.entityId).toBe("ent-e2e-1");

      // Verify prisma.entity.create was called exactly once
      expect(mockPrisma.entity.create).toHaveBeenCalledTimes(1);
      const createCall = mockPrisma.entity.create.mock.calls[0][0];

      // Verify entity data
      expect(createCall.data.name).toBe("Order");
      expect(createCall.data.slug).toBe("order");
      expect(createCall.data.domainId).toBe("dom-1");
      expect(createCall.data.description).toBe("Customer order");

      // Verify exactly 3 fields in nested create
      expect(createCall.data.fields.create).toHaveLength(3);

      // Verify field 1: order_id
      const f1 = createCall.data.fields.create[0];
      expect(f1.name).toBe("order_id");
      expect(f1.slug).toBe("order-id");
      expect(f1.type).toBe("string");
      expect(f1.isKey).toBe(true);
      expect(f1.nullable).toBe(false);
      expect(f1.sortOrder).toBe(0);

      // Verify field 2: customer_name
      const f2 = createCall.data.fields.create[1];
      expect(f2.name).toBe("customer_name");
      expect(f2.slug).toBe("customer-name");
      expect(f2.classification).toBe("PII");
      expect(f2.sortOrder).toBe(1);

      // Verify field 3: total_amount
      const f3 = createCall.data.fields.create[2];
      expect(f3.name).toBe("total_amount");
      expect(f3.type).toBe("decimal");
      expect(f3.precision).toBe(18);
      expect(f3.scale).toBe(2);
      expect(f3.nullable).toBe(true);
      expect(f3.sortOrder).toBe(2);
    });
  });

  // -------------------------------------------------------------------------
  // 2. Generate schema for bigquery target -> verify DDL output
  // -------------------------------------------------------------------------
  describe("Flow 2: Generate schema for bigquery target", () => {
    it("generates DDL output containing CREATE TABLE", async () => {
      const ddlOutput = "CREATE TABLE `sales.Order` (\n  order_id STRING NOT NULL,\n  customer_name STRING NOT NULL,\n  total_amount NUMERIC(18,2)\n);";

      // Mock emitEntity to return bigquery target output
      vi.doMock("@/lib/emission/emission.service", () => ({
        emitEntity: vi.fn().mockResolvedValue({
          typeSpec: "model Order { ... }",
          targets: {
            bigquery: {
              output: ddlOutput,
              validationStatus: "valid",
              warnings: [],
              errors: [],
            },
          },
          summary: { totalTargets: 1, validCount: 1, invalidCount: 0, warningCount: 0 },
        }),
      }));

      // Mock entity lookup for generateSchemaAction
      mockPrisma.entity.findUnique.mockResolvedValue({
        id: "ent-e2e-1",
        name: "Order",
        slug: "order",
        version: 1,
        metadata: {},
      });
      mockPrisma.entity.update.mockResolvedValue({
        id: "ent-e2e-1",
        metadata: {},
      });

      mockPrisma.field.findMany.mockResolvedValue([]);

      const result = await generateSchemaAction("ent-e2e-1", "bigquery");

      expect(result.success).toBe(true);
      expect(result.schemaVersion).toBeDefined();
      expect(result.schemaVersion!.status).toBe("draft");
      expect(result.schemaVersion!.output).toContain("CREATE TABLE");
      expect(result.schemaVersion!.output).toContain("order_id STRING NOT NULL");
      expect(result.schemaVersion!.version).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // 3. Publish schema -> verify status changes to "published"
  // -------------------------------------------------------------------------
  describe("Flow 3: Publish schema version", () => {
    it("changes draft schema status to published", async () => {
      const draftVersion = {
        version: 1,
        status: "draft" as const,
        output: "CREATE TABLE ...",
        generatedAt: "2026-04-05T10:00:00.000Z",
        entityVersion: 1,
      };

      mockPrisma.entity.findUnique.mockResolvedValue({
        id: "ent-e2e-1",
        metadata: {
          schemaVersions: {
            bigquery: [draftVersion],
          },
        },
      });
      mockPrisma.entity.update.mockImplementation(async ({ data }) => {
        return { id: "ent-e2e-1", metadata: data.metadata };
      });

      const result = await publishSchemaAction("ent-e2e-1", "bigquery", 1);

      expect(result.success).toBe(true);

      // Verify the metadata update contains published status
      const updateCall = mockPrisma.entity.update.mock.calls[0][0];
      const updatedMeta = updateCall.data.metadata as Record<string, unknown>;
      const versions = (updatedMeta.schemaVersions as Record<string, unknown[]>).bigquery as Array<{ status: string; publishedAt?: string }>;
      expect(versions[0].status).toBe("published");
      expect(versions[0].publishedAt).toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  // 4. Field name update -> verify slug regenerates
  // -------------------------------------------------------------------------
  describe("Flow 4: Field name update regenerates slug", () => {
    it("regenerates slug when field name changes", async () => {
      const existingField = {
        id: "field-e2e-1",
        entityId: "ent-e2e-1",
        name: "old_field_name",
        slug: "oldfieldname",
        type: "string",
        nullable: false,
        isKey: false,
        description: "",
        classification: null,
        precision: null,
        scale: null,
        fieldNumber: null,
        aliases: [],
        decorators: {},
        sortOrder: 0,
      };

      mockPrisma.field.findUnique.mockResolvedValue(existingField);
      mockPrisma.field.update.mockResolvedValue({
        ...existingField,
        name: "New Field Name",
        slug: "new-field-name",
      });

      const result = await updateFieldAction("field-e2e-1", {
        name: "New Field Name",
      });

      expect(result.success).toBe(true);

      // Verify that slug was regenerated in the update call
      const updateCall = mockPrisma.field.update.mock.calls[0][0];
      expect(updateCall.data.name).toBe("New Field Name");
      expect(updateCall.data.slug).toBe("new-field-name");
    });

    it("does not regenerate slug when name is unchanged", async () => {
      const existingField = {
        id: "field-e2e-2",
        entityId: "ent-e2e-1",
        name: "same_name",
        slug: "samename",
        type: "string",
        nullable: false,
        isKey: false,
        description: "",
        classification: null,
        precision: null,
        scale: null,
        fieldNumber: null,
        aliases: [],
        decorators: {},
        sortOrder: 0,
      };

      mockPrisma.field.findUnique.mockResolvedValue(existingField);
      mockPrisma.field.update.mockResolvedValue({
        ...existingField,
        description: "Updated description",
      });

      const result = await updateFieldAction("field-e2e-2", {
        description: "Updated description",
      });

      expect(result.success).toBe(true);

      // Verify slug was NOT included in update (no name change)
      const updateCall = mockPrisma.field.update.mock.calls[0][0];
      expect(updateCall.data.slug).toBeUndefined();
      expect(updateCall.data.description).toBe("Updated description");
    });
  });

  // -------------------------------------------------------------------------
  // 5. Entity status transition DRAFT -> ACTIVE -> verify success
  // -------------------------------------------------------------------------
  describe("Flow 5: Entity status transition DRAFT -> ACTIVE", () => {
    it("successfully transitions from DRAFT to ACTIVE", async () => {
      const existingEntity = {
        id: "ent-e2e-1",
        name: "Order",
        slug: "order",
        domainId: "dom-1",
        description: "Customer order",
        status: "DRAFT",
        version: 1,
        ownerId: "user-1",
        metadata: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      mockPrisma.entity.findUnique.mockResolvedValue(existingEntity);
      mockPrisma.entity.update.mockResolvedValue({
        ...existingEntity,
        status: "ACTIVE",
      });

      const result = await updateEntityStatusAction("ent-e2e-1", "ACTIVE");

      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it("rejects invalid transition DRAFT -> DEPRECATED", async () => {
      const existingEntity = {
        id: "ent-e2e-1",
        name: "Order",
        slug: "order",
        domainId: "dom-1",
        description: "Customer order",
        status: "DRAFT",
        version: 1,
        ownerId: "user-1",
        metadata: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      mockPrisma.entity.findUnique.mockResolvedValue(existingEntity);

      const result = await updateEntityStatusAction("ent-e2e-1", "DEPRECATED");

      expect(result.error).toBeDefined();
      expect(result.error).toContain("Cannot transition from DRAFT to DEPRECATED");
    });

    it("rejects invalid transition DRAFT -> RETIRED", async () => {
      const existingEntity = {
        id: "ent-e2e-1",
        name: "Order",
        slug: "order",
        domainId: "dom-1",
        description: "Customer order",
        status: "DRAFT",
        version: 1,
        ownerId: "user-1",
        metadata: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      mockPrisma.entity.findUnique.mockResolvedValue(existingEntity);

      const result = await updateEntityStatusAction("ent-e2e-1", "RETIRED");

      expect(result.error).toBeDefined();
      expect(result.error).toContain("Cannot transition from DRAFT to RETIRED");
    });
  });
});

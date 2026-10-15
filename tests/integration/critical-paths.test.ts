/**
 * Integration tests for critical paths.
 *
 * These tests exercise the full server-side action layer without a browser,
 * mocking only Prisma (database) and NextAuth (session).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock: Prisma client (use vi.hoisted so the variable is available in factory)
// ---------------------------------------------------------------------------

const { mockPrisma } = vi.hoisted(() => {
  return {
    mockPrisma: {
      user: {
        findUnique: vi.fn().mockResolvedValue({ id: "user-1" }),
      },
      entity: {
        create: vi.fn(),
        findUnique: vi.fn(),
        findMany: vi.fn().mockResolvedValue([]),
        update: vi.fn(),
        delete: vi.fn(),
      },
      product: {
        findUnique: vi.fn().mockResolvedValue({
          id: "prod-default",
          domainId: "dom-1",
          domain: { tenantId: "tenant-1" },
        }),
        create: vi.fn().mockResolvedValue({ id: "prod-default" }),
      },
      // Name-registry finders (real registry runs against this mock; no rows = no conflicts)
      sharedEnum: { findMany: vi.fn().mockResolvedValue([]) },
      customScalar: { findMany: vi.fn().mockResolvedValue([]) },
      unionType: { findMany: vi.fn().mockResolvedValue([]) },
      serviceDefinition: { findMany: vi.fn().mockResolvedValue([]) },
      $executeRaw: vi.fn(),
      $executeRawUnsafe: vi.fn(),
      $transaction: vi.fn(),
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
// Mock: next/cache (server actions call revalidatePath)
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
// Imports (after mocks are set up)
// ---------------------------------------------------------------------------

import { createEntityWithFieldsAction } from "@/app/(dashboard)/schemas/[domainSlug]/actions";
import {
  updateFieldAction,
  deleteFieldAction,
  updateEntityStatusAction,
  generateTypeSpecPreviewAction,
} from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/actions";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  // Interactive transactions (tenant name lock) run their callback against the same mock client.
  mockPrisma.$transaction.mockImplementation(async (fn: (tx: typeof mockPrisma) => unknown) => fn(mockPrisma));
  // Re-set audit mock default
  mockPrisma.auditLog.create.mockResolvedValue({ id: "audit-1" });
});

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("Critical Paths - Integration", () => {
  // -----------------------------------------------------------------------
  // 1. Create entity with 3 fields
  // -----------------------------------------------------------------------
  describe("createEntityWithFieldsAction", () => {
    it("creates entity with 3 fields and returns success", async () => {
      const mockEntity = {
        id: "ent-1",
        name: "Customer",
        domainId: "dom-1",
        description: "Customer entity",
        status: "DRAFT",
        version: 1,
      };

      mockPrisma.entity.create.mockResolvedValue(mockEntity);

      const result = await createEntityWithFieldsAction("dom-1", {
        name: "Customer",
        description: "Customer entity",
        fields: [
          {
            name: "id",
            type: "string",
            nullable: false,
            isKey: true,
            description: "Primary key",
            classification: null,
            precision: null,
            scale: null,
          },
          {
            name: "name",
            type: "string",
            nullable: false,
            isKey: false,
            description: "Customer name",
            classification: "PII",
            precision: null,
            scale: null,
          },
          {
            name: "balance",
            type: "decimal",
            nullable: true,
            isKey: false,
            description: "Account balance",
            classification: null,
            precision: 18,
            scale: 2,
          },
        ],
      });

      expect(result.success).toBe(true);
      expect(result.entityId).toBe("ent-1");

      // Verify prisma.entity.create was called with nested field create
      expect(mockPrisma.entity.create).toHaveBeenCalledTimes(1);
      const createCall = mockPrisma.entity.create.mock.calls[0][0];
      expect(createCall.data.name).toBe("Customer");
      expect(createCall.data.domainId).toBe("dom-1");
      expect(createCall.data.tenantId).toBe("tenant-1");
      expect(createCall.data.fields.create).toHaveLength(3);

      // Verify each field in the nested create
      const fieldsCreate = createCall.data.fields.create;
      expect(fieldsCreate[0].name).toBe("id");
      expect(fieldsCreate[0].isKey).toBe(true);
      expect(fieldsCreate[0].sortOrder).toBe(0);

      expect(fieldsCreate[1].name).toBe("name");
      expect(fieldsCreate[1].classification).toBe("PII");
      expect(fieldsCreate[1].sortOrder).toBe(1);

      expect(fieldsCreate[2].name).toBe("balance");
      expect(fieldsCreate[2].type).toBe("decimal");
      expect(fieldsCreate[2].precision).toBe(18);
      expect(fieldsCreate[2].scale).toBe(2);
      expect(fieldsCreate[2].sortOrder).toBe(2);
    });

    it("returns error for empty entity name", async () => {
      const result = await createEntityWithFieldsAction("dom-1", {
        name: "",
        description: "",
        fields: [],
      });

      expect(result.error).toBe("Entity name is required");
      expect(mockPrisma.entity.create).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // 2. Update field with decorators
  // -----------------------------------------------------------------------
  describe("updateFieldAction", () => {
    it("updates field and saves decorators", async () => {
      const existingField = {
        id: "field-1",
        entityId: "ent-1",
        name: "email",
        type: "string",
        nullable: true,
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
        description: "User email address",
        decorators: {
          typespec: {
            identity: { format: "email" },
            validation: { maxLength: 255 },
          },
          policy: { encryption: "at-rest" },
        },
      });

      const result = await updateFieldAction("field-1", {
        description: "User email address",
        decorators: {
          typespec: {
            identity: { format: "email" },
            validation: { maxLength: 255 },
          },
          policy: { encryption: "at-rest" },
        },
      });

      expect(result.success).toBe(true);

      // Verify the update call included decorators
      expect(mockPrisma.field.update).toHaveBeenCalledTimes(1);
      const updateCall = mockPrisma.field.update.mock.calls[0][0];
      expect(updateCall.where.id).toBe("field-1");
      expect(updateCall.data.description).toBe("User email address");
      expect(updateCall.data.decorators).toEqual({
        typespec: {
          identity: { format: "email" },
          validation: { maxLength: 255 },
        },
        policy: { encryption: "at-rest" },
      });
    });

    it("returns error for non-existent field", async () => {
      mockPrisma.field.findUnique.mockResolvedValue(null);

      const result = await updateFieldAction("nonexistent", {
        name: "updated",
      });

      expect(result.error).toBe("Field not found");
      expect(mockPrisma.field.update).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // 3. Delete field
  // -----------------------------------------------------------------------
  describe("deleteFieldAction", () => {
    it("deletes field and returns success", async () => {
      const existingField = {
        id: "field-1",
        entityId: "ent-1",
        name: "temp_field",
        type: "string",
        nullable: true,
        isKey: false,
        description: "",
        classification: null,
        precision: null,
        scale: null,
        fieldNumber: null,
        aliases: [],
        decorators: {},
        sortOrder: 3,
      };

      mockPrisma.field.findUnique.mockResolvedValue(existingField);
      mockPrisma.field.delete.mockResolvedValue(existingField);

      const result = await deleteFieldAction("field-1");

      expect(result.success).toBe(true);
      expect(mockPrisma.field.delete).toHaveBeenCalledWith({
        where: { id: "field-1" },
      });
    });

    it("returns error for non-existent field", async () => {
      mockPrisma.field.findUnique.mockResolvedValue(null);

      const result = await deleteFieldAction("nonexistent");

      expect(result.error).toBe("Field not found");
      expect(mockPrisma.field.delete).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // 4. Status transition DRAFT -> ACTIVE
  // -----------------------------------------------------------------------
  describe("updateEntityStatusAction", () => {
    it("transitions DRAFT -> ACTIVE successfully", async () => {
      const existingEntity = {
        id: "ent-1",
        name: "Customer",
        domainId: "dom-1",
        description: "Customer entity",
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

      const result = await updateEntityStatusAction("ent-1", "ACTIVE");

      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it("rejects invalid transition DRAFT -> RETIRED", async () => {
      const existingEntity = {
        id: "ent-1",
        name: "Customer",
        domainId: "dom-1",
        description: "Customer entity",
        status: "DRAFT",
        version: 1,
        ownerId: "user-1",
        metadata: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      mockPrisma.entity.findUnique.mockResolvedValue(existingEntity);

      const result = await updateEntityStatusAction("ent-1", "RETIRED");

      expect(result.error).toBeDefined();
      expect(result.error).toContain("Cannot transition from DRAFT to RETIRED");
      expect(mockPrisma.entity.update).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // 5. TypeSpec preview generation
  // -----------------------------------------------------------------------
  describe("generateTypeSpecPreviewAction", () => {
    it("generates TypeSpec source containing model name and fields", async () => {
      const mockEntity = {
        id: "ent-1",
        name: "Customer",
        domainId: "dom-1",
        description: "A customer record",
        status: "DRAFT",
        version: 1,
        metadata: null,
        domain: { id: "dom-1", name: "Sales", slug: "sales" },
      };

      const mockFields = [
        {
          id: "f1",
          name: "id",
          type: "string",
          precision: null,
          scale: null,
          nullable: false,
          isKey: true,
          fieldNumber: null,
          description: "Primary identifier",
          classification: null,
          aliases: [],
          decorators: {},
          sortOrder: 0,
        },
        {
          id: "f2",
          name: "name",
          type: "string",
          precision: null,
          scale: null,
          nullable: false,
          isKey: false,
          fieldNumber: null,
          description: "Customer name",
          classification: "PII",
          aliases: [],
          decorators: {},
          sortOrder: 1,
        },
        {
          id: "f3",
          name: "balance",
          type: "decimal",
          precision: 18,
          scale: 2,
          nullable: true,
          isKey: false,
          fieldNumber: null,
          description: "Account balance",
          classification: null,
          aliases: [],
          decorators: {},
          sortOrder: 2,
        },
      ];

      mockPrisma.entity.findUnique.mockResolvedValue(mockEntity);
      mockPrisma.field.findMany.mockResolvedValue(mockFields);

      const result = await generateTypeSpecPreviewAction("ent-1");

      expect(result.success).toBe(true);
      expect(result.source).toBeDefined();
      expect(result.source).toContain("model Customer");
      expect(result.source).toContain("id");
      expect(result.source).toContain("name");
      expect(result.source).toContain("balance");
      // Key field gets @key decorator
      expect(result.source).toContain("@key");
      // PII field gets the governance classification decorator (Story 16.6)
      expect(result.source).toContain("@Enterprise.dataClassification(Enterprise.DataClassification.PII)");
      expect(result.source).not.toContain("@tag(");
      // Nullable field gets optional marker
      expect(result.source).toContain("balance?");
    });
  });
});

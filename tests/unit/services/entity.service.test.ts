import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockTx, mockAssertNameAvailable } = vi.hoisted(() => ({
  mockTx: {
    entity: {
      create: vi.fn(),
      update: vi.fn(),
    },
  },
  mockAssertNameAvailable: vi.fn(),
}));

vi.mock("@/services/name-registry.service", () => ({
  assertNameAvailable: mockAssertNameAvailable,
  withTenantNameLock: (_db: unknown, _tenantId: string, fn: (tx: unknown) => unknown) => fn(mockTx),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    entity: {
      create: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    product: {
      findUnique: vi.fn().mockResolvedValue({
        id: "prd-default",
        domainId: "dom-1",
        domain: { tenantId: "tenant-1" },
      }),
      create: vi.fn().mockResolvedValue({ id: "prd-default" }),
    },
    auditLog: {
      create: vi.fn().mockResolvedValue({ id: "audit-1" }),
    },
  },
}));

import {
  createEntity,
  getEntities,
  getEntityById,
  updateEntity,
  deleteEntity,
} from "@/services/entity.service";
import { prisma } from "@/lib/db";
import type { ServiceContext } from "@/types/service-context";

const mockCtx: ServiceContext = {
  userId: "user-1",
  userRole: "AUTHOR",
  prisma: prisma as unknown as ServiceContext["prisma"],
};

const CONFLICT_ERROR = {
  code: "NAME_CONFLICT",
  message: '"Customer" is already used by Enum "Customer" at Domain level.',
  suggestedFix: "Choose a different name.",
};

describe("Entity Service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAssertNameAvailable.mockResolvedValue({ success: true, data: undefined });
  });

  describe("createEntity", () => {
    it("returns success result on valid input", async () => {
      const mockEntity = {
        id: "ent-1",
        name: "Customer",
        domainId: "dom-1",
        version: 1,
        status: "DRAFT",
      };
      mockTx.entity.create.mockResolvedValue(mockEntity as never);

      const result = await createEntity(
        { name: "Customer", domainId: "dom-1", description: "Customer entity" },
        mockCtx
      );

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.name).toBe("Customer");
      }
      expect(mockAssertNameAvailable).toHaveBeenCalledWith(mockTx, {
        name: "Customer",
        tenantId: "tenant-1",
        domainId: "dom-1",
        productId: "prd-default",
      });
      expect(mockTx.entity.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            domainId: "dom-1",
            tenantId: "tenant-1",
            productId: "prd-default",
          }),
        })
      );
    });

    it("returns the registry conflict, creates nothing and writes no audit log", async () => {
      mockAssertNameAvailable.mockResolvedValue({ success: false, error: CONFLICT_ERROR });

      const result = await createEntity(
        { name: "Customer", domainId: "dom-1", description: "Clash" },
        mockCtx
      );

      expect(result).toEqual({ success: false, error: CONFLICT_ERROR });
      expect(mockTx.entity.create).not.toHaveBeenCalled();
      expect(prisma.auditLog.create).not.toHaveBeenCalled();
    });

    it("returns NOT_FOUND when the domain's default product cannot be resolved", async () => {
      vi.mocked(prisma.product.findUnique)
        .mockResolvedValueOnce({ id: "prd-default" } as never) // ensureDefaultProductId
        .mockResolvedValueOnce(null); // resolveScope

      const result = await createEntity(
        { name: "Customer", domainId: "dom-1", description: "" },
        mockCtx
      );

      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.code).toBe("NOT_FOUND");
      expect(mockAssertNameAvailable).not.toHaveBeenCalled();
    });

    it("returns error for duplicate entity name in same domain", async () => {
      mockTx.entity.create.mockRejectedValue(
        new Error("Unique constraint failed on the constraint: `entities_name_domainId_key`")
      );

      const result = await createEntity(
        { name: "Customer", domainId: "dom-1", description: "Duplicate" },
        mockCtx
      );

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe("DUPLICATE");
        expect(result.error.suggestedFix).toContain("different name");
      }
    });

    it("returns error for invalid metadata JSONB", async () => {
      const result = await createEntity(
        {
          name: "Test",
          domainId: "dom-1",
          description: "Test",
          metadata: { relationships: [{ targetEntityId: "x", type: "invalid-type" }] } as never,
        },
        mockCtx
      );

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe("VALIDATION_ERROR");
        expect(result.error.suggestedFix).toBeDefined();
      }
    });

    it("rejects 'Events' entity name (reserved for event spec routes)", async () => {
      const result = await createEntity(
        { name: "Events", domainId: "dom-1", description: "Reserved for event spec routes" },
        mockCtx
      );

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe("VALIDATION_ERROR");
        expect(result.error.message).toContain("reserved");
      }
      expect(mockTx.entity.create).not.toHaveBeenCalled();
    });
  });

  describe("getEntities", () => {
    it("returns filtered entity list", async () => {
      const mockEntities = [{ id: "ent-1", name: "Customer" }];
      vi.mocked(prisma.entity.findMany).mockResolvedValue(mockEntities as never);

      const result = await getEntities({ domainId: "dom-1" }, mockCtx);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toHaveLength(1);
      }
    });
  });

  describe("getEntityById", () => {
    it("returns entity when found", async () => {
      vi.mocked(prisma.entity.findUnique).mockResolvedValue({
        id: "ent-1",
        name: "Customer",
      } as never);

      const result = await getEntityById("ent-1", mockCtx);
      expect(result.success).toBe(true);
    });

    it("returns not-found error for missing entity", async () => {
      vi.mocked(prisma.entity.findUnique).mockResolvedValue(null);

      const result = await getEntityById("nonexistent", mockCtx);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe("NOT_FOUND");
      }
    });
  });

  describe("updateEntity", () => {
    const existing = {
      id: "ent-1",
      name: "Customer",
      version: 1,
      tenantId: "tenant-1",
      domainId: "dom-1",
      productId: "prd-1",
      status: "DRAFT",
    };

    it("rejects renaming to 'Specs' (reserved URL segment)", async () => {
      vi.mocked(prisma.entity.findUnique).mockResolvedValue(existing as never);

      const result = await updateEntity("ent-1", { name: "Specs" }, mockCtx);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe("VALIDATION_ERROR");
        expect(result.error.message).toContain("reserved");
      }
      expect(mockTx.entity.update).not.toHaveBeenCalled();
    });

    it("renames through the registry (excluding the entity itself) inside the tenant lock", async () => {
      vi.mocked(prisma.entity.findUnique).mockResolvedValue(existing as never);
      mockTx.entity.update.mockResolvedValue({ ...existing, name: "CustomerV2" } as never);

      const result = await updateEntity("ent-1", { name: "CustomerV2" }, mockCtx);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.name).toBe("CustomerV2");
      }
      expect(mockAssertNameAvailable).toHaveBeenCalledWith(mockTx, {
        name: "CustomerV2",
        tenantId: "tenant-1",
        domainId: "dom-1",
        productId: "prd-1",
        exclude: { kind: "entity", id: "ent-1" },
      });
      expect(mockTx.entity.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: "ent-1" }, data: expect.objectContaining({ name: "CustomerV2" }) })
      );
      expect(prisma.entity.update).not.toHaveBeenCalled();
    });

    it("returns the registry conflict and does not rename", async () => {
      vi.mocked(prisma.entity.findUnique).mockResolvedValue(existing as never);
      mockAssertNameAvailable.mockResolvedValue({ success: false, error: CONFLICT_ERROR });

      const result = await updateEntity("ent-1", { name: "Order" }, mockCtx);

      expect(result).toEqual({ success: false, error: CONFLICT_ERROR });
      expect(mockTx.entity.update).not.toHaveBeenCalled();
      expect(prisma.auditLog.create).not.toHaveBeenCalled();
    });

    it("skips the registry when the name is unchanged", async () => {
      vi.mocked(prisma.entity.findUnique).mockResolvedValue(existing as never);
      vi.mocked(prisma.entity.update).mockResolvedValue({ ...existing, description: "d" } as never);

      const result = await updateEntity("ent-1", { name: "Customer", description: "d" }, mockCtx);

      expect(result.success).toBe(true);
      expect(mockAssertNameAvailable).not.toHaveBeenCalled();
      expect(prisma.entity.update).toHaveBeenCalled();
      expect(mockTx.entity.update).not.toHaveBeenCalled();
    });

    it("skips the registry when no name is supplied", async () => {
      vi.mocked(prisma.entity.findUnique).mockResolvedValue(existing as never);
      vi.mocked(prisma.entity.update).mockResolvedValue({ ...existing, description: "d" } as never);

      const result = await updateEntity("ent-1", { description: "d" }, mockCtx);

      expect(result.success).toBe(true);
      expect(mockAssertNameAvailable).not.toHaveBeenCalled();
    });

    it("flags the draft when the description changes", async () => {
      vi.mocked(prisma.entity.findUnique).mockResolvedValue({ ...existing, description: "", metadata: null } as never);
      vi.mocked(prisma.entity.update).mockResolvedValue({ ...existing, description: "d" } as never);

      await updateEntity("ent-1", { description: "d" }, mockCtx);

      expect(prisma.entity.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ description: "d", hasUnpublishedChanges: true }) })
      );
    });

    it("does not flag the draft on a status-only change", async () => {
      vi.mocked(prisma.entity.findUnique).mockResolvedValue({ ...existing, description: "", metadata: null } as never);
      vi.mocked(prisma.entity.update).mockResolvedValue({ ...existing, status: "ACTIVE" } as never);

      const result = await updateEntity("ent-1", { status: "ACTIVE" }, mockCtx);

      expect(result.success).toBe(true);
      const call = vi.mocked(prisma.entity.update).mock.calls[0][0] as { data: Record<string, unknown> };
      expect(call.data).not.toHaveProperty("hasUnpublishedChanges");
    });

    it("keeps metadata.sourceStale when the caller replaces metadata with a copy that lacks it", async () => {
      vi.mocked(prisma.entity.findUnique).mockResolvedValue({
        ...existing, description: "", metadata: { tags: [], sourceStale: true },
      } as never);
      vi.mocked(prisma.entity.update).mockResolvedValue({ ...existing, status: "DEPRECATED" } as never);

      await updateEntity("ent-1", { metadata: { tags: ["sales"] } }, mockCtx);

      const call = vi.mocked(prisma.entity.update).mock.calls[0][0] as { data: { metadata: Record<string, unknown> } };
      expect(call.data.metadata).toEqual({ tags: ["sales"], sourceStale: true });
    });

    it("does not invent sourceStale when the stored metadata is not stale", async () => {
      vi.mocked(prisma.entity.findUnique).mockResolvedValue({ ...existing, description: "", metadata: { tags: [] } } as never);
      vi.mocked(prisma.entity.update).mockResolvedValue({ ...existing, status: "DEPRECATED" } as never);

      await updateEntity("ent-1", { metadata: { tags: ["sales"] } }, mockCtx);

      const call = vi.mocked(prisma.entity.update).mock.calls[0][0] as { data: { metadata: Record<string, unknown> } };
      expect(call.data.metadata).toEqual({ tags: ["sales"] });
    });
  });

  describe("deleteEntity", () => {
    it("returns success on delete", async () => {
      vi.mocked(prisma.entity.findUnique).mockResolvedValue({
        id: "ent-1",
        name: "Customer",
      } as never);
      vi.mocked(prisma.entity.delete).mockResolvedValue({} as never);

      const result = await deleteEntity("ent-1", mockCtx);
      expect(result.success).toBe(true);
    });

    it("returns not-found error for missing entity", async () => {
      vi.mocked(prisma.entity.findUnique).mockResolvedValue(null);

      const result = await deleteEntity("nonexistent", mockCtx);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe("NOT_FOUND");
      }
    });
  });
});

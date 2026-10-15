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
    message: { findMany: vi.fn().mockResolvedValue([]) },
    trait: { findMany: vi.fn().mockResolvedValue([]) },
    entityVersion: { findMany: vi.fn().mockResolvedValue([]) },
    schemaReference: { findMany: vi.fn().mockResolvedValue([]) },
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
import { GENERIC_ACTION_ERROR } from "@/types/action-result";
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

    it("flags the draft and marks the stored source stale when the description changes (R45)", async () => {
      vi.mocked(prisma.entity.findUnique).mockResolvedValue({ ...existing, description: "", metadata: null } as never);
      vi.mocked(prisma.entity.update).mockResolvedValue({ ...existing, description: "d" } as never);

      await updateEntity("ent-1", { description: "d" }, mockCtx);

      expect(prisma.entity.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            description: "d",
            hasUnpublishedChanges: true,
            metadata: { sourceStale: true },
          }),
        })
      );
    });

    it("a rename marks the stored source stale, keeping the other metadata (R45)", async () => {
      vi.mocked(prisma.entity.findUnique).mockResolvedValue({
        ...existing, description: "", metadata: { tags: ["a"], schemaVersions: { avro: [] } },
      } as never);
      mockTx.entity.update.mockResolvedValue({ ...existing, name: "CustomerV2" } as never);

      await updateEntity("ent-1", { name: "CustomerV2" }, mockCtx);

      expect(mockTx.entity.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            name: "CustomerV2",
            hasUnpublishedChanges: true,
            metadata: { tags: ["a"], schemaVersions: { avro: [] }, sourceStale: true },
          }),
        })
      );
    });

    it("a tags edit marks the stored source stale", async () => {
      vi.mocked(prisma.entity.findUnique).mockResolvedValue({ ...existing, description: "", metadata: { tags: [] } } as never);
      vi.mocked(prisma.entity.update).mockResolvedValue({ ...existing } as never);

      await updateEntity("ent-1", { metadata: { tags: ["sales"] } }, mockCtx);

      const call = vi.mocked(prisma.entity.update).mock.calls[0][0] as { data: { metadata: Record<string, unknown> } };
      expect(call.data.metadata).toEqual({ tags: ["sales"], sourceStale: true });
    });

    it("does not flag the draft or touch metadata on a status-only change", async () => {
      vi.mocked(prisma.entity.findUnique).mockResolvedValue({ ...existing, description: "", metadata: null } as never);
      vi.mocked(prisma.entity.update).mockResolvedValue({ ...existing, status: "ACTIVE" } as never);

      const result = await updateEntity("ent-1", { status: "ACTIVE" }, mockCtx);

      expect(result.success).toBe(true);
      const call = vi.mocked(prisma.entity.update).mock.calls[0][0] as { data: Record<string, unknown> };
      expect(call.data).not.toHaveProperty("hasUnpublishedChanges");
      expect(call.data.metadata).toBeUndefined();
    });

    it("a lifecycle-only metadata change (deprecation) neither flags the draft nor invents sourceStale", async () => {
      vi.mocked(prisma.entity.findUnique).mockResolvedValue({
        ...existing, status: "ACTIVE", description: "", metadata: { tags: [] },
      } as never);
      vi.mocked(prisma.entity.update).mockResolvedValue({ ...existing, status: "DEPRECATED" } as never);

      await updateEntity(
        "ent-1",
        { status: "DEPRECATED", metadata: { tags: [], deprecation: { deprecated: true } } },
        mockCtx
      );

      const call = vi.mocked(prisma.entity.update).mock.calls[0][0] as { data: Record<string, unknown> };
      expect(call.data).not.toHaveProperty("hasUnpublishedChanges");
      expect(call.data.metadata).toEqual({ tags: [], deprecation: { deprecated: true } });
    });

    it("keeps metadata.sourceStale when the caller replaces metadata with a copy that lacks it, even for a lifecycle-only change", async () => {
      vi.mocked(prisma.entity.findUnique).mockResolvedValue({
        ...existing, status: "ACTIVE", description: "", metadata: { tags: [], sourceStale: true },
      } as never);
      vi.mocked(prisma.entity.update).mockResolvedValue({ ...existing, status: "DEPRECATED" } as never);

      await updateEntity(
        "ent-1",
        { status: "DEPRECATED", metadata: { tags: [], deprecation: { deprecated: true } } },
        mockCtx
      );

      const call = vi.mocked(prisma.entity.update).mock.calls[0][0] as { data: { metadata: Record<string, unknown> } };
      expect(call.data.metadata).toEqual({ tags: [], deprecation: { deprecated: true }, sourceStale: true });
    });
  });


  describe("deleteEntity", () => {
    const existing = { id: "ent-1", name: "Order", tenantId: "tenant-1" };
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fkError = () => Object.assign(new Error("Foreign key constraint violated on the constraint: `messages_payloadEntityId_fkey`"), { code: "P2003" });
    const rawQuery = (state: string) =>
      Object.assign(new Error('Raw query failed. relation "entities" deadlock'), { code: "P2010", meta: { driverAdapterError: { cause: { originalCode: state } } } });
    const deleteAudits = () =>
      vi.mocked(prisma.auditLog.create).mock.calls.filter(([args]) => (args as { data: { action: string } }).data.action === "DELETE");

    beforeEach(() => {
      consoleError.mockClear();
      vi.mocked(prisma.entity.findUnique).mockResolvedValue(existing as never);
      vi.mocked(prisma.entity.delete).mockResolvedValue({} as never);
      vi.mocked(prisma.message.findMany).mockResolvedValue([]);
      vi.mocked(prisma.trait.findMany).mockResolvedValue([]);
      vi.mocked(prisma.entityVersion.findMany).mockResolvedValue([]);
      vi.mocked(prisma.schemaReference.findMany).mockResolvedValue([]);
    });

    it("returns success on delete, after checking pins (tenant-scoped) and referencing entities", async () => {
      const result = await deleteEntity("ent-1", mockCtx);
      expect(result.success).toBe(true);
      expect(prisma.message.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ tenantId: "tenant-1" }) }));
      expect(prisma.entityVersion.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { entityId: "ent-1" } }));
      expect(prisma.entity.delete).toHaveBeenCalledWith({ where: { id: "ent-1" } });
      expect(deleteAudits()).toHaveLength(1);
    });

    it("returns not-found error for missing entity", async () => {
      vi.mocked(prisma.entity.findUnique).mockResolvedValue(null);

      const result = await deleteEntity("nonexistent", mockCtx);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe("NOT_FOUND");
      }
      expect(prisma.entity.delete).not.toHaveBeenCalled();
    });

    describe("an entity-version reference (no FK) blocks the delete BEFORE it is attempted", () => {
      it("returns IN_USE naming the referencing entity + versions; nothing is deleted or audited", async () => {
        vi.mocked(prisma.entityVersion.findMany)
          .mockResolvedValueOnce([{ id: "ev-money-1" }] as never) // this entity's versions
          .mockResolvedValueOnce([{ major: 1, minor: 0, entity: { id: "ent-cart", name: "Cart" } }] as never); // the edge source
        vi.mocked(prisma.schemaReference.findMany).mockResolvedValueOnce([{ fromId: "ev-cart-1" }] as never);

        const result = await deleteEntity("ent-1", mockCtx);

        expect(result).toMatchObject({
          success: false,
          error: {
            code: "IN_USE",
            message: 'Entity "Order" cannot be deleted: it is referenced by published versions of Entity "Cart" (v1.0).',
            details: { entities: [{ id: "ent-cart", name: "Cart", versions: ["1.0"] }] },
          },
        });
        expect(prisma.schemaReference.findMany).toHaveBeenCalledWith(
          expect.objectContaining({ where: expect.objectContaining({ fromKind: "ENTITY_VERSION", toKind: "ENTITY_VERSION", toId: { in: ["ev-money-1"] } }) })
        );
        expect(prisma.entity.delete).not.toHaveBeenCalled();
        expect(deleteAudits()).toHaveLength(0);
      });
    });

    describe("when a foreign key blocks the delete (P2003)", () => {
      it("returns IN_USE naming the messages and traits that pin the entity", async () => {
        vi.mocked(prisma.entity.delete).mockRejectedValueOnce(fkError());
        // the pre-delete check finds nothing (the pin landed meanwhile), the post-P2003 check does
        vi.mocked(prisma.message.findMany).mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: "m1", name: "OrderCreated" }] as never);
        vi.mocked(prisma.trait.findMany).mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: "t1", name: "CloudEvents" }] as never);

        const result = await deleteEntity("ent-1", mockCtx);
        expect(result).toMatchObject({
          success: false,
          error: {
            code: "IN_USE",
            message: 'Entity "Order" cannot be deleted: it is used by Message "OrderCreated" and Trait "CloudEvents".',
            details: { messages: [{ id: "m1", name: "OrderCreated" }], traits: [{ id: "t1", name: "CloudEvents" }], entities: [] },
          },
        });
        expect(deleteAudits()).toHaveLength(0);
      });

      it("returns a generic IN_USE (never the driver text) when no pin explains it", async () => {
        vi.mocked(prisma.entity.delete).mockRejectedValueOnce(fkError());
        const result = await deleteEntity("ent-1", mockCtx);
        expect(result).toEqual({
          success: false,
          error: { code: "IN_USE", message: "This entity is referenced by another record and cannot be deleted.", suggestedFix: "Remove the references first." },
        });
      });
    });

    describe("never throws and never carries driver text", () => {
      it("a lock timeout / deadlock / expired transaction is a retryable CONFLICT without a pin lookup", async () => {
        for (const error of [rawQuery("40P01"), rawQuery("55P03"), rawQuery("40001"), Object.assign(new Error("Transaction API error"), { code: "P2028" })]) {
          vi.mocked(prisma.message.findMany).mockClear();
          vi.mocked(prisma.entity.delete).mockRejectedValueOnce(error);
          const result = await deleteEntity("ent-1", mockCtx);
          expect(result).toEqual({
            success: false,
            error: { code: "CONFLICT", message: "Entity changed concurrently, try again", suggestedFix: "Reload and try deleting again." },
          });
          // the one pre-delete check ran; the failure path did not look for pins again
          expect(prisma.message.findMany).toHaveBeenCalledTimes(1);
        }
      });

      it("any other database error is a DB_ERROR with the generic message; the original is only logged", async () => {
        const error = new Error("connection lost to 10.0.0.5:5432");
        vi.mocked(prisma.entity.delete).mockRejectedValueOnce(error);
        const result = await deleteEntity("ent-1", mockCtx);
        expect(result).toEqual({ success: false, error: { code: "DB_ERROR", message: GENERIC_ACTION_ERROR } });
        expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("deleteEntity ent-1"), error);
      });

      it("a failing lookup of the entity itself or of its pins is a DB_ERROR, not a throw", async () => {
        vi.mocked(prisma.entity.findUnique).mockRejectedValueOnce(new Error("pool exhausted"));
        expect(await deleteEntity("ent-1", mockCtx)).toEqual({ success: false, error: { code: "DB_ERROR", message: GENERIC_ACTION_ERROR } });

        vi.mocked(prisma.schemaReference.findMany).mockRejectedValueOnce(new Error("relation schema_references does not exist"));
        vi.mocked(prisma.entityVersion.findMany).mockResolvedValueOnce([{ id: "ev1" }] as never);
        expect(await deleteEntity("ent-1", mockCtx)).toEqual({ success: false, error: { code: "DB_ERROR", message: GENERIC_ACTION_ERROR } });
        expect(prisma.entity.delete).not.toHaveBeenCalled();
      });

      it("a session whose user no longer exists is UNAUTHORIZED", async () => {
        (prisma as unknown as { user: unknown }).user = { findUnique: vi.fn().mockResolvedValue(null) };
        try {
          const result = await deleteEntity("ent-1", mockCtx);
          expect(result).toMatchObject({ success: false, error: { code: "UNAUTHORIZED" } });
          expect(prisma.entity.delete).not.toHaveBeenCalled();
        } finally {
          delete (prisma as unknown as { user?: unknown }).user;
        }
      });
    });
  });
});

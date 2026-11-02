import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    entity: { findUnique: vi.fn(), update: vi.fn() },
    $executeRawUnsafe: vi.fn(),
    field: {
      create: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    auditLog: { create: vi.fn().mockResolvedValue({ id: "audit-1" }) },
    $transaction: vi.fn(),
  },
}));

import {
  createField,
  updateField,
  deleteField,
  reorderFields,
} from "@/services/field.service";
import { prisma } from "@/lib/db";
import { MARK_DRAFT_CHANGED_SQL } from "@/lib/entity-versioning/draft-state";
import type { ServiceContext } from "@/types/service-context";

const mockCtx: ServiceContext = {
  userId: "user-1",
  userRole: "AUTHOR",
  prisma: prisma as unknown as ServiceContext["prisma"],
};

describe("Field Service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // The field write and the draft mark run as one `$transaction([...])` batch: resolve every operation, in order.
    vi.mocked(prisma.$transaction).mockImplementation((async (ops: Promise<unknown>[]) => Promise.all(ops)) as never);
  });

  describe("createField", () => {
    it("returns success with correct sortOrder (max + 1)", async () => {
      vi.mocked(prisma.entity.findUnique).mockResolvedValue({ id: "ent-1" } as never);
      vi.mocked(prisma.field.findFirst).mockResolvedValue({ sortOrder: 2 } as never);
      vi.mocked(prisma.field.create).mockResolvedValue({
        id: "fld-1",
        name: "email",
        type: "string",
        sortOrder: 3,
      } as never);

      const result = await createField(
        "ent-1",
        { name: "email", type: "string" },
        mockCtx
      );

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.sortOrder).toBe(3);
      }
    });

    it("returns error for invalid decorators", async () => {
      vi.mocked(prisma.entity.findUnique).mockResolvedValue({ id: "ent-1" } as never);

      const result = await createField(
        "ent-1",
        {
          name: "email",
          type: "string",
          decorators: { classification: { level: "INVALID" } } as never,
        },
        mockCtx
      );

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe("VALIDATION_ERROR");
        expect(result.error.suggestedFix).toBeDefined();
      }
    });

    it("returns error for duplicate field name", async () => {
      vi.mocked(prisma.entity.findUnique).mockResolvedValue({ id: "ent-1" } as never);
      vi.mocked(prisma.field.findFirst).mockResolvedValue(null);
      vi.mocked(prisma.field.create).mockRejectedValue(
        new Error("Unique constraint failed on the constraint: `fields_entityId_name_key`")
      );

      const result = await createField(
        "ent-1",
        { name: "email", type: "string" },
        mockCtx
      );

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe("DUPLICATE");
      }
    });

    it("returns error when entity not found", async () => {
      vi.mocked(prisma.entity.findUnique).mockResolvedValue(null);

      const result = await createField(
        "nonexistent",
        { name: "email", type: "string" },
        mockCtx
      );

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe("NOT_FOUND");
      }
    });
  });

  describe("updateField", () => {
    it("returns updated field", async () => {
      vi.mocked(prisma.field.findUnique).mockResolvedValue({
        id: "fld-1",
        name: "email",
      } as never);
      vi.mocked(prisma.field.update).mockResolvedValue({
        id: "fld-1",
        name: "email_address",
      } as never);

      const result = await updateField(
        "fld-1",
        { name: "email_address" },
        mockCtx
      );

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.name).toBe("email_address");
      }
    });
  });

  describe("deleteField", () => {
    it("returns success on delete", async () => {
      vi.mocked(prisma.field.findUnique).mockResolvedValue({
        id: "fld-1",
      } as never);
      vi.mocked(prisma.field.delete).mockResolvedValue({} as never);

      const result = await deleteField("fld-1", mockCtx);
      expect(result.success).toBe(true);
    });
  });

  describe("reorderFields", () => {
    it("updates sortOrder for all fields", async () => {
      vi.mocked(prisma.field.findMany).mockResolvedValue([
        { id: "fld-1", sortOrder: 0 },
        { id: "fld-2", sortOrder: 1 },
        { id: "fld-3", sortOrder: 2 },
      ] as never);
      vi.mocked(prisma.$transaction).mockResolvedValue([]);

      const result = await reorderFields(
        "ent-1",
        ["fld-3", "fld-1", "fld-2"],
        mockCtx
      );

      expect(result.success).toBe(true);
      expect(prisma.$transaction).toHaveBeenCalled();
    });

    it("returns error for field not belonging to entity", async () => {
      vi.mocked(prisma.field.findMany).mockResolvedValue([
        { id: "fld-1", sortOrder: 0 },
      ] as never);

      const result = await reorderFields(
        "ent-1",
        ["fld-1", "fld-unknown"],
        mockCtx
      );

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe("VALIDATION_ERROR");
      }
    });
  });

  describe("draft tracking", () => {
    it("createField marks the draft changed and the source stale", async () => {
      vi.mocked(prisma.entity.findUnique).mockResolvedValue({ id: "ent-1" } as never);
      vi.mocked(prisma.field.findFirst).mockResolvedValue(null);
      vi.mocked(prisma.field.create).mockResolvedValue({ id: "fld-1", entityId: "ent-1" } as never);
      await createField("ent-1", { name: "email", type: "string" }, mockCtx);
      expect(prisma.$executeRawUnsafe).toHaveBeenCalledWith(MARK_DRAFT_CHANGED_SQL, "ent-1");
    });

    it("updateField marks the draft changed and the source stale", async () => {
      vi.mocked(prisma.field.findUnique).mockResolvedValue({ id: "fld-1", entityId: "ent-1", name: "email" } as never);
      vi.mocked(prisma.field.update).mockResolvedValue({ id: "fld-1" } as never);
      await updateField("fld-1", { description: "Primary email" }, mockCtx);
      expect(prisma.$executeRawUnsafe).toHaveBeenCalledWith(MARK_DRAFT_CHANGED_SQL, "ent-1");
    });

    it("deleteField marks the draft changed and the source stale", async () => {
      vi.mocked(prisma.field.findUnique).mockResolvedValue({ id: "fld-1", entityId: "ent-1", name: "email" } as never);
      vi.mocked(prisma.field.delete).mockResolvedValue({ id: "fld-1" } as never);
      await deleteField("fld-1", mockCtx);
      expect(prisma.$executeRawUnsafe).toHaveBeenCalledWith(MARK_DRAFT_CHANGED_SQL, "ent-1");
    });

    it("reorderFields marks the draft changed and the source stale", async () => {
      vi.mocked(prisma.field.findMany).mockResolvedValue([{ id: "fld-1", sortOrder: 0 }] as never);
      vi.mocked(prisma.$transaction).mockResolvedValue([]);
      await reorderFields("ent-1", ["fld-1"], mockCtx);
      expect(prisma.$executeRawUnsafe).toHaveBeenCalledWith(MARK_DRAFT_CHANGED_SQL, "ent-1");
    });

    it("records the REORDER row under the entity's tenant (its id is the entity's, so the tenant is not found from a field)", async () => {
      vi.mocked(prisma.field.findMany).mockResolvedValue([{ id: "fld-1", sortOrder: 0 }] as never);
      vi.mocked(prisma.entity.findUnique).mockResolvedValue({ tenantId: "tenant-1" } as never);
      vi.mocked(prisma.$transaction).mockResolvedValue([]);
      await reorderFields("ent-1", ["fld-1"], mockCtx);
      expect(prisma.auditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ action: "REORDER", entityType: "Field", entityId: "ent-1", tenantId: "tenant-1" }),
      });
    });
  });

  /**
   * The field write and the draft + stale-source mark must be ONE atomic batch. The fake below models Prisma's lazy
   * operations: a write only takes effect when it is AWAITED, and `$transaction([...])` rolls every effect back when
   * a later operation rejects. A service that awaited the field write on its own, then marked the draft separately, would
   * leave the committed write behind when the mark fails (a changed field with `hasUnpublishedChanges` still false, so
   * publish would answer NO_CHANGES).
   */
  describe("atomic field writes", () => {
    let committed: string[];

    const lazy = (label: string, effect?: () => void, result: unknown = { id: "fld-1", entityId: "ent-1" }) =>
      ({
        then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
          Promise.resolve()
            .then(() => {
              if (effect) effect();
              committed.push(label);
              return result;
            })
            .then(resolve, reject),
      }) as unknown as Promise<unknown>;

    beforeEach(() => {
      committed = [];
      vi.mocked(prisma.$transaction).mockImplementation((async (ops: Promise<unknown>[]) => {
        const snapshot = [...committed];
        try {
          const out: unknown[] = [];
          for (const op of ops) out.push(await op);
          return out;
        } catch (e) {
          committed.length = 0;
          committed.push(...snapshot);
          throw e;
        }
      }) as never);
      vi.mocked(prisma.$executeRawUnsafe).mockImplementation((() =>
        lazy("mark", () => {
          throw new Error("connection lost");
        })) as never);
      vi.mocked(prisma.entity.findUnique).mockResolvedValue({ id: "ent-1" } as never);
      vi.mocked(prisma.field.findFirst).mockResolvedValue(null);
      vi.mocked(prisma.field.findUnique).mockResolvedValue({ id: "fld-1", entityId: "ent-1", name: "email" } as never);
      vi.mocked(prisma.field.findMany).mockResolvedValue([{ id: "fld-1", sortOrder: 0 }] as never);
      vi.mocked(prisma.field.create).mockImplementation((() => lazy("create-field")) as never);
      vi.mocked(prisma.field.update).mockImplementation((() => lazy("update-field")) as never);
      vi.mocked(prisma.field.delete).mockImplementation((() => lazy("delete-field")) as never);
    });

    it("createField: a failing mark rolls the new field back", async () => {
      await expect(createField("ent-1", { name: "email", type: "string" }, mockCtx)).rejects.toThrow("connection lost");
      expect(committed).toEqual([]);
    });

    it("updateField: a failing mark rolls the field change back", async () => {
      await expect(updateField("fld-1", { description: "x" }, mockCtx)).rejects.toThrow("connection lost");
      expect(committed).toEqual([]);
    });

    it("deleteField: a failing mark rolls the delete back", async () => {
      await expect(deleteField("fld-1", mockCtx)).rejects.toThrow("connection lost");
      expect(committed).toEqual([]);
    });

    it("reorderFields: a failing mark rolls every sortOrder write back", async () => {
      await expect(reorderFields("ent-1", ["fld-1"], mockCtx)).rejects.toThrow("connection lost");
      expect(committed).toEqual([]);
    });

    it("on success the field write and the mark are committed together, in one batch", async () => {
      vi.mocked(prisma.$executeRawUnsafe).mockImplementation((() => lazy("mark")) as never);
      const result = await updateField("fld-1", { description: "x" }, mockCtx);
      expect(result.success).toBe(true);
      expect(committed).toEqual(["update-field", "mark"]);
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(vi.mocked(prisma.$transaction).mock.calls[0][0]).toHaveLength(2);
    });
  });
});

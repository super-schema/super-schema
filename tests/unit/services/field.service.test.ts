import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    entity: { findUnique: vi.fn() },
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
import type { ServiceContext } from "@/types/service-context";

const mockCtx: ServiceContext = {
  userId: "user-1",
  userRole: "AUTHOR",
  prisma: prisma as unknown as ServiceContext["prisma"],
};

describe("Field Service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
});

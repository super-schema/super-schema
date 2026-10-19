import { describe, it, expect, vi, beforeEach } from "vitest";

// The service behind the field API refuses a field name the AsyncAPI parser cannot read (`PARSER_UNSAFE_KEYS`), so a caller that skips the
// UI action cannot bypass the rule.

vi.mock("@/lib/db", () => ({
  prisma: {
    entity: { findUnique: vi.fn(), update: vi.fn() },
    $executeRawUnsafe: vi.fn(),
    field: { create: vi.fn(), findFirst: vi.fn(), findUnique: vi.fn(), findMany: vi.fn(), update: vi.fn(), delete: vi.fn() },
    auditLog: { create: vi.fn().mockResolvedValue({ id: "audit-1" }) },
    $transaction: vi.fn(),
  },
}));

import { createField, updateField } from "@/services/field.service";
import { prisma } from "@/lib/db";
import type { ServiceContext } from "@/types/service-context";

const ctx: ServiceContext = { userId: "user-1", userRole: "AUTHOR", prisma: prisma as unknown as ServiceContext["prisma"] };
const MESSAGE = '"hasOwnProperty" is a reserved name: AsyncAPI documents cannot contain it. Choose another field name.';

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(prisma.$transaction).mockImplementation((async (ops: Promise<unknown>[]) => Promise.all(ops)) as never);
  vi.mocked(prisma.entity.findUnique).mockResolvedValue({ id: "ent-1" } as never);
  vi.mocked(prisma.field.findFirst).mockResolvedValue(null);
  vi.mocked(prisma.field.create).mockResolvedValue({ id: "fld-1", name: "x" } as never);
  vi.mocked(prisma.field.findUnique).mockResolvedValue({ id: "fld-1", entityId: "ent-1", name: "email" } as never);
  vi.mocked(prisma.field.update).mockResolvedValue({ id: "fld-1" } as never);
});

const nothingWritten = () => {
  expect(prisma.field.create).not.toHaveBeenCalled();
  expect(prisma.field.update).not.toHaveBeenCalled();
  expect(prisma.$transaction).not.toHaveBeenCalled();
};

describe("createField", () => {
  it.each(["hasOwnProperty", "  hasOwnProperty  "])("refuses the name %j with VALIDATION_ERROR and the reserved-name message, and writes nothing", async (name) => {
    const result = await createField("ent-1", { name, type: "string" }, ctx);
    expect(result).toMatchObject({ success: false, error: { code: "VALIDATION_ERROR", message: MESSAGE } });
    if (!result.success) expect(result.error.suggestedFix).toBeDefined();
    nothingWritten();
  });

  it.each(["hasownproperty", "HasOwnProperty", "hasOwnProperty2"])("accepts %j", async (name) => {
    expect((await createField("ent-1", { name, type: "string" }, ctx)).success).toBe(true);
    expect(prisma.field.create).toHaveBeenCalledTimes(1);
  });
});

describe("updateField", () => {
  it.each(["hasOwnProperty", " hasOwnProperty "])("refuses renaming a field to %j", async (name) => {
    const result = await updateField("fld-1", { name }, ctx);
    expect(result).toMatchObject({ success: false, error: { code: "VALIDATION_ERROR", message: MESSAGE } });
    nothingWritten();
  });

  it("accepts a rename to a look-alike, and an update that keeps an old reserved name", async () => {
    expect((await updateField("fld-1", { name: "hasownproperty" }, ctx)).success).toBe(true);
    vi.mocked(prisma.field.findUnique).mockResolvedValue({ id: "fld-1", entityId: "ent-1", name: "hasOwnProperty" } as never);
    expect((await updateField("fld-1", { name: "hasOwnProperty", description: "legacy" }, ctx)).success).toBe(true);
    expect(prisma.field.update).toHaveBeenCalledTimes(2);
  });
});

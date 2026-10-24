import { beforeEach, describe, expect, it, vi } from "vitest";

// The precision and scale of a decimal field live in two columns of the row, not in the TypeSpec text. When a TypeSpec save changes the
// type of a decimal field to one that is not a decimal, the pair has no meaning any more: it must go with the type (a string field that
// still says `(12,2)` is a lie that the table comment of a DB emitter and the review screens would repeat). A save that keeps the type
// decimal leaves the pair alone: the text cannot say it, so the text cannot unsay it.

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    entity: { findUnique: vi.fn(), update: vi.fn() },
    field: { findFirst: vi.fn(), findUnique: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
    auditLog: { create: vi.fn() },
    $executeRawUnsafe: vi.fn(),
    $transaction: vi.fn(),
  },
}));

vi.mock("@/lib/db", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/auth", () => ({ auth: vi.fn().mockResolvedValue({ user: { id: "user-1" } }) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/active-tenant", () => ({ getActiveTenantId: vi.fn().mockResolvedValue("tenant-1") }));
vi.mock("@/lib/compiler/typespec-compiler", () => ({ compileTypeSpecWithGovernance: vi.fn() }));

import { applyTypeSpecAction } from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/actions";

const stored = (type: string, precision: number | null, scale: number | null) => ({
  id: "fld-1",
  entityId: "ent-1",
  name: "total",
  slug: "total",
  sortOrder: 0,
  fieldNumber: 1,
  type,
  nullable: true,
  isKey: false,
  description: "",
  classification: null,
  decorators: {},
  precision,
  scale,
});
const parsed = (type: string) => ({ name: "total", type, isOptional: true, isKey: false, decorators: {} });

const updateData = () => {
  expect(mockPrisma.field.update).toHaveBeenCalledTimes(1);
  return mockPrisma.field.update.mock.calls[0][0].data as Record<string, unknown>;
};

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.auditLog.create.mockResolvedValue({ id: "audit-1" });
  mockPrisma.entity.findUnique.mockResolvedValue({ id: "ent-1", tenantId: "tenant-1", metadata: {} });
  mockPrisma.field.update.mockResolvedValue({ id: "fld-1" });
  mockPrisma.$transaction.mockImplementation(async (ops: unknown[]) => Promise.all(ops));
});

describe("a TypeSpec save and the precision and scale of a decimal field", () => {
  it.each(["string", "int32", "float64", "boolean", "utcDateTime"])("clears precision and scale when decimal becomes %s", async (type) => {
    mockPrisma.field.findMany.mockResolvedValue([stored("decimal", 12, 2)]);
    expect(await applyTypeSpecAction("ent-1", [parsed(type)])).toEqual({ added: 0, updated: 1, removed: [] });
    expect(updateData()).toMatchObject({ precision: null, scale: null });
  });

  it("clears them when decimal128 becomes a non-decimal type too", async () => {
    mockPrisma.field.findMany.mockResolvedValue([stored("decimal128", 34, 10)]);
    await applyTypeSpecAction("ent-1", [parsed("string")]);
    expect(updateData()).toMatchObject({ precision: null, scale: null });
  });

  it("keeps them when the type stays decimal (the text cannot say them), and writes nothing for an unchanged field", async () => {
    mockPrisma.field.findMany.mockResolvedValue([stored("decimal", 12, 2)]);
    expect(await applyTypeSpecAction("ent-1", [parsed("decimal")])).toEqual({ added: 0, updated: 0, removed: [] });
    expect(mockPrisma.field.update).not.toHaveBeenCalled();
  });

  it("keeps them when decimal becomes decimal128 (both are decimals), while the other changes of the row are written", async () => {
    mockPrisma.field.findMany.mockResolvedValue([stored("decimal", 12, 2)]);
    await applyTypeSpecAction("ent-1", [parsed("decimal128")]);
    const data = updateData();
    expect(data).toMatchObject({ type: "decimal128" });
    expect(data).not.toHaveProperty("precision");
    expect(data).not.toHaveProperty("scale");
  });

  it("does not touch the pair of a field that was never a decimal, or become one", async () => {
    mockPrisma.field.findMany.mockResolvedValue([stored("string", null, null)]);
    await applyTypeSpecAction("ent-1", [parsed("int32")]);
    const data = updateData();
    expect(data).not.toHaveProperty("precision");
    expect(data).not.toHaveProperty("scale");
  });

  it("does not invent a pair when a field becomes a decimal (the person sets it in the field editor)", async () => {
    mockPrisma.field.findMany.mockResolvedValue([stored("string", null, null)]);
    await applyTypeSpecAction("ent-1", [parsed("decimal")]);
    const data = updateData();
    expect(data).toMatchObject({ type: "decimal" });
    expect(data).not.toHaveProperty("precision");
    expect(data).not.toHaveProperty("scale");
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    entity: { findUnique: vi.fn() },
    field: { findUnique: vi.fn(), update: vi.fn() },
    entityVersion: { findUnique: vi.fn() },
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

const { getEffectiveRole } = vi.hoisted(() => ({ getEffectiveRole: vi.fn() }));
vi.mock("@/services/rbac.service", () => ({ getEffectiveRole }));

import { setFieldReferenceAction } from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/actions";

const ENTITIES: Record<string, unknown> = {
  "ent-1": { id: "ent-1", tenantId: "tenant-1" },
  "ent-2": { id: "ent-2", tenantId: "tenant-1", name: "Customer", domain: { name: "Sales" }, product: { name: "Crm" } },
  "ent-x": { id: "ent-x", tenantId: "tenant-2", name: "Foreign", domain: { name: "D" }, product: { name: "P" } },
};

beforeEach(() => {
  vi.clearAllMocks();
  getEffectiveRole.mockResolvedValue({ success: true, data: "AUTHOR" });
  mockPrisma.auditLog.create.mockResolvedValue({ id: "audit-1" });
  mockPrisma.entity.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) => ENTITIES[where.id] ?? null);
  mockPrisma.field.findUnique.mockResolvedValue({
    id: "fld-1",
    entityId: "ent-1",
    type: "reference",
    decorators: { cardinality: "many-to-one", referencedEntityVersion: "1.0" },
    entity: { tenantId: "tenant-1" },
  });
  mockPrisma.field.update.mockResolvedValue({ id: "fld-1" });
  mockPrisma.entityVersion.findUnique.mockResolvedValue({ id: "v1", major: 1, minor: 0 });
  mockPrisma.$transaction.mockImplementation(async (ops: unknown[]) => Promise.all(ops));
});

const written = () => (mockPrisma.field.update.mock.calls[0][0] as { data: { decorators: Record<string, unknown> } }).data.decorators;

describe("setFieldReferenceAction", () => {
  it("stores the qualified reference and id, preserving other decorators, with no version", async () => {
    const r = await setFieldReferenceAction("ent-1", "fld-1", { entityId: "ent-2" });
    expect(r.success).toBe(true);
    expect(written()).toEqual({
      cardinality: "many-to-one",
      referencedEntityId: "ent-2",
      referencedEntityName: "Customer",
      referencedQualifiedName: "Sales/Crm/Customer",
    });
    expect(mockPrisma.$executeRawUnsafe).toHaveBeenCalled();
  });

  it("stores a published pin", async () => {
    const r = await setFieldReferenceAction("ent-1", "fld-1", { entityId: "ent-2", pinnedVersion: "2.1" });
    expect(r.success).toBe(true);
    expect(mockPrisma.entityVersion.findUnique).toHaveBeenCalledWith({
      where: { entityId_major_minor: { entityId: "ent-2", major: 2, minor: 1 } },
    });
    expect(written().referencedEntityVersion).toBe("2.1");
  });

  it("clearing the pin (null) removes referencedEntityVersion", async () => {
    const r = await setFieldReferenceAction("ent-1", "fld-1", { entityId: "ent-2", pinnedVersion: null });
    expect(r.success).toBe(true);
    expect(written()).not.toHaveProperty("referencedEntityVersion");
  });

  it("rejects a cross-tenant target", async () => {
    const r = await setFieldReferenceAction("ent-1", "fld-1", { entityId: "ent-x" });
    expect(r).toMatchObject({ success: false, error: { code: "NOT_FOUND" } });
    expect(mockPrisma.field.update).not.toHaveBeenCalled();
  });

  it("rejects a cross-tenant source entity", async () => {
    const r = await setFieldReferenceAction("ent-x", "fld-1", { entityId: "ent-2" });
    expect(r).toMatchObject({ success: false, error: { code: "NOT_FOUND" } });
    expect(mockPrisma.field.update).not.toHaveBeenCalled();
  });

  it("rejects a pin whose version was never published", async () => {
    mockPrisma.entityVersion.findUnique.mockResolvedValue(null);
    const r = await setFieldReferenceAction("ent-1", "fld-1", { entityId: "ent-2", pinnedVersion: "9.9" });
    expect(r).toMatchObject({ success: false, error: { code: "VALIDATION_ERROR" } });
    expect(mockPrisma.field.update).not.toHaveBeenCalled();
  });

  it("rejects a draft / malformed version pin without a lookup", async () => {
    for (const pin of ["draft", "1.0-draft", "", "0.1"]) {
      const r = await setFieldReferenceAction("ent-1", "fld-1", { entityId: "ent-2", pinnedVersion: pin });
      expect(r).toMatchObject({ success: false, error: { code: "VALIDATION_ERROR" } });
    }
    expect(mockPrisma.entityVersion.findUnique).not.toHaveBeenCalled();
    expect(mockPrisma.field.update).not.toHaveBeenCalled();
  });

  it("rejects a field that belongs to another entity", async () => {
    mockPrisma.field.findUnique.mockResolvedValue({ id: "fld-1", entityId: "ent-other", type: "reference", decorators: {}, entity: { tenantId: "tenant-1" } });
    const r = await setFieldReferenceAction("ent-1", "fld-1", { entityId: "ent-2" });
    expect(r).toMatchObject({ success: false, error: { code: "NOT_FOUND" } });
    expect(mockPrisma.field.update).not.toHaveBeenCalled();
  });

  it("rejects a non-reference field", async () => {
    mockPrisma.field.findUnique.mockResolvedValue({ id: "fld-1", entityId: "ent-1", type: "string", decorators: {}, entity: { tenantId: "tenant-1" } });
    const r = await setFieldReferenceAction("ent-1", "fld-1", { entityId: "ent-2" });
    expect(r).toMatchObject({ success: false, error: { code: "VALIDATION_ERROR" } });
  });

  it("refuses a viewer (and an unassigned user) before reading or writing anything", async () => {
    for (const role of [{ success: true, data: "VIEWER" }, { success: true, data: null }, { success: false, error: { code: "DB_ERROR", message: "x" } }]) {
      getEffectiveRole.mockResolvedValue(role);
      const r = await setFieldReferenceAction("ent-1", "fld-1", { entityId: "ent-2" });
      expect(r).toMatchObject({ success: false, error: { code: "FORBIDDEN" } });
    }
    expect(mockPrisma.field.findUnique).not.toHaveBeenCalled();
    expect(mockPrisma.field.update).not.toHaveBeenCalled();
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it("returns a validation Result for a non-string id instead of a Prisma throw", async () => {
    for (const args of [[undefined, "fld-1", { entityId: "ent-2" }], ["ent-1", 5, { entityId: "ent-2" }], ["ent-1", "fld-1", { entityId: 7 }], ["ent-1", "fld-1", undefined]] as const) {
      const r = await setFieldReferenceAction(...(args as unknown as Parameters<typeof setFieldReferenceAction>));
      expect(r).toMatchObject({ success: false, error: { code: "VALIDATION_ERROR" } });
    }
    expect(mockPrisma.field.findUnique).not.toHaveBeenCalled();
  });

  it("returns a Result failure instead of throwing on a database error", async () => {
    mockPrisma.$transaction.mockRejectedValue(new Error("boom"));
    const r = await setFieldReferenceAction("ent-1", "fld-1", { entityId: "ent-2" });
    expect(r.success).toBe(false);
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

// reorderFieldsAction: the drag reorder of an entity's fields is ONE write (each field that moved and the draft mark in one batch) and ONE
// revalidation, judged over the entity like the other field actions, and it refuses an order that is not exactly the entity's own fields.

const { mockPrisma, mockGetActiveTenantId, mockRevalidatePath } = vi.hoisted(() => ({
  mockGetActiveTenantId: vi.fn(),
  mockRevalidatePath: vi.fn(),
  mockPrisma: {
    entity: { findUnique: vi.fn() },
    field: { findMany: vi.fn(), update: vi.fn() },
    auditLog: { create: vi.fn() },
    $executeRawUnsafe: vi.fn(),
    $transaction: vi.fn(),
  },
}));

vi.mock("@/lib/db", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/access/principal", async () => (await import("../../helpers/access-mocks")).sessionPrincipalModule);
vi.mock("@/lib/auth", () => ({ auth: vi.fn().mockResolvedValue({ user: { id: "user-1" } }) }));
vi.mock("next/cache", () => ({ revalidatePath: mockRevalidatePath }));
vi.mock("@/lib/active-tenant", () => ({ getActiveTenantId: mockGetActiveTenantId }));
vi.mock("@/lib/compiler/typespec-compiler", () => ({ compileTypeSpecWithGovernance: vi.fn() }));

import { MARK_DRAFT_CHANGED_SQL } from "@/lib/entity-versioning/draft-state";
import { GENERIC_ACTION_ERROR } from "@/types/action-result";
import { reorderFieldsAction } from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/actions";
import { assign, resetSessionPrincipal, setSessionPrincipal } from "../../helpers/access-mocks";

const ENTITY_PLACE = { tenantId: "tenant-1", domainId: null, productId: "prod-1", product: { domainId: "dom-1" } };
// Stored order: f1 first, then f2, then f3.
const STORED_FIELDS = [
  { id: "f1", sortOrder: 0 },
  { id: "f2", sortOrder: 1 },
  { id: "f3", sortOrder: 2 },
];

const reorder = (ids: string[]) => reorderFieldsAction("ent-1", ids);

beforeEach(() => {
  vi.clearAllMocks();
  resetSessionPrincipal();
  mockGetActiveTenantId.mockResolvedValue("tenant-1");
  mockPrisma.entity.findUnique.mockResolvedValue(ENTITY_PLACE);
  mockPrisma.field.findMany.mockResolvedValue(STORED_FIELDS);
  mockPrisma.field.update.mockImplementation((args: unknown) => ({ args }));
  mockPrisma.$executeRawUnsafe.mockResolvedValue(0);
  mockPrisma.auditLog.create.mockResolvedValue({ id: "audit-1" });
  mockPrisma.$transaction.mockImplementation(async (ops: unknown[]) => Promise.all(ops));
});

describe("reorderFieldsAction", () => {
  it("writes the position of EVERY field, in ONE batch with the draft mark, and revalidates once", async () => {
    expect(await reorder(["f2", "f1", "f3"])).toEqual({ success: true });

    // Every field gets its index, including f3 which did not move: a batch that wrote only the moved rows could leave two fields on one
    // position when the list it was computed from is stale (see the concurrent-reorder case below).
    expect(mockPrisma.field.update.mock.calls).toEqual([
      [{ where: { id: "f2" }, data: { sortOrder: 0 } }],
      [{ where: { id: "f1" }, data: { sortOrder: 1 } }],
      [{ where: { id: "f3" }, data: { sortOrder: 2 } }],
    ]);
    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
    expect(mockPrisma.$transaction.mock.calls[0][0]).toHaveLength(4);
    expect(mockPrisma.$executeRawUnsafe).toHaveBeenCalledWith(MARK_DRAFT_CHANGED_SQL, "ent-1");
    expect(mockRevalidatePath).toHaveBeenCalledTimes(1);
    expect(mockRevalidatePath).toHaveBeenCalledWith("/schemas");
  });

  it("a reorder computed from a list read before another reorder committed still leaves every position distinct", async () => {
    // A store of sortOrder values that the batches write into. Both reorders read the SAME stored order (the list is read outside the
    // transaction), so the second one is computed from a stale snapshot: [f1, f2, f3] -> [f2, f1, f3], then [f1, f3, f2].
    const store = new Map(STORED_FIELDS.map((f) => [f.id, f.sortOrder]));
    mockPrisma.$transaction.mockImplementation(async (ops: Array<{ args?: { where: { id: string }; data: { sortOrder: number } } }>) => {
      for (const op of ops) if (op.args) store.set(op.args.where.id, op.args.data.sortOrder);
    });

    expect(await reorder(["f2", "f1", "f3"])).toEqual({ success: true });
    expect(await reorder(["f1", "f3", "f2"])).toEqual({ success: true });

    const positions = [...store.values()].sort((a, b) => a - b);
    expect(positions).toEqual([0, 1, 2]);
    expect(store.get("f1")).toBe(0);
    expect(store.get("f3")).toBe(1);
    expect(store.get("f2")).toBe(2);
  });

  it("records ONE Entity UPDATE audit entry carrying the field order before and after", async () => {
    expect(await reorder(["f2", "f1", "f3"])).toEqual({ success: true });

    expect(mockPrisma.auditLog.create).toHaveBeenCalledTimes(1);
    expect(mockPrisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "UPDATE",
        entityType: "Entity",
        entityId: "ent-1",
        userId: "user-1",
        tenantId: "tenant-1",
        beforeState: { fieldOrder: ["f1", "f2", "f3"] },
        afterState: { fieldOrder: ["f2", "f1", "f3"] },
      }),
    });
  });

  it("an order that moves no field writes nothing and does not revalidate", async () => {
    expect(await reorder(["f1", "f2", "f3"])).toEqual({ success: true });
    expect(mockPrisma.field.update).not.toHaveBeenCalled();
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });

  it.each([
    ["a field missing", ["f1", "f2"]],
    ["a field repeated in place of another", ["f1", "f1", "f3"]],
    ["a field of another entity", ["f1", "f2", "f9"]],
    ["an empty list", []],
    ["a blank id", ["f1", "f2", ""]],
  ])("refuses an order with %s, before any write", async (_label, ids) => {
    expect(await reorder(ids)).toEqual({
      error: "The field list has changed since this page was loaded. It is being reloaded; try the move again.",
      code: "VALIDATION_ERROR",
    });
    expect(mockPrisma.field.update).not.toHaveBeenCalled();
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    expect(mockPrisma.auditLog.create).not.toHaveBeenCalled();
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });

  it("refuses a payload that is not a list of ids", async () => {
    for (const ids of ["f1", null, [1, 2, 3], { 0: "f1" }]) {
      expect(await reorderFieldsAction("ent-1", ids as never)).toMatchObject({ code: "VALIDATION_ERROR" });
    }
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it("answers NOT_FOUND for an entity of another tenant, before any of its fields is read", async () => {
    mockPrisma.entity.findUnique.mockResolvedValue({ ...ENTITY_PLACE, tenantId: "tenant-2" });
    expect(await reorder(["f2", "f1", "f3"])).toEqual({ error: "Entity not found", code: "NOT_FOUND" });
    expect(mockPrisma.field.findMany).not.toHaveBeenCalled();
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it("refuses a role that cannot edit the entity (a viewer) before any of its fields is read", async () => {
    setSessionPrincipal([assign.tenant("VIEWER")]);
    expect(await reorder(["f2", "f1", "f3"])).toMatchObject({ code: "FORBIDDEN" });
    expect(mockPrisma.field.findMany).not.toHaveBeenCalled();
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });

  it("a failed write answers the generic error (no driver text) and does not revalidate", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mockPrisma.$transaction.mockRejectedValue(new Error("connect ECONNREFUSED 10.0.0.5:5432"));
    expect(await reorder(["f2", "f1", "f3"])).toEqual({ error: GENERIC_ACTION_ERROR, code: "INTERNAL_ERROR" });
    expect(mockRevalidatePath).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

/**
 * deleteEntityAction guards the delete itself: a message / trait pin (NO ACTION FK → Prisma P2003) and a published
 * version of another entity that references one of its versions (schema_references, no FK) both end in an error that
 * names the referencing records instead of surfacing a raw database message; lock contention is a retryable message.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockPrisma } = await vi.hoisted(async () => {
  const { emptyRegistryDelegates } = await import("../../helpers/registry-mocks");
  return {
    mockPrisma: {
      ...emptyRegistryDelegates(),
      user: { findUnique: vi.fn() },
      entity: { findUnique: vi.fn(), delete: vi.fn(), findMany: vi.fn().mockResolvedValue([]) },
      entityVersion: { findMany: vi.fn() },
      schemaReference: { findMany: vi.fn() },
      auditLog: { create: vi.fn().mockResolvedValue({ id: "audit-1" }) },
    },
  };
});

vi.mock("@/lib/db", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/auth", () => ({
  auth: vi.fn().mockResolvedValue({ user: { id: "user-1", email: "test@example.com", name: "Test User" } }),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/active-tenant", () => ({ getActiveTenantId: vi.fn().mockResolvedValue("tenant-1") }));
vi.mock("@/services/rbac.service", () => ({
  getEffectiveRole: vi.fn().mockResolvedValue({ success: true, data: "AUTHOR" }),
}));

import { revalidatePath } from "next/cache";
import { deleteEntityAction } from "@/app/(dashboard)/schemas/[domainSlug]/actions";
import { GENERIC_ACTION_ERROR } from "@/types/action-result";

const fkError = () => Object.assign(new Error("Foreign key constraint violated on the constraint: `messages_payloadEntityId_fkey`"), { code: "P2003" });
const rawQuery = (state: string) =>
  Object.assign(new Error('Raw query failed. deadlock detected on relation "entities"'), { code: "P2010", meta: { driverAdapterError: { cause: { originalCode: state } } } });
const fn = (mock: unknown) => mock as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.user.findUnique.mockResolvedValue({ id: "user-1" });
  mockPrisma.entity.findUnique.mockResolvedValue({ id: "ent-1", name: "Order", tenantId: "tenant-1" });
  mockPrisma.entity.delete.mockResolvedValue({ id: "ent-1" });
  mockPrisma.auditLog.create.mockResolvedValue({ id: "audit-1" });
  fn(mockPrisma.message.findMany).mockResolvedValue([]);
  fn(mockPrisma.trait.findMany).mockResolvedValue([]);
  mockPrisma.entityVersion.findMany.mockResolvedValue([]);
  mockPrisma.schemaReference.findMany.mockResolvedValue([]);
});

describe("deleteEntityAction — pinned entities", () => {
  it("names the messages and traits that pin the entity instead of the raw FK error, with the remedy", async () => {
    mockPrisma.entity.delete.mockRejectedValueOnce(fkError());
    // nothing at the pre-delete check; the pin landed before the delete, so the post-P2003 check finds it
    fn(mockPrisma.message.findMany).mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: "m1", name: "OrderCreated" }]);
    fn(mockPrisma.trait.findMany).mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: "t1", name: "CloudEvents" }]);

    const result = await deleteEntityAction("ent-1");

    expect(result).toEqual({
      error:
        'Entity "Order" cannot be deleted: it is used by Message "OrderCreated" and Trait "CloudEvents". Re-pin or delete those messages and traits first, then delete the entity.',
    });
    expect(revalidatePath).not.toHaveBeenCalled();
    expect(mockPrisma.auditLog.create).not.toHaveBeenCalled();
  });

  it("blocks BEFORE deleting when another entity's published version references one of its versions", async () => {
    mockPrisma.entityVersion.findMany
      .mockResolvedValueOnce([{ id: "ev-order-1" }]) // the entity's own versions
      .mockResolvedValueOnce([{ major: 1, minor: 0, entity: { id: "ent-cart", name: "Cart" } }]); // the referencing source
    mockPrisma.schemaReference.findMany.mockResolvedValueOnce([{ fromId: "ev-cart-1" }]);

    const result = (await deleteEntityAction("ent-1")) as { error: string };

    expect(result.error).toContain('Entity "Order" cannot be deleted: it is referenced by published versions of Entity "Cart" (v1.0).');
    expect(result.error).toContain("Published versions cannot be changed");
    expect(mockPrisma.entity.delete).not.toHaveBeenCalled();
    expect(mockPrisma.auditLog.create).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
    // the entity is looked up with its tenant so every reference read is tenant-scoped
    expect(mockPrisma.entity.findUnique).toHaveBeenCalledWith(expect.objectContaining({ select: { id: true, name: true, tenantId: true } }));
    expect(mockPrisma.entityVersion.findMany.mock.calls[1][0]).toMatchObject({ where: { entity: { tenantId: "tenant-1", id: { not: "ent-1" } } } });
  });

  it("answers a P2003 nothing explains with a generic message, never the database text", async () => {
    mockPrisma.entity.delete.mockRejectedValueOnce(fkError());
    const result = (await deleteEntityAction("ent-1")) as { error: string };
    expect(result.error).toBe("This entity is referenced by another record and cannot be deleted. Remove the references first.");
    expect(result.error).not.toMatch(/foreign key|constraint|fkey/i);
  });

  it("maps a lock timeout / deadlock to a retryable message and any other failure to the generic one (driver text never leaks)", async () => {
    for (const error of [rawQuery("40P01"), rawQuery("55P03"), Object.assign(new Error("tx expired"), { code: "P2028" })]) {
      mockPrisma.entity.delete.mockRejectedValueOnce(error);
      expect(await deleteEntityAction("ent-1")).toEqual({ error: "Entity changed concurrently, try again. Reload and try deleting again." });
    }

    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      mockPrisma.entity.delete.mockRejectedValueOnce(new Error("connection lost"));
      expect(await deleteEntityAction("ent-1")).toEqual({ error: GENERIC_ACTION_ERROR });
      // a throw before the entity is even read (e.g. the lookup) is the same generic failure
      mockPrisma.entity.findUnique.mockRejectedValueOnce(new Error("pool exhausted"));
      expect(await deleteEntityAction("ent-1")).toEqual({ error: GENERIC_ACTION_ERROR });
      expect(consoleError).toHaveBeenCalledTimes(2);
    } finally {
      consoleError.mockRestore();
    }
  });

  it("still deletes unreferenced entities, and keeps its not-found / stale-session answers", async () => {
    expect(await deleteEntityAction("ent-1")).toEqual({ success: true });
    expect(mockPrisma.entity.delete).toHaveBeenCalledWith({ where: { id: "ent-1" } });
    expect(revalidatePath).toHaveBeenCalledWith("/schemas");

    mockPrisma.entity.findUnique.mockResolvedValueOnce(null);
    expect(await deleteEntityAction("ghost")).toEqual({ error: "Entity not found" });

    mockPrisma.user.findUnique.mockResolvedValue(null);
    expect(await deleteEntityAction("ent-1")).toEqual({ error: "Your session is stale. Sign out and sign in again, then retry." });
  });
});

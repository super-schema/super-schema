/**
 * deleteEntityAction maps a message / trait pin (NO ACTION FK → Prisma P2003) to an error that names
 * the referencing messages and traits instead of surfacing the raw foreign-key message.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockPrisma } = await vi.hoisted(async () => {
  const { emptyRegistryDelegates } = await import("../../helpers/registry-mocks");
  return {
    mockPrisma: {
      ...emptyRegistryDelegates(),
      user: { findUnique: vi.fn() },
      entity: { findUnique: vi.fn(), delete: vi.fn(), findMany: vi.fn().mockResolvedValue([]) },
      auditLog: { create: vi.fn().mockResolvedValue({ id: "audit-1" }) },
    },
  };
});

vi.mock("@/lib/db", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/auth", () => ({
  auth: vi.fn().mockResolvedValue({ user: { id: "user-1", email: "test@example.com", name: "Test User" } }),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/services/rbac.service", () => ({
  getEffectiveRole: vi.fn().mockResolvedValue({ success: true, data: "AUTHOR" }),
}));

import { revalidatePath } from "next/cache";
import { deleteEntityAction } from "@/app/(dashboard)/schemas/[domainSlug]/actions";

const fkError = () => Object.assign(new Error("Foreign key constraint violated on the constraint: `messages_payloadEntityId_fkey`"), { code: "P2003" });

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.user.findUnique.mockResolvedValue({ id: "user-1" });
  mockPrisma.entity.findUnique.mockResolvedValue({ id: "ent-1", name: "Order" });
  mockPrisma.entity.delete.mockResolvedValue({ id: "ent-1" });
  mockPrisma.auditLog.create.mockResolvedValue({ id: "audit-1" });
  (mockPrisma.message.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  (mockPrisma.trait.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
});

describe("deleteEntityAction — pinned entities", () => {
  it("names the messages and traits that pin the entity instead of the raw FK error", async () => {
    mockPrisma.entity.delete.mockRejectedValueOnce(fkError());
    (mockPrisma.message.findMany as ReturnType<typeof vi.fn>).mockResolvedValueOnce([{ id: "m1", name: "OrderCreated" }]);
    (mockPrisma.trait.findMany as ReturnType<typeof vi.fn>).mockResolvedValueOnce([{ id: "t1", name: "CloudEvents" }]);

    const result = await deleteEntityAction("ent-1");

    expect(result).toEqual({ error: 'Entity "Order" cannot be deleted: it is used by Message "OrderCreated" and Trait "CloudEvents".' });
    expect(revalidatePath).not.toHaveBeenCalled();
    expect(mockPrisma.auditLog.create).not.toHaveBeenCalled();
  });

  it("falls back to the database message when no pin explains the foreign-key failure", async () => {
    const error = fkError();
    mockPrisma.entity.delete.mockRejectedValueOnce(error);
    expect(await deleteEntityAction("ent-1")).toEqual({ error: error.message });
  });

  it("does not look for pins on other failures and still deletes unpinned entities", async () => {
    mockPrisma.entity.delete.mockRejectedValueOnce(new Error("connection lost"));
    expect(await deleteEntityAction("ent-1")).toEqual({ error: "connection lost" });
    expect(mockPrisma.message.findMany).not.toHaveBeenCalled();

    expect(await deleteEntityAction("ent-1")).toEqual({ success: true });
    expect(revalidatePath).toHaveBeenCalledWith("/schemas");
  });
});

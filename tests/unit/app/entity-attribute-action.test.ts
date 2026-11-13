import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    entity: { findUnique: vi.fn(), update: vi.fn() },
    auditLog: { create: vi.fn() },
    $executeRawUnsafe: vi.fn(),
    $queryRaw: vi.fn(async () => [{ id: "ent-1" }]),
    $transaction: vi.fn(),
  },
}));

vi.mock("@/lib/db", () => ({ prisma: mockPrisma }));
vi.mock("@/services/metadata-rederive.service", async () => (await import("../../helpers/no-derivation")).noDerivationModule);
vi.mock("@/lib/access/principal", async () => (await import("../../helpers/access-mocks")).sessionPrincipalModule);
vi.mock("@/lib/auth", () => ({ auth: vi.fn().mockResolvedValue({ user: { id: "user-1" } }) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/active-tenant", () => ({ getActiveTenantId: vi.fn().mockResolvedValue("tenant-1") }));

import { updateEntityAttributeAction } from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/actions";

function stored(metadata: Record<string, unknown>) {
  mockPrisma.entity.findUnique.mockResolvedValue({ id: "ent-1", tenantId: "tenant-1", metadata });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.auditLog.create.mockResolvedValue({ id: "audit-1" });
  mockPrisma.entity.update.mockResolvedValue({ id: "ent-1" });
  mockPrisma.$transaction.mockImplementation(async (ops: unknown) =>
    typeof ops === "function" ? (ops as (tx: unknown) => unknown)(mockPrisma) : Promise.all(ops as unknown[]),
  );
});

describe("updateEntityAttributeAction", () => {
  it("sets one key of custom.extensions, keeps the rest, and marks the draft changed and the source stale", async () => {
    stored({ tags: ["a"], custom: { color: "red", extensions: { "x-team": "iot" } } });
    expect(await updateEntityAttributeAction("ent-1", "x-owner", { team: "data" })).toEqual({ success: true });
    expect(mockPrisma.$queryRaw).toHaveBeenCalled(); // the row lock
    expect(mockPrisma.entity.update).toHaveBeenLastCalledWith({
      where: { id: "ent-1" },
      data: {
        metadata: { tags: ["a"], custom: { color: "red", extensions: { "x-team": "iot", "x-owner": { team: "data" } } }, sourceStale: true },
        hasUnpublishedChanges: true,
      },
    });
  });

  it("deletes the key when the value is undefined, pruning an emptied container", async () => {
    stored({ custom: { extensions: { "x-owner": "a" } } });
    expect(await updateEntityAttributeAction("ent-1", "x-owner", undefined)).toEqual({ success: true });
    expect(mockPrisma.entity.update).toHaveBeenLastCalledWith({
      where: { id: "ent-1" },
      data: { metadata: { sourceStale: true }, hasUnpublishedChanges: true },
    });
  });

  it("rejects a key that breaks the attribute key rule, before reading anything", async () => {
    for (const key of ["owner", "x-", "x-bad key", "$id", "$schema", "__proto__", `x-${"a".repeat(70)}`, "x-a/b"]) {
      expect(await updateEntityAttributeAction("ent-1", key, 1), key).toMatchObject({ code: "VALIDATION_ERROR" });
    }
    expect(await updateEntityAttributeAction("ent-1", 5 as unknown as string, 1)).toMatchObject({ code: "VALIDATION_ERROR" });
    expect(mockPrisma.entity.findUnique).not.toHaveBeenCalled();
    expect(mockPrisma.entity.update).not.toHaveBeenCalled();
  });
});

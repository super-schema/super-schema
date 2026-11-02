import { describe, it, expect, vi, beforeEach } from "vitest";
import { GENERIC_ACTION_ERROR } from "@/types/action-result";

// A retention edit made on the Retention page is audited the way the entity's other metadata edits are (`withAudit`, as on the Governance tab):
// an UPDATE of the entity by the acting user, in the acting tenant, with the retention policy and the two draft flags the write sets (the
// `sourceStale` marker and `hasUnpublishedChanges`), before and after. A write that fails leaves no entry, and so does a stale session.

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    entity: { findUnique: vi.fn(), update: vi.fn() },
    auditLog: { create: vi.fn() },
    user: { findUnique: vi.fn() },
  },
}));

vi.mock("@/lib/db", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/auth", () => ({ auth: vi.fn().mockResolvedValue({ user: { id: "user-1" } }) }));
vi.mock("@/lib/access/principal", async () => (await import("../../helpers/access-mocks")).sessionPrincipalModule);
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/active-tenant", () => ({ getActiveTenantId: vi.fn().mockResolvedValue("tenant-1") }));

import { updateRetentionPolicyAction } from "@/app/(dashboard)/governance/retention/actions";

const OLD = { strategy: "indefinite", action: "archive" };
const NEW = { strategy: "age-based", period: 1, periodUnit: "years", action: "delete" };

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.user.findUnique.mockResolvedValue({ id: "user-1" });
  mockPrisma.entity.findUnique.mockResolvedValue({
    tenantId: "tenant-1",
    metadata: { tags: ["a"], retentionPolicy: OLD },
    hasUnpublishedChanges: false,
  });
  mockPrisma.entity.update.mockResolvedValue({ id: "ent-1" });
  mockPrisma.auditLog.create.mockResolvedValue({ id: "audit-1" });
});

describe("updateRetentionPolicyAction is audited like the entity's other metadata edits", () => {
  it("records an UPDATE of the entity by the acting user, in the acting tenant, with the policy and the draft flags before and after", async () => {
    expect(await updateRetentionPolicyAction("ent-1", NEW)).toEqual({ success: true });
    expect(mockPrisma.auditLog.create).toHaveBeenCalledTimes(1);
    expect(mockPrisma.auditLog.create).toHaveBeenCalledWith({
      data: {
        action: "UPDATE",
        entityType: "Entity",
        entityId: "ent-1",
        userId: "user-1",
        tenantId: "tenant-1",
        // The write marks the draft changed and the stored source stale; the entry records both, as the Governance tab's entry does.
        beforeState: { metadata: { retentionPolicy: OLD, sourceStale: false }, hasUnpublishedChanges: false },
        afterState: { metadata: { retentionPolicy: NEW, sourceStale: true }, hasUnpublishedChanges: true },
      },
    });
  });

  it("a save that leaves the policy and the flags as they were records them as they were", async () => {
    mockPrisma.entity.findUnique.mockResolvedValue({
      tenantId: "tenant-1",
      metadata: { retentionPolicy: NEW, sourceStale: true },
      hasUnpublishedChanges: true,
    });
    await updateRetentionPolicyAction("ent-1", NEW);
    expect(mockPrisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        beforeState: { metadata: { retentionPolicy: NEW, sourceStale: true }, hasUnpublishedChanges: true },
        afterState: { metadata: { retentionPolicy: NEW, sourceStale: true }, hasUnpublishedChanges: true },
      }),
    });
  });

  it("writes the entry after the policy is stored", async () => {
    await updateRetentionPolicyAction("ent-1", NEW);
    expect(mockPrisma.entity.update.mock.invocationCallOrder[0]).toBeLessThan(mockPrisma.auditLog.create.mock.invocationCallOrder[0]);
  });

  it("an entity with no policy yet has null as its before state", async () => {
    mockPrisma.entity.findUnique.mockResolvedValue({ tenantId: "tenant-1", metadata: { tags: ["a"] }, hasUnpublishedChanges: false });
    await updateRetentionPolicyAction("ent-1", NEW);
    expect(mockPrisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        beforeState: { metadata: { retentionPolicy: null, sourceStale: false }, hasUnpublishedChanges: false },
      }),
    });
  });

  it("a write that fails records nothing, and the caller gets the generic answer", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mockPrisma.entity.update.mockRejectedValue(new Error("connection lost"));
    expect(await updateRetentionPolicyAction("ent-1", NEW)).toEqual({ error: GENERIC_ACTION_ERROR, code: "INTERNAL_ERROR" });
    expect(mockPrisma.auditLog.create).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("a stale session (its user no longer exists) stores nothing and records nothing", async () => {
    mockPrisma.user.findUnique.mockResolvedValueOnce(null);
    expect(await updateRetentionPolicyAction("ent-1", NEW)).toMatchObject({ code: "UNAUTHORIZED" });
    expect(mockPrisma.entity.update).not.toHaveBeenCalled();
    expect(mockPrisma.auditLog.create).not.toHaveBeenCalled();
  });

  it("a refused policy is not written and records nothing", async () => {
    expect(await updateRetentionPolicyAction("ent-1", { ...NEW, period: 0.5 })).toMatchObject({ code: "VALIDATION_ERROR" });
    expect(mockPrisma.entity.update).not.toHaveBeenCalled();
    expect(mockPrisma.auditLog.create).not.toHaveBeenCalled();
  });
});

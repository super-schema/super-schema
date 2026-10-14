import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: { entity: { findUnique: vi.fn(), update: vi.fn() } },
}));

vi.mock("@/lib/db", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/auth", () => ({ auth: vi.fn().mockResolvedValue({ user: { id: "user-1" } }) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { updateRetentionPolicyAction } from "@/app/(dashboard)/governance/retention/actions";

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.entity.update.mockResolvedValue({ id: "ent-1" });
});

describe("updateRetentionPolicyAction draft + source tracking (R45)", () => {
  it("marks a changed retention policy as a draft change and the stored source stale", async () => {
    mockPrisma.entity.findUnique.mockResolvedValue({ metadata: { tags: ["a"] } });
    expect(await updateRetentionPolicyAction("ent-1", { period: "P1Y" })).toEqual({ success: true });
    expect(mockPrisma.entity.update).toHaveBeenCalledWith({
      where: { id: "ent-1" },
      data: {
        metadata: { tags: ["a"], retentionPolicy: { period: "P1Y" }, sourceStale: true },
        hasUnpublishedChanges: true,
      },
    });
  });

  it("does not touch the flags when the policy is unchanged on a fresh source", async () => {
    mockPrisma.entity.findUnique.mockResolvedValue({ metadata: { retentionPolicy: { period: "P1Y" } } });
    await updateRetentionPolicyAction("ent-1", { period: "P1Y" });
    expect(mockPrisma.entity.update).toHaveBeenCalledWith({
      where: { id: "ent-1" },
      data: { metadata: { retentionPolicy: { period: "P1Y" } } },
    });
  });

  it("keeps an already-stale source stale", async () => {
    mockPrisma.entity.findUnique.mockResolvedValue({
      metadata: { retentionPolicy: { period: "P1Y" }, sourceStale: true },
    });
    await updateRetentionPolicyAction("ent-1", { period: "P1Y" });
    expect(mockPrisma.entity.update).toHaveBeenCalledWith({
      where: { id: "ent-1" },
      data: { metadata: { retentionPolicy: { period: "P1Y" }, sourceStale: true } },
    });
  });
});

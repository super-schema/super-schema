import { describe, it, expect, vi, beforeEach } from "vitest";

// FINAL WAVE 2b, G9: the retention policy is validated on the SERVER with RetentionPolicySchema (the editor's checks are a convenience):
// {period: 0.5} used to be stored, and the stored template then read as "No template" wherever the schema is applied.

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: { entity: { findUnique: vi.fn(), update: vi.fn() }, auditLog: { create: vi.fn() } },
}));

vi.mock("@/lib/db", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/auth", () => ({ auth: vi.fn().mockResolvedValue({ user: { id: "user-1" } }) }));
vi.mock("@/lib/access/principal", async () => (await import("../../helpers/access-mocks")).sessionPrincipalModule);
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/active-tenant", () => ({ getActiveTenantId: vi.fn().mockResolvedValue("tenant-1") }));

import { updateRetentionPolicyAction } from "@/app/(dashboard)/governance/retention/actions";

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.entity.update.mockResolvedValue({ id: "ent-1" });
  mockPrisma.entity.findUnique.mockResolvedValue({ metadata: {}, tenantId: "tenant-1" });
});

const VALID = { strategy: "age-based", period: 7, periodUnit: "years", action: "archive" };

describe("updateRetentionPolicyAction validates the policy", () => {
  it.each([
    ["a fractional period", { ...VALID, period: 0.5 }],
    ["a zero period", { ...VALID, period: 0 }],
    ["a negative period", { ...VALID, period: -3 }],
    ["a text period", { ...VALID, period: "P1Y" }],
    ["an unknown strategy", { ...VALID, strategy: "forever" }],
    ["an unknown action", { ...VALID, action: "shred" }],
    ["an unknown unit", { ...VALID, periodUnit: "decades" }],
    ["no strategy", { period: 7, action: "delete" }],
    ["a description that is not text", { ...VALID, description: 3 }],
  ])("refuses %s, with the schema's message, and writes nothing", async (_label, policy) => {
    const result = await updateRetentionPolicyAction("ent-1", policy as Record<string, unknown>);
    expect(result).toMatchObject({ code: "VALIDATION_ERROR", error: expect.any(String) });
    expect((result as { error: string }).error.length).toBeGreaterThan(0);
    expect(mockPrisma.entity.update).not.toHaveBeenCalled();
  });

  it("names the period when it is the problem, in the editor's own words", async () => {
    const result = await updateRetentionPolicyAction("ent-1", { ...VALID, period: 0.5 });
    expect(result).toMatchObject({ error: "The period must be a whole number of 1 or more." });
  });

  it("a valid policy is stored (as the schema reads it: only its own keys)", async () => {
    expect(await updateRetentionPolicyAction("ent-1", { ...VALID, notAKey: "x" })).toEqual({ success: true });
    expect(mockPrisma.entity.update).toHaveBeenCalledWith({
      where: { id: "ent-1" },
      data: { metadata: { retentionPolicy: VALID, sourceStale: true }, hasUnpublishedChanges: true },
    });
  });

  it("an indefinite policy needs no period", async () => {
    expect(await updateRetentionPolicyAction("ent-1", { strategy: "indefinite", action: "notify-only" })).toEqual({ success: true });
  });
});

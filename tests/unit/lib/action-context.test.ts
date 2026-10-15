import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  auth: vi.fn(),
  revalidatePath: vi.fn(),
  getEffectiveRole: vi.fn(),
  resolveCurrentUserId: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: h.revalidatePath }));
vi.mock("@/lib/auth", () => ({ auth: h.auth }));
vi.mock("@/lib/db", () => ({ prisma: { tag: "prisma" } }));
vi.mock("@/services/rbac.service", () => ({ getEffectiveRole: h.getEffectiveRole }));
vi.mock("@/lib/current-user", () => ({ resolveCurrentUserId: h.resolveCurrentUserId }));

import { AuditUserMissingError } from "@/lib/audit";
import { getActionContext, NOT_AUTHENTICATED, runMutation, toActionResult } from "@/lib/action-context";

beforeEach(() => {
  vi.clearAllMocks();
  h.auth.mockResolvedValue({ user: { id: "session-id", email: "a@example.test" } });
  h.resolveCurrentUserId.mockResolvedValue("db-user");
  h.getEffectiveRole.mockResolvedValue({ success: true, data: "AUTHOR" });
});

describe("toActionResult", () => {
  it("maps success data through", () => {
    expect(toActionResult({ success: true, data: { id: "1" } })).toEqual({ success: true, data: { id: "1" } });
  });

  it("carries code, details and suggestedFix on failure, omitting the ones that are absent", () => {
    expect(
      toActionResult({ success: false, error: { code: "VALIDATION_ERROR", message: "bad", details: { problems: ["x"] }, suggestedFix: "Fix x" } })
    ).toEqual({ success: false, error: "bad", code: "VALIDATION_ERROR", details: { problems: ["x"] }, suggestedFix: "Fix x" });
    const bare = toActionResult({ success: false, error: { code: "NOT_FOUND", message: "gone" } });
    expect(bare).toEqual({ success: false, error: "gone", code: "NOT_FOUND" });
    expect("details" in bare).toBe(false);
    expect("suggestedFix" in bare).toBe(false);
  });
});

describe("getActionContext", () => {
  it("resolves the user through resolveCurrentUserId (id, then email fallback) and uses the resolved id for the role", async () => {
    const ctx = await getActionContext();
    expect(h.resolveCurrentUserId).toHaveBeenCalledWith({ id: "session-id", email: "a@example.test" });
    expect(h.getEffectiveRole).toHaveBeenCalledWith("db-user", null, expect.objectContaining({ userId: "db-user" }));
    expect(ctx).toMatchObject({ userId: "db-user", userRole: "AUTHOR" });
  });

  it("fails closed to VIEWER when the role lookup fails or is empty", async () => {
    h.getEffectiveRole.mockResolvedValueOnce({ success: false, error: { code: "DB_ERROR", message: "x" } });
    expect(await getActionContext()).toMatchObject({ userRole: "VIEWER" });
    h.getEffectiveRole.mockResolvedValueOnce({ success: true, data: null });
    expect(await getActionContext()).toMatchObject({ userRole: "VIEWER" });
  });

  it("returns null without a session, without a session user id, or for a stale session", async () => {
    h.auth.mockResolvedValueOnce(null);
    expect(await getActionContext()).toBeNull();
    h.auth.mockResolvedValueOnce({ user: { email: "a@example.test" } });
    expect(await getActionContext()).toBeNull();
    expect(h.resolveCurrentUserId).not.toHaveBeenCalled();
    h.resolveCurrentUserId.mockRejectedValueOnce(new AuditUserMissingError("session-id"));
    expect(await getActionContext()).toBeNull();
  });

  it("does not swallow unexpected errors from the user lookup", async () => {
    h.resolveCurrentUserId.mockRejectedValueOnce(new Error("db down"));
    await expect(getActionContext()).rejects.toThrow("db down");
  });
});

describe("runMutation", () => {
  it("returns NOT_AUTHENTICATED without running or revalidating", async () => {
    h.auth.mockResolvedValueOnce(null);
    const run = vi.fn();
    expect(await runMutation(run)).toEqual(NOT_AUTHENTICATED);
    expect(run).not.toHaveBeenCalled();
    expect(h.revalidatePath).not.toHaveBeenCalled();
  });

  it("runs with the context, revalidates /schemas (layout) after success and returns the data", async () => {
    const run = vi.fn(async (ctx: { userId: string }) => ({ success: true as const, data: { by: ctx.userId } }));
    const r = await runMutation(run);
    expect(r).toEqual({ success: true, data: { by: "db-user" } });
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ userId: "db-user", userRole: "AUTHOR" }));
    expect(h.revalidatePath).toHaveBeenCalledTimes(1);
    expect(h.revalidatePath).toHaveBeenCalledWith("/schemas", "layout");
  });

  it("never revalidates on a service failure and carries the error contract", async () => {
    const r = await runMutation(async () => ({
      success: false as const,
      error: { code: "NAME_CONFLICT", message: "taken", details: { conflict: 1 }, suggestedFix: "Pick another" },
    }));
    expect(r).toEqual({ success: false, error: "taken", code: "NAME_CONFLICT", details: { conflict: 1 }, suggestedFix: "Pick another" });
    expect(h.revalidatePath).not.toHaveBeenCalled();
  });
});

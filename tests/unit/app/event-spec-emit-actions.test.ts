import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => {
  const findFirst = vi.fn();
  return {
    auth: vi.fn(), revalidatePath: vi.fn(), resolveCurrentUserId: vi.fn(), emitEventSpec: vi.fn(), getActiveTenantId: vi.fn(), findFirst,
    // The one client the actions must hand to the service: carries the old `tag` plus the scope lookup.
    prisma: { tag: "prisma", eventSpec: { findFirst } },
  };
});
vi.mock("@/lib/db", () => ({ prisma: h.prisma }));
vi.mock("@/lib/auth", () => ({ auth: h.auth }));
vi.mock("@/lib/current-user", () => ({ resolveCurrentUserId: h.resolveCurrentUserId }));
vi.mock("@/lib/active-tenant", () => ({ getActiveTenantId: h.getActiveTenantId }));
vi.mock("next/cache", () => ({ revalidatePath: h.revalidatePath }));
vi.mock("@/services/rbac.service", () => ({ getEffectiveRole: vi.fn().mockResolvedValue({ success: true, data: "VIEWER" }) }));
vi.mock("@/services/events/event-spec-emit.service", () => ({ emitEventSpec: h.emitEventSpec }));

import { emitEventSpecDraftAction, getEventSpecVersionDocumentAction } from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/event-spec-emit-actions";
import { GENERIC_ACTION_ERROR } from "@/types/action-result";

const NOT_FOUND = { success: false, error: "Event spec not found", code: "NOT_FOUND" };

beforeEach(() => {
  vi.clearAllMocks();
  h.auth.mockResolvedValue({ user: { id: "u1" } });
  h.resolveCurrentUserId.mockResolvedValue("u1");
  h.getActiveTenantId.mockResolvedValue("tenant-active");
  h.findFirst.mockResolvedValue({ id: "s1" });
  h.emitEventSpec.mockResolvedValue({ success: true, data: { version: "draft" } });
});

describe("event spec emit actions", () => {
  it("emit the draft or a version without revalidating", async () => {
    expect(await emitEventSpecDraftAction("s1", "p1")).toEqual({ success: true, data: { version: "draft" } });
    expect(h.emitEventSpec).toHaveBeenCalledWith("s1", { draft: true }, { userId: "u1", userRole: "VIEWER", prisma: h.prisma });
    // Same client object, not a copy: scoping and emission run on the real connection.
    expect(h.emitEventSpec.mock.calls[0][2].prisma).toBe(h.prisma);
    await getEventSpecVersionDocumentAction("s1", "2.0");
    expect(h.emitEventSpec).toHaveBeenLastCalledWith("s1", { versionLabel: "2.0" }, expect.anything());
    expect(h.revalidatePath).not.toHaveBeenCalled();
  });

  it("requires a session", async () => {
    h.auth.mockResolvedValue(null);
    expect(await emitEventSpecDraftAction("s1", "p1")).toMatchObject({ success: false, code: "UNAUTHORIZED" });
    expect(await getEventSpecVersionDocumentAction("s1", "1.0")).toMatchObject({ success: false, code: "UNAUTHORIZED" });
    expect(h.emitEventSpec).not.toHaveBeenCalled();
    expect(h.findFirst).not.toHaveBeenCalled();
  });

  it("scopes a draft by the server-resolved tenant AND the page's product before anything is emitted (R67)", async () => {
    await emitEventSpecDraftAction("s1", "p1");
    expect(h.findFirst).toHaveBeenCalledWith({ where: { id: "s1", tenantId: "tenant-active", productId: "p1" }, select: { id: true } });
  });

  it("scopes a published version by tenant only: other products of the tenant read it, never another tenant", async () => {
    await getEventSpecVersionDocumentAction("s1", "1.0");
    expect(h.findFirst).toHaveBeenCalledWith({ where: { id: "s1", tenantId: "tenant-active" }, select: { id: true } });
  });

  it("answers a foreign-tenant, wrong-product and nonexistent spec identically, without emitting", async () => {
    h.findFirst.mockResolvedValue(null);
    const draft = await emitEventSpecDraftAction("foreign-or-missing", "p1");
    const version = await getEventSpecVersionDocumentAction("foreign-or-missing", "1.0");
    expect(draft).toEqual(NOT_FOUND);
    expect(version).toEqual(NOT_FOUND);
    expect(h.emitEventSpec).not.toHaveBeenCalled();
  });

  it("rejects malformed client input without a database lookup, and never widens a draft read to the whole tenant", async () => {
    expect(await emitEventSpecDraftAction("", "p1")).toEqual(NOT_FOUND);
    expect(await emitEventSpecDraftAction("s1", "")).toEqual(NOT_FOUND);
    expect(await emitEventSpecDraftAction("s1", undefined as unknown as string)).toEqual(NOT_FOUND);
    expect(await emitEventSpecDraftAction("s1", null as unknown as string)).toEqual(NOT_FOUND);
    expect(await emitEventSpecDraftAction({ id: "s1" } as unknown as string, "p1")).toEqual(NOT_FOUND);
    expect(await getEventSpecVersionDocumentAction("", "1.0")).toEqual(NOT_FOUND);
    expect(await getEventSpecVersionDocumentAction("s1", 2 as unknown as string)).toMatchObject({ success: false, code: "VALIDATION_ERROR" });
    expect(h.findFirst).not.toHaveBeenCalled();
    expect(h.emitEventSpec).not.toHaveBeenCalled();
  });

  it("bounds the version label before any read, whichever spec it is asked of, and normalizes a good one", async () => {
    for (const label of ["99999999999.0", "1.99999999999", `${"9".repeat(400)}.0`, "2147483648.0", "0.1", "abc"]) {
      expect(await getEventSpecVersionDocumentAction("s1", label)).toEqual({ success: false, error: "The version must be MAJOR.MINOR, e.g. 2.1", code: "VALIDATION_ERROR" });
    }
    expect(h.findFirst).not.toHaveBeenCalled();
    expect(h.emitEventSpec).not.toHaveBeenCalled();
    await getEventSpecVersionDocumentAction("s1", "v01.00");
    expect(h.emitEventSpec).toHaveBeenCalledWith("s1", { versionLabel: "1.0" }, expect.anything());
    await getEventSpecVersionDocumentAction("s1", "2147483647.2147483647");
    expect(h.emitEventSpec).toHaveBeenLastCalledWith("s1", { versionLabel: "2147483647.2147483647" }, expect.anything());
  });

  it("passes service errors through, and maps an unexpected throw to a generic message (no internal text reaches the client)", async () => {
    h.emitEventSpec.mockResolvedValue({ success: false, error: { code: "NOT_FOUND", message: 'Version 9.0 of event spec "s1" not found', suggestedFix: "Pick a listed version." } });
    expect(await getEventSpecVersionDocumentAction("s1", "9.0")).toEqual({ success: false, error: 'Version 9.0 of event spec "s1" not found', code: "NOT_FOUND", suggestedFix: "Pick a listed version." });

    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    h.emitEventSpec.mockRejectedValue(new Error('connect ECONNREFUSED 10.0.0.5:5432 password authentication failed for user "app"'));
    const result = await getEventSpecVersionDocumentAction("s1", "1.0");
    expect(result).toMatchObject({ success: false, code: "INTERNAL_ERROR" });
    expect(JSON.stringify(result)).not.toMatch(/ECONNREFUSED|password|10\.0\.0\.5/);
    expect(log).toHaveBeenCalled();
    log.mockRestore();
  });

  it("maps a failing scope lookup (tenant cookie / database) to the generic failure too", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    h.findFirst.mockRejectedValue(new Error('relation "event_specs" does not exist'));
    const result = await emitEventSpecDraftAction("s1", "p1");
    expect(result).toMatchObject({ success: false, code: "INTERNAL_ERROR" });
    expect(JSON.stringify(result)).not.toMatch(/relation/);
    expect(h.emitEventSpec).not.toHaveBeenCalled();
    log.mockRestore();
  });

  it.each(["DB_ERROR", "INTERNAL_ERROR"])("never returns the raw text of a %s result (the emit service's failure reaches the browser through toActionResult)", async (code) => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const raw = 'Invalid `prisma.eventSpec.findUnique()` invocation: password authentication failed for user "app"';
      h.emitEventSpec.mockResolvedValue({ success: false, error: { code, message: raw, suggestedFix: "Check DATABASE_URL" } });
      for (const result of [await emitEventSpecDraftAction("s1", "p1"), await getEventSpecVersionDocumentAction("s1", "1.0")]) {
        expect(result).toEqual({ success: false, error: GENERIC_ACTION_ERROR, code });
      }
      const kind = code === "DB_ERROR" ? "database error" : "internal error";
      expect(log).toHaveBeenCalledWith(`[emitEventSpecDraftAction] ${kind}`, raw);
      expect(log).toHaveBeenCalledWith(`[getEventSpecVersionDocumentAction] ${kind}`, raw);
    } finally {
      log.mockRestore();
    }
  });
});

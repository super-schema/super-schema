import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({ auth: vi.fn(), revalidatePath: vi.fn(), resolveCurrentUserId: vi.fn(), emitEventSpec: vi.fn() }));
vi.mock("@/lib/db", () => ({ prisma: { tag: "prisma" } }));
vi.mock("@/lib/auth", () => ({ auth: h.auth }));
vi.mock("@/lib/current-user", () => ({ resolveCurrentUserId: h.resolveCurrentUserId }));
vi.mock("next/cache", () => ({ revalidatePath: h.revalidatePath }));
vi.mock("@/services/rbac.service", () => ({ getEffectiveRole: vi.fn().mockResolvedValue({ success: true, data: "VIEWER" }) }));
vi.mock("@/services/events/event-spec-emit.service", () => ({ emitEventSpec: h.emitEventSpec }));

import { emitEventSpecDraftAction, getEventSpecVersionDocumentAction } from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/event-spec-emit-actions";
import { GENERIC_ACTION_ERROR } from "@/types/action-result";

beforeEach(() => {
  vi.clearAllMocks();
  h.auth.mockResolvedValue({ user: { id: "u1" } });
  h.resolveCurrentUserId.mockResolvedValue("u1");
  h.emitEventSpec.mockResolvedValue({ success: true, data: { version: "draft" } });
});

describe("event spec emit actions", () => {
  it("emit the draft or a version without revalidating", async () => {
    expect(await emitEventSpecDraftAction("s1")).toEqual({ success: true, data: { version: "draft" } });
    expect(h.emitEventSpec).toHaveBeenCalledWith("s1", { draft: true }, { userId: "u1", userRole: "VIEWER", prisma: { tag: "prisma" } });
    await getEventSpecVersionDocumentAction("s1", "2.0");
    expect(h.emitEventSpec).toHaveBeenLastCalledWith("s1", { versionLabel: "2.0" }, expect.anything());
    expect(h.revalidatePath).not.toHaveBeenCalled();
  });

  it("requires a session", async () => {
    h.auth.mockResolvedValue(null);
    expect(await emitEventSpecDraftAction("s1")).toMatchObject({ success: false, code: "UNAUTHORIZED" });
    expect(await getEventSpecVersionDocumentAction("s1", "1.0")).toMatchObject({ success: false, code: "UNAUTHORIZED" });
    expect(h.emitEventSpec).not.toHaveBeenCalled();
  });

  it("passes service errors through, and maps an unexpected throw to a generic message (no internal text reaches the client)", async () => {
    h.emitEventSpec.mockResolvedValue({ success: false, error: { code: "NOT_FOUND", message: 'Event spec "s9" not found', suggestedFix: "Check the id." } });
    expect(await emitEventSpecDraftAction("s9")).toEqual({ success: false, error: 'Event spec "s9" not found', code: "NOT_FOUND", suggestedFix: "Check the id." });

    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    h.emitEventSpec.mockRejectedValue(new Error('connect ECONNREFUSED 10.0.0.5:5432 password authentication failed for user "app"'));
    const result = await getEventSpecVersionDocumentAction("s1", "1.0");
    expect(result).toMatchObject({ success: false, code: "INTERNAL_ERROR" });
    expect(JSON.stringify(result)).not.toMatch(/ECONNREFUSED|password|10\.0\.0\.5/);
    expect(log).toHaveBeenCalled();
    log.mockRestore();
  });

  it.each(["DB_ERROR", "INTERNAL_ERROR"])("never returns the raw text of a %s result (the emit service's failure reaches the browser through toActionResult)", async (code) => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const raw = 'Invalid `prisma.eventSpec.findUnique()` invocation: password authentication failed for user "app"';
      h.emitEventSpec.mockResolvedValue({ success: false, error: { code, message: raw, suggestedFix: "Check DATABASE_URL" } });
      for (const result of [await emitEventSpecDraftAction("s1"), await getEventSpecVersionDocumentAction("s1", "1.0")]) {
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

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => ({
  auth: vi.fn(), revalidatePath: vi.fn(), resolveCurrentUserId: vi.fn(),
  previewEventSpecPublish: vi.fn(), publishEventSpec: vi.fn(), listEventSpecVersions: vi.fn(),
}));
// The Events actions check their (client-supplied) parent against the active tenant; the real check is covered by
// tests/unit/app/events-actions-tenant-guard.test.ts. Here every parent is the active tenant's.
vi.mock("@/lib/action-context", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/action-context")>()),
  withOwnedTarget: async (_target: unknown, run: () => Promise<unknown>) => run(),
}));
vi.mock("@/lib/db", () => ({ prisma: { tag: "prisma" } }));
vi.mock("@/lib/auth", () => ({ auth: h.auth }));
vi.mock("@/lib/current-user", () => ({ resolveCurrentUserId: h.resolveCurrentUserId }));
vi.mock("next/cache", () => ({ revalidatePath: h.revalidatePath }));
vi.mock("@/services/rbac.service", () => ({ getEffectiveRole: vi.fn().mockResolvedValue({ success: true, data: "AUTHOR" }) }));
vi.mock("@/services/events/event-spec-publish.service", () => ({
  previewEventSpecPublish: h.previewEventSpecPublish, publishEventSpec: h.publishEventSpec, listEventSpecVersions: h.listEventSpecVersions,
}));

import {
  getEventSpecPublishPreviewAction, listEventSpecVersionsAction, publishEventSpecAction,
} from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/event-spec-version-actions";

const CTX = { userId: "u1", userRole: "AUTHOR", prisma: { tag: "prisma" } };
const GENERIC = "Something went wrong. Try again; if it keeps happening, contact an administrator.";

let consoleError: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.clearAllMocks();
  h.auth.mockResolvedValue({ user: { id: "u1" } });
  h.resolveCurrentUserId.mockResolvedValue("u1");
  consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => consoleError.mockRestore());

describe("event spec version actions", () => {
  it("validates the bump and summary before calling the service", async () => {
    expect(await publishEventSpecAction("s1", "p1", { bump: "PATCH" as never })).toEqual({ success: false, error: "bump must be MAJOR or MINOR", code: "VALIDATION_ERROR" });
    expect(await publishEventSpecAction("s1", "p1", { changeSummary: "x".repeat(501) })).toMatchObject({ code: "VALIDATION_ERROR" });
    expect(await publishEventSpecAction("s1", "p1", { changeSummary: 42 as never })).toMatchObject({ code: "VALIDATION_ERROR" });
    expect(h.publishEventSpec).not.toHaveBeenCalled();
    expect(h.revalidatePath).not.toHaveBeenCalled();
  });

  it("tolerates a null / non-object input (untrusted client payload) as 'no options'", async () => {
    h.publishEventSpec.mockResolvedValue({ success: true, data: { label: "1.0" } });
    for (const input of [null, undefined, "MAJOR", 7, [] as unknown]) {
      expect(await publishEventSpecAction("s1", "p1", input as never)).toEqual({ success: true, data: { label: "1.0" } });
    }
    expect(h.publishEventSpec).toHaveBeenCalledTimes(5);
    for (const call of h.publishEventSpec.mock.calls) expect(call).toEqual(["s1", "p1", { bump: undefined, changeSummary: undefined }, CTX]);
  });

  it("requires a session for every action and never reaches the service without one", async () => {
    h.auth.mockResolvedValue(null);
    const unauthenticated = { success: false, error: "Not authenticated", code: "UNAUTHORIZED" };
    expect(await publishEventSpecAction("s1", "p1", {})).toEqual(unauthenticated);
    expect(await getEventSpecPublishPreviewAction("s1", "p1")).toEqual(unauthenticated);
    expect(await listEventSpecVersionsAction("s1", "p1")).toEqual(unauthenticated);
    expect(h.publishEventSpec).not.toHaveBeenCalled();
    expect(h.previewEventSpecPublish).not.toHaveBeenCalled();
    expect(h.listEventSpecVersions).not.toHaveBeenCalled();
    expect(h.revalidatePath).not.toHaveBeenCalled();
  });

  it("passes the owning product id (after the spec id, like updateEventSpecDocumentAction) to every service call", async () => {
    h.publishEventSpec.mockResolvedValue({ success: true, data: { label: "1.0" } });
    h.previewEventSpecPublish.mockResolvedValue({ success: true, data: { isFirstPublish: true } });
    h.listEventSpecVersions.mockResolvedValue({ success: true, data: [] });
    await publishEventSpecAction("s1", "p1", { bump: "MAJOR", changeSummary: "ship it" });
    await getEventSpecPublishPreviewAction("s1", "p1");
    await listEventSpecVersionsAction("s1", "p1");
    expect(h.publishEventSpec).toHaveBeenCalledWith("s1", "p1", { bump: "MAJOR", changeSummary: "ship it" }, CTX);
    expect(h.previewEventSpecPublish).toHaveBeenCalledWith("s1", "p1", CTX);
    expect(h.listEventSpecVersions).toHaveBeenCalledWith("s1", "p1", CTX);
  });

  it("revalidates on a successful publish only and passes planner errors, blockers and ownership errors through", async () => {
    h.publishEventSpec.mockResolvedValueOnce({ success: true, data: { label: "1.0" } });
    expect(await publishEventSpecAction("s1", "p1", {})).toEqual({ success: true, data: { label: "1.0" } });
    expect(h.revalidatePath).toHaveBeenCalledWith("/schemas", "layout");

    const blockers = [{ kind: "UNPUBLISHED_MESSAGE", message: "Message OrderCreated is an unpublished draft — publish it and pick its version" }];
    h.publishEventSpec.mockResolvedValueOnce({ success: false, error: { code: "PUBLISH_BLOCKED", message: "Publish OrderCreated first", details: { blockers }, suggestedFix: "Resolve every blocker" } });
    expect(await publishEventSpecAction("s1", "p1", {})).toEqual({
      success: false, error: "Publish OrderCreated first", code: "PUBLISH_BLOCKED", details: { blockers }, suggestedFix: "Resolve every blocker",
    });
    for (const code of ["BUMP_TOO_LOW", "INVALID_PLAN_INPUT", "CONFLICT", "NOT_FOUND", "FORBIDDEN"]) {
      h.publishEventSpec.mockResolvedValueOnce({ success: false, error: { code, message: code, suggestedFix: "fix" } });
      expect(await publishEventSpecAction("s1", "p1", {})).toEqual({ success: false, error: code, code, suggestedFix: "fix" });
    }
    expect(h.revalidatePath).toHaveBeenCalledTimes(1);
  });

  it("does not leak database error text from any action (generic message, original logged server-side)", async () => {
    h.publishEventSpec.mockResolvedValueOnce({ success: false, error: { code: "DB_ERROR", message: 'relation "event_spec_versions" does not exist' } });
    expect(await publishEventSpecAction("s1", "p1", {})).toEqual({ success: false, error: GENERIC, code: "DB_ERROR" });
    expect(consoleError).toHaveBeenCalledWith("[publishEventSpecAction] database error", 'relation "event_spec_versions" does not exist');

    const thrown = new Error("connect ECONNREFUSED 10.0.0.5:5432");
    h.publishEventSpec.mockRejectedValueOnce(thrown);
    expect(await publishEventSpecAction("s1", "p1", {})).toEqual({ success: false, error: GENERIC, code: "INTERNAL_ERROR" });
    expect(consoleError).toHaveBeenCalledWith("[publishEventSpecAction] unexpected error", thrown);
    h.previewEventSpecPublish.mockRejectedValueOnce(new Error("password authentication failed for user admin"));
    expect(await getEventSpecPublishPreviewAction("s1", "p1")).toEqual({ success: false, error: GENERIC, code: "INTERNAL_ERROR" });
    h.previewEventSpecPublish.mockResolvedValueOnce({ success: false, error: { code: "DB_ERROR", message: "pg: relation \"channels\" does not exist" } });
    expect(await getEventSpecPublishPreviewAction("s1", "p1")).toEqual({ success: false, error: GENERIC, code: "DB_ERROR" });
    h.listEventSpecVersions.mockResolvedValueOnce({ success: false, error: { code: "DB_ERROR", message: "pg: too many clients" } });
    expect(await listEventSpecVersionsAction("s1", "p1")).toEqual({ success: false, error: GENERIC, code: "DB_ERROR" });
    expect(h.revalidatePath).not.toHaveBeenCalled();
  });

  it("passes preview and versions through without revalidating", async () => {
    h.previewEventSpecPublish.mockResolvedValue({ success: true, data: { isFirstPublish: true } });
    h.listEventSpecVersions.mockResolvedValue({ success: true, data: [] });
    expect(await getEventSpecPublishPreviewAction("s1", "p1")).toEqual({ success: true, data: { isFirstPublish: true } });
    expect(await listEventSpecVersionsAction("s1", "p1")).toEqual({ success: true, data: [] });
    h.previewEventSpecPublish.mockResolvedValueOnce({ success: false, error: { code: "FORBIDDEN", message: "owned elsewhere", suggestedFix: "Open it from its owning level to edit it." } });
    expect(await getEventSpecPublishPreviewAction("s1", "other")).toEqual({
      success: false, error: "owned elsewhere", code: "FORBIDDEN", suggestedFix: "Open it from its owning level to edit it.",
    });
    expect(h.revalidatePath).not.toHaveBeenCalled();
  });
});

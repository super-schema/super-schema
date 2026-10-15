import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => ({
  auth: vi.fn(), revalidatePath: vi.fn(), resolveCurrentUserId: vi.fn(),
  previewMessagePublish: vi.fn(), publishMessage: vi.fn(), listMessageVersions: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ prisma: { tag: "prisma" } }));
vi.mock("@/lib/auth", () => ({ auth: h.auth }));
vi.mock("@/lib/current-user", () => ({ resolveCurrentUserId: h.resolveCurrentUserId }));
vi.mock("next/cache", () => ({ revalidatePath: h.revalidatePath }));
vi.mock("@/services/rbac.service", () => ({ getEffectiveRole: vi.fn().mockResolvedValue({ success: true, data: "AUTHOR" }) }));
vi.mock("@/services/events/message-publish.service", () => ({
  previewMessagePublish: h.previewMessagePublish, publishMessage: h.publishMessage, listMessageVersions: h.listMessageVersions,
}));

import {
  getMessagePublishPreviewAction, listMessageVersionsAction, publishMessageAction,
} from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/message-version-actions";

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

describe("message version actions", () => {
  it("validates the bump and summary before calling the service", async () => {
    expect(await publishMessageAction("m1", "p1", { bump: "PATCH" as never })).toEqual({ success: false, error: "bump must be MAJOR or MINOR", code: "VALIDATION_ERROR" });
    expect(await publishMessageAction("m1", "p1", { changeSummary: "x".repeat(501) })).toMatchObject({ code: "VALIDATION_ERROR" });
    expect(await publishMessageAction("m1", "p1", { changeSummary: 42 as never })).toMatchObject({ code: "VALIDATION_ERROR" });
    expect(h.publishMessage).not.toHaveBeenCalled();
    expect(h.revalidatePath).not.toHaveBeenCalled();
  });

  it("tolerates a null / non-object input (untrusted client payload) as 'no options'", async () => {
    h.publishMessage.mockResolvedValue({ success: true, data: { label: "1.0" } });
    for (const input of [null, undefined, "MAJOR", 7, [] as unknown]) {
      expect(await publishMessageAction("m1", "p1", input as never)).toEqual({ success: true, data: { label: "1.0" } });
    }
    expect(h.publishMessage).toHaveBeenCalledTimes(5);
    for (const call of h.publishMessage.mock.calls) expect(call).toEqual(["m1", "p1", { bump: undefined, changeSummary: undefined }, CTX]);
  });

  it("requires a session for every action and never reaches the service without one", async () => {
    h.auth.mockResolvedValue(null);
    const unauthenticated = { success: false, error: "Not authenticated", code: "UNAUTHORIZED" };
    expect(await publishMessageAction("m1", "p1", {})).toEqual(unauthenticated);
    expect(await getMessagePublishPreviewAction("m1", "p1")).toEqual(unauthenticated);
    expect(await listMessageVersionsAction("m1", "p1")).toEqual(unauthenticated);
    expect(h.publishMessage).not.toHaveBeenCalled();
    expect(h.previewMessagePublish).not.toHaveBeenCalled();
    expect(h.listMessageVersions).not.toHaveBeenCalled();
  });

  it("passes the owning product id (after the message id, like updateMessageAction) to every service call", async () => {
    h.publishMessage.mockResolvedValue({ success: true, data: { label: "1.0" } });
    h.previewMessagePublish.mockResolvedValue({ success: true, data: { isFirstPublish: true } });
    h.listMessageVersions.mockResolvedValue({ success: true, data: [] });
    await publishMessageAction("m1", "p1", { bump: "MAJOR", changeSummary: "ship it" });
    await getMessagePublishPreviewAction("m1", "p1");
    await listMessageVersionsAction("m1", "p1");
    expect(h.publishMessage).toHaveBeenCalledWith("m1", "p1", { bump: "MAJOR", changeSummary: "ship it" }, CTX);
    expect(h.previewMessagePublish).toHaveBeenCalledWith("m1", "p1", CTX);
    expect(h.listMessageVersions).toHaveBeenCalledWith("m1", "p1", CTX);
  });

  it("revalidates on a successful publish only and passes planner errors, blockers and ownership errors through", async () => {
    h.publishMessage.mockResolvedValueOnce({ success: true, data: { label: "1.0" } });
    expect(await publishMessageAction("m1", "p1", {})).toEqual({ success: true, data: { label: "1.0" } });
    expect(h.revalidatePath).toHaveBeenCalledWith("/schemas", "layout");

    const blockers = [{ kind: "UNPUBLISHED_PIN", message: "Payload: publish Order first, then pin its version" }];
    h.publishMessage.mockResolvedValueOnce({ success: false, error: { code: "PUBLISH_BLOCKED", message: "Publish Order first", details: { blockers }, suggestedFix: "Resolve every blocker" } });
    expect(await publishMessageAction("m1", "p1", {})).toEqual({
      success: false, error: "Publish Order first", code: "PUBLISH_BLOCKED", details: { blockers }, suggestedFix: "Resolve every blocker",
    });
    for (const code of ["BUMP_TOO_LOW", "INVALID_PLAN_INPUT", "CONFLICT", "NOT_FOUND", "FORBIDDEN"]) {
      h.publishMessage.mockResolvedValueOnce({ success: false, error: { code, message: code, suggestedFix: "fix" } });
      expect(await publishMessageAction("m1", "p1", {})).toEqual({ success: false, error: code, code, suggestedFix: "fix" });
    }
    expect(h.revalidatePath).toHaveBeenCalledTimes(1);
  });

  it("does not leak database error text from any action (generic message, original logged server-side)", async () => {
    h.publishMessage.mockResolvedValueOnce({ success: false, error: { code: "DB_ERROR", message: 'relation "message_versions" does not exist' } });
    expect(await publishMessageAction("m1", "p1", {})).toEqual({ success: false, error: GENERIC, code: "DB_ERROR" });
    expect(consoleError).toHaveBeenCalledWith("[publishMessageAction] database error", 'relation "message_versions" does not exist');

    const thrown = new Error("connect ECONNREFUSED 10.0.0.5:5432");
    h.publishMessage.mockRejectedValueOnce(thrown);
    expect(await publishMessageAction("m1", "p1", {})).toEqual({ success: false, error: GENERIC, code: "INTERNAL_ERROR" });
    expect(consoleError).toHaveBeenCalledWith("[publishMessageAction] unexpected error", thrown);
    h.previewMessagePublish.mockRejectedValueOnce(new Error("password authentication failed for user admin"));
    expect(await getMessagePublishPreviewAction("m1", "p1")).toEqual({ success: false, error: GENERIC, code: "INTERNAL_ERROR" });
    h.listMessageVersions.mockResolvedValueOnce({ success: false, error: { code: "DB_ERROR", message: "pg: too many clients" } });
    expect(await listMessageVersionsAction("m1", "p1")).toEqual({ success: false, error: GENERIC, code: "DB_ERROR" });
    expect(h.revalidatePath).not.toHaveBeenCalled();
  });

  it("passes preview and versions through without revalidating", async () => {
    h.previewMessagePublish.mockResolvedValue({ success: true, data: { isFirstPublish: true } });
    h.listMessageVersions.mockResolvedValue({ success: true, data: [] });
    expect(await getMessagePublishPreviewAction("m1", "p1")).toEqual({ success: true, data: { isFirstPublish: true } });
    expect(await listMessageVersionsAction("m1", "p1")).toEqual({ success: true, data: [] });
    h.previewMessagePublish.mockResolvedValueOnce({ success: false, error: { code: "FORBIDDEN", message: "owned elsewhere", suggestedFix: "Open it from its owning level to edit it." } });
    expect(await getMessagePublishPreviewAction("m1", "other")).toEqual({
      success: false, error: "owned elsewhere", code: "FORBIDDEN", suggestedFix: "Open it from its owning level to edit it.",
    });
    expect(h.revalidatePath).not.toHaveBeenCalled();
  });
});

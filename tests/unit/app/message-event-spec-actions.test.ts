import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => ({
  auth: vi.fn(), revalidatePath: vi.fn(), resolveCurrentUserId: vi.fn(),
  createMessage: vi.fn(), updateMessage: vi.fn(), deleteMessage: vi.fn(),
  createEventSpec: vi.fn(), updateEventSpecDocument: vi.fn(), renameEventSpec: vi.fn(), deleteEventSpec: vi.fn(),
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
vi.mock("@/services/events/message.service", () => ({ createMessage: h.createMessage, updateMessage: h.updateMessage, deleteMessage: h.deleteMessage }));
vi.mock("@/services/events/event-spec.service", () => ({
  createEventSpec: h.createEventSpec, updateEventSpecDocument: h.updateEventSpecDocument, renameEventSpec: h.renameEventSpec, deleteEventSpec: h.deleteEventSpec,
}));

import { createMessageAction, deleteMessageAction, updateMessageAction } from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/message-actions";
import {
  createEventSpecAction, deleteEventSpecAction, renameEventSpecAction, updateEventSpecDocumentAction,
} from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/event-spec-actions";
import { GENERIC_ACTION_ERROR } from "@/types/action-result";

const CTX = { userId: "u1", userRole: "AUTHOR", prisma: { tag: "prisma" } };
const OWNER = { level: "PRODUCT", productId: "p1" };
const OK = { success: true, data: { id: "x" } };
const SERVICE_MOCKS = [
  h.createMessage, h.updateMessage, h.deleteMessage,
  h.createEventSpec, h.updateEventSpecDocument, h.renameEventSpec, h.deleteEventSpec,
];

beforeEach(() => {
  vi.clearAllMocks();
  h.auth.mockResolvedValue({ user: { id: "u1" } });
  h.resolveCurrentUserId.mockResolvedValue("u1");
  for (const fn of SERVICE_MOCKS) fn.mockResolvedValue(OK);
});

describe("message + event spec actions", () => {
  it("wire product owners through and revalidate after each successful mutation", async () => {
    const input = { name: "OrderCreated", payload: { entityId: "e1" } };
    await createMessageAction("p1", input);
    expect(h.createMessage).toHaveBeenCalledWith("p1", input, CTX);
    await updateMessageAction("m1", "p1", input);
    expect(h.updateMessage).toHaveBeenCalledWith("m1", input, OWNER, CTX);
    await deleteMessageAction("m1", "p1");
    expect(h.deleteMessage).toHaveBeenCalledWith("m1", OWNER, CTX);
    await createEventSpecAction("p1", { name: "checkout-service" });
    expect(h.createEventSpec).toHaveBeenCalledWith("p1", { name: "checkout-service" }, CTX);
    await updateEventSpecDocumentAction("s1", "p1", { info: { title: "x" } });
    expect(h.updateEventSpecDocument).toHaveBeenCalledWith("s1", { info: { title: "x" } }, OWNER, CTX);
    await renameEventSpecAction("s1", "p1", "renamed");
    expect(h.renameEventSpec).toHaveBeenCalledWith("s1", "renamed", OWNER, CTX);
    await deleteEventSpecAction("s1", "p1");
    expect(h.deleteEventSpec).toHaveBeenCalledWith("s1", OWNER, CTX);
    expect(h.revalidatePath).toHaveBeenCalledTimes(7);
    expect(h.revalidatePath).toHaveBeenLastCalledWith("/schemas", "layout");
  });

  it("surfaces validation problems in details and does not revalidate on failure", async () => {
    h.updateEventSpecDocument.mockResolvedValue({ success: false, error: { code: "VALIDATION_ERROR", message: "bad", details: { problems: [{ pointer: "/info/title", message: "x" }] } } });
    expect(await updateEventSpecDocumentAction("s1", "p1", {})).toEqual({
      success: false, error: "bad", code: "VALIDATION_ERROR", details: { problems: [{ pointer: "/info/title", message: "x" }] },
    });
    expect(h.revalidatePath).not.toHaveBeenCalled();
  });

  it("carries suggestedFix of an IN_USE refusal and does not revalidate", async () => {
    h.deleteMessage.mockResolvedValue({ success: false, error: { code: "IN_USE", message: "pinned by a published spec", suggestedFix: "Deprecate it instead" } });
    expect(await deleteMessageAction("m1", "p1")).toEqual({
      success: false, error: "pinned by a published spec", code: "IN_USE", suggestedFix: "Deprecate it instead",
    });
    expect(h.revalidatePath).not.toHaveBeenCalled();
  });

  it("returns NOT_AUTHENTICATED without calling any service when there is no session", async () => {
    h.auth.mockResolvedValue(null);
    expect(await createMessageAction("p1", { name: "OrderCreated", payload: { entityId: "e1" } })).toMatchObject({ success: false, code: "UNAUTHORIZED" });
    expect(await deleteEventSpecAction("s1", "p1")).toMatchObject({ success: false, code: "UNAUTHORIZED" });
    for (const fn of SERVICE_MOCKS) expect(fn).not.toHaveBeenCalled();
    expect(h.revalidatePath).not.toHaveBeenCalled();
  });

  describe("raw database text never reaches the browser (these actions have no per-action sanitizer; runMutation is the backstop)", () => {
    const RAW = 'Invalid `prisma.message.update()` invocation: relation "messages" does not exist at 10.0.0.5:5432';
    let consoleError: ReturnType<typeof vi.spyOn>;
    beforeEach(() => {
      consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    });
    afterEach(() => consoleError.mockRestore());

    it("replaces a DB_ERROR / INTERNAL_ERROR from any message or event spec action with the generic message, logs it under the action name, and does not revalidate", async () => {
      const calls: Array<[string, () => Promise<unknown>]> = [
        ["createMessageAction", () => createMessageAction("p1", { name: "OrderCreated", payload: { entityId: "e1" } })],
        ["updateMessageAction", () => updateMessageAction("m1", "p1", { name: "OrderCreated", payload: { entityId: "e1" } })],
        ["deleteMessageAction", () => deleteMessageAction("m1", "p1")],
        ["createEventSpecAction", () => createEventSpecAction("p1", { name: "checkout-service" })],
        ["updateEventSpecDocumentAction", () => updateEventSpecDocumentAction("s1", "p1", {})],
        ["renameEventSpecAction", () => renameEventSpecAction("s1", "p1", "renamed")],
        ["deleteEventSpecAction", () => deleteEventSpecAction("s1", "p1")],
      ];
      for (const code of ["DB_ERROR", "INTERNAL_ERROR"]) {
        for (const fn of SERVICE_MOCKS) fn.mockResolvedValue({ success: false, error: { code, message: RAW, details: { host: "10.0.0.5" }, suggestedFix: "Check DATABASE_URL" } });
        for (const [name, call] of calls) {
          const r = await call();
          expect(r).toEqual({ success: false, error: GENERIC_ACTION_ERROR, code });
          expect(JSON.stringify(r)).not.toMatch(/prisma|messages|10\.0\.0\.5|DATABASE_URL/);
          expect(consoleError).toHaveBeenCalledWith(`[${name}] ${code === "DB_ERROR" ? "database error" : "internal error"}`, RAW);
        }
      }
      expect(h.revalidatePath).not.toHaveBeenCalled();
    });
  });
});

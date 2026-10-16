import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => ({
  auth: vi.fn(), revalidatePath: vi.fn(), resolveCurrentUserId: vi.fn(), withOwnedTarget: vi.fn(),
  emitEventDraft: vi.fn(), emitEventDocumentPreview: vi.fn(),
}));
// The real parent check (the client-supplied product must lie in the active tenant) is covered by
// tests/unit/app/events-actions-tenant-guard.test.ts; here it is a spy that lets every parent through unless a test says otherwise.
vi.mock("@/lib/action-context", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/action-context")>()),
  withOwnedTarget: h.withOwnedTarget,
}));
vi.mock("@/lib/db", () => ({ prisma: { tag: "prisma" } }));
vi.mock("@/lib/auth", () => ({ auth: h.auth }));
vi.mock("@/lib/current-user", () => ({ resolveCurrentUserId: h.resolveCurrentUserId }));
vi.mock("next/cache", () => ({ revalidatePath: h.revalidatePath }));
vi.mock("@/services/rbac.service", () => ({ getEffectiveRole: vi.fn().mockResolvedValue({ success: true, data: "VIEWER" }) }));
vi.mock("@/services/events/event.service", () => ({
  createEvent: vi.fn(), updateEventDocument: vi.fn(), renameEvent: vi.fn(), deleteEvent: vi.fn(),
}));
vi.mock("@/services/events/event-emit.service", () => ({
  emitEventDraft: h.emitEventDraft, emitEventDocumentPreview: h.emitEventDocumentPreview,
}));

import { emitEventDraftAction, previewEventDocumentAction } from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/event-actions";
import { GENERIC_ACTION_ERROR } from "@/types/action-result";

const CTX = { userId: "u1", userRole: "VIEWER", prisma: { tag: "prisma" } };
const OWNER = { level: "PRODUCT", productId: "p1" };
const EMISSION = {
  document: { asyncapi: "3.0.0" }, json: "{}", yaml: "asyncapi: 3.0.0\n",
  diagnostics: [{ severity: "warning", code: "UNPUBLISHED_PIN", message: "not pinned", pointer: "/messages/0/payload" }],
};
const DRAFT_DOC = { documentVersion: 2, info: { title: "orders" } };
const SERVICE_MOCKS = [h.emitEventDraft, h.emitEventDocumentPreview];

const ALL_ACTIONS: Array<[string, () => Promise<unknown>]> = [
  ["previewEventDocumentAction", () => previewEventDocumentAction("e1", "p1", DRAFT_DOC)],
  ["emitEventDraftAction", () => emitEventDraftAction("e1", "p1")],
];

beforeEach(() => {
  vi.clearAllMocks();
  h.auth.mockResolvedValue({ user: { id: "u1" } });
  h.resolveCurrentUserId.mockResolvedValue("u1");
  h.withOwnedTarget.mockImplementation(async (_target: unknown, run: () => Promise<unknown>) => run());
  for (const fn of SERVICE_MOCKS) fn.mockResolvedValue({ success: true, data: EMISSION });
});

describe("event preview actions", () => {
  it("previewEventDocumentAction emits the UNSAVED document: event id, product id, the document as sent and the context", async () => {
    expect(await previewEventDocumentAction("e1", "p1", DRAFT_DOC)).toEqual({ success: true, data: EMISSION });
    expect(h.emitEventDocumentPreview).toHaveBeenCalledTimes(1);
    expect(h.emitEventDocumentPreview).toHaveBeenCalledWith("e1", "p1", DRAFT_DOC, CTX);
    expect(h.emitEventDraft).not.toHaveBeenCalled();
  });

  it("emitEventDraftAction emits the saved draft: event id, product id and the context", async () => {
    expect(await emitEventDraftAction("e1", "p1")).toEqual({ success: true, data: EMISSION });
    expect(h.emitEventDraft).toHaveBeenCalledTimes(1);
    expect(h.emitEventDraft).toHaveBeenCalledWith("e1", "p1", CTX);
    expect(h.emitEventDocumentPreview).not.toHaveBeenCalled();
  });

  it("returns the nullable artifacts of a render failure as a SUCCESS carrying the diagnostics (no crash, no error)", async () => {
    const failed = {
      document: null, json: null, yaml: null,
      diagnostics: [{ severity: "error", code: "RENDER_FAILED", message: "payload does not render", pointer: "/messages/0/payload" }],
    };
    for (const fn of SERVICE_MOCKS) fn.mockResolvedValue({ success: true, data: failed });
    for (const [, call] of ALL_ACTIONS) expect(await call()).toEqual({ success: true, data: failed });
  });

  it("checks the client-supplied product against the active tenant before every service call", async () => {
    for (const [, call] of ALL_ACTIONS) {
      h.withOwnedTarget.mockClear();
      await call();
      expect(h.withOwnedTarget).toHaveBeenCalledTimes(1);
      expect(h.withOwnedTarget.mock.calls[0][0]).toEqual(OWNER);
    }
  });

  it("never reaches the emit service when the product is not in the active tenant (the NOT_FOUND of an unknown one)", async () => {
    h.withOwnedTarget.mockResolvedValue({ success: false, error: { code: "NOT_FOUND", message: 'Product "p1" not found' } });
    for (const [, call] of ALL_ACTIONS) {
      expect(await call()).toEqual({ success: false, error: 'Product "p1" not found', code: "NOT_FOUND" });
    }
    for (const fn of SERVICE_MOCKS) expect(fn).not.toHaveBeenCalled();
  });

  it("is read-only: a success never revalidates", async () => {
    for (const [, call] of ALL_ACTIONS) await call();
    expect(h.revalidatePath).not.toHaveBeenCalled();
  });

  it("returns a service failure with its message, code and the document problems of an invalid draft", async () => {
    const problems = [{ pointer: "/info/title", message: "Title is required" }];
    h.emitEventDocumentPreview.mockResolvedValue({ success: false, error: { code: "VALIDATION_ERROR", message: "bad document", details: { problems } } });
    expect(await previewEventDocumentAction("e1", "p1", {})).toEqual({
      success: false, error: "bad document", code: "VALIDATION_ERROR", details: { problems },
    });
  });

  it("passes a FORBIDDEN refusal through untouched (the service labels it by id, never by name)", async () => {
    for (const fn of SERVICE_MOCKS) fn.mockResolvedValue({ success: false, error: { code: "FORBIDDEN", message: 'Event "e1" does not belong to this product' } });
    for (const [, call] of ALL_ACTIONS) {
      expect(await call()).toEqual({ success: false, error: 'Event "e1" does not belong to this product', code: "FORBIDDEN" });
    }
  });

  it("answers UNAUTHORIZED without calling the ownership check or any service when there is no session", async () => {
    h.auth.mockResolvedValue(null);
    for (const [, call] of ALL_ACTIONS) expect(await call()).toMatchObject({ success: false, code: "UNAUTHORIZED" });
    for (const fn of SERVICE_MOCKS) expect(fn).not.toHaveBeenCalled();
    expect(h.withOwnedTarget).not.toHaveBeenCalled();
  });

  describe("raw database text and thrown errors never reach the browser", () => {
    const RAW = 'Invalid `prisma.eventSpec.findUnique()` invocation: relation "event_specs" does not exist at 10.0.0.5:5432';
    let consoleError: ReturnType<typeof vi.spyOn>;
    beforeEach(() => {
      consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    });
    afterEach(() => consoleError.mockRestore());

    it("replaces a DB_ERROR / INTERNAL_ERROR with the generic message and logs it under the action name", async () => {
      for (const code of ["DB_ERROR", "INTERNAL_ERROR"]) {
        for (const fn of SERVICE_MOCKS) fn.mockResolvedValue({ success: false, error: { code, message: RAW, details: { host: "10.0.0.5" }, suggestedFix: "Check DATABASE_URL" } });
        for (const [name, call] of ALL_ACTIONS) {
          const r = await call();
          expect(r).toEqual({ success: false, error: GENERIC_ACTION_ERROR, code });
          expect(JSON.stringify(r)).not.toMatch(/prisma|event_specs|10\.0\.0\.5|DATABASE_URL/);
          expect(consoleError).toHaveBeenCalledWith(`[${name}] ${code === "DB_ERROR" ? "database error" : "internal error"}`, RAW);
        }
      }
    });

    it("turns a throwing service into a generic INTERNAL_ERROR and logs it under the action name", async () => {
      const boom = new Error(RAW);
      for (const fn of SERVICE_MOCKS) fn.mockRejectedValue(boom);
      for (const [name, call] of ALL_ACTIONS) {
        const r = await call();
        expect(r).toEqual({ success: false, error: GENERIC_ACTION_ERROR, code: "INTERNAL_ERROR" });
        expect(JSON.stringify(r)).not.toMatch(/prisma|event_specs|10\.0\.0\.5/);
        expect(consoleError).toHaveBeenCalledWith(`[${name}] unexpected error`, boom);
      }
    });

    it("turns a throwing ownership check into a generic INTERNAL_ERROR and never reaches a service", async () => {
      h.withOwnedTarget.mockRejectedValue(new Error(RAW));
      for (const [, call] of ALL_ACTIONS) {
        expect(await call()).toEqual({ success: false, error: GENERIC_ACTION_ERROR, code: "INTERNAL_ERROR" });
      }
      for (const fn of SERVICE_MOCKS) expect(fn).not.toHaveBeenCalled();
    });

    it("turns a throwing session lookup into a generic INTERNAL_ERROR and never reaches a service", async () => {
      h.auth.mockRejectedValue(new Error(RAW));
      for (const [, call] of ALL_ACTIONS) {
        expect(await call()).toEqual({ success: false, error: GENERIC_ACTION_ERROR, code: "INTERNAL_ERROR" });
      }
      for (const fn of SERVICE_MOCKS) expect(fn).not.toHaveBeenCalled();
    });
  });
});

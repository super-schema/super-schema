import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const PRISMA_MOCK = vi.hoisted(() => ({ tag: "prisma", product: { findUnique: vi.fn() } }));
const h = vi.hoisted(() => ({
  auth: vi.fn(), revalidatePath: vi.fn(), getActiveTenantId: vi.fn(), findProduct: vi.fn(),
  createEvent: vi.fn(), updateEventDocument: vi.fn(), renameEvent: vi.fn(), deleteEvent: vi.fn(),
}));
h.findProduct = PRISMA_MOCK.product.findUnique;
// The real guard runs (the principal is a platform administrator unless a test says otherwise): the client-supplied product must lie in the
// active tenant. The role rules of these actions are in events-area-access.test.ts, the foreign-tenant ones in events-actions-tenant-guard.test.ts.
vi.mock("@/lib/db", () => ({ prisma: PRISMA_MOCK }));
vi.mock("@/lib/auth", () => ({ auth: h.auth }));
vi.mock("@/lib/access/principal", async () => (await import("../../helpers/access-mocks")).sessionPrincipalModule);
vi.mock("@/lib/active-tenant", () => ({ getActiveTenantId: h.getActiveTenantId }));
vi.mock("next/cache", () => ({ revalidatePath: h.revalidatePath }));
vi.mock("@/services/events/event.service", () => ({
  createEvent: h.createEvent, updateEventDocument: h.updateEventDocument, renameEvent: h.renameEvent, deleteEvent: h.deleteEvent,
}));

import {
  createEventAction, deleteEventAction, renameEventAction, updateEventDocumentAction,
} from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/event-actions";
import { GENERIC_ACTION_ERROR } from "@/types/action-result";
import { assign, resetSessionPrincipal } from "../../helpers/access-mocks";

const CTX = { userId: "u1", userRole: "ADMIN", assignments: [assign.global()], prisma: PRISMA_MOCK };
const OWNER = { level: "PRODUCT", productId: "p1" };
const DETAIL = { id: "e1", name: "orders" };
const SERVICE_MOCKS = [h.createEvent, h.updateEventDocument, h.renameEvent, h.deleteEvent];

const ALL_ACTIONS: Array<[string, () => Promise<unknown>]> = [
  ["createEventAction", () => createEventAction("p1", { name: "orders" })],
  ["updateEventDocumentAction", () => updateEventDocumentAction("e1", "p1", { documentVersion: 2 })],
  ["renameEventAction", () => renameEventAction("e1", "p1", "renamed")],
  ["deleteEventAction", () => deleteEventAction("e1", "p1")],
];

beforeEach(() => {
  vi.clearAllMocks();
  h.auth.mockResolvedValue({ user: { id: "u1" } });
  resetSessionPrincipal();
  h.getActiveTenantId.mockResolvedValue("t1");
  h.findProduct.mockResolvedValue({ domainId: "d1", domain: { tenantId: "t1" } });
  for (const fn of SERVICE_MOCKS) fn.mockResolvedValue({ success: true, data: DETAIL });
});

describe("event actions", () => {
  it("createEventAction calls createEvent with the product id, the input and the context", async () => {
    const input = { name: "orders", description: "Order events" };
    expect(await createEventAction("p1", input)).toEqual({ success: true, data: DETAIL });
    expect(h.createEvent).toHaveBeenCalledTimes(1);
    expect(h.createEvent).toHaveBeenCalledWith("p1", input, CTX);
  });

  it("updateEventDocumentAction calls updateEventDocument with the event id, the document, the product owner and the context", async () => {
    const document = { documentVersion: 2, info: { title: "x" } };
    expect(await updateEventDocumentAction("e1", "p1", document)).toEqual({ success: true, data: DETAIL });
    expect(h.updateEventDocument).toHaveBeenCalledTimes(1);
    expect(h.updateEventDocument).toHaveBeenCalledWith("e1", document, OWNER, CTX);
  });

  it("renameEventAction calls renameEvent with the event id, the name, the product owner and the context", async () => {
    expect(await renameEventAction("e1", "p1", "renamed")).toEqual({ success: true, data: DETAIL });
    expect(h.renameEvent).toHaveBeenCalledTimes(1);
    expect(h.renameEvent).toHaveBeenCalledWith("e1", "renamed", OWNER, CTX);
  });

  it("deleteEventAction calls deleteEvent with the event id, the product owner and the context", async () => {
    h.deleteEvent.mockResolvedValue({ success: true, data: { id: "e1" } });
    expect(await deleteEventAction("e1", "p1")).toEqual({ success: true, data: { id: "e1" } });
    expect(h.deleteEvent).toHaveBeenCalledTimes(1);
    expect(h.deleteEvent).toHaveBeenCalledWith("e1", OWNER, CTX);
  });

  it("checks the client-supplied product against the active tenant before every service call", async () => {
    for (const [, call] of ALL_ACTIONS) {
      h.findProduct.mockClear();
      await call();
      expect(h.findProduct).toHaveBeenCalledTimes(1);
      expect(h.findProduct.mock.calls[0][0]).toMatchObject({ where: { id: "p1" } });
    }
  });

  it("never reaches a service, and does not revalidate, when the product is not in the active tenant", async () => {
    h.findProduct.mockResolvedValue({ domainId: "d1", domain: { tenantId: "other-tenant" } });
    for (const [, call] of ALL_ACTIONS) {
      expect(await call()).toEqual({ success: false, error: 'Product "p1" not found', code: "NOT_FOUND" });
    }
    for (const fn of SERVICE_MOCKS) expect(fn).not.toHaveBeenCalled();
    expect(h.revalidatePath).not.toHaveBeenCalled();
  });

  it("revalidates /schemas (layout) after each successful mutation", async () => {
    for (const [, call] of ALL_ACTIONS) await call();
    expect(h.revalidatePath).toHaveBeenCalledTimes(4);
    expect(h.revalidatePath).toHaveBeenLastCalledWith("/schemas", "layout");
  });

  it("returns a service failure as the action result, with its details, and does not revalidate", async () => {
    const problems = [{ pointer: "/info/title", message: "Title is required" }];
    h.updateEventDocument.mockResolvedValue({ success: false, error: { code: "VALIDATION_ERROR", message: "bad document", details: { problems } } });
    expect(await updateEventDocumentAction("e1", "p1", {})).toEqual({
      success: false, error: "bad document", code: "VALIDATION_ERROR", details: { problems },
    });
    expect(h.revalidatePath).not.toHaveBeenCalled();
  });

  it("passes a FORBIDDEN refusal through untouched (the service labels it by id, never by name)", async () => {
    for (const fn of SERVICE_MOCKS) fn.mockResolvedValue({ success: false, error: { code: "FORBIDDEN", message: 'Event "e1" does not belong to this product' } });
    for (const [, call] of ALL_ACTIONS) {
      expect(await call()).toEqual({ success: false, error: 'Event "e1" does not belong to this product', code: "FORBIDDEN" });
    }
    expect(h.revalidatePath).not.toHaveBeenCalled();
  });

  it("carries the message and suggestedFix of an IN_USE delete refusal and does not revalidate", async () => {
    h.deleteEvent.mockResolvedValue({
      success: false, error: { code: "IN_USE", message: "referenced by payments/checkout", suggestedFix: "Remove the external reference first" },
    });
    expect(await deleteEventAction("e1", "p1")).toEqual({
      success: false, error: "referenced by payments/checkout", code: "IN_USE", suggestedFix: "Remove the external reference first",
    });
    expect(h.revalidatePath).not.toHaveBeenCalled();
  });

  it("answers UNAUTHORIZED without calling any service when there is no session", async () => {
    h.auth.mockResolvedValue(null);
    for (const [, call] of ALL_ACTIONS) expect(await call()).toMatchObject({ success: false, code: "UNAUTHORIZED" });
    for (const fn of SERVICE_MOCKS) expect(fn).not.toHaveBeenCalled();
    expect(h.findProduct).not.toHaveBeenCalled();
    expect(h.revalidatePath).not.toHaveBeenCalled();
  });

  describe("raw database text and thrown errors never reach the browser", () => {
    const RAW = 'Invalid `prisma.eventSpec.update()` invocation: relation "event_specs" does not exist at 10.0.0.5:5432';
    let consoleError: ReturnType<typeof vi.spyOn>;
    beforeEach(() => {
      consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    });
    afterEach(() => consoleError.mockRestore());

    it("replaces a DB_ERROR / INTERNAL_ERROR from any action with the generic message, logs it under the action name, and does not revalidate", async () => {
      for (const code of ["DB_ERROR", "INTERNAL_ERROR"]) {
        for (const fn of SERVICE_MOCKS) fn.mockResolvedValue({ success: false, error: { code, message: RAW, details: { host: "10.0.0.5" }, suggestedFix: "Check DATABASE_URL" } });
        for (const [name, call] of ALL_ACTIONS) {
          const r = await call();
          expect(r).toEqual({ success: false, error: GENERIC_ACTION_ERROR, code });
          expect(JSON.stringify(r)).not.toMatch(/prisma|event_specs|10\.0\.0\.5|DATABASE_URL/);
          expect(consoleError).toHaveBeenCalledWith(`[${name}] ${code === "DB_ERROR" ? "database error" : "internal error"}`, RAW);
        }
      }
      expect(h.revalidatePath).not.toHaveBeenCalled();
    });

    it("turns a throwing service into a generic INTERNAL_ERROR, logs it under the action name, and does not revalidate", async () => {
      const boom = new Error(RAW);
      for (const fn of SERVICE_MOCKS) fn.mockRejectedValue(boom);
      for (const [name, call] of ALL_ACTIONS) {
        const r = await call();
        expect(r).toEqual({ success: false, error: GENERIC_ACTION_ERROR, code: "INTERNAL_ERROR" });
        expect(JSON.stringify(r)).not.toMatch(/prisma|event_specs|10\.0\.0\.5/);
        expect(consoleError).toHaveBeenCalledWith(`[${name}] unexpected error`, boom);
      }
      expect(h.revalidatePath).not.toHaveBeenCalled();
    });

    it("turns a throwing ownership check into a generic INTERNAL_ERROR and never reaches a service", async () => {
      h.findProduct.mockRejectedValue(new Error(RAW));
      for (const [, call] of ALL_ACTIONS) {
        expect(await call()).toEqual({ success: false, error: GENERIC_ACTION_ERROR, code: "INTERNAL_ERROR" });
      }
      for (const fn of SERVICE_MOCKS) expect(fn).not.toHaveBeenCalled();
    });
  });
});

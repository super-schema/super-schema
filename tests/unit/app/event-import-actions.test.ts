import { assign, resetSessionPrincipal } from "../../helpers/access-mocks";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => ({
  auth: vi.fn(), revalidatePath: vi.fn(), findProduct: vi.fn(), getActiveTenantId: vi.fn(),
  previewAsyncApiImport: vi.fn(), importAsyncApi: vi.fn(),
}));
// The real guard runs (the principal is a platform administrator unless a test says otherwise): the client-supplied product must lie in the
// active tenant. The role rules of these actions are in events-area-access.test.ts, the foreign-tenant ones in events-actions-tenant-guard.test.ts.
vi.mock("@/lib/db", () => ({ prisma: { tag: "prisma", product: { findUnique: h.findProduct } } }));
vi.mock("@/lib/access/principal", async () => (await import("../../helpers/access-mocks")).sessionPrincipalModule);
vi.mock("@/lib/active-tenant", () => ({ getActiveTenantId: h.getActiveTenantId }));
vi.mock("@/lib/auth", () => ({ auth: h.auth }));
vi.mock("next/cache", () => ({ revalidatePath: h.revalidatePath }));
vi.mock("@/services/events/event.service", () => ({
  createEvent: vi.fn(), updateEventDocument: vi.fn(), renameEvent: vi.fn(), deleteEvent: vi.fn(),
}));
vi.mock("@/services/events/asyncapi-import.service", () => ({
  previewAsyncApiImport: h.previewAsyncApiImport, importAsyncApi: h.importAsyncApi,
}));

import { importAsyncApiAction, previewAsyncApiImportAction } from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/event-actions";
import { GENERIC_ACTION_ERROR } from "@/types/action-result";

const CTX = { userId: "u1", userRole: "ADMIN", assignments: [assign.global()], prisma: { tag: "prisma", product: { findUnique: h.findProduct } } };
const INPUT = { content: "asyncapi: 3.0.0\n", fileName: "orders.yaml", eventName: "orders" };
const PREVIEW = {
  eventName: "orders", title: "Orders",
  counts: { servers: 1, channels: 1, messages: 1, operations: 1, traits: 0, securitySchemes: 0 },
  entities: [{ requestedName: "OrderCreated", name: "OrderCreated2", renamed: true, fields: 3, format: "json-schema" }],
  builtInTraits: ["CloudEvents"],
  warnings: [{ pointer: "/components/messages/orderCreated/payload", code: "ENTITY_RENAMED", message: "renamed" }],
};
const IMPORTED = { eventId: "e1", preview: PREVIEW };

const ACTIONS: Array<{ label: string; call: () => Promise<unknown>; service: ReturnType<typeof vi.fn>; data: unknown; mutates: boolean }> = [
  { label: "previewAsyncApiImportAction", call: () => previewAsyncApiImportAction("p1", INPUT), service: h.previewAsyncApiImport, data: PREVIEW, mutates: false },
  { label: "importAsyncApiAction", call: () => importAsyncApiAction("p1", INPUT), service: h.importAsyncApi, data: IMPORTED, mutates: true },
];

beforeEach(() => {
  vi.clearAllMocks();
  h.auth.mockResolvedValue({ user: { id: "u1" } });
  resetSessionPrincipal();
  h.findProduct.mockResolvedValue({ domainId: "d1", domain: { tenantId: "t1" } });
  h.getActiveTenantId.mockResolvedValue("t1");
  h.previewAsyncApiImport.mockResolvedValue({ success: true, data: PREVIEW });
  h.importAsyncApi.mockResolvedValue({ success: true, data: IMPORTED });
});

describe.each(ACTIONS)("$label", ({ label, call, service, data, mutates }) => {
  it("takes the product FIRST and runs the service with it, the untouched input and the caller's context", async () => {
    expect(await call()).toEqual({ success: true, data });
    expect(service).toHaveBeenCalledTimes(1);
    expect(service).toHaveBeenCalledWith("p1", INPUT, CTX);
  });

  it("checks the client-supplied product against the active tenant before the service", async () => {
    await call();
    expect(h.findProduct).toHaveBeenCalledTimes(1);
    expect(h.findProduct.mock.calls[0][0]).toMatchObject({ where: { id: "p1" } });
  });

  it("never reaches the service when the product is not in the active tenant (the NOT_FOUND of an unknown one)", async () => {
    h.findProduct.mockResolvedValue(null);
    expect(await call()).toEqual({ success: false, error: 'Product "p1" not found', code: "NOT_FOUND" });
    expect(service).not.toHaveBeenCalled();
    expect(h.revalidatePath).not.toHaveBeenCalled();
  });

  it(mutates ? "revalidates /schemas (layout) on success only" : "is read-only: a success never revalidates", async () => {
    await call();
    if (mutates) expect(h.revalidatePath).toHaveBeenCalledWith("/schemas", "layout");
    else expect(h.revalidatePath).not.toHaveBeenCalled();
    h.revalidatePath.mockClear();
    service.mockResolvedValue({ success: false, error: { code: "VALIDATION_ERROR", message: "bad" } });
    await call();
    expect(h.revalidatePath).not.toHaveBeenCalled();
  });

  it("answers UNAUTHORIZED without the ownership check or the service when there is no session", async () => {
    h.auth.mockResolvedValue(null);
    expect(await call()).toMatchObject({ success: false, code: "UNAUTHORIZED" });
    expect(h.findProduct).not.toHaveBeenCalled();
    expect(service).not.toHaveBeenCalled();
  });

  it("returns a validation failure with its diagnostics (message and pointer) and the suggested fix", async () => {
    const problems = [{ pointer: "/operations/turnOn/action", message: "must be equal to one of the allowed values", code: "asyncapi3-document-structure" }];
    service.mockResolvedValue({ success: false, error: { code: "VALIDATION_ERROR", message: "The AsyncAPI document is not valid", details: { problems }, suggestedFix: "Fix the document and import it again." } });
    expect(await call()).toEqual({
      success: false, error: "The AsyncAPI document is not valid", code: "VALIDATION_ERROR", details: { problems }, suggestedFix: "Fix the document and import it again.",
    });
  });

  it("passes the importer's own codes through (UNSUPPORTED_VERSION, EXTERNAL_REF, PARSE_ERROR)", async () => {
    for (const code of ["UNSUPPORTED_VERSION", "EXTERNAL_REF", "PARSE_ERROR", "REF_CYCLE"]) {
      service.mockResolvedValue({ success: false, error: { code, message: `m-${code}` } });
      expect(await call()).toEqual({ success: false, error: `m-${code}`, code });
    }
  });

  it("passes a rollback report through: IMPORT_FAILED keeps its message and the leftovers an owner must remove", async () => {
    const details = { deletedEntities: 1, leftovers: [{ kind: "entity", id: "x1", name: "DimLight", code: "IN_USE", message: "referenced" }] };
    service.mockResolvedValue({ success: false, error: { code: "IMPORT_FAILED", message: "The import failed. The import could not be undone completely: the entity \"DimLight\" is still in the product; delete it by hand.", details } });
    expect(await call()).toEqual({
      success: false, code: "IMPORT_FAILED", details,
      error: "The import failed. The import could not be undone completely: the entity \"DimLight\" is still in the product; delete it by hand.",
    });
  });

  describe("raw database text and thrown errors never reach the browser", () => {
    const RAW = 'Invalid `prisma.entity.create()` invocation: relation "entities" does not exist at 10.0.0.5:5432';
    let consoleError: ReturnType<typeof vi.spyOn>;
    beforeEach(() => {
      consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    });
    afterEach(() => consoleError.mockRestore());

    it("replaces a DB_ERROR / INTERNAL_ERROR with the generic message (no details, no fix) and logs it under the action name", async () => {
      for (const code of ["DB_ERROR", "INTERNAL_ERROR"]) {
        service.mockResolvedValue({ success: false, error: { code, message: RAW, details: { host: "10.0.0.5" }, suggestedFix: "Check DATABASE_URL" } });
        const result = await call();
        expect(result).toEqual({ success: false, error: GENERIC_ACTION_ERROR, code });
        expect(JSON.stringify(result)).not.toMatch(/prisma|entities|10\.0\.0\.5|DATABASE_URL/);
        expect(consoleError).toHaveBeenCalledWith(`[${label}] ${code === "DB_ERROR" ? "database error" : "internal error"}`, RAW);
      }
    });

    it("turns a throwing service into a generic INTERNAL_ERROR and logs it under the action name", async () => {
      const boom = new Error(RAW);
      service.mockRejectedValue(boom);
      const result = await call();
      expect(result).toEqual({ success: false, error: GENERIC_ACTION_ERROR, code: "INTERNAL_ERROR" });
      expect(JSON.stringify(result)).not.toMatch(/prisma|entities|10\.0\.0\.5/);
      expect(consoleError).toHaveBeenCalledWith(`[${label}] unexpected error`, boom);
    });

    it("turns a throwing ownership check or session lookup into a generic INTERNAL_ERROR and never reaches the service", async () => {
      h.findProduct.mockRejectedValue(new Error(RAW));
      expect(await call()).toEqual({ success: false, error: GENERIC_ACTION_ERROR, code: "INTERNAL_ERROR" });
      h.findProduct.mockResolvedValue({ domainId: "d1", domain: { tenantId: "t1" } });
      h.auth.mockRejectedValue(new Error(RAW));
      expect(await call()).toEqual({ success: false, error: GENERIC_ACTION_ERROR, code: "INTERNAL_ERROR" });
      expect(service).not.toHaveBeenCalled();
    });
  });
});

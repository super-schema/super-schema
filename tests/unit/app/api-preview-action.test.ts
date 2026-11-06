import { beforeEach, describe, expect, it, vi } from "vitest";

// The API tab preview: the openapi3 closure emission of the entity (draft), read-only, guarded by `schema.generate`.

const h = vi.hoisted(() => ({
  guardSubject: vi.fn(),
  loadReferenceClosure: vi.fn(),
  emitClosureTarget: vi.fn(),
  getActiveTenantId: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ prisma: { tag: "prisma" } }));
vi.mock("@/lib/active-tenant", () => ({ getActiveTenantId: h.getActiveTenantId }));
vi.mock("@/lib/access", () => ({ entityReader: () => "reader" }));
vi.mock("@/lib/action-context", () => ({
  guardSubject: h.guardSubject,
  failureOf: (error: { code: string; message: string }) => ({ error: error.message, code: error.code }),
  unexpectedFailure: () => ({ error: "Something went wrong", code: "INTERNAL_ERROR" }),
}));
vi.mock("@/lib/references/closure", () => ({ loadReferenceClosure: h.loadReferenceClosure }));
vi.mock("@/lib/emission/closure-generation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/emission/closure-generation")>()),
  emitClosureTarget: h.emitClosureTarget,
}));

import { previewEntityOpenApiAction } from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/api-preview-actions";

beforeEach(() => {
  vi.clearAllMocks();
  h.getActiveTenantId.mockResolvedValue("t1");
  h.guardSubject.mockResolvedValue({ allowed: true, principal: { assignments: [] }, resource: {} });
  h.loadReferenceClosure.mockResolvedValue({ success: true, data: { entities: [], cycles: [] } });
});

describe("previewEntityOpenApiAction", () => {
  it("returns the entity's own OpenAPI file of the openapi3 closure emission, in draft mode", async () => {
    h.emitClosureTarget.mockResolvedValue({
      output: "",
      validationStatus: "WARNING",
      warnings: ["w1"],
      errors: [],
      files: [
        { path: "openapi.Customer.yaml", content: "openapi: 3.0.0 # customer", target: "openapi3", entityId: "c" },
        { path: "openapi.Order.yaml", content: "openapi: 3.0.0 # order", target: "openapi3", entityId: "e1" },
      ],
    });
    const result = await previewEntityOpenApiAction("e1");
    expect(h.guardSubject).toHaveBeenCalledWith("schema.generate", { kind: "entity", id: "e1" }, { label: "Entity" });
    expect(h.loadReferenceClosure).toHaveBeenCalledWith({ tag: "prisma" }, "t1", "e1", "draft", { reader: "reader" });
    expect(h.emitClosureTarget).toHaveBeenCalledWith(expect.anything(), "openapi3");
    expect(result).toEqual({ success: true, yaml: "openapi: 3.0.0 # order", path: "openapi.Order.yaml", validationStatus: "WARNING", warnings: ["w1"], errors: [] });
  });

  it("reports an emission failure as INVALID with the emitter's messages", async () => {
    h.emitClosureTarget.mockResolvedValue({ output: "", validationStatus: "INVALID", warnings: [], errors: [{ message: "Unknown identifier Foo" }] });
    expect(await previewEntityOpenApiAction("e1")).toMatchObject({ success: true, yaml: "", validationStatus: "INVALID", errors: ["Unknown identifier Foo"] });
  });

  it("refuses an entity the caller may not generate for, before loading anything", async () => {
    h.guardSubject.mockResolvedValue({ allowed: false, refusal: { error: "Entity not found", code: "NOT_FOUND" } });
    expect(await previewEntityOpenApiAction("e1")).toEqual({ error: "Entity not found", code: "NOT_FOUND" });
    expect(h.loadReferenceClosure).not.toHaveBeenCalled();
  });

  it("reports a closure that could not be built", async () => {
    h.loadReferenceClosure.mockResolvedValue({ success: false, error: { code: "CROSS_TENANT" } });
    expect(await previewEntityOpenApiAction("e1")).toMatchObject({ error: expect.any(String) });
    expect(h.emitClosureTarget).not.toHaveBeenCalled();
  });

  it("rejects a missing id", async () => {
    expect(await previewEntityOpenApiAction("")).toMatchObject({ code: "VALIDATION_ERROR" });
  });
});

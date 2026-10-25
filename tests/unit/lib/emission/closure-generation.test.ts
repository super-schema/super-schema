import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ emitClosure: vi.fn() }));
vi.mock("@/lib/typespec-official/closure-emit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/typespec-official/closure-emit")>()),
  emitClosure: h.emitClosure,
}));

import { closureFailure, describeResolution, emitClosureTarget } from "@/lib/emission/closure-generation";
import { bundleEmittedFiles } from "@/lib/typespec-official/closure-emit";
import type { ClosureError, ReferenceClosure } from "@/lib/references/closure";

const ref = (entity: string, domain = "Sales", product = "Crm") => ({ entityId: `id-${entity}`, domain, product, entity });
const member = (entity: string, source: "published" | "draft" | "pinned", version?: string) =>
  ({ entityId: `id-${entity}`, ref: ref(entity), source, ...(version ? { version } : {}), fields: [], entity: {} }) as unknown as ReferenceClosure["entities"][number];

describe("closureFailure", () => {
  it("turns an ambiguous reference into a structured error carrying the candidates and where to pick", () => {
    const error: ClosureError = {
      code: "AMBIGUOUS_REFERENCE",
      field: "addr",
      name: "Address",
      candidates: [ref("Address", "d1", "p1"), ref("Address", "d2", "p2")],
      entityId: "e1",
      fieldId: "f1",
    };
    const failure = closureFailure(error);
    expect(failure.code).toBe("AMBIGUOUS_REFERENCE");
    expect(failure.message).toContain('"addr"');
    expect(failure.message).toContain("d1 / p1 / Address");
    expect(failure.message).toContain("d2 / p2 / Address");
    expect(failure.details).toEqual({ field: "addr", name: "Address", candidates: error.candidates, entityId: "e1", fieldId: "f1" });
  });

  it("names the entity that was never published, the pin that is gone and the size limit", () => {
    expect(closureFailure({ code: "NEVER_PUBLISHED", ref: ref("Address") })).toMatchObject({
      code: "NEVER_PUBLISHED",
      message: expect.stringContaining("Sales / Crm / Address"),
    });
    const pin = closureFailure({ code: "PIN_NOT_FOUND", field: "addr", ref: ref("Address"), version: "9.9" });
    expect(pin).toMatchObject({ code: "PIN_NOT_FOUND" });
    expect(pin.message).toContain("9.9");
    expect(pin.message).toContain("Sales / Crm / Address");
    expect(pin.message).toContain('"addr"');
    expect(closureFailure({ code: "CLOSURE_TOO_LARGE", limit: 200 })).toMatchObject({ code: "CLOSURE_TOO_LARGE", message: expect.stringContaining("200") });
  });

  it("a PIN_CONFLICT names the entity, both pinning fields with their owners and versions, and how to fix it", () => {
    const failure = closureFailure({
      code: "PIN_CONFLICT",
      ref: ref("Address"),
      pins: [
        { field: "home", owner: ref("Customer"), version: "1.0" },
        { field: "billing", owner: ref("Invoice"), version: "2.0" },
      ],
    });
    expect(failure.code).toBe("PIN_CONFLICT");
    expect(failure.message).toContain("Sales / Crm / Address");
    expect(failure.message).toContain("Customer.home");
    expect(failure.message).toContain("1.0");
    expect(failure.message).toContain("Invoice.billing");
    expect(failure.message).toContain("2.0");
    expect(failure.message).toMatch(/same version|unpin/i);
    expect(failure.details).toMatchObject({ ref: ref("Address"), pins: expect.any(Array) });
  });

  it("answers a cross-tenant root like a missing entity", () => {
    expect(closureFailure({ code: "CROSS_TENANT" })).toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("describeResolution", () => {
  const closure = (entities: ReferenceClosure["entities"]) => ({ entities, draftEntities: entities.filter((e) => e.source === "draft").map((e) => e.ref) });

  it("is a preview as soon as any entity came from unpublished rows, and lists every entity root first", () => {
    const resolution = describeResolution(closure([member("A", "draft"), member("B", "draft"), member("C", "pinned", "1.0")]), "draft");
    expect(resolution).toEqual({
      mode: "draft",
      preview: true,
      entities: [
        { ref: ref("A"), source: "draft" },
        { ref: ref("B"), source: "draft" },
        { ref: ref("C"), source: "pinned", version: "1.0" },
      ],
    });
  });

  it("carries the closure's resolution notes (a pin used for an unpinned edge too), and omits the key when there are none", () => {
    const notes = ["A.x is unpinned but A.y pins B 1.0: the pin was used for both."];
    expect(describeResolution({ ...closure([member("A", "draft"), member("B", "pinned", "1.0")]), notes }, "draft").notes).toEqual(notes);
    expect("notes" in describeResolution({ ...closure([member("A", "draft")]), notes: [] }, "draft")).toBe(false);
  });

  it("is not a preview when everything is published or pinned, and records each version", () => {
    const resolution = describeResolution(closure([member("A", "published", "2.1"), member("B", "pinned", "1.0")]), "published");
    expect(resolution.preview).toBe(false);
    expect(resolution.mode).toBe("published");
    expect(resolution.entities.map((e) => [e.ref.entity, e.source, e.version])).toEqual([["A", "published", "2.1"], ["B", "pinned", "1.0"]]);
  });
});

describe("emitClosureTarget", () => {
  const closure = { entities: [member("A", "draft")], cycles: [] };
  beforeEach(() => h.emitClosure.mockReset());

  it("bundles the files into `output` exactly as the schema version stores it", async () => {
    const files = [
      { path: "A.json", content: '{"a":1}\n', target: "json-schema", entityId: "id-A" },
      { path: "B.json", content: '{"b":2}', target: "json-schema", entityId: "id-B" },
    ];
    h.emitClosure.mockResolvedValue({ success: true, data: { files, warnings: [], entityFiles: {} } });
    const result = await emitClosureTarget(closure, "json-schema");
    expect(result.output).toBe(bundleEmittedFiles(files));
    expect(result.output).toBe('===== A.json =====\n{"a":1}\n\n===== B.json =====\n{"b":2}');
    expect(result.files).toEqual(files);
    expect(result).toMatchObject({ validationStatus: "VALID", warnings: [], errors: [] });
  });

  it("is a WARNING result when the emission has warnings, a single file stays its bare content", async () => {
    const files = [{ path: "A.avsc.json", content: "{}", target: "avro", entityId: "id-A" }];
    h.emitClosure.mockResolvedValue({ success: true, data: { files, warnings: ["shared namespace"], entityFiles: {} } });
    const result = await emitClosureTarget(closure, "avro");
    expect(result).toMatchObject({ output: "{}", validationStatus: "WARNING", warnings: ["shared namespace"] });
  });

  it("is an INVALID result with the emitter's messages and no files when the emission fails", async () => {
    h.emitClosure.mockResolvedValue({ success: false, error: { code: "EMISSION_INVALID", message: "x", details: { errors: ["bad one", "bad two"], warnings: ["w"] } } });
    const result = await emitClosureTarget(closure, "protobuf");
    expect(result).toEqual({ output: "", validationStatus: "INVALID", warnings: ["w"], errors: [{ message: "bad one" }, { message: "bad two" }] });
    expect(result.files).toBeUndefined();
  });
});

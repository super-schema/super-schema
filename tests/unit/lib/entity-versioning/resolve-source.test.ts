import { describe, it, expect, vi } from "vitest";
import {
  resolveDraftSource,
  referencedModelNames,
  stubUnresolvedReferences,
  type ResolveSourceDeps,
} from "@/lib/entity-versioning/resolve-source";

function model(over: { name?: string; fields?: unknown[]; parentEntityName?: string; spreadFrom?: string[] } = {}) {
  return {
    entity: { name: over.name ?? "Order", parentEntityName: over.parentEntityName, spreadFrom: over.spreadFrom },
    fields: over.fields ?? [],
    relationships: [],
  } as never;
}

function deps(over: Partial<ResolveSourceDeps> = {}): ResolveSourceDeps & {
  loadModel: ReturnType<typeof vi.fn>;
  generate: ReturnType<typeof vi.fn>;
  compile: ReturnType<typeof vi.fn>;
} {
  return {
    loadModel: vi.fn().mockResolvedValue({ success: true, data: model() }),
    generate: vi.fn().mockReturnValue("model Order {\n  id?: string;\n}\n"),
    compile: vi.fn().mockResolvedValue({ success: true, diagnostics: [] }),
    ...over,
  } as never;
}

const DB = {} as never;

describe("resolveDraftSource", () => {
  it("uses the stored source untouched when it is present and not stale", async () => {
    const d = deps();
    const res = await resolveDraftSource(DB, "e1", "model Order { hand: string; }", false, d);
    expect(res).toEqual({ success: true, data: { source: "model Order { hand: string; }", regenerated: false } });
    expect(d.loadModel).not.toHaveBeenCalled();
    expect(d.compile).not.toHaveBeenCalled();
  });

  it("regenerates from the field rows when the stored source is stale", async () => {
    const d = deps();
    const res = await resolveDraftSource(DB, "e1", "model Order { old: string; }", true, d);
    expect(res).toEqual({ success: true, data: { source: "model Order {\n  id?: string;\n}\n", regenerated: true } });
    expect(d.compile).toHaveBeenCalledWith("model Order {\n  id?: string;\n}\n");
  });

  it("regenerates when there is no stored source", async () => {
    const d = deps();
    const res = await resolveDraftSource(DB, "e1", null, false, d);
    expect(res.success && res.data.regenerated).toBe(true);
  });

  it("blocks the publish with the compiler diagnostics when the regenerated source does not compile", async () => {
    const d = deps({
      compile: vi.fn().mockResolvedValue({
        success: false,
        diagnostics: [
          { severity: "error", code: "invalid-ref", message: "Unknown identifier Thing" },
          { severity: "warning", code: "w", message: "just a warning" },
        ],
      }),
    });
    const res = await resolveDraftSource(DB, "e1", null, true, d);
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.code).toBe("PUBLISH_BLOCKED");
      expect(res.error.message).toContain("does not compile");
      expect(res.error.message).toContain("Unknown identifier Thing");
      expect(res.error.message).not.toContain("just a warning");
      expect((res.error.details as { diagnostics: unknown[] }).diagnostics).toHaveLength(2);
    }
  });

  it("passes loader failures through", async () => {
    const d = deps({ loadModel: vi.fn().mockResolvedValue({ success: false, error: { code: "NOT_FOUND", message: "gone" } }) });
    const res = await resolveDraftSource(DB, "e1", null, true, d);
    expect(res).toEqual({ success: false, error: { code: "NOT_FOUND", message: "gone" } });
    expect(d.compile).not.toHaveBeenCalled();
  });

  it("gates reference fields with stub models but freezes the unstubbed source", async () => {
    const m = model({
      fields: [
        { name: "buyer", complexType: { referencedEntityId: "b1", referencedEntityName: "Buyer" } },
        { name: "id", complexType: undefined },
      ],
    });
    const d = deps({
      loadModel: vi.fn().mockResolvedValue({ success: true, data: m }),
      generate: vi.fn().mockReturnValue("model Order {\n  buyer?: Buyer;\n}\n"),
    });
    const res = await resolveDraftSource(DB, "e1", null, true, d);
    expect(d.compile).toHaveBeenCalledWith("model Order {\n  buyer?: Buyer;\n}\n\nmodel Buyer {}\n");
    expect(res).toEqual({ success: true, data: { source: "model Order {\n  buyer?: Buyer;\n}\n", regenerated: true } });
  });
});

describe("referencedModelNames / stubUnresolvedReferences", () => {
  it("collects reference, parent and spread names, sanitised and de-duplicated", () => {
    const m = model({
      parentEntityName: "Base Thing",
      spreadFrom: ["Audit", "Audit"],
      fields: [
        { complexType: { referencedEntityName: "Buyer" } },
        { complexType: { referencedEntityName: "Buyer" } },
        { complexType: { referencedEntityName: "my-entity" } },
        { complexType: {} },
        {},
      ],
    });
    expect(referencedModelNames(m).sort()).toEqual(["Audit", "Base_Thing", "Buyer", "my_entity"]);
  });

  it("never stubs a name the source already declares (including the entity's own model)", () => {
    const src = "model Order {\n  parent?: Order;\n  buyer?: Buyer;\n}\nenum Buyer2 { a }\n";
    expect(stubUnresolvedReferences(src, ["Order", "Buyer", "Buyer2"])).toBe(`${src}\nmodel Buyer {}\n`);
  });

  it("returns the source unchanged when there is nothing to stub", () => {
    expect(stubUnresolvedReferences("model A {}\n", [])).toBe("model A {}\n");
  });
});

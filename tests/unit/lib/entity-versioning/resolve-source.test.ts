import { describe, it, expect, vi } from "vitest";
import {
  needsRegeneration,
  compileRegeneratedSource,
  confirmRegeneratedSource,
  referencedModelNames,
  stubUnresolvedReferences,
  type ResolveSourceDeps,
} from "@/lib/entity-versioning/resolve-source";
import { compileTypeSpecWithGovernance } from "@/lib/compiler/typespec-compiler";
import { generateTypeSpec } from "@/lib/compiler/typespec-generator";
import { compileEntity } from "@/lib/compiler/compiler.service";

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

describe("needsRegeneration", () => {
  it("is true when the stored source is missing or stale, false only for a fresh stored source", () => {
    expect(needsRegeneration(null, false)).toBe(true);
    expect(needsRegeneration("", false)).toBe(true);
    expect(needsRegeneration("model A {}", true)).toBe(true);
    expect(needsRegeneration("model A {}", false)).toBe(false);
  });
});

describe("compileRegeneratedSource (phase 1, outside the lock)", () => {
  it("regenerates from the field rows, compiles the text, and returns the generated source", async () => {
    const d = deps();
    const res = await compileRegeneratedSource(DB, "e1", d);
    expect(res).toEqual({ success: true, data: "model Order {\n  id?: string;\n}\n" });
    expect(d.compile).toHaveBeenCalledWith("model Order {\n  id?: string;\n}\n");
  });

  it("blocks with the compiler diagnostics when the regenerated source does not compile", async () => {
    const d = deps({
      compile: vi.fn().mockResolvedValue({
        success: false,
        diagnostics: [
          { severity: "error", code: "invalid-ref", message: "Unknown identifier Thing" },
          { severity: "warning", code: "w", message: "just a warning" },
        ],
      }),
    });
    const res = await compileRegeneratedSource(DB, "e1", d);
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.code).toBe("PUBLISH_BLOCKED");
      expect(res.error.message).toContain("does not compile");
      expect(res.error.message).toContain("Unknown identifier Thing");
      expect(res.error.message).not.toContain("just a warning");
      expect((res.error.details as { diagnostics: unknown[] }).diagnostics).toHaveLength(2);
    }
  });

  it("passes loader failures through without compiling", async () => {
    const d = deps({ loadModel: vi.fn().mockResolvedValue({ success: false, error: { code: "NOT_FOUND", message: "gone" } }) });
    const res = await compileRegeneratedSource(DB, "e1", d);
    expect(res).toEqual({ success: false, error: { code: "NOT_FOUND", message: "gone" } });
    expect(d.compile).not.toHaveBeenCalled();
  });

  it("gates reference fields with stub models but returns the unstubbed source", async () => {
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
    const res = await compileRegeneratedSource(DB, "e1", d);
    expect(d.compile).toHaveBeenCalledWith("model Order {\n  buyer?: Buyer;\n}\n\nmodel Buyer {}\n");
    expect(res).toEqual({ success: true, data: "model Order {\n  buyer?: Buyer;\n}\n" });
  });

  it("hands the generator's own text to the compiler verbatim: nothing is stripped (Story 16.6)", async () => {
    const text = [
      'import "@superschema/typespec-enterprise";',
      "",
      '@doc("Orders")',
      "model Order {",
      "  @Enterprise.dataClassification(Enterprise.DataClassification.PII)",
      "  email?: string;",
      "}",
      "",
    ].join("\n");
    const d = deps({ generate: vi.fn().mockReturnValue(text) });
    const res = await compileRegeneratedSource(DB, "e1", d);

    expect(d.compile).toHaveBeenCalledWith(text);
    expect(res).toEqual({ success: true, data: text });
  });

  it("gates a tagged entity with classified fields through the REAL generator + compiler (Story 16.6)", async () => {
    const f = (name: string, classification: string | null, i: number) => ({
      id: `f-${name}`, name, type: "string", precision: null, scale: null, nullable: true, isKey: false,
      fieldNumber: null, description: "", classification, aliases: [] as string[], decorators: {}, sortOrder: i,
    });
    const real = compileEntity(
      { id: "e1", name: "Order", description: "Orders", status: "DRAFT", version: 1, domainId: null, metadata: { tags: ["sales"] }, domain: null },
      [f("id", null, 0), f("email", "PII", 1), f("code", "TOP_SECRET", 2)]
    );

    const res = await compileRegeneratedSource(DB, "e1", {
      loadModel: vi.fn().mockResolvedValue({ success: true, data: real }),
      generate: generateTypeSpec,
      compile: compileTypeSpecWithGovernance,
    });

    expect(res).toEqual({ success: true, data: generateTypeSpec(real) });
  }, 60_000);
});

describe("confirmRegeneratedSource (phase 2, inside the lock)", () => {
  it("accepts the precompiled text when the regenerated text is identical, without compiling again", async () => {
    const d = deps();
    const res = await confirmRegeneratedSource(DB, "e1", "model Order {\n  id?: string;\n}\n", d);
    expect(res).toEqual({ success: true, data: undefined });
    expect(d.compile).not.toHaveBeenCalled();
  });

  it("aborts with a retryable CONFLICT when the entity changed since the compile", async () => {
    const d = deps({ generate: vi.fn().mockReturnValue("model Order {\n  id?: string;\n  note?: string;\n}\n") });
    const res = await confirmRegeneratedSource(DB, "e1", "model Order {\n  id?: string;\n}\n", d);
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.code).toBe("CONFLICT");
      expect(res.error.message).toBe("Entity changed during publish, try again");
    }
    expect(d.compile).not.toHaveBeenCalled();
  });

  it("passes loader failures through", async () => {
    const d = deps({ loadModel: vi.fn().mockResolvedValue({ success: false, error: { code: "NOT_FOUND", message: "gone" } }) });
    expect(await confirmRegeneratedSource(DB, "e1", "x", d)).toEqual({
      success: false,
      error: { code: "NOT_FOUND", message: "gone" },
    });
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

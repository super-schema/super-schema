import { describe, it, expect, vi } from "vitest";
import {
  needsRegeneration,
  compileClosure,
  compileRegeneratedSource,
  confirmRegeneratedSource,
  type ResolveSourceDeps,
} from "@/lib/entity-versioning/resolve-source";
import * as resolveSource from "@/lib/entity-versioning/resolve-source";
import { compileTypeSpecWithGovernance } from "@/lib/compiler/typespec-compiler";
import { generateTypeSpec } from "@/lib/compiler/typespec-generator";
import { compileEntity, type PrismaFieldInput } from "@/lib/compiler/compiler.service";
import type { ClosureEntity } from "@/lib/references/closure";
import { writeFieldReference, type EntityRef } from "@/lib/references/entity-reference";

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
  generateClosure: ReturnType<typeof vi.fn>;
} {
  return {
    loadModel: vi.fn().mockResolvedValue({ success: true, data: model() }),
    generate: vi.fn().mockReturnValue("model Order {\n  id?: string;\n}\n"),
    compile: vi.fn().mockResolvedValue({ success: true, diagnostics: [] }),
    generateClosure: vi.fn().mockReturnValue("namespace SuperSchemaClosure.d.p.Order { model Order {} }\n"),
    ...over,
  } as never;
}

const DB = {} as never;
const CLOSURE = { entities: [] } as never;

const field = (name: string, type: string, sortOrder: number, decorators: Record<string, unknown> = {}, extra: Partial<PrismaFieldInput> = {}): PrismaFieldInput => ({
  id: `f-${name}`, name, type, precision: null, scale: null, nullable: true, isKey: false,
  fieldNumber: null, description: "", classification: null, aliases: [], decorators, sortOrder, ...extra,
});

function member(id: string, name: string, fields: PrismaFieldInput[], source: ClosureEntity["source"] = "published", metadata: unknown = null): ClosureEntity {
  const ref: EntityRef = { entityId: id, domain: "Sales", product: "Orders", entity: name };
  return {
    entityId: id,
    ref,
    source,
    ...(source === "draft" ? {} : { version: "1.0" }),
    fields: [field("id", "string", 0, {}, { nullable: false, isKey: true }), ...fields],
    entity: { id, name, description: "", status: "DRAFT", version: 1, domainId: null, metadata, domain: null },
  };
}

describe("needsRegeneration", () => {
  it("is true when the stored source is missing or stale, false only for a fresh stored source", () => {
    expect(needsRegeneration(null, false)).toBe(true);
    expect(needsRegeneration("", false)).toBe(true);
    expect(needsRegeneration("model A {}", true)).toBe(true);
    expect(needsRegeneration("model A {}", false)).toBe(false);
  });
});

describe("compileClosure (the publish gate)", () => {
  it("compiles the combined source of the closure, once, and succeeds when it compiles", async () => {
    const d = deps();
    const res = await compileClosure(CLOSURE, d);
    expect(res).toEqual({ success: true, data: undefined });
    expect(d.generateClosure).toHaveBeenCalledWith(CLOSURE);
    expect(d.compile).toHaveBeenCalledTimes(1);
    expect(d.compile).toHaveBeenCalledWith("namespace SuperSchemaClosure.d.p.Order { model Order {} }\n");
  });

  it("blocks with the compiler diagnostics (errors only in the message) when the closure does not compile", async () => {
    const d = deps({
      compile: vi.fn().mockResolvedValue({
        success: false,
        diagnostics: [
          { severity: "error", code: "invalid-ref", message: "Unknown identifier Thing" },
          { severity: "warning", code: "w", message: "just a warning" },
        ],
      }),
    });
    const res = await compileClosure(CLOSURE, d);
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.code).toBe("PUBLISH_BLOCKED");
      expect(res.error.message).toContain("does not compile");
      expect(res.error.message).toContain("Unknown identifier Thing");
      expect(res.error.message).not.toContain("just a warning");
      expect((res.error.details as { diagnostics: unknown[] }).diagnostics).toHaveLength(2);
    }
  });
});

describe("compileRegeneratedSource (phase 1, outside the lock)", () => {
  it("regenerates the entity's own text from the field rows, gates the CLOSURE with the compiler, and returns the entity's own text", async () => {
    const d = deps();
    const res = await compileRegeneratedSource(DB, "e1", CLOSURE, d);
    expect(res).toEqual({ success: true, data: "model Order {\n  id?: string;\n}\n" });
    // The compiler saw the combined closure source, never the stand-alone text (which refers to other models by bare name).
    expect(d.compile).toHaveBeenCalledWith("namespace SuperSchemaClosure.d.p.Order { model Order {} }\n");
    expect(d.compile).not.toHaveBeenCalledWith("model Order {\n  id?: string;\n}\n");
  });

  it("blocks with the diagnostics and returns no text when the closure does not compile", async () => {
    const d = deps({
      compile: vi.fn().mockResolvedValue({ success: false, diagnostics: [{ severity: "error", code: "invalid-ref", message: "Unknown identifier Thing" }] }),
    });
    const res = await compileRegeneratedSource(DB, "e1", CLOSURE, d);
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.code).toBe("PUBLISH_BLOCKED");
      expect(res.error.message).toContain("Unknown identifier Thing");
    }
  });

  it("passes loader failures through without compiling", async () => {
    const d = deps({ loadModel: vi.fn().mockResolvedValue({ success: false, error: { code: "NOT_FOUND", message: "gone" } }) });
    const res = await compileRegeneratedSource(DB, "e1", CLOSURE, d);
    expect(res).toEqual({ success: false, error: { code: "NOT_FOUND", message: "gone" } });
    expect(d.compile).not.toHaveBeenCalled();
  });

  it("gates a tagged entity with classified fields and a reference through the REAL generators + compiler", async () => {
    const real = (id: string, name: string, fields: PrismaFieldInput[], source: ClosureEntity["source"], metadata: unknown) => member(id, name, fields, source, metadata);
    const customer = real("c", "Customer", [field("email", "string", 1, {}, { classification: "PII" })], "published", { tags: ["crm"] });
    const order = real(
      "o",
      "Order",
      [
        field("email", "string", 1, {}, { classification: "PII" }),
        field("code", "string", 2, {}, { classification: "TOP_SECRET" }),
        field("buyer", "reference", 3, writeFieldReference({}, { entityId: "c", domain: "Sales", product: "Orders", entity: "Customer" })),
      ],
      "draft",
      { tags: ["sales"] }
    );
    const entities = [order, customer];
    const stored = compileEntity(order.entity, order.fields);

    const res = await compileRegeneratedSource(DB, "o", { entities }, {
      loadModel: vi.fn().mockResolvedValue({ success: true, data: stored }),
      generate: generateTypeSpec,
      compile: compileTypeSpecWithGovernance,
    });
    expect(res).toEqual({ success: true, data: generateTypeSpec(stored) });
  }, 60_000);
});

describe("compileClosure with the real compiler", () => {
  const compileOf = (entities: ClosureEntity[]) => compileClosure({ entities });

  it("a reference to a published member compiles", async () => {
    const customer = member("c", "Customer", []);
    const order = member("o", "Order", [field("buyer", "reference", 1, writeFieldReference({}, customer.ref as never))], "draft");
    expect(await compileOf([order, customer])).toEqual({ success: true, data: undefined });
  }, 60_000);

  it("a source the compiler rejects blocks the publish with its diagnostic (the real compiler is what runs)", async () => {
    const res = await compileClosure({ entities: [] }, { generateClosure: () => "model A { b: Nope; }\n" });
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.code).toBe("PUBLISH_BLOCKED");
      expect(res.error.message).toMatch(/Nope/);
    }
  }, 60_000);

  it("a reference that matches no entity stays dangling and compiles (typed unknown; there are no stub models)", async () => {
    const order = member("o", "Order", [field("buyer", "reference", 1, { referencedEntityName: "Nobody" })], "draft");
    expect(await compileOf([order])).toEqual({ success: true, data: undefined });
  }, 60_000);

  it("a self-reference and a cycle compile", async () => {
    const a = member("a", "A", [field("b", "reference", 1, writeFieldReference({}, { entityId: "b", domain: "Sales", product: "Orders", entity: "B" }))], "draft");
    const b = member("b", "B", [field("a", "reference", 1, writeFieldReference({}, { entityId: "a", domain: "Sales", product: "Orders", entity: "A" })), field("me", "reference", 2, writeFieldReference({}, { entityId: "b", domain: "Sales", product: "Orders", entity: "B" }))]);
    expect(await compileOf([a, b])).toEqual({ success: true, data: undefined });
  }, 60_000);

  it("a reference to an entity called Enterprise (the governance library namespace) compiles", async () => {
    const enterprise = member("e", "Enterprise", []);
    const order = member(
      "o",
      "Order",
      [field("email", "string", 1, {}, { classification: "PII" }), field("owner", "reference", 2, writeFieldReference({}, enterprise.ref as never))],
      "draft"
    );
    expect(await compileOf([order, enterprise])).toEqual({ success: true, data: undefined });
  }, 60_000);
});

describe("stubs are gone", () => {
  it("resolve-source exports neither the stub generator nor its name collector", () => {
    expect(Object.keys(resolveSource)).not.toContain("stubUnresolvedReferences");
    expect(Object.keys(resolveSource)).not.toContain("referencedModelNames");
  });
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

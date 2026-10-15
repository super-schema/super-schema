/**
 * C-I1: JSON Schema `const` / non-string `enum` must never turn into an enum with no values (an unsatisfiable
 * `{ "enum": [] }`). Covered importer-side, through the generator, and through the real JSON Schema emitter.
 */
import { describe, it, expect, vi, beforeAll } from "vitest";
import { compileEntity } from "@/lib/compiler/compiler.service";
import type { PrismaEntityInput, PrismaFieldInput } from "@/lib/compiler/compiler.service";
import { generateTypeSpecWithDiagnostics } from "@/lib/compiler/typespec-generator";
import { parseJsonSchemaDocument } from "@/lib/importers/jsonschema.importer";
import { parsedFieldToCreateFieldInput } from "@/lib/importers/import-payload";
import type { ParsedEntity, ParsedField } from "@/lib/importers/types";

vi.mock("server-only", () => ({}));

let compileTypeSpecWithGovernance: typeof import("@/lib/compiler/typespec-compiler").compileTypeSpecWithGovernance;
let runTypeSpecEmitterFiles: typeof import("@/lib/typespec-official/emitter.service").runTypeSpecEmitterFiles;

beforeAll(async () => {
  ({ compileTypeSpecWithGovernance } = await import("@/lib/compiler/typespec-compiler"));
  ({ runTypeSpecEmitterFiles } = await import("@/lib/typespec-official/emitter.service"));
});

function importEntity(properties: Record<string, unknown>, extra: Record<string, unknown> = {}): ParsedEntity {
  const r = parseJsonSchemaDocument(
    JSON.stringify({ title: "T", type: "object", required: Object.keys(properties), properties, ...extra })
  );
  if (!r.success) throw new Error(r.error.message);
  return r.data.entities[0];
}

const byName = (entity: ParsedEntity, name: string): ParsedField => {
  const f = entity.fields.find((x) => x.name === name);
  if (!f) throw new Error(`no field ${name}`);
  return f;
};

/** The persisted path: ParsedField → CreateFieldInput (decorators carry the symbols) → field row → generator. */
function generateFor(entity: ParsedEntity) {
  const rows: PrismaFieldInput[] = entity.fields.map((f, i) => {
    const input = parsedFieldToCreateFieldInput(f);
    return {
      id: `f${i}`,
      name: input.name,
      type: input.type,
      precision: null,
      scale: null,
      nullable: input.nullable,
      isKey: input.isKey,
      fieldNumber: null,
      description: input.description ?? "",
      classification: null,
      aliases: input.aliases ?? [],
      decorators: (input.decorators ?? {}) as Record<string, unknown>,
      sortOrder: i,
    };
  });
  const e: PrismaEntityInput = {
    id: "e1",
    name: entity.name,
    description: "",
    status: "DRAFT",
    version: 1,
    domainId: "d1",
    metadata: {},
    domain: { id: "d1", name: "Sales", slug: "sales" },
  };
  return generateTypeSpecWithDiagnostics(compileEntity(e, rows), { governance: false });
}

describe("const (CloudEvents specversion)", () => {
  it("imports a string const as a single-member enum at high confidence", () => {
    const e = importEntity({ specversion: { const: "1.0" } });
    expect(byName(e, "specversion")).toMatchObject({
      type: "enum",
      enumValues: ["1.0"],
      confidence: "high",
      originalType: 'const("1.0")',
    });
  });

  it("a const with a $ref sibling-free object schema still resolves through $defs", () => {
    const e = importEntity({ v: { $ref: "#/$defs/Version" } }, { $defs: { Version: { const: "2" } } });
    expect(byName(e, "v")).toMatchObject({ type: "enum", enumValues: ["2"] });
  });

  it("generates a one-member enum, compiles, and publishes enum: ['1.0']", async () => {
    const { source, diagnostics } = generateFor(importEntity({ id: { type: "string" }, specversion: { const: "1.0" } }));
    expect(diagnostics).toEqual([]);
    expect(source).toContain("enum T_specversion {");
    expect(source).toContain('  "1.0",');
    const compiled = await compileTypeSpecWithGovernance(source);
    expect(compiled.success).toBe(true);

    const r = await runTypeSpecEmitterFiles("@typespec/json-schema", `import "@typespec/json-schema";\n\n${source}`, {
      emitAllModels: true,
      "file-type": "json",
    });
    if (!r.success) throw new Error(r.error.message);
    const docs = r.data.map((f) => JSON.parse(f.content));
    const enumDoc = docs.find((d) => d.$id === "T_specversion.json");
    expect(enumDoc.enum).toEqual(["1.0"]);
    // Satisfiable: no `type: []`, no empty enum anywhere in the output.
    for (const d of docs) {
      expect(d.enum ?? ["x"]).not.toEqual([]);
      expect(d.type).not.toEqual([]);
    }
  }, 120_000);
});

describe("enums whose symbols are not plain words", () => {
  it("survives the persisted path (pattern slot) with hyphens, spaces and digits", async () => {
    const symbols = ["in-progress", "en US", "1", "model"];
    const { source, diagnostics } = generateFor(importEntity({ status: { enum: symbols } }));
    expect(diagnostics).toEqual([]);
    const compiled = await compileTypeSpecWithGovernance(source);
    if (!compiled.success) throw new Error(compiled.diagnostics.map((d) => d.message).join("\n"));
    expect(compiled.document.enums[0].values).toEqual(symbols);
  }, 60_000);

  it("flags a symbol that cannot round-trip through the A|B|C carrier (low confidence)", () => {
    const e = importEntity({ s: { enum: ["a|b", "c"] }, t: { enum: ["", "x"] } });
    expect(byName(e, "s").confidence).toBe("low");
    expect(byName(e, "t").confidence).toBe("low");
  });

  it("de-duplicates repeated symbols", () => {
    const e = importEntity({ s: { enum: ["a", "b", "a"] } });
    expect(byName(e, "s").enumValues).toEqual(["a", "b"]);
  });
});

describe("numeric / boolean / mixed enums never become an empty enum", () => {
  it("numeric enum [1,2,3] → integer, low confidence, range kept", () => {
    const e = importEntity({ n: { enum: [1, 2, 3] } });
    const f = byName(e, "n");
    expect(f).toMatchObject({ type: "integer", confidence: "low", originalType: "enum(1,2,3)" });
    expect(f.enumValues).toBeUndefined();
    expect(f.constraints).toEqual(
      expect.arrayContaining([
        { type: "minValue", value: 1 },
        { type: "maxValue", value: 3 },
      ])
    );
  });

  it("fractional numbers → float64; a numeric const pins min = max", () => {
    expect(byName(importEntity({ n: { enum: [0.5, 1] } }), "n").type).toBe("float64");
    const c = byName(importEntity({ n: { const: 7 } }), "n");
    expect(c).toMatchObject({ type: "integer", confidence: "low" });
    expect(c.constraints).toEqual(
      expect.arrayContaining([
        { type: "minValue", value: 7 },
        { type: "maxValue", value: 7 },
      ])
    );
  });

  it("an explicit minimum/maximum on the property wins over the implied range", () => {
    const f = byName(importEntity({ n: { enum: [1, 2, 3], minimum: 0 } }), "n");
    expect(f.constraints?.filter((c) => c.type === "minValue")).toEqual([{ type: "minValue", value: 0 }]);
  });

  it("boolean const / enum → boolean (exact only when both values are listed)", () => {
    expect(byName(importEntity({ b: { const: true } }), "b")).toMatchObject({ type: "boolean", confidence: "low" });
    expect(byName(importEntity({ b: { enum: [true, false] } }), "b")).toMatchObject({ type: "boolean", confidence: "high" });
  });

  it("mixed enum ['a', 1, null] → nullable string at low confidence, flagged in the review warnings", () => {
    const f = byName(importEntity({ m: { enum: ["a", 1, null] } }), "m");
    expect(f).toMatchObject({ type: "string", confidence: "low", nullable: true, originalType: 'enum("a",1,null)' });
    expect(f.enumValues).toBeUndefined();
  });

  it("an empty enum / a null-only const → low-confidence string, never an enum", () => {
    expect(byName(importEntity({ e: { enum: [] } }), "e")).toMatchObject({ type: "string", confidence: "low" });
    expect(byName(importEntity({ e: { const: null } }), "e")).toMatchObject({ type: "string", confidence: "low", nullable: true });
  });

  it("numeric $defs enums are inlined (not stringified into a shared enum)", () => {
    const r = parseJsonSchemaDocument(
      JSON.stringify({
        title: "T",
        type: "object",
        properties: { code: { $ref: "#/$defs/Code" } },
        $defs: { Code: { enum: [200, 404] } },
      })
    );
    if (!r.success) throw new Error(r.error.message);
    expect(r.data.enums).toEqual([]);
    expect(byName(r.data.entities[0], "code")).toMatchObject({ type: "integer", confidence: "low" });
  });

  it("the generated TypeSpec for numeric / boolean / mixed fields has no enum and compiles", async () => {
    const entity = importEntity({
      n: { enum: [1, 2, 3] },
      b: { const: true },
      m: { enum: ["a", 1, null] },
      c: { const: 7 },
    });
    const { source, diagnostics } = generateFor(entity);
    expect(diagnostics).toEqual([]);
    expect(source).not.toMatch(/enum\s+\w+/);
    const compiled = await compileTypeSpecWithGovernance(source);
    if (!compiled.success) throw new Error(compiled.diagnostics.map((d) => d.message).join("\n"));

    const r = await runTypeSpecEmitterFiles("@typespec/json-schema", `import "@typespec/json-schema";\n\n${source}`, {
      emitAllModels: true,
      "file-type": "json",
    });
    if (!r.success) throw new Error(r.error.message);
    const t = JSON.parse(r.data[0].content);
    expect(t.properties.n).toMatchObject({ type: "integer", minimum: 1, maximum: 3 });
    expect(t.properties.c).toMatchObject({ type: "integer", minimum: 7, maximum: 7 });
    expect(t.properties.b).toMatchObject({ type: "boolean" });
  }, 120_000);
});

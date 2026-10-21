/**
 * Vendor-extension import: the regex parser and the compiler (AST) path read back the generic
 * `@TypeSpec.JsonSchema.extension` / `@TypeSpec.OpenAPI.extension` pair (and the legacy bare
 * `@extension`) as ONE entry per key, with object / array / scalar values intact.
 */
import { describe, it, expect, vi, beforeAll } from "vitest";
import { compileEntity, type PrismaFieldInput } from "@/lib/compiler/compiler.service";
import { generateTypeSpec } from "@/lib/compiler/typespec-generator";
import { parseTypeSpecDocument } from "@/lib/compiler/typespec-parser";
import { typeSpecValueLiteral, parseTypeSpecValueLiteral } from "@/lib/compiler/governance-decorators";

vi.mock("server-only", () => ({}));

let compiler: typeof import("@/lib/compiler/typespec-compiler");
beforeAll(async () => {
  compiler = await import("@/lib/compiler/typespec-compiler");
});

const wrap = (decorators: string) => `model M {\n  ${decorators}\n  f?: string;\n}\n`;
const fieldExt = (src: string) => parseTypeSpecDocument(src).models[0].fields[0].decorators.extensions;

describe("parseTypeSpecValueLiteral", () => {
  it("is the inverse of typeSpecValueLiteral", () => {
    const values: unknown[] = [
      "a\tb \\ \"q\" ${x} $5\nz\r",
      3, -1.5, true, false, null,
      [], {}, ["a", 1, [false, null]],
      { extent: "EXTERNAL", "has-dash": { n: 1, list: [{ a: "x, y (z)" }] }, "": 1 },
    ];
    for (const v of values) expect(parseTypeSpecValueLiteral(typeSpecValueLiteral(v))).toEqual(v);
  });
});

describe("regex parser: field-level @extension spellings", () => {
  const obj = '"x-visibility", #{extent: "EXTERNAL"}';
  const expected = { "x-visibility": { extent: "EXTERNAL" } };

  it.each([
    ["JsonSchema alone", `@TypeSpec.JsonSchema.extension(${obj})`],
    ["OpenAPI alone", `@TypeSpec.OpenAPI.extension(${obj})`],
    ["both together", `@TypeSpec.JsonSchema.extension(${obj})\n  @TypeSpec.OpenAPI.extension(${obj})`],
  ])("%s yields one object-valued entry", (_n, deco) => {
    expect(fieldExt(wrap(deco))).toEqual(expected);
  });

  it("keeps the legacy bare string form", () => {
    expect(fieldExt(wrap('@extension("k", "v")'))).toEqual({ k: "v" });
  });

  it("splits on the first top-level comma when the value holds commas, parens and quotes", () => {
    const v = { a: "x, \"y\" (z)", b: [1, 2], c: { d: null } };
    expect(fieldExt(wrap(`@TypeSpec.OpenAPI.extension("x-k", ${typeSpecValueLiteral(v)})`))).toEqual({ "x-k": v });
  });

  it("parses the decorator when it shares a line with the property", () => {
    const src = `model M {\n  @TypeSpec.OpenAPI.extension("x-k", #{a: 1, b: "p q"}) f?: string;\n}\n`;
    const f = parseTypeSpecDocument(src).models[0].fields[0];
    expect(f.name).toBe("f");
    expect(f.decorators.extensions).toEqual({ "x-k": { a: 1, b: "p q" } });
  });

  it("does not put x-tags / x-classification in the generic bag", () => {
    const src = wrap(
      '@TypeSpec.OpenAPI.extension("x-classification", "PII")\n  @TypeSpec.OpenAPI.extension("x-tags", #["a"])\n  @TypeSpec.OpenAPI.extension("x-o", 1)'
    );
    const f = parseTypeSpecDocument(src).models[0].fields[0];
    expect(f.decorators.extensions).toEqual({ "x-o": 1 });
    expect(f.decorators.classification).toBe("PII");
  });
});

describe("regex parser: model-level extensions", () => {
  it("collects them above the model, deduped, excluding x-tags", () => {
    const src =
      '@TypeSpec.OpenAPI.extension("x-tags", #["t"])\n' +
      '@TypeSpec.JsonSchema.extension("x-owner", #{team: "a"})\n' +
      '@TypeSpec.OpenAPI.extension("x-owner", #{team: "a"})\n' +
      '@TypeSpec.OpenAPI.extension("x-n", 2)\nmodel M {\n  f?: string;\n}\n';
    const m = parseTypeSpecDocument(src).models[0];
    expect(m.extensions).toEqual({ "x-owner": { team: "a" }, "x-n": 2 });
    expect(m.tags).toEqual(["t"]);
  });

  it("is undefined when there are none", () => {
    expect(parseTypeSpecDocument("model M {\n  f?: string;\n}\n").models[0].extensions).toBeUndefined();
  });
});

const fld = (name: string, i: number, extra: Partial<PrismaFieldInput> = {}): PrismaFieldInput => ({
  id: `f-${name}`, name, type: "string", precision: null, scale: null, nullable: true, isKey: false,
  fieldNumber: null, description: "", classification: null, aliases: [], decorators: {}, sortOrder: i, ...extra,
});

const NASTY = 'a\tb \\ "q" ${x}';
const FIELD_EXT: Record<string, unknown> = {
  "x-obj": { extent: "EXTERNAL", nested: { list: [1, "two", null, { k: false }] }, "odd key": NASTY },
  "x-arr": ["a", 2, [true]],
  "x-str": NASTY,
  "x-num": 4.5,
  "x-bool": false,
  "x-null": null,
};
const MODEL_EXT: Record<string, unknown> = { "x-owner": { team: "a, b", tags: ["p"] }, "x-count": 3, "x-s": NASTY };

function generated() {
  const model = compileEntity(
    {
      id: "e1", name: "Thing", description: "", status: "DRAFT", version: 1, domainId: null,
      metadata: { tags: ["t1"], custom: { extensions: MODEL_EXT } },
      domain: null,
    },
    [fld("id", 0, { isKey: true, nullable: false }), fld("name", 1, { classification: "PII" })]
  );
  const f = model.fields.find((x) => x.name === "name")!;
  f.decorators.typespec = { ...(f.decorators.typespec ?? {}), extensions: { openapi: FIELD_EXT } };
  return generateTypeSpec(model);
}

describe("round trip: generator -> regex parser", () => {
  it("returns field and model extensions deep-equal to the originals", () => {
    const m = parseTypeSpecDocument(generated()).models[0];
    const f = m.fields.find((x) => x.name === "name")!;
    expect(f.decorators.extensions).toEqual(FIELD_EXT);
    expect(m.extensions).toEqual(MODEL_EXT);
    expect(m.tags).toEqual(["t1"]);
  });
});

describe("compile (AST) path", () => {
  it("keeps object / array / scalar values and collapses the pair", async () => {
    const doc = await compiler.compileTypeSpecDocument(generated());
    const m = doc.models.find((x) => x.name === "Thing")!;
    const f = m.fields.find((x) => x.name === "name")!;
    expect(f.decorators.extensions).toEqual(FIELD_EXT);
    expect(m.extensions).toEqual(MODEL_EXT);
    expect(m.tags).toEqual(["t1"]);
    expect(f.decorators.classification).toBe("PII");
  });

  it("keeps the legacy bare string extension", async () => {
    const doc = await compiler.compileTypeSpecDocument('model M {\n  @extension("k", "v")\n  f?: string;\n}\n');
    expect(doc.models[0].fields[0].decorators.extensions).toEqual({ k: "v" });
  });
});

describe("hostile input", () => {
  it("does not overflow the stack on 10000 nested openers; yields no extension", () => {
    const src = wrap(`@TypeSpec.JsonSchema.extension("k", ${"#[".repeat(10000)}`);
    expect(() => parseTypeSpecDocument(src)).not.toThrow();
    expect(fieldExt(src)).toBeUndefined();
    const full = wrap(`@TypeSpec.JsonSchema.extension("k", ${"#[".repeat(10000)}${"]".repeat(10000)})`);
    expect(() => parseTypeSpecDocument(full)).not.toThrow();
    expect(fieldExt(full)).toBeUndefined();
  });

  it("still parses nesting just under the limit", () => {
    const n = 60;
    const lit = "#[".repeat(n) + "1" + "]".repeat(n);
    let expected: unknown = 1;
    for (let i = 0; i < n; i++) expected = [expected];
    expect(fieldExt(wrap(`@TypeSpec.OpenAPI.extension("k", ${lit})`))).toEqual({ k: expected });
  });

  const nest = (n: number) => "#[".repeat(n) + "1" + "]".repeat(n);
  const nested = (n: number) => {
    let v: unknown = 1;
    for (let i = 0; i < n; i++) v = [v];
    return v;
  };

  it("regex path boundary: 63 nested arrays parse, 64 are dropped", () => {
    expect(fieldExt(wrap(`@TypeSpec.OpenAPI.extension("k", ${nest(63)})`))).toEqual({ k: nested(63) });
    expect(fieldExt(wrap(`@TypeSpec.OpenAPI.extension("k", ${nest(64)})`))).toBeUndefined();
  });

  it("compile path boundary: 63 nested survives intact, 70 drops only that key and does not throw", async () => {
    const src = (n: number) =>
      `model M {\n  @extension("deep", ${nest(n)})\n  @extension("ok", #{a: 1})\n  f?: string;\n}\n`;
    const under = await compiler.compileTypeSpecDocument(src(63));
    expect(under.models[0].fields[0].decorators.extensions).toEqual({ deep: nested(63), ok: { a: 1 } });
    const over = await compiler.compileTypeSpecDocument(src(70));
    expect(over.models[0].fields[0].decorators.extensions).toEqual({ ok: { a: 1 } });
    const exact = await compiler.compileTypeSpecDocument(src(64));
    expect(exact.models[0].fields[0].decorators.extensions).toEqual({ ok: { a: 1 } });
  });

  it("generator omits an over-deep extension key (no throw, no truncation) and keeps the others", () => {
    const deep = nested(100);
    const model = compileEntity(
      {
        id: "e1", name: "Thing", description: "", status: "DRAFT", version: 1, domainId: null,
        metadata: { custom: { extensions: { "x-deep": deep, "x-keep": 1 } } },
        domain: null,
      },
      [fld("id", 0, { isKey: true, nullable: false }), fld("name", 1)]
    );
    const f = model.fields.find((x) => x.name === "name")!;
    f.decorators.typespec = { ...(f.decorators.typespec ?? {}), extensions: { openapi: { "x-deep": deep, "x-f": "ok" } } };
    let src = "";
    expect(() => (src = generateTypeSpec(model))).not.toThrow();
    expect(src).not.toContain("x-deep");
    expect(src).toContain('extension("x-keep", 1)');
    expect(src).toContain('extension("x-f", "ok")');
  });

  const hostile = "#{__proto__: #{isAdmin: true}, constructor: 1}";
  const checkOwn = (r: unknown) => {
    const o = r as Record<string, unknown>;
    expect(Object.keys(o)).toEqual(["__proto__", "constructor"]);
    expect(Object.getPrototypeOf(o)).toBe(Object.prototype);
    expect(o.isAdmin).toBeUndefined();
    expect(Object.getOwnPropertyDescriptor(o, "__proto__")!.value).toEqual({ isAdmin: true });
  };

  it("literal parser keeps __proto__ / constructor as own keys", () => {
    checkOwn(parseTypeSpecValueLiteral(hostile));
  });

  it("regex path (field and model) keeps them as own keys", () => {
    const f = fieldExt(wrap(`@TypeSpec.OpenAPI.extension("x", ${hostile})`))!;
    checkOwn(f.x);
    const m = parseTypeSpecDocument(
      `@TypeSpec.OpenAPI.extension("__proto__", ${hostile})\nmodel M {\n  f?: string;\n}\n`
    ).models[0];
    expect(Object.keys(m.extensions!)).toEqual(["__proto__"]);
    expect(Object.getPrototypeOf(m.extensions)).toBe(Object.prototype);
  });

  it("compile path keeps them as own keys", async () => {
    const doc = await compiler.compileTypeSpecDocument(`model M {\n  @extension("x", ${hostile})\n  f?: string;\n}\n`);
    checkOwn(doc.models[0].fields[0].decorators.extensions!.x);
  });
});

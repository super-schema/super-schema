/**
 * Extension object keys spelled like TypeSpec keywords (`enum`, `const`, `if`, ...) or holding backticks / newlines must
 * be written so the REAL compiler accepts the document, and must round-trip through the parsers.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { describe, it, expect, vi, beforeAll } from "vitest";
import { compileEntity, type PrismaFieldInput } from "@/lib/compiler/compiler.service";
import { generateTypeSpec } from "@/lib/compiler/typespec-generator";
import { parseTypeSpecDocument } from "@/lib/compiler/typespec-parser";
import {
  TYPESPEC_RESERVED_WORDS,
  typeSpecValueLiteral,
  parseTypeSpecValueLiteral,
} from "@/lib/compiler/governance-decorators";
import { parseJsonSchemaDocument } from "@/lib/importers/jsonschema.importer";
import { parsedFieldToCreateFieldInput } from "@/lib/importers/import-payload";

vi.mock("server-only", () => ({}));

let compiler: typeof import("@/lib/compiler/typespec-compiler");
beforeAll(async () => {
  compiler = await import("@/lib/compiler/typespec-compiler");
});

const fld = (name: string, i: number, extra: Partial<PrismaFieldInput> = {}): PrismaFieldInput => ({
  id: `f-${name}`, name, type: "string", precision: null, scale: null, nullable: true, isKey: false,
  fieldNumber: null, description: "", classification: null, aliases: [], decorators: {}, sortOrder: i, ...extra,
});

function build(opts: { fieldExt?: Record<string, unknown>; modelExt?: Record<string, unknown> }) {
  const model = compileEntity(
    {
      id: "e1", name: "Thing", description: "", status: "DRAFT", version: 1, domainId: null,
      metadata: opts.modelExt ? { custom: { extensions: opts.modelExt } } : {},
      domain: null,
    },
    [fld("id", 0, { isKey: true, nullable: false }), fld("name", 1)]
  );
  if (opts.fieldExt) {
    const f = model.fields.find((x) => x.name === "name")!;
    f.decorators.typespec = { ...(f.decorators.typespec ?? {}), extensions: { openapi: opts.fieldExt } };
  }
  return model;
}

async function errorsOf(src: string) {
  const result = await compiler.compileTypeSpecWithGovernance(src);
  return result.diagnostics.filter((d) => d.severity === "error").map((d) => `${d.code}: ${d.message}`);
}

const parsedField = (src: string) => parseTypeSpecDocument(src).models[0].fields.find((f) => f.name === "name")!;
const parsedModel = (src: string) => parseTypeSpecDocument(src).models[0];

describe("reserved-word list contract", () => {
  it("covers every Keywords / ReservedKeywords entry of the installed TypeSpec scanner", () => {
    const req = createRequire(import.meta.url);
    const indexPath = req.resolve("@typespec/compiler");
    const scanner = readFileSync(path.join(path.dirname(indexPath), "core", "scanner.js"), "utf8");
    const words = new Set<string>();
    for (const block of ["export const Keywords = new Map([", "export const ReservedKeywords = new Map(["]) {
      const start = scanner.indexOf(block);
      expect(start).toBeGreaterThan(-1);
      const end = scanner.indexOf("]);", start);
      for (const m of scanner.slice(start, end).matchAll(/\["([a-z]+)",/g)) words.add(m[1]);
    }
    expect(words.size).toBeGreaterThan(60);
    const missing = [...words].filter((w) => !TYPESPEC_RESERVED_WORDS.has(w));
    expect(missing).toEqual([]);
  });
});

describe("keyword-spelled keys", () => {
  it("quotes keywords, leaves ordinary keys bare", () => {
    expect(typeSpecValueLiteral({ enum: 1, extent: 2, const: 3 })).toBe("#{`enum`: 1, extent: 2, `const`: 3}");
  });

  it("the reviewer's input compiles with zero errors", async () => {
    const parsed = parseJsonSchemaDocument(
      '{"title":"T","type":"object","properties":{"a":{"type":"string","not":{"enum":["x"]},"if":{"const":"a"},"then":{"minLength":1}}}}'
    );
    if (!parsed.success) throw new Error("import failed");
    const a = parsed.data.entities[0].fields[0];
    const input = parsedFieldToCreateFieldInput(a);
    const ext = (input.decorators as { typespec: { extensions: { openapi: Record<string, unknown> } } }).typespec.extensions.openapi;
    const src = generateTypeSpec(build({ fieldExt: ext }));
    expect(src).toContain("`enum`");
    expect(await errorsOf(src)).toEqual([]);
  }, 60_000);

  it("EVERY reserved word as an extension key compiles and round-trips (field and model)", async () => {
    const all: Record<string, unknown> = {};
    for (const w of TYPESPEC_RESERVED_WORDS) all[w] = 1;
    const src = generateTypeSpec(build({ fieldExt: all, modelExt: all }));
    expect(await errorsOf(src)).toEqual([]);
    expect(parsedField(src).decorators.extensions).toEqual({ ...all });
    for (const w of TYPESPEC_RESERVED_WORDS) {
      expect(parseTypeSpecValueLiteral(typeSpecValueLiteral({ [w]: 1 })), w).toEqual({ [w]: 1 });
    }
  }, 120_000);

  const REALISTIC: Array<[string, Record<string, unknown>]> = [
    ["if/properties/const", { if: { properties: { country: { const: "US" } } }, then: { required: ["zip"] } }],
    ["not/enum", { not: { enum: ["a", "b"] } }],
    ["contains/const", { contains: { const: "x" } }],
  ];
  it.each(REALISTIC)("%s compiles and round-trips at field and model level", async (_n, ext) => {
    const src = generateTypeSpec(build({ fieldExt: ext, modelExt: ext }));
    expect(await errorsOf(src)).toEqual([]);
    expect(parsedField(src).decorators.extensions).toEqual(ext);
    expect(parsedModel(src).extensions).toEqual(ext);
  }, 60_000);
});

describe("keys with a backtick or a newline", () => {
  const keys = ["a`b", "line1\nline2", "back\\slash`", "cr\rtab\t", "`"];
  it("round-trips through the literal reader", () => {
    for (const k of keys) expect(parseTypeSpecValueLiteral(typeSpecValueLiteral({ [k]: 1 })), JSON.stringify(k)).toEqual({ [k]: 1 });
  });

  it("compiles with the real compiler and round-trips through the document parser", async () => {
    const ext = Object.fromEntries(keys.map((k, i) => [k, i]));
    const src = generateTypeSpec(build({ fieldExt: ext, modelExt: ext }));
    expect(await errorsOf(src)).toEqual([]);
    expect(parsedField(src).decorators.extensions).toEqual(ext);
  }, 60_000);

  it("omits (never emits invalid TypeSpec for) a key with another control character", async () => {
    const ext = { "bad\u0007key": 1, ok: 2 };
    expect(typeSpecValueLiteral(ext)).toBe("#{ok: 2}");
    expect(await errorsOf(generateTypeSpec(build({ fieldExt: ext })))).toEqual([]);
  }, 60_000);
});

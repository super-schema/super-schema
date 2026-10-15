/**
 * C-I2 / C-I1 (generator side): the generated contract keeps the WIRE names, never emits an empty enum, and every
 * case compiles in the REAL TypeSpec compiler (and, for the wire output, through the real JSON Schema emitter).
 */
import { describe, it, expect, vi, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { compileEntity } from "@/lib/compiler/compiler.service";
import type { PrismaEntityInput, PrismaFieldInput } from "@/lib/compiler/compiler.service";
import {
  TYPESPEC_KEYWORDS,
  enumMemberName,
  escapeString,
  generateTypeSpec,
  generateTypeSpecWithDiagnostics,
  isPlainIdentifier,
  propertyName,
  sanitizeIdentifier,
} from "@/lib/compiler/typespec-generator";
import { parseTypeSpecDocument } from "@/lib/compiler/typespec-parser";
import { projectTypeSpecSourceForProtobuf } from "@/lib/typespec-official/protobuf-source";

// server-only throws outside an RSC bundle; neutralize it for the Node test.
vi.mock("server-only", () => ({}));

let compileTypeSpecWithGovernance: typeof import("@/lib/compiler/typespec-compiler").compileTypeSpecWithGovernance;
let runTypeSpecEmitterFiles: typeof import("@/lib/typespec-official/emitter.service").runTypeSpecEmitterFiles;
let emitOfficialTypeSpecTargetFromData: typeof import("@/lib/typespec-official/emitter.service").emitOfficialTypeSpecTargetFromData;

beforeAll(async () => {
  ({ compileTypeSpecWithGovernance } = await import("@/lib/compiler/typespec-compiler"));
  ({ runTypeSpecEmitterFiles, emitOfficialTypeSpecTargetFromData } = await import("@/lib/typespec-official/emitter.service"));
});

const entity = (overrides: Partial<PrismaEntityInput> = {}): PrismaEntityInput => ({
  id: "e1",
  name: "Ticket",
  description: "",
  status: "DRAFT",
  version: 1,
  domainId: "d1",
  metadata: {},
  domain: { id: "d1", name: "Sales", slug: "sales" },
  ...overrides,
});

let seq = 0;
const field = (overrides: Partial<PrismaFieldInput>): PrismaFieldInput => ({
  id: `f${seq++}`,
  name: "x",
  type: "string",
  precision: null,
  scale: null,
  nullable: false,
  isKey: false,
  fieldNumber: null,
  description: "",
  classification: null,
  aliases: [],
  decorators: {},
  sortOrder: seq,
  ...overrides,
});

const generate = (fields: PrismaFieldInput[], e: Partial<PrismaEntityInput> = {}) =>
  generateTypeSpecWithDiagnostics(compileEntity(entity(e), fields), { governance: false });

/** Compile with the real compiler; fail the test with the diagnostics when it does not compile cleanly. */
async function compileClean(source: string) {
  const r = await compileTypeSpecWithGovernance(source);
  if (!r.success) throw new Error(`does not compile:\n${r.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n")}\n---\n${source}`);
  return r.document;
}

const WIRE_NAMES = [
  "plain",
  "in-progress",
  "en US",
  "1st",
  "2",
  "model",
  "op",
  "namespace",
  "is",
  "union",
  "enum",
  "import",
  "extends",
  "interface",
  "alias",
  "using",
  "const",
  "true",
  "false",
  "null",
  "void",
  "never",
  "unknown",
  "日本語",
  "Ünï",
  "a.b",
  "a/b",
  "$ref",
  "@type",
  "__proto__",
  "constructor",
  "a`b",
  'a"b',
  "a\\b",
  "a\nb",
  "${x}",
];

describe("identifier helpers", () => {
  it("keeps plain names bare and backticks everything else", () => {
    expect(propertyName("orderId")).toBe("orderId");
    expect(propertyName("_x1")).toBe("_x1");
    expect(propertyName("in-progress")).toBe("`in-progress`");
    expect(propertyName("op")).toBe("`op`");
    expect(propertyName("2nd")).toBe("`2nd`");
    expect(propertyName("日本語")).toBe("`日本語`");
    expect(propertyName("a`b")).toBe("`a\\`b`");
    expect(propertyName("a\\b")).toBe("`a\\\\b`");
  });

  it("quotes enum members that are not identifiers", () => {
    expect(enumMemberName("ACTIVE")).toBe("ACTIVE");
    expect(enumMemberName("in-progress")).toBe('"in-progress"');
    expect(enumMemberName("model")).toBe('"model"');
    expect(enumMemberName('a"b')).toBe('"a\\"b"');
    expect(enumMemberName("a${b}")).toBe('"a\\${b}"');
  });

  it("escapes `${` (a TypeSpec string template) but leaves a lone $ alone", () => {
    expect(escapeString("Price in ${currency}")).toBe("Price in \\${currency}");
    expect(escapeString("cost $5 and $")).toBe("cost $5 and $");
  });

  it("sanitizeIdentifier (type names) also avoids every keyword, not just the statement keywords", () => {
    for (const word of ["model", "true", "void", "unknown", "never", "record", "module", "env"]) {
      expect(sanitizeIdentifier(word)).toBe(`_${word}`);
    }
    expect(sanitizeIdentifier("Order")).toBe("Order");
  });

  it("TYPESPEC_KEYWORDS covers every keyword of the installed TypeSpec compiler's scanner", () => {
    // `Keywords` (statement + literal + reserved-for-future words) in the scanner source: ["import", Token.ImportKeyword], …
    const scanner = readFileSync(join(process.cwd(), "node_modules/@typespec/compiler/dist/src/core/scanner.js"), "utf8");
    const table = /export const Keywords = new Map\(\[([\s\S]*?)\]\);/.exec(scanner)?.[1] ?? "";
    const fromCompiler = [...table.matchAll(/\["([a-z]+)", Token\.\w+\]/g)].map((m) => m[1]);
    expect(fromCompiler.length).toBeGreaterThan(60);
    const missing = fromCompiler.filter((word) => !TYPESPEC_KEYWORDS.has(word));
    expect(missing).toEqual([]);
    for (const word of fromCompiler) expect(isPlainIdentifier(word)).toBe(false);
  });
});

describe("property names keep the wire name (real TypeSpec compiler)", () => {
  it("emits every non-identifier name verbatim and compiles", async () => {
    const { source, diagnostics } = generate(WIRE_NAMES.map((name) => field({ name })));
    expect(diagnostics).toEqual([]);
    expect(source).toContain("  `in-progress`: string;");
    expect(source).toContain("  `op`: string;");
    expect(source).toContain("  `日本語`: string;");
    expect(source).toContain("  plain: string;");
    expect(source).not.toContain("_in_progress");
    expect(source).not.toContain("_op");
    const doc = await compileClean(source);
    expect(doc.models[0].fields.map((f) => f.name)).toEqual(WIRE_NAMES);
  }, 60_000);

  it("distinct originals never collide (a-b vs a_b, two non-ASCII names)", async () => {
    const names = ["a-b", "a_b", "日本語", "中文", "Ünï", "Üni"];
    const { source } = generate(names.map((name) => field({ name })));
    const doc = await compileClean(source);
    expect(doc.models[0].fields.map((f) => f.name)).toEqual(names);
  }, 60_000);

  it("round-trips through the regex parser (source projection, importer)", () => {
    const { source } = generate(WIRE_NAMES.map((name) => field({ name })));
    const parsed = parseTypeSpecDocument(source);
    expect(parsed.models[0].fields.map((f) => f.name)).toEqual(WIRE_NAMES);
  });
});

describe("enum members keep the wire symbols (real TypeSpec compiler)", () => {
  const SYMBOLS = ["in-progress", "en US", "1", "model", "done", "日本語", 'say "hi"', "${x}", "a:b", "ACTIVE"];

  it("quotes non-identifier symbols, keeps identifiers bare, and compiles", async () => {
    const { source, diagnostics } = generate([field({ name: "status", type: "enum", aliases: SYMBOLS })]);
    expect(diagnostics).toEqual([]);
    expect(source).toContain('  "in-progress",');
    expect(source).toContain('  "model",');
    expect(source).toContain("  done,");
    expect(source).toContain("  ACTIVE,");
    expect(source).not.toContain("in_progress");
    const doc = await compileClean(source);
    expect(doc.enums[0].values).toEqual(SYMBOLS);
  }, 60_000);

  it("reads symbols with any character from the pattern slot the importers use", async () => {
    const { source } = generate([
      field({ name: "status", type: "enum", decorators: { typespec: { validation: { pattern: "in-progress|en US|done" } } } }),
    ]);
    const doc = await compileClean(source);
    expect(doc.enums[0].values).toEqual(["in-progress", "en US", "done"]);
  }, 60_000);

  it("does not read a real regex pattern as a symbol list", () => {
    const { source, diagnostics } = generate([
      field({ name: "status", type: "enum", decorators: { typespec: { validation: { pattern: "^[A-Z]+$" } } } }),
    ]);
    expect(diagnostics.map((d) => d.code)).toEqual(["ENUM_NO_VALUES"]);
    expect(source).not.toContain('"^[A-Z]+$"');
  });

  it("drops a repeated symbol (a duplicate member is a compile error) and reports it", async () => {
    const { source, diagnostics } = generate([field({ name: "status", type: "enum", aliases: ["a", "b", "a"] })]);
    expect(diagnostics).toMatchObject([{ severity: "warning", code: "ENUM_DUPLICATE_VALUE", fieldName: "status" }]);
    const doc = await compileClean(source);
    expect(doc.enums[0].values).toEqual(["a", "b"]);
  }, 60_000);

  it("two enum fields whose names sanitize identically get distinct enum types", async () => {
    const { source } = generate([
      field({ name: "a-b", type: "enum", aliases: ["x"] }),
      field({ name: "a_b", type: "enum", aliases: ["y"] }),
    ]);
    expect(source).toContain("enum Ticket_a_b {");
    expect(source).toContain("enum Ticket_a_b_2 {");
    const doc = await compileClean(source);
    expect(doc.models[0].fields.map((f) => f.name)).toEqual(["a-b", "a_b"]);
    expect(doc.models[0].fields.map((f) => f.type)).toEqual(["Ticket_a_b", "Ticket_a_b_2"]);
  }, 60_000);
});

describe("an enum without values is never emitted (C-I1)", () => {
  it("fails loudly: an error diagnostic, no empty enum declaration, and a compile error naming the field", async () => {
    const { source, diagnostics } = generate([field({ name: "status", type: "enum" })]);
    expect(diagnostics).toMatchObject([{ severity: "error", code: "ENUM_NO_VALUES", fieldName: "status" }]);
    expect(source).not.toMatch(/enum\s+Ticket_status/);
    expect(source).not.toContain("TODO: Define enum values");
    expect(source).toContain('// ERROR: enum field "status" has no values');
    // The real compiler rejects it, and the message says why.
    const r = await compileTypeSpecWithGovernance(source);
    expect(r.success).toBe(false);
    expect(r.diagnostics.map((d) => d.message).join("\n")).toContain('enum field "status" has no values');
  }, 60_000);

  it("generateTypeSpec (the string API) behaves the same", () => {
    const source = generateTypeSpec(compileEntity(entity(), [field({ name: "status", type: "enum" })]), { governance: false });
    expect(source).not.toMatch(/enum\s+\w+\s*\{\s*\}/);
    expect(source).toContain("has no values");
  });

  it("a shared enum without values is omitted (with a warning), never declared empty", () => {
    const model = compileEntity(entity(), [field({ name: "id" })]);
    const { source, diagnostics } = generateTypeSpecWithDiagnostics(
      { ...model, sharedEnums: [{ name: "Empty", values: [] }] },
      { governance: false }
    );
    expect(source).not.toMatch(/enum\s+Empty/);
    expect(diagnostics).toMatchObject([{ severity: "warning", code: "ENUM_NO_VALUES" }]);
  });

  it("a shared enum with values is still declared, with quoted members", async () => {
    const model = compileEntity(entity(), [field({ name: "id" })]);
    const { source } = generateTypeSpecWithDiagnostics(
      { ...model, sharedEnums: [{ name: "Kind", values: ["a-b", "c"] }] },
      { governance: false }
    );
    const doc = await compileClean(source);
    expect(doc.enums[0]).toMatchObject({ name: "Kind", values: ["a-b", "c"] });
  }, 60_000);
});

describe("string escaping (real TypeSpec compiler)", () => {
  it("a description with ${...} compiles and round-trips", async () => {
    const { source } = generate(
      [field({ name: "price", description: "Price in ${currency}" })],
      { description: "Topic ${\"x\"}.orders" }
    );
    expect(source).toContain('@doc("Price in \\${currency}")');
    const doc = await compileClean(source);
    expect(doc.models[0].fields[0].decorators.doc).toBe("Price in ${currency}");
    expect(doc.models[0].doc).toBe('Topic ${"x"}.orders');
  }, 60_000);

  it("keeps a lone dollar sign untouched", async () => {
    const { source } = generate([field({ name: "price", description: "cost $5 and $" })]);
    const doc = await compileClean(source);
    expect(doc.models[0].fields[0].decorators.doc).toBe("cost $5 and $");
  }, 60_000);
});

describe("through the real JSON Schema emitter: the contract is what the producer sends", () => {
  it("emits the original property names and enum symbols", async () => {
    const { source } = generate([
      field({ name: "op" }),
      field({ name: "in-progress" }),
      field({ name: "日本語" }),
      field({ name: "status", type: "enum", aliases: ["in-progress", "en US", "1", "model"] }),
      field({ name: "specversion", type: "enum", aliases: ["1.0"] }),
    ]);
    const r = await runTypeSpecEmitterFiles("@typespec/json-schema", `import "@typespec/json-schema";\n\n${source}`, {
      emitAllModels: true,
      "file-type": "json",
    });
    if (!r.success) throw new Error(r.error.message);
    const byId = new Map(r.data.map((f) => [JSON.parse(f.content).$id as string, JSON.parse(f.content)]));
    const ticket = byId.get("Ticket.json");
    expect(Object.keys(ticket.properties)).toEqual(["op", "in-progress", "日本語", "status", "specversion"]);
    expect(byId.get("Ticket_status.json").enum).toEqual(["in-progress", "en US", "1", "model"]);
    expect(byId.get("Ticket_specversion.json").enum).toEqual(["1.0"]);
  }, 120_000);
});

describe("targets that need identifiers keep working with wire-name sources", () => {
  const fields = () => [
    field({ name: "id" }),
    field({ name: "in-progress" }),
    field({ name: "status", type: "enum", aliases: ["in-progress", "DONE"] }),
  ];

  it("the protobuf projection maps a wire name to the proto identifier it always used", () => {
    const { source } = generate(fields());
    const projected = projectTypeSpecSourceForProtobuf(source);
    expect(projected).toContain("  in_progress: string;");
    expect(projected).not.toContain("`in-progress`");
    expect(projected).toContain("  in_progress: 1,");
    expect(projected).not.toContain('"in-progress"');
  });

  it("protobuf: the real emitter writes valid field and enum value names", async () => {
    const r = await emitOfficialTypeSpecTargetFromData(entity(), fields(), "protobuf");
    expect(r.validationStatus).toBe("VALID");
    expect(r.output).toContain("string in_progress = 2;");
    expect(r.output).toContain("in_progress = 1;");
  }, 120_000);

  it("java-pojo: the wire name survives as @JsonProperty", async () => {
    const r = await emitOfficialTypeSpecTargetFromData(entity(), fields(), "java-pojo");
    expect(r.output).toContain('@JsonProperty("in-progress")');
  }, 120_000);
});

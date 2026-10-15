/**
 * Final review F5, round 2: the Avro projection used to skip any enum whose body held a `{` or `}` (a regex over
 * `[^{}]*`), so `"a{b"`, `"${x}"`, a `@doc("see {x}")` or a comment with a brace sent the WHOLE enum to the Avro emitter
 * unprojected — published as VALID, then ~80 opaque AsyncAPI parser errors. The scan is now brace-, string- and
 * comment-aware, and a safety net fails the emission loudly (naming the enum) when a symbol still is not valid.
 */
import { describe, it, expect, vi, beforeAll } from "vitest";
import { compileEntity } from "@/lib/compiler/compiler.service";
import type { PrismaEntityInput, PrismaFieldInput } from "@/lib/compiler/compiler.service";
import { generateTypeSpec } from "@/lib/compiler/typespec-generator";
import {
  AVRO_SYMBOL,
  describeAvroProjection,
  describeInvalidAvroSymbols,
  findInvalidAvroSymbols,
  projectTypeSpecSourceForAvro,
} from "@/lib/typespec-official/avro-source";
import { assembleAsyncApi3 } from "@/lib/event-specs/assemble";
import { AsyncApiParserValidator } from "@/lib/event-specs/validation/asyncapi-parser-validator";
import type { JsonObject } from "@/lib/event-specs/types";
import { channel, message, operation, spec } from "../event-specs/fixtures/builders";

vi.mock("server-only", () => ({}));

let emitOfficialTypeSpecTargetFromData: typeof import("@/lib/typespec-official/emitter.service").emitOfficialTypeSpecTargetFromData;
let runTypeSpecEmitterFiles: typeof import("@/lib/typespec-official/emitter.service").runTypeSpecEmitterFiles;
let targetResultFromFiles: typeof import("@/lib/typespec-official/emitter.service").targetResultFromFiles;
beforeAll(async () => {
  ({ emitOfficialTypeSpecTargetFromData, runTypeSpecEmitterFiles, targetResultFromFiles } = await import("@/lib/typespec-official/emitter.service"));
});

const entity: PrismaEntityInput = {
  id: "e1",
  name: "Ticket",
  description: "",
  status: "DRAFT",
  version: 1,
  domainId: "d1",
  metadata: {},
  domain: { id: "d1", name: "Sales", slug: "sales" },
};

let seq = 0;
const field = (name: string, type = "string", aliases: string[] = []): PrismaFieldInput => ({
  id: `f${seq}`,
  name,
  type,
  precision: null,
  scale: null,
  nullable: false,
  isKey: false,
  fieldNumber: null,
  description: "",
  classification: null,
  aliases,
  decorators: {},
  sortOrder: ++seq,
});

describe("enums with braces are projected (brace-, string- and comment-aware scan)", () => {
  it("a symbol that contains a brace", () => {
    const p = projectTypeSpecSourceForAvro('enum S {\n  "a{b",\n  "in-progress",\n}\nmodel A {\n  x: S;\n}\n');
    expect(p.source).toBe("enum S {\n  a_b,\n  in_progress,\n}\nmodel A {\n  x: S;\n}\n");
    expect(p.renames.map((r) => `${r.from}->${r.to}`)).toEqual(["a{b->a_b", "in-progress->in_progress"]);
  });

  it("a closing brace first, and a template-looking symbol the generator escapes", () => {
    const p = projectTypeSpecSourceForAvro('enum S {\n  "}x{",\n  "\\${x}",\n  ok,\n}\n');
    expect(p.source).toBe("enum S {\n  _x_,\n  __x_,\n  ok,\n}\n");
  });

  it("a member decorator whose string holds braces", () => {
    const p = projectTypeSpecSourceForAvro('enum S {\n  @doc("see {x} and }")\n  ok,\n  "in-progress",\n}\n');
    expect(p.source).toBe('enum S {\n  @doc("see {x} and }")\n  ok,\n  in_progress,\n}\n');
  });

  it("a member decorator with a nested object value (unquoted braces) does not end the enum early", () => {
    const source = 'enum S {\n  @example(#{ a: "x", b: #{ c: 1 } })\n  ok,\n  "in-progress",\n}\nmodel M {\n  s: S;\n}\n';
    const p = projectTypeSpecSourceForAvro(source);
    expect(p.source).toBe('enum S {\n  @example(#{ a: "x", b: #{ c: 1 } })\n  ok,\n  in_progress,\n}\nmodel M {\n  s: S;\n}\n');
    expect(p.renames).toEqual([{ enumName: "S", from: "in-progress", to: "in_progress" }]);
  });

  it("a comment with braces (line and block)", () => {
    const source = "enum S {\n  // legacy { value } here\n  ok,\n  /* } */\n  \"en US\",\n}\n";
    expect(projectTypeSpecSourceForAvro(source).source).toBe("enum S {\n  // legacy { value } here\n  ok,\n  /* } */\n  en_US,\n}\n");
  });

  it("an enum inside a namespace block, and several enums, each projected", () => {
    const source = [
      "namespace Acme.Sales {",
      "  enum A {",
      '    "a-b",',
      "  }",
      "  model M {",
      "    x: A;",
      "  }",
      "}",
      "",
      "@doc(\"decorated { enum Fake { \\\"x-y\\\" } }\")",
      "enum B {",
      '  "c d",',
      "}",
      "",
    ].join("\n");
    const p = projectTypeSpecSourceForAvro(source);
    expect(p.renames).toEqual([
      { enumName: "A", from: "a-b", to: "a_b" },
      { enumName: "B", from: "c d", to: "c_d" },
    ]);
    // the `enum Fake { … }` inside the decorator's string is text, not a declaration
    expect(p.source).toContain('@doc("decorated { enum Fake { \\"x-y\\" } }")');
    expect(p.source).toContain("  enum A {\n    a_b,\n  }");
    expect(p.source).toContain("enum B {\n  c_d,\n}");
  });

  it("a backticked enum name, a triple-quoted doc, and `enum` as a word inside a string or comment", () => {
    const source = '// enum Nope { "x-y" }\nconst s = "enum Nope2 { \\"x-y\\" }";\n@doc("""\nan enum { with braces }\n""")\nenum `My-Enum` {\n  "a-b",\n}\n';
    const p = projectTypeSpecSourceForAvro(source);
    expect(p.renames).toEqual([{ enumName: "My-Enum", from: "a-b", to: "a_b" }]);
    expect(p.source).toContain("// enum Nope { \"x-y\" }");
    expect(p.source).toContain("enum `My-Enum` {\n  a_b,\n}");
  });

  it("an unbalanced enum is left alone instead of crashing", () => {
    const source = 'enum Broken {\n  "a-b",\n';
    expect(projectTypeSpecSourceForAvro(source)).toEqual({ source, renames: [], collisions: [] });
  });

  it("still reports a collision across brace-bearing values", () => {
    const p = projectTypeSpecSourceForAvro('enum S {\n  "a{b",\n  "a}b",\n}\n');
    expect(describeAvroProjection(p).errors).toEqual(['Avro enum S: the values "a{b" and "a}b" would all be published as the symbol "a_b" — rename one of them']);
  });
});

describe("the safety net: every emitted symbol must be valid", () => {
  it("findInvalidAvroSymbols walks nested schemas and reports each bad symbol once, naming the enum", () => {
    const schema = {
      type: "record",
      name: "R",
      fields: [
        { name: "a", type: { type: "enum", name: "Priority", symbols: ["1", "2", "OK"] } },
        { name: "b", type: ["null", { type: "array", items: { type: "enum", name: "Kind", symbols: ["a-b", "a-b", "fine"] } }] },
      ],
    };
    expect(findInvalidAvroSymbols(schema)).toEqual(
      expect.arrayContaining([
        { enumName: "Priority", symbol: "1" },
        { enumName: "Priority", symbol: "2" },
        { enumName: "Kind", symbol: "a-b" },
      ])
    );
    expect(findInvalidAvroSymbols(schema)).toHaveLength(3);
    expect(findInvalidAvroSymbols({ type: "record", fields: [{ type: { type: "enum", name: "E", symbols: ["ok", "_x"] } }] })).toEqual([]);
    expect(findInvalidAvroSymbols("not a schema")).toEqual([]);
  });

  it("describes a numeric symbol with the reason and the way out", () => {
    expect(describeInvalidAvroSymbols([{ enumName: "Priority", symbol: "1" }])).toEqual([
      'Avro enum Priority has the symbol "1", which is not valid (an Avro symbol must match [A-Za-z_][A-Za-z0-9_]*) — an enum member with a numeric value publishes that number, which Avro cannot carry — use named members without values',
    ]);
  });

  it("numeric-valued members (Low: 1) through the real Avro emitter are a loud INVALID result naming the enum", async () => {
    const source = "enum Priority {\n  Low: 1,\n  High: 2,\n}\n\nmodel Ticket {\n  priority: Priority;\n}\n";
    const files = await runTypeSpecEmitterFiles("@typespec/avro", projectTypeSpecSourceForAvro(source).source, {});
    if (!files.success) throw new Error(files.error.message);
    const symbols = (JSON.parse(files.data[0].content) as { fields: Array<{ type: { symbols: string[] } }> }).fields[0].type.symbols;
    expect(symbols).toEqual(["1", "2"]); // the emitter publishes the numbers — invalid Avro, and it was invalid at the base too

    const result = targetResultFromFiles("@typespec/avro", files.data);
    expect(result.validationStatus).toBe("INVALID");
    expect(result.output).toBe("");
    expect(result.errors).toHaveLength(2);
    expect(result.errors[0].message).toContain('Avro enum Priority has the symbol "1"');
    expect(result.errors[0].message).toContain("numeric value");
  }, 120_000);

  it("a valid Avro emission is untouched by the net", () => {
    const ok = targetResultFromFiles("@typespec/avro", [{ relativePath: "T.avsc.json", content: '{"type":"record","name":"T","fields":[{"name":"s","type":{"type":"enum","name":"S","symbols":["A","b_1"]}}]}' }]);
    expect(ok.validationStatus).toBe("VALID");
    expect(targetResultFromFiles("@typespec/avro", [{ relativePath: "x", content: "not json" }]).validationStatus).toBe("VALID");
  });
});

describe("brace-bearing generated enums through the real emitter and the real AsyncAPI parser", () => {
  const symbols = ["${x}", "日本語", "a.b", "x/y", "}x", "in-progress", "plain"];

  it("the generated enum is projected, published with valid symbols, and the parser accepts it", async () => {
    const fields = [field("id"), field("status", "enum", symbols)];
    // the generated source really holds braces inside the enum body (the case the old regex skipped)
    const generated = generateTypeSpec(compileEntity(entity, fields), { governance: false });
    expect(generated).toContain('"\\${x}"');
    expect(generated).toContain('"}x"');

    const r = await emitOfficialTypeSpecTargetFromData(entity, fields, "avro");
    expect(r.errors).toEqual([]);
    expect(r.validationStatus).toBe("WARNING");
    const schema = JSON.parse(r.output) as { fields: Array<{ name: string; type: { symbols?: string[] } }> };
    const published = schema.fields.find((f) => f.name === "status")?.type.symbols ?? [];
    expect(published).toEqual(["__x_", "___", "a_b", "x_y", "_x", "in_progress", "plain"]);
    for (const symbol of published) expect(AVRO_SYMBOL.test(symbol)).toBe(true);
  }, 180_000);

  it("a collision among brace-bearing values is an INVALID emission naming the enum", async () => {
    const r = await emitOfficialTypeSpecTargetFromData(entity, [field("id"), field("kind", "enum", ["a{b", "a}b"])], "avro");
    expect(r.validationStatus).toBe("INVALID");
    expect(r.errors).toEqual([{ message: 'Avro enum Ticket_kind: the values "a{b" and "a}b" would all be published as the symbol "a_b" — rename one of them' }]);
  }, 120_000);

  it("without braces in the way the AsyncAPI parser accepts the projected payload (0 errors)", async () => {
    const r = await emitOfficialTypeSpecTargetFromData(entity, [field("id"), field("status", "enum", ["a{b", "in-progress", "${x}", "ok"])], "avro");
    expect(r.validationStatus).toBe("WARNING");
    const document = assembleAsyncApi3(
      spec({
        channels: [channel({ id: "ch", name: "tickets", profile: { format: "avro" } })],
        messages: [message({ id: "m", name: "Ticket", payloads: [{ format: "avro", schema: JSON.parse(r.output) as JsonObject }] })],
        operations: [operation({ key: "publishTicket", channelRef: "ch", messageRefs: ["m"] })],
      })
    ).document;
    const parsed = await new AsyncApiParserValidator().validate(document);
    if (!parsed.success) throw new Error(parsed.error.message);
    expect(parsed.data.filter((d) => d.severity === "error")).toEqual([]);
  }, 180_000);
});

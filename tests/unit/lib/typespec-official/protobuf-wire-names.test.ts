/**
 * Final review F5, C1: protobuf must emit a message for EVERY field name. The generator wrote `context` / `metadata` /
 * `public` … quoted (they compile bare), the protobuf projection renamed them, and `injectProtobufFieldNumbers` looked
 * them up under yet another spelling — no `@field(n)` was injected and the emitter silently wrote an EMPTY schema
 * (`syntax = "proto3";` only) with status VALID. Now: wire names + numbers identical to the base, and an empty result
 * is an error.
 */
import { describe, it, expect, vi, beforeAll } from "vitest";
import { compileEntity } from "@/lib/compiler/compiler.service";
import type { PrismaEntityInput, PrismaFieldInput } from "@/lib/compiler/compiler.service";
import { generateTypeSpec } from "@/lib/compiler/typespec-generator";
import { protobufFieldName } from "@/lib/compiler/typespec-identifiers";
import { projectTypeSpecSourceForProtobuf } from "@/lib/typespec-official/protobuf-source";

vi.mock("server-only", () => ({}));

let emitOfficialTypeSpecTargetFromData: typeof import("@/lib/typespec-official/emitter.service").emitOfficialTypeSpecTargetFromData;
let injectProtobufFieldNumbers: typeof import("@/lib/typespec-official/emitter.service").injectProtobufFieldNumbers;
let unusableOutputReason: typeof import("@/lib/typespec-official/emitter.service").unusableOutputReason;
let targetResultFromFiles: typeof import("@/lib/typespec-official/emitter.service").targetResultFromFiles;

beforeAll(async () => {
  ({ emitOfficialTypeSpecTargetFromData, injectProtobufFieldNumbers, unusableOutputReason, targetResultFromFiles } = await import(
    "@/lib/typespec-official/emitter.service"
  ));
});

const entity = (name: string): PrismaEntityInput => ({
  id: "e1",
  name,
  description: "",
  status: "DRAFT",
  version: 1,
  domainId: "d1",
  metadata: {},
  domain: { id: "d1", name: "Sales", slug: "sales" },
});

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

/** Every field name the final review named: reserved-for-future words, `internal`, and the hard keywords `op` / `model`. */
const NAMES = ["id", "context", "metadata", "public", "flag", "record", "internal", "op", "model"];

describe("protobuf emission keeps every field (real @typespec/protobuf)", () => {
  it("emits all fields with their wire names and 1-based numbers", async () => {
    const r = await emitOfficialTypeSpecTargetFromData(entity("Order"), NAMES.map((n) => field(n)), "protobuf");
    expect(r.errors).toEqual([]);
    expect(r.validationStatus).toBe("VALID");
    expect(r.output).toMatch(/message Order \{/);
    NAMES.forEach((name, i) => expect(r.output, name).toContain(`string ${name} = ${i + 1};`));
  }, 120_000);

  it("explicit stored field numbers win, for bare and backticked names alike", async () => {
    const fields = [
      { ...field("context"), fieldNumber: 7 },
      { ...field("op"), fieldNumber: 3 },
    ];
    const r = await emitOfficialTypeSpecTargetFromData(entity("Order"), fields, "protobuf");
    expect(r.validationStatus).toBe("VALID");
    expect(r.output).toContain("string context = 7;");
    expect(r.output).toContain("string op = 3;");
  }, 120_000);

  it("a name that is not an identifier becomes its `_` form with its number", async () => {
    const r = await emitOfficialTypeSpecTargetFromData(entity("Order"), [field("id"), field("in-progress"), field("2nd")], "protobuf");
    expect(r.validationStatus).toBe("VALID");
    expect(r.output).toContain("string in_progress = 2;");
    expect(r.output).toContain("string _2nd = 3;");
  }, 120_000);

  it("a lowercase entity named like a reserved word (record / metadata) emits instead of silently dropping the message", async () => {
    for (const name of ["record", "metadata"]) {
      const r = await emitOfficialTypeSpecTargetFromData(entity(name), [field("id"), field("context")], "protobuf");
      expect(r.errors, name).toEqual([]);
      expect(r.validationStatus, name).toBe("VALID");
      expect(r.output, name).toMatch(new RegExp(`message _${name} \\{`));
      expect(r.output, name).toContain("string context = 2;");
    }
  }, 180_000);

  it("enum members that are reserved words keep their names too", async () => {
    const r = await emitOfficialTypeSpecTargetFromData(
      entity("Order"),
      [field("id"), field("kind", "enum", ["public", "context", "ACTIVE"])],
      "protobuf"
    );
    expect(r.validationStatus).toBe("VALID");
    expect(r.output).toContain("public = 1;");
    expect(r.output).toContain("context = 2;");
  }, 120_000);
});

describe("an emission that wrote no message is an error, not VALID", () => {
  it("flags a protobuf output without any message", () => {
    expect(unusableOutputReason("@typespec/protobuf", 'syntax = "proto3";\n')).toMatch(/wrote no message/);
    expect(unusableOutputReason("@typespec/protobuf", "// Generated by Microsoft TypeSpec\n\nsyntax = \"proto3\";\n")).not.toBeNull();
  });

  it("accepts an output with a message, and never judges other emitters", () => {
    expect(unusableOutputReason("@typespec/protobuf", 'syntax = "proto3";\n\nmessage Order {\n  string id = 1;\n}\n')).toBeNull();
    expect(unusableOutputReason("@typespec/protobuf", 'syntax = "proto3";\n\nenum E {\n  A = 0;\n}\nmessage M {}\n')).toBeNull();
    expect(unusableOutputReason("@typespec/avro", "{}")).toBeNull();
  });

  it("the target result of an empty protobuf run is INVALID with the reason; a normal run stays VALID", () => {
    const empty = targetResultFromFiles("@typespec/protobuf", [{ relativePath: "main.proto", content: '// Generated by Microsoft TypeSpec\n\nsyntax = "proto3";\n' }]);
    expect(empty.validationStatus).toBe("INVALID");
    expect(empty.output).toBe("");
    expect(empty.errors).toEqual([{ message: expect.stringContaining("wrote no message") }]);

    const good = targetResultFromFiles("@typespec/protobuf", [{ relativePath: "main.proto", content: 'syntax = "proto3";\n\nmessage Order {\n  string id = 1;\n}\n' }]);
    expect(good).toMatchObject({ validationStatus: "VALID", errors: [], warnings: [] });
    expect(good.output).toContain("message Order");
    expect(targetResultFromFiles("@typespec/json-schema", [{ relativePath: "a.json", content: "{}" }]).validationStatus).toBe("VALID");
  });
});

describe("the projection and the @field(n) injection agree on every spelling", () => {
  const source = (fields: PrismaFieldInput[]) => generateTypeSpec(compileEntity(entity("Order"), fields), { governance: false });

  it("protobufFieldName is the identity for identifiers (keywords included) and `_` for the rest", () => {
    for (const name of ["context", "op", "model", "metadata", "_x", "a1"]) expect(protobufFieldName(name)).toBe(name);
    expect(protobufFieldName("in-progress")).toBe("in_progress");
    expect(protobufFieldName("2nd")).toBe("_2nd");
    expect(protobufFieldName("日本語")).toBe("___");
  });

  it("a backticked hard keyword keeps its backticks through the projection", () => {
    const projected = projectTypeSpecSourceForProtobuf(source([field("op"), field("context"), field("in-progress")]));
    expect(projected).toContain("  `op`: string;");
    expect(projected).toContain("  context: string;");
    expect(projected).toContain("  in_progress: string;");
  });

  it("injects @field(n) before a bare name, a backticked name and a renamed name", () => {
    const fields = [field("context"), field("op"), field("in-progress")];
    const projected = projectTypeSpecSourceForProtobuf(source(fields));
    const injected = injectProtobufFieldNumbers(projected, "Order", fields);
    expect(injected).toContain("  @field(1)\n  context: string;");
    expect(injected).toContain("  @field(2)\n  `op`: string;");
    expect(injected).toContain("  @field(3)\n  in_progress: string;");
  });
});

/**
 * `T | null` is a union to the protobuf emitter ("a message field's type may not be a union"), but a proto3 `optional` field is exactly
 * a value that may be absent: the null of the type is dropped and the property is written optional (what `a?: T` always was there).
 */
import { describe, expect, it, vi } from "vitest";
vi.setConfig({ testTimeout: 60_000 });
vi.mock("server-only", () => ({}));
import { projectTypeSpecSourceForProtobuf } from "@/lib/typespec-official/protobuf-source";
import { compileEntity, type PrismaEntityInput, type PrismaFieldInput } from "@/lib/compiler/compiler.service";
import { emitOfficialTypeSpecTargetFromData } from "@/lib/typespec-official/emitter.service";

describe("projectTypeSpecSourceForProtobuf: the null of a type", () => {
  const project = (line: string) => projectTypeSpecSourceForProtobuf(`model M {\n  ${line}\n}`).split("\n")[1].trim();

  it("`a: T | null;` is `a?: T;`", () => {
    expect(project("a: string | null;")).toBe("a?: string;");
  });

  it("`a?: T | null;` is `a?: T;`", () => {
    expect(project("a?: string | null;")).toBe("a?: string;");
  });

  it("the type is still projected for protobuf, after the null is dropped", () => {
    expect(project("a: utcDateTime | null;")).toMatch(/^a\?: .*Timestamp/);
    expect(project("n: integer | null;")).toBe("n?: int64;");
  });

  it("an array keeps being an array, a default is kept", () => {
    expect(project("t: string[] | null;")).toBe("t?: string[];");
    expect(project('s: string | null = "x";')).toBe('s?: string = "x";');
  });

  it("a property without a null type is untouched", () => {
    expect(project("a: string;")).toBe("a: string;");
    expect(project("a?: string;")).toBe("a?: string;");
  });

  it("the validators above the property stay (only the type's null went)", () => {
    const text = projectTypeSpecSourceForProtobuf('model M {\n  @maxLength(5)\n  a: string | null;\n}');
    expect(text).toContain("@maxLength(5)");
  });
});

describe("the protobuf target generates an entity with a nullable type", () => {
  const entity: PrismaEntityInput = { id: "e1", name: "Evt", description: "", status: "DRAFT", version: 1, domainId: "d", metadata: {}, domain: { id: "d", name: "Sales", slug: "sales" } };
  const field = (name: string, type: string, decorators: Record<string, unknown>, i: number, nullable: boolean, isKey = false): PrismaFieldInput => ({
    id: name, name, type, precision: null, scale: null, nullable, isKey, fieldNumber: i + 1, description: "", classification: null, aliases: [], decorators, sortOrder: i,
  });
  const fields = [
    field("id", "string", {}, 0, false, true),
    field("reqNull", "string", { nullableType: true, requiredNullable: true }, 1, true),
    field("optNull", "integer", { nullableType: true }, 2, true),
  ];

  it("emits the fields as it always did for an optional one", async () => {
    expect(compileEntity(entity, fields).fields[1].nullableType).toBe(true);
    const result = await emitOfficialTypeSpecTargetFromData(entity, fields, "protobuf");
    expect(result.errors).toEqual([]);
    // @typespec/protobuf 0.82+ writes an optional scalar with proto3's explicit `optional` (presence tracking; the wire format is the same).
    expect(result.output).toMatch(/^  optional string reqNull = \d+;/m);
    expect(result.output).toMatch(/^  optional int64 optNull = \d+;/m);
  });
});

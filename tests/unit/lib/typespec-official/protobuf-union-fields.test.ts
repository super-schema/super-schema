/**
 * A .proto message field cannot be a union (@typespec/protobuf: "a message field's type may not be a union"). A union field (scalar members:
 * a JSON Schema `type: [a, b]` / `oneOf` of scalars imports as one) is written as `string` for protobuf, with a warning that says so,
 * instead of making the whole entity impossible to generate.
 */
import { describe, expect, it, vi } from "vitest";
vi.setConfig({ testTimeout: 60_000 });
vi.mock("server-only", () => ({}));
import { compileEntity, type PrismaEntityInput, type PrismaFieldInput } from "@/lib/compiler/compiler.service";
import { buildSourceForTarget, emitOfficialTypeSpecTargetFromData } from "@/lib/typespec-official/emitter.service";

const entity: PrismaEntityInput = { id: "e1", name: "Evt", description: "", status: "DRAFT", version: 1, domainId: "d", metadata: {}, domain: { id: "d", name: "Sales", slug: "sales" } };
const field = (name: string, type: string, decorators: Record<string, unknown>, i: number, isKey = false): PrismaFieldInput => ({
  id: name, name, type, precision: null, scale: null, nullable: false, isKey, fieldNumber: i + 1, description: "", classification: null, aliases: [], decorators, sortOrder: i,
});
const fields = [
  field("id", "string", {}, 0, true),
  field("u", "union", { unionName: "Evt_u_Union", unionMembers: ["string", "integer"] }, 1),
  field("tags", "array", { arrayElementType: "union", unionName: "Evt_tags_Union", unionMembers: ["string", "int64"] }, 2),
];

describe("protobuf and union fields", () => {
  it("the source writes a union field and an array of unions as string / string[]", () => {
    const built = buildSourceForTarget(compileEntity(entity, fields), "protobuf");
    expect(built.source).toMatch(/\bu: string;/);
    expect(built.source).toMatch(/\btags: string\[\];/);
    expect(built.source).not.toContain("string | integer");
  });

  it("says so, once per field", () => {
    const built = buildSourceForTarget(compileEntity(entity, fields), "protobuf");
    expect(built.warnings).toEqual([
      'Field "u": a union of string | integer; protobuf has no union field, so it is written as string.',
      'Field "tags": the items are a union of string | int64; protobuf has no union field, so they are written as string.',
    ]);
  });

  it("the emitter generates the .proto (a warning, not an error)", async () => {
    const result = await emitOfficialTypeSpecTargetFromData(entity, fields, "protobuf");
    expect(result.errors).toEqual([]);
    expect(result.validationStatus).toBe("WARNING");
    expect(result.output).toMatch(/string u = \d+;/);
    expect(result.output).toMatch(/repeated string tags = \d+;/);
    expect(result.warnings.join("\n")).toContain('Field "u": a union of string | integer');
  });

  it("the other targets keep the union", () => {
    expect(buildSourceForTarget(compileEntity(entity, fields), "json-schema").source).toContain("string | integer");
  });
});

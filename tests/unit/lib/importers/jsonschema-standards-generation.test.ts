import { beforeAll, describe, expect, it } from "vitest";
import { compileEntity } from "@/lib/compiler/compiler.service";
import type { PrismaEntityInput, PrismaFieldInput } from "@/lib/compiler/compiler.service";
import { generateTypeSpecWithDiagnostics } from "@/lib/compiler/typespec-generator";
import { parseJsonSchemaDocument } from "@/lib/importers/jsonschema.importer";
import { parsedFieldToCreateFieldInput } from "@/lib/importers/import-payload";

let compile: typeof import("@/lib/compiler/typespec-compiler").compileTypeSpecWithGovernance;
beforeAll(async () => {
  ({ compileTypeSpecWithGovernance: compile } = await import("@/lib/compiler/typespec-compiler"));
});

function generate(schema: unknown) {
  const r = parseJsonSchemaDocument(JSON.stringify(schema));
  if (!r.success) throw new Error(r.error.message);
  const entity = r.data.entities[0];
  const rows: PrismaFieldInput[] = entity.fields.map((f, i) => {
    const input = parsedFieldToCreateFieldInput(f);
    return {
      id: `f${i}`, name: input.name, type: input.type, precision: null, scale: null, nullable: input.nullable, isKey: input.isKey,
      fieldNumber: null, description: input.description ?? "", classification: null, aliases: input.aliases ?? [],
      decorators: (input.decorators ?? {}) as Record<string, unknown>, sortOrder: i,
    };
  });
  const e: PrismaEntityInput = { id: "e1", name: entity.name, description: "", status: "DRAFT", version: 1, domainId: "d1", metadata: {}, domain: { id: "d1", name: "Identity", slug: "identity" } };
  return generateTypeSpecWithDiagnostics(compileEntity(e, rows), { governance: false });
}

const errorsOf = async (source: string) => {
  const r = await compile(source, {});
  return ((r as { diagnostics?: Array<{ severity: string; message: string }> }).diagnostics ?? []).filter((d) => d.severity === "error").map((d) => d.message);
};

describe("standards support survives generation", () => {
  it("x-enum descriptions become @doc on the enum members and the source compiles", async () => {
    const { source } = generate({
      type: "object", title: "Login",
      properties: { intent: { type: "string", "x-enum": [{ value: "LOGIN_SUCCESS", description: "Logged in." }, { value: "LOGIN_FAILURE", description: "Failed." }] } },
    });
    expect(source).toContain('@doc("Logged in.")');
    expect(source).toMatch(/@doc\("Failed\."\)\s*\n\s*LOGIN_FAILURE/);
    expect(await errorsOf(source)).toEqual([]);
  });

  it("a NUL in a description never reaches the generated source", () => {
    const { source } = generate({ type: "object", title: "O", description: "a\u0000b", properties: { x: { type: "string", description: "c\u0000d" } } });
    expect(source).not.toContain("\u0000");
  });
});

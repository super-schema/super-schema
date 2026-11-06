import { beforeAll, describe, expect, it } from "vitest";
import { generateTypeSpec } from "@/lib/compiler/typespec-generator";
import type { SuperSchemaModel } from "@/types/super-schema-model";

let compile: typeof import("@/lib/compiler/typespec-compiler").compileTypeSpecWithGovernance;
beforeAll(async () => {
  ({ compileTypeSpecWithGovernance: compile } = await import("@/lib/compiler/typespec-compiler"));
});

const model = (customScalars: SuperSchemaModel["customScalars"]): SuperSchemaModel => ({
  entity: { id: "e1", name: "Holder", domain: "identity", description: "", status: "DRAFT", version: 1, metadata: {} } as never,
  fields: [],
  relationships: [],
  customScalars,
});

describe("custom scalars are written with their constraints", () => {
  it("emits format, pattern and bounds as decorators on the scalar", () => {
    const source = generateTypeSpec(
      model([
        { name: "CountryCode", baseType: "string", description: "ISO alpha-2", pattern: "^[A-Z]{2}$", constraints: { minLength: 2, maxLength: 2 } },
        { name: "Percentage", baseType: "int32", constraints: { minValue: 0, maxValue: 100 } },
        { name: "Email", baseType: "string", format: "email" },
      ])
    );
    expect(source).toContain('@pattern("^[A-Z]{2}$")');
    expect(source).toMatch(/@minLength\(2\)\s*\n@maxLength\(2\)\s*\nscalar CountryCode extends string;/);
    expect(source).toMatch(/@minValue\(0\)\s*\n@maxValue\(100\)\s*\nscalar Percentage extends int32;/);
    expect(source).toMatch(/@format\("email"\)\s*\nscalar Email extends string;/);
  });

  it("the generated source compiles", async () => {
    const source = generateTypeSpec(
      model([
        { name: "CountryCode", baseType: "string", pattern: "^[A-Z]{2}$", constraints: { minLength: 2, maxLength: 2 } },
        { name: "Percentage", baseType: "int32", constraints: { minValue: 0, maxValue: 100 } },
        { name: "Email", baseType: "string", format: "email" },
      ])
    );
    const r = await compile(source, {});
    const errors = (r as { diagnostics?: Array<{ severity: string; message: string }> }).diagnostics?.filter((d) => d.severity === "error") ?? [];
    expect(errors, errors.map((e) => e.message).join("; ")).toEqual([]);
  });
});

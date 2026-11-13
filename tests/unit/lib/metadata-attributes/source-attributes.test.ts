import { describe, it, expect } from "vitest";
import { modelExtensionsInSource, stripExtensionDecorators } from "@/lib/metadata-attributes/source-attributes";

const KEYS = ["x-review-note"];

describe("stripExtensionDecorators", () => {
  it("removes both forms of an internal key, each line with it, and keeps every other key", () => {
    const source = [
      "model Customer {",
      '  @TypeSpec.JsonSchema.extension("x-review-note", "check")',
      '  @TypeSpec.OpenAPI.extension("x-review-note", "check")',
      '  @TypeSpec.JsonSchema.extension("x-securityClassification", #{data_class: "class2"})',
      "  note: string;",
      "}",
      "",
    ].join("\n");
    expect(stripExtensionDecorators(source, KEYS)).toBe(
      ["model Customer {", '  @TypeSpec.JsonSchema.extension("x-securityClassification", #{data_class: "class2"})', "  note: string;", "}", ""].join("\n")
    );
  });

  it("handles a literal spanning lines with `)` and quotes inside strings; a decorator sharing its line leaves the rest", () => {
    const source = [
      "model A {",
      '  @TypeSpec.JsonSchema.extension("x-review-note", #{',
      '    text: "a ) b \\" c",',
      "    n: 1",
      "  })",
      '  @doc("d") @extension("x-review-note", "x") note: string;',
      "}",
    ].join("\n");
    expect(stripExtensionDecorators(source, KEYS)).toBe(["model A {", '  @doc("d") note: string;', "}"].join("\n"));
  });

  it("leaves decorator text inside strings and comments alone, and returns the same string when nothing matches", () => {
    const source = [
      "// @TypeSpec.JsonSchema.extension(\"x-review-note\", \"c\")",
      '@doc("@TypeSpec.OpenAPI.extension(\\"x-review-note\\", 1)")',
      "model A { a: string; }",
    ].join("\n");
    expect(stripExtensionDecorators(source, KEYS)).toBe(source);
    expect(stripExtensionDecorators(source, [])).toBe(source);
  });
});

describe("modelExtensionsInSource", () => {
  it("reads the model's own extension values, not its properties' nor another model's", () => {
    const source = [
      '@TypeSpec.JsonSchema.extension("x-owner-team", "other")',
      "model Other { a: string; }",
      "",
      '@doc("A customer")',
      '@TypeSpec.JsonSchema.extension("x-owner-team", "payments")',
      '@TypeSpec.OpenAPI.extension("x-owner-team", "payments")',
      '@TypeSpec.JsonSchema.extension("x-slo", #{p95: 200})',
      "model Customer {",
      '  @TypeSpec.JsonSchema.extension("x-field", 1)',
      "  a: string;",
      "}",
    ].join("\n");
    expect(modelExtensionsInSource(source, "Customer")).toEqual({ "x-owner-team": "payments", "x-slo": { p95: 200 } });
    expect(modelExtensionsInSource(source, "Missing")).toEqual({});
  });
});

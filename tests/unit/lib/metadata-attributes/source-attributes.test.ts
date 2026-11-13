import { describe, it, expect } from "vitest";
import { MetadataStripError, modelExtensionsInSource, stripExtensionDecorators } from "@/lib/metadata-attributes/source-attributes";

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

describe("stripExtensionDecorators: augment decorators and failing closed", () => {
  it("strips augment decorators (`@@extension(Target, key, value);`, every qualification) of an internal key, keeping the others", () => {
    const source = [
      "model A { note: string; }",
      '@@extension(A.note, "x-review-note", "c");',
      '@@TypeSpec.JsonSchema.extension(A.note, "x-review-note", #{t: "a, b"});',
      '@@OpenAPI.extension(Ns.A.note, "x-review-note", "c");',
      '@@JsonSchema.extension(A.note, "x-keep", 1);',
      "",
    ].join("\n");
    expect(stripExtensionDecorators(source, KEYS)).toBe(["model A { note: string; }", '@@JsonSchema.extension(A.note, "x-keep", 1);', ""].join("\n"));
  });

  it("reads a triple-quoted string that ends in an escaped quote as one string", () => {
    // `"""say \""""`: the escaped quote is content, the next three close the string.
    const doc = '@doc("""say \\"""")';
    const source = [doc, '@TypeSpec.JsonSchema.extension("x-review-note", "c")', "model A { a: string; }"].join("\n");
    expect(stripExtensionDecorators(source, KEYS)).toBe([doc, "model A { a: string; }"].join("\n"));
  });

  it("throws when the source mentions an internal key and cannot be scanned", () => {
    const source = ['@TypeSpec.JsonSchema.extension("x-review-note", "c")', 'model A { @doc("unterminated) a: string; }'].join("\n");
    expect(() => stripExtensionDecorators(source, KEYS)).toThrow(MetadataStripError);
    // Without an internal key in it, an unreadable source is the compiler's business.
    const plain = 'model A { @doc("unterminated) a: string; }';
    expect(stripExtensionDecorators(plain, KEYS)).toBe(plain);
  });

  it("throws when an extension decorator carries the key in a form whose key cannot be read", () => {
    expect(() => stripExtensionDecorators('@extension(KEY_CONST, "x-review-note")\nmodel A {}', KEYS)).toThrow(MetadataStripError);
    // A non-internal key whose VALUE mentions the internal key is fine.
    const fine = '@extension("x-other", #{see: "x-review-note"})\nmodel A {}';
    expect(stripExtensionDecorators(fine, KEYS)).toBe(fine);
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

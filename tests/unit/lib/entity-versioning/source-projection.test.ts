import { describe, it, expect } from "vitest";
import {
  compareSourceProjection,
  expandBlocks,
  projectRowFields,
  projectSourceFields,
} from "@/lib/entity-versioning/source-projection";

describe("projectSourceFields", () => {
  it("projects the entity's model: field names + logical types (array element included)", () => {
    const source = `
import "@typespec/http";
model Address { line1: string; }
@doc("A customer")
model Customer {
  @key id: string;
  createdAt: utcDateTime;
  tags?: string[];
  address: Address;
  attrs: Record<string>;
}`;
    expect(projectSourceFields(source, "Customer")).toEqual([
      { name: "id", type: "string" },
      { name: "createdAt", type: "utcDateTime" },
      { name: "tags", type: "array<string>" },
      { name: "address", type: "Address" },
      { name: "attrs", type: "map" },
    ]);
  });

  it("matches the model by sanitized name, else falls back to the first model", () => {
    expect(projectSourceFields("model Line_Item { qty: int32; }", "Line Item")).toEqual([{ name: "qty", type: "int32" }]);
    expect(projectSourceFields("model Other { a: string; }", "Missing")).toEqual([{ name: "a", type: "string" }]);
  });

  it("projects nothing for a source without models", () => {
    expect(projectSourceFields("// empty", "Customer")).toEqual([]);
  });
});

describe("projectRowFields", () => {
  it("normalizes row types through the TypeSpec scalar map and keeps the array element type", () => {
    expect(
      projectRowFields([
        { name: "id", type: "string", decorators: {} },
        { name: "tags", type: "array", decorators: { arrayElementType: "string" } },
        { name: "status", type: "Status", decorators: null },
      ])
    ).toEqual([
      { name: "id", type: "string" },
      { name: "tags", type: "array<string>" },
      { name: "status", type: "Status" },
    ]);
  });
});

describe("compareSourceProjection", () => {
  const f = (name: string, type: string) => ({ name, type });

  it("is consistent when names and types agree", () => {
    const stored = [f("id", "string"), f("n", "int32")];
    expect(compareSourceProjection(stored, stored, stored)).toEqual({ differs: false, reasons: [] });
  });

  it("is consistent when the stored type is what the generator renders for the row (lossy generator)", () => {
    // Row type "Status" (an enum name the generator cannot render) is generated as `string`.
    expect(compareSourceProjection([f("status", "string")], [f("status", "Status")], [f("status", "string")]))
      .toEqual({ differs: false, reasons: [] });
  });

  it("is consistent when the stored type equals the row type the TypeSpec save projected", () => {
    expect(compareSourceProjection([f("status", "Status")], [f("status", "Status")], [f("status", "string")]))
      .toEqual({ differs: false, reasons: [] });
  });

  it("differs when a field was added or removed outside the source", () => {
    expect(compareSourceProjection([f("id", "string"), f("old", "string")], [f("id", "string"), f("email", "string")], [f("id", "string"), f("email", "string")]))
      .toEqual({ differs: true, reasons: ['field "email" missing from source', 'field "old" only in source'] });
  });

  it("differs when a field type changed outside the source", () => {
    expect(compareSourceProjection([f("n", "int32")], [f("n", "int64")], [f("n", "int64")]))
      .toEqual({ differs: true, reasons: ['field "n" type: source int32, fields int64'] });
  });

  it("ignores field order", () => {
    expect(compareSourceProjection([f("a", "string"), f("b", "string")], [f("b", "string"), f("a", "string")], []).differs).toBe(false);
  });
});

describe("expandBlocks", () => {
  it("keeps strings and comments intact while splitting one-line blocks", () => {
    const src = 'model A { @doc("x; {y}") a: string; // c; {d}\n b: int32; }';
    expect(projectSourceFields(src, "A")).toEqual([
      { name: "a", type: "string" },
      { name: "b", type: "int32" },
    ]);
  });

  it("does not split inside decorator arguments", () => {
    expect(expandBlocks("@foo(#{k: 1; j: 2}) b: int32;")).toBe("@foo(#{k: 1; j: 2}) b: int32;\n");
  });
});

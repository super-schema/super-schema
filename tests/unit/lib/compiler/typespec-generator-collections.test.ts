import { describe, it, expect } from "vitest";
import { generateTypeSpec, generateTypeSpecWithSourceMap } from "@/lib/compiler/typespec-generator";
import { compileEntity } from "@/lib/compiler/compiler.service";
import type { PrismaEntityInput, PrismaFieldInput } from "@/lib/compiler/compiler.service";

/**
 * Collections of entities / enums (Epic 15 fix round): the element / value type
 * must resolve to the referenced entity or a generated enum — never the bare
 * logical-type words "reference" / "enum" (invalid TypeSpec).
 */

const ENTITY: PrismaEntityInput = {
  id: "entity-1",
  name: "Order",
  description: "",
  status: "DRAFT",
  version: 1,
  domainId: "domain-1",
  metadata: {},
  domain: { id: "domain-1", name: "Shop", slug: "shop" },
};

let fieldSeq = 0;
function field(name: string, type: string, decorators: Record<string, unknown>): PrismaFieldInput {
  return {
    id: `f-${++fieldSeq}`,
    name,
    type,
    precision: null,
    scale: null,
    nullable: false,
    isKey: false,
    fieldNumber: null,
    description: "",
    classification: null,
    aliases: [],
    decorators,
    sortOrder: fieldSeq,
  };
}

function generate(...fields: PrismaFieldInput[]): string {
  return generateTypeSpec(compileEntity(ENTITY, fields));
}

describe("TypeSpec generator — collections of entities and enums", () => {
  it("resolves an array of references to the referenced entity", () => {
    const source = generate(
      field("items", "array", { arrayElementType: "reference", referencedEntityName: "Order_LineItem" })
    );
    expect(source).toContain("items: Order_LineItem[];");
    expect(source).not.toContain("reference[]");
  });

  it("resolves a map of references to the referenced entity (map keeps referencedEntityName)", () => {
    const model = compileEntity(ENTITY, [
      field("items_by_sku", "map", {
        mapKeyType: "string",
        mapValueType: "reference",
        referencedEntityName: "LineItem",
      }),
    ]);
    expect(model.fields[0].complexType).toMatchObject({ referencedEntityName: "LineItem" });
    expect(generateTypeSpec(model)).toContain("items_by_sku: Record<LineItem>;");
  });

  it("generates an enum for an array / map of enum values and uses it as the element type", () => {
    const source = generate(
      field("kinds", "array", { arrayElementType: "enum", enumValues: ["PHYSICAL", "DIGITAL"] }),
      field("level_by_region", "map", { mapKeyType: "string", mapValueType: "enum", enumValues: ["LOW", "HIGH"] })
    );
    expect(source).toContain("kinds: Order_kinds[];");
    expect(source).toMatch(/enum Order_kinds \{\s+PHYSICAL,\s+DIGITAL,\s+\}/);
    expect(source).toContain("level_by_region: Record<Order_level_by_region>;");
    expect(source).toMatch(/enum Order_level_by_region \{\s+LOW,\s+HIGH,\s+\}/);
    expect(source).not.toContain("enum[]");
    expect(source).not.toContain("Record<enum>");
  });

  it("emits the collection enum in the source-map variant too", () => {
    const { source } = generateTypeSpecWithSourceMap(
      compileEntity(ENTITY, [field("kinds", "array", { arrayElementType: "enum", enumValues: ["A"] })])
    );
    expect(source).toContain("kinds: Order_kinds[];");
    expect(source).toContain("enum Order_kinds {");
  });

  it("falls back to string when the target is unknown", () => {
    const source = generate(
      field("refs", "array", { arrayElementType: "reference" }),
      field("flags", "array", { arrayElementType: "enum" }),
      field("lookup", "map", { mapKeyType: "string", mapValueType: "reference" })
    );
    expect(source).toContain("refs: string[];");
    expect(source).toContain("flags: string[];");
    expect(source).toContain("lookup: Record<string>;");
    expect(source).not.toMatch(/enum Order_flags/);
  });

  it("maps structured element types to valid TypeSpec", () => {
    const source = generate(
      field("blobs", "array", { arrayElementType: "object" }),
      field("bags", "map", { mapKeyType: "string", mapValueType: "object" })
    );
    expect(source).toContain("blobs: Record<unknown>[];");
    expect(source).toContain("bags: Record<Record<unknown>>;");
  });

  it("emits a string-keyed Record for non-string map keys (TypeSpec Record takes one argument)", () => {
    const source = generate(field("names_by_id", "map", { mapKeyType: "int32", mapValueType: "string" }));
    expect(source).toContain("names_by_id: Record<string>;");
  });

  it("keeps existing scalar collection outputs unchanged", () => {
    const source = generate(
      field("tags", "array", { arrayElementType: "string" }),
      field("scores", "array", { arrayElementType: "int32" }),
      field("attributes", "map", { mapKeyType: "string", mapValueType: "string" }),
      field("counts", "map", { mapKeyType: "string", mapValueType: "int64" })
    );
    expect(source).toContain("tags: string[];");
    expect(source).toContain("scores: int32[];");
    expect(source).toContain("attributes: Record<string>;");
    expect(source).toContain("counts: Record<int64>;");
  });
});

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { parseJsonSchemaDocument, parseJsonSchema } from "@/lib/importers/jsonschema.importer";
import type { MultiEntityImportResult, ParsedEntity } from "@/lib/importers/types";

const ORDER_SCHEMA = readFileSync(
  path.resolve(process.cwd(), "tests/fixtures/importers/order.schema.json"),
  "utf8"
);

function parseFixture(): MultiEntityImportResult {
  const result = parseJsonSchemaDocument(ORDER_SCHEMA);
  if (!result.success) throw new Error(result.error.message);
  return result.data;
}

function entity(doc: MultiEntityImportResult, name: string): ParsedEntity {
  const found = doc.entities.find((e) => e.name === name);
  if (!found) throw new Error(`entity ${name} missing; have ${doc.entities.map((e) => e.name)}`);
  return found;
}

function fieldOf(e: ParsedEntity, name: string) {
  const found = e.fields.find((f) => f.name === name);
  if (!found) throw new Error(`field ${e.name}.${name} missing`);
  return found;
}

describe("parseJsonSchemaDocument — $defs / $ref", () => {
  it("imports the root object plus every object $defs entry as entities, root first", () => {
    const doc = parseFixture();
    expect(doc.sourceFormat).toBe("json-schema");
    expect(doc.entities.map((e) => e.name)).toEqual(["Order", "Customer", "Address", "LineItem"]);
    expect(entity(doc, "Order").description).toBe("A customer order.");
    expect(entity(doc, "Customer").description).toBe("Who placed the order.");
    expect(entity(doc, "Customer").fields.map((f) => f.name)).toEqual(["id", "email", "addresses"]);
    expect(doc.entities.every((e) => e.sourceFormat === "json-schema" && e.originalContent === ORDER_SCHEMA)).toBe(true);
  });

  it("imports enum $defs as shared enums and links fields to them", () => {
    const doc = parseFixture();
    expect(doc.enums).toEqual([
      { name: "OrderStatus", values: ["PENDING", "PAID", "SHIPPED"], description: "Lifecycle of an order." },
    ]);
    expect(fieldOf(entity(doc, "Order"), "status")).toMatchObject({
      type: "enum",
      enumName: "OrderStatus",
      enumValues: ["PENDING", "PAID", "SHIPPED"],
      confidence: "high",
    });
    expect(fieldOf(entity(doc, "LineItem"), "status")).toMatchObject({ type: "enum", enumName: "OrderStatus" });
  });

  it("maps $ref to a defined entity as a high-confidence reference", () => {
    const order = entity(parseFixture(), "Order");
    expect(fieldOf(order, "customer")).toMatchObject({
      type: "reference",
      referencedEntityName: "Customer",
      confidence: "high",
      nullable: false,
      originalType: "#/$defs/Customer",
    });
    expect(fieldOf(order, "shipping_address")).toMatchObject({
      type: "reference",
      referencedEntityName: "Address",
      nullable: true,
    });
  });

  it("maps arrays of $ref to arrays of references", () => {
    const doc = parseFixture();
    expect(fieldOf(entity(doc, "Order"), "items")).toMatchObject({
      type: "array",
      arrayElementType: "reference",
      referencedEntityName: "LineItem",
      confidence: "high",
      constraints: [{ type: "minItems", value: 1 }],
    });
    expect(fieldOf(entity(doc, "Customer"), "addresses")).toMatchObject({
      type: "array",
      arrayElementType: "reference",
      referencedEntityName: "Address",
    });
  });

  it("inlines primitive $defs into the referencing field", () => {
    const doc = parseFixture();
    expect(fieldOf(entity(doc, "Order"), "contact_email")).toMatchObject({
      type: "string",
      format: "email",
      confidence: "high",
    });
    expect(fieldOf(entity(doc, "Customer"), "email")).toMatchObject({ type: "string", format: "email" });
  });

  it('resolves $ref "#" to the root entity', () => {
    expect(fieldOf(entity(parseFixture(), "Order"), "parent_order")).toMatchObject({
      type: "reference",
      referencedEntityName: "Order",
      confidence: "high",
    });
  });

  it("keeps inline enum values on the field", () => {
    expect(fieldOf(entity(parseFixture(), "Address"), "country")).toMatchObject({
      type: "enum",
      enumValues: ["US", "DE", "IN"],
    });
  });

  it("supports draft-07 `definitions`", () => {
    const result = parseJsonSchemaDocument(
      JSON.stringify({
        $schema: "http://json-schema.org/draft-07/schema#",
        title: "Invoice",
        type: "object",
        properties: { payer: { $ref: "#/definitions/Party" } },
        definitions: { Party: { type: "object", properties: { name: { type: "string" } } } },
      })
    );
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.entities.map((e) => e.name)).toEqual(["Invoice", "Party"]);
    expect(result.data.entities[0].fields[0]).toMatchObject({
      type: "reference",
      referencedEntityName: "Party",
      confidence: "high",
    });
  });

  it("imports a definitions-only bundle (no root properties)", () => {
    const result = parseJsonSchemaDocument(
      JSON.stringify({
        $defs: {
          Customer: { type: "object", properties: { id: { type: "string" } } },
          Address: { properties: { city: { type: "string" } } },
        },
      })
    );
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.entities.map((e) => e.name)).toEqual(["Customer", "Address"]);
  });

  it("keeps an unresolved $ref as a low-confidence reference by name", () => {
    const result = parseJsonSchemaDocument(
      JSON.stringify({ title: "Order", type: "object", properties: { owner: { $ref: "#/$defs/Owner" } } })
    );
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.entities).toHaveLength(1);
    expect(result.data.entities[0].fields[0]).toMatchObject({
      type: "reference",
      referencedEntityName: "Owner",
      confidence: "low",
    });
  });

  it("accepts a YAML JSON Schema document", () => {
    const yaml = [
      "title: Order",
      "type: object",
      "properties:",
      "  customer:",
      "    $ref: '#/$defs/Customer'",
      "$defs:",
      "  Customer:",
      "    type: object",
      "    properties:",
      "      id:",
      "        type: string",
    ].join("\n");
    const result = parseJsonSchemaDocument(yaml);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.entities.map((e) => e.name)).toEqual(["Order", "Customer"]);
  });

  it("still rejects a document without any object schema", () => {
    const result = parseJsonSchemaDocument(JSON.stringify({ type: "object", title: "Empty" }));
    expect(result.success).toBe(false);
  });
});

describe("parseJsonSchema (single-entity API)", () => {
  it("returns the root entity with resolved references", () => {
    const result = parseJsonSchema(ORDER_SCHEMA);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.name).toBe("Order");
    expect(result.data.fields.find((f) => f.name === "customer")).toMatchObject({
      referencedEntityName: "Customer",
      confidence: "high",
    });
  });
});

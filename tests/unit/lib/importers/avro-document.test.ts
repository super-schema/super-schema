import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { parseAvroDocument, parseAvroSchema } from "@/lib/importers/avro.importer";
import type { MultiEntityImportResult, ParsedEntity } from "@/lib/importers/types";

const ORDER_AVSC = readFileSync(
  path.resolve(process.cwd(), "tests/fixtures/importers/order.avsc"),
  "utf8"
);

function parseFixture(): MultiEntityImportResult {
  const result = parseAvroDocument(ORDER_AVSC);
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

describe("parseAvroDocument — nested named types", () => {
  it("turns every named record into an entity, in definition order, root first", () => {
    const doc = parseFixture();
    expect(doc.sourceFormat).toBe("avro");
    expect(doc.namespace).toBe("com.shop.orders");
    expect(doc.entities.map((e) => e.name)).toEqual(["Order", "Address", "LineItem"]);
    expect(entity(doc, "Order").description).toBe("A customer order.");
    expect(entity(doc, "Address").description).toBe("Postal address.");
    expect(entity(doc, "Address").fields.map((f) => f.name)).toEqual(["street", "city", "country"]);
    expect(doc.entities.every((e) => e.sourceFormat === "avro" && e.originalContent === ORDER_AVSC)).toBe(true);
  });

  it("turns named enums into shared enums and fixed into custom scalars", () => {
    const doc = parseFixture();
    expect(doc.enums).toEqual([
      { name: "OrderStatus", values: ["PENDING", "PAID", "SHIPPED"], description: "Lifecycle of an order." },
      { name: "Country", values: ["US", "DE", "IN"] },
    ]);
    expect(doc.scalars).toEqual([{ name: "MD5", baseType: "bytes", description: "Avro fixed (16 bytes)" }]);
  });

  it("maps an inline nested record to a reference field", () => {
    const order = entity(parseFixture(), "Order");
    expect(fieldOf(order, "shipping_address")).toMatchObject({
      type: "reference",
      referencedEntityName: "Address",
      confidence: "high",
      nullable: false,
      originalType: "record(com.shop.orders.Address)",
    });
  });

  it("resolves later uses by short name and by full name to the first definition", () => {
    const order = entity(parseFixture(), "Order");
    expect(fieldOf(order, "billing_address")).toMatchObject({
      type: "reference",
      referencedEntityName: "Address",
      nullable: true,
      confidence: "high",
    });
    expect(fieldOf(order, "previous_status")).toMatchObject({
      type: "enum",
      enumName: "OrderStatus",
      enumValues: ["PENDING", "PAID", "SHIPPED"],
      nullable: true,
    });
    expect(fieldOf(order, "home_country")).toMatchObject({ type: "enum", enumName: "Country" });
    expect(fieldOf(order, "signature")).toMatchObject({
      type: "bytes",
      confidence: "high",
      governance: { avroFixedSize: 16 },
    });
  });

  it("maps enum, array-of-record and map-of-record fields with their targets", () => {
    const doc = parseFixture();
    const order = entity(doc, "Order");
    expect(fieldOf(order, "status")).toMatchObject({
      type: "enum",
      enumName: "OrderStatus",
      enumValues: ["PENDING", "PAID", "SHIPPED"],
      confidence: "high",
    });
    expect(fieldOf(order, "items")).toMatchObject({
      type: "array",
      arrayElementType: "reference",
      referencedEntityName: "LineItem",
      confidence: "high",
    });
    expect(fieldOf(order, "items_by_sku")).toMatchObject({
      type: "map",
      mapKeyType: "string",
      mapValueType: "reference",
      referencedEntityName: "LineItem",
      confidence: "high",
    });
    expect(fieldOf(entity(doc, "Address"), "country")).toMatchObject({ type: "enum", enumName: "Country" });
    expect(fieldOf(entity(doc, "LineItem"), "checksum")).toMatchObject({
      type: "bytes",
      governance: { avroFixedSize: 16 },
      originalType: "fixed(MD5,16)",
    });
    expect(fieldOf(order, "created_at")).toMatchObject({ type: "utcDateTime", confidence: "high" });
  });

  it("maps arrays and maps of primitives with their element / value types", () => {
    const result = parseAvroDocument(
      JSON.stringify({
        type: "record",
        name: "Tags",
        fields: [
          { name: "names", type: { type: "array", items: "string" } },
          { name: "counts", type: { type: "map", values: "long" } },
        ],
      })
    );
    expect(result.success).toBe(true);
    if (!result.success) return;
    const [names, counts] = result.data.entities[0].fields;
    expect(names).toMatchObject({ type: "array", arrayElementType: "string", confidence: "high" });
    expect(counts).toMatchObject({ type: "map", mapKeyType: "string", mapValueType: "int64", confidence: "high" });
  });

  it("imports a named type the document does not define as a low-confidence reference with a warning", () => {
    const result = parseAvroDocument(
      JSON.stringify({
        type: "record",
        name: "Order",
        namespace: "com.shop",
        fields: [{ name: "customer", type: "com.shop.crm.Customer" }],
      })
    );
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.entities[0].fields[0]).toMatchObject({
      type: "reference",
      referencedEntityName: "Customer",
      confidence: "low",
    });
    expect(result.data.warnings.some((w) => w.includes("com.shop.crm.Customer"))).toBe(true);
  });

  it("qualifies a record whose short name clashes with one from another namespace", () => {
    const result = parseAvroDocument(
      JSON.stringify({
        type: "record",
        name: "Order",
        namespace: "com.shop",
        fields: [
          { name: "a", type: { type: "record", name: "Address", fields: [{ name: "x", type: "string" }] } },
          {
            name: "b",
            type: {
              type: "record",
              name: "Address",
              namespace: "com.billing",
              fields: [{ name: "y", type: "string" }],
            },
          },
        ],
      })
    );
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.entities.map((e) => e.name)).toEqual(["Order", "Address", "com_billing_Address"]);
    expect(result.data.entities[0].fields[1].referencedEntityName).toBe("com_billing_Address");
    expect(result.data.warnings.some((w) => w.includes("com.billing.Address"))).toBe(true);
  });

  it("supports a record that references itself", () => {
    const result = parseAvroDocument(
      JSON.stringify({
        type: "record",
        name: "Node",
        fields: [{ name: "next", type: ["null", "Node"] }],
      })
    );
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.entities).toHaveLength(1);
    expect(result.data.entities[0].fields[0]).toMatchObject({
      type: "reference",
      referencedEntityName: "Node",
      nullable: true,
    });
  });
});

describe("parseAvroSchema (single-entity API)", () => {
  it("returns the root record", () => {
    const result = parseAvroSchema(ORDER_AVSC);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.name).toBe("Order");
    expect(result.data.fields).toHaveLength(10);
  });
});

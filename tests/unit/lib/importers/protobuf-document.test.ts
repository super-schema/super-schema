import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { parseProtobufDocument, parseProtobufSchema } from "@/lib/importers/protobuf.importer";
import type { MultiEntityImportResult, ParsedEntity } from "@/lib/importers/types";

const ORDER_PROTO = readFileSync(
  path.resolve(process.cwd(), "tests/fixtures/importers/order.proto"),
  "utf8"
);

function parseFixture(): MultiEntityImportResult {
  const result = parseProtobufDocument(ORDER_PROTO);
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

describe("parseProtobufDocument (protobufjs)", () => {
  describe("assets", () => {
    it("imports every top-level and nested message as an entity, nested named Outer_Inner", () => {
      const doc = parseFixture();
      expect(doc.sourceFormat).toBe("protobuf");
      expect(doc.namespace).toBe("shop.orders.v1");
      expect(doc.entities.map((e) => e.name)).toEqual(["Order", "Order_LineItem", "Card", "Customer"]);
      expect(doc.entities.every((e) => e.sourceFormat === "protobuf")).toBe(true);
      expect(doc.entities.every((e) => e.originalContent === ORDER_PROTO)).toBe(true);
    });

    it("imports top-level and nested enums as shared enums with their values and comments", () => {
      const doc = parseFixture();
      expect(doc.enums).toEqual([
        {
          name: "OrderStatus",
          values: ["ORDER_STATUS_UNSPECIFIED", "PENDING", "PAID", "SHIPPED"],
          description: "Lifecycle of an order.",
        },
        { name: "Order_LineItem_Kind", values: ["KIND_UNSPECIFIED", "PHYSICAL", "DIGITAL"] },
      ]);
      expect(doc.scalars).toEqual([]);
    });

    it("uses message doc comments as entity descriptions", () => {
      const doc = parseFixture();
      expect(entity(doc, "Order").description).toBe("A customer order.");
      expect(entity(doc, "Order_LineItem").description).toBe("One purchasable line.");
    });

    it("names deeper nesting by the full nesting path", () => {
      const result = parseProtobufDocument(
        `syntax = "proto3";\nmessage A { message B { message C { string x = 1; } C c = 1; } B b = 1; }`
      );
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.entities.map((e) => e.name)).toEqual(["A", "A_B", "A_B_C"]);
      expect(fieldOf(result.data.entities[1], "c")).toMatchObject({
        type: "reference",
        referencedEntityName: "A_B_C",
      });
    });
  });

  describe("fields", () => {
    it("keeps field names, numbers and trailing comments", () => {
      const order = entity(parseFixture(), "Order");
      expect(order.fields.map((f) => [f.name, f.fieldNumber])).toEqual([
        ["id", 1],
        ["status", 2],
        ["items", 3],
        ["labels", 4],
        ["created_at", 5],
        ["fulfillment_sla", 6],
        ["tags", 7],
        ["card", 8],
        ["voucher_code", 9],
        ["note", 10],
        ["gift_message", 11],
        ["items_by_sku", 12],
        ["customer", 13],
      ]);
      expect(fieldOf(order, "id")).toMatchObject({
        type: "string",
        confidence: "high",
        description: "Order identifier",
        nullable: true,
      });
    });

    it("maps enum-typed fields to enum with the shared enum name and values", () => {
      const doc = parseFixture();
      expect(fieldOf(entity(doc, "Order"), "status")).toMatchObject({
        type: "enum",
        enumName: "OrderStatus",
        enumValues: ["ORDER_STATUS_UNSPECIFIED", "PENDING", "PAID", "SHIPPED"],
        confidence: "high",
      });
      expect(fieldOf(entity(doc, "Order_LineItem"), "kind")).toMatchObject({
        type: "enum",
        enumName: "Order_LineItem_Kind",
      });
    });

    it("maps repeated fields to arrays with their element type", () => {
      const order = entity(parseFixture(), "Order");
      expect(fieldOf(order, "items")).toMatchObject({
        type: "array",
        arrayElementType: "reference",
        referencedEntityName: "Order_LineItem",
        confidence: "high",
      });
      expect(fieldOf(order, "tags")).toMatchObject({
        type: "array",
        arrayElementType: "string",
        confidence: "high",
      });
    });

    it("maps map<K,V> to the map logical type with key and value types", () => {
      const order = entity(parseFixture(), "Order");
      expect(fieldOf(order, "labels")).toMatchObject({
        type: "map",
        mapKeyType: "string",
        mapValueType: "string",
        confidence: "high",
        originalType: "map<string, string>",
      });
      expect(fieldOf(order, "items_by_sku")).toMatchObject({
        type: "map",
        mapKeyType: "string",
        mapValueType: "reference",
        referencedEntityName: "Order_LineItem",
      });
    });

    it("records oneof membership, but not for proto3 `optional` synthetic oneofs", () => {
      const order = entity(parseFixture(), "Order");
      expect(fieldOf(order, "card")).toMatchObject({
        type: "reference",
        referencedEntityName: "Card",
        governance: { protobufOneofGroup: "payment" },
      });
      expect(fieldOf(order, "voucher_code").governance).toEqual({ protobufOneofGroup: "payment" });
      expect(fieldOf(order, "note").governance).toBeUndefined();
      expect(fieldOf(order, "note").nullable).toBe(true);
    });

    it("maps well-known types to temporal / wrapped logical types", () => {
      const order = entity(parseFixture(), "Order");
      expect(fieldOf(order, "created_at")).toMatchObject({ type: "utcDateTime", confidence: "high" });
      expect(fieldOf(order, "fulfillment_sla")).toMatchObject({ type: "duration", confidence: "high" });
      expect(fieldOf(order, "gift_message")).toMatchObject({
        type: "string",
        nullable: true,
        confidence: "high",
        originalType: "google.protobuf.StringValue",
      });
    });

    it("resolves cross-message references, including qualified nested names", () => {
      const doc = parseFixture();
      expect(fieldOf(entity(doc, "Order"), "customer")).toMatchObject({
        type: "reference",
        referencedEntityName: "Customer",
        confidence: "high",
      });
      expect(fieldOf(entity(doc, "Card"), "last_item")).toMatchObject({
        type: "reference",
        referencedEntityName: "Order_LineItem",
      });
    });

    it("imports a type from an unresolved import as a low-confidence reference with a warning", () => {
      const doc = parseFixture();
      expect(fieldOf(entity(doc, "Order_LineItem"), "unit_price")).toMatchObject({
        type: "reference",
        referencedEntityName: "Money",
        confidence: "low",
        originalType: "shop.common.v1.Money",
      });
      expect(doc.warnings.some((w) => w.includes("shop.common.v1.Money"))).toBe(true);
    });

    it("honours proto2 labels for nullability", () => {
      const result = parseProtobufDocument(
        `syntax = "proto2";\nmessage M { required string a = 1; optional string b = 2; repeated string c = 3; }`
      );
      expect(result.success).toBe(true);
      if (!result.success) return;
      const [a, b, c] = result.data.entities[0].fields;
      expect(a.nullable).toBe(false);
      expect(b.nullable).toBe(true);
      expect(c.nullable).toBe(false);
    });
  });

  describe("warnings", () => {
    it("collects services/rpcs as not imported (gRPC is a later story)", () => {
      const doc = parseFixture();
      const serviceWarning = doc.warnings.find((w) => w.includes("OrderService"));
      expect(serviceWarning).toBeDefined();
      expect(serviceWarning).toContain("2 rpc");
    });

    it("notes non-well-known imports but not google/protobuf ones", () => {
      const doc = parseFixture();
      expect(doc.warnings.some((w) => w.includes("shop/common/v1/money.proto"))).toBe(true);
      expect(doc.warnings.some((w) => w.includes("google/protobuf"))).toBe(false);
    });
  });

  describe("errors", () => {
    it("reports syntax errors as PARSE_ERROR with the parser's location", () => {
      const result = parseProtobufDocument(`syntax = "proto3";\nmessage { broken`);
      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error.code).toBe("PARSE_ERROR");
      expect(result.error.message).toContain("line 2");
    });

    it("requires at least one message", () => {
      const result = parseProtobufDocument(`syntax = "proto3";\nenum Status { ACTIVE = 0; }`);
      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error.code).toBe("PARSE_ERROR");
    });
  });
});

describe("parseProtobufSchema (single-entity API)", () => {
  it("returns the document's first top-level message with fully resolved fields", () => {
    const result = parseProtobufSchema(ORDER_PROTO);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.name).toBe("Order");
    expect(result.data.fields).toHaveLength(13);
    expect(result.data.fields.find((f) => f.name === "items")).toMatchObject({
      referencedEntityName: "Order_LineItem",
    });
  });
});

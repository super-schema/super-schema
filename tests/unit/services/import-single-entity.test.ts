import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { importSchema, bulkImport } from "@/services/import.service";
import { parseProtobufSchema } from "@/lib/importers/protobuf.importer";
import { parseAvroSchema } from "@/lib/importers/avro.importer";
import { parseJsonSchema } from "@/lib/importers/jsonschema.importer";

function fixture(name: string): string {
  return readFileSync(path.resolve(process.cwd(), "tests/fixtures/importers", name), "utf8");
}

describe("single-entity import of a multi-entity document", () => {
  it("forwards the document warnings and names the sibling entities it did not import", () => {
    const r = importSchema(fixture("order.proto"), "protobuf");
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.parsedEntity.name).toBe("Order");
    expect(r.data.warnings).toContain(
      "3 additional entities (Order_LineItem, Card, Customer) were not imported — use the multi-asset import"
    );
    expect(r.data.warnings.some((w) => w.includes("OrderService"))).toBe(true);
    expect(r.data.warnings.some((w) => w.includes("shop/common/v1/money.proto"))).toBe(true);
    // low-confidence notes are still added
    expect(r.data.warnings.some((w) => w.includes("low confidence"))).toBe(false); // root has none
  });

  it("uses the singular for one sibling", () => {
    const r = importSchema(
      JSON.stringify({
        type: "record",
        name: "Order",
        fields: [{ name: "a", type: { type: "record", name: "Address", fields: [{ name: "x", type: "string" }] } }],
      }),
      "avro"
    );
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.warnings).toContain(
      "1 additional entity (Address) was not imported — use the multi-asset import"
    );
  });

  it("adds no sibling warning for a single-entity document", () => {
    const r = importSchema(`syntax = "proto3";\nmessage User { string id = 1; }`, "protobuf");
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.warnings).toEqual([]);
  });

  it("bulk import reports the dropped siblings and document warnings per file", () => {
    const r = bulkImport([
      { content: fixture("order.avsc"), filename: "order.avsc" },
      { content: fixture("order.schema.json"), filename: "order.schema.json" },
    ]);
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.parsed.map((e) => e.name)).toEqual(["Order", "Order"]);
    expect(r.data.warnings).toContain(
      "order.avsc — 2 additional entities (Address, LineItem) were not imported — use the multi-asset import"
    );
    expect(r.data.warnings).toContain(
      "order.schema.json — 3 additional entities (Customer, Address, LineItem) were not imported — use the multi-asset import"
    );
  });
});

describe("root entity selection (deterministic)", () => {
  it("protobuf: the first top-level message no other message references", () => {
    const r = parseProtobufSchema(
      `syntax = "proto3";\nmessage Address { string city = 1; }\nmessage Order { Address shipping = 1; }`
    );
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.name).toBe("Order");
  });

  it("protobuf: falls back to the first message when every message is referenced", () => {
    const r = parseProtobufSchema(
      `syntax = "proto3";\nmessage A { B b = 1; }\nmessage B { A a = 1; }`
    );
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.name).toBe("A");
  });

  it("Avro: always the schema's root record, even when a nested record points back at it", () => {
    const r = parseAvroSchema(
      JSON.stringify({
        type: "record",
        name: "Order",
        fields: [
          {
            name: "lines",
            type: {
              type: "array",
              items: { type: "record", name: "Line", fields: [{ name: "order", type: ["null", "Order"] }] },
            },
          },
        ],
      })
    );
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.name).toBe("Order");
  });

  it("JSON Schema: the root object, or the unreferenced definition of a definitions-only bundle", () => {
    const rooted = parseJsonSchema(fixture("order.schema.json"));
    expect(rooted.success && rooted.data.name).toBe("Order");

    const bundle = parseJsonSchema(
      JSON.stringify({
        $defs: {
          Address: { type: "object", properties: { city: { type: "string" } } },
          Customer: { type: "object", properties: { address: { $ref: "#/$defs/Address" } } },
        },
      })
    );
    expect(bundle.success).toBe(true);
    if (!bundle.success) return;
    expect(bundle.data.name).toBe("Customer");
  });
});

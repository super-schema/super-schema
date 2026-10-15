import { describe, it, expect } from "vitest";
import { inlineJsonSchemaBundle } from "@/lib/events/json-schema-bundle";

const S = "https://json-schema.org/draft/2020-12/schema";

describe("inlineJsonSchemaBundle", () => {
  it("turns an @typespec/json-schema bundle into one schema with local $defs (no file refs)", () => {
    const bundle = {
      $schema: S, $id: "Order",
      $defs: {
        Order: {
          $schema: S, $id: "Order.json", type: "object",
          properties: { id: { type: "string" }, address: { $ref: "Address.json" }, parent: { $ref: "Order.json" } },
          required: ["id", "address"],
        },
        Address: { $schema: S, $id: "Address.json", type: "object", properties: { street: { type: "string" }, alias: { $ref: "#/properties/street" } } },
      },
    };
    expect(inlineJsonSchemaBundle(bundle, "Order")).toEqual({
      success: true,
      data: {
        $schema: S, type: "object",
        properties: { id: { type: "string" }, address: { $ref: "#/$defs/Address" }, parent: { $ref: "#" } },
        required: ["id", "address"],
        $defs: { Address: { type: "object", properties: { street: { type: "string" }, alias: { $ref: "#/$defs/Address/properties/street" } } } },
      },
    });
  });

  it("accepts a single non-bundled schema and rejects unknown refs or a missing root", () => {
    expect(inlineJsonSchemaBundle({ $schema: S, $id: "Order.json", type: "object", properties: {} }, "Order")).toEqual({
      success: true, data: { $schema: S, type: "object", properties: {} },
    });
    const unknown = inlineJsonSchemaBundle({ $id: "Order", $defs: { Order: { type: "object", properties: { x: { $ref: "Missing.json" } } } } }, "Order");
    expect(!unknown.success && unknown.error.code).toBe("SCHEMA_BUNDLE_UNRESOLVED");
    const noRoot = inlineJsonSchemaBundle({ $id: "Order", $defs: { Other: { type: "object" } } }, "Order");
    expect(!noRoot.success && noRoot.error.code).toBe("ROOT_SCHEMA_NOT_FOUND");
  });
});

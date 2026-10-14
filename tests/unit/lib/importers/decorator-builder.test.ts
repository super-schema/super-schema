import { describe, it, expect } from "vitest";
import { buildDecoratorsFromParsedField } from "@/lib/importers/decorator-builder";
import type { ParsedField } from "@/lib/importers/types";

function field(overrides: Partial<ParsedField>): ParsedField {
  return {
    name: "f",
    type: "string",
    nullable: true,
    confidence: "high",
    originalType: "string",
    ...overrides,
  };
}

describe("buildDecoratorsFromParsedField — multi-entity import metadata", () => {
  it("stores map key/value types where compiler.service reads them", () => {
    const decorators = buildDecoratorsFromParsedField(
      field({ type: "map", mapKeyType: "string", mapValueType: "int64" })
    );
    expect(decorators.mapKeyType).toBe("string");
    expect(decorators.mapValueType).toBe("int64");
  });

  it("stores a map of references with its target entity", () => {
    const decorators = buildDecoratorsFromParsedField(
      field({
        type: "map",
        mapKeyType: "string",
        mapValueType: "reference",
        referencedEntityName: "Order_LineItem",
      })
    );
    expect(decorators).toMatchObject({
      mapKeyType: "string",
      mapValueType: "reference",
      referencedEntityName: "Order_LineItem",
    });
  });

  it("links an enum field to its shared enum and carries the values in the generator's pattern slot", () => {
    const decorators = buildDecoratorsFromParsedField(
      field({ type: "enum", enumName: "OrderStatus", enumValues: ["PENDING", "SHIPPED"] })
    );
    expect(decorators.enumName).toBe("OrderStatus");
    expect(decorators.typespec).toMatchObject({ validation: { pattern: "PENDING|SHIPPED" } });
  });

  it("does not overwrite an explicit pattern constraint with enum values", () => {
    const decorators = buildDecoratorsFromParsedField(
      field({
        type: "enum",
        enumValues: ["A", "B"],
        constraints: [{ type: "pattern", value: "X|Y" }],
      })
    );
    expect(decorators.typespec).toMatchObject({ validation: { pattern: "X|Y" } });
  });

  it("writes governance (protobuf field number + oneof group, Avro fixed size)", () => {
    const decorators = buildDecoratorsFromParsedField(
      field({ fieldNumber: 6, governance: { protobufOneofGroup: "payment" } })
    );
    expect(decorators.governance).toEqual({ protobufFieldNumber: 6, protobufOneofGroup: "payment" });

    const fixed = buildDecoratorsFromParsedField(
      field({ type: "bytes", governance: { avroFixedSize: 16 } })
    );
    expect(fixed.governance).toEqual({ avroFixedSize: 16 });
  });

  it("adds no new keys for a plain field", () => {
    const decorators = buildDecoratorsFromParsedField(field({}));
    expect(decorators).toEqual({});
  });
});

import { describe, it, expect } from "vitest";
import { dedupeAvroNamedTypes } from "@/lib/events/avro-named-types";

const address = { type: "record", name: "Address", fields: [{ name: "street", type: "string" }] };

describe("dedupeAvroNamedTypes", () => {
  it("keeps the first definition of a doubly used record and refers to it by full name afterwards", () => {
    const r = dedupeAvroNamedTypes({
      type: "record", name: "Order", namespace: "com.acme",
      fields: [
        { name: "billing", type: address },
        { name: "shipping", type: address },
        { name: "past", type: ["null", address], default: null },
        { name: "all", type: { type: "array", items: address } },
        { name: "byKey", type: { type: "map", values: address } },
      ],
    });
    expect(r).toEqual({
      success: true,
      data: {
        type: "record", name: "Order", namespace: "com.acme",
        fields: [
          { name: "billing", type: address },
          { name: "shipping", type: "com.acme.Address" },
          { name: "past", type: ["null", "com.acme.Address"], default: null },
          { name: "all", type: { type: "array", items: "com.acme.Address" } },
          { name: "byKey", type: { type: "map", values: "com.acme.Address" } },
        ],
      },
    });
  });

  it("dedupes enums, including ones nested inside a record that is itself defined once", () => {
    const status = { type: "enum", name: "Status", symbols: ["A", "B"] };
    const line = { type: "record", name: "Line", fields: [{ name: "status", type: status }] };
    const r = dedupeAvroNamedTypes({
      type: "record", name: "Order", namespace: "n",
      fields: [{ name: "status", type: status }, { name: "line", type: line }, { name: "again", type: line }],
    });
    expect(r.success && r.data.fields).toEqual([
      { name: "status", type: status },
      { name: "line", type: { type: "record", name: "Line", fields: [{ name: "status", type: "n.Status" }] } },
      { name: "again", type: "n.Line" },
    ]);
  });

  it("resolves a nested record's namespace from its enclosing record, and honours explicit namespaces and dotted names", () => {
    const r = dedupeAvroNamedTypes({
      type: "record", name: "Order", namespace: "a.b",
      fields: [
        { name: "x", type: { type: "record", name: "Thing", fields: [] } },
        { name: "y", type: { type: "record", name: "Thing", namespace: "other", fields: [] } },
        { name: "z", type: { type: "record", name: "a.b.Thing", fields: [] } },
        { name: "w", type: { type: "record", name: "Thing", fields: [] } },
      ],
    });
    expect(r.success && (r.data.fields as Array<{ type: unknown }>).map((f) => f.type)).toEqual([
      { type: "record", name: "Thing", fields: [] },
      { type: "record", name: "Thing", namespace: "other", fields: [] },
      "a.b.Thing",
      "a.b.Thing",
    ]);
  });

  it("leaves a schema without repeated named types untouched and does not mutate its input", () => {
    const input = { type: "record", name: "Order", namespace: "n", fields: [{ name: "a", type: address }, { name: "t", type: { type: "long", logicalType: "timestamp-millis" } }] };
    const copy = structuredClone(input);
    expect(dedupeAvroNamedTypes(input)).toEqual({ success: true, data: copy });
    expect(input).toEqual(copy);
  });

  it("refuses two different definitions of the same full name (cannot be expressed as a reference)", () => {
    const other = { type: "record", name: "Address", fields: [{ name: "line1", type: "string" }] };
    const r = dedupeAvroNamedTypes({
      type: "record", name: "Order", namespace: "n",
      fields: [{ name: "a", type: address }, { name: "b", type: other }],
    });
    expect(!r.success && r.error.code).toBe("AVRO_NAME_CONFLICT");
    expect(!r.success && r.error.details).toEqual({ names: ["n.Address"] });
  });
});

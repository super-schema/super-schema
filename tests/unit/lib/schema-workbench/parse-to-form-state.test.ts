import { describe, expect, it } from "vitest";
import { parseToFormState } from "@/lib/schema-workbench/parse-to-form-state";
import { serializeFormState, type FormState } from "@/lib/schema-workbench/form-state";

function roundTrip(state: FormState) {
  const text = serializeFormState(state);
  expect(text).not.toBeNull();
  const parsed = parseToFormState(state.format, text as string);
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) throw new Error(parsed.reason);
  expect(serializeFormState(parsed.state)).toBe(text);
  return parsed.state;
}

describe("parseToFormState — JSON Schema round-trip", () => {
  it("recovers every field kind the form can build", () => {
    const state = roundTrip({
      format: "json-schema",
      title: "Customer",
      description: "A customer",
      fields: [
        { id: "1", name: "email", type: "string", required: true, description: "Email", format: "email", minLength: 3, maxLength: 80, pattern: "^.+@.+$" },
        { id: "2", name: "age", type: "integer", required: false, description: "", minimum: 0, maximum: 150, exclusiveMinimum: -1, exclusiveMaximum: 151, multipleOf: 1 },
        { id: "3", name: "tags", type: "array", required: false, description: "", itemsType: "string", minItems: 0, maxItems: 5, uniqueItems: true },
        { id: "4", name: "orders", type: "array", required: false, description: "", itemsType: "reference", itemsRefTarget: "Order" },
        { id: "5", name: "address", type: "reference", required: true, description: "", refTarget: "Address" },
        { id: "6", name: "tier", type: "string", required: true, description: "", enumValues: ["gold", "silver"], defaultValue: "silver", constValue: "gold" },
        { id: "7", name: "legacy", type: "boolean", required: false, description: "", deprecated: true, readOnly: true, writeOnly: true },
        { id: "8", name: "meta", type: "object", required: false, description: "" },
        { id: "9", name: "count", type: "number", required: false, description: "", defaultValue: "3" },
      ],
    });
    expect(state.format).toBe("json-schema");
    if (state.format !== "json-schema") return;
    expect(state.title).toBe("Customer");
    expect(state.fields.map((f) => f.name)).toEqual(["email", "age", "tags", "orders", "address", "tier", "legacy", "meta", "count"]);
    expect(state.fields[4]).toMatchObject({ type: "reference", refTarget: "Address", required: true });
    expect(state.fields[3]).toMatchObject({ itemsType: "reference", itemsRefTarget: "Order" });
    expect(state.fields[1].required).toBe(false);
  });

  it("rejects what the form cannot express", () => {
    const base = (props: object) =>
      JSON.stringify({ title: "T", type: "object", properties: props });
    expect(parseToFormState("json-schema", "{ nope").ok).toBe(false);
    expect(parseToFormState("json-schema", "[]").ok).toBe(false);
    expect(parseToFormState("json-schema", JSON.stringify({ type: "object", properties: {} })).ok).toBe(false);
    expect(parseToFormState("json-schema", base({ a: { type: "object", properties: { b: { type: "string" } } } })).ok).toBe(false);
    expect(parseToFormState("json-schema", base({ a: { type: "string", oneOf: [] } })).ok).toBe(false);
    expect(parseToFormState("json-schema", base({ a: { type: ["string", "null"] } })).ok).toBe(false);
    expect(
      parseToFormState("json-schema", JSON.stringify({ title: "T", type: "object", properties: {}, required: ["x"] })).ok
    ).toBe(false);
  });

  it("reports a reason", () => {
    const r = parseToFormState("json-schema", "{ nope");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/json/i);
  });
});

describe("parseToFormState — Avro round-trip", () => {
  it("recovers primitives, logical, structured and reference fields", () => {
    const state = roundTrip({
      format: "avro",
      name: "Customer",
      namespace: "com.acme",
      doc: "A customer",
      fields: [
        { id: "1", name: "id", type: "long", nullable: false, doc: "pk" },
        { id: "2", name: "nick", type: "string", nullable: true, doc: "", defaultValue: "anon" },
        { id: "3", name: "born", type: "date", nullable: false, doc: "" },
        { id: "4", name: "price", type: "decimal", nullable: false, doc: "", precision: 12, scale: 4 },
        { id: "5", name: "kind", type: "enum", nullable: false, doc: "", enumName: "Kind", symbols: ["A", "B"] },
        { id: "6", name: "tags", type: "array", nullable: false, doc: "", itemsType: "string" },
        { id: "7", name: "attrs", type: "map", nullable: false, doc: "", valuesType: "reference", valuesRefTarget: "Attr" },
        { id: "8", name: "hash", type: "fixed", nullable: false, doc: "", fixedName: "Hash", fixedSize: 8 },
        { id: "9", name: "span", type: "duration", nullable: false, doc: "" },
        { id: "10", name: "owner", type: "reference", nullable: false, doc: "", refTarget: "com.acme.Owner", aliases: ["boss"], order: "descending" },
        { id: "11", name: "ts", type: "timestamp-micros", nullable: true, doc: "" },
        { id: "12", name: "uid", type: "uuid", nullable: false, doc: "" },
      ],
    });
    if (state.format !== "avro") throw new Error("format");
    expect(state.namespace).toBe("com.acme");
    expect(state.fields[1]).toMatchObject({ nullable: true, type: "string", defaultValue: "anon" });
    expect(state.fields[3]).toMatchObject({ type: "decimal", precision: 12, scale: 4 });
    expect(state.fields[6]).toMatchObject({ type: "map", valuesType: "reference", valuesRefTarget: "Attr" });
    expect(state.fields[9]).toMatchObject({ aliases: ["boss"], order: "descending", type: "reference" });
  });

  it("rejects what the form cannot express", () => {
    const rec = (field: object) => JSON.stringify({ type: "record", name: "R", fields: [field] });
    expect(parseToFormState("avro", "nope").ok).toBe(false);
    expect(parseToFormState("avro", JSON.stringify({ type: "enum", name: "E", symbols: [] })).ok).toBe(false);
    expect(parseToFormState("avro", rec({ name: "a", type: ["null", "string", "int"] })).ok).toBe(false);
    expect(parseToFormState("avro", rec({ name: "a", type: { type: "record", name: "N", fields: [] } })).ok).toBe(false);
    expect(parseToFormState("avro", rec({ name: "a", type: "string", extra: 1 })).ok).toBe(false);
  });
});

describe("parseToFormState — Protobuf round-trip", () => {
  it("recovers scalars, repeated, map, reference and oneof groups", () => {
    const state = roundTrip({
      format: "protobuf",
      name: "Order",
      packageName: "acme.orders",
      fields: [
        { id: "1", name: "id", type: "string", fieldNumber: 1, repeated: false, doc: "pk" },
        { id: "2", name: "lines", type: "int32", fieldNumber: 2, repeated: true, doc: "" },
        { id: "3", name: "placed", type: "google.protobuf.Timestamp", fieldNumber: 3, repeated: false, doc: "" },
        { id: "4", name: "customer", type: "reference", fieldNumber: 4, repeated: false, doc: "", refTarget: "Customer" },
        { id: "5", name: "labels", type: "map", fieldNumber: 5, repeated: false, doc: "", mapKeyType: "string", mapValueType: "string" },
        { id: "6", name: "refs", type: "map", fieldNumber: 6, repeated: false, doc: "", mapKeyType: "int64", mapValueType: "reference", mapValueRefTarget: "Ref" },
        { id: "7", name: "card", type: "string", fieldNumber: 7, repeated: false, doc: "", oneofGroup: "payment" },
        { id: "8", name: "iban", type: "string", fieldNumber: 8, repeated: false, doc: "bank", oneofGroup: "payment" },
      ],
    });
    if (state.format !== "protobuf") throw new Error("format");
    expect(state.packageName).toBe("acme.orders");
    expect(state.fields.find((f) => f.name === "lines")?.repeated).toBe(true);
    expect(state.fields.find((f) => f.name === "iban")).toMatchObject({ oneofGroup: "payment", doc: "bank" });
    expect(state.fields.find((f) => f.name === "refs")).toMatchObject({ mapKeyType: "int64", mapValueType: "reference", mapValueRefTarget: "Ref" });
  });

  it("rejects what the form cannot express", () => {
    expect(parseToFormState("protobuf", "message A { string id = 1; }").ok).toBe(false);
    expect(
      parseToFormState("protobuf", 'syntax = "proto3";\nimport "x.proto";\nmessage A {\n  string id = 1;\n}\n').ok
    ).toBe(false);
    expect(
      parseToFormState("protobuf", 'syntax = "proto3";\nmessage A {\n  message B {\n  }\n  string id = 1;\n}\n').ok
    ).toBe(false);
    expect(
      parseToFormState("protobuf", 'syntax = "proto3";\nmessage A {\n  string id = 1;\n}\nmessage B {\n  string id = 1;\n}\n').ok
    ).toBe(false);
    expect(parseToFormState("protobuf", 'syntax = "proto3";\nmessage A {\n  string id = 1;\n').ok).toBe(false);
  });
});

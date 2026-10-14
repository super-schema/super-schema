import { describe, it, expect } from "vitest";
import {
  buildProtoDocument,
  nextFieldNumber,
  type ProtoField,
} from "@/components/custom/VisualSchemaBuilder/protobuf-serialize";
import { parseProtobufSchema } from "@/lib/importers/protobuf.importer";

function field(partial: Partial<ProtoField>): ProtoField {
  return {
    id: Math.random().toString(36),
    name: "f",
    type: "string",
    fieldNumber: 1,
    repeated: false,
    doc: "",
    ...partial,
  };
}

describe("VisualSchemaBuilder protobuf-serialize", () => {
  it("returns null until a message name + a named field exist", () => {
    expect(buildProtoDocument("", "", [field({ name: "a" })])).toBeNull();
    expect(buildProtoDocument("Order", "", [field({ name: "" })])).toBeNull();
    expect(buildProtoDocument("Order", "", [field({ name: "a" })])).not.toBeNull();
  });

  it("emits proto3 syntax + optional package + message block", () => {
    const text = buildProtoDocument("Order", "com.example", [
      field({ name: "id", fieldNumber: 1 }),
    ]) as string;
    expect(text).toContain('syntax = "proto3";');
    expect(text).toContain("package com.example;");
    expect(text).toContain("message Order {");
    expect(text).toContain("string id = 1;");
  });

  it("omits the package line when no namespace is set", () => {
    const text = buildProtoDocument("Order", "", [field({ name: "id" })]) as string;
    expect(text).not.toContain("package");
  });

  it("repeated fields get the repeated modifier", () => {
    const text = buildProtoDocument("Order", "", [
      field({ name: "tags", type: "string", repeated: true, fieldNumber: 2 }),
    ]) as string;
    expect(text).toContain("repeated string tags = 2;");
  });

  it("a reference field emits the bare referenced type name", () => {
    const text = buildProtoDocument("Order", "", [
      field({ name: "customer", type: "reference", refTarget: "Customer", fieldNumber: 3 }),
    ]) as string;
    expect(text).toContain("Customer customer = 3;");
  });

  it("map fields emit map<K, V> and ignore the repeated flag", () => {
    const text = buildProtoDocument("Order", "", [
      field({
        name: "metadata",
        type: "map",
        mapKeyType: "string",
        mapValueType: "int32",
        repeated: true,
        fieldNumber: 4,
      }),
    ]) as string;
    expect(text).toContain("map<string, int32> metadata = 4;");
    expect(text).not.toContain("repeated map");
  });

  it("a map with a reference value type resolves to the referenced type name", () => {
    const text = buildProtoDocument("Order", "", [
      field({
        name: "related",
        type: "map",
        mapKeyType: "string",
        mapValueType: "reference",
        mapValueRefTarget: "LineItem",
        fieldNumber: 5,
      }),
    ]) as string;
    expect(text).toContain("map<string, LineItem> related = 5;");
  });

  it("doc text becomes a trailing // comment", () => {
    const text = buildProtoDocument("Order", "", [
      field({ name: "id", doc: "primary id", fieldNumber: 1 }),
    ]) as string;
    expect(text).toContain("string id = 1; // primary id");
  });

  it("groups fields sharing a oneofGroup into a nested oneof block, once", () => {
    const text = buildProtoDocument("Contact", "", [
      field({ name: "email", oneofGroup: "method", fieldNumber: 1 }),
      field({ name: "phone", oneofGroup: "method", fieldNumber: 2 }),
    ]) as string;
    const oneofCount = (text.match(/oneof method \{/g) ?? []).length;
    expect(oneofCount).toBe(1);
    expect(text).toContain("string email = 1;");
    expect(text).toContain("string phone = 2;");
  });

  it("nextFieldNumber suggests the lowest unused positive integer", () => {
    expect(nextFieldNumber([])).toBe(1);
    expect(nextFieldNumber([field({ fieldNumber: 1 }), field({ fieldNumber: 2 })])).toBe(3);
    expect(nextFieldNumber([field({ fieldNumber: 1 }), field({ fieldNumber: 3 })])).toBe(2);
  });

  describe("round-trips through parseProtobufSchema", () => {
    it("scalar, repeated, reference, well-known type, map, and oneof fields all come back with stable field numbers", () => {
      const fields: ProtoField[] = [
        field({ name: "id", type: "string", fieldNumber: 1 }),
        field({ name: "tags", type: "string", fieldNumber: 2, repeated: true }),
        field({ name: "customer", type: "reference", refTarget: "Customer", fieldNumber: 3 }),
        field({ name: "created_at", type: "google.protobuf.Timestamp", fieldNumber: 4 }),
        field({
          name: "metadata",
          type: "map",
          mapKeyType: "string",
          mapValueType: "string",
          fieldNumber: 5,
        }),
        field({ name: "email", oneofGroup: "contact", fieldNumber: 6, doc: "email variant" }),
        field({ name: "phone", oneofGroup: "contact", fieldNumber: 7, doc: "phone variant" }),
      ];
      const text = buildProtoDocument("Order", "com.example", fields) as string;
      const result = parseProtobufSchema(text);
      expect(result.success).toBe(true);
      if (!result.success) return;

      expect(result.data.name).toBe("Order");
      expect(result.data.fields).toHaveLength(7);
      const byName = Object.fromEntries(result.data.fields.map((f) => [f.name, f]));

      expect(byName.id).toMatchObject({ type: "string", confidence: "high", fieldNumber: 1 });
      // Epic 15.1 (protobufjs importer): element / key / value types and oneof
      // groups are preserved now, so these come back exact.
      expect(byName.tags).toMatchObject({
        type: "array",
        arrayElementType: "string",
        confidence: "high",
        fieldNumber: 2,
      });
      // "Customer" is not defined in this document, so it stays a
      // low-confidence reference by name (resolved against existing entities).
      expect(byName.customer).toMatchObject({
        type: "reference",
        referencedEntityName: "Customer",
        confidence: "low",
        fieldNumber: 3,
      });
      expect(byName.created_at).toMatchObject({
        type: "utcDateTime",
        confidence: "high",
        fieldNumber: 4,
      });
      expect(byName.metadata).toMatchObject({
        type: "map",
        mapKeyType: "string",
        mapValueType: "string",
        confidence: "high",
        fieldNumber: 5,
      });
      expect(byName.email).toMatchObject({
        fieldNumber: 6,
        description: "email variant",
        governance: { protobufOneofGroup: "contact" },
      });
      expect(byName.phone).toMatchObject({
        fieldNumber: 7,
        description: "phone variant",
        governance: { protobufOneofGroup: "contact" },
      });
    });

    it("proto3 fields are nullable by default per the importer's own semantics", () => {
      const text = buildProtoDocument("Order", "", [
        field({ name: "id", type: "string", fieldNumber: 1 }),
      ]) as string;
      const result = parseProtobufSchema(text);
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.fields[0].nullable).toBe(true);
    });
  });
});

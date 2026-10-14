import { describe, it, expect } from "vitest";
import {
  serializeAvroSchema,
  buildAvroDocument,
  buildAvroFieldNode,
  type AvroField,
} from "@/components/custom/VisualSchemaBuilder/avro-serialize";
import { parseAvroSchema } from "@/lib/importers/avro.importer";

function field(partial: Partial<AvroField>): AvroField {
  return {
    id: Math.random().toString(36),
    name: "f",
    type: "string",
    nullable: false,
    doc: "",
    ...partial,
  };
}

describe("VisualSchemaBuilder avro-serialize", () => {
  it("returns null until a record name + a named field exist", () => {
    expect(serializeAvroSchema("", "", "", [field({ name: "a" })])).toBeNull();
    expect(serializeAvroSchema("Order", "", "", [field({ name: "" })])).toBeNull();
    expect(serializeAvroSchema("Order", "", "", [field({ name: "a" })])).not.toBeNull();
  });

  it("emits type/name/namespace/doc at the record level", () => {
    const doc = JSON.parse(
      serializeAvroSchema("Order", "com.example", "An order", [
        field({ name: "id" }),
      ]) as string
    );
    expect(doc.type).toBe("record");
    expect(doc.name).toBe("Order");
    expect(doc.namespace).toBe("com.example");
    expect(doc.doc).toBe("An order");
  });

  it("wraps nullable fields in a [\"null\", type] union with a null default", () => {
    const node = buildAvroFieldNode(field({ type: "string", nullable: true }));
    expect(node.type).toEqual(["null", "string"]);
    expect(node.default).toBeNull();
  });

  it("non-nullable fields stay a bare type with no default unless set", () => {
    const node = buildAvroFieldNode(field({ type: "string", nullable: false }));
    expect(node.type).toBe("string");
    expect(node.default).toBeUndefined();
  });

  it("builds logical types on their spec-correct base type", () => {
    expect(buildAvroFieldNode(field({ type: "date" })).type).toEqual({
      type: "int",
      logicalType: "date",
    });
    expect(buildAvroFieldNode(field({ type: "timestamp-millis" })).type).toEqual({
      type: "long",
      logicalType: "timestamp-millis",
    });
    expect(buildAvroFieldNode(field({ type: "uuid" })).type).toEqual({
      type: "string",
      logicalType: "uuid",
    });
  });

  it("decimal carries precision/scale with defaults when unset", () => {
    const withDefaults = buildAvroFieldNode(field({ type: "decimal" }));
    expect(withDefaults.type).toMatchObject({ type: "bytes", logicalType: "decimal", precision: 10, scale: 2 });
    const explicit = buildAvroFieldNode(field({ type: "decimal", precision: 12, scale: 4 }));
    expect(explicit.type).toMatchObject({ precision: 12, scale: 4 });
  });

  it("duration is a 12-byte fixed with logicalType duration", () => {
    const node = buildAvroFieldNode(field({ type: "duration", fixedName: "Dur" }));
    expect(node.type).toEqual({ type: "fixed", name: "Dur", size: 12, logicalType: "duration" });
  });

  it("enum carries name + symbols", () => {
    const node = buildAvroFieldNode(
      field({ type: "enum", enumName: "Status", symbols: ["ACTIVE", "INACTIVE"] })
    );
    expect(node.type).toEqual({ type: "enum", name: "Status", symbols: ["ACTIVE", "INACTIVE"] });
  });

  it("array/map nest an element type, including reference elements", () => {
    const arr = buildAvroFieldNode(field({ type: "array", itemsType: "int" }));
    expect(arr.type).toEqual({ type: "array", items: "int" });
    const arrRef = buildAvroFieldNode(
      field({ type: "array", itemsType: "reference", itemsRefTarget: "LineItem" })
    );
    expect(arrRef.type).toEqual({ type: "array", items: "LineItem" });
    const map = buildAvroFieldNode(field({ type: "map", valuesType: "long" }));
    expect(map.type).toEqual({ type: "map", values: "long" });
  });

  it("a reference field emits the bare referenced type name", () => {
    const node = buildAvroFieldNode(field({ type: "reference", refTarget: "Customer" }));
    expect(node.type).toBe("Customer");
  });

  it("aliases/order/default are only emitted when set", () => {
    const bare = buildAvroFieldNode(field({}));
    expect(bare.aliases).toBeUndefined();
    expect(bare.order).toBeUndefined();
    const full = buildAvroFieldNode(
      field({ aliases: ["old_name"], order: "descending", defaultValue: '"x"' })
    );
    expect(full.aliases).toEqual(["old_name"]);
    expect(full.order).toBe("descending");
    expect(full.default).toBe("x");
  });

  describe("round-trips through parseAvroSchema", () => {
    it("primitives, enum, decimal, and reference all come back mapped", () => {
      const fields: AvroField[] = [
        field({ name: "id", type: "string", nullable: false }),
        field({ name: "nickname", type: "string", nullable: true }),
        field({
          name: "status",
          type: "enum",
          enumName: "Status",
          symbols: ["ACTIVE", "INACTIVE", "PENDING"],
        }),
        field({ name: "customer", type: "reference", refTarget: "Customer" }),
        field({ name: "price", type: "decimal", precision: 12, scale: 4 }),
      ];
      const content = serializeAvroSchema("Order", "com.example", "An order", fields) as string;
      const result = parseAvroSchema(content);
      expect(result.success).toBe(true);
      if (!result.success) return;

      expect(result.data.name).toBe("Order");
      const byName = Object.fromEntries(result.data.fields.map((f) => [f.name, f]));
      expect(byName.id).toMatchObject({ type: "string", confidence: "high", nullable: false });
      expect(byName.nickname.nullable).toBe(true);
      expect(byName.status).toMatchObject({ type: "enum", confidence: "high" });
      expect(byName.price).toMatchObject({
        type: "decimal",
        confidence: "high",
        originalType: "bytes/decimal(12,4)",
      });
      // Epic 15.3: a named type the document does not define ("Customer")
      // imports as a low-confidence reference by its short name.
      expect(byName.customer).toMatchObject({
        type: "reference",
        referencedEntityName: "Customer",
        confidence: "low",
      });
      expect(byName.status).toMatchObject({
        enumName: "Status",
        enumValues: ["ACTIVE", "INACTIVE", "PENDING"],
      });
    });

    it("date/time/timestamp/duration/uuid logical types round-trip to their high-confidence logical mapping", () => {
      const fields: AvroField[] = [
        field({ name: "birth_date", type: "date" }),
        field({ name: "start_time", type: "time-millis" }),
        field({ name: "created_at", type: "timestamp-millis" }),
        field({ name: "span", type: "duration" }),
        field({ name: "ext_id", type: "uuid" }),
      ];
      const content = serializeAvroSchema("Session", "", "", fields) as string;
      const result = parseAvroSchema(content);
      expect(result.success).toBe(true);
      if (!result.success) return;
      const byName = Object.fromEntries(result.data.fields.map((f) => [f.name, f]));
      expect(byName.birth_date).toMatchObject({ type: "plainDate", confidence: "high" });
      expect(byName.start_time).toMatchObject({ type: "plainTime", confidence: "high" });
      expect(byName.created_at).toMatchObject({ type: "utcDateTime", confidence: "high" });
      expect(byName.span).toMatchObject({ type: "duration", confidence: "high" });
      expect(byName.ext_id).toMatchObject({ type: "string", confidence: "high" });
    });
  });

  it("buildAvroDocument is null-safe for an all-blank field list", () => {
    expect(buildAvroDocument("Order", "", "", [field({ name: "" })])).toBeNull();
  });
});

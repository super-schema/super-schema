import { describe, it, expect } from "vitest";
import {
  serializeJsonSchema,
  buildFieldNode,
  type JsonSchemaField,
} from "@/components/custom/VisualSchemaBuilder/serialize";
import { parseJsonSchema } from "@/lib/importers/jsonschema.importer";

function field(partial: Partial<JsonSchemaField>): JsonSchemaField {
  return {
    id: Math.random().toString(36),
    name: "f",
    type: "string",
    required: true,
    description: "",
    ...partial,
  };
}

describe("VisualSchemaBuilder serialize (JSON Schema 2020-12)", () => {
  it("returns null until title + a named field exist", () => {
    expect(serializeJsonSchema("", "", [field({ name: "a" })])).toBeNull();
    expect(serializeJsonSchema("E", "", [field({ name: "" })])).toBeNull();
    expect(serializeJsonSchema("E", "", [field({ name: "a" })])).not.toBeNull();
  });

  it("emits the 2020-12 dialect + title + description + required", () => {
    const doc = JSON.parse(
      serializeJsonSchema("Order", "An order", [
        field({ name: "id", type: "string", required: true }),
        field({ name: "note", type: "string", required: false }),
      ]) as string
    );
    expect(doc.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(doc.title).toBe("Order");
    expect(doc.description).toBe("An order");
    expect(doc.type).toBe("object");
    expect(doc.required).toEqual(["id"]);
  });

  it("only JSON-native types are produced", () => {
    const node = buildFieldNode(field({ name: "n", type: "integer", minimum: 0, maximum: 10 }));
    expect(node.type).toBe("integer");
    expect(node.minimum).toBe(0);
    expect(node.maximum).toBe(10);
  });

  it("emits string keywords (format, length, pattern)", () => {
    const node = buildFieldNode(
      field({ type: "string", format: "email", minLength: 3, maxLength: 50, pattern: "^.+@.+$" })
    );
    expect(node).toMatchObject({
      type: "string",
      format: "email",
      minLength: 3,
      maxLength: 50,
      pattern: "^.+@.+$",
    });
  });

  it("emits array keywords", () => {
    const node = buildFieldNode(
      field({ type: "array", itemsType: "string", minItems: 1, uniqueItems: true })
    );
    expect(node).toMatchObject({
      type: "array",
      items: { type: "string" },
      minItems: 1,
      uniqueItems: true,
    });
  });

  it("parses const/default/enum values loosely (JSON when possible)", () => {
    const node = buildFieldNode(
      field({ type: "integer", constValue: "42", defaultValue: "7", enumValues: ["1", "2"] })
    );
    expect(node.const).toBe(42);
    expect(node.default).toBe(7);
    expect(node.enum).toEqual(["1", "2"]);
  });

  it("round-trips through parseJsonSchema", () => {
    const content = serializeJsonSchema("User", "", [
      field({ name: "id", type: "string", format: "uuid", required: true }),
      field({ name: "age", type: "integer", minimum: 0, required: false }),
      field({ name: "created", type: "string", format: "date-time", required: true }),
    ]) as string;
    const r = parseJsonSchema(content);
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.name).toBe("User");
    const byName = Object.fromEntries(r.data.fields.map((f) => [f.name, f]));
    expect(byName.id.format).toBe("uuid");
    expect(byName.created.type).toBe("utcDateTime");
    expect(byName.age.nullable).toBe(true);
    expect(byName.id.nullable).toBe(false);
  });

  describe("references to other entities", () => {
    it("a reference field emits a $ref to the target entity", () => {
      const node = buildFieldNode(field({ name: "owner", type: "reference", refTarget: "Customer" }));
      expect(node).toEqual({ $ref: "#/$defs/Customer" });
    });

    it("keeps an already-qualified $ref as-is", () => {
      const node = buildFieldNode(
        field({ type: "reference", refTarget: "https://ex.com/Customer.json" })
      );
      expect(node.$ref).toBe("https://ex.com/Customer.json");
    });

    it("an array of references emits items.$ref", () => {
      const node = buildFieldNode(
        field({ type: "array", itemsType: "reference", itemsRefTarget: "LineItem" })
      );
      expect(node).toMatchObject({ type: "array", items: { $ref: "#/$defs/LineItem" } });
    });

    it("reference fields round-trip to a reference logical type via parseJsonSchema", () => {
      const content = serializeJsonSchema("Order", "", [
        field({ name: "id", type: "string", required: true }),
        field({ name: "customer", type: "reference", refTarget: "Customer", required: true }),
        field({ name: "lines", type: "array", itemsType: "reference", itemsRefTarget: "LineItem" }),
      ]) as string;
      const r = parseJsonSchema(content);
      expect(r.success).toBe(true);
      if (!r.success) return;
      const byName = Object.fromEntries(r.data.fields.map((f) => [f.name, f]));
      expect(byName.customer.type).toBe("reference");
      expect(byName.customer.originalType).toBe("#/$defs/Customer");
      expect(byName.customer.referencedEntityName).toBe("Customer");
    });
  });
});

import { describe, it, expect } from "vitest";
import { parseJsonSchema } from "@/lib/importers/jsonschema.importer";

describe("JSON Schema Importer", () => {
  const schema = (properties: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    JSON.stringify({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      title: "User",
      type: "object",
      properties,
      ...extra,
    });

  describe("primitive type mapping", () => {
    it("maps string → string (high)", () => {
      const r = parseJsonSchema(schema({ name: { type: "string" } }));
      expect(r.success).toBe(true);
      if (!r.success) return;
      expect(r.data.fields[0]).toMatchObject({ name: "name", type: "string", confidence: "high" });
    });

    it("maps integer → integer, number → float64", () => {
      const r = parseJsonSchema(schema({ age: { type: "integer" }, score: { type: "number" } }));
      expect(r.success).toBe(true);
      if (!r.success) return;
      expect(r.data.fields.find((f) => f.name === "age")?.type).toBe("integer");
      expect(r.data.fields.find((f) => f.name === "score")?.type).toBe("float64");
    });

    it("maps integer format int64 → int64", () => {
      const r = parseJsonSchema(schema({ id: { type: "integer", format: "int64" } }));
      expect(r.success).toBe(true);
      if (!r.success) return;
      expect(r.data.fields[0].type).toBe("int64");
    });

    it("maps boolean → boolean", () => {
      const r = parseJsonSchema(schema({ active: { type: "boolean" } }));
      expect(r.success).toBe(true);
      if (!r.success) return;
      expect(r.data.fields[0].type).toBe("boolean");
    });
  });

  describe("string formats", () => {
    it("date-time → utcDateTime, date → plainDate, uri → url", () => {
      const r = parseJsonSchema(
        schema({
          createdAt: { type: "string", format: "date-time" },
          birthday: { type: "string", format: "date" },
          homepage: { type: "string", format: "uri" },
        })
      );
      expect(r.success).toBe(true);
      if (!r.success) return;
      expect(r.data.fields.find((f) => f.name === "createdAt")?.type).toBe("utcDateTime");
      expect(r.data.fields.find((f) => f.name === "birthday")?.type).toBe("plainDate");
      expect(r.data.fields.find((f) => f.name === "homepage")?.type).toBe("url");
    });

    it("keeps uuid/email as string with a preserved format hint", () => {
      const r = parseJsonSchema(
        schema({ id: { type: "string", format: "uuid" }, email: { type: "string", format: "email" } })
      );
      expect(r.success).toBe(true);
      if (!r.success) return;
      const email = r.data.fields.find((f) => f.name === "email");
      expect(email?.type).toBe("string");
      expect(email?.format).toBe("email");
    });
  });

  describe("nullability", () => {
    it("marks properties not in `required` as nullable", () => {
      const r = parseJsonSchema(
        schema({ id: { type: "string" }, nickname: { type: "string" } }, { required: ["id"] })
      );
      expect(r.success).toBe(true);
      if (!r.success) return;
      expect(r.data.fields.find((f) => f.name === "id")?.nullable).toBe(false);
      expect(r.data.fields.find((f) => f.name === "nickname")?.nullable).toBe(true);
    });

    it("handles union type [T, null] as nullable", () => {
      const r = parseJsonSchema(
        schema({ note: { type: ["string", "null"] } }, { required: ["note"] })
      );
      expect(r.success).toBe(true);
      if (!r.success) return;
      expect(r.data.fields[0]).toMatchObject({ type: "string", nullable: true });
    });
  });

  describe("enum, const, $ref, combinators", () => {
    it("maps enum → enum (high)", () => {
      const r = parseJsonSchema(schema({ status: { enum: ["A", "B"] } }));
      expect(r.success).toBe(true);
      if (!r.success) return;
      expect(r.data.fields[0]).toMatchObject({ type: "enum", confidence: "high" });
    });

    it("maps $ref → reference (low) and links the target entity name", () => {
      const r = parseJsonSchema(schema({ owner: { $ref: "#/$defs/Owner" } }));
      expect(r.success).toBe(true);
      if (!r.success) return;
      expect(r.data.fields[0]).toMatchObject({
        type: "reference",
        confidence: "low",
        referencedEntityName: "Owner",
      });
    });

    it("maps array of $ref → array with element reference + target", () => {
      const r = parseJsonSchema(
        schema({ lines: { type: "array", items: { $ref: "#/$defs/LineItem" } } })
      );
      expect(r.success).toBe(true);
      if (!r.success) return;
      expect(r.data.fields[0]).toMatchObject({
        type: "array",
        arrayElementType: "reference",
        referencedEntityName: "LineItem",
      });
    });

    it("maps array of scalars → array with element type", () => {
      const r = parseJsonSchema(
        schema({ tags: { type: "array", items: { type: "string" } } })
      );
      expect(r.success).toBe(true);
      if (!r.success) return;
      expect(r.data.fields[0]).toMatchObject({ type: "array", arrayElementType: "string" });
    });

    it("maps a oneOf of scalars to a union of those types (not to its first member)", () => {
      const r = parseJsonSchema(
        schema({ value: { oneOf: [{ type: "string" }, { type: "integer" }] } })
      );
      expect(r.success).toBe(true);
      if (!r.success) return;
      expect(r.data.fields[0]).toMatchObject({ type: "union", unionMembers: ["string", "integer"] });
    });

    it("maps a oneOf that mixes a scalar and an inline object to the first member type", () => {
      const r = parseJsonSchema(
        schema({ value: { oneOf: [{ type: "string" }, { type: "object", properties: { k: { type: "string" } } }] } })
      );
      expect(r.success).toBe(true);
      if (!r.success) return;
      expect(r.data.fields[0].type).toBe("string");
    });
  });

  describe("constraints + metadata", () => {
    it("extracts validation constraints onto the field", () => {
      const r = parseJsonSchema(
        schema({
          name: { type: "string", minLength: 1, maxLength: 80, pattern: "^[a-z]+$" },
          age: { type: "integer", minimum: 0, maximum: 120 },
        })
      );
      expect(r.success).toBe(true);
      if (!r.success) return;
      const name = r.data.fields.find((f) => f.name === "name");
      expect(name?.constraints).toEqual(
        expect.arrayContaining([
          { type: "minLength", value: 1 },
          { type: "maxLength", value: 80 },
          { type: "pattern", value: "^[a-z]+$" },
        ])
      );
      const age = r.data.fields.find((f) => f.name === "age");
      expect(age?.constraints).toEqual(
        expect.arrayContaining([
          { type: "minValue", value: 0 },
          { type: "maxValue", value: 120 },
        ])
      );
    });

    it("captures description and deprecated", () => {
      const r = parseJsonSchema(
        schema({ legacy: { type: "string", description: "old field", deprecated: true } })
      );
      expect(r.success).toBe(true);
      if (!r.success) return;
      expect(r.data.fields[0].description).toBe("old field");
      expect(r.data.fields[0].deprecated).toBe(true);
    });

    it("flags a required `id` property as the key", () => {
      const r = parseJsonSchema(schema({ id: { type: "string" } }, { required: ["id"] }));
      expect(r.success).toBe(true);
      if (!r.success) return;
      expect(r.data.fields[0].isKey).toBe(true);
    });
  });

  describe("entity + document metadata", () => {
    it("derives the entity name from title", () => {
      const r = parseJsonSchema(schema({ x: { type: "string" } }));
      expect(r.success).toBe(true);
      if (!r.success) return;
      expect(r.data.name).toBe("User");
      expect(r.data.sourceFormat).toBe("json-schema");
    });

    it("derives the entity name from $id when title is absent", () => {
      const r = parseJsonSchema(
        JSON.stringify({ $id: "https://ex.com/schemas/order.json", type: "object", properties: { x: { type: "string" } } })
      );
      expect(r.success).toBe(true);
      if (!r.success) return;
      expect(r.data.name).toBe("order");
    });
  });

  describe("error handling", () => {
    it("rejects invalid JSON", () => {
      const r = parseJsonSchema("{ not json");
      expect(r.success).toBe(false);
    });

    it("rejects a schema with no properties", () => {
      const r = parseJsonSchema(JSON.stringify({ type: "object", title: "Empty" }));
      expect(r.success).toBe(false);
    });

    it("rejects an array-root schema", () => {
      const r = parseJsonSchema(JSON.stringify({ type: "array", items: { type: "string" } }));
      expect(r.success).toBe(false);
    });
  });
});

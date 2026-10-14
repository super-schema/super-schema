import { describe, it, expect } from "vitest";
import { parseAvroSchema } from "@/lib/importers/avro.importer";

describe("Avro Importer", () => {
  const validAvro = (fields: unknown[], name = "User") =>
    JSON.stringify({
      type: "record",
      name,
      namespace: "com.example",
      fields,
    });

  describe("primitive types", () => {
    it("parses string type with high confidence", () => {
      const result = parseAvroSchema(
        validAvro([{ name: "name", type: "string" }])
      );
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.fields[0]).toMatchObject({
        name: "name",
        type: "string",
        confidence: "high",
        nullable: false,
      });
    });

    it("parses int type to int32", () => {
      const result = parseAvroSchema(
        validAvro([{ name: "age", type: "int" }])
      );
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.fields[0].type).toBe("int32");
    });

    it("parses long type to int64", () => {
      const result = parseAvroSchema(
        validAvro([{ name: "id", type: "long" }])
      );
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.fields[0].type).toBe("int64");
    });

    it("parses float type to float32", () => {
      const result = parseAvroSchema(
        validAvro([{ name: "score", type: "float" }])
      );
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.fields[0].type).toBe("float32");
    });

    it("parses double type to float64", () => {
      const result = parseAvroSchema(
        validAvro([{ name: "amount", type: "double" }])
      );
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.fields[0].type).toBe("float64");
    });

    it("parses boolean type", () => {
      const result = parseAvroSchema(
        validAvro([{ name: "active", type: "boolean" }])
      );
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.fields[0].type).toBe("boolean");
      expect(result.data.fields[0].confidence).toBe("high");
    });

    it("parses bytes type with low confidence", () => {
      const result = parseAvroSchema(
        validAvro([{ name: "data", type: "bytes" }])
      );
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.fields[0].type).toBe("bytes");
      expect(result.data.fields[0].confidence).toBe("low");
    });
  });

  describe("nullable union types", () => {
    it('parses ["null", "string"] as nullable string', () => {
      const result = parseAvroSchema(
        validAvro([{ name: "nickname", type: ["null", "string"] }])
      );
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.fields[0]).toMatchObject({
        name: "nickname",
        type: "string",
        nullable: true,
        confidence: "high",
      });
    });

    it('parses ["null", "int"] as nullable int32', () => {
      const result = parseAvroSchema(
        validAvro([{ name: "count", type: ["null", "int"] }])
      );
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.fields[0].type).toBe("int32");
      expect(result.data.fields[0].nullable).toBe(true);
    });

    it("parses multi-type union as medium confidence", () => {
      const result = parseAvroSchema(
        validAvro([{ name: "value", type: ["null", "string", "int"] }])
      );
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.fields[0].confidence).toBe("medium");
      expect(result.data.fields[0].nullable).toBe(true);
    });
  });

  describe("logical types", () => {
    it("parses date logical type", () => {
      const result = parseAvroSchema(
        validAvro([
          { name: "birthdate", type: { type: "int", logicalType: "date" } },
        ])
      );
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.fields[0].type).toBe("plainDate");
      expect(result.data.fields[0].confidence).toBe("high");
    });

    it("parses timestamp-millis logical type", () => {
      const result = parseAvroSchema(
        validAvro([
          {
            name: "created_at",
            type: { type: "long", logicalType: "timestamp-millis" },
          },
        ])
      );
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.fields[0].type).toBe("utcDateTime");
      expect(result.data.fields[0].confidence).toBe("high");
    });

    it("parses decimal logical type", () => {
      const result = parseAvroSchema(
        validAvro([
          {
            name: "price",
            type: {
              type: "bytes",
              logicalType: "decimal",
              precision: 10,
              scale: 2,
            },
          },
        ])
      );
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.fields[0].type).toBe("decimal");
      expect(result.data.fields[0].confidence).toBe("high");
    });
  });

  describe("entity name extraction", () => {
    it("extracts entity name from top-level name field", () => {
      const result = parseAvroSchema(
        validAvro([], "CustomerProfile")
      );
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.name).toBe("CustomerProfile");
    });

    it("strips namespace from name", () => {
      const content = JSON.stringify({
        type: "record",
        name: "com.example.data.UserEvent",
        fields: [],
      });
      const result = parseAvroSchema(content);
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.name).toBe("UserEvent");
    });
  });

  describe("doc/description", () => {
    it("extracts field description from doc", () => {
      const result = parseAvroSchema(
        validAvro([
          { name: "email", type: "string", doc: "User email address" },
        ])
      );
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.fields[0].description).toBe("User email address");
    });
  });

  // Epic 15.3: a nested record is its own entity now (see avro-document.test.ts);
  // the field referencing it is an exact reference, no longer a low-confidence object.
  describe("nested records", () => {
    it("maps a nested record field to a reference to the nested entity", () => {
      const result = parseAvroSchema(
        validAvro([
          {
            name: "address",
            type: {
              type: "record",
              name: "Address",
              fields: [{ name: "street", type: "string" }],
            },
          },
        ])
      );
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.fields[0]).toMatchObject({
        type: "reference",
        referencedEntityName: "Address",
        confidence: "high",
      });
    });
  });

  describe("error handling", () => {
    it("returns error for invalid JSON", () => {
      const result = parseAvroSchema("not valid json {{{");
      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error.code).toBe("PARSE_ERROR");
    });

    it("returns error for non-record type", () => {
      const result = parseAvroSchema(JSON.stringify({ type: "string" }));
      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error.code).toBe("PARSE_ERROR");
    });

    it("returns error for missing fields array", () => {
      const result = parseAvroSchema(
        JSON.stringify({ type: "record", name: "Test" })
      );
      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error.code).toBe("PARSE_ERROR");
    });
  });

  describe("source format tracking", () => {
    it("sets sourceFormat to avro", () => {
      const result = parseAvroSchema(validAvro([]));
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.sourceFormat).toBe("avro");
    });

    it("preserves original content", () => {
      const content = validAvro([{ name: "id", type: "string" }]);
      const result = parseAvroSchema(content);
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.originalContent).toBe(content);
    });
  });
});

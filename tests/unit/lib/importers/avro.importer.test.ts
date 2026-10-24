import { describe, it, expect } from "vitest";
import { parseAvroDocument, parseAvroSchema } from "@/lib/importers/avro.importer";

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

    describe("the precision and scale of a decimal are kept", () => {
      const one = (type: unknown) => {
        const result = parseAvroSchema(validAvro([{ name: "price", type }]));
        expect(result.success).toBe(true);
        if (!result.success) throw new Error("did not parse");
        return result.data.fields[0];
      };

      it("bytes with logicalType decimal", () => {
        const field = one({ type: "bytes", logicalType: "decimal", precision: 12, scale: 2 });
        expect(field.type).toBe("decimal");
        expect(field.precision).toBe(12);
        expect(field.scale).toBe(2);
      });

      it("a scale that is not written is 0 (the Avro default)", () => {
        const field = one({ type: "bytes", logicalType: "decimal", precision: 9 });
        expect(field.precision).toBe(9);
        expect(field.scale).toBe(0);
      });

      it("inside a union with null the field is nullable and keeps them", () => {
        const field = one(["null", { type: "bytes", logicalType: "decimal", precision: 18, scale: 4 }]);
        expect(field.nullable).toBe(true);
        expect(field.type).toBe("decimal");
        expect(field.precision).toBe(18);
        expect(field.scale).toBe(4);
      });

      it("a fixed decimal", () => {
        const field = one({ type: "fixed", name: "Money", size: 8, logicalType: "decimal", precision: 18, scale: 4 });
        expect(field.type).toBe("decimal");
        expect(field.precision).toBe(18);
        expect(field.scale).toBe(4);
      });

      it("a precision that is not a positive whole number is not kept (and nothing is made up)", () => {
        for (const precision of ["12", -1, 1.5, null]) {
          const field = one({ type: "bytes", logicalType: "decimal", precision, scale: 2 });
          expect(field.type, String(precision)).toBe("decimal");
          expect(field.precision, String(precision)).toBeUndefined();
          expect(field.scale, String(precision)).toBeUndefined();
        }
      });

      describe("a declaration that is not a valid decimal is not kept: a plain decimal, and a warning of the import", () => {
        const documentOf = (type: unknown) => {
          const result = parseAvroDocument(validAvro([{ name: "price", type }]));
          expect(result.success).toBe(true);
          if (!result.success) throw new Error("did not parse");
          return result.data;
        };

        it.each([
          ["a precision of 1e10", { type: "bytes", logicalType: "decimal", precision: 1e10, scale: 2 }],
          ["a precision of 1e309 (Infinity once parsed)", JSON.parse('{"type":"bytes","logicalType":"decimal","precision":1e309,"scale":2}')],
          ["a precision above 76", { type: "bytes", logicalType: "decimal", precision: 77, scale: 2 }],
          ["a scale above the precision", { type: "bytes", logicalType: "decimal", precision: 5, scale: 6 }],
          ["a negative scale", { type: "bytes", logicalType: "decimal", precision: 5, scale: -1 }],
          ["a fractional precision", { type: "bytes", logicalType: "decimal", precision: 5.5, scale: 2 }],
          ["a precision that is a string", { type: "bytes", logicalType: "decimal", precision: "12", scale: 2 }],
          ["no precision at all", { type: "bytes", logicalType: "decimal", scale: 2 }],
          ["a scale of 1e309", JSON.parse('{"type":"bytes","logicalType":"decimal","precision":12,"scale":1e309}')],
        ])("%s", (_name, type) => {
          const doc = documentOf(type);
          const field = doc.entities[0].fields[0];
          expect(field.type).toBe("decimal");
          expect(field.precision).toBeUndefined();
          expect(field.scale).toBeUndefined();
          const warnings = doc.warnings.filter((w) => w.includes("plain decimal"));
          expect(warnings).toHaveLength(1);
          expect(warnings[0]).toContain("price");
        });

        it("a valid one raises none", () => {
          const doc = documentOf({ type: "bytes", logicalType: "decimal", precision: 38, scale: 9 });
          expect(doc.warnings.filter((w) => w.includes("plain decimal"))).toEqual([]);
        });
      });

      it("a field that is not a decimal has none", () => {
        const field = one({ type: "long", logicalType: "timestamp-millis" });
        expect(field.precision).toBeUndefined();
        expect(field.scale).toBeUndefined();
      });
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

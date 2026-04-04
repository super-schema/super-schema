import { describe, it, expect } from "vitest";
import { avroEmitter } from "@/emitters/avro/avro.emitter";
import { validateAvroSchema } from "@/emitters/avro/avro.validator";
import { getDefaultPolicies } from "@/lib/type-mapping/default-mappings";
import type {
  SuperSchemaModel,
  SuperSchemaField,
  MappingPolicy,
} from "@/types/super-schema-model";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const defaultPolicies: MappingPolicy[] = getDefaultPolicies();

function makeField(overrides: Partial<SuperSchemaField>): SuperSchemaField {
  return {
    name: "test_field",
    type: "string",
    nullable: false,
    isKey: false,
    description: "",
    aliases: [],
    decorators: {},
    sortOrder: 0,
    ...overrides,
  };
}

function makeModel(
  fields: SuperSchemaField[],
  overrides?: Partial<SuperSchemaModel["entity"]>
): SuperSchemaModel {
  return {
    entity: {
      id: "entity-1",
      name: "test_entity",
      domain: "payments",
      domainId: "domain-1",
      description: "A test entity",
      status: "draft",
      version: 1,
      metadata: {},
      ...overrides,
    },
    fields,
    relationships: [],
  };
}

function emitAndParse(model: SuperSchemaModel): Record<string, unknown> {
  const result = avroEmitter.emit(model, defaultPolicies);
  return JSON.parse(result.output);
}

// ---------------------------------------------------------------------------
// Emitter metadata
// ---------------------------------------------------------------------------

describe("Avro Emitter metadata", () => {
  it("has correct name, version, and targetFormat", () => {
    expect(avroEmitter.name).toBe("avro");
    expect(avroEmitter.version).toBe("1.0.0");
    expect(avroEmitter.targetFormat).toBe("avro");
  });
});

// ---------------------------------------------------------------------------
// Simple entity
// ---------------------------------------------------------------------------

describe("Avro Emitter — simple entity", () => {
  it("produces valid Avro JSON with 3 fields (string, integer, boolean)", () => {
    const model = makeModel([
      makeField({ name: "username", type: "string", sortOrder: 0 }),
      makeField({ name: "age", type: "integer", sortOrder: 1 }),
      makeField({ name: "active", type: "boolean", sortOrder: 2 }),
    ]);

    const result = avroEmitter.emit(model, defaultPolicies);
    const schema = JSON.parse(result.output);

    expect(schema.type).toBe("record");
    expect(schema.fields).toHaveLength(3);
    expect(schema.fields[0].name).toBe("username");
    expect(schema.fields[0].type).toBe("string");
    expect(schema.fields[1].name).toBe("age");
    expect(schema.fields[1].type).toBe("long");
    expect(schema.fields[2].name).toBe("active");
    expect(schema.fields[2].type).toBe("boolean");

    // Validate the generated schema
    const validation = avroEmitter.validate(result.output);
    expect(validation.valid).toBe(true);
    expect(validation.errors).toHaveLength(0);
  });

  it("returns targetFormat 'avro' in result", () => {
    const model = makeModel([
      makeField({ name: "id", type: "string", sortOrder: 0 }),
    ]);
    const result = avroEmitter.emit(model, defaultPolicies);
    expect(result.targetFormat).toBe("avro");
  });
});

// ---------------------------------------------------------------------------
// Entity name — PascalCase
// ---------------------------------------------------------------------------

describe("Avro Emitter — entity name", () => {
  it("converts entity name to PascalCase", () => {
    const model = makeModel([], { name: "user_payment_history" });
    const schema = emitAndParse(model);
    expect(schema.name).toBe("UserPaymentHistory");
  });

  it("handles already-PascalCase names", () => {
    const model = makeModel([], { name: "PaymentOrder" });
    const schema = emitAndParse(model);
    expect(schema.name).toBe("PaymentOrder");
  });

  it("handles hyphenated names", () => {
    const model = makeModel([], { name: "my-entity" });
    const schema = emitAndParse(model);
    expect(schema.name).toBe("MyEntity");
  });
});

// ---------------------------------------------------------------------------
// Namespace from domain
// ---------------------------------------------------------------------------

describe("Avro Emitter — namespace", () => {
  it('derives namespace from domain: "payments" -> "com.superschema.payments"', () => {
    const model = makeModel([], { domain: "payments" });
    const schema = emitAndParse(model);
    expect(schema.namespace).toBe("com.superschema.payments");
  });

  it("lowercases the domain name", () => {
    const model = makeModel([], { domain: "FinancialData" });
    const schema = emitAndParse(model);
    expect(schema.namespace).toBe("com.superschema.financialdata");
  });
});

// ---------------------------------------------------------------------------
// Nullable fields
// ---------------------------------------------------------------------------

describe("Avro Emitter — nullable fields", () => {
  it('produces union ["null", "type"] for nullable fields', () => {
    const model = makeModel([
      makeField({ name: "email", type: "string", nullable: true, sortOrder: 0 }),
    ]);
    const schema = emitAndParse(model);
    expect(schema.fields).toHaveLength(1);
    const field = (schema.fields as Record<string, unknown>[])[0];
    expect(field.type).toEqual(["null", "string"]);
    expect(field.default).toBeNull();
  });

  it("produces bare type for non-nullable fields", () => {
    const model = makeModel([
      makeField({
        name: "name",
        type: "string",
        nullable: false,
        sortOrder: 0,
      }),
    ]);
    const schema = emitAndParse(model);
    const field = (schema.fields as Record<string, unknown>[])[0];
    expect(field.type).toBe("string");
    expect(field.default).toBeUndefined();
  });

  it("handles nullable complex type (array)", () => {
    const model = makeModel([
      makeField({
        name: "tags",
        type: "array",
        nullable: true,
        sortOrder: 0,
        complexType: { arrayElementType: "string" },
      }),
    ]);
    const schema = emitAndParse(model);
    const field = (schema.fields as Record<string, unknown>[])[0];
    expect(field.type).toEqual([
      "null",
      { type: "array", items: "string" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Decimal type
// ---------------------------------------------------------------------------

describe("Avro Emitter — decimal type", () => {
  it("produces bytes with logicalType decimal, precision 19, scale 4", () => {
    const model = makeModel([
      makeField({
        name: "amount",
        type: "decimal",
        precision: 19,
        scale: 4,
        nullable: false,
        sortOrder: 0,
      }),
    ]);
    const schema = emitAndParse(model);
    const field = (schema.fields as Record<string, unknown>[])[0];
    expect(field.type).toEqual({
      type: "bytes",
      logicalType: "decimal",
      precision: 19,
      scale: 4,
    });
  });

  it("validates decimal schema passes", () => {
    const model = makeModel([
      makeField({
        name: "price",
        type: "decimal",
        precision: 10,
        scale: 2,
        nullable: false,
        sortOrder: 0,
      }),
    ]);
    const result = avroEmitter.emit(model, defaultPolicies);
    const validation = avroEmitter.validate(result.output);
    expect(validation.valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Enum type
// ---------------------------------------------------------------------------

describe("Avro Emitter — enum type", () => {
  it("produces enum type with symbols array", () => {
    const model = makeModel([
      makeField({
        name: "status",
        type: "enum",
        nullable: false,
        sortOrder: 0,
        complexType: {
          nestedFields: [
            { name: "ACTIVE", type: "string" },
            { name: "INACTIVE", type: "string" },
            { name: "SUSPENDED", type: "string" },
          ],
        },
      }),
    ]);
    const schema = emitAndParse(model);
    const field = (schema.fields as Record<string, unknown>[])[0];
    expect(field.type).toEqual({
      type: "enum",
      name: "StatusEnum",
      symbols: ["ACTIVE", "INACTIVE", "SUSPENDED"],
    });
  });

  it("emits warning when enum has no symbols and falls back to string", () => {
    const model = makeModel([
      makeField({
        name: "color",
        type: "enum",
        nullable: false,
        sortOrder: 0,
      }),
    ]);
    const result = avroEmitter.emit(model, defaultPolicies);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings[0].message).toContain("no symbols");
    const schema = JSON.parse(result.output);
    const field = (schema.fields as Record<string, unknown>[])[0];
    expect(field.type).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// Array type
// ---------------------------------------------------------------------------

describe("Avro Emitter — array type", () => {
  it("produces array type with items", () => {
    const model = makeModel([
      makeField({
        name: "tags",
        type: "array",
        nullable: false,
        sortOrder: 0,
        complexType: { arrayElementType: "string" },
      }),
    ]);
    const schema = emitAndParse(model);
    const field = (schema.fields as Record<string, unknown>[])[0];
    expect(field.type).toEqual({ type: "array", items: "string" });
  });

  it("handles array of integers", () => {
    const model = makeModel([
      makeField({
        name: "scores",
        type: "array",
        nullable: false,
        sortOrder: 0,
        complexType: { arrayElementType: "integer" },
      }),
    ]);
    const schema = emitAndParse(model);
    const field = (schema.fields as Record<string, unknown>[])[0];
    expect(field.type).toEqual({ type: "array", items: "long" });
  });
});

// ---------------------------------------------------------------------------
// Map type
// ---------------------------------------------------------------------------

describe("Avro Emitter — map type", () => {
  it("produces map type with values (keys are always strings in Avro)", () => {
    const model = makeModel([
      makeField({
        name: "properties",
        type: "map",
        nullable: false,
        sortOrder: 0,
        complexType: { mapKeyType: "string", mapValueType: "string" },
      }),
    ]);
    const schema = emitAndParse(model);
    const field = (schema.fields as Record<string, unknown>[])[0];
    expect(field.type).toEqual({ type: "map", values: "string" });
  });

  it("handles map with integer values", () => {
    const model = makeModel([
      makeField({
        name: "counts",
        type: "map",
        nullable: false,
        sortOrder: 0,
        complexType: { mapKeyType: "string", mapValueType: "integer" },
      }),
    ]);
    const schema = emitAndParse(model);
    const field = (schema.fields as Record<string, unknown>[])[0];
    expect(field.type).toEqual({ type: "map", values: "long" });
  });
});

// ---------------------------------------------------------------------------
// Date type
// ---------------------------------------------------------------------------

describe("Avro Emitter — date type", () => {
  it("produces int with logicalType date", () => {
    const model = makeModel([
      makeField({
        name: "birth_date",
        type: "plainDate",
        nullable: false,
        sortOrder: 0,
      }),
    ]);
    const schema = emitAndParse(model);
    const field = (schema.fields as Record<string, unknown>[])[0];
    expect(field.type).toEqual({ type: "int", logicalType: "date" });
  });
});

// ---------------------------------------------------------------------------
// Timestamp type
// ---------------------------------------------------------------------------

describe("Avro Emitter — timestamp type", () => {
  it("produces long with logicalType timestamp-millis", () => {
    const model = makeModel([
      makeField({
        name: "created_at",
        type: "utcDateTime",
        nullable: false,
        sortOrder: 0,
      }),
    ]);
    const schema = emitAndParse(model);
    const field = (schema.fields as Record<string, unknown>[])[0];
    expect(field.type).toEqual({
      type: "long",
      logicalType: "timestamp-millis",
    });
  });
});

// ---------------------------------------------------------------------------
// Doc and aliases
// ---------------------------------------------------------------------------

describe("Avro Emitter — doc and aliases", () => {
  it("includes doc from field description", () => {
    const model = makeModel([
      makeField({
        name: "email",
        type: "string",
        description: "User email address",
        sortOrder: 0,
      }),
    ]);
    const schema = emitAndParse(model);
    const field = (schema.fields as Record<string, unknown>[])[0];
    expect(field.doc).toBe("User email address");
  });

  it("uses semantics decorator description when available", () => {
    const model = makeModel([
      makeField({
        name: "email",
        type: "string",
        description: "fallback desc",
        sortOrder: 0,
        decorators: {
          semantics: { description: "Primary email from semantics" },
        },
      }),
    ]);
    const schema = emitAndParse(model);
    const field = (schema.fields as Record<string, unknown>[])[0];
    expect(field.doc).toBe("Primary email from semantics");
  });

  it("omits doc when description is empty", () => {
    const model = makeModel([
      makeField({
        name: "id",
        type: "string",
        description: "",
        sortOrder: 0,
      }),
    ]);
    const schema = emitAndParse(model);
    const field = (schema.fields as Record<string, unknown>[])[0];
    expect(field.doc).toBeUndefined();
  });

  it("includes aliases from field aliases array", () => {
    const model = makeModel([
      makeField({
        name: "email",
        type: "string",
        aliases: ["email_address", "contact_email"],
        sortOrder: 0,
      }),
    ]);
    const schema = emitAndParse(model);
    const field = (schema.fields as Record<string, unknown>[])[0];
    expect(field.aliases).toEqual(["email_address", "contact_email"]);
  });

  it("omits aliases when empty", () => {
    const model = makeModel([
      makeField({ name: "id", type: "string", aliases: [], sortOrder: 0 }),
    ]);
    const schema = emitAndParse(model);
    const field = (schema.fields as Record<string, unknown>[])[0];
    expect(field.aliases).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Entity doc
// ---------------------------------------------------------------------------

describe("Avro Emitter — entity doc", () => {
  it("includes entity description as top-level doc", () => {
    const model = makeModel([], { description: "Payment entity" });
    const schema = emitAndParse(model);
    expect(schema.doc).toBe("Payment entity");
  });

  it("omits doc when entity description is empty", () => {
    const model = makeModel([], { description: "" });
    const schema = emitAndParse(model);
    expect(schema.doc).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Empty entity
// ---------------------------------------------------------------------------

describe("Avro Emitter — empty entity", () => {
  it("produces valid empty record schema", () => {
    const model = makeModel([]);
    const result = avroEmitter.emit(model, defaultPolicies);
    const schema = JSON.parse(result.output);
    expect(schema.type).toBe("record");
    expect(schema.fields).toEqual([]);

    const validation = avroEmitter.validate(result.output);
    expect(validation.valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

describe("Avro Emitter — determinism", () => {
  it("same input produces identical output", () => {
    const model = makeModel([
      makeField({ name: "a", type: "string", sortOrder: 0 }),
      makeField({ name: "b", type: "integer", sortOrder: 1 }),
      makeField({ name: "c", type: "boolean", sortOrder: 2 }),
    ]);

    const result1 = avroEmitter.emit(model, defaultPolicies);
    const result2 = avroEmitter.emit(model, defaultPolicies);
    expect(result1.output).toBe(result2.output);
  });

  it("field order is determined by sortOrder, not insertion order", () => {
    const model = makeModel([
      makeField({ name: "z_field", type: "string", sortOrder: 2 }),
      makeField({ name: "a_field", type: "integer", sortOrder: 0 }),
      makeField({ name: "m_field", type: "boolean", sortOrder: 1 }),
    ]);

    const schema = emitAndParse(model);
    const fieldNames = (schema.fields as { name: string }[]).map(
      (f) => f.name
    );
    expect(fieldNames).toEqual(["a_field", "m_field", "z_field"]);
  });
});

// ---------------------------------------------------------------------------
// Validator — pass cases
// ---------------------------------------------------------------------------

describe("Avro Validator — valid schemas", () => {
  it("passes for a minimal valid Avro schema", () => {
    const valid = JSON.stringify({
      type: "record",
      name: "Test",
      fields: [],
    });
    const result = validateAvroSchema(valid);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("passes for schema with primitive fields", () => {
    const valid = JSON.stringify({
      type: "record",
      name: "Test",
      namespace: "com.example",
      fields: [
        { name: "s", type: "string" },
        { name: "i", type: "int" },
        { name: "b", type: "boolean" },
      ],
    });
    const result = validateAvroSchema(valid);
    expect(result.valid).toBe(true);
  });

  it("passes for schema with union types", () => {
    const valid = JSON.stringify({
      type: "record",
      name: "Test",
      fields: [{ name: "n", type: ["null", "string"] }],
    });
    const result = validateAvroSchema(valid);
    expect(result.valid).toBe(true);
  });

  it("passes for schema with decimal logical type", () => {
    const valid = JSON.stringify({
      type: "record",
      name: "Test",
      fields: [
        {
          name: "amount",
          type: {
            type: "bytes",
            logicalType: "decimal",
            precision: 19,
            scale: 4,
          },
        },
      ],
    });
    const result = validateAvroSchema(valid);
    expect(result.valid).toBe(true);
  });

  it("passes for schema with enum type", () => {
    const valid = JSON.stringify({
      type: "record",
      name: "Test",
      fields: [
        {
          name: "color",
          type: {
            type: "enum",
            name: "Color",
            symbols: ["RED", "GREEN", "BLUE"],
          },
        },
      ],
    });
    const result = validateAvroSchema(valid);
    expect(result.valid).toBe(true);
  });

  it("passes for schema with array and map types", () => {
    const valid = JSON.stringify({
      type: "record",
      name: "Test",
      fields: [
        { name: "tags", type: { type: "array", items: "string" } },
        { name: "props", type: { type: "map", values: "string" } },
      ],
    });
    const result = validateAvroSchema(valid);
    expect(result.valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Validator — fail cases
// ---------------------------------------------------------------------------

describe("Avro Validator — invalid schemas", () => {
  it("fails for invalid JSON", () => {
    const result = validateAvroSchema("{not valid json");
    expect(result.valid).toBe(false);
    expect(result.errors[0].message).toContain("Invalid JSON");
  });

  it("fails when type is not record", () => {
    const result = validateAvroSchema(
      JSON.stringify({ type: "string", name: "Test", fields: [] })
    );
    expect(result.valid).toBe(false);
    expect(result.errors[0].message).toContain('"record"');
  });

  it("fails when name is missing", () => {
    const result = validateAvroSchema(
      JSON.stringify({ type: "record", fields: [] })
    );
    expect(result.valid).toBe(false);
    expect(result.errors[0].message).toContain("name");
  });

  it("fails when fields is not an array", () => {
    const result = validateAvroSchema(
      JSON.stringify({ type: "record", name: "Test", fields: "nope" })
    );
    expect(result.valid).toBe(false);
    expect(result.errors[0].message).toContain("array");
  });

  it("fails for invalid field type", () => {
    const result = validateAvroSchema(
      JSON.stringify({
        type: "record",
        name: "Test",
        fields: [{ name: "x", type: "notavalidtype" }],
      })
    );
    expect(result.valid).toBe(false);
    expect(result.errors[0].message).toContain("unknown primitive type");
  });

  it("fails for malformed union (nested unions)", () => {
    const result = validateAvroSchema(
      JSON.stringify({
        type: "record",
        name: "Test",
        fields: [{ name: "x", type: [["null", "string"]] }],
      })
    );
    expect(result.valid).toBe(false);
    expect(result.errors[0].message).toContain("nested unions");
  });

  it("fails for decimal without precision", () => {
    const result = validateAvroSchema(
      JSON.stringify({
        type: "record",
        name: "Test",
        fields: [
          {
            name: "amount",
            type: { type: "bytes", logicalType: "decimal", scale: 2 },
          },
        ],
      })
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.message.includes("precision"))).toBe(
      true
    );
  });

  it("fails for decimal without scale", () => {
    const result = validateAvroSchema(
      JSON.stringify({
        type: "record",
        name: "Test",
        fields: [
          {
            name: "amount",
            type: { type: "bytes", logicalType: "decimal", precision: 10 },
          },
        ],
      })
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.message.includes("scale"))).toBe(true);
  });

  it("fails for enum without symbols", () => {
    const result = validateAvroSchema(
      JSON.stringify({
        type: "record",
        name: "Test",
        fields: [
          { name: "status", type: { type: "enum", name: "Status" } },
        ],
      })
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.message.includes("symbols"))).toBe(
      true
    );
  });

  it("fails for array without items", () => {
    const result = validateAvroSchema(
      JSON.stringify({
        type: "record",
        name: "Test",
        fields: [{ name: "tags", type: { type: "array" } }],
      })
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.message.includes("items"))).toBe(true);
  });

  it("fails for map without values", () => {
    const result = validateAvroSchema(
      JSON.stringify({
        type: "record",
        name: "Test",
        fields: [{ name: "props", type: { type: "map" } }],
      })
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.message.includes("values"))).toBe(
      true
    );
  });
});

// ---------------------------------------------------------------------------
// Additional type mappings
// ---------------------------------------------------------------------------

describe("Avro Emitter — additional type mappings", () => {
  it("maps float to double", () => {
    const model = makeModel([
      makeField({ name: "rate", type: "float", sortOrder: 0 }),
    ]);
    const schema = emitAndParse(model);
    const field = (schema.fields as Record<string, unknown>[])[0];
    expect(field.type).toBe("double");
  });

  it("maps float32 to float", () => {
    const model = makeModel([
      makeField({ name: "ratio", type: "float32", sortOrder: 0 }),
    ]);
    const schema = emitAndParse(model);
    const field = (schema.fields as Record<string, unknown>[])[0];
    expect(field.type).toBe("float");
  });

  it("maps bytes to bytes", () => {
    const model = makeModel([
      makeField({ name: "data", type: "bytes", sortOrder: 0 }),
    ]);
    const schema = emitAndParse(model);
    const field = (schema.fields as Record<string, unknown>[])[0];
    expect(field.type).toBe("bytes");
  });
});

// ---------------------------------------------------------------------------
// Warnings for lossy mappings
// ---------------------------------------------------------------------------

describe("Avro Emitter — lossy mapping warnings", () => {
  it("emits warning for uint64 (lossy to long)", () => {
    const model = makeModel([
      makeField({ name: "big_id", type: "uint64", sortOrder: 0 }),
    ]);
    const result = avroEmitter.emit(model, defaultPolicies);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings[0].fieldName).toBe("big_id");
  });
});

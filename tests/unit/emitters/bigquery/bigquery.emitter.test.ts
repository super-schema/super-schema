/**
 * Unit tests for BigQuery DDL Emitter
 */

import { describe, it, expect } from "vitest";
import { BigQueryEmitter, toSnakeCase } from "@/emitters/bigquery/bigquery.emitter";
import { validateBigQueryDDL } from "@/emitters/bigquery/bigquery.validator";
import { getDefaultPolicies } from "@/lib/type-mapping/default-mappings";
import type { SuperSchemaModel, SuperSchemaField } from "@/types/super-schema-model";
import type { ScopedMappingPolicy } from "@/lib/type-mapping/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const emitter = new BigQueryEmitter();
const defaultPolicies = getDefaultPolicies();

function makeField(overrides: Partial<SuperSchemaField> & { name: string; type: SuperSchemaField["type"] }): SuperSchemaField {
  return {
    nullable: true,
    isKey: false,
    description: "",
    aliases: [],
    decorators: {},
    sortOrder: 0,
    ...overrides,
  };
}

function makeModel(fields: SuperSchemaField[], overrides?: Partial<SuperSchemaModel["entity"]>): SuperSchemaModel {
  return {
    entity: {
      id: "entity-1",
      name: "TestEntity",
      domain: "test_domain",
      domainId: "domain-1",
      description: "A test entity",
      status: "active",
      version: 1,
      metadata: {},
      ...overrides,
    },
    fields,
    relationships: [],
  };
}

// ---------------------------------------------------------------------------
// Emitter metadata
// ---------------------------------------------------------------------------

describe("BigQueryEmitter metadata", () => {
  it("has correct name, version, and targetFormat", () => {
    expect(emitter.name).toBe("bigquery");
    expect(emitter.version).toBe("1.0.0");
    expect(emitter.targetFormat).toBe("bigquery-ddl");
  });
});

// ---------------------------------------------------------------------------
// toSnakeCase
// ---------------------------------------------------------------------------

describe("toSnakeCase", () => {
  it("converts camelCase to snake_case", () => {
    expect(toSnakeCase("TestEntity")).toBe("test_entity");
    expect(toSnakeCase("myFieldName")).toBe("my_field_name");
  });

  it("handles spaces and hyphens", () => {
    expect(toSnakeCase("My Entity")).toBe("my_entity");
    expect(toSnakeCase("my-entity")).toBe("my_entity");
  });

  it("removes special characters", () => {
    expect(toSnakeCase("entity@name!")).toBe("entityname");
  });

  it("handles already snake_case names", () => {
    expect(toSnakeCase("already_snake")).toBe("already_snake");
  });
});

// ---------------------------------------------------------------------------
// Simple entity (3 fields: string, integer, boolean)
// ---------------------------------------------------------------------------

describe("BigQueryEmitter.emit — simple entity", () => {
  it("produces valid DDL for 3 basic fields", () => {
    const fields: SuperSchemaField[] = [
      makeField({ name: "name", type: "string", sortOrder: 0 }),
      makeField({ name: "age", type: "integer", sortOrder: 1 }),
      makeField({ name: "active", type: "boolean", sortOrder: 2 }),
    ];
    const model = makeModel(fields);
    const result = emitter.emit(model, defaultPolicies);

    expect(result.targetFormat).toBe("bigquery-ddl");
    expect(result.output).toContain("CREATE TABLE");
    expect(result.output).toContain("test_domain.test_entity");
    expect(result.output).toContain("name STRING");
    expect(result.output).toContain("age INT64");
    expect(result.output).toContain("active BOOL");

    // Validate the output
    const validation = emitter.validate(result.output);
    expect(validation.valid).toBe(true);
    expect(validation.errors).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Decimal precision/scale
// ---------------------------------------------------------------------------

describe("BigQueryEmitter.emit — decimal precision", () => {
  it("maps decimal(19,4) to NUMERIC(19,4)", () => {
    const fields: SuperSchemaField[] = [
      makeField({
        name: "amount",
        type: "decimal",
        precision: 19,
        scale: 4,
        sortOrder: 0,
      }),
    ];
    const model = makeModel(fields);
    const result = emitter.emit(model, defaultPolicies);

    expect(result.output).toContain("amount NUMERIC(19,4)");
  });

  it("maps decimal128 to BIGNUMERIC", () => {
    const fields: SuperSchemaField[] = [
      makeField({
        name: "big_amount",
        type: "decimal128",
        precision: 38,
        scale: 10,
        sortOrder: 0,
      }),
    ];
    const model = makeModel(fields);
    const result = emitter.emit(model, defaultPolicies);

    expect(result.output).toContain("big_amount BIGNUMERIC(38,10)");
  });
});

// ---------------------------------------------------------------------------
// Nullable / NOT NULL
// ---------------------------------------------------------------------------

describe("BigQueryEmitter.emit — nullable handling", () => {
  it("omits NOT NULL for nullable fields", () => {
    const fields: SuperSchemaField[] = [
      makeField({ name: "optional_field", type: "string", nullable: true, sortOrder: 0 }),
    ];
    const model = makeModel(fields);
    const result = emitter.emit(model, defaultPolicies);

    expect(result.output).toContain("optional_field STRING");
    expect(result.output).not.toContain("NOT NULL");
  });

  it("includes NOT NULL for non-nullable fields", () => {
    const fields: SuperSchemaField[] = [
      makeField({ name: "required_field", type: "string", nullable: false, sortOrder: 0 }),
    ];
    const model = makeModel(fields);
    const result = emitter.emit(model, defaultPolicies);

    expect(result.output).toContain("required_field STRING NOT NULL");
  });
});

// ---------------------------------------------------------------------------
// Column OPTIONS — description
// ---------------------------------------------------------------------------

describe("BigQueryEmitter.emit — column OPTIONS", () => {
  it("generates OPTIONS with description from semantics decorator", () => {
    const fields: SuperSchemaField[] = [
      makeField({
        name: "email",
        type: "string",
        sortOrder: 0,
        decorators: {
          semantics: { description: "User email address" },
        },
      }),
    ];
    const model = makeModel(fields);
    const result = emitter.emit(model, defaultPolicies);

    expect(result.output).toContain("OPTIONS(description='User email address')");
  });

  it("generates OPTIONS with description from field.description fallback", () => {
    const fields: SuperSchemaField[] = [
      makeField({
        name: "email",
        type: "string",
        description: "User email address",
        sortOrder: 0,
      }),
    ];
    const model = makeModel(fields);
    const result = emitter.emit(model, defaultPolicies);

    expect(result.output).toContain("OPTIONS(description='User email address')");
  });

  it("escapes single quotes in description", () => {
    const fields: SuperSchemaField[] = [
      makeField({
        name: "note",
        type: "string",
        sortOrder: 0,
        decorators: {
          semantics: { description: "User's note" },
        },
      }),
    ];
    const model = makeModel(fields);
    const result = emitter.emit(model, defaultPolicies);

    expect(result.output).toContain("description='User\\'s note'");
  });
});

// ---------------------------------------------------------------------------
// Column OPTIONS — classification labels
// ---------------------------------------------------------------------------

describe("BigQueryEmitter.emit — classification labels", () => {
  it("generates OPTIONS with classification label", () => {
    const fields: SuperSchemaField[] = [
      makeField({
        name: "ssn",
        type: "string",
        sortOrder: 0,
        decorators: {
          semantics: { description: "Social Security Number" },
          classification: { level: "PII" },
        },
      }),
    ];
    const model = makeModel(fields);
    const result = emitter.emit(model, defaultPolicies);

    expect(result.output).toContain(
      "OPTIONS(description='Social Security Number', labels=['classification:PII'])"
    );
  });

  it("generates OPTIONS with classification from field.classification fallback", () => {
    const fields: SuperSchemaField[] = [
      makeField({
        name: "ssn",
        type: "string",
        classification: "SENSITIVE",
        sortOrder: 0,
      }),
    ];
    const model = makeModel(fields);
    const result = emitter.emit(model, defaultPolicies);

    expect(result.output).toContain("labels=['classification:SENSITIVE']");
  });
});

// ---------------------------------------------------------------------------
// PARTITION BY
// ---------------------------------------------------------------------------

describe("BigQueryEmitter.emit — PARTITION BY", () => {
  it("generates PARTITION BY clause for a DATE field", () => {
    const fields: SuperSchemaField[] = [
      makeField({ name: "id", type: "string", sortOrder: 0 }),
      makeField({
        name: "created_date",
        type: "plainDate",
        sortOrder: 1,
        decorators: { operationalHints: { partition: true } },
      }),
    ];
    const model = makeModel(fields);
    const result = emitter.emit(model, defaultPolicies);

    expect(result.output).toContain("PARTITION BY created_date");
    const validation = emitter.validate(result.output);
    expect(validation.valid).toBe(true);
  });

  it("generates PARTITION BY clause for a TIMESTAMP field", () => {
    const fields: SuperSchemaField[] = [
      makeField({
        name: "event_time",
        type: "unixTimestamp32",
        sortOrder: 0,
        decorators: { operationalHints: { partition: true } },
      }),
    ];
    const model = makeModel(fields);
    const result = emitter.emit(model, defaultPolicies);

    expect(result.output).toContain("PARTITION BY event_time");
  });

  it("warns when partition field type is not partitionable", () => {
    const fields: SuperSchemaField[] = [
      makeField({
        name: "name",
        type: "string",
        sortOrder: 0,
        decorators: { operationalHints: { partition: true } },
      }),
    ];
    const model = makeModel(fields);
    const result = emitter.emit(model, defaultPolicies);

    expect(result.output).not.toContain("PARTITION BY");
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings[0].message).toContain("not partitionable");
  });
});

// ---------------------------------------------------------------------------
// CLUSTER BY
// ---------------------------------------------------------------------------

describe("BigQueryEmitter.emit — CLUSTER BY", () => {
  it("generates CLUSTER BY clause for clustered fields", () => {
    const fields: SuperSchemaField[] = [
      makeField({
        name: "region",
        type: "string",
        sortOrder: 0,
        decorators: { operationalHints: { cluster: true } },
      }),
      makeField({
        name: "status",
        type: "string",
        sortOrder: 1,
        decorators: { operationalHints: { cluster: true } },
      }),
    ];
    const model = makeModel(fields);
    const result = emitter.emit(model, defaultPolicies);

    expect(result.output).toContain("CLUSTER BY region, status");
    const validation = emitter.validate(result.output);
    expect(validation.valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Lossy mapping warning
// ---------------------------------------------------------------------------

describe("BigQueryEmitter.emit — lossy mapping warning", () => {
  it("produces warning SQL comment for map→STRUCT (lossy)", () => {
    const fields: SuperSchemaField[] = [
      makeField({
        name: "metadata",
        type: "map",
        sortOrder: 0,
        complexType: { mapKeyType: "string", mapValueType: "string" },
      }),
    ];
    const model = makeModel(fields);
    const result = emitter.emit(model, defaultPolicies);

    expect(result.output).toContain("-- WARNING:");
    expect(result.output).toContain("lossy");
    expect(result.output).toContain("metadata STRUCT");
    expect(result.warnings.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Empty entity
// ---------------------------------------------------------------------------

describe("BigQueryEmitter.emit — empty entity", () => {
  it("produces valid empty table DDL", () => {
    const model = makeModel([]);
    const result = emitter.emit(model, defaultPolicies);

    expect(result.output).toContain("CREATE TABLE");
    expect(result.output).toContain("test_domain.test_entity");

    const validation = emitter.validate(result.output);
    expect(validation.valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Array types
// ---------------------------------------------------------------------------

describe("BigQueryEmitter.emit — array types", () => {
  it("maps array with element type to ARRAY<T>", () => {
    const fields: SuperSchemaField[] = [
      makeField({
        name: "tags",
        type: "array",
        sortOrder: 0,
        complexType: { arrayElementType: "string" },
      }),
    ];
    const model = makeModel(fields);
    const result = emitter.emit(model, defaultPolicies);

    expect(result.output).toContain("tags ARRAY<STRING>");
  });

  it("maps array without element type to ARRAY<STRING>", () => {
    const fields: SuperSchemaField[] = [
      makeField({ name: "items", type: "array", sortOrder: 0 }),
    ];
    const model = makeModel(fields);
    const result = emitter.emit(model, defaultPolicies);

    expect(result.output).toContain("items ARRAY<STRING>");
  });
});

// ---------------------------------------------------------------------------
// Enum type
// ---------------------------------------------------------------------------

describe("BigQueryEmitter.emit — enum type", () => {
  it("maps enum to STRING", () => {
    const fields: SuperSchemaField[] = [
      makeField({ name: "status", type: "enum", sortOrder: 0 }),
    ];
    const model = makeModel(fields);
    const result = emitter.emit(model, defaultPolicies);

    expect(result.output).toContain("status STRING");
  });
});

// ---------------------------------------------------------------------------
// Reserved keywords
// ---------------------------------------------------------------------------

describe("BigQueryEmitter.emit — reserved keywords", () => {
  it("backtick-quotes reserved keyword column names", () => {
    const fields: SuperSchemaField[] = [
      makeField({ name: "select", type: "string", sortOrder: 0 }),
      makeField({ name: "from", type: "string", sortOrder: 1 }),
    ];
    const model = makeModel(fields);
    const result = emitter.emit(model, defaultPolicies);

    expect(result.output).toContain("`select` STRING");
    expect(result.output).toContain("`from` STRING");
  });
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

describe("BigQueryEmitter.emit — determinism", () => {
  it("produces identical output on multiple calls", () => {
    const fields: SuperSchemaField[] = [
      makeField({ name: "id", type: "string", nullable: false, sortOrder: 0 }),
      makeField({ name: "amount", type: "decimal", precision: 10, scale: 2, sortOrder: 1 }),
      makeField({
        name: "created_at",
        type: "plainDate",
        sortOrder: 2,
        decorators: { operationalHints: { partition: true } },
      }),
      makeField({
        name: "region",
        type: "string",
        sortOrder: 3,
        decorators: {
          operationalHints: { cluster: true },
          semantics: { description: "Geographic region" },
        },
      }),
    ];
    const model = makeModel(fields);

    const result1 = emitter.emit(model, defaultPolicies);
    const result2 = emitter.emit(model, defaultPolicies);
    const result3 = emitter.emit(model, defaultPolicies);

    expect(result1.output).toBe(result2.output);
    expect(result2.output).toBe(result3.output);
  });
});

// ---------------------------------------------------------------------------
// Entity name conversion
// ---------------------------------------------------------------------------

describe("BigQueryEmitter.emit — entity name", () => {
  it("converts camelCase entity name to snake_case", () => {
    const model = makeModel([], { name: "UserProfile" });
    const result = emitter.emit(model, defaultPolicies);

    expect(result.output).toContain("test_domain.user_profile");
  });

  it("handles domain prefix in table name", () => {
    const model = makeModel([], { name: "Order", domain: "commerce" });
    const result = emitter.emit(model, defaultPolicies);

    expect(result.output).toContain("commerce.order");
  });
});

// ---------------------------------------------------------------------------
// Validator — pass cases
// ---------------------------------------------------------------------------

describe("validateBigQueryDDL — valid DDL", () => {
  it("passes for a simple valid DDL", () => {
    const ddl = `CREATE TABLE dataset.my_table (
  id STRING NOT NULL,
  name STRING,
  age INT64
);
`;
    const result = validateBigQueryDDL(ddl);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("passes for DDL with PARTITION BY and CLUSTER BY", () => {
    const ddl = `CREATE TABLE dataset.events (
  event_date DATE,
  region STRING,
  user_id STRING
)
PARTITION BY event_date
CLUSTER BY region, user_id;
`;
    const result = validateBigQueryDDL(ddl);
    expect(result.valid).toBe(true);
  });

  it("passes for DDL with OPTIONS", () => {
    const ddl = `CREATE TABLE dataset.users (
  email STRING OPTIONS(description='User email', labels=['classification:PII'])
);
`;
    const result = validateBigQueryDDL(ddl);
    expect(result.valid).toBe(true);
  });

  it("passes for DDL with ARRAY type", () => {
    const ddl = `CREATE TABLE dataset.users (
  tags ARRAY<STRING>
);
`;
    const result = validateBigQueryDDL(ddl);
    expect(result.valid).toBe(true);
  });

  it("passes for empty table DDL", () => {
    const ddl = `CREATE TABLE dataset.empty_table (
);
`;
    const result = validateBigQueryDDL(ddl);
    expect(result.valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Validator — fail cases
// ---------------------------------------------------------------------------

describe("validateBigQueryDDL — invalid DDL", () => {
  it("fails for empty string", () => {
    const result = validateBigQueryDDL("");
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("fails for DDL without CREATE TABLE", () => {
    const result = validateBigQueryDDL("SELECT * FROM table;");
    expect(result.valid).toBe(false);
  });

  it("fails for DDL without closing parenthesis", () => {
    const result = validateBigQueryDDL("CREATE TABLE t (id STRING");
    expect(result.valid).toBe(false);
  });

  it("fails for DDL without semicolon", () => {
    const result = validateBigQueryDDL("CREATE TABLE t (\n  id STRING\n)");
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.message.includes("semicolon"))).toBe(true);
  });

  it("fails for DDL with invalid column type", () => {
    const result = validateBigQueryDDL("CREATE TABLE t (\n  id INVALID_TYPE\n);");
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.message.includes("Invalid BigQuery column type"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Combined PARTITION + CLUSTER + OPTIONS
// ---------------------------------------------------------------------------

describe("BigQueryEmitter.emit — combined features", () => {
  it("generates DDL with PARTITION, CLUSTER, and OPTIONS together", () => {
    const fields: SuperSchemaField[] = [
      makeField({
        name: "user_id",
        type: "string",
        nullable: false,
        sortOrder: 0,
        decorators: {
          semantics: { description: "Unique user identifier" },
          classification: { level: "PII" },
          operationalHints: { cluster: true },
        },
      }),
      makeField({
        name: "event_date",
        type: "plainDate",
        sortOrder: 1,
        decorators: { operationalHints: { partition: true } },
      }),
      makeField({
        name: "amount",
        type: "decimal",
        precision: 19,
        scale: 4,
        nullable: false,
        sortOrder: 2,
      }),
    ];
    const model = makeModel(fields);
    const result = emitter.emit(model, defaultPolicies);

    expect(result.output).toContain("user_id STRING NOT NULL OPTIONS(description='Unique user identifier', labels=['classification:PII'])");
    expect(result.output).toContain("event_date DATE");
    expect(result.output).toContain("amount NUMERIC(19,4) NOT NULL");
    expect(result.output).toContain("PARTITION BY event_date");
    expect(result.output).toContain("CLUSTER BY user_id");

    const validation = emitter.validate(result.output);
    expect(validation.valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// All type mappings
// ---------------------------------------------------------------------------

describe("BigQueryEmitter.emit — all logical types", () => {
  const typeMappings: Array<{ logicalType: SuperSchemaField["type"]; expectedBq: string }> = [
    { logicalType: "string", expectedBq: "STRING" },
    { logicalType: "url", expectedBq: "STRING" },
    { logicalType: "integer", expectedBq: "INT64" },
    { logicalType: "int64", expectedBq: "INT64" },
    { logicalType: "float", expectedBq: "FLOAT64" },
    { logicalType: "float64", expectedBq: "FLOAT64" },
    { logicalType: "boolean", expectedBq: "BOOL" },
    { logicalType: "bytes", expectedBq: "BYTES" },
    { logicalType: "plainDate", expectedBq: "DATE" },
    { logicalType: "plainTime", expectedBq: "TIME" },
    { logicalType: "utcDateTime", expectedBq: "DATETIME" },
    { logicalType: "enum", expectedBq: "STRING" },
  ];

  for (const { logicalType, expectedBq } of typeMappings) {
    it(`maps ${logicalType} to ${expectedBq}`, () => {
      const fields = [makeField({ name: "test_col", type: logicalType, sortOrder: 0 })];
      const model = makeModel(fields);
      const result = emitter.emit(model, defaultPolicies);

      expect(result.output).toContain(`test_col ${expectedBq}`);
    });
  }
});

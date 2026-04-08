/**
 * Unit tests for Spanner DDL Emitter
 */

import { describe, it, expect } from "vitest";
import { SpannerEmitter } from "@/emitters/spanner/spanner.emitter";
import { validateSpannerDDL } from "@/emitters/spanner/spanner.validator";
import { getDefaultPolicies } from "@/lib/type-mapping/default-mappings";
import type { SuperSchemaModel, SuperSchemaField } from "@/types/super-schema-model";
import type { ScopedMappingPolicy } from "@/lib/type-mapping/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const emitter = new SpannerEmitter();
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

describe("SpannerEmitter metadata", () => {
  it("has correct name, version, and targetFormat", () => {
    expect(emitter.name).toBe("spanner");
    expect(emitter.version).toBe("1.0.0");
    expect(emitter.targetFormat).toBe("spanner-ddl");
  });
});

// ---------------------------------------------------------------------------
// Basic DDL generation
// ---------------------------------------------------------------------------

describe("SpannerEmitter emit", () => {
  it("generates CREATE TABLE for a simple entity", () => {
    const model = makeModel([
      makeField({ name: "id", type: "string", isKey: true, nullable: false, sortOrder: 0 }),
      makeField({ name: "name", type: "string", sortOrder: 1 }),
      makeField({ name: "age", type: "int32", sortOrder: 2 }),
    ]);

    const result = emitter.emit(model, defaultPolicies);
    expect(result.output).toContain("CREATE TABLE test_entity");
    expect(result.output).toContain("id STRING(MAX) NOT NULL");
    expect(result.output).toContain("name STRING(MAX)");
    expect(result.output).toContain("age INT64");
    expect(result.output).toContain("PRIMARY KEY (id)");
  });

  it("generates valid DDL that passes validation", () => {
    const model = makeModel([
      makeField({ name: "id", type: "string", isKey: true, nullable: false }),
      makeField({ name: "email", type: "string" }),
    ]);

    const result = emitter.emit(model, defaultPolicies);
    const validation = validateSpannerDDL(result.output);
    expect(validation.valid).toBe(true);
  });

  it("places key columns first", () => {
    const model = makeModel([
      makeField({ name: "name", type: "string", sortOrder: 0 }),
      makeField({ name: "id", type: "string", isKey: true, nullable: false, sortOrder: 1 }),
    ]);

    const result = emitter.emit(model, defaultPolicies);
    const idPos = result.output.indexOf("id STRING(MAX)");
    const namePos = result.output.indexOf("name STRING(MAX)");
    expect(idPos).toBeLessThan(namePos);
  });

  it("handles empty entity", () => {
    const model = makeModel([]);
    const result = emitter.emit(model, defaultPolicies);
    expect(result.output).toContain("CREATE TABLE test_entity");
    expect(result.warnings).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Type mapping
// ---------------------------------------------------------------------------

describe("SpannerEmitter type mappings", () => {
  it("maps boolean to BOOL", () => {
    const model = makeModel([
      makeField({ name: "active", type: "boolean" }),
    ]);
    const result = emitter.emit(model, defaultPolicies);
    expect(result.output).toContain("active BOOL");
  });

  it("maps plainDate to DATE", () => {
    const model = makeModel([
      makeField({ name: "birthday", type: "plainDate" }),
    ]);
    const result = emitter.emit(model, defaultPolicies);
    expect(result.output).toContain("birthday DATE");
  });

  it("maps utcDateTime to TIMESTAMP", () => {
    const model = makeModel([
      makeField({ name: "createdAt", type: "utcDateTime" }),
    ]);
    const result = emitter.emit(model, defaultPolicies);
    expect(result.output).toContain("created_at TIMESTAMP");
  });

  it("maps bytes to BYTES(MAX)", () => {
    const model = makeModel([
      makeField({ name: "data", type: "bytes" }),
    ]);
    const result = emitter.emit(model, defaultPolicies);
    expect(result.output).toContain("data BYTES(MAX)");
  });

  it("maps map to JSON with lossy warning", () => {
    const model = makeModel([
      makeField({ name: "metadata", type: "map" }),
    ]);
    const result = emitter.emit(model, defaultPolicies);
    expect(result.output).toContain("metadata JSON");
    expect(result.warnings.some((w) => w.message.includes("lossy"))).toBe(true);
  });

  it("maps object to JSON", () => {
    const model = makeModel([
      makeField({ name: "config", type: "object" }),
    ]);
    const result = emitter.emit(model, defaultPolicies);
    expect(result.output).toContain("config JSON");
  });

  it("maps array with element type", () => {
    const model = makeModel([
      makeField({
        name: "tags",
        type: "array",
        complexType: { arrayElementType: "string" },
      }),
    ]);
    const result = emitter.emit(model, defaultPolicies);
    expect(result.output).toContain("tags ARRAY<STRING(MAX)>");
  });

  it("maps decimal to NUMERIC with lossy warning", () => {
    const model = makeModel([
      makeField({ name: "amount", type: "decimal", precision: 19, scale: 4 }),
    ]);
    const result = emitter.emit(model, defaultPolicies);
    expect(result.output).toContain("amount NUMERIC");
  });

  it("maps plainTime to STRING(MAX) with lossy warning", () => {
    const model = makeModel([
      makeField({ name: "startTime", type: "plainTime" }),
    ]);
    const result = emitter.emit(model, defaultPolicies);
    expect(result.output).toContain("start_time STRING(MAX)");
    expect(result.warnings.some((w) => w.message.includes("TIME"))).toBe(true);
  });

  it("maps duration to STRING(MAX) with lossy warning", () => {
    const model = makeModel([
      makeField({ name: "ttl", type: "duration" }),
    ]);
    const result = emitter.emit(model, defaultPolicies);
    expect(result.output).toContain("ttl STRING(MAX)");
    expect(result.warnings.some((w) => w.message.includes("duration"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// STRING with maxLength
// ---------------------------------------------------------------------------

describe("SpannerEmitter STRING length", () => {
  it("uses maxLength when specified", () => {
    const model = makeModel([
      makeField({
        name: "email",
        type: "string",
        decorators: {
          typespec: {
            validation: { maxLength: 255 },
          },
        },
      }),
    ]);
    const result = emitter.emit(model, defaultPolicies);
    expect(result.output).toContain("email STRING(255)");
  });
});

// ---------------------------------------------------------------------------
// NOT NULL handling
// ---------------------------------------------------------------------------

describe("SpannerEmitter nullable", () => {
  it("adds NOT NULL for non-nullable fields", () => {
    const model = makeModel([
      makeField({ name: "id", type: "string", nullable: false }),
    ]);
    const result = emitter.emit(model, defaultPolicies);
    expect(result.output).toContain("NOT NULL");
  });

  it("omits NOT NULL for nullable fields", () => {
    const model = makeModel([
      makeField({ name: "name", type: "string", nullable: true }),
    ]);
    const result = emitter.emit(model, defaultPolicies);
    expect(result.output).not.toMatch(/name STRING\(MAX\) NOT NULL/);
  });
});

describe("SpannerEmitter field overrides", () => {
  it("uses field-level type overrides and emits the provenance comment", () => {
    const policies: ScopedMappingPolicy[] = [
      ...defaultPolicies,
      {
        sourceType: "string",
        targetType: "STRING(36)",
        targetFormat: "spanner",
        mappedType: "STRING(36)",
        isOverride: true,
        isLossy: false,
        fieldId: "field-id",
      },
    ];

    const result = emitter.emit(
      makeModel([
        makeField({
          id: "field-id",
          name: "customerId",
          type: "string",
          nullable: false,
          sortOrder: 0,
        }),
      ]),
      policies
    );

    expect(result.output).toContain("customer_id STRING(36) NOT NULL");
    expect(result.output).toContain("SUPER SCHEMA TYPE OVERRIDE");
  });
});

// ---------------------------------------------------------------------------
// INTERLEAVE IN PARENT (inheritance)
// ---------------------------------------------------------------------------

describe("SpannerEmitter inheritance", () => {
  it("generates INTERLEAVE IN PARENT for inherited entities", () => {
    const model = makeModel(
      [makeField({ name: "id", type: "string", isKey: true, nullable: false })],
      { name: "ChildEntity", parentEntityName: "ParentEntity" }
    );
    const result = emitter.emit(model, defaultPolicies);
    expect(result.output).toContain("INTERLEAVE IN PARENT parent_entity ON DELETE CASCADE");
  });

  it("does not add INTERLEAVE for entities without parent", () => {
    const model = makeModel([
      makeField({ name: "id", type: "string", isKey: true, nullable: false }),
    ]);
    const result = emitter.emit(model, defaultPolicies);
    expect(result.output).not.toContain("INTERLEAVE");
  });
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

describe("SpannerEmitter determinism", () => {
  it("produces identical output for identical input", () => {
    const model = makeModel([
      makeField({ name: "id", type: "string", isKey: true, nullable: false, sortOrder: 0 }),
      makeField({ name: "name", type: "string", sortOrder: 1 }),
      makeField({ name: "age", type: "int32", sortOrder: 2 }),
    ]);

    const result1 = emitter.emit(model, defaultPolicies);
    const result2 = emitter.emit(model, defaultPolicies);
    expect(result1.output).toBe(result2.output);
  });
});

// ---------------------------------------------------------------------------
// Lossy warning comments
// ---------------------------------------------------------------------------

describe("SpannerEmitter lossy warnings", () => {
  it("emits SQL comment for lossy mappings", () => {
    const model = makeModel([
      makeField({ name: "elapsed", type: "duration" }),
    ]);
    const result = emitter.emit(model, defaultPolicies);
    expect(result.output).toContain("-- WARNING:");
    expect(result.output).toContain("lossy");
  });
});

// ---------------------------------------------------------------------------
// Validator
// ---------------------------------------------------------------------------

describe("validateSpannerDDL", () => {
  it("accepts valid DDL", () => {
    const ddl = `CREATE TABLE users (
  id STRING(MAX) NOT NULL,
  name STRING(MAX)
) PRIMARY KEY (id);
`;
    const result = validateSpannerDDL(ddl);
    expect(result.valid).toBe(true);
  });

  it("rejects empty DDL", () => {
    const result = validateSpannerDDL("");
    expect(result.valid).toBe(false);
  });

  it("rejects DDL without CREATE TABLE", () => {
    const result = validateSpannerDDL("SELECT * FROM users;");
    expect(result.valid).toBe(false);
  });

  it("rejects DDL without semicolon", () => {
    const result = validateSpannerDDL("CREATE TABLE users (\n  id INT64\n) PRIMARY KEY (id)");
    expect(result.valid).toBe(false);
  });

  it("rejects invalid column types", () => {
    const ddl = `CREATE TABLE users (
  id BIGINT NOT NULL
) PRIMARY KEY (id);
`;
    const result = validateSpannerDDL(ddl);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.message.includes("Invalid Spanner column type"))).toBe(true);
  });

  it("accepts ARRAY<STRING(MAX)>", () => {
    const ddl = `CREATE TABLE users (
  tags ARRAY<STRING(MAX)>
);
`;
    const result = validateSpannerDDL(ddl);
    expect(result.valid).toBe(true);
  });
});

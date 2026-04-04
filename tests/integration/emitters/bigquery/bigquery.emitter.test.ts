/**
 * Integration test for BigQuery DDL Emitter
 *
 * Tests a real entity with 10+ fields of mixed types,
 * verifying end-to-end emit + validate.
 */

import { describe, it, expect } from "vitest";
import { BigQueryEmitter } from "@/emitters/bigquery/bigquery.emitter";
import { getDefaultPolicies } from "@/lib/type-mapping/default-mappings";
import type { SuperSchemaModel, SuperSchemaField } from "@/types/super-schema-model";

const emitter = new BigQueryEmitter();
const defaultPolicies = getDefaultPolicies();

function makeField(
  overrides: Partial<SuperSchemaField> & { name: string; type: SuperSchemaField["type"] }
): SuperSchemaField {
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

describe("BigQuery Emitter — integration", () => {
  it("emits syntactically valid DDL for a real entity with 10+ fields of mixed types", () => {
    const fields: SuperSchemaField[] = [
      makeField({
        name: "userId",
        type: "string",
        nullable: false,
        isKey: true,
        sortOrder: 0,
        description: "Unique user identifier",
        decorators: {
          semantics: { description: "Unique user identifier" },
          classification: { level: "PII" },
          operationalHints: { cluster: true },
        },
      }),
      makeField({
        name: "fullName",
        type: "string",
        sortOrder: 1,
        decorators: {
          semantics: { description: "Full legal name" },
          classification: { level: "PII" },
        },
      }),
      makeField({
        name: "age",
        type: "integer",
        sortOrder: 2,
        decorators: { semantics: { description: "Age in years" } },
      }),
      makeField({
        name: "accountBalance",
        type: "decimal",
        precision: 19,
        scale: 4,
        nullable: false,
        sortOrder: 3,
        decorators: { semantics: { description: "Current balance" } },
      }),
      makeField({
        name: "isActive",
        type: "boolean",
        sortOrder: 4,
        decorators: { semantics: { description: "Whether the account is active" } },
      }),
      makeField({
        name: "rating",
        type: "float",
        sortOrder: 5,
      }),
      makeField({
        name: "createdDate",
        type: "plainDate",
        sortOrder: 6,
        decorators: {
          operationalHints: { partition: true },
          semantics: { description: "Account creation date" },
        },
      }),
      makeField({
        name: "lastLogin",
        type: "utcDateTime",
        sortOrder: 7,
      }),
      makeField({
        name: "accountType",
        type: "enum",
        sortOrder: 8,
        decorators: { semantics: { description: "Type of account" } },
      }),
      makeField({
        name: "tags",
        type: "array",
        sortOrder: 9,
        complexType: { arrayElementType: "string" },
        decorators: { semantics: { description: "User tags" } },
      }),
      makeField({
        name: "preferences",
        type: "map",
        sortOrder: 10,
        complexType: { mapKeyType: "string", mapValueType: "string" },
        decorators: { semantics: { description: "User preferences" } },
      }),
      makeField({
        name: "loginCount",
        type: "int64",
        sortOrder: 11,
      }),
    ];

    const model: SuperSchemaModel = {
      entity: {
        id: "user-entity-1",
        name: "UserAccount",
        domain: "identity",
        domainId: "domain-identity",
        description: "Represents a user account in the system",
        status: "active",
        version: 1,
        metadata: {
          tags: ["user", "identity"],
        },
      },
      fields,
      relationships: [],
    };

    // Emit
    const result = emitter.emit(model, defaultPolicies);

    // Basic structure
    expect(result.output).toContain("CREATE TABLE identity.user_account");
    expect(result.targetFormat).toBe("bigquery-ddl");

    // Column types
    expect(result.output).toContain("user_id STRING NOT NULL");
    expect(result.output).toContain("full_name STRING");
    expect(result.output).toContain("age INT64");
    expect(result.output).toContain("account_balance NUMERIC(19,4) NOT NULL");
    expect(result.output).toContain("is_active BOOL");
    expect(result.output).toContain("rating FLOAT64");
    expect(result.output).toContain("created_date DATE");
    expect(result.output).toContain("last_login DATETIME");
    expect(result.output).toContain("account_type STRING");
    expect(result.output).toContain("tags ARRAY<STRING>");
    expect(result.output).toContain("preferences STRUCT");
    expect(result.output).toContain("login_count INT64");

    // OPTIONS
    expect(result.output).toContain("OPTIONS(description='Unique user identifier', labels=['classification:PII'])");
    expect(result.output).toContain("OPTIONS(description='Full legal name', labels=['classification:PII'])");

    // PARTITION BY
    expect(result.output).toContain("PARTITION BY created_date");

    // CLUSTER BY
    expect(result.output).toContain("CLUSTER BY user_id");

    // Lossy warning for map type
    expect(result.output).toContain("-- WARNING:");
    expect(result.warnings.some((w) => w.fieldName === "preferences")).toBe(true);

    // Validate the output
    const validation = emitter.validate(result.output);
    expect(validation.valid).toBe(true);
    expect(validation.errors).toHaveLength(0);
  });

  it("full round-trip: emit then validate produces valid result", () => {
    const fields: SuperSchemaField[] = [
      makeField({ name: "id", type: "string", nullable: false, sortOrder: 0 }),
      makeField({ name: "value", type: "decimal", precision: 10, scale: 2, sortOrder: 1 }),
      makeField({
        name: "timestamp",
        type: "utcDateTime",
        sortOrder: 2,
        decorators: { operationalHints: { partition: true } },
      }),
    ];

    const model: SuperSchemaModel = {
      entity: {
        id: "txn-1",
        name: "Transaction",
        domain: "finance",
        domainId: "domain-fin",
        description: "A financial transaction",
        status: "active",
        version: 1,
        metadata: {},
      },
      fields,
      relationships: [],
    };

    const emitResult = emitter.emit(model, defaultPolicies);
    const validateResult = emitter.validate(emitResult.output);

    expect(validateResult.valid).toBe(true);
    expect(validateResult.errors).toHaveLength(0);

    // Verify the DDL is non-empty and well-structured
    expect(emitResult.output.length).toBeGreaterThan(50);
    expect(emitResult.output).toMatch(/^CREATE TABLE/);
    expect(emitResult.output.trim()).toMatch(/;$/);
  });
});

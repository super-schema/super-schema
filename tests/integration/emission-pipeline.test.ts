/**
 * Emission pipeline integration tests.
 *
 * Tests the full compile -> emit pipeline using emitFromData()
 * (the pure function variant that requires no database).
 * Verifies BigQuery DDL, Avro JSON, and OpenAPI output for a realistic entity.
 */

import { describe, it, expect } from "vitest";
import { emitFromData } from "@/lib/emission/emit-from-data";
import type { PrismaEntityInput, PrismaFieldInput } from "@/lib/compiler/compiler.service";

// ---------------------------------------------------------------------------
// Realistic test entity: Customer with id, name, email, created_at, balance
// ---------------------------------------------------------------------------

const customerEntity: PrismaEntityInput = {
  id: "ent-cust-1",
  name: "Customer",
  description: "A customer record in the CRM domain",
  status: "ACTIVE",
  version: 1,
  domainId: "dom-crm-1",
  metadata: null,
  domain: { id: "dom-crm-1", name: "CRM", slug: "crm" },
};

const customerFields: PrismaFieldInput[] = [
  {
    id: "f-id",
    name: "id",
    type: "string",
    precision: null,
    scale: null,
    nullable: false,
    isKey: true,
    fieldNumber: null,
    description: "Unique customer identifier",
    classification: null,
    aliases: [],
    decorators: {
      typespec: {
        identity: { format: "uuid" },
      },
    },
    sortOrder: 0,
  },
  {
    id: "f-name",
    name: "name",
    type: "string",
    precision: null,
    scale: null,
    nullable: false,
    isKey: false,
    fieldNumber: null,
    description: "Full name",
    classification: "PII",
    aliases: [],
    decorators: {
      typespec: {
        validation: { minLength: 1, maxLength: 200 },
      },
    },
    sortOrder: 1,
  },
  {
    id: "f-email",
    name: "email",
    type: "string",
    precision: null,
    scale: null,
    nullable: false,
    isKey: false,
    fieldNumber: null,
    description: "Contact email",
    classification: "PII",
    aliases: [],
    decorators: {
      typespec: {
        identity: { format: "email" },
        validation: { maxLength: 320 },
      },
    },
    sortOrder: 2,
  },
  {
    id: "f-created",
    name: "created_at",
    type: "utcDateTime",
    precision: null,
    scale: null,
    nullable: false,
    isKey: false,
    fieldNumber: null,
    description: "Account creation timestamp",
    classification: null,
    aliases: [],
    decorators: {},
    sortOrder: 3,
  },
  {
    id: "f-balance",
    name: "balance",
    type: "decimal",
    precision: 18,
    scale: 2,
    nullable: true,
    isKey: false,
    fieldNumber: null,
    description: "Current account balance",
    classification: "SENSITIVE",
    aliases: [],
    decorators: {},
    sortOrder: 4,
  },
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Emission Pipeline - Integration", () => {
  // Run the pipeline once and reuse the result
  const result = emitFromData(customerEntity, customerFields);

  it("pipeline succeeds and emits to all 4 targets", () => {
    expect(result.success).toBe(true);
    expect(result.summary.totalTargets).toBe(4);
    expect(result.targets.bigquery).toBeDefined();
    expect(result.targets.avro).toBeDefined();
    expect(result.targets.openapi).toBeDefined();
    expect(result.targets.spanner).toBeDefined();
  });

  it("generates valid TypeSpec source", () => {
    expect(result.typespec).toContain("model Customer");
    expect(result.typespec).toContain("id");
    expect(result.typespec).toContain("name");
    expect(result.typespec).toContain("email");
    expect(result.typespec).toContain("created_at");
    expect(result.typespec).toContain("balance");
  });

  // -----------------------------------------------------------------------
  // BigQuery
  // -----------------------------------------------------------------------
  describe("BigQuery output", () => {
    it("contains CREATE TABLE with correct column types", () => {
      const bq = result.targets.bigquery;
      expect(bq.isValid).toBe(true);

      const ddl = bq.output;
      expect(ddl).toContain("CREATE TABLE");
      // BigQuery emitter lowercases table names (e.g. crm.customer)
      expect(ddl.toLowerCase()).toContain("customer");

      // Verify mapped types
      expect(ddl).toContain("STRING"); // id, name, email are STRING
      expect(ddl).toContain("DATETIME"); // utcDateTime -> DATETIME
      expect(ddl).toContain("NUMERIC"); // decimal -> NUMERIC
    });

    it("marks id as NOT NULL", () => {
      const ddl = result.targets.bigquery.output;
      // The id field should be NOT NULL since nullable=false
      expect(ddl).toMatch(/id\s+STRING\s+NOT\s+NULL/i);
    });
  });

  // -----------------------------------------------------------------------
  // Avro
  // -----------------------------------------------------------------------
  describe("Avro output", () => {
    it("is valid JSON with correct field types", () => {
      const avro = result.targets.avro;
      expect(avro.isValid).toBe(true);

      const schema = JSON.parse(avro.output);
      expect(schema.type).toBe("record");
      expect(schema.name).toBe("Customer");
      expect(Array.isArray(schema.fields)).toBe(true);

      // Find specific fields and verify types
      const fields = schema.fields as Array<{
        name: string;
        type: unknown;
      }>;

      const idField = fields.find((f) => f.name === "id");
      expect(idField).toBeDefined();
      // id is non-nullable string -> type should be "string"
      expect(idField!.type).toBe("string");

      const balanceField = fields.find((f) => f.name === "balance");
      expect(balanceField).toBeDefined();
      // balance is nullable decimal -> type should include null union
      // Avro represents nullable as ["null", actualType]
      expect(Array.isArray(balanceField!.type)).toBe(true);

      const createdField = fields.find((f) => f.name === "created_at");
      expect(createdField).toBeDefined();
    });
  });

  // -----------------------------------------------------------------------
  // OpenAPI
  // -----------------------------------------------------------------------
  describe("OpenAPI output", () => {
    it("has correct schema properties", () => {
      const openapi = result.targets.openapi;
      expect(openapi.isValid).toBe(true);

      // OpenAPI output should be valid JSON or YAML
      let schema: Record<string, unknown>;
      try {
        schema = JSON.parse(openapi.output);
      } catch {
        // If it's YAML, skip JSON-specific assertions but verify key content
        expect(openapi.output).toContain("Customer");
        expect(openapi.output).toContain("properties");
        return;
      }

      // Verify schema structure
      expect(schema.type).toBe("object");

      const properties = schema.properties as Record<
        string,
        Record<string, unknown>
      >;
      expect(properties).toBeDefined();

      // Verify field presence
      expect(properties.id).toBeDefined();
      expect(properties.name).toBeDefined();
      expect(properties.email).toBeDefined();
      expect(properties.created_at).toBeDefined();
      expect(properties.balance).toBeDefined();

      // id should be string type
      expect(properties.id.type).toBe("string");
    });

    it("includes required fields in required array", () => {
      const openapi = result.targets.openapi;
      let schema: Record<string, unknown>;
      try {
        schema = JSON.parse(openapi.output);
      } catch {
        // If YAML, verify text content
        expect(openapi.output).toContain("required");
        return;
      }

      const required = schema.required as string[];
      if (required) {
        // Non-nullable fields should be in required array
        expect(required).toContain("id");
        expect(required).toContain("name");
        expect(required).toContain("email");
        expect(required).toContain("created_at");
        // Nullable field should NOT be required
        expect(required).not.toContain("balance");
      }
    });
  });

  // -----------------------------------------------------------------------
  // Lossy mapping warnings for decimal -> OpenAPI
  // -----------------------------------------------------------------------
  describe("Lossy mapping warnings", () => {
    it("produces a lossy warning for decimal -> OpenAPI", () => {
      const openapi = result.targets.openapi;
      // decimal -> number/double is a lossy mapping
      const hasDecimalWarning = openapi.warnings.some(
        (w) =>
          w.message.toLowerCase().includes("decimal") ||
          w.message.toLowerCase().includes("lossy") ||
          w.message.toLowerCase().includes("precision")
      );
      expect(hasDecimalWarning).toBe(true);
    });

    it("OpenAPI has WARNING validation status due to lossy decimal", () => {
      const openapi = result.targets.openapi;
      expect(openapi.validationStatus).toBe("WARNING");
    });
  });
});

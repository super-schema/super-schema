/**
 * Unit tests for the emission service orchestration.
 *
 * Tests the emitFromData() pure function which:
 * - Compiles entity + fields to SuperSchemaModel IR
 * - Generates TypeSpec source
 * - Runs all registered emitters (BigQuery, Avro, OpenAPI)
 * - Collects per-target results with validation status
 */

import { describe, it, expect } from "vitest";
import { emitFromData } from "@/lib/emission/emit-from-data";
import type { PrismaEntityInput, PrismaFieldInput } from "@/lib/compiler/compiler.service";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEntity(overrides?: Partial<PrismaEntityInput>): PrismaEntityInput {
  return {
    id: "entity-1",
    name: "Customer",
    description: "A customer entity",
    status: "ACTIVE",
    version: 1,
    domainId: "domain-1",
    metadata: {},
    domain: { id: "domain-1", name: "Sales", slug: "sales" },
    ...overrides,
  };
}

function makeField(
  overrides: Partial<PrismaFieldInput> & { name: string; type: string }
): PrismaFieldInput {
  return {
    id: `field-${overrides.name}`,
    precision: null,
    scale: null,
    nullable: true,
    isKey: false,
    fieldNumber: null,
    description: "",
    classification: null,
    aliases: [],
    decorators: {},
    sortOrder: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("emission.service", () => {
  describe("emitFromData", () => {
    it("runs all three emitters and returns results", () => {
      const entity = makeEntity();
      const fields = [
        makeField({ name: "id", type: "string", isKey: true, sortOrder: 0 }),
        makeField({ name: "name", type: "string", sortOrder: 1 }),
        makeField({ name: "email", type: "string", sortOrder: 2 }),
      ];

      const result = emitFromData(entity, fields);

      // Should have all three targets
      expect(result.targets).toHaveProperty("bigquery");
      expect(result.targets).toHaveProperty("avro");
      expect(result.targets).toHaveProperty("openapi");

      // Summary should reflect 3 targets
      expect(result.summary.totalTargets).toBe(3);
    });

    it("generates TypeSpec source", () => {
      const entity = makeEntity();
      const fields = [
        makeField({ name: "id", type: "string", isKey: true, sortOrder: 0 }),
      ];

      const result = emitFromData(entity, fields);

      expect(result.typespec).toBeTruthy();
      expect(result.typespec).toContain("model Customer");
      expect(result.typespec).toContain("id");
    });

    it("sets VALID status for targets with no warnings or errors", () => {
      const entity = makeEntity();
      const fields = [
        makeField({ name: "id", type: "string", isKey: true, sortOrder: 0 }),
        makeField({ name: "name", type: "string", sortOrder: 1 }),
      ];

      const result = emitFromData(entity, fields);

      // All string fields should map without lossy warnings
      for (const [, target] of Object.entries(result.targets)) {
        if (target.warnings.length === 0 && target.isValid) {
          expect(target.validationStatus).toBe("VALID");
        }
      }
    });

    it("sets WARNING status for targets with lossy mappings", () => {
      const entity = makeEntity();
      const fields = [
        makeField({ name: "id", type: "string", isKey: true, sortOrder: 0 }),
        makeField({
          name: "amount",
          type: "decimal",
          sortOrder: 1,
          precision: 10,
          scale: 2,
        }),
      ];

      const result = emitFromData(entity, fields);

      // OpenAPI maps decimal to number/double which is lossy
      const openapi = result.targets.openapi;
      expect(openapi).toBeDefined();
      if (openapi.warnings.length > 0) {
        expect(openapi.validationStatus).toBe("WARNING");
      }
    });

    it("collects warnings from lossy mappings", () => {
      const entity = makeEntity();
      const fields = [
        makeField({ name: "id", type: "string", isKey: true, sortOrder: 0 }),
        makeField({ name: "timestamp", type: "offsetDateTime", sortOrder: 1 }),
      ];

      const result = emitFromData(entity, fields);

      // offsetDateTime is lossy in BigQuery and Avro
      const bq = result.targets.bigquery;
      const avro = result.targets.avro;

      // At least one should have warnings about lossy mapping
      const totalWarnings = bq.warnings.length + avro.warnings.length;
      expect(totalWarnings).toBeGreaterThan(0);
    });

    it("returns success=true when all targets are valid", () => {
      const entity = makeEntity();
      const fields = [
        makeField({ name: "id", type: "string", isKey: true, sortOrder: 0 }),
      ];

      const result = emitFromData(entity, fields);

      expect(result.success).toBe(true);
      expect(result.summary.invalidCount).toBe(0);
    });

    it("produces non-empty output for each target", () => {
      const entity = makeEntity();
      const fields = [
        makeField({ name: "id", type: "string", isKey: true, sortOrder: 0 }),
        makeField({ name: "name", type: "string", sortOrder: 1 }),
        makeField({ name: "active", type: "boolean", sortOrder: 2 }),
      ];

      const result = emitFromData(entity, fields);

      for (const [, target] of Object.entries(result.targets)) {
        expect(target.output).toBeTruthy();
        expect(target.output.length).toBeGreaterThan(0);
      }
    });

    it("BigQuery output contains CREATE TABLE DDL", () => {
      const entity = makeEntity();
      const fields = [
        makeField({ name: "id", type: "string", isKey: true, sortOrder: 0 }),
      ];

      const result = emitFromData(entity, fields);

      expect(result.targets.bigquery.output).toContain("CREATE TABLE");
      expect(result.targets.bigquery.output).toContain("customer");
    });

    it("Avro output contains valid JSON schema", () => {
      const entity = makeEntity();
      const fields = [
        makeField({ name: "id", type: "string", isKey: true, sortOrder: 0 }),
      ];

      const result = emitFromData(entity, fields);

      // Avro output should be parseable JSON
      expect(() => JSON.parse(result.targets.avro.output)).not.toThrow();
    });

    it("OpenAPI output is non-empty", () => {
      const entity = makeEntity();
      const fields = [
        makeField({ name: "id", type: "string", isKey: true, sortOrder: 0 }),
      ];

      const result = emitFromData(entity, fields);

      expect(result.targets.openapi.output.length).toBeGreaterThan(0);
    });

    it("handles entity with no fields", () => {
      const entity = makeEntity();
      const fields: PrismaFieldInput[] = [];

      const result = emitFromData(entity, fields);

      // Should still produce results for all targets without crashing
      expect(result.summary.totalTargets).toBe(3);
      expect(result.typespec).toContain("model Customer");
    });

    it("handles multiple field types correctly", () => {
      const entity = makeEntity();
      const fields = [
        makeField({ name: "id", type: "string", isKey: true, sortOrder: 0 }),
        makeField({ name: "age", type: "integer", sortOrder: 1 }),
        makeField({ name: "balance", type: "decimal", precision: 19, scale: 4, sortOrder: 2 }),
        makeField({ name: "active", type: "boolean", sortOrder: 3 }),
        makeField({ name: "createdAt", type: "utcDateTime", sortOrder: 4 }),
      ];

      const result = emitFromData(entity, fields);

      expect(result.summary.totalTargets).toBe(3);

      // BigQuery should contain column names
      const bqOutput = result.targets.bigquery.output;
      expect(bqOutput).toContain("id");
      expect(bqOutput).toContain("age");
      expect(bqOutput).toContain("balance");
      expect(bqOutput).toContain("active");
    });

    it("summary counts match target statuses", () => {
      const entity = makeEntity();
      const fields = [
        makeField({ name: "id", type: "string", isKey: true, sortOrder: 0 }),
        makeField({ name: "amount", type: "decimal", sortOrder: 1 }),
      ];

      const result = emitFromData(entity, fields);

      const targets = Object.values(result.targets);
      const validCount = targets.filter((t) => t.validationStatus === "VALID").length;
      const warningCount = targets.filter((t) => t.validationStatus === "WARNING").length;
      const invalidCount = targets.filter((t) => t.validationStatus === "INVALID").length;

      expect(result.summary.validCount).toBe(validCount);
      expect(result.summary.warningCount).toBe(warningCount);
      expect(result.summary.invalidCount).toBe(invalidCount);
      expect(result.summary.totalTargets).toBe(validCount + warningCount + invalidCount);
    });

    it("each target has correct name and targetFormat", () => {
      const entity = makeEntity();
      const fields = [
        makeField({ name: "id", type: "string", isKey: true, sortOrder: 0 }),
      ];

      const result = emitFromData(entity, fields);

      expect(result.targets.bigquery.name).toBe("bigquery");
      expect(result.targets.avro.name).toBe("avro");
      expect(result.targets.openapi.name).toBe("openapi");

      // Each should have a non-empty targetFormat
      for (const [, target] of Object.entries(result.targets)) {
        expect(target.targetFormat).toBeTruthy();
      }
    });
  });
});

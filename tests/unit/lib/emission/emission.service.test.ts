/**
 * Unit tests for the emission service orchestration.
 *
 * Tests the emitFromData() pure function, which:
 * - Compiles entity + fields to SuperSchemaModel IR
 * - Generates TypeSpec source
 * - Runs all registered NATIVE emitters
 *
 * The native emitter registry is empty as of 2026-10-12 — the last two native
 * emitters (avro, openapi) retired in favor of real TypeSpec packages
 * (@typespec/avro, official @typespec/openapi3), joining the database-DDL
 * targets (spanner/postgresql/bigquery) that made the same move earlier.
 * Their output-correctness coverage now lives in:
 * - ~/src/my/typespec/packages/avro/test/avro.test.ts (avro)
 * - tests/integration/db-emitter-parity.test.ts (DB-DDL targets, as before)
 * - official @typespec/openapi3's own test suite (openapi3)
 * What's left to verify here is only what `emitFromData` itself still does:
 * compile to TypeSpec source and return a well-formed (now-empty) result
 * shape without crashing.
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
    it("returns an empty native-targets map now that the native registry is empty", () => {
      const entity = makeEntity();
      const fields = [
        makeField({ name: "id", type: "string", isKey: true, sortOrder: 0 }),
        makeField({ name: "name", type: "string", sortOrder: 1 }),
        makeField({ name: "email", type: "string", sortOrder: 2 }),
      ];

      const result = emitFromData(entity, fields);

      expect(result.targets).toEqual({});
      expect(result.summary.totalTargets).toBe(0);
      expect(result.summary.validCount).toBe(0);
      expect(result.summary.warningCount).toBe(0);
      expect(result.summary.invalidCount).toBe(0);
    });

    it("generates TypeSpec source regardless of the native registry", () => {
      const entity = makeEntity();
      const fields = [
        makeField({ name: "id", type: "string", isKey: true, sortOrder: 0 }),
      ];

      const result = emitFromData(entity, fields);

      expect(result.typespec).toBeTruthy();
      expect(result.typespec).toContain("model Customer");
      expect(result.typespec).toContain("id");
    });

    it("succeeds trivially with zero targets to fail", () => {
      const entity = makeEntity();
      const fields = [
        makeField({ name: "id", type: "string", isKey: true, sortOrder: 0 }),
      ];

      const result = emitFromData(entity, fields);

      expect(result.success).toBe(true);
      expect(result.summary.invalidCount).toBe(0);
    });

    it("handles an entity with no fields without crashing", () => {
      const entity = makeEntity();
      const fields: PrismaFieldInput[] = [];

      const result = emitFromData(entity, fields);

      expect(result.targets).toEqual({});
      expect(result.typespec).toContain("model Customer");
    });

    it("handles multiple field types without crashing", () => {
      const entity = makeEntity();
      const fields = [
        makeField({ name: "id", type: "string", isKey: true, sortOrder: 0 }),
        makeField({ name: "age", type: "integer", sortOrder: 1 }),
        makeField({ name: "balance", type: "decimal", precision: 19, scale: 4, sortOrder: 2 }),
        makeField({ name: "active", type: "boolean", sortOrder: 3 }),
        makeField({ name: "createdAt", type: "utcDateTime", sortOrder: 4 }),
      ];

      const result = emitFromData(entity, fields);

      expect(result.targets).toEqual({});
      expect(result.typespec).toContain("age");
      expect(result.typespec).toContain("balance");
    });
  });
});

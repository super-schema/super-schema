/**
 * Emission pipeline integration tests.
 *
 * Verifies BigQuery DDL (tests/integration/db-emitter-parity.test.ts), Avro,
 * and OpenAPI output for a realistic entity.
 *
 * Avro and OpenAPI retired as native `emitFromData()` targets on 2026-10-12 in
 * favor of real TypeSpec packages (@typespec/avro, official @typespec/openapi3),
 * routed through `emitOfficialTypeSpecTargetFromData` — the same path the
 * database-DDL targets already used. `emitFromData()`'s native-emitter loop is
 * now always empty; its remaining job (compiling to TypeSpec source) is
 * covered by `tests/unit/lib/emission/emission.service.test.ts`.
 */

import { describe, it, expect, vi } from "vitest";
import { emitOfficialTypeSpecTargetFromData } from "@/lib/typespec-official/emitter.service";
import type { PrismaEntityInput, PrismaFieldInput } from "@/lib/compiler/compiler.service";

// These tests run the real TypeSpec compiler (`tsp`): 5 s is too tight when the whole suite shares the machine.
vi.setConfig({ testTimeout: 60_000 });

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
  it("emits Avro and OpenAPI independently through the real TypeSpec-cli path", async () => {
    const avro = await emitOfficialTypeSpecTargetFromData(customerEntity, customerFields, "avro");
    const openapi3 = await emitOfficialTypeSpecTargetFromData(customerEntity, customerFields, "openapi3");
    expect(avro.validationStatus).toBe("VALID");
    expect(openapi3.validationStatus).toBe("VALID");
  });

  // -----------------------------------------------------------------------
  // Avro
  // -----------------------------------------------------------------------
  describe("Avro output", () => {
    it("is valid JSON with correct field types", async () => {
      const avro = await emitOfficialTypeSpecTargetFromData(customerEntity, customerFields, "avro");

      const schema = JSON.parse(avro.output);
      expect(schema.type).toBe("record");
      expect(schema.name).toBe("Customer");
      expect(Array.isArray(schema.fields)).toBe(true);

      const fields = schema.fields as Array<{ name: string; type: unknown }>;

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
    it("has correct schema properties", async () => {
      const openapi = await emitOfficialTypeSpecTargetFromData(customerEntity, customerFields, "openapi3");

      // Official openapi3 emits YAML with the schema nested under
      // components.schemas.<Name> — not a bare JSON schema at the root.
      expect(openapi.output).toContain("Customer");
      expect(openapi.output).toContain("properties");
      expect(openapi.output).toContain("id:");
      expect(openapi.output).toContain("type: string");
    });

    it("includes required fields in required array", async () => {
      const openapi = await emitOfficialTypeSpecTargetFromData(customerEntity, customerFields, "openapi3");

      expect(openapi.output).toContain("required");
      expect(openapi.output).toMatch(/required:\s*\n(\s*-\s*\w+\n)*\s*-\s*id/);
    });
  });

  // NOTE: the two "lossy mapping warning" tests that lived here (decimal ->
  // OpenAPI producing a WARNING validation status) tested a concept specific
  // to the old native mapping-policy engine (resolveMapping()'s isLossy/
  // lossDescription tracking). The real-compiler typespec-cli path has no
  // equivalent — OfficialTypeSpecTargetResult.warnings is always `[]` on
  // success, since a real TypeSpec compile is pass/fail on diagnostics, not
  // "lossy but tolerated." Removed 2026-10-12, not ported.
});

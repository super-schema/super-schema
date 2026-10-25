/**
 * Integration-style tests for official TypeSpec emitter generation.
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {},
}));

import { emitOfficialTypeSpecTargetFromData } from "@/lib/typespec-official/emitter.service";
import type {
  PrismaEntityInput,
  PrismaFieldInput,
} from "@/lib/compiler/compiler.service";

function makeEntity(overrides?: Partial<PrismaEntityInput>): PrismaEntityInput {
  return {
    id: "entity-1",
    name: "Customer",
    description: "Customer record",
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
    nullable: false,
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

describe("official TypeSpec emitter service", () => {
  const entity = makeEntity();
  const fields = [
    makeField({ name: "id", type: "string", isKey: true, sortOrder: 0 }),
    makeField({ name: "name", type: "string", nullable: true, sortOrder: 1 }),
  ];

  it("emits JSON Schema output with the official json-schema emitter", async () => {
    const result = await emitOfficialTypeSpecTargetFromData(
      entity,
      fields,
      "json-schema"
    );

    expect(result.validationStatus).toBe("VALID");
    expect(result.output).toContain('"$schema"');
    expect(result.output).toContain('"properties"');
  });

  describe("an entity with model tags and classified fields (Story 16.6)", () => {
    // The canonical source now carries valid governance decorators (Enterprise.dataClassification,
    // x-classification, x-tags). Emission sources omit that overlay: no typespec-cli emitter reads it, and
    // importing @superschema/typespec-enterprise would leak its enums into java-pojo / json-schema output.
    const taggedEntity = makeEntity({ metadata: { tags: ["sales", "pii"] } });
    const classifiedFields = [
      makeField({ name: "id", type: "string", isKey: true, sortOrder: 0 }),
      makeField({ name: "email", type: "string", nullable: true, sortOrder: 1, classification: "PII" }),
      makeField({ name: "note", type: "string", nullable: true, sortOrder: 2, classification: "SENSITIVE" }),
      makeField({ name: "code", type: "string", nullable: true, sortOrder: 3, classification: "TOP_SECRET" }),
    ];
    const LEAKED_ENTERPRISE_TYPES = ["DataClassification", "AnonymizationStrategy", "AvroLogicalType", "AvroFieldOrder"];

    it.each(["openapi3", "json-schema", "avro", "java-pojo", "protobuf"])(
      "%s emits VALID output with every field and no leaked Enterprise types",
      async (target) => {
        const result = await emitOfficialTypeSpecTargetFromData(taggedEntity, classifiedFields, target);

        expect(result.errors).toEqual([]);
        expect(result.validationStatus).toBe("VALID");
        for (const name of ["email", "note", "code"]) expect(result.output).toContain(name);
        for (const leaked of LEAKED_ENTERPRISE_TYPES) expect(result.output).not.toContain(leaked);
        expect(result.output).not.toContain("x-tags");
        expect(result.output).not.toContain("x-classification");
      },
      30_000
    );
  });

  it("emits OpenAPI output with the official openapi3 emitter", async () => {
    const result = await emitOfficialTypeSpecTargetFromData(
      entity,
      fields,
      "openapi3"
    );

    expect(result.validationStatus).toBe("VALID");
    expect(result.output).toContain("openapi:");
    expect(result.output).toContain("components:");
    expect(result.output).toContain("Customer:");
  }, 15_000);

  it("emits Protobuf output and auto-assigns field numbers when missing", async () => {
    const result = await emitOfficialTypeSpecTargetFromData(
      entity,
      fields,
      "protobuf"
    );

    expect(result.validationStatus).toBe("VALID");
    expect(result.output).toContain('syntax = "proto3";');
    expect(result.output).toContain("message Customer");
    expect(result.output).toContain("string id = 1;");
    expect(result.output).toContain("string name = 2;");
  }, 30_000); // a real `tsp compile`: over the default 5 s under the load of the whole suite

  it("emits Protobuf for a tenant-level entity with no domain (namespace falls back to the keyword `unknown`)", async () => {
    // Entity.domainId is optional (tenant-level entities, Story 13.5);
    // compileEntity() then reports the domain as "unknown" — a reserved
    // TypeSpec keyword that must be escaped when used as the namespace.
    const result = await emitOfficialTypeSpecTargetFromData(
      makeEntity({ domainId: null, domain: null }),
      fields,
      "protobuf"
    );

    expect(result.errors).toEqual([]);
    expect(result.validationStatus).toBe("VALID");
    expect(result.output).toContain("message Customer");
  }, 30_000);

  it("rejects multi-file code generators in the Schemas tab flow", async () => {
    const result = await emitOfficialTypeSpecTargetFromData(
      entity,
      fields,
      "http-client-js"
    );

    expect(result.validationStatus).toBe("INVALID");
    expect(result.errors[0]?.message).toContain("multi-file");
  });
});

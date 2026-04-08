/**
 * Integration-style tests for official TypeSpec emitter generation.
 */

import { describe, it, expect } from "vitest";
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
  });

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
  });

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

import { describe, expect, it } from "vitest";
import { PostgreSqlEmitter } from "@/emitters/postgresql/postgresql.emitter";
import { getDefaultPolicies } from "@/lib/type-mapping/default-mappings";
import type { SuperSchemaField, SuperSchemaModel } from "@/types/super-schema-model";
import type { ScopedMappingPolicy } from "@/lib/type-mapping/types";

const emitter = new PostgreSqlEmitter();
const defaultPolicies = getDefaultPolicies();

function makeField(
  overrides: Partial<SuperSchemaField> & {
    name: string;
    type: SuperSchemaField["type"];
  }
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

function makeModel(
  fields: SuperSchemaField[],
  overrides?: Partial<SuperSchemaModel["entity"]>
): SuperSchemaModel {
  return {
    entity: {
      id: "entity-1",
      name: "Customer",
      domain: "sales",
      domainId: "domain-1",
      description: "Customer table",
      status: "draft",
      version: 1,
      metadata: {},
      ...overrides,
    },
    fields,
    relationships: [],
  };
}

describe("PostgreSqlEmitter", () => {
  it("emits PostgreSQL DDL with primary keys", () => {
    const result = emitter.emit(
      makeModel([
        makeField({ name: "id", type: "string", id: "field-1", isKey: true, nullable: false }),
        makeField({ name: "createdAt", type: "utcDateTime", id: "field-2", nullable: false }),
      ]),
      defaultPolicies
    );

    expect(result.output).toContain("CREATE TABLE customer");
    expect(result.output).toContain("PRIMARY KEY (id)");
    expect(result.output).toContain("created_at timestamp NOT NULL");
    expect(emitter.validate(result.output).valid).toBe(true);
  });

  it("honors field-level overrides and preserves the override comment", () => {
    const policies: ScopedMappingPolicy[] = [
      ...defaultPolicies,
      {
        sourceType: "string",
        targetType: "uuid",
        targetFormat: "postgresql",
        mappedType: "uuid",
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
        }),
      ]),
      policies
    );

    expect(result.output).toContain("customer_id uuid NOT NULL");
    expect(result.output).toContain("SUPER SCHEMA TYPE OVERRIDE");
  });
});

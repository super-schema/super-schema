import { describe, it, expect } from "vitest";
import { compileEntity } from "@/lib/compiler/compiler.service";
import type { PrismaEntityInput, PrismaFieldInput } from "@/lib/compiler/compiler.service";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEntity(overrides: Partial<PrismaEntityInput> = {}): PrismaEntityInput {
  return {
    id: "entity-1",
    name: "Customer",
    description: "A customer entity",
    status: "DRAFT",
    version: 1,
    domainId: "domain-1",
    metadata: {},
    domain: { id: "domain-1", name: "Sales", slug: "sales" },
    ...overrides,
  };
}

function makeField(overrides: Partial<PrismaFieldInput> = {}): PrismaFieldInput {
  return {
    id: "field-1",
    name: "firstName",
    type: "string",
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("compileEntity", () => {
  it("compiles a basic entity with no fields", () => {
    const model = compileEntity(makeEntity(), []);

    expect(model.entity.id).toBe("entity-1");
    expect(model.entity.name).toBe("Customer");
    expect(model.entity.domain).toBe("Sales");
    expect(model.entity.domainId).toBe("domain-1");
    expect(model.entity.description).toBe("A customer entity");
    expect(model.entity.status).toBe("DRAFT");
    expect(model.entity.version).toBe(1);
    expect(model.fields).toHaveLength(0);
    expect(model.relationships).toHaveLength(0);
  });

  it("uses domain slug when name is not available", () => {
    const model = compileEntity(
      makeEntity({ domain: { id: "d-1", name: "", slug: "finance" } }),
      []
    );
    // name is empty string, which is falsy, so it falls back to slug
    expect(model.entity.domain).toBe("finance");
  });

  it("compiles fields in sortOrder", () => {
    const fields = [
      makeField({ id: "f-3", name: "c", sortOrder: 2 }),
      makeField({ id: "f-1", name: "a", sortOrder: 0 }),
      makeField({ id: "f-2", name: "b", sortOrder: 1 }),
    ];

    const model = compileEntity(makeEntity(), fields);

    expect(model.fields.map((f) => f.name)).toEqual(["a", "b", "c"]);
  });

  it("compiles field types correctly", () => {
    const fields = [
      makeField({ name: "name", type: "string", sortOrder: 0 }),
      makeField({ name: "age", type: "int32", sortOrder: 1 }),
      makeField({ name: "amount", type: "decimal", precision: 10, scale: 2, sortOrder: 2 }),
      makeField({ name: "active", type: "boolean", sortOrder: 3 }),
      makeField({ name: "created", type: "utcDateTime", sortOrder: 4 }),
    ];

    const model = compileEntity(makeEntity(), fields);

    expect(model.fields[0].type).toBe("string");
    expect(model.fields[1].type).toBe("int32");
    expect(model.fields[2].type).toBe("decimal");
    expect(model.fields[2].precision).toBe(10);
    expect(model.fields[2].scale).toBe(2);
    expect(model.fields[3].type).toBe("boolean");
    expect(model.fields[4].type).toBe("utcDateTime");
  });

  it("handles nullable and isKey fields", () => {
    const model = compileEntity(makeEntity(), [
      makeField({ name: "id", isKey: true, nullable: false, sortOrder: 0 }),
      makeField({ name: "nickname", nullable: true, sortOrder: 1 }),
    ]);

    expect(model.fields[0].isKey).toBe(true);
    expect(model.fields[0].nullable).toBe(false);
    expect(model.fields[1].nullable).toBe(true);
  });

  it("compiles field decorators from all 8 categories", () => {
    const decorators = {
      structure: { nullable: true, key: false },
      semantics: { description: "A test field", aliases: ["fname"] },
      classification: { level: "PII" },
      policy: { retention: "90d", encryption: "AES-256" },
      quality: { rules: [{ type: "notNull", params: {} }] },
      lineage: { source: "crm.customers.first_name" },
      operationalHints: { index: true },
      evolution: { deprecated: false },
    };

    const model = compileEntity(makeEntity(), [
      makeField({ name: "fname", decorators, sortOrder: 0 }),
    ]);

    const field = model.fields[0];
    expect(field.decorators.structure?.nullable).toBe(true);
    expect(field.decorators.semantics?.description).toBe("A test field");
    expect(field.decorators.classification?.level).toBe("PII");
    expect(field.decorators.policy?.retention).toBe("90d");
    expect(field.decorators.quality?.rules).toHaveLength(1);
    expect(field.decorators.lineage?.source).toBe("crm.customers.first_name");
    expect(field.decorators.operationalHints?.index).toBe(true);
    expect(field.decorators.evolution?.deprecated).toBe(false);
  });

  it("compiles typespec 7-panel decorators", () => {
    const decorators = {
      typespec: {
        identity: { key: true, secret: false, format: "uuid" },
        validation: { minLength: 1, maxLength: 128 },
        wireFormat: { encode: "rfc3339" },
        visibility: { phases: ["Create", "Read"] },
        documentation: { doc: "The customer ID", summary: "Customer ID" },
        versioning: { added: "v1" },
        extensions: { openapi: { "x-custom": true } },
      },
    };

    const model = compileEntity(makeEntity(), [
      makeField({ name: "id", decorators, sortOrder: 0 }),
    ]);

    const field = model.fields[0];
    expect(field.decorators.typespec?.identity?.key).toBe(true);
    expect(field.decorators.typespec?.identity?.format).toBe("uuid");
    expect(field.decorators.typespec?.validation?.minLength).toBe(1);
    expect(field.decorators.typespec?.validation?.maxLength).toBe(128);
    expect(field.decorators.typespec?.wireFormat?.encode).toBe("rfc3339");
    expect(field.decorators.typespec?.visibility?.phases).toEqual(["Create", "Read"]);
    expect(field.decorators.typespec?.documentation?.doc).toBe("The customer ID");
    expect(field.decorators.typespec?.versioning?.added).toBe("v1");
    expect(field.decorators.typespec?.extensions?.openapi).toEqual({ "x-custom": true });
  });

  it("compiles complex type info for array fields", () => {
    const model = compileEntity(makeEntity(), [
      makeField({
        name: "tags",
        type: "array",
        decorators: { arrayElementType: "string" },
        sortOrder: 0,
      }),
    ]);

    expect(model.fields[0].complexType?.arrayElementType).toBe("string");
  });

  it("compiles complex type info for map fields", () => {
    const model = compileEntity(makeEntity(), [
      makeField({
        name: "attrs",
        type: "map",
        decorators: { mapKeyType: "string", mapValueType: "int32" },
        sortOrder: 0,
      }),
    ]);

    expect(model.fields[0].complexType?.mapKeyType).toBe("string");
    expect(model.fields[0].complexType?.mapValueType).toBe("int32");
  });

  it("compiles complex type info for reference fields", () => {
    const model = compileEntity(makeEntity(), [
      makeField({
        name: "order",
        type: "reference",
        decorators: {
          referencedEntityId: "entity-2",
          referencedEntityName: "Order",
        },
        sortOrder: 0,
      }),
    ]);

    expect(model.fields[0].complexType?.referencedEntityId).toBe("entity-2");
    expect(model.fields[0].complexType?.referencedEntityName).toBe("Order");
  });

  it("extracts relationships from entity metadata", () => {
    const metadata = {
      relationships: [
        {
          targetEntityId: "entity-2",
          fieldId: "field-order",
          cardinality: "one-to-many",
          foreignKey: "customerId",
        },
      ],
    };

    const model = compileEntity(makeEntity({ metadata }), []);

    expect(model.relationships).toHaveLength(1);
    expect(model.relationships[0].targetEntityId).toBe("entity-2");
    expect(model.relationships[0].cardinality).toBe("one-to-many");
    expect(model.relationships[0].foreignKey).toBe("customerId");
  });

  it("extracts relationships from reference fields", () => {
    const model = compileEntity(makeEntity(), [
      makeField({
        id: "field-ref",
        name: "order",
        type: "reference",
        decorators: { referencedEntityId: "entity-2", referencedEntityName: "Order" },
        sortOrder: 0,
      }),
    ]);

    expect(model.relationships).toHaveLength(1);
    expect(model.relationships[0].targetEntityId).toBe("entity-2");
    expect(model.relationships[0].fieldId).toBe("field-ref");
    expect(model.relationships[0].cardinality).toBe("many-to-one");
  });

  it("does not duplicate relationships from metadata and reference fields", () => {
    const metadata = {
      relationships: [
        {
          targetEntityId: "entity-2",
          fieldId: "field-ref",
          cardinality: "one-to-one",
        },
      ],
    };

    const model = compileEntity(makeEntity({ metadata }), [
      makeField({
        id: "field-ref",
        name: "order",
        type: "reference",
        decorators: { referencedEntityId: "entity-2" },
        sortOrder: 0,
      }),
    ]);

    expect(model.relationships).toHaveLength(1);
  });

  it("compiles entity metadata with tags and deprecation", () => {
    const metadata = {
      tags: ["core", "billing"],
      deprecation: {
        deprecated: true,
        since: "v2",
        replacement: "NewCustomer",
        reason: "Schema redesign",
      },
    };

    const model = compileEntity(makeEntity({ metadata }), []);

    expect(model.entity.metadata.tags).toEqual(["core", "billing"]);
    expect(model.entity.metadata.deprecation?.deprecated).toBe(true);
    expect(model.entity.metadata.deprecation?.since).toBe("v2");
    expect(model.entity.metadata.deprecation?.replacement).toBe("NewCustomer");
  });

  it("handles null/empty metadata gracefully", () => {
    const model = compileEntity(makeEntity({ metadata: null }), []);
    expect(model.entity.metadata).toEqual({});

    const model2 = compileEntity(makeEntity({ metadata: undefined }), []);
    expect(model2.entity.metadata).toEqual({});
  });

  it("handles unknown field types by falling back to string", () => {
    const model = compileEntity(makeEntity(), [
      makeField({ name: "weird", type: "unknownType", sortOrder: 0 }),
    ]);

    expect(model.fields[0].type).toBe("string");
  });

  it("compiles aliases and classification", () => {
    const model = compileEntity(makeEntity(), [
      makeField({
        name: "email",
        aliases: ["emailAddress", "mail"],
        classification: "PII",
        sortOrder: 0,
      }),
    ]);

    expect(model.fields[0].aliases).toEqual(["emailAddress", "mail"]);
    expect(model.fields[0].classification).toBe("PII");
  });
});

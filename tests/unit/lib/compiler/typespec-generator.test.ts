import { describe, it, expect } from "vitest";
import { generateTypeSpec, generateTypeSpecWithSourceMap } from "@/lib/compiler/typespec-generator";
import { compileEntity } from "@/lib/compiler/compiler.service";
import type { SuperSchemaModel } from "@/types/super-schema-model";
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

function compileAndGenerate(
  entityOverrides: Partial<PrismaEntityInput> = {},
  fields: PrismaFieldInput[] = []
): string {
  const model = compileEntity(makeEntity(entityOverrides), fields);
  return generateTypeSpec(model);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("TypeSpec Generator", () => {
  describe("string field", () => {
    it("generates correct TypeSpec for a required string field", () => {
      const source = compileAndGenerate({}, [
        makeField({ name: "firstName", type: "string", nullable: false }),
      ]);

      expect(source).toContain("firstName: string;");
      expect(source).not.toContain("firstName?");
    });

    it("generates correct TypeSpec for an optional string field", () => {
      const source = compileAndGenerate({}, [
        makeField({ name: "middleName", type: "string", nullable: true }),
      ]);

      expect(source).toContain("middleName?: string;");
    });

    it("generates url type", () => {
      const source = compileAndGenerate({}, [
        makeField({ name: "website", type: "url", nullable: false }),
      ]);

      expect(source).toContain("website: url;");
    });
  });

  describe("integer fields", () => {
    it("generates int32 type", () => {
      const source = compileAndGenerate({}, [
        makeField({ name: "age", type: "int32", nullable: false }),
      ]);

      expect(source).toContain("age: int32;");
    });

    it("generates int64 type", () => {
      const source = compileAndGenerate({}, [
        makeField({ name: "bigId", type: "int64", nullable: false }),
      ]);

      expect(source).toContain("bigId: int64;");
    });

    it("generates integer (abstract) type", () => {
      const source = compileAndGenerate({}, [
        makeField({ name: "count", type: "integer", nullable: false }),
      ]);

      expect(source).toContain("count: integer;");
    });

    it("generates safeint type", () => {
      const source = compileAndGenerate({}, [
        makeField({ name: "jsNumber", type: "safeint", nullable: false }),
      ]);

      expect(source).toContain("jsNumber: safeint;");
    });
  });

  describe("decimal field", () => {
    it("generates correct TypeSpec for decimal with precision and scale", () => {
      const source = compileAndGenerate({}, [
        makeField({
          name: "amount",
          type: "decimal",
          precision: 10,
          scale: 2,
          nullable: false,
        }),
      ]);

      expect(source).toContain("amount: decimal;");
    });

    it("generates decimal128 type", () => {
      const source = compileAndGenerate({}, [
        makeField({
          name: "bigAmount",
          type: "decimal128",
          precision: 38,
          scale: 10,
          nullable: false,
        }),
      ]);

      expect(source).toContain("bigAmount: decimal128;");
    });
  });

  describe("boolean field", () => {
    it("generates correct TypeSpec for boolean", () => {
      const source = compileAndGenerate({}, [
        makeField({ name: "isActive", type: "boolean", nullable: false }),
      ]);

      expect(source).toContain("isActive: boolean;");
    });
  });

  describe("float fields", () => {
    it("generates float32 type", () => {
      const source = compileAndGenerate({}, [
        makeField({ name: "temperature", type: "float32", nullable: false }),
      ]);

      expect(source).toContain("temperature: float32;");
    });

    it("generates float64 type", () => {
      const source = compileAndGenerate({}, [
        makeField({ name: "latitude", type: "float64", nullable: false }),
      ]);

      expect(source).toContain("latitude: float64;");
    });
  });

  describe("date/time fields", () => {
    it("generates utcDateTime type", () => {
      const source = compileAndGenerate({}, [
        makeField({ name: "createdAt", type: "utcDateTime", nullable: false }),
      ]);

      expect(source).toContain("createdAt: utcDateTime;");
    });

    it("generates plainDate type", () => {
      const source = compileAndGenerate({}, [
        makeField({ name: "birthDate", type: "plainDate", nullable: true }),
      ]);

      expect(source).toContain("birthDate?: plainDate;");
    });

    it("generates plainTime type", () => {
      const source = compileAndGenerate({}, [
        makeField({ name: "startTime", type: "plainTime", nullable: false }),
      ]);

      expect(source).toContain("startTime: plainTime;");
    });

    it("generates duration type", () => {
      const source = compileAndGenerate({}, [
        makeField({ name: "timeout", type: "duration", nullable: false }),
      ]);

      expect(source).toContain("timeout: duration;");
    });
  });

  describe("enum field", () => {
    it("generates TypeSpec enum definition", () => {
      const source = compileAndGenerate({}, [
        makeField({
          name: "status",
          type: "enum",
          nullable: false,
          aliases: ["ACTIVE", "INACTIVE", "PENDING"],
        }),
      ]);

      expect(source).toContain("enum Customer_status {");
      expect(source).toContain("  ACTIVE,");
      expect(source).toContain("  INACTIVE,");
      expect(source).toContain("  PENDING,");
      expect(source).toContain("status: Customer_status;");
    });

    it("generates enum from pattern-based values", () => {
      const source = compileAndGenerate({}, [
        makeField({
          name: "priority",
          type: "enum",
          nullable: false,
          decorators: {
            typespec: {
              validation: { pattern: "LOW|MEDIUM|HIGH|CRITICAL" },
            },
          },
        }),
      ]);

      expect(source).toContain("enum Customer_priority {");
      expect(source).toContain("  LOW,");
      expect(source).toContain("  HIGH,");
    });
  });

  describe("array field", () => {
    it("generates TypeSpec array syntax", () => {
      const source = compileAndGenerate({}, [
        makeField({
          name: "tags",
          type: "array",
          nullable: false,
          decorators: { arrayElementType: "string" },
        }),
      ]);

      expect(source).toContain("tags: string[];");
    });

    it("generates array with int32 element type", () => {
      const source = compileAndGenerate({}, [
        makeField({
          name: "scores",
          type: "array",
          nullable: false,
          decorators: { arrayElementType: "int32" },
        }),
      ]);

      expect(source).toContain("scores: int32[];");
    });
  });

  describe("map field", () => {
    it("generates TypeSpec Record syntax", () => {
      const source = compileAndGenerate({}, [
        makeField({
          name: "attributes",
          type: "map",
          nullable: false,
          decorators: { mapKeyType: "string", mapValueType: "string" },
        }),
      ]);

      expect(source).toContain("attributes: Record<string>;");
    });
  });

  describe("reference field", () => {
    it("generates model reference for reference fields", () => {
      const source = compileAndGenerate({}, [
        makeField({
          name: "order",
          type: "reference",
          nullable: true,
          decorators: {
            referencedEntityId: "entity-2",
            referencedEntityName: "Order",
          },
        }),
      ]);

      expect(source).toContain("order?: Order;");
    });

    it("falls back to string when no referenced entity name", () => {
      const source = compileAndGenerate({}, [
        makeField({
          name: "parentId",
          type: "reference",
          nullable: false,
          decorators: {},
        }),
      ]);

      expect(source).toContain("parentId: string;");
    });
  });

  describe("nullable fields", () => {
    it("generates optional marker for nullable fields", () => {
      const source = compileAndGenerate({}, [
        makeField({ name: "nickname", type: "string", nullable: true }),
      ]);

      expect(source).toContain("nickname?: string;");
    });

    it("does not generate optional marker for non-nullable fields", () => {
      const source = compileAndGenerate({}, [
        makeField({ name: "id", type: "string", nullable: false }),
      ]);

      expect(source).toContain("id: string;");
      expect(source).not.toContain("id?");
    });
  });

  describe("field decorators", () => {
    it("generates @key for key fields", () => {
      const source = compileAndGenerate({}, [
        makeField({ name: "id", type: "string", nullable: false, isKey: true }),
      ]);

      expect(source).toContain("@key");
      expect(source).toContain("id: string;");
    });

    it("generates @doc for fields with description", () => {
      const source = compileAndGenerate({}, [
        makeField({
          name: "email",
          type: "string",
          nullable: false,
          description: "User email address",
        }),
      ]);

      expect(source).toContain('@doc("User email address")');
    });

    it("generates the Enterprise classification decorator, never @tag (Story 16.6)", () => {
      const source = compileAndGenerate({}, [
        makeField({
          name: "ssn",
          type: "string",
          nullable: false,
          classification: "PII",
        }),
      ]);

      expect(source).toContain("  @Enterprise.dataClassification(Enterprise.DataClassification.PII)\n  ssn: string;");
      expect(source).not.toContain("@tag(");
    });

    it("generates @minLength and @maxLength", () => {
      const source = compileAndGenerate({}, [
        makeField({
          name: "code",
          type: "string",
          nullable: false,
          decorators: {
            typespec: {
              validation: { minLength: 3, maxLength: 10 },
            },
          },
        }),
      ]);

      expect(source).toContain("@minLength(3)");
      expect(source).toContain("@maxLength(10)");
    });

    it("generates @minValue and @maxValue", () => {
      const source = compileAndGenerate({}, [
        makeField({
          name: "rating",
          type: "int32",
          nullable: false,
          decorators: {
            typespec: {
              validation: { minValue: 1, maxValue: 5 },
            },
          },
        }),
      ]);

      expect(source).toContain("@minValue(1)");
      expect(source).toContain("@maxValue(5)");
    });

    it("generates @pattern", () => {
      const source = compileAndGenerate({}, [
        makeField({
          name: "zipCode",
          type: "string",
          nullable: false,
          decorators: {
            typespec: {
              validation: { pattern: "^\\d{5}$" },
            },
          },
        }),
      ]);

      expect(source).toContain("@pattern");
    });

    it("generates @secret", () => {
      const source = compileAndGenerate({}, [
        makeField({
          name: "apiKey",
          type: "string",
          nullable: false,
          decorators: {
            typespec: {
              identity: { secret: true },
            },
          },
        }),
      ]);

      expect(source).toContain("@secret");
    });

    it("generates @format", () => {
      const source = compileAndGenerate({}, [
        makeField({
          name: "email",
          type: "string",
          nullable: false,
          decorators: {
            typespec: {
              identity: { format: "email" },
            },
          },
        }),
      ]);

      expect(source).toContain('@format("email")');
    });

    it("generates @encode", () => {
      const source = compileAndGenerate({}, [
        makeField({
          name: "createdAt",
          type: "utcDateTime",
          nullable: false,
          decorators: {
            typespec: {
              wireFormat: { encode: "rfc3339" },
            },
          },
        }),
      ]);

      expect(source).toContain('@encode("rfc3339")');
    });

    it("generates @visibility", () => {
      const source = compileAndGenerate({}, [
        makeField({
          name: "password",
          type: "string",
          nullable: false,
          decorators: {
            typespec: {
              visibility: { phases: ["Create"] },
            },
          },
        }),
      ]);

      expect(source).toContain("@visibility(Lifecycle.Create)");
    });
  });

  describe("model-level output", () => {
    it("generates model with @doc for entity description", () => {
      const source = compileAndGenerate(
        { name: "Customer", description: "A customer entity" },
        [makeField({ name: "id", type: "string", nullable: false })]
      );

      expect(source).toContain('@doc("A customer entity")');
      expect(source).toContain("model Customer {");
      expect(source).toContain("}");
    });

    it("sanitizes entity names with special characters", () => {
      const source = compileAndGenerate({ name: "My-Entity 123" }, [
        makeField({ name: "id", type: "string", nullable: false }),
      ]);

      expect(source).toContain("model My_Entity_123 {");
    });
  });

  describe("multi-field entity", () => {
    it("generates valid TypeSpec for entity with mixed field types", () => {
      const source = compileAndGenerate({}, [
        makeField({
          name: "id",
          type: "string",
          nullable: false,
          isKey: true,
          sortOrder: 0,
        }),
        makeField({
          name: "name",
          type: "string",
          nullable: false,
          description: "Customer name",
          sortOrder: 1,
        }),
        makeField({
          name: "age",
          type: "int32",
          nullable: true,
          sortOrder: 2,
        }),
        makeField({
          name: "balance",
          type: "decimal",
          precision: 10,
          scale: 2,
          nullable: false,
          sortOrder: 3,
        }),
        makeField({
          name: "isActive",
          type: "boolean",
          nullable: false,
          sortOrder: 4,
        }),
        makeField({
          name: "createdAt",
          type: "utcDateTime",
          nullable: false,
          sortOrder: 5,
        }),
      ]);

      expect(source).toContain("model Customer {");
      expect(source).toContain("@key");
      expect(source).toContain("id: string;");
      expect(source).toContain("name: string;");
      expect(source).toContain("age?: int32;");
      expect(source).toContain("balance: decimal;");
      expect(source).toContain("isActive: boolean;");
      expect(source).toContain("createdAt: utcDateTime;");
      expect(source).toContain("}");
    });
  });

  describe("source map generation", () => {
    it("generates source map with field locations", () => {
      const model = compileEntity(makeEntity(), [
        makeField({ name: "id", type: "string", nullable: false, isKey: true, sortOrder: 0 }),
        makeField({ name: "name", type: "string", nullable: false, sortOrder: 1 }),
      ]);

      const { source, sourceMap } = generateTypeSpecWithSourceMap(model);

      expect(source).toBeTruthy();
      expect(sourceMap).toHaveLength(2);
      expect(sourceMap[0].fieldName).toBe("id");
      expect(sourceMap[1].fieldName).toBe("name");
      expect(sourceMap[0].startLine).toBeGreaterThan(0);
      expect(sourceMap[0].endLine).toBeGreaterThanOrEqual(sourceMap[0].startLine);
    });

    it("includes enum fields in source map", () => {
      const model = compileEntity(makeEntity(), [
        makeField({
          name: "status",
          type: "enum",
          nullable: false,
          aliases: ["ACTIVE", "INACTIVE"],
          sortOrder: 0,
        }),
      ]);

      const { sourceMap } = generateTypeSpecWithSourceMap(model);

      // One entry for enum definition and one for field definition
      expect(sourceMap.length).toBeGreaterThanOrEqual(1);
      const statusEntries = sourceMap.filter((e) => e.fieldName === "status");
      expect(statusEntries.length).toBeGreaterThanOrEqual(1);
    });
  });
});

// ---------------------------------------------------------------------------
// Governance overlay (Story 16.6): valid decorators instead of @tag
// ---------------------------------------------------------------------------

describe("TypeSpec Generator — governance overlay (Story 16.6)", () => {
  const taggedClassified = () =>
    compileEntity(makeEntity({ metadata: { tags: ["sales", "core"] } }), [
      makeField({ id: "f1", name: "id", type: "string", isKey: true, sortOrder: 0 }),
      makeField({ id: "f2", name: "email", type: "string", nullable: true, classification: "PII", sortOrder: 1 }),
      makeField({ id: "f3", name: "note", type: "string", nullable: true, classification: "SENSITIVE", sortOrder: 2 }),
      makeField({ id: "f4", name: "code", type: "string", nullable: true, classification: "TOP_SECRET", sortOrder: 3 }),
    ]);

  it("emits entity tags as one x-tags extension on the model, never @tag", () => {
    const source = generateTypeSpec(taggedClassified());
    expect(source).toContain('@TypeSpec.OpenAPI.extension("x-tags", #["sales", "core"])\nmodel Customer {');
    expect(source).not.toContain("@tag(");
  });

  it("emits mapped classifications as Enterprise decorators and an unmapped level as x-classification", () => {
    const source = generateTypeSpec(taggedClassified());
    expect(source).toContain("  @Enterprise.dataClassification(Enterprise.DataClassification.PII)\n  email?: string;");
    expect(source).toContain("  @Enterprise.dataClassification(Enterprise.DataClassification.Confidential)\n  note?: string;");
    expect(source).toContain('  @TypeSpec.OpenAPI.extension("x-classification", "TOP_SECRET")\n  code?: string;');
  });

  it("emits the library imports the overlay needs, first in the file", () => {
    const source = generateTypeSpec(taggedClassified());
    expect(source.startsWith('import "@superschema/typespec-enterprise";\nimport "@typespec/openapi";\n\n')).toBe(true);
  });

  it("emits only the import that is used", () => {
    const enterpriseOnly = generateTypeSpec(
      compileEntity(makeEntity(), [makeField({ name: "email", classification: "PII" })])
    );
    expect(enterpriseOnly).toContain('import "@superschema/typespec-enterprise";');
    expect(enterpriseOnly).not.toContain('import "@typespec/openapi";');

    const openapiOnly = generateTypeSpec(
      compileEntity(makeEntity({ metadata: { tags: ["sales"] } }), [makeField({ name: "id" })])
    );
    expect(openapiOnly).toContain('import "@typespec/openapi";');
    expect(openapiOnly).not.toContain("typespec-enterprise");
  });

  it("emits no import for an entity without tags or classification (output unchanged)", () => {
    const source = generateTypeSpec(compileEntity(makeEntity(), [makeField({ name: "id" })]));
    expect(source).not.toContain("import ");
    expect(source.startsWith('@doc("A customer entity")\nmodel Customer {')).toBe(true);
  });

  it("omits the whole overlay (decorators and imports) with governance: false", () => {
    const source = generateTypeSpec(taggedClassified(), { governance: false });
    expect(source).not.toContain("import ");
    expect(source).not.toContain("Enterprise");
    expect(source).not.toContain("x-tags");
    expect(source).not.toContain("x-classification");
    expect(source).not.toContain("@tag(");
    expect(source).toContain("email?: string;");
  });

  it("keeps the source map aligned with the import lines", () => {
    const { source, sourceMap } = generateTypeSpecWithSourceMap(taggedClassified());
    const lines = source.split("\n");
    const email = sourceMap.find((e) => e.fieldName === "email")!;
    expect(lines.slice(email.startLine - 1, email.endLine)).toEqual([
      "  @Enterprise.dataClassification(Enterprise.DataClassification.PII)",
      "  email?: string;",
    ]);
  });
});

/**
 * Unit tests for the OpenAPI 3.0 Schema Emitter
 *
 * Tests cover: simple entity, nullable/required, enum, array, reference,
 * decimal with lossy warning, quality rules, date/timestamp, integer,
 * boolean, validator pass/fail, determinism, and edge cases.
 */

import { describe, it, expect } from "vitest";
import { parse as yamlParse } from "yaml";
import { openApiEmitter } from "@/emitters/openapi/openapi.emitter";
import { getDefaultPolicies } from "@/lib/type-mapping/default-mappings";
import type { SuperSchemaModel, SuperSchemaField } from "@/types/super-schema-model";
import type { ScopedMappingPolicy } from "@/lib/type-mapping/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const defaultPolicies = getDefaultPolicies();

function makeModel(
  fields: SuperSchemaField[],
  overrides?: Partial<SuperSchemaModel["entity"]>
): SuperSchemaModel {
  return {
    entity: {
      id: "entity-1",
      name: "TestEntity",
      domain: "test",
      domainId: "domain-1",
      description: "A test entity",
      status: "draft",
      version: 1,
      metadata: {},
      ...overrides,
    },
    fields,
    relationships: [],
  };
}

function makeField(overrides: Partial<SuperSchemaField>): SuperSchemaField {
  return {
    name: "testField",
    type: "string",
    nullable: false,
    isKey: false,
    description: "",
    aliases: [],
    decorators: {},
    sortOrder: 0,
    ...overrides,
  };
}

function emitAndParse(model: SuperSchemaModel, policies?: ScopedMappingPolicy[]) {
  const result = openApiEmitter.emit(model, policies ?? defaultPolicies);
  const parsed = yamlParse(result.output) as {
    components: {
      schemas: Record<string, Record<string, unknown>>;
    };
  };
  return { result, parsed };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("OpenAPI Emitter", () => {
  describe("emit()", () => {
    it("should produce valid OpenAPI YAML for a simple entity with string, integer, boolean", () => {
      const model = makeModel([
        makeField({ name: "name", type: "string", sortOrder: 0, description: "User name" }),
        makeField({ name: "age", type: "integer", sortOrder: 1 }),
        makeField({ name: "active", type: "boolean", sortOrder: 2 }),
      ]);

      const { result, parsed } = emitAndParse(model);

      expect(result.targetFormat).toBe("openapi");
      expect(parsed.components.schemas.TestEntity).toBeDefined();

      const schema = parsed.components.schemas.TestEntity;
      expect(schema.type).toBe("object");
      expect(schema.description).toBe("A test entity");

      const props = schema.properties as Record<string, Record<string, unknown>>;
      expect(props.name.type).toBe("string");
      expect(props.name.description).toBe("User name");
      expect(props.age.type).toBe("integer");
      expect(props.age.format).toBe("int64");
      expect(props.active.type).toBe("boolean");
    });

    it("should include non-nullable fields in the required array", () => {
      const model = makeModel([
        makeField({ name: "id", type: "string", nullable: false, sortOrder: 0 }),
        makeField({ name: "email", type: "string", nullable: false, sortOrder: 1 }),
        makeField({ name: "nickname", type: "string", nullable: true, sortOrder: 2 }),
      ]);

      const { parsed } = emitAndParse(model);
      const schema = parsed.components.schemas.TestEntity;

      expect(schema.required).toEqual(["id", "email"]);
    });

    it("should set nullable: true on nullable fields and exclude them from required", () => {
      const model = makeModel([
        makeField({ name: "middle_name", type: "string", nullable: true, sortOrder: 0 }),
        makeField({ name: "bio", type: "string", nullable: true, sortOrder: 1 }),
      ]);

      const { parsed } = emitAndParse(model);
      const schema = parsed.components.schemas.TestEntity;

      const props = schema.properties as Record<string, Record<string, unknown>>;
      expect(props.middle_name.nullable).toBe(true);
      expect(props.bio.nullable).toBe(true);
      expect(schema.required).toBeUndefined();
    });

    it("should map decimal to number/double with x-precision and x-scale extensions", () => {
      const model = makeModel([
        makeField({
          name: "price",
          type: "decimal",
          precision: 10,
          scale: 2,
          sortOrder: 0,
        }),
      ]);

      const { parsed } = emitAndParse(model);
      const props = parsed.components.schemas.TestEntity.properties as Record<
        string,
        Record<string, unknown>
      >;

      expect(props.price.type).toBe("number");
      expect(props.price.format).toBe("double");
      expect(props.price["x-precision"]).toBe(10);
      expect(props.price["x-scale"]).toBe(2);
    });

    it("should flag decimal mapping as lossy with a warning", () => {
      const model = makeModel([
        makeField({
          name: "amount",
          type: "decimal",
          precision: 38,
          scale: 10,
          sortOrder: 0,
        }),
      ]);

      const { result } = emitAndParse(model);

      expect(result.warnings.length).toBeGreaterThan(0);
      const lossyWarning = result.warnings.find(
        (w) => w.fieldName === "amount" && w.message.includes("Lossy")
      );
      expect(lossyWarning).toBeDefined();
    });

    it("should map enum to string with enum array of values", () => {
      const model = makeModel([
        makeField({
          name: "status",
          type: "enum",
          sortOrder: 0,
          decorators: {
            quality: {
              rules: [
                {
                  type: "enum_values",
                  params: { values: ["active", "inactive", "pending"] },
                },
              ],
            },
          },
        }),
      ]);

      const { parsed } = emitAndParse(model);
      const props = parsed.components.schemas.TestEntity.properties as Record<
        string,
        Record<string, unknown>
      >;

      expect(props.status.type).toBe("string");
      expect(props.status.enum).toEqual(["active", "inactive", "pending"]);
    });

    it("should map array to type: array with items", () => {
      const model = makeModel([
        makeField({
          name: "tags",
          type: "array",
          sortOrder: 0,
          complexType: {
            arrayElementType: "string",
          },
        }),
      ]);

      const { parsed } = emitAndParse(model);
      const props = parsed.components.schemas.TestEntity.properties as Record<
        string,
        Record<string, unknown>
      >;

      expect(props.tags.type).toBe("array");
      expect(props.tags.items).toEqual({ type: "string" });
    });

    it("should map array of integers with correct items type", () => {
      const model = makeModel([
        makeField({
          name: "scores",
          type: "array",
          sortOrder: 0,
          complexType: {
            arrayElementType: "integer",
          },
        }),
      ]);

      const { parsed } = emitAndParse(model);
      const props = parsed.components.schemas.TestEntity.properties as Record<
        string,
        Record<string, unknown>
      >;

      expect(props.scores.type).toBe("array");
      expect(props.scores.items).toEqual({ type: "integer", format: "int64" });
    });

    it("should map plainDate to string/date", () => {
      const model = makeModel([
        makeField({ name: "birth_date", type: "plainDate", sortOrder: 0 }),
      ]);

      const { parsed } = emitAndParse(model);
      const props = parsed.components.schemas.TestEntity.properties as Record<
        string,
        Record<string, unknown>
      >;

      expect(props.birth_date.type).toBe("string");
      expect(props.birth_date.format).toBe("date");
    });

    it("should map utcDateTime to string/date-time", () => {
      const model = makeModel([
        makeField({ name: "created_at", type: "utcDateTime", sortOrder: 0 }),
      ]);

      const { parsed } = emitAndParse(model);
      const props = parsed.components.schemas.TestEntity.properties as Record<
        string,
        Record<string, unknown>
      >;

      expect(props.created_at.type).toBe("string");
      expect(props.created_at.format).toBe("date-time");
    });

    it("should map integer to integer/int64", () => {
      const model = makeModel([
        makeField({ name: "count", type: "integer", sortOrder: 0 }),
      ]);

      const { parsed } = emitAndParse(model);
      const props = parsed.components.schemas.TestEntity.properties as Record<
        string,
        Record<string, unknown>
      >;

      expect(props.count.type).toBe("integer");
      expect(props.count.format).toBe("int64");
    });

    it("should map boolean to boolean", () => {
      const model = makeModel([
        makeField({ name: "is_verified", type: "boolean", sortOrder: 0 }),
      ]);

      const { parsed } = emitAndParse(model);
      const props = parsed.components.schemas.TestEntity.properties as Record<
        string,
        Record<string, unknown>
      >;

      expect(props.is_verified.type).toBe("boolean");
      expect(props.is_verified.format).toBeUndefined();
    });

    it("should map float to number/float", () => {
      const model = makeModel([
        makeField({ name: "rating", type: "float", sortOrder: 0 }),
      ]);

      const { parsed } = emitAndParse(model);
      const props = parsed.components.schemas.TestEntity.properties as Record<
        string,
        Record<string, unknown>
      >;

      expect(props.rating.type).toBe("number");
      expect(props.rating.format).toBe("float");
    });

    it("should map reference to $ref with referenced entity name", () => {
      const model = makeModel([
        makeField({
          name: "department",
          type: "reference",
          sortOrder: 0,
          complexType: {
            referencedEntityId: "entity-dept",
            referencedEntityName: "Department",
          },
        }),
      ]);

      const { parsed } = emitAndParse(model);
      const props = parsed.components.schemas.TestEntity.properties as Record<
        string,
        Record<string, unknown>
      >;

      expect(props.department.$ref).toBe("#/components/schemas/Department");
    });

    it("should translate range quality rule to minimum/maximum", () => {
      const model = makeModel([
        makeField({
          name: "score",
          type: "integer",
          sortOrder: 0,
          decorators: {
            quality: {
              rules: [
                { type: "range", params: { min: 0, max: 100 } },
              ],
            },
          },
        }),
      ]);

      const { parsed } = emitAndParse(model);
      const props = parsed.components.schemas.TestEntity.properties as Record<
        string,
        Record<string, unknown>
      >;

      expect(props.score.minimum).toBe(0);
      expect(props.score.maximum).toBe(100);
    });

    it("should translate min_length quality rule to minLength", () => {
      const model = makeModel([
        makeField({
          name: "username",
          type: "string",
          sortOrder: 0,
          decorators: {
            quality: {
              rules: [{ type: "min_length", params: { value: 3 } }],
            },
          },
        }),
      ]);

      const { parsed } = emitAndParse(model);
      const props = parsed.components.schemas.TestEntity.properties as Record<
        string,
        Record<string, unknown>
      >;

      expect(props.username.minLength).toBe(3);
    });

    it("should translate max_length quality rule to maxLength", () => {
      const model = makeModel([
        makeField({
          name: "bio",
          type: "string",
          sortOrder: 0,
          decorators: {
            quality: {
              rules: [{ type: "max_length", params: { value: 500 } }],
            },
          },
        }),
      ]);

      const { parsed } = emitAndParse(model);
      const props = parsed.components.schemas.TestEntity.properties as Record<
        string,
        Record<string, unknown>
      >;

      expect(props.bio.maxLength).toBe(500);
    });

    it("should translate regex quality rule to pattern", () => {
      const model = makeModel([
        makeField({
          name: "email",
          type: "string",
          sortOrder: 0,
          decorators: {
            quality: {
              rules: [
                {
                  type: "regex",
                  params: { pattern: "^[a-zA-Z0-9+_.-]+@[a-zA-Z0-9.-]+$" },
                },
              ],
            },
          },
        }),
      ]);

      const { parsed } = emitAndParse(model);
      const props = parsed.components.schemas.TestEntity.properties as Record<
        string,
        Record<string, unknown>
      >;

      expect(props.email.pattern).toBe(
        "^[a-zA-Z0-9+_.-]+@[a-zA-Z0-9.-]+$"
      );
    });

    it("should omit description when field has no description", () => {
      const model = makeModel([
        makeField({ name: "code", type: "string", description: "", sortOrder: 0 }),
      ]);

      const { parsed } = emitAndParse(model);
      const props = parsed.components.schemas.TestEntity.properties as Record<
        string,
        Record<string, unknown>
      >;

      expect(props.code.description).toBeUndefined();
    });

    it("should use semantics.description when field.description is empty", () => {
      const model = makeModel([
        makeField({
          name: "code",
          type: "string",
          description: "",
          sortOrder: 0,
          decorators: {
            semantics: { description: "Product code identifier" },
          },
        }),
      ]);

      const { parsed } = emitAndParse(model);
      const props = parsed.components.schemas.TestEntity.properties as Record<
        string,
        Record<string, unknown>
      >;

      expect(props.code.description).toBe("Product code identifier");
    });

    it("should produce deterministic output for the same input", () => {
      const model = makeModel([
        makeField({ name: "alpha", type: "string", sortOrder: 0 }),
        makeField({ name: "beta", type: "integer", sortOrder: 1 }),
        makeField({ name: "gamma", type: "boolean", sortOrder: 2 }),
      ]);

      const result1 = openApiEmitter.emit(model, defaultPolicies);
      const result2 = openApiEmitter.emit(model, defaultPolicies);

      expect(result1.output).toBe(result2.output);
    });

    it("should handle empty entity with no fields", () => {
      const model = makeModel([]);

      const { result, parsed } = emitAndParse(model);

      expect(result.warnings).toHaveLength(0);
      const schema = parsed.components.schemas.TestEntity;
      expect(schema.type).toBe("object");
      expect(schema.properties).toEqual({});
      expect(schema.required).toBeUndefined();
    });

    it("should handle entity with all nullable fields (omit required)", () => {
      const model = makeModel([
        makeField({ name: "a", type: "string", nullable: true, sortOrder: 0 }),
        makeField({ name: "b", type: "string", nullable: true, sortOrder: 1 }),
      ]);

      const { parsed } = emitAndParse(model);
      const schema = parsed.components.schemas.TestEntity;

      expect(schema.required).toBeUndefined();
    });

    it("should map url to string/uri", () => {
      const model = makeModel([
        makeField({ name: "website", type: "url", sortOrder: 0 }),
      ]);

      const { parsed } = emitAndParse(model);
      const props = parsed.components.schemas.TestEntity.properties as Record<
        string,
        Record<string, unknown>
      >;

      expect(props.website.type).toBe("string");
      expect(props.website.format).toBe("uri");
    });

    it("should handle multiple quality rules on a single field", () => {
      const model = makeModel([
        makeField({
          name: "username",
          type: "string",
          sortOrder: 0,
          decorators: {
            quality: {
              rules: [
                { type: "min_length", params: { value: 3 } },
                { type: "max_length", params: { value: 50 } },
                { type: "regex", params: { pattern: "^[a-zA-Z0-9_]+$" } },
              ],
            },
          },
        }),
      ]);

      const { parsed } = emitAndParse(model);
      const props = parsed.components.schemas.TestEntity.properties as Record<
        string,
        Record<string, unknown>
      >;

      expect(props.username.minLength).toBe(3);
      expect(props.username.maxLength).toBe(50);
      expect(props.username.pattern).toBe("^[a-zA-Z0-9_]+$");
    });
  });

  describe("validate()", () => {
    it("should pass validation for valid OpenAPI schema", () => {
      const model = makeModel([
        makeField({ name: "id", type: "string", sortOrder: 0 }),
        makeField({ name: "count", type: "integer", sortOrder: 1 }),
      ]);

      const result = openApiEmitter.emit(model, defaultPolicies);
      const validation = openApiEmitter.validate(result.output);

      expect(validation.valid).toBe(true);
      expect(validation.errors).toHaveLength(0);
    });

    it("should fail validation for invalid YAML", () => {
      const validation = openApiEmitter.validate("{{invalid: yaml::");

      expect(validation.valid).toBe(false);
      expect(validation.errors.length).toBeGreaterThan(0);
    });

    it("should fail validation for missing components", () => {
      const validation = openApiEmitter.validate("foo: bar\n");

      expect(validation.valid).toBe(false);
      expect(
        validation.errors.some((e) => e.message.includes("components"))
      ).toBe(true);
    });

    it("should fail validation for missing schemas", () => {
      const validation = openApiEmitter.validate(
        "components:\n  other: {}\n"
      );

      expect(validation.valid).toBe(false);
      expect(
        validation.errors.some((e) => e.message.includes("schemas"))
      ).toBe(true);
    });

    it("should fail validation for invalid property type", () => {
      const yaml = `
components:
  schemas:
    Bad:
      type: object
      properties:
        field1:
          type: foobar
`;
      const validation = openApiEmitter.validate(yaml);

      expect(validation.valid).toBe(false);
      expect(
        validation.errors.some((e) => e.message.includes("foobar"))
      ).toBe(true);
    });

    it("should fail validation for invalid $ref path", () => {
      const yaml = `
components:
  schemas:
    Bad:
      type: object
      properties:
        ref_field:
          $ref: "invalid/path"
`;
      const validation = openApiEmitter.validate(yaml);

      expect(validation.valid).toBe(false);
      expect(
        validation.errors.some((e) => e.message.includes("$ref"))
      ).toBe(true);
    });

    it("should fail validation for required field not in properties", () => {
      const yaml = `
components:
  schemas:
    Bad:
      type: object
      required:
        - nonexistent
      properties:
        actual:
          type: string
`;
      const validation = openApiEmitter.validate(yaml);

      expect(validation.valid).toBe(false);
      expect(
        validation.errors.some((e) => e.message.includes("nonexistent"))
      ).toBe(true);
    });

    it("should pass validation for schema with $ref properties", () => {
      const yaml = `
components:
  schemas:
    Order:
      type: object
      properties:
        customer:
          $ref: "#/components/schemas/Customer"
`;
      const validation = openApiEmitter.validate(yaml);

      expect(validation.valid).toBe(true);
    });

    it("should validate emitted output from a complex model", () => {
      const model = makeModel([
        makeField({ name: "id", type: "string", sortOrder: 0 }),
        makeField({ name: "price", type: "decimal", precision: 10, scale: 2, sortOrder: 1 }),
        makeField({
          name: "status",
          type: "enum",
          sortOrder: 2,
          decorators: {
            quality: {
              rules: [
                { type: "enum_values", params: { values: ["active", "inactive"] } },
              ],
            },
          },
        }),
        makeField({
          name: "tags",
          type: "array",
          sortOrder: 3,
          complexType: { arrayElementType: "string" },
        }),
        makeField({
          name: "owner",
          type: "reference",
          sortOrder: 4,
          complexType: {
            referencedEntityId: "entity-user",
            referencedEntityName: "User",
          },
        }),
        makeField({ name: "notes", type: "string", nullable: true, sortOrder: 5 }),
      ]);

      const result = openApiEmitter.emit(model, defaultPolicies);
      const validation = openApiEmitter.validate(result.output);

      expect(validation.valid).toBe(true);
    });
  });

  describe("emitter metadata", () => {
    it("should have correct name, version, and targetFormat", () => {
      expect(openApiEmitter.name).toBe("openapi");
      expect(openApiEmitter.version).toBe("1.0.0");
      expect(openApiEmitter.targetFormat).toBe("openapi");
    });
  });
});

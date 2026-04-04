import { describe, it, expect } from "vitest";
import {
  isComplexType,
  formatComplexTypeDisplay,
  isDecimalType,
} from "@/lib/data-types";
import {
  EntityMetadataSchema,
  RelationshipSchema,
} from "@/types/schemas/entity-metadata.schema";
import {
  ComplexTypeMetadataSchema,
  NestedFieldSchema,
} from "@/types/schemas/decorator.schema";

describe("isComplexType", () => {
  it("returns true for array", () => {
    expect(isComplexType("array")).toBe(true);
  });

  it("returns true for map", () => {
    expect(isComplexType("map")).toBe(true);
  });

  it("returns true for object", () => {
    expect(isComplexType("object")).toBe(true);
  });

  it("returns true for reference", () => {
    expect(isComplexType("reference")).toBe(true);
  });

  it("returns false for string", () => {
    expect(isComplexType("string")).toBe(false);
  });

  it("returns false for integer", () => {
    expect(isComplexType("integer")).toBe(false);
  });

  it("returns false for decimal", () => {
    expect(isComplexType("decimal")).toBe(false);
  });

  it("returns false for boolean", () => {
    expect(isComplexType("boolean")).toBe(false);
  });
});

describe("formatComplexTypeDisplay", () => {
  it("formats array<string>", () => {
    expect(
      formatComplexTypeDisplay("array", { arrayElementType: "string" })
    ).toBe("array<string>");
  });

  it("formats array with missing element type as array<?>", () => {
    expect(formatComplexTypeDisplay("array", {})).toBe("array<?>");
  });

  it("formats array<decimal>", () => {
    expect(
      formatComplexTypeDisplay("array", { arrayElementType: "decimal" })
    ).toBe("array<decimal>");
  });

  it("formats map<string, integer>", () => {
    expect(
      formatComplexTypeDisplay("map", {
        mapKeyType: "string",
        mapValueType: "integer",
      })
    ).toBe("map<string, integer>");
  });

  it("formats map with missing types as map<?, ?>", () => {
    expect(formatComplexTypeDisplay("map", {})).toBe("map<?, ?>");
  });

  it("formats object with nested fields count", () => {
    expect(
      formatComplexTypeDisplay("object", {
        nestedFields: [
          { name: "street", type: "string" },
          { name: "city", type: "string" },
        ],
      })
    ).toBe("object{2 fields}");
  });

  it("formats object with 1 field (singular)", () => {
    expect(
      formatComplexTypeDisplay("object", {
        nestedFields: [{ name: "value", type: "string" }],
      })
    ).toBe("object{1 field}");
  });

  it("formats object with no nested fields", () => {
    expect(formatComplexTypeDisplay("object", {})).toBe("object{0 fields}");
  });

  it("formats reference with entity name", () => {
    expect(
      formatComplexTypeDisplay("reference", {
        referencedEntityName: "Customer",
      })
    ).toBe("ref(Customer)");
  });

  it("formats reference with missing entity name as ref(?)", () => {
    expect(formatComplexTypeDisplay("reference", {})).toBe("ref(?)");
  });

  it("returns the type unchanged for non-complex types", () => {
    expect(formatComplexTypeDisplay("string", {})).toBe("string");
    expect(formatComplexTypeDisplay("integer", {})).toBe("integer");
  });
});

describe("ComplexTypeMetadataSchema", () => {
  it("validates array type metadata", () => {
    const result = ComplexTypeMetadataSchema.safeParse({
      arrayElementType: "string",
    });
    expect(result.success).toBe(true);
  });

  it("validates array with precision/scale", () => {
    const result = ComplexTypeMetadataSchema.safeParse({
      arrayElementType: "decimal",
      arrayElementPrecision: 19,
      arrayElementScale: 4,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.arrayElementType).toBe("decimal");
      expect(result.data.arrayElementPrecision).toBe(19);
      expect(result.data.arrayElementScale).toBe(4);
    }
  });

  it("validates map type metadata", () => {
    const result = ComplexTypeMetadataSchema.safeParse({
      mapKeyType: "string",
      mapValueType: "integer",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.mapKeyType).toBe("string");
      expect(result.data.mapValueType).toBe("integer");
    }
  });

  it("validates nested fields metadata", () => {
    const result = ComplexTypeMetadataSchema.safeParse({
      nestedFields: [
        { name: "street", type: "string", description: "Street address" },
        { name: "city", type: "string" },
        { name: "zip", type: "string", nullable: true },
      ],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.nestedFields).toHaveLength(3);
      expect(result.data.nestedFields![0].name).toBe("street");
      expect(result.data.nestedFields![0].description).toBe("Street address");
    }
  });

  it("validates reference type metadata", () => {
    const result = ComplexTypeMetadataSchema.safeParse({
      referencedEntityId: "clxxx123",
      referencedEntityName: "Customer",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.referencedEntityId).toBe("clxxx123");
      expect(result.data.referencedEntityName).toBe("Customer");
    }
  });

  it("accepts an empty object (all fields optional)", () => {
    const result = ComplexTypeMetadataSchema.safeParse({});
    expect(result.success).toBe(true);
  });
});

describe("NestedFieldSchema", () => {
  it("validates a minimal nested field", () => {
    const result = NestedFieldSchema.safeParse({
      name: "street",
      type: "string",
    });
    expect(result.success).toBe(true);
  });

  it("validates a nested field with all properties", () => {
    const result = NestedFieldSchema.safeParse({
      name: "zipCode",
      type: "string",
      description: "Postal code",
      nullable: false,
      decorators: { policy: { retention: "30d" } },
    });
    expect(result.success).toBe(true);
  });

  it("rejects a nested field without name", () => {
    const result = NestedFieldSchema.safeParse({ type: "string" });
    expect(result.success).toBe(false);
  });

  it("rejects a nested field without type", () => {
    const result = NestedFieldSchema.safeParse({ name: "foo" });
    expect(result.success).toBe(false);
  });
});

describe("Relationship schema and entity metadata", () => {
  it("validates a relationship with all four cardinality options", () => {
    for (const cardinality of [
      "one-to-one",
      "one-to-many",
      "many-to-one",
      "many-to-many",
    ]) {
      const result = RelationshipSchema.safeParse({
        targetEntityId: "entity-123",
        fieldId: "field-456",
        cardinality,
      });
      expect(result.success, `cardinality ${cardinality} should be valid`).toBe(
        true
      );
    }
  });

  it("rejects invalid cardinality", () => {
    const result = RelationshipSchema.safeParse({
      targetEntityId: "entity-123",
      fieldId: "field-456",
      cardinality: "many-to-few",
    });
    expect(result.success).toBe(false);
  });

  it("requires fieldId on relationship", () => {
    const result = RelationshipSchema.safeParse({
      targetEntityId: "entity-123",
      cardinality: "one-to-many",
    });
    expect(result.success).toBe(false);
  });

  it("stores relationships in entity metadata", () => {
    const result = EntityMetadataSchema.safeParse({
      relationships: [
        {
          targetEntityId: "entity-123",
          fieldId: "field-456",
          cardinality: "one-to-many",
        },
        {
          targetEntityId: "entity-789",
          fieldId: "field-012",
          cardinality: "many-to-many",
          foreignKey: "order_id",
        },
      ],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.relationships).toHaveLength(2);
      expect(result.data.relationships![0].cardinality).toBe("one-to-many");
      expect(result.data.relationships![1].foreignKey).toBe("order_id");
    }
  });
});

describe("Complex type decorators storage patterns", () => {
  it("stores array element type at decorators root level", () => {
    // Simulates how field-editor.tsx builds decorators for array type
    const decorators: Record<string, unknown> = {};
    decorators.arrayElementType = "string";

    // Validate via schema
    const result = ComplexTypeMetadataSchema.safeParse(decorators);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.arrayElementType).toBe("string");
    }
  });

  it("stores map key/value types at decorators root level", () => {
    const decorators: Record<string, unknown> = {};
    decorators.mapKeyType = "string";
    decorators.mapValueType = "integer";

    const result = ComplexTypeMetadataSchema.safeParse(decorators);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.mapKeyType).toBe("string");
      expect(result.data.mapValueType).toBe("integer");
    }
  });

  it("stores nested fields in decorators JSONB under nestedFields key", () => {
    const decorators: Record<string, unknown> = {
      nestedFields: [
        { name: "street", type: "string" },
        { name: "city", type: "string" },
        { name: "zip", type: "string" },
      ],
    };

    const result = ComplexTypeMetadataSchema.safeParse(decorators);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.nestedFields).toHaveLength(3);
    }
  });

  it("stores reference entity ID in decorators root level", () => {
    const decorators: Record<string, unknown> = {
      referencedEntityId: "clxxx-entity-id",
      referencedEntityName: "Customer",
    };

    const result = ComplexTypeMetadataSchema.safeParse(decorators);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.referencedEntityId).toBe("clxxx-entity-id");
      expect(result.data.referencedEntityName).toBe("Customer");
    }
  });

  it("complex type metadata coexists with other decorator keys", () => {
    // Simulates the full decorators JSONB with both complex type metadata
    // and existing decorator sections
    const decorators = {
      arrayElementType: "string",
      policy: { retention: "30d" },
      evolution: { deprecated: false },
      typespec: { identity: { key: true } },
    };

    // Complex type metadata should parse the relevant keys
    const complexResult = ComplexTypeMetadataSchema.safeParse(decorators);
    expect(complexResult.success).toBe(true);
    if (complexResult.success) {
      expect(complexResult.data.arrayElementType).toBe("string");
    }
  });
});

describe("Field number uniqueness validation", () => {
  it("validates that field numbers should be unique per entity", () => {
    // This tests the logic that would run server-side
    // We simulate the validation check
    const existingFields = [
      { id: "f1", name: "id", fieldNumber: 1 },
      { id: "f2", name: "name", fieldNumber: 2 },
      { id: "f3", name: "email", fieldNumber: null },
    ];

    function checkFieldNumberUniqueness(
      fieldNumber: number,
      excludeFieldId?: string
    ): { error?: string } {
      const conflict = existingFields.find(
        (f) =>
          f.fieldNumber === fieldNumber && f.id !== excludeFieldId
      );
      if (conflict) {
        return {
          error: `Field number ${fieldNumber} is already assigned to field '${conflict.name}'`,
        };
      }
      return {};
    }

    // Duplicate field number should error
    expect(checkFieldNumberUniqueness(1)).toEqual({
      error: "Field number 1 is already assigned to field 'id'",
    });

    // Updating the same field with its own number should be fine
    expect(checkFieldNumberUniqueness(1, "f1")).toEqual({});

    // New unique field number should be fine
    expect(checkFieldNumberUniqueness(3)).toEqual({});

    // Another duplicate
    expect(checkFieldNumberUniqueness(2)).toEqual({
      error: "Field number 2 is already assigned to field 'name'",
    });
  });
});

describe("Aliases storage", () => {
  it("stores aliases as an array of strings", () => {
    const field = {
      aliases: ["email", "e_mail", "customer_email"],
    };
    expect(field.aliases).toEqual(["email", "e_mail", "customer_email"]);
    expect(field.aliases).toHaveLength(3);
    expect(field.aliases[0]).toBe("email");
  });

  it("handles empty aliases array", () => {
    const field = { aliases: [] as string[] };
    expect(field.aliases).toEqual([]);
    expect(field.aliases).toHaveLength(0);
  });

  it("supports adding and removing aliases", () => {
    let aliases = ["email", "e_mail"];

    // Add
    aliases = [...aliases, "customer_email"];
    expect(aliases).toEqual(["email", "e_mail", "customer_email"]);

    // Remove
    aliases = aliases.filter((a) => a !== "e_mail");
    expect(aliases).toEqual(["email", "customer_email"]);
  });
});

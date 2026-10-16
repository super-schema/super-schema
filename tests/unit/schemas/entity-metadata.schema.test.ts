import { describe, it, expect } from "vitest";
import { EntityMetadataSchema } from "@/types/schemas/entity-metadata.schema";

describe("EntityMetadataSchema", () => {
  it("accepts an empty object (all fields optional)", () => {
    const result = EntityMetadataSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it("accepts valid metadata with tags", () => {
    const result = EntityMetadataSchema.safeParse({
      tags: ["core", "financial"],
    });
    expect(result.success).toBe(true);
  });

  it("accepts valid metadata with relationships", () => {
    const result = EntityMetadataSchema.safeParse({
      relationships: [
        {
          targetEntityId: "cuid123",
          fieldId: "field-1",
          cardinality: "one-to-many",
          foreignKey: "customer_id",
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("accepts valid deprecation info", () => {
    const result = EntityMetadataSchema.safeParse({
      deprecation: {
        deprecated: true,
        since: "2024-01-01",
        replacement: "CustomerV2",
        reason: "Schema redesign",
      },
    });
    expect(result.success).toBe(true);
  });

  it("accepts deprecation info with replacementEntityId and migrationNotes", () => {
    const result = EntityMetadataSchema.safeParse({
      deprecation: {
        deprecated: true,
        since: "2026-04-02",
        replacementEntityId: "ent-new-123",
        migrationNotes: "Use CustomerV2 model instead",
      },
    });
    expect(result.success).toBe(true);
  });

  it("accepts custom metadata", () => {
    const result = EntityMetadataSchema.safeParse({
      custom: { team: "data-platform", priority: 1 },
    });
    expect(result.success).toBe(true);
  });

  it("rejects invalid relationship cardinality", () => {
    const result = EntityMetadataSchema.safeParse({
      relationships: [
        { targetEntityId: "cuid123", fieldId: "field-1", cardinality: "invalid-relation" },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("keeps the import format the importer recorded (it must survive a parse that strips unknown keys)", () => {
    const result = EntityMetadataSchema.safeParse({ tags: ["core"], sourceFormat: "avro" });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toEqual({ tags: ["core"], sourceFormat: "avro" });
  });

  it("rejects a sourceFormat that is not a string", () => {
    expect(EntityMetadataSchema.safeParse({ sourceFormat: 3 }).success).toBe(false);
  });

  it("rejects tags with non-string values", () => {
    const result = EntityMetadataSchema.safeParse({
      tags: [123, true],
    });
    expect(result.success).toBe(false);
  });
});

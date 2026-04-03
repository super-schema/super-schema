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
          type: "one-to-many",
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

  it("accepts custom metadata", () => {
    const result = EntityMetadataSchema.safeParse({
      custom: { team: "data-platform", priority: 1 },
    });
    expect(result.success).toBe(true);
  });

  it("rejects invalid relationship type", () => {
    const result = EntityMetadataSchema.safeParse({
      relationships: [
        { targetEntityId: "cuid123", type: "invalid-relation" },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("rejects tags with non-string values", () => {
    const result = EntityMetadataSchema.safeParse({
      tags: [123, true],
    });
    expect(result.success).toBe(false);
  });
});

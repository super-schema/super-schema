import { describe, expect, it } from "vitest";
import { MetadataAttributeDefinitionSchema } from "@/types/schemas/metadata-attribute";

const base = { key: "x-data-class", label: "Data class", valueSchema: { type: "string" }, targets: ["field"] };

describe("MetadataAttributeDefinitionSchema", () => {
  it("accepts a minimal definition and applies defaults", () => {
    const r = MetadataAttributeDefinitionSchema.parse(base);
    expect(r).toMatchObject({ scope: "schema", placement: "field", requiredWhen: "never", description: "" });
  });
  it("rejects a key without x-", () => {
    expect(MetadataAttributeDefinitionSchema.safeParse({ ...base, key: "securityClassification" }).success).toBe(false);
  });
  it("rejects a key longer than 64", () => {
    expect(MetadataAttributeDefinitionSchema.safeParse({ ...base, key: "x-" + "a".repeat(63) }).success).toBe(false);
  });
  it("rejects unknown targets and empty targets", () => {
    expect(MetadataAttributeDefinitionSchema.safeParse({ ...base, targets: ["bogus"] }).success).toBe(false);
    expect(MetadataAttributeDefinitionSchema.safeParse({ ...base, targets: [] }).success).toBe(false);
  });
  it("rejects a value schema outside the subset", () => {
    expect(MetadataAttributeDefinitionSchema.safeParse({ ...base, valueSchema: { type: "string", oneOf: [] } }).success).toBe(false);
  });
  it("requires derive keys to be properties of an object valueSchema", () => {
    const vs = { type: "object", properties: { data_class: { type: "string" } } };
    expect(MetadataAttributeDefinitionSchema.safeParse({ ...base, valueSchema: vs, derive: { data_class: "{class}" } }).success).toBe(true);
    expect(MetadataAttributeDefinitionSchema.safeParse({ ...base, valueSchema: vs, derive: { nope: "{class}" } }).success).toBe(false);
    expect(MetadataAttributeDefinitionSchema.safeParse({ ...base, derive: { a: "{class}" } }).success).toBe(false);
  });
  it("abc-primitive placement requires the field target", () => {
    expect(MetadataAttributeDefinitionSchema.safeParse({ ...base, placement: "abc-primitive", targets: ["entity"] }).success).toBe(false);
    expect(MetadataAttributeDefinitionSchema.safeParse({ ...base, placement: "abc-primitive", targets: ["field", "entity"] }).success).toBe(true);
  });
});

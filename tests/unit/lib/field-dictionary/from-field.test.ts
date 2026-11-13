import { describe, expect, it } from "vitest";
import { dictionaryEntryFromField } from "@/lib/field-dictionary/from-field";
import type { MetadataAttributeDefinition } from "@/types/schemas/metadata-attribute";

const def = (over: Partial<MetadataAttributeDefinition> & { key: string }): MetadataAttributeDefinition => ({
  label: over.key,
  description: "",
  valueSchema: { type: "string" },
  targets: ["field"],
  scope: "schema",
  placement: "field",
  requiredWhen: "never",
  ...over,
});

const DEFS = [
  def({
    key: "x-securityClassification",
    valueSchema: { type: "object", properties: { data_class: { type: "string" }, data_category: { type: "string" } } },
    derive: { data_class: "{class}" },
  }),
  def({ key: "x-review-note", scope: "internal" }),
  def({ key: "x-owner" }),
];

const field = (extensions: Record<string, unknown>) => ({
  name: "email",
  type: "string",
  description: "Customer email",
  classification: "PII",
  decorators: { typespec: { extensions: { openapi: extensions } } },
});

describe("dictionaryEntryFromField", () => {
  it("copies name, type, description, classification and schema-scoped attributes without derived members", () => {
    const entry = dictionaryEntryFromField(
      field({
        "x-securityClassification": { data_class: "class2", data_category: "ConsumerPersonal" },
        "x-review-note": "check with legal",
      }),
      DEFS,
    );
    expect(entry).toEqual({
      name: "email",
      type: "string",
      description: "Customer email",
      classification: "PII",
      attributes: { "x-securityClassification": { data_category: "ConsumerPersonal" } },
    });
  });

  it("drops an attribute whose members were all derived, and keys without a definition", () => {
    const entry = dictionaryEntryFromField(
      field({ "x-securityClassification": { data_class: "class2" }, "x-unknown": 1, "x-owner": "team-a" }),
      DEFS,
    );
    expect(entry.attributes).toEqual({ "x-owner": "team-a" });
  });

  it("excludes undefined values", () => {
    const entry = dictionaryEntryFromField(field({ "x-owner": undefined }), DEFS);
    expect(entry.attributes).toEqual({});
  });
});

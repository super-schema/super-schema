import { describe, expect, it } from "vitest";
import { METADATA_PACKS, getMetadataPack } from "@/lib/metadata-attributes/packs";
import { PAYPAL_SECURITY_CLASSIFICATION_PACK } from "@/lib/metadata-attributes/packs/paypal-security-classification";
import { MetadataAttributeDefinitionSchema } from "@/types/schemas/metadata-attribute";
import { validateValue } from "@/lib/metadata-attributes/value-schema";

describe("metadata packs", () => {
  it("registers the paypal security classification pack under its id", () => {
    expect(getMetadataPack("paypal-security-classification")).toBe(PAYPAL_SECURITY_CLASSIFICATION_PACK);
    expect(getMetadataPack("nope")).toBeUndefined();
    expect(METADATA_PACKS.map((p) => p.id)).toEqual(["paypal-security-classification"]);
  });

  it("every definition parses against the dictionary schema", () => {
    for (const pack of METADATA_PACKS) {
      for (const def of pack.definitions) expect(MetadataAttributeDefinitionSchema.safeParse(def).success).toBe(true);
    }
  });

  it("defines x-securityClassification exactly as the spec says", () => {
    const [def] = PAYPAL_SECURITY_CLASSIFICATION_PACK.definitions;
    expect(PAYPAL_SECURITY_CLASSIFICATION_PACK.definitions).toHaveLength(1);
    expect(def).toMatchObject({
      key: "x-securityClassification",
      label: "Security classification",
      targets: ["field"],
      scope: "schema",
      placement: "abc-primitive",
      derive: { data_class: "class{class}" },
      requiredWhen: "primitive",
    });
    const props = (def.valueSchema as { properties: Record<string, { pattern?: string; enum?: string[] }> }).properties;
    expect(props.data_class.pattern).toBe("^class[1-5]$");
    expect(props.data_category.enum).toEqual([
      "ConsumerPersonal", "BusinessPersonal", "BusinessCompany", "EmployeePersonal", "PayPalCompany", "Intrinsic",
    ]);
    expect(validateValue({ data_class: "class3", data_category: "Intrinsic" }, def.valueSchema)).toEqual([]);
    expect(validateValue({ data_class: "class9" }, def.valueSchema).length).toBeGreaterThan(0);
    expect(validateValue({ data_category: "Other" }, def.valueSchema).length).toBeGreaterThan(0);
  });
});

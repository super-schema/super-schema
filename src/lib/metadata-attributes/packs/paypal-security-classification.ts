import type { MetadataPack } from "@/lib/metadata-attributes/packs";

/** The data categories of the security classification pack, in the order the editor offers them. */
export const SECURITY_DATA_CATEGORIES = [
  "ConsumerPersonal",
  "BusinessPersonal",
  "BusinessCompany",
  "EmployeePersonal",
  "PayPalCompany",
  "Intrinsic",
] as const;

/**
 * `x-securityClassification`: users pick `data_category`; `data_class` always follows the field's classification through the fixed class number.
 * Definitions are only added to a tenant when it installs this pack.
 */
export const PAYPAL_SECURITY_CLASSIFICATION_PACK: MetadataPack = {
  // Keep the installation ID stable for tenants that already installed this pack.
  id: "paypal-security-classification",
  name: "Security classification",
  description: "Adds x-securityClassification: a data_class derived from the field's classification and a data_category chosen by the author.",
  definitions: [
    {
      key: "x-securityClassification",
      label: "Security classification",
      description: "",
      targets: ["field"],
      scope: "schema",
      placement: "abc-primitive",
      valueSchema: {
        type: "object",
        properties: {
          data_class: { type: "string", pattern: "^class[1-5]$" },
          data_category: { type: "string", enum: [...SECURITY_DATA_CATEGORIES] },
        },
      },
      derive: { data_class: "class{class}" },
      requiredWhen: "primitive",
    },
  ],
};

import type { MetadataAttributeDefinition } from "@/types/schemas/metadata-attribute";

export const SECURITY: MetadataAttributeDefinition = {
  key: "x-securityClassification",
  label: "Security classification",
  description: "How sensitive the data is",
  valueSchema: {
    type: "object",
    properties: {
      data_category: {
        type: "string",
        enum: ["ConsumerPersonal", "BusinessPersonal", "BusinessCompany", "EmployeePersonal", "PayPalCompany", "Intrinsic"],
      },
      data_class: { type: "string" },
    },
    required: ["data_category"],
  },
  targets: ["field"],
  scope: "schema",
  placement: "field",
  derive: { data_class: "{class}" },
  requiredWhen: "never",
};

export const ENTITY_ONLY: MetadataAttributeDefinition = {
  key: "x-owner-team",
  label: "Owner team",
  description: "",
  valueSchema: { type: "string" },
  targets: ["entity"],
  scope: "schema",
  placement: "field",
  derive: null,
  requiredWhen: "never",
};

export const RETENTION: MetadataAttributeDefinition = {
  key: "x-retentionDays",
  label: "Retention days",
  description: "",
  valueSchema: { type: "integer", minimum: 1 },
  targets: ["field", "entity"],
  scope: "schema",
  placement: "field",
  derive: null,
  requiredWhen: "never",
};

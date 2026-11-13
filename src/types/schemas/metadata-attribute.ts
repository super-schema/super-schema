import { z } from "zod";
import { checkValueSchema, type ValueSchema } from "@/lib/metadata-attributes/value-schema";

export const METADATA_ATTRIBUTE_TARGETS = ["field", "entity", "operation", "channel", "message"] as const;
export const METADATA_ATTRIBUTE_KEY_REGEX = /^x-[A-Za-z0-9][A-Za-z0-9_.-]*$/;

export const MetadataAttributeKeySchema = z
  .string()
  .max(64)
  .regex(METADATA_ATTRIBUTE_KEY_REGEX, 'Key must start with "x-" followed by letters, digits, "_", "." or "-"');

const ValueSchemaField = z.custom<ValueSchema>((v) => checkValueSchema(v).length === 0, {
  message: "valueSchema is outside the supported subset",
});

const ObjectShape = z.object({
  key: MetadataAttributeKeySchema,
  label: z.string().min(1),
  description: z.string().default(""),
  valueSchema: ValueSchemaField,
  targets: z.array(z.enum(METADATA_ATTRIBUTE_TARGETS)).min(1),
  scope: z.enum(["schema", "internal"]).default("schema"),
  placement: z.enum(["field", "abc-primitive"]).default("field"),
  derive: z.record(z.string(), z.string()).nullish(),
  requiredWhen: z.enum(["never", "always", "primitive"]).default("never"),
  pack: z.string().nullish(),
});

type Shape = z.infer<typeof ObjectShape>;

function refine(v: Pick<Shape, "valueSchema" | "derive" | "placement" | "targets">, ctx: z.RefinementCtx) {
  if (v.derive) {
    const props = v.valueSchema?.type === "object" ? Object.keys(v.valueSchema.properties ?? {}) : null;
    for (const k of Object.keys(v.derive)) {
      if (!props || !props.includes(k)) {
        ctx.addIssue({ code: "custom", path: ["derive", k], message: `derive key "${k}" must be a property of an object valueSchema` });
      }
    }
  }
  if (v.placement === "abc-primitive" && !v.targets.includes("field")) {
    ctx.addIssue({ code: "custom", path: ["targets"], message: 'placement "abc-primitive" requires targets to include "field"' });
  }
}

export const MetadataAttributeDefinitionSchema = ObjectShape.superRefine(refine);
export type MetadataAttributeDefinition = z.infer<typeof MetadataAttributeDefinitionSchema>;
export type MetadataAttributeTarget = (typeof METADATA_ATTRIBUTE_TARGETS)[number];

/** Row as persisted (definition plus identity). */
export type MetadataAttributeRecord = MetadataAttributeDefinition & {
  id: string;
  tenantId: string;
  protobufOptionNumber: number | null;
  createdAt: Date;
  updatedAt: Date;
};

import { z } from "zod";

export const FIELD_COMPLETENESS_RULE_IDS = [
  "description", "minLength", "maxLength", "minValue", "maxValue", "pattern", "precision", "scale",
] as const;
export const FieldRuleLevelSchema = z.enum(["off", "suggested", "required"]);
export const FieldCompletenessPolicySchema = z.record(
  z.string().min(1).max(128),
  z.partialRecord(z.enum(FIELD_COMPLETENESS_RULE_IDS), FieldRuleLevelSchema),
);

export type FieldRuleId = typeof FIELD_COMPLETENESS_RULE_IDS[number];
export type FieldRuleLevel = z.infer<typeof FieldRuleLevelSchema>;
/** Type IDs inherit from their scalar parents. "*" configures common checks for every type. */
export type FieldCompletenessPolicy = z.infer<typeof FieldCompletenessPolicySchema>;

export function readFieldCompletenessPolicy(value: unknown): FieldCompletenessPolicy | undefined {
  if (value == null) return undefined;
  const parsed = FieldCompletenessPolicySchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

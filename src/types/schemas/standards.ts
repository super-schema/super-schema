import { z } from "zod";

// --- Story 11.2: Schema Standard Reference Library ---

export const StandardFieldSchema = z.object({
  name: z.string().min(1),
  type: z.string().min(1),
  classification: z
    .enum(["PII", "SENSITIVE", "INTERNAL", "PUBLIC"])
    .optional(),
  description: z.string().optional(),
  qualityRules: z
    .array(
      z.object({
        rule: z.string(),
        params: z.record(z.string(), z.unknown()).optional(),
      })
    )
    .optional(),
});

export type StandardField = z.infer<typeof StandardFieldSchema>;

export const StandardTemplateSchema = z.object({
  standardName: z.string().min(1),
  entityName: z.string().min(1),
  description: z.string(),
  fields: z.array(StandardFieldSchema),
  source: z.enum(["schema.org", "financial", "healthcare-fhir"]),
  version: z.string(),
});

export type StandardTemplate = z.infer<typeof StandardTemplateSchema>;

export type StandardSource = "schema.org" | "financial" | "healthcare-fhir";

export const GetStandardsInputSchema = z.object({
  source: z.enum(["schema.org", "financial", "healthcare-fhir"]).optional(),
  query: z.string().optional(),
});

export type GetStandardsInput = z.infer<typeof GetStandardsInputSchema>;

export const GetStandardInputSchema = z.object({
  standardName: z.string(),
  entityName: z.string(),
});

export type GetStandardInput = z.infer<typeof GetStandardInputSchema>;

export const ReviewAgainstStandardInputSchema = z.object({
  entityFields: z.array(
    z.object({
      name: z.string(),
      type: z.string(),
    })
  ),
  standardName: z.string(),
  entityName: z.string(),
});

export type ReviewAgainstStandardInput = z.infer<
  typeof ReviewAgainstStandardInputSchema
>;

export const SuggestFieldsFromStandardInputSchema = z.object({
  entityName: z.string(),
  existingFieldNames: z.array(z.string()),
});

export type SuggestFieldsFromStandardInput = z.infer<
  typeof SuggestFieldsFromStandardInputSchema
>;

export const FieldComparisonSchema = z.object({
  name: z.string(),
  type: z.string(),
  standardType: z.string(),
});

export type FieldComparison = z.infer<typeof FieldComparisonSchema>;

export const StandardReviewSchema = z.object({
  matching: z.array(FieldComparisonSchema),
  missing: z.array(StandardFieldSchema),
  extra: z.array(
    z.object({
      name: z.string(),
      type: z.string(),
    })
  ),
  matchPercentage: z.number().min(0).max(100),
});

export type StandardReview = z.infer<typeof StandardReviewSchema>;

import { z } from "zod";

export const PolicyTemplateSchema = z
  .object({
    defaultClassification: z
      .enum(["PII", "SENSITIVE", "INTERNAL", "PUBLIC"])
      .optional(),
    defaultRetention: z.string().optional(),
    defaultQualityRules: z
      .array(
        z.object({
          type: z.string(),
          params: z.record(z.string(), z.unknown()),
        })
      )
      .optional(),
    namingConventions: z.string().optional(),
  })
  .partial();

export type PolicyTemplate = z.infer<typeof PolicyTemplateSchema>;

export const CreateDomainInputSchema = z.object({
  name: z
    .string()
    .min(1, "Domain name is required")
    .max(64, "Domain name must be 64 characters or less"),
  description: z.string().default(""),
  policyTemplate: PolicyTemplateSchema.optional(),
});

export type CreateDomainInput = z.infer<typeof CreateDomainInputSchema>;

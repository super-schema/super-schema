import { z } from "zod";

// --- Story 11.1: Natural Language Entity Creation ---

export const FieldSuggestionSchema = z.object({
  name: z.string().min(1),
  type: z.string().min(1),
  classification: z
    .enum(["PII", "SENSITIVE", "INTERNAL", "PUBLIC"])
    .optional(),
  description: z.string().optional(),
  confidence: z.number().min(0).max(1),
});

export type FieldSuggestion = z.infer<typeof FieldSuggestionSchema>;

export const EntitySuggestionSchema = z.object({
  entityName: z.string().min(1),
  description: z.string().optional(),
  fields: z.array(FieldSuggestionSchema),
});

export type EntitySuggestion = z.infer<typeof EntitySuggestionSchema>;

export const GenerateEntityInputSchema = z.object({
  description: z.string().min(10).max(2000),
  domainId: z.string().min(1),
});

export type GenerateEntityInput = z.infer<typeof GenerateEntityInputSchema>;

export const AiStatusResponseSchema = z.object({
  configured: z.boolean(),
  provider: z.string().optional(),
});

export type AiStatusResponse = z.infer<typeof AiStatusResponseSchema>;

// --- Story 11.3: AI-Assisted Field Suggestions ---

export const RankedFieldSuggestionSchema = FieldSuggestionSchema.extend({
  source: z.enum(["standard", "ai", "pattern"]),
  rank: z.number(),
});

export type RankedFieldSuggestion = z.infer<typeof RankedFieldSuggestionSchema>;

export const SuggestFieldsInputSchema = z.object({
  entityName: z.string().min(1),
  domainId: z.string().min(1),
  description: z.string().optional(),
});

export type SuggestFieldsInput = z.infer<typeof SuggestFieldsInputSchema>;

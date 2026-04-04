import { z } from "zod";

// --- Story 11.4: AI-Enhanced Schema Import with Confidence Scoring ---

export const EnhancedFieldMappingSchema = z.object({
  name: z.string().min(1),
  deterministicType: z.string(),
  aiSuggestedType: z.string().optional(),
  finalType: z.string(),
  confidence: z.number().min(0).max(1),
  classification: z
    .enum(["PII", "SENSITIVE", "INTERNAL", "PUBLIC"])
    .optional(),
  aiReasoning: z.string().optional(),
  source: z.enum(["deterministic", "ai-enhanced"]),
});

export type EnhancedFieldMapping = z.infer<typeof EnhancedFieldMappingSchema>;

export const EnhancedImportResultSchema = z.object({
  fields: z.array(EnhancedFieldMappingSchema),
  overallQualityScore: z.number().min(0).max(1),
});

export type EnhancedImportResult = z.infer<typeof EnhancedImportResultSchema>;

export const ParsedFieldSchema = z.object({
  name: z.string().min(1),
  type: z.string(),
  confidence: z.number().min(0).max(1).optional(),
});

export type ParsedField = z.infer<typeof ParsedFieldSchema>;

export const EnhanceImportInputSchema = z.object({
  parsedFields: z.array(ParsedFieldSchema),
  sourceContent: z.string(),
  domainId: z.string().min(1),
});

export type EnhanceImportInput = z.infer<typeof EnhanceImportInputSchema>;

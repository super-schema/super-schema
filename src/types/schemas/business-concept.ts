import { z } from "zod";

export const CreateBusinessConceptSchema = z.object({
  name: z
    .string()
    .min(1, "Concept name is required")
    .max(200, "Concept name must be 200 characters or less"),
  domain: z.string().default("Core"),
  definition: z.string().default(""),
  synonyms: z.array(z.string()).default([]),
  canonicalType: z.string().optional(),
  classification: z.string().optional(),
  tags: z.array(z.string()).default([]),
});

export type CreateBusinessConceptInput = z.infer<typeof CreateBusinessConceptSchema>;

export const UpdateBusinessConceptSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  domain: z.string().optional(),
  definition: z.string().optional(),
  synonyms: z.array(z.string()).optional(),
  canonicalType: z.string().nullable().optional(),
  classification: z.string().nullable().optional(),
  tags: z.array(z.string()).optional(),
});

export type UpdateBusinessConceptInput = z.infer<typeof UpdateBusinessConceptSchema>;

export const BusinessConceptFilterSchema = z.object({
  domain: z.string().optional(),
  tag: z.string().optional(),
  search: z.string().optional(),
});

export type BusinessConceptFilter = z.infer<typeof BusinessConceptFilterSchema>;

export const LinkFieldConceptSchema = z.object({
  fieldId: z.string().min(1, "Field ID is required"),
  conceptId: z.string().min(1, "Concept ID is required"),
  confidence: z.number().min(0).max(1).default(1.0),
});

export type LinkFieldConceptInput = z.infer<typeof LinkFieldConceptSchema>;

import { z } from "zod";

export const StructureSchema = z
  .object({
    nullable: z.boolean(),
    key: z.boolean(),
  })
  .partial();

export const SemanticsSchema = z
  .object({
    description: z.string(),
    aliases: z.array(z.string()),
    glossaryTerms: z.array(z.string()),
  })
  .partial();

export const ClassificationSchema = z
  .object({
    level: z.enum(["PII", "SENSITIVE", "INTERNAL", "PUBLIC"]),
    customLevel: z.string().nullable(),
  })
  .partial();

export const PolicySchema = z
  .object({
    retention: z.string(),
    anonymization: z.string(),
    encryption: z.string(),
  })
  .partial();

export const QualityRuleSchema = z.object({
  type: z.string(),
  params: z.record(z.string(), z.unknown()),
});

export const QualitySchema = z
  .object({
    rules: z.array(QualityRuleSchema),
  })
  .partial();

export const LineageSchema = z
  .object({
    source: z.string(),
    upstream: z.array(z.string()),
    downstream: z.array(z.string()),
  })
  .partial();

export const OperationalHintsSchema = z
  .object({
    partition: z.boolean(),
    index: z.boolean(),
    cluster: z.boolean(),
  })
  .partial();

export const EvolutionSchema = z
  .object({
    deprecated: z.boolean(),
    since: z.string(),
    replacement: z.string().nullable(),
  })
  .partial();

export const DecoratorSchema = z
  .object({
    structure: StructureSchema,
    semantics: SemanticsSchema,
    classification: ClassificationSchema,
    policy: PolicySchema,
    quality: QualitySchema,
    lineage: LineageSchema,
    operationalHints: OperationalHintsSchema,
    evolution: EvolutionSchema,
  })
  .partial();

export type Decorators = z.infer<typeof DecoratorSchema>;

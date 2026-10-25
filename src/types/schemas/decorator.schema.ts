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

/**
 * Schema for complex type metadata stored at the root level of field decorators JSONB.
 * These keys sit alongside structure, semantics, policy, etc. -- NOT under typespec.
 */
export const NestedFieldSchema: z.ZodType<NestedField> = z.lazy(() =>
  z.object({
    name: z.string(),
    type: z.string(),
    description: z.string().optional(),
    nullable: z.boolean().optional(),
    decorators: z.record(z.string(), z.unknown()).optional(),
  })
);

export interface NestedField {
  name: string;
  type: string;
  description?: string;
  nullable?: boolean;
  decorators?: Record<string, unknown>;
}

export const ComplexTypeMetadataSchema = z
  .object({
    // Array type
    arrayElementType: z.string(),
    arrayElementPrecision: z.number().int(),
    arrayElementScale: z.number().int(),
    // Map type
    mapKeyType: z.string(),
    mapValueType: z.string(),
    // Object/nested type
    nestedFields: z.array(NestedFieldSchema),
    // Reference type
    referencedEntityId: z.string(),
    referencedEntityName: z.string(),
    referencedQualifiedName: z.string(),
    referencedDomain: z.string(),
    referencedProduct: z.string(),
    referencedEntity: z.string(),
    referencedEntityVersion: z.string(),
  })
  .partial();

export type ComplexTypeMetadata = z.infer<typeof ComplexTypeMetadataSchema>;

import { z } from "zod";
import { RetentionPolicySchema } from "./retention-policy.schema";

export const RelationshipCardinality = z.enum([
  "one-to-one",
  "one-to-many",
  "many-to-one",
  "many-to-many",
]);

export type RelationshipCardinality = z.infer<typeof RelationshipCardinality>;

export const RelationshipSchema = z.object({
  targetEntityId: z.string(),
  fieldId: z.string(),
  cardinality: RelationshipCardinality,
  foreignKey: z.string().optional(),
});

export type Relationship = z.infer<typeof RelationshipSchema>;

export const ImportedFromSchema = z.object({
  format: z.string(),
  originalContent: z.string(),
  importedAt: z.string().or(z.date()),
});

export type ImportedFrom = z.infer<typeof ImportedFromSchema>;

export const EntityMetadataSchema = z
  .object({
    tags: z.array(z.string()),
    relationships: z.array(RelationshipSchema),
    deprecation: z
      .object({
        deprecated: z.boolean(),
        since: z.string().optional(),
        replacement: z.string().nullable().optional(),
        replacementEntityId: z.string().nullable().optional(),
        reason: z.string().optional(),
        migrationNotes: z.string().optional(),
      })
      .optional(),
    custom: z.record(z.string(), z.unknown()).optional(),
    importedFrom: ImportedFromSchema.optional(),
    /**
     * The format the entity was imported in ("avro", "protobuf", "json-schema", "typespec", ...). Server-recorded by the import;
     * an event message's "Auto" representation follows it (see `entitySourceFormat`). Declared here so a parse that strips unknown
     * keys does not drop it.
     */
    sourceFormat: z.string().optional(),
    retentionPolicy: RetentionPolicySchema.optional(),
  })
  .partial();

export type EntityMetadata = z.infer<typeof EntityMetadataSchema>;

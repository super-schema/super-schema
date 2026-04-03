import { z } from "zod";

export const EntityMetadataSchema = z
  .object({
    tags: z.array(z.string()),
    relationships: z.array(
      z.object({
        targetEntityId: z.string(),
        type: z.enum(["one-to-one", "one-to-many", "many-to-many"]),
        foreignKey: z.string().optional(),
      })
    ),
    deprecation: z
      .object({
        deprecated: z.boolean(),
        since: z.string().optional(),
        replacement: z.string().nullable().optional(),
        reason: z.string().optional(),
      })
      .optional(),
    custom: z.record(z.string(), z.unknown()).optional(),
  })
  .partial();

export type EntityMetadata = z.infer<typeof EntityMetadataSchema>;

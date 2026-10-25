import { z } from "zod";
import { EntityMetadataSchema } from "./entity-metadata.schema";

const EntityStatusEnum = z.enum(["DRAFT", "ACTIVE", "DEPRECATED", "RETIRED"]);

export const CreateEntityInputSchema = z.object({
  name: z
    .string()
    .min(1, "Entity name is required")
    .max(128, "Entity name must be 128 characters or less"),
  domainId: z.string().min(1, "Domain ID is required"),
  description: z.string().default(""),
  metadata: EntityMetadataSchema.optional(),
});

export type CreateEntityInput = z.infer<typeof CreateEntityInputSchema>;

export const UpdateEntityInputSchema = z.object({
  name: z.string().min(1).max(128).optional(),
  description: z.string().optional(),
  status: EntityStatusEnum.optional(),
  metadata: EntityMetadataSchema.optional(),
});

export type UpdateEntityInput = z.infer<typeof UpdateEntityInputSchema>;

/** A string that PostgreSQL can hold: no NUL byte (a query with one makes the driver throw). */
const NoNul = z.string().refine((value) => !value.includes("\u0000"), "A filter must not hold a NUL byte (\\u0000)");

export const EntityFiltersSchema = z.object({
  domainId: NoNul.optional(),
  status: EntityStatusEnum.optional(),
  search: NoNul.optional(),
});

export type EntityFilters = z.infer<typeof EntityFiltersSchema>;

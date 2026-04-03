import { z } from "zod";
import { DecoratorSchema } from "./decorator.schema";

export const CreateFieldInputSchema = z.object({
  name: z
    .string()
    .min(1, "Field name is required")
    .max(128, "Field name must be 128 characters or less"),
  type: z.string().min(1, "Field type is required"),
  precision: z.number().int().optional(),
  scale: z.number().int().optional(),
  nullable: z.boolean().default(true),
  isKey: z.boolean().default(false),
  fieldNumber: z.number().int().optional(),
  description: z.string().default(""),
  aliases: z.array(z.string()).default([]),
  classification: z.string().optional(),
  decorators: DecoratorSchema.optional(),
});

export type CreateFieldInput = z.infer<typeof CreateFieldInputSchema>;

export const UpdateFieldInputSchema = CreateFieldInputSchema.partial();

export type UpdateFieldInput = z.infer<typeof UpdateFieldInputSchema>;

export const ReorderFieldsInputSchema = z.object({
  entityId: z.string().min(1),
  fieldIds: z.array(z.string()).min(1, "At least one field ID is required"),
});

export type ReorderFieldsInput = z.infer<typeof ReorderFieldsInputSchema>;

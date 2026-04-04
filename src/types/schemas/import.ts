/**
 * Zod schemas for the schema import pipeline.
 */

import { z } from "zod";

export const ImportFormatSchema = z.enum(["avro", "bigquery-ddl", "protobuf"]);

export const ImportConfidenceSchema = z.enum(["high", "medium", "low"]);

export const ParsedFieldSchema = z.object({
  name: z.string().min(1),
  type: z.string().min(1),
  nullable: z.boolean(),
  description: z.string().optional(),
  fieldNumber: z.number().int().optional(),
  confidence: ImportConfidenceSchema,
  originalType: z.string(),
});

export const ParsedEntitySchema = z.object({
  name: z.string().min(1),
  fields: z.array(ParsedFieldSchema),
  sourceFormat: ImportFormatSchema,
  originalContent: z.string(),
});

export const ImportSchemaInput = z.object({
  content: z.string().min(1, "Schema content is required"),
  format: ImportFormatSchema.optional(),
});

export const ConfirmImportInput = z.object({
  parsedEntity: ParsedEntitySchema,
  domainId: z.string().min(1, "Domain ID is required"),
});

export const BulkImportInput = z.object({
  files: z.array(
    z.object({
      content: z.string(),
      filename: z.string(),
    })
  ),
});

export const ConfirmBulkImportInput = z.object({
  parsedEntities: z.array(ParsedEntitySchema),
  domainId: z.string().min(1, "Domain ID is required"),
});

export type ImportSchemaInputType = z.infer<typeof ImportSchemaInput>;
export type ConfirmImportInputType = z.infer<typeof ConfirmImportInput>;
export type BulkImportInputType = z.infer<typeof BulkImportInput>;
export type ConfirmBulkImportInputType = z.infer<typeof ConfirmBulkImportInput>;

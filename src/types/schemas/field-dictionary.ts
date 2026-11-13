import { z } from "zod";

/** A tenant field dictionary entry as the service input: the canonical name, its aliases and the defaults a field created from it gets. */
export const FieldDictionaryEntrySchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(128),
  aliases: z.array(z.string().trim().min(1).max(128)).default([]),
  type: z.string().trim().min(1, "Type is required"),
  description: z.string().default(""),
  classification: z.string().trim().min(1).nullish(),
  /** Default metadata attribute values, x-key to value. */
  attributes: z.record(z.string(), z.unknown()).default({}),
  conceptId: z.string().min(1).nullish(),
});

export type FieldDictionaryInput = z.input<typeof FieldDictionaryEntrySchema>;
export type FieldDictionaryEntryData = z.infer<typeof FieldDictionaryEntrySchema>;

/** A stored dictionary entry. */
export interface DictionaryEntry {
  id: string;
  tenantId: string;
  name: string;
  aliases: string[];
  type: string;
  description: string;
  classification: string | null;
  attributes: Record<string, unknown>;
  conceptId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

import { readFieldAttributes } from "@/lib/metadata-attributes/values";
import type { FieldDictionaryInput } from "@/types/schemas/field-dictionary";
import type { MetadataAttributeDefinition } from "@/types/schemas/metadata-attribute";

export interface DictionarySourceField {
  name: string;
  type: string;
  description?: string | null;
  classification?: string | null;
  decorators: unknown;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/**
 * The dictionary entry a field would save as: its name, type, description, classification and the attribute values whose definition is
 * scope `schema`, with derived members removed (they re-derive on use). Values of keys without a definition, and undefined values, are left out.
 */
export function dictionaryEntryFromField(field: DictionarySourceField, defs: readonly MetadataAttributeDefinition[]): FieldDictionaryInput {
  const byKey = new Map(defs.map((d) => [d.key, d]));
  const attributes: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(readFieldAttributes(field.decorators))) {
    const def = byKey.get(key);
    if (!def || def.scope !== "schema" || value === undefined) continue;
    const derived = Object.keys(def.derive ?? {});
    if (derived.length > 0 && isObj(value)) {
      const rest = Object.fromEntries(Object.entries(value).filter(([m, v]) => !derived.includes(m) && v !== undefined));
      if (Object.keys(rest).length > 0) attributes[key] = rest;
      continue;
    }
    attributes[key] = value;
  }
  return {
    name: field.name,
    type: field.type,
    description: field.description ?? "",
    classification: field.classification ?? null,
    attributes,
  };
}

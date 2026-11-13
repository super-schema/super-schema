/**
 * Derived attribute members: a definition's `derive` maps object members to templates over `{class}`, `{level}`, `{name}`, `{type}`.
 * `recomputeFieldAttributes` re-resolves them whenever a field is saved, keeping the user-entered members.
 */

import { classNumberOf } from "@/lib/classification-scale";
import { abcPlacement, isPrimitiveField, type PlacementField } from "@/lib/metadata-attributes/placement";
import { readFieldAttributes, writeFieldAttribute } from "@/lib/metadata-attributes/values";
import type { MetadataAttributeDefinition } from "@/types/schemas/metadata-attribute";

export interface DerivableField extends PlacementField {
  name: string;
  classification?: string | null;
  decorators: unknown;
}

function resolveTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(class|level|name|type)\}/g, (_, k: string) => vars[k]);
}

/** The decorators after applying every definition's derived members (the same reference when nothing changes). */
export function recomputeFieldAttributes(
  field: DerivableField,
  defs: MetadataAttributeDefinition[],
  customClasses: ReadonlyMap<string, number>,
): Record<string, unknown> {
  const original = (field.decorators && typeof field.decorators === "object" ? field.decorators : {}) as Record<string, unknown>;
  if (defs.length === 0) return original;

  const vars = {
    class: String(classNumberOf(field.classification, customClasses)),
    level: field.classification || "SENSITIVE",
    name: field.name,
    type: field.type,
  };
  const placement = abcPlacement(field);
  const primitive = isPrimitiveField(field);

  let current = original;
  let changed = false;
  for (const def of defs) {
    const existing = readFieldAttributes(current);
    const has = Object.prototype.hasOwnProperty.call(existing, def.key);

    if (def.placement === "abc-primitive" && placement === "none") {
      if (has) {
        current = writeFieldAttribute(current, def.key, undefined);
        changed = true;
      }
      continue;
    }
    if (!def.derive) continue;

    const objectSchema = def.valueSchema?.type === "object";
    const required = def.requiredWhen === "always" || (def.requiredWhen === "primitive" && primitive);
    if (!has && !(required && objectSchema)) continue;

    const stored = existing[def.key];
    const base = stored && typeof stored === "object" && !Array.isArray(stored) ? (stored as Record<string, unknown>) : {};
    const derived = Object.fromEntries(Object.entries(def.derive).map(([member, tpl]) => [member, resolveTemplate(tpl, vars)]));
    const merged = { ...base, ...derived };
    if (has && JSON.stringify(merged) === JSON.stringify(stored)) continue;
    current = writeFieldAttribute(current, def.key, merged);
    changed = true;
  }
  return changed ? current : original;
}

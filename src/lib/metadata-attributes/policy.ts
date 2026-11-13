/**
 * Domain-policy overrides for metadata attributes: a domain may tighten a definition's `requiredWhen` and supply a default value.
 * Pure; reads the policy leniently (a malformed entry is ignored, never thrown on).
 */

import type { PolicyTemplate } from "@/types/schemas/domain-policy";
import type { MetadataAttributeDefinition } from "@/types/schemas/metadata-attribute";
import { abcPlacement, attributeApplies, type PlacementField } from "./placement";
import { readFieldAttributes, writeFieldAttribute } from "./values";
import { validateValue } from "./value-schema";

const REQUIRED_WHEN = new Set(["never", "always", "primitive"]);

type Override = { requiredWhen?: "never" | "always" | "primitive"; default?: unknown };

function overrides(policy: PolicyTemplate | null | undefined): Record<string, Override> {
  const raw = (policy as { metadataAttributes?: unknown } | null | undefined)?.metadataAttributes;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  return raw as Record<string, Override>;
}

function validDefault(def: MetadataAttributeDefinition, value: unknown): boolean {
  if (value === undefined) return false;
  if (!def.valueSchema) return true;
  const problems = validateValue(value, def.valueSchema);
  if (problems.length === 0) return true;
  console.warn(`Domain policy default for ${def.key} ignored: ${problems.map((p) => `${p.path || "value"} ${p.message}`).join("; ")}`);
  return false;
}

/** The definitions with the domain's `requiredWhen` overrides applied; overrides for unknown keys are ignored. */
export function resolveDefinitionsForDomain(
  defs: MetadataAttributeDefinition[],
  policy: PolicyTemplate | null | undefined,
): MetadataAttributeDefinition[] {
  const map = overrides(policy);
  return defs.map((d) => {
    const o = Object.prototype.hasOwnProperty.call(map, d.key) ? map[d.key] : undefined;
    if (!o || typeof o !== "object" || !o.requiredWhen || !REQUIRED_WHEN.has(o.requiredWhen) || o.requiredWhen === d.requiredWhen) return d;
    return { ...d, requiredWhen: o.requiredWhen };
  });
}

/**
 * The field decorators with the domain's valid defaults filled in for attributes that have no stored value; present values are never
 * overwritten. Given the field's shape, a default is not filled where the attribute does not apply (`attributeApplies` for a
 * `requiredWhen: "primitive"` one; no place at all for an `abc-primitive` one).
 */
export function applyPolicyDefaults(
  decorators: Record<string, unknown> | undefined,
  resolvedDefs: MetadataAttributeDefinition[],
  policy: PolicyTemplate | null | undefined,
  field?: PlacementField,
): Record<string, unknown> {
  const map = overrides(policy);
  let current: Record<string, unknown> = decorators ?? {};
  for (const d of resolvedDefs) {
    if (!d.targets.includes("field") || !Object.prototype.hasOwnProperty.call(map, d.key)) continue;
    if (field && d.requiredWhen === "primitive" && !attributeApplies(field)) continue;
    if (field && d.placement === "abc-primitive" && abcPlacement(field) === "none") continue;
    const value = map[d.key]?.default;
    if (!validDefault(d, value)) continue;
    if (Object.prototype.hasOwnProperty.call(readFieldAttributes(current), d.key)) continue;
    current = writeFieldAttribute(current, d.key, value) as Record<string, unknown>;
  }
  return current;
}

import { getTypeInfo } from "@/lib/data-types";
import type { FieldCompletenessPolicy, FieldRuleId, FieldRuleLevel } from "@/types/schemas/field-completeness-policy";

export type ValidationStatus = "complete" | "suggestion" | "error";
export interface FieldCompleteness {
  status: ValidationStatus;
  missing: string[];
  suggestions: string[];
}

export interface FieldInput {
  name: string;
  type: string;
  classification: string | null;
  precision: number | null;
  scale: number | null;
  description?: string;
  decorators?: Record<string, unknown>;
}

interface FieldRule {
  id: FieldRuleId;
  label: string;
  families: readonly string[] | "all";
  satisfied: (field: FieldInput) => boolean;
}

function validation(field: FieldInput): Record<string, unknown> {
  const typespec = field.decorators?.typespec;
  if (!typespec || typeof typespec !== "object" || Array.isArray(typespec)) return {};
  const constraints = (typespec as Record<string, unknown>).validation;
  return constraints && typeof constraints === "object" && !Array.isArray(constraints) ? constraints as Record<string, unknown> : {};
}

function hasDescription(field: FieldInput): boolean {
  if (field.description?.trim()) return true;
  const typespec = field.decorators?.typespec as { documentation?: { summary?: unknown } } | undefined;
  const summary = typespec?.documentation?.summary;
  return typeof summary === "string" && Boolean(summary.trim());
}

const nonnegativeInteger = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0;
const finiteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/** Add new checks here and their stable ID to FieldCompletenessPolicySchema. */
export const FIELD_COMPLETENESS_RULES: readonly FieldRule[] = [
  { id: "description", label: "Field description", families: "all", satisfied: hasDescription },
  { id: "minLength", label: "Minimum length", families: ["string"], satisfied: (field) => nonnegativeInteger(validation(field).minLength) },
  { id: "maxLength", label: "Maximum length", families: ["string"], satisfied: (field) => nonnegativeInteger(validation(field).maxLength) },
  { id: "minValue", label: "Minimum value", families: ["numeric"], satisfied: (field) => finiteNumber(validation(field).minValue) || finiteNumber(validation(field).minValueExclusive) },
  { id: "maxValue", label: "Maximum value", families: ["numeric"], satisfied: (field) => finiteNumber(validation(field).maxValue) || finiteNumber(validation(field).maxValueExclusive) },
  { id: "pattern", label: "Validation pattern", families: ["string"], satisfied: (field) => typeof validation(field).pattern === "string" && Boolean((validation(field).pattern as string).trim()) },
  { id: "precision", label: "Precision", families: ["decimal"], satisfied: (field) => nonnegativeInteger(field.precision) && field.precision > 0 },
  { id: "scale", label: "Scale", families: ["decimal"], satisfied: (field) => nonnegativeInteger(field.scale) && (field.precision == null || field.scale <= field.precision) },
];

export const DEFAULT_FIELD_COMPLETENESS_POLICY: FieldCompletenessPolicy = {
  string: { minLength: "suggested", maxLength: "suggested" },
  decimal: { precision: "required", scale: "required" },
};

function typeChain(type: string): string[] {
  const chain: string[] = [];
  const seen = new Set<string>();
  let current: string | undefined = type;
  while (current && !seen.has(current)) {
    chain.unshift(current);
    seen.add(current);
    current = getTypeInfo(current)?.parent;
  }
  return chain;
}

export function applicableFieldRules(type: string) {
  const chain = typeChain(type);
  return FIELD_COMPLETENESS_RULES.filter((rule) => rule.families === "all" || rule.families.some((family) => chain.includes(family)));
}

/** Built-in defaults, common overrides, then parent-to-child type overrides. Explicit "off" wins. */
export function resolveFieldCompletenessRules(type: string, policy?: FieldCompletenessPolicy): Partial<Record<FieldRuleId, FieldRuleLevel>> {
  const chain = typeChain(type);
  const rules: Partial<Record<FieldRuleId, FieldRuleLevel>> = {};
  for (const parent of chain) Object.assign(rules, DEFAULT_FIELD_COMPLETENESS_POLICY[parent]);
  Object.assign(rules, policy?.["*"]);
  for (const parent of chain) Object.assign(rules, policy?.[parent]);
  return rules;
}

export function fieldCompletenessLabel(id: string): string {
  if (id === "name") return "Field name";
  if (id === "type") return "Data type";
  return FIELD_COMPLETENESS_RULES.find((rule) => rule.id === id)?.label ?? id;
}

export function getFieldCompleteness(field: FieldInput, policy?: FieldCompletenessPolicy): FieldCompleteness {
  const missing: string[] = [];
  const suggestions: string[] = [];
  // Identity is structural, independent of optional authoring policies. Default Class 3 is valid.
  if (!field.name?.trim()) missing.push("name");
  if (!field.type?.trim()) missing.push("type");
  const levels = resolveFieldCompletenessRules(field.type, policy);
  for (const rule of applicableFieldRules(field.type)) {
    const level = levels[rule.id] ?? "off";
    if (level === "off" || rule.satisfied(field)) continue;
    (level === "required" ? missing : suggestions).push(rule.id);
  }
  return { status: missing.length ? "error" : suggestions.length ? "suggestion" : "complete", missing, suggestions };
}

export function getEntityCompleteness(fields: FieldInput[], policy?: FieldCompletenessPolicy) {
  const complete = fields.filter((field) => getFieldCompleteness(field, policy).status === "complete").length;
  return { complete, total: fields.length, percentage: fields.length ? Math.round(complete / fields.length * 100) : 0 };
}

export function canEmit(fields: FieldInput[], policy?: FieldCompletenessPolicy): { allowed: boolean; incompleteCount: number } {
  const incompleteCount = fields.filter((field) => getFieldCompleteness(field, policy).status === "error").length;
  return { allowed: fields.length > 0 && incompleteCount === 0, incompleteCount };
}

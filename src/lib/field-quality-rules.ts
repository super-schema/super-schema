/**
 * Data quality rules attached to a field (`governance.qualityRules`). Pure helpers shared by the editor and its tests.
 *
 * Parameter keys are the contract for every consumer: `severity` (error | warning), `min` / `max` (range), `threshold`
 * (not-null, percent 0–100), `pattern` (regex), `values` (enum), `name` / `expression` (custom). Keys the editor does not
 * know are preserved untouched.
 */

export const QUALITY_SEVERITIES = ["error", "warning"] as const;
export type QualitySeverity = (typeof QUALITY_SEVERITIES)[number];

export interface QualityRule {
  type: string;
  params: Record<string, unknown>;
}

export const QUALITY_RULE_TYPES = [
  {
    id: "unique",
    label: "Unique",
    description: "Checks that no two rows share a value.",
    singleton: true,
  },
  {
    id: "not-null",
    label: "Not null",
    description:
      "Checks that values are present. Optionally accept a minimum share of non-null rows.",
    singleton: true,
  },
  {
    id: "range",
    label: "Range",
    description: "Checks that numeric values fall between a minimum and a maximum.",
    singleton: false,
  },
  {
    id: "regex",
    label: "Regex",
    description: "Checks that text values match a regular expression.",
    singleton: false,
  },
  {
    id: "enum",
    label: "Enum",
    description: "Checks that values are one of an allowed list.",
    singleton: false,
  },
  {
    id: "custom",
    label: "Custom",
    description:
      "A named assertion written as an SQL or expression for an external quality tool.",
    singleton: false,
  },
] as const;

const KNOWN_TYPES = new Set<string>(QUALITY_RULE_TYPES.map((t) => t.id));

export function isKnownQualityRuleType(type: string): boolean {
  return KNOWN_TYPES.has(type);
}

export function qualityRuleLabel(type: string): string {
  return QUALITY_RULE_TYPES.find((t) => t.id === type)?.label ?? type;
}

/** The default parameters a newly added rule of this type starts with (severity is always stored explicitly). */
export function newQualityRule(type: string): QualityRule {
  const defaults: Record<string, unknown> =
    type === "enum" ? { values: [] } : {};
  return { type, params: { severity: "error", ...defaults } };
}

export function qualityRuleSeverity(params: Record<string, unknown>): QualitySeverity {
  return params.severity === "warning" ? "warning" : "error";
}

/**
 * Returns a copy of `params` with `key` set to `value`. An empty value (undefined, null or "") removes the key, so an
 * unset bound is not stored as null. Every other key is kept as it was.
 */
export function withQualityParam(
  params: Record<string, unknown>,
  key: string,
  value: unknown,
): Record<string, unknown> {
  const next = { ...params };
  if (value === undefined || value === null || value === "") delete next[key];
  else next[key] = value;
  return next;
}

function numberParam(params: Record<string, unknown>, key: string) {
  const value = params[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringParam(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  return typeof value === "string" ? value : "";
}

function enumParam(params: Record<string, unknown>): string[] {
  const value = params.values;
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string")
    : [];
}

function patternError(pattern: string): string | undefined {
  if (!pattern) return undefined;
  try {
    new RegExp(pattern);
    return undefined;
  } catch {
    return "Enter a valid regular expression.";
  }
}

/** A one-line human description of what the rule checks. */
export function qualityRuleSummary(rule: QualityRule): string {
  const p = rule.params;
  switch (rule.type) {
    case "unique":
      return "Values must be unique";
    case "not-null": {
      const threshold = numberParam(p, "threshold");
      return threshold === undefined
        ? "Every row must be non-null"
        : `At least ${threshold}% of rows non-null`;
    }
    case "range": {
      const min = numberParam(p, "min");
      const max = numberParam(p, "max");
      if (min !== undefined && max !== undefined)
        return `Between ${min} and ${max}`;
      if (min !== undefined) return `At least ${min}`;
      if (max !== undefined) return `At most ${max}`;
      return "No bounds set";
    }
    case "regex": {
      const pattern = stringParam(p, "pattern");
      if (!pattern) return "No pattern set";
      const shown = pattern.length > 40 ? `${pattern.slice(0, 39)}…` : pattern;
      return `Matches ${shown}`;
    }
    case "enum": {
      const count = enumParam(p).length;
      if (count === 0) return "No values yet";
      return `One of ${count} ${count === 1 ? "value" : "values"}`;
    }
    case "custom":
      return stringParam(p, "name") || (stringParam(p, "expression") ? "Custom expression" : "No expression set");
    default:
      return `Parameters for “${rule.type}”`;
  }
}

export type QualityRuleField = "min" | "max" | "threshold" | "pattern" | "values" | "expression";

export interface QualityRuleError {
  field: QualityRuleField;
  message: string;
}

/** Inline validation for one rule. Unknown rule types have no structural checks; their raw parameters are still stored. */
export function qualityRuleErrors(rule: QualityRule): QualityRuleError[] {
  const p = rule.params;
  const errors: QualityRuleError[] = [];
  switch (rule.type) {
    case "range": {
      const min = numberParam(p, "min");
      const max = numberParam(p, "max");
      if (p.min !== undefined && min === undefined)
        errors.push({ field: "min", message: "Minimum must be a number." });
      if (p.max !== undefined && max === undefined)
        errors.push({ field: "max", message: "Maximum must be a number." });
      if (p.min === undefined && p.max === undefined)
        errors.push({ field: "min", message: "Enter a minimum, a maximum, or both." });
      if (min !== undefined && max !== undefined && min > max)
        errors.push({ field: "max", message: "Maximum must be at least the minimum." });
      break;
    }
    case "not-null": {
      if (p.threshold === undefined) break;
      const threshold = numberParam(p, "threshold");
      if (threshold === undefined || threshold < 0 || threshold > 100)
        errors.push({ field: "threshold", message: "Enter a percentage from 0 to 100." });
      break;
    }
    case "regex": {
      const pattern = stringParam(p, "pattern");
      if (!pattern) errors.push({ field: "pattern", message: "Enter a pattern." });
      else {
        const message = patternError(pattern);
        if (message) errors.push({ field: "pattern", message });
      }
      break;
    }
    case "enum":
      if (enumParam(p).length === 0)
        errors.push({ field: "values", message: "Add at least one value." });
      break;
    case "custom":
      if (!stringParam(p, "expression").trim())
        errors.push({ field: "expression", message: "Enter an expression." });
      break;
  }
  return errors;
}

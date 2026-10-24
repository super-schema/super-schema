/**
 * Retention Policy Schema — structured, condition-based retention policies.
 *
 * Supports 4 industry-standard strategies:
 * - age-based: Delete/archive after a duration from a reference date field
 * - condition-based: Delete/archive when a SQL-like condition is true
 * - rolling-window: Keep only the last N days/months/years of data
 * - indefinite: Explicit keep-forever (legal hold, audit)
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const RetentionStrategyEnum = z.enum([
  "age-based",
  "condition-based",
  "rolling-window",
  "indefinite",
]);

export type RetentionStrategy = z.infer<typeof RetentionStrategyEnum>;

export const RetentionActionEnum = z.enum([
  "delete",
  "archive",
  "anonymize",
  "notify-only",
]);

export type RetentionAction = z.infer<typeof RetentionActionEnum>;

export const PeriodUnitEnum = z.enum(["days", "months", "years"]);

export type PeriodUnit = z.infer<typeof PeriodUnitEnum>;

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

/** A retention period counts whole days, months or years: 0.5 and 0 are not periods, and the editor says so in these words. */
export const RETENTION_PERIOD_MESSAGE = "The period must be a whole number of 1 or more.";

export const RetentionPolicySchema = z.object({
  strategy: RetentionStrategyEnum,

  // For age-based and rolling-window
  period: z.number().int(RETENTION_PERIOD_MESSAGE).min(1, RETENTION_PERIOD_MESSAGE).optional(),
  periodUnit: PeriodUnitEnum.optional(),
  referenceField: z.string().optional(),

  // For condition-based
  condition: z.string().optional(),

  // Action when retention triggers
  action: RetentionActionEnum,

  // Human-readable description
  description: z.string().optional(),
});

export type RetentionPolicy = z.infer<typeof RetentionPolicySchema>;

// ---------------------------------------------------------------------------
// Migration: old simple string → structured policy
// ---------------------------------------------------------------------------

export function migrateSimpleRetention(oldValue: string): RetentionPolicy {
  if (!oldValue || oldValue === "indefinite" || oldValue === "Indefinite") {
    return { strategy: "indefinite", action: "notify-only" };
  }

  // Parse compact format: "30d", "90d", "1y", "3y", "5y", "7y"
  const compactMatch = oldValue.match(/^(\d+)(d|y)$/);
  if (compactMatch) {
    const num = parseInt(compactMatch[1], 10);
    const unit = compactMatch[2] === "d" ? "days" : "years";
    return {
      strategy: "age-based",
      period: num,
      periodUnit: unit as PeriodUnit,
      referenceField: "created_at",
      action: "delete",
    };
  }

  // Parse verbose format: "30 days", "90 days", "1 year", "3 years", "7 years"
  const verboseMatch = oldValue.toLowerCase().match(/^(\d+)\s*(day|month|year|yr)s?$/);
  if (verboseMatch) {
    const num = parseInt(verboseMatch[1], 10);
    let unit: PeriodUnit = "days";
    if (verboseMatch[2].startsWith("year") || verboseMatch[2].startsWith("yr")) unit = "years";
    if (verboseMatch[2].startsWith("month")) unit = "months";
    return {
      strategy: "age-based",
      period: num,
      periodUnit: unit,
      referenceField: "created_at",
      action: "delete",
    };
  }

  // Fallback: keep the old value as description
  return {
    strategy: "indefinite",
    action: "notify-only",
    description: oldValue,
  };
}

// ---------------------------------------------------------------------------
// Summary formatter
// ---------------------------------------------------------------------------

const ACTION_LABELS: Record<RetentionAction, string> = {
  delete: "Delete",
  archive: "Archive",
  anonymize: "Anonymize",
  "notify-only": "Notify",
};

/** "1 day", "2 days": the unit is stored in the plural ("days"), and exactly one of it is singular. */
function periodText(period: number, unit: string): string {
  return `${period} ${period === 1 ? unit.replace(/s$/, "") : unit}`;
}

export function formatRetentionSummary(policy: RetentionPolicy): string {
  const action = ACTION_LABELS[policy.action] ?? policy.action;

  switch (policy.strategy) {
    case "age-based": {
      const period = policy.period ?? 0;
      const unit = policy.periodUnit ?? "days";
      const ref = policy.referenceField ? ` (${policy.referenceField})` : "";
      return `${action} after ${periodText(period, unit)}${ref}`;
    }
    case "condition-based": {
      const cond = policy.condition
        ? policy.condition.length > 40
          ? policy.condition.substring(0, 37) + "..."
          : policy.condition
        : "custom condition";
      return `${action} when ${cond}`;
    }
    case "rolling-window": {
      const period = policy.period ?? 0;
      const unit = policy.periodUnit ?? "days";
      const ref = policy.referenceField ? ` (${policy.referenceField})` : "";
      return `Keep ${periodText(period, unit)}${ref}`;
    }
    case "indefinite":
      return "Retain indefinitely";
    default:
      return "Unknown policy";
  }
}

// ---------------------------------------------------------------------------
// Extract retention years for compliance filtering
// ---------------------------------------------------------------------------

export function retentionPolicyToYears(policy: RetentionPolicy): number | null {
  if (policy.strategy === "indefinite") return null;
  if (!policy.period || !policy.periodUnit) return null;

  switch (policy.periodUnit) {
    case "years":
      return policy.period;
    case "months":
      return policy.period / 12;
    case "days":
      return policy.period / 365;
    default:
      return null;
  }
}

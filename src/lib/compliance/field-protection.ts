/**
 * What a field protects, as the product stores it. The compliance views (Query, Gaps, the exports) and the field card read these values here, so
 * that they agree with each other and with the editors that write them:
 * - anonymization: the Data Protection value the field's Governance panel writes (`decorators.typespec.governance`, the panel and the Quick Edit
 *   panel both write it). A field whose panel never gave that key keeps the `@anonymization` of its TypeSpec source, which the sync writes to
 *   `decorators.governance.anonymization`; then the legacy `decorators.policy`, read as a fallback for rows written before either.
 * - encryption: the same panel value; a row that never had the key keeps the legacy `decorators.policy`.
 * - retention: the ENTITY's `metadata.retentionPolicy` (the retention page). A field whose entity has none keeps the legacy
 *   `decorators.policy.retention`. A `@retentionPolicy` in the TypeSpec source is not read: retention is kept per entity, and nothing in the product
 *   reads a retention declared in a source.
 *
 * A key the panel wrote is the answer, even as null (the panel's None): the other sources answer only for a key the panel never wrote.
 *
 * A method is compared with the compliance enum values: case and punctuation do not matter (`AES-256` is `aes256`), and `none` is the same as no
 * value at all (the Gaps tab treats them alike). This module is pure: it is shared by the server services and by client components.
 */
import {
  RetentionPolicySchema,
  formatRetentionSummary,
  migrateSimpleRetention,
  retentionPolicyToYears,
  type RetentionPolicy,
} from "@/types/schemas/retention-policy.schema";

export type FieldProtection = {
  /** The retention as text (the summary of the entity's policy, or the legacy value); `null` when there is none. */
  retention: string | null;
  /** The years the retention covers, which the range filters compare; `null` for indefinite, unset or unreadable. */
  retentionYears: number | null;
  anonymization: string | null;
  encryption: string | null;
};

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const textOrNull = (value: unknown): string | null => (typeof value === "string" && value.trim() !== "" ? value : null);

/**
 * The retention policy an entity stores (`metadata.retentionPolicy`), read as the retention page reads it: a structured policy, or a legacy string
 * migrated the same way. `null` when the entity has none, or what it stores is not a valid policy.
 */
export function entityRetentionPolicy(metadata: unknown): RetentionPolicy | null {
  const raw = asRecord(metadata).retentionPolicy;
  if (typeof raw === "string") return raw.trim() === "" ? null : migrateSimpleRetention(raw);
  if (typeof raw !== "object" || raw === null) return null;
  const checked = RetentionPolicySchema.safeParse(raw);
  return checked.success ? checked.data : null;
}

/**
 * The retention as the views show it: the summary the retention page shows, except that a policy kept only as text (a stored text no duration
 * reads: the migration makes it `indefinite` with the text as its description) shows that text as it was written, not "Retain indefinitely".
 */
export function retentionText(policy: RetentionPolicy): string {
  return policy.strategy === "indefinite" && policy.description ? policy.description : formatRetentionSummary(policy);
}

/**
 * The years a retention covers, for the range filters: a legacy string ("3 years", "90 days", "6 months", "30d") or the structured object. `null`
 * when it is not a period (`indefinite`, or text that is no duration).
 */
export function parseRetentionToYears(retention: string | Record<string, unknown>): number | null {
  // Handle structured RetentionPolicy object
  if (typeof retention === "object" && retention !== null) {
    const policy = retention as { strategy?: string; period?: number; periodUnit?: string };
    if (policy.strategy === "indefinite") return null;
    if (!policy.period || !policy.periodUnit) return null;
    switch (policy.periodUnit) {
      case "years": return policy.period;
      case "months": return policy.period / 12;
      case "days": return policy.period / 365;
      default: return null;
    }
  }

  // Handle legacy string format
  const lower = (retention as string).toLowerCase().trim();
  // Handle compact format: "30d", "90d", "1y"
  const compactMatch = lower.match(/^(\d+)(d|y)$/);
  if (compactMatch) {
    const num = parseInt(compactMatch[1], 10);
    return compactMatch[2] === "y" ? num : num / 365;
  }
  // Handle verbose format: "1 year", "90 days"
  const match = lower.match(/^(\d+)\s*(year|yr|month|mo|day|d)s?$/);
  if (!match) return null;
  const num = parseInt(match[1], 10);
  const unit = match[2];
  if (unit.startsWith("year") || unit.startsWith("yr")) return num;
  if (unit.startsWith("month") || unit === "mo") return num / 12;
  if (unit.startsWith("day") || unit === "d") return num / 365;
  return null;
}

/** What a field protects. `entityMetadata` is the metadata of the field's entity (`null` or absent when it is not known). */
export function fieldProtection(decorators: unknown, entityMetadata: unknown): FieldProtection {
  const root = asRecord(decorators);
  const legacy = asRecord(root.policy);
  const panel = asRecord(asRecord(root.typespec).governance);
  const source = asRecord(root.governance);
  const has = (record: Record<string, unknown>, key: string): boolean => Object.prototype.hasOwnProperty.call(record, key);

  // The panel's key answers even as null; without it, the TypeSpec source's `@anonymization`, then the legacy key.
  const anonymization = has(panel, "anonymization")
    ? textOrNull(panel.anonymization)
    : (textOrNull(source.anonymization) ?? textOrNull(legacy.anonymization));
  const encryption = has(panel, "encryption") ? textOrNull(panel.encryption) : textOrNull(legacy.encryption);

  const policy = entityRetentionPolicy(entityMetadata);
  const legacyRetention = textOrNull(legacy.retention);
  const retention = policy ? retentionText(policy) : legacyRetention;
  const retentionYears = policy ? retentionPolicyToYears(policy) : legacyRetention === null ? null : parseRetentionToYears(legacyRetention);

  return { retention, retentionYears, anonymization, encryption };
}

const methodKey = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Whether a stored method is the one a filter names (`wanted` is a compliance enum value). `none` names the fields with no method: no value at all,
 * or the value `none`.
 */
export function isMethod(value: string | null, wanted: string): boolean {
  if (wanted === "none") return value === null || methodKey(value) === "none";
  return value !== null && methodKey(value) === methodKey(wanted);
}

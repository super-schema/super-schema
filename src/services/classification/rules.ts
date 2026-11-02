/**
 * Classification Rules
 *
 * Pure functions that evaluate individual field changes and produce
 * classification reasons. No side effects, no database access.
 */

import type { DiffField } from "@/services/version-history/version.types";
import type {
  ChangeType,
  Severity,
} from "@/types/schemas/classification";

export interface ClassificationReason {
  changeType: ChangeType;
  severity: Severity;
  reason: string;
  fieldName: string;
}

// ---------------------------------------------------------------------------
// Core Rule Evaluation
// ---------------------------------------------------------------------------

/**
 * Evaluate a single DiffField against all classification rules.
 * Returns all matching reasons.
 */
export function evaluateFieldChange(field: DiffField): ClassificationReason[] {
  const reasons: ClassificationReason[] = [];

  switch (field.changeType) {
    case "added":
      reasons.push(...evaluateAddedField(field));
      break;
    case "removed":
      reasons.push(...evaluateRemovedField(field));
      break;
    case "modified":
      reasons.push(...evaluateModifiedField(field));
      break;
    case "unchanged":
      // No classification needed
      break;
  }

  return reasons;
}

// ---------------------------------------------------------------------------
// Added Field Rules
// ---------------------------------------------------------------------------

function evaluateAddedField(field: DiffField): ClassificationReason[] {
  const snapshot = field.versionB;
  if (!snapshot) return [];

  if (snapshot.nullable) {
    return [
      {
        changeType: "non-breaking",
        severity: "low",
        reason: `Added optional (nullable) field "${field.fieldName}" — safe addition`,
        fieldName: field.fieldName,
      },
    ];
  }

  // Non-nullable field added = breaking (consumers must provide value)
  return [
    {
      changeType: "breaking",
      severity: "high",
      reason: `Added required (non-nullable) field "${field.fieldName}" — consumers must provide a value`,
      fieldName: field.fieldName,
    },
  ];
}

// ---------------------------------------------------------------------------
// Removed Field Rules
// ---------------------------------------------------------------------------

function evaluateRemovedField(field: DiffField): ClassificationReason[] {
  return [
    {
      changeType: "breaking",
      severity: "critical",
      reason: `Removed field "${field.fieldName}" — consumers depending on this field will break`,
      fieldName: field.fieldName,
    },
  ];
}

// ---------------------------------------------------------------------------
// Modified Field Rules
// ---------------------------------------------------------------------------

function evaluateModifiedField(field: DiffField): ClassificationReason[] {
  const reasons: ClassificationReason[] = [];
  const changedProps = field.changedProperties ?? [];
  const before = field.versionA;
  const after = field.versionB;

  if (!before || !after) return reasons;

  for (const prop of changedProps) {
    switch (prop.property) {
      case "type":
        reasons.push({
          changeType: "breaking",
          severity: "high",
          reason: `Changed type of field "${field.fieldName}" from "${prop.before}" to "${prop.after}"`,
          fieldName: field.fieldName,
        });
        break;

      case "nullable":
        if (prop.before === true && prop.after === false) {
          // Making nullable → non-nullable = breaking
          reasons.push({
            changeType: "breaking",
            severity: "high",
            reason: `Made field "${field.fieldName}" non-nullable (was nullable) — existing null values will cause errors`,
            fieldName: field.fieldName,
          });
        } else {
          // Making non-nullable → nullable = non-breaking
          reasons.push({
            changeType: "non-breaking",
            severity: "low",
            reason: `Made field "${field.fieldName}" nullable (was required) — relaxes constraint`,
            fieldName: field.fieldName,
          });
        }
        break;

      case "name":
        // Check if an alias was added
        if (
          after.aliases &&
          after.aliases.length > 0 &&
          after.aliases.includes(String(prop.before))
        ) {
          reasons.push({
            changeType: "non-breaking",
            severity: "low",
            reason: `Renamed field "${prop.before}" to "${prop.after}" with alias — backward compatible`,
            fieldName: field.fieldName,
          });
        } else {
          reasons.push({
            changeType: "breaking",
            severity: "high",
            reason: `Renamed field "${prop.before}" to "${prop.after}" without alias — consumers using old name will break`,
            fieldName: field.fieldName,
          });
        }
        break;

      case "precision":
      case "scale": {
        const beforeVal = prop.before as number | null;
        const afterVal = prop.after as number | null;
        if (
          beforeVal !== null &&
          afterVal !== null &&
          afterVal < beforeVal
        ) {
          reasons.push({
            changeType: "breaking",
            severity: "medium",
            reason: `Reduced ${prop.property} of field "${field.fieldName}" from ${beforeVal} to ${afterVal} — possible data loss`,
            fieldName: field.fieldName,
          });
        } else {
          reasons.push({
            changeType: "non-breaking",
            severity: "low",
            reason: `Increased ${prop.property} of field "${field.fieldName}" — safe expansion`,
            fieldName: field.fieldName,
          });
        }
        break;
      }

      case "classification":
        reasons.push({
          changeType: "classification-change",
          severity: "medium",
          reason: `Changed classification of field "${field.fieldName}" from "${prop.before ?? "none"}" to "${prop.after ?? "none"}" — may require governance review`,
          fieldName: field.fieldName,
        });
        break;

      case "description":
        reasons.push({
          changeType: "non-breaking",
          severity: "low",
          reason: `Modified description of field "${field.fieldName}"`,
          fieldName: field.fieldName,
        });
        break;

      case "referenceTarget":
        // Another entity: consumers and the generated schemas type the field by a different model.
        reasons.push({
          changeType: "breaking",
          severity: "high",
          reason: `Re-pointed reference "${field.fieldName}" from "${prop.before ?? "none"}" to "${prop.after ?? "none"}" — consumers and generated schemas now type it as another entity`,
          fieldName: field.fieldName,
        });
        break;

      case "decorators":
        reasons.push({
          changeType: "non-breaking",
          severity: "low",
          reason: `Modified decorators on field "${field.fieldName}"`,
          fieldName: field.fieldName,
        });
        break;

      case "aliases":
        reasons.push({
          changeType: "non-breaking",
          severity: "low",
          reason: `Modified aliases on field "${field.fieldName}"`,
          fieldName: field.fieldName,
        });
        break;

      default:
        // Other metadata changes are non-breaking
        reasons.push({
          changeType: "non-breaking",
          severity: "low",
          reason: `Modified ${prop.property} on field "${field.fieldName}"`,
          fieldName: field.fieldName,
        });
        break;
    }
  }

  return reasons;
}

// ---------------------------------------------------------------------------
// Severity Rollup
// ---------------------------------------------------------------------------

const SEVERITY_ORDER: Record<Severity, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

/**
 * Compute the maximum severity from a list of reasons.
 */
export function maxSeverity(reasons: ClassificationReason[]): Severity {
  if (reasons.length === 0) return "low";
  return reasons.reduce<Severity>((max, r) => {
    return SEVERITY_ORDER[r.severity] > SEVERITY_ORDER[max]
      ? r.severity
      : max;
  }, "low");
}

/**
 * Compute overall change type from a list of reasons.
 * If any reason is "breaking" → overall is "breaking".
 * Else if any is "classification-change" → overall is "classification-change".
 * Else "non-breaking".
 */
export function aggregateChangeType(
  reasons: ClassificationReason[]
): ChangeType {
  if (reasons.some((r) => r.changeType === "breaking")) return "breaking";
  if (reasons.some((r) => r.changeType === "classification-change"))
    return "classification-change";
  return "non-breaking";
}

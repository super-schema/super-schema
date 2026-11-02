/**
 * BigQuery Target Classifier
 *
 * BigQuery-specific compatibility rules:
 * - ADD COLUMN is always safe (non-breaking)
 * - DROP COLUMN requires manual review (breaking)
 * - Type changes may or may not be safe depending on BigQuery type coercion
 */

import type { DiffField } from "@/services/version-history/version.types";
import type { PerTargetClassification, ChangeType } from "@/types/schemas/classification";

export function classifyForBigQuery(
  fields: DiffField[]
): PerTargetClassification {
  const details: string[] = [];
  let changeType: ChangeType = "non-breaking";

  for (const field of fields) {
    if (field.changeType === "unchanged") continue;

    switch (field.changeType) {
      case "added":
        // ADD COLUMN is always safe in BigQuery
        details.push(
          `ADD COLUMN "${field.fieldName}" — safe (BigQuery supports online schema expansion)`
        );
        break;

      case "removed":
        // DROP COLUMN requires caution
        details.push(
          `DROP COLUMN "${field.fieldName}" — breaking (requires ALTER TABLE DROP COLUMN)`
        );
        changeType = "breaking";
        break;

      case "modified": {
        const changedProps = field.changedProperties ?? [];
        for (const prop of changedProps) {
          if (prop.property === "type") {
            details.push(
              `Type change on "${field.fieldName}": ${prop.before} → ${prop.after} — breaking (BigQuery requires CAST or column recreation)`
            );
            changeType = "breaking";
          } else if (prop.property === "nullable") {
            if (prop.before === true && prop.after === false) {
              details.push(
                `"${field.fieldName}" changed to NOT NULL — breaking (existing NULL values will fail)`
              );
              changeType = "breaking";
            } else {
              details.push(
                `"${field.fieldName}" changed to NULLABLE — non-breaking`
              );
            }
          } else if (prop.property === "classification") {
            if (changeType !== "breaking") {
              changeType = "classification-change";
            }
            details.push(
              `Classification change on "${field.fieldName}" — may require policy update`
            );
          } else if (
            prop.property === "precision" ||
            prop.property === "scale"
          ) {
            const beforeVal = prop.before as number | null;
            const afterVal = prop.after as number | null;
            if (
              beforeVal !== null &&
              afterVal !== null &&
              afterVal < beforeVal
            ) {
              details.push(
                `Reduced ${prop.property} on "${field.fieldName}" — breaking (data truncation)`
              );
              changeType = "breaking";
            }
          } else if (prop.property === "referenceTarget") {
            details.push(
              `Re-pointed reference on "${field.fieldName}": ${prop.before ?? "none"} → ${prop.after ?? "none"} — breaking (the column's record type changes)`
            );
            changeType = "breaking";
          }
          // Other property changes are non-breaking for BigQuery
        }
        break;
      }
    }
  }

  return {
    target: "bigquery",
    changeType,
    details: details.join("; ") || "No impactful changes for BigQuery",
  };
}

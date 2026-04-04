/**
 * Avro Target Classifier
 *
 * Avro-specific compatibility rules:
 * - Additions of optional fields = backward compatible
 * - Removing fields or enum values = breaking
 * - Type changes depend on Avro promotion rules
 */

import type { DiffField } from "@/services/version-history/version.types";
import type { PerTargetClassification, ChangeType } from "@/types/schemas/classification";

/** Avro type promotion rules — some type changes are safe */
const AVRO_PROMOTIONS: Record<string, string[]> = {
  int: ["long", "float", "double"],
  long: ["float", "double"],
  float: ["double"],
};

function isAvroPromotionSafe(from: string, to: string): boolean {
  const promotions = AVRO_PROMOTIONS[from.toLowerCase()];
  return promotions?.includes(to.toLowerCase()) ?? false;
}

export function classifyForAvro(
  fields: DiffField[]
): PerTargetClassification {
  const details: string[] = [];
  let changeType: ChangeType = "non-breaking";

  for (const field of fields) {
    if (field.changeType === "unchanged") continue;

    switch (field.changeType) {
      case "added": {
        const snapshot = field.versionB;
        if (snapshot?.nullable) {
          details.push(
            `Added optional field "${field.fieldName}" — backward compatible (implicit null default)`
          );
        } else {
          details.push(
            `Added required field "${field.fieldName}" — breaking (no default value for old data)`
          );
          changeType = "breaking";
        }
        break;
      }

      case "removed": {
        const snapshot = field.versionA;
        if (snapshot?.nullable) {
          details.push(
            `Removed optional field "${field.fieldName}" — forward compatible only`
          );
          // Forward-only compat is still considered breaking for safety
          if (changeType !== "breaking") changeType = "breaking";
        } else {
          details.push(
            `Removed required field "${field.fieldName}" — breaking (Avro identifies fields by name)`
          );
          changeType = "breaking";
        }
        break;
      }

      case "modified": {
        const changedProps = field.changedProperties ?? [];
        for (const prop of changedProps) {
          if (prop.property === "type") {
            if (
              isAvroPromotionSafe(
                String(prop.before),
                String(prop.after)
              )
            ) {
              details.push(
                `Type promotion on "${field.fieldName}": ${prop.before} → ${prop.after} — safe (Avro promotion)`
              );
            } else {
              details.push(
                `Type change on "${field.fieldName}": ${prop.before} → ${prop.after} — breaking (not an Avro promotion)`
              );
              changeType = "breaking";
            }
          } else if (prop.property === "nullable") {
            if (prop.before === true && prop.after === false) {
              details.push(
                `"${field.fieldName}" changed to required — breaking (old data may have nulls)`
              );
              changeType = "breaking";
            } else {
              details.push(
                `"${field.fieldName}" changed to optional — backward compatible`
              );
            }
          } else if (prop.property === "name") {
            details.push(
              `Field renamed "${prop.before}" → "${prop.after}" — breaking (Avro identifies by name)`
            );
            changeType = "breaking";
          } else if (prop.property === "classification") {
            if (changeType !== "breaking") {
              changeType = "classification-change";
            }
            details.push(
              `Classification change on "${field.fieldName}" — metadata only`
            );
          }
          // Other property changes are non-breaking for Avro
        }
        break;
      }
    }
  }

  return {
    target: "avro",
    changeType,
    details:
      details.join("; ") || "No impactful changes for Avro",
  };
}

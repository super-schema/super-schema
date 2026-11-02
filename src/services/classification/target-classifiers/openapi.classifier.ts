/**
 * OpenAPI Target Classifier
 *
 * OpenAPI-specific compatibility rules:
 * - Added optional property = non-breaking
 * - Removed required property = breaking
 * - Added required property = breaking
 * - Type changes = breaking
 */

import type { DiffField } from "@/services/version-history/version.types";
import type { PerTargetClassification, ChangeType } from "@/types/schemas/classification";

export function classifyForOpenAPI(
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
            `Added optional property "${field.fieldName}" — non-breaking for API consumers`
          );
        } else {
          details.push(
            `Added required property "${field.fieldName}" — breaking (request consumers must now send this field)`
          );
          changeType = "breaking";
        }
        break;
      }

      case "removed": {
        const snapshot = field.versionA;
        if (snapshot && !snapshot.nullable) {
          details.push(
            `Removed required property "${field.fieldName}" — breaking (response consumers expect this field)`
          );
          changeType = "breaking";
        } else {
          details.push(
            `Removed optional property "${field.fieldName}" — may affect consumers relying on it`
          );
          if (changeType !== "breaking") changeType = "breaking";
        }
        break;
      }

      case "modified": {
        const changedProps = field.changedProperties ?? [];
        for (const prop of changedProps) {
          if (prop.property === "type") {
            details.push(
              `Type change on "${field.fieldName}": ${prop.before} → ${prop.after} — breaking (serialization incompatibility)`
            );
            changeType = "breaking";
          } else if (prop.property === "nullable") {
            if (prop.before === true && prop.after === false) {
              details.push(
                `"${field.fieldName}" changed to required — breaking (consumers sending null will get validation errors)`
              );
              changeType = "breaking";
            } else {
              details.push(
                `"${field.fieldName}" changed to optional — non-breaking`
              );
            }
          } else if (prop.property === "classification") {
            if (changeType !== "breaking") {
              changeType = "classification-change";
            }
            details.push(
              `Classification change on "${field.fieldName}" — may require API documentation update`
            );
          } else if (prop.property === "referenceTarget") {
            details.push(
              `Re-pointed reference on "${field.fieldName}": ${prop.before ?? "none"} → ${prop.after ?? "none"} — breaking (the property's schema is another entity's)`
            );
            changeType = "breaking";
          }
          // Other property changes are non-breaking for OpenAPI
        }
        break;
      }
    }
  }

  return {
    target: "openapi",
    changeType,
    details:
      details.join("; ") ||
      "No impactful changes for OpenAPI",
  };
}

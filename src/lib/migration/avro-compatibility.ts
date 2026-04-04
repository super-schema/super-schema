/**
 * Avro Schema Compatibility Classifier
 *
 * Pure function: takes a ChangeEntry[] diff and classifies the schema evolution
 * as BACKWARD, FORWARD, FULL, or BREAKING per Avro compatibility rules.
 *
 * Avro compatibility rules:
 * - BACKWARD: new schema can read data written by old schema
 *   - Added fields with defaults (nullable fields have implicit null default)
 *   - Removed fields that had defaults
 * - FORWARD: old schema can read data written by new schema
 *   - Removed optional fields
 *   - Added fields (old readers ignore unknown fields)
 * - FULL: both backward and forward compatible
 * - BREAKING: incompatible change
 *   - Type changes
 *   - Required (non-nullable) field removed
 *   - Required (non-nullable) field added without default
 *   - Field renamed (appears as remove + add)
 *
 * No side effects, no database access.
 */

import type { ChangeEntry } from "@/services/version-history/version.types";
import type {
  CompatibilityResult,
  AvroCompatibility,
  MigrationArtifact,
} from "./migration.types";

// ---------------------------------------------------------------------------
// Compatibility Classification
// ---------------------------------------------------------------------------

/**
 * Classify Avro schema compatibility from a set of field changes.
 *
 * @param changes - The list of field changes from computeFieldDiff()
 * @returns CompatibilityResult with classification and detailed reasons
 */
export function classifyAvroCompatibility(
  changes: ChangeEntry[]
): CompatibilityResult {
  if (changes.length === 0) {
    return {
      compatible: true,
      compatibility: "FULL",
      details: ["No changes detected — schemas are identical"],
    };
  }

  const details: string[] = [];
  let isBackwardCompatible = true;
  let isForwardCompatible = true;

  for (const change of changes) {
    switch (change.type) {
      case "added": {
        const field = change.details.after!;
        if (field.nullable) {
          // Nullable fields have an implicit null default in Avro — backward compatible
          details.push(
            `Added optional field "${field.name}" (${field.type}, nullable) — backward compatible (implicit null default)`
          );
          // Forward: old readers will ignore unknown fields
        } else {
          // Required field added without default — not backward compatible
          // Old data won't have this field, new reader needs it
          // Also not forward compatible — old consumers can't provide the required field
          details.push(
            `Added required field "${field.name}" (${field.type}, non-nullable) — BREAKING: old data lacks this field and no default is defined`
          );
          isBackwardCompatible = false;
          isForwardCompatible = false;
        }
        break;
      }

      case "removed": {
        const field = change.details.before!;
        if (field.nullable) {
          // Removing an optional field: forward compatible (old readers can use default)
          // But not backward compatible if new readers still expect it
          details.push(
            `Removed optional field "${field.name}" (${field.type}, nullable) — forward compatible (old readers use default null)`
          );
          // Backward: new reader doesn't need the field, old data has it — OK
          // Forward: old reader expects field, new data doesn't have it — needs default
        } else {
          // Required field removed — breaking
          details.push(
            `Removed required field "${field.name}" (${field.type}, non-nullable) — BREAKING: old readers expect this field with no default`
          );
          isBackwardCompatible = false;
          isForwardCompatible = false;
        }
        break;
      }

      case "modified": {
        const before = change.details.before!;
        const after = change.details.after!;
        const changedProps = change.details.changedProperties;

        if (changedProps.includes("type")) {
          // Type change is always breaking in Avro
          details.push(
            `Changed type of field "${after.name}" from "${before.type}" to "${after.type}" — BREAKING: Avro does not support type changes`
          );
          isBackwardCompatible = false;
          isForwardCompatible = false;
        }

        if (changedProps.includes("nullable")) {
          if (!before.nullable && after.nullable) {
            // Making a required field optional — forward compatible only
            details.push(
              `Field "${after.name}" changed from required to optional — forward compatible (old readers still expect value)`
            );
          } else if (before.nullable && !after.nullable) {
            // Making an optional field required — breaking
            details.push(
              `Field "${after.name}" changed from optional to required — BREAKING: old data may have null values`
            );
            isBackwardCompatible = false;
            isForwardCompatible = false;
          }
        }

        // Name change on a field is detected as remove + add, not here,
        // but if changedProperties includes "name" we flag it
        if (changedProps.includes("name")) {
          details.push(
            `Field renamed from "${before.name}" to "${after.name}" — BREAKING: Avro identifies fields by name`
          );
          isBackwardCompatible = false;
          isForwardCompatible = false;
        }

        // Other property changes (description, classification, etc.) are non-breaking
        const nonBreakingProps = changedProps.filter(
          (p) => !["type", "nullable", "name"].includes(p)
        );
        if (nonBreakingProps.length > 0 && !changedProps.includes("type") && !changedProps.includes("nullable") && !changedProps.includes("name")) {
          details.push(
            `Field "${after.name}" metadata changed (${nonBreakingProps.join(", ")}) — compatible (metadata-only change)`
          );
        }
        break;
      }
    }
  }

  // Determine overall compatibility
  let compatibility: AvroCompatibility;
  if (isBackwardCompatible && isForwardCompatible) {
    compatibility = "FULL";
  } else if (isBackwardCompatible) {
    compatibility = "BACKWARD";
  } else if (isForwardCompatible) {
    compatibility = "FORWARD";
  } else {
    compatibility = "BREAKING";
  }

  return {
    compatible: compatibility !== "BREAKING",
    compatibility,
    details,
  };
}

// ---------------------------------------------------------------------------
// Avro Migration Artifact Generator
// ---------------------------------------------------------------------------

/**
 * Generate an Avro compatibility report as a MigrationArtifact.
 *
 * @param changes - The list of field changes from computeFieldDiff()
 * @returns MigrationArtifact containing the JSON compatibility report
 */
export function generateAvroMigration(
  changes: ChangeEntry[]
): MigrationArtifact {
  const result = classifyAvroCompatibility(changes);

  const warnings: string[] = [];
  if (result.compatibility === "BREAKING") {
    warnings.push(
      "Schema change is BREAKING — consumers using the old schema will not be able to read data written with the new schema"
    );
  } else if (result.compatibility === "FORWARD") {
    warnings.push(
      "Schema change is FORWARD compatible only — new schema can write data that old consumers can read, but new consumers cannot read old data"
    );
  }

  return {
    type: "compatibility-report",
    content: JSON.stringify(result, null, 2),
    warnings,
  };
}

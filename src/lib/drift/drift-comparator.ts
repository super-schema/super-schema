/**
 * Drift Comparator — compares two normalized field lists to detect schema drift.
 *
 * Used by the drift service (Story 9.2) to compare the current emitted output
 * against the imported/registered implementation.
 *
 * Pure functions with no I/O or framework dependencies.
 */

import type { ParsedField } from "@/lib/importers/types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface NormalizedField {
  name: string;
  type: string;
  nullable: boolean;
  description?: string;
  fieldNumber?: number;
}

export type DriftDifferenceType =
  | "added"
  | "removed"
  | "type-mismatch"
  | "metadata-mismatch";

export interface DriftDifference {
  fieldName: string;
  type: DriftDifferenceType;
  logicalValue: string | null;
  implementationValue: string | null;
}

export type DriftStatus = "in-sync" | "drifted" | "unknown";

export interface DriftTargetStatus {
  targetFormat: string;
  driftStatus: DriftStatus;
  differences: DriftDifference[];
}

export interface DriftReport {
  entityId: string;
  entityName: string;
  targets: DriftTargetStatus[];
}

// ---------------------------------------------------------------------------
// Normalize parsed fields into a comparable format
// ---------------------------------------------------------------------------

export function normalizeFieldList(
  parsedFields: ParsedField[]
): NormalizedField[] {
  return parsedFields
    .map((f) => ({
      name: f.name,
      type: f.type,
      nullable: f.nullable,
      description: f.description,
      fieldNumber: f.fieldNumber,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------------------
// Compare two normalized field lists and produce differences
// ---------------------------------------------------------------------------

export function compareFieldLists(
  logical: NormalizedField[],
  implementation: NormalizedField[]
): DriftDifference[] {
  const differences: DriftDifference[] = [];

  const logicalMap = new Map(logical.map((f) => [f.name, f]));
  const implMap = new Map(implementation.map((f) => [f.name, f]));

  // Fields in logical but not in implementation → "added"
  for (const [name, logicalField] of logicalMap) {
    if (!implMap.has(name)) {
      differences.push({
        fieldName: name,
        type: "added",
        logicalValue: logicalField.type,
        implementationValue: null,
      });
    }
  }

  // Fields in implementation but not in logical → "removed"
  for (const [name, implField] of implMap) {
    if (!logicalMap.has(name)) {
      differences.push({
        fieldName: name,
        type: "removed",
        logicalValue: null,
        implementationValue: implField.type,
      });
    }
  }

  // Fields in both — check for type and metadata mismatches
  for (const [name, logicalField] of logicalMap) {
    const implField = implMap.get(name);
    if (!implField) continue;

    // Type mismatch
    if (logicalField.type !== implField.type) {
      differences.push({
        fieldName: name,
        type: "type-mismatch",
        logicalValue: logicalField.type,
        implementationValue: implField.type,
      });
    }

    // Nullability mismatch
    if (logicalField.nullable !== implField.nullable) {
      differences.push({
        fieldName: name,
        type: "metadata-mismatch",
        logicalValue: `nullable=${logicalField.nullable}`,
        implementationValue: `nullable=${implField.nullable}`,
      });
    }
  }

  return differences;
}

// ---------------------------------------------------------------------------
// Determine drift status from differences
// ---------------------------------------------------------------------------

export function determineDriftStatus(
  differences: DriftDifference[]
): DriftStatus {
  if (differences.length === 0) {
    return "in-sync";
  }
  return "drifted";
}

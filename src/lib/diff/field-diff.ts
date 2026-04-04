/**
 * Field Diff Algorithm
 *
 * Pure function that compares two field snapshots and produces a list of changes.
 * No side effects, no database access.
 */

import type { FieldSnapshot, ChangeEntry, DiffField, DiffResult, PropertyChange } from "@/services/version-history/version.types";

/** Properties to compare when detecting modifications */
const COMPARABLE_PROPERTIES: (keyof FieldSnapshot)[] = [
  "name",
  "type",
  "precision",
  "scale",
  "nullable",
  "isKey",
  "fieldNumber",
  "description",
  "classification",
  "aliases",
  "decorators",
  "sortOrder",
];

/**
 * Deep equality check for JSON-serializable values.
 */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return a === b;
  if (typeof a !== typeof b) return false;

  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((val, i) => deepEqual(val, b[i]));
  }

  if (typeof a === "object" && typeof b === "object") {
    const aObj = a as Record<string, unknown>;
    const bObj = b as Record<string, unknown>;
    const aKeys = Object.keys(aObj);
    const bKeys = Object.keys(bObj);
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every((key) => deepEqual(aObj[key], bObj[key]));
  }

  return false;
}

/**
 * Compare two sets of field snapshots and produce a list of change entries.
 *
 * Algorithm:
 * 1. Index fields by name from both snapshots
 * 2. Fields in current but not previous = "added"
 * 3. Fields in previous but not current = "removed"
 * 4. Fields in both = compare all properties; if any differ = "modified"
 */
export function computeFieldDiff(
  previousFields: FieldSnapshot[],
  currentFields: FieldSnapshot[]
): ChangeEntry[] {
  const changes: ChangeEntry[] = [];

  const previousByName = new Map<string, FieldSnapshot>();
  for (const field of previousFields) {
    previousByName.set(field.name, field);
  }

  const currentByName = new Map<string, FieldSnapshot>();
  for (const field of currentFields) {
    currentByName.set(field.name, field);
  }

  // Detect added fields (in current but not previous)
  for (const [name, field] of currentByName) {
    if (!previousByName.has(name)) {
      changes.push({
        type: "added",
        fieldName: name,
        details: {
          after: field,
          changedProperties: COMPARABLE_PROPERTIES.slice(),
        },
      });
    }
  }

  // Detect removed fields (in previous but not current)
  for (const [name, field] of previousByName) {
    if (!currentByName.has(name)) {
      changes.push({
        type: "removed",
        fieldName: name,
        details: {
          before: field,
          changedProperties: COMPARABLE_PROPERTIES.slice(),
        },
      });
    }
  }

  // Detect modified fields (in both, with property differences)
  for (const [name, currentField] of currentByName) {
    const previousField = previousByName.get(name);
    if (!previousField) continue;

    const changedProperties: string[] = [];
    for (const prop of COMPARABLE_PROPERTIES) {
      const prevVal = previousField[prop];
      const currVal = currentField[prop];
      if (!deepEqual(prevVal, currVal)) {
        changedProperties.push(prop);
      }
    }

    if (changedProperties.length > 0) {
      changes.push({
        type: "modified",
        fieldName: name,
        details: {
          before: previousField,
          after: currentField,
          changedProperties,
        },
      });
    }
  }

  // Sort: added first, then modified, then removed (for consistent output)
  const typeOrder: Record<string, number> = { added: 0, modified: 1, removed: 2 };
  changes.sort((a, b) => {
    const orderDiff = typeOrder[a.type] - typeOrder[b.type];
    if (orderDiff !== 0) return orderDiff;
    return a.fieldName.localeCompare(b.fieldName);
  });

  return changes;
}

/**
 * Compute property-level changes between two field snapshots.
 * Returns an array of PropertyChange entries for each differing property.
 */
function computePropertyChanges(
  before: FieldSnapshot,
  after: FieldSnapshot
): PropertyChange[] {
  const propertyChanges: PropertyChange[] = [];

  for (const prop of COMPARABLE_PROPERTIES) {
    const prevVal = before[prop];
    const currVal = after[prop];
    if (!deepEqual(prevVal, currVal)) {
      // Determine category based on property name
      let category = "field";
      if (prop === "decorators") {
        category = "decorators";
      } else if (prop === "classification") {
        category = "governance";
      } else if (prop === "aliases") {
        category = "metadata";
      }
      propertyChanges.push({
        property: prop,
        category,
        before: prevVal,
        after: currVal,
      });
    }
  }

  return propertyChanges;
}

/**
 * Compute a structured diff result between two sets of field snapshots.
 * Includes unchanged fields and property-level detail for modified fields.
 */
export function computeDiffResult(
  previousFields: FieldSnapshot[],
  currentFields: FieldSnapshot[],
  fromVersion: number,
  toVersion: number
): DiffResult {
  const previousByName = new Map<string, FieldSnapshot>();
  for (const field of previousFields) {
    previousByName.set(field.name, field);
  }

  const currentByName = new Map<string, FieldSnapshot>();
  for (const field of currentFields) {
    currentByName.set(field.name, field);
  }

  const fields: DiffField[] = [];

  // Added fields (in current but not previous)
  for (const [name, field] of currentByName) {
    if (!previousByName.has(name)) {
      fields.push({
        fieldName: name,
        changeType: "added",
        versionB: field,
      });
    }
  }

  // Removed fields (in previous but not current)
  for (const [name, field] of previousByName) {
    if (!currentByName.has(name)) {
      fields.push({
        fieldName: name,
        changeType: "removed",
        versionA: field,
      });
    }
  }

  // Modified and unchanged fields (in both)
  for (const [name, currentField] of currentByName) {
    const previousField = previousByName.get(name);
    if (!previousField) continue;

    const propertyChanges = computePropertyChanges(previousField, currentField);

    if (propertyChanges.length > 0) {
      fields.push({
        fieldName: name,
        changeType: "modified",
        versionA: previousField,
        versionB: currentField,
        changedProperties: propertyChanges,
      });
    } else {
      fields.push({
        fieldName: name,
        changeType: "unchanged",
        versionA: previousField,
        versionB: currentField,
      });
    }
  }

  // Sort: added first, then modified, then removed, then unchanged
  const typeOrder: Record<string, number> = {
    added: 0,
    modified: 1,
    removed: 2,
    unchanged: 3,
  };
  fields.sort((a, b) => {
    const orderDiff = typeOrder[a.changeType] - typeOrder[b.changeType];
    if (orderDiff !== 0) return orderDiff;
    return a.fieldName.localeCompare(b.fieldName);
  });

  const summary = {
    added: fields.filter((f) => f.changeType === "added").length,
    removed: fields.filter((f) => f.changeType === "removed").length,
    modified: fields.filter((f) => f.changeType === "modified").length,
    unchanged: fields.filter((f) => f.changeType === "unchanged").length,
  };

  return { fromVersion, toVersion, summary, fields };
}

/**
 * Generate a human-readable one-line summary of changes.
 */
export function summarizeChanges(changes: ChangeEntry[]): string {
  const added = changes.filter((c) => c.type === "added").length;
  const modified = changes.filter((c) => c.type === "modified").length;
  const removed = changes.filter((c) => c.type === "removed").length;

  const parts: string[] = [];
  if (added > 0) parts.push(`Added ${added} field${added !== 1 ? "s" : ""}`);
  if (modified > 0) parts.push(`Modified ${modified} field${modified !== 1 ? "s" : ""}`);
  if (removed > 0) parts.push(`Removed ${removed} field${removed !== 1 ? "s" : ""}`);

  if (parts.length === 0) return "No changes";
  return parts.join(", ");
}

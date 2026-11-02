/**
 * Field Diff Algorithm
 *
 * Pure function that compares two field snapshots and produces a list of changes.
 * No side effects, no database access.
 */

import type { FieldSnapshot, ChangeEntry, DiffField, DiffResult, PropertyChange } from "@/services/version-history/version.types";
import { describeEntityRef, holdsEntityReference, qualifiedName, readFieldReference, withoutReferenceKeys } from "@/lib/references/entity-reference";

/**
 * Properties to compare when detecting modifications. `referenceTarget` is not a stored column: it is the entity a reference field points at
 * (see `referenceRetargeted`), a change of its own, so re-pointing a reference is never read as a cosmetic decorators edit.
 */
const COMPARABLE_PROPERTIES = [
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
  "referenceTarget",
] as const;

type ComparableProperty = (typeof COMPARABLE_PROPERTIES)[number];

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
      if (propertyDiffers(previousField, currentField, prop)) {
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

/** A decorators value as an object: anything that is not a plain object reads as none. */
function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/**
 * The entity a reference names in its decorators: its id (absent on a name-only or id-less reference), its name, its qualified name (absent
 * on a name-only reference) and how it reads in a change (`shown`).
 */
type PointedEntity = { id?: string; name?: string; qualified?: string; shown?: string };

function pointedEntity(decorators: unknown): PointedEntity {
  const ref = readFieldReference(decorators);
  if (ref === undefined) {
    const id = asRecord(decorators).referencedEntityId;
    return typeof id === "string" && id !== "" ? { id, shown: id } : {};
  }
  if ("legacyName" in ref) {
    return ref.entityId !== undefined
      ? { id: ref.entityId, name: ref.legacyName, shown: ref.legacyName }
      : { name: ref.legacyName, shown: `${ref.legacyName} (by name)` };
  }
  return { id: ref.entityId, name: ref.entity, qualified: qualifiedName(ref), shown: describeEntityRef(ref) };
}

/**
 * Whether a reference field now points at another entity. Two references that both name their entity by id are the same target when the ids
 * are. A legacy name-only reference that gained the id of the entity it already named (the upgrade) is the same target too. Any other
 * change of the target counts, including a reference that lost its id: it no longer names the entity it named, so the entity it means
 * is looked up by name again. A field that does not hold a reference on both sides is not re-pointed; its type change is the change.
 */
function referenceRetargeted(before: FieldSnapshot, after: FieldSnapshot): boolean {
  if (!holdsEntityReference(before.type, before.decorators) || !holdsEntityReference(after.type, after.decorators)) return false;
  const was = pointedEntity(before.decorators);
  const now = pointedEntity(after.decorators);
  if (was.id !== undefined && now.id !== undefined) return was.id !== now.id;
  // A reference that lost its id no longer names the entity it named (conservative: it is a change).
  if (was.id !== undefined) return true;
  // Without ids, the qualified name tells two same-named entities of different products apart; a name-only side has only its name.
  if (was.qualified !== undefined && now.qualified !== undefined) return was.qualified !== now.qualified;
  return was.name !== now.name;
}

/**
 * What `referenceTarget` reports as a value: the entity the reference points at by its qualified name (`domain / product / entity`, so two
 * same-named entities read apart), marked when the reference names it by name only; the id when there is no name; none for a field that
 * holds no reference.
 */
function referenceTargetLabel(field: FieldSnapshot): string | null {
  if (!holdsEntityReference(field.type, field.decorators)) return null;
  return pointedEntity(field.decorators).shown ?? null;
}

/**
 * A field's type as a change reports it: an array or a map keeps its element (or value) type in its decorators, so that type is part of the
 * field's type (`array<string>`, `map<reference>`). Changing it is a type change, not a decorators edit.
 */
function fieldType(field: FieldSnapshot): string {
  const d = asRecord(field.decorators);
  if (field.type === "array" && typeof d.arrayElementType === "string" && d.arrayElementType !== "") return `array<${d.arrayElementType}>`;
  if (field.type === "map" && typeof d.mapValueType === "string" && d.mapValueType !== "") return `map<${d.mapValueType}>`;
  return field.type;
}

/**
 * Whether the decorators changed in a way that is not a re-point. A re-pointed reference rewrites its target's keys (and drops its pin), which
 * `referenceTarget` reports on its own; `decorators` keeps every other edit, and the pin of a reference that stays on its target.
 */
function decoratorsDiffer(before: FieldSnapshot, after: FieldSnapshot): boolean {
  if (deepEqual(before.decorators, after.decorators)) return false;
  const onlyTheTargetMoved =
    referenceRetargeted(before, after) &&
    deepEqual(withoutReferenceKeys(asRecord(before.decorators)), withoutReferenceKeys(asRecord(after.decorators)));
  return !onlyTheTargetMoved;
}

/** Whether one comparable property differs between the two snapshots of a field. */
function propertyDiffers(before: FieldSnapshot, after: FieldSnapshot, prop: ComparableProperty): boolean {
  if (prop === "referenceTarget") return referenceRetargeted(before, after);
  if (prop === "decorators") return decoratorsDiffer(before, after);
  if (prop === "type") return fieldType(before) !== fieldType(after);
  return !deepEqual(before[prop], after[prop]);
}

/** The value of one comparable property of a field, as a change reports it. */
function propertyValue(field: FieldSnapshot, prop: ComparableProperty): unknown {
  if (prop === "referenceTarget") return referenceTargetLabel(field);
  if (prop === "type") return fieldType(field);
  return field[prop];
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
    if (propertyDiffers(before, after, prop)) {
      // Determine category based on property name
      let category = "field";
      if (prop === "decorators") {
        category = "decorators";
      } else if (prop === "classification") {
        category = "governance";
      } else if (prop === "aliases") {
        category = "metadata";
      } else if (prop === "referenceTarget") {
        category = "reference";
      }
      propertyChanges.push({
        property: prop,
        category,
        before: propertyValue(before, prop),
        after: propertyValue(after, prop),
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

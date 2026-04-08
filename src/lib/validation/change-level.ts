/**
 * Lightweight change-level classifier for save-time version bumping.
 *
 * Determines whether a set of field property changes constitutes a "major"
 * (breaking/structural) or "minor" (documentation/metadata) change.
 */

export type ChangeLevel = "major" | "minor";

/**
 * Field properties that trigger a major version bump when changed.
 * These represent structural or breaking changes that affect consumers.
 */
const MAJOR_PROPERTIES = new Set([
  "type",
  "nullable",
  "isKey",
  "precision",
  "scale",
  "classification",
]);

/**
 * Classify the change level based on which field properties were modified.
 *
 * - If ANY changed property is in the MAJOR set, the change is "major".
 * - Otherwise the change is "minor" (description, summary, format, etc.).
 * - Empty changes default to "minor".
 */
export function classifyChangeLevel(changedProperties: string[]): ChangeLevel {
  for (const prop of changedProperties) {
    if (MAJOR_PROPERTIES.has(prop)) return "major";
  }
  return "minor";
}

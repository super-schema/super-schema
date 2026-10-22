/** The field classification scale, as shown on entity cards. */
export const CLASSIFICATIONS = ["NEVER_STORED", "PII", "SENSITIVE", "INTERNAL", "PUBLIC"] as const;

/** The labels of the standard scale (a level outside it is shown as itself). */
export const CLASSIFICATION_LABELS: Record<(typeof CLASSIFICATIONS)[number], string> = {
  NEVER_STORED: "Never Stored",
  PII: "PII",
  SENSITIVE: "Sensitive",
  INTERNAL: "Internal",
  PUBLIC: "Public",
};

/** The five standard levels always, plus one key per other level present (e.g. an imported vendor level `class4`), under its own name. */
export type ClassificationCounts = Record<(typeof CLASSIFICATIONS)[number], number> & Record<string, number>;

const isStandard = (level: string): level is (typeof CLASSIFICATIONS)[number] => (CLASSIFICATIONS as readonly string[]).includes(level);

/** The levels of `counts` outside the standard scale, with their counts, in name order. */
export function otherClassificationCounts(counts: Readonly<Record<string, number>>): Array<[string, number]> {
  return Object.entries(counts)
    .filter(([level, count]) => !isStandard(level) && count > 0)
    .sort(([a], [b]) => a.localeCompare(b));
}

/** The field list's classification filter: the standard five, then every other level the entity's fields actually carry. */
export function classificationFilterOptions(levels: ReadonlyArray<string | null | undefined>): Array<{ value: string; label: string }> {
  const present = [...new Set(levels.filter((l): l is string => !!l && !isStandard(l.toUpperCase())))].sort((a, b) => a.localeCompare(b));
  return [
    ...CLASSIFICATIONS.map((value) => ({ value, label: CLASSIFICATION_LABELS[value] })),
    ...present.map((value) => ({ value, label: value })),
  ];
}

/** Does a field of `level` match the filter `value` (a standard level compares case-insensitively, any other level exactly)? */
export function matchesClassificationFilter(level: string | null | undefined, value: string): boolean {
  if (!level) return false;
  return isStandard(value) ? level.toUpperCase() === value : level === value;
}

/** One row of `prisma.field.groupBy({ by: ["entityId", "classification"], _count: true })`. */
export interface ClassificationGroup {
  entityId: string;
  classification: string | null;
  _count: number;
}

export function emptyClassificationCounts(): ClassificationCounts {
  return { NEVER_STORED: 0, PII: 0, SENSITIVE: 0, INTERNAL: 0, PUBLIC: 0 };
}

/**
 * Folds `field.groupBy` rows into per-entity classification counts, so a page
 * never has to load every field row just to tally classifications.
 *
 * A field without a classification counts as SENSITIVE (the product default);
 * a level outside the scale is counted under its own name. Pass `entityIds` to seed zeroed counts
 * for entities that have no field rows (and therefore no group).
 */
export function classificationCountsFromGroups(
  groups: readonly ClassificationGroup[],
  entityIds: readonly string[] = []
): Map<string, ClassificationCounts> {
  const byEntity = new Map<string, ClassificationCounts>();
  for (const id of entityIds) byEntity.set(id, emptyClassificationCounts());

  for (const group of groups) {
    let counts = byEntity.get(group.entityId);
    if (!counts) {
      counts = emptyClassificationCounts();
      byEntity.set(group.entityId, counts);
    }
    const classification = group.classification ?? "SENSITIVE";
    if (classification === "__proto__") continue;
    counts[classification] = (Object.prototype.hasOwnProperty.call(counts, classification) ? counts[classification] : 0) + group._count;
  }
  return byEntity;
}

/** The Badge variant of a level of the standard scale that has one; undefined for any other level (shown with the neutral style). */
export function standardClassificationVariant(level: string): "pii" | "sensitive" | "internal" | "public" | undefined {
  const lower = level.toLowerCase();
  return lower === "pii" || lower === "sensitive" || lower === "internal" || lower === "public" ? lower : undefined;
}

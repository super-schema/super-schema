/** The field classification scale, as shown on entity cards. */
export const CLASSIFICATIONS = ["NEVER_STORED", "PII", "SENSITIVE", "INTERNAL", "PUBLIC"] as const;

export type ClassificationCounts = Record<(typeof CLASSIFICATIONS)[number], number>;

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
 * values outside the scale are ignored. Pass `entityIds` to seed zeroed counts
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
    if (Object.prototype.hasOwnProperty.call(counts, classification)) {
      counts[classification as keyof ClassificationCounts] += group._count;
    }
  }
  return byEntity;
}

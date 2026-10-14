export interface ReferenceSourceField {
  id: string;
  decorators: unknown;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/**
 * Entity IDs this entity's draft references (spec §5.1 entity→entity pins):
 * `decorators.referencedEntityId` on any field (reference / array<reference> / map value),
 * plus `metadata.relationships[].targetEntityId` whose `fieldId` is still a field of the entity.
 * Self-references are excluded (an entity cannot pin a version of itself). Sorted for determinism.
 */
export function collectReferencedEntityIds(
  entityId: string,
  fields: ReferenceSourceField[],
  metadata: unknown
): string[] {
  const ids = new Set<string>();
  const fieldIds = new Set(fields.map((f) => f.id));

  for (const field of fields) {
    const target = asRecord(field.decorators).referencedEntityId;
    if (typeof target === "string" && target.trim()) ids.add(target.trim());
  }

  const relationships = asRecord(metadata).relationships;
  if (Array.isArray(relationships)) {
    for (const raw of relationships) {
      const rel = asRecord(raw);
      if (
        typeof rel.targetEntityId === "string" &&
        rel.targetEntityId.trim() &&
        typeof rel.fieldId === "string" &&
        fieldIds.has(rel.fieldId)
      ) {
        ids.add(rel.targetEntityId.trim());
      }
    }
  }

  ids.delete(entityId);
  return [...ids].sort();
}

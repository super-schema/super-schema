import { holdsEntityReference } from "@/lib/references/entity-reference";

/** An edge of the Lineage Graph: this entity points at `targetEntityId` with this cardinality (`one-to-many`, `many-to-one` ...). */
export interface LineageRelationship {
  targetEntityId: string;
  type: string;
}

interface Input {
  /** `metadata.relationships` of the entity: what the entity editor can store (and imports may). */
  metadataRelationships: ReadonlyArray<{ targetEntityId: string; cardinality: string }>;
  /** The entity's fields, with their decorators (where a reference field keeps the id of the entity it references). */
  fields: ReadonlyArray<{ type: string; decorators: unknown }>;
}

function referencedEntityId(decorators: unknown): string | undefined {
  if (!decorators || typeof decorators !== "object" || Array.isArray(decorators)) return undefined;
  const value = Object.prototype.hasOwnProperty.call(decorators, "referencedEntityId") ? (decorators as Record<string, unknown>).referencedEntityId : undefined;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * The relationships the Lineage Graph draws from an entity: the ones stored in its metadata, then one per reference field (a reference
 * is many-to-one, an array or map of references one-to-many). Each target once (the first one found names the cardinality: the metadata's before the fields'). A field that is no longer a reference
 * (`holdsEntityReference`) draws nothing whatever its decorators still say, and a reference with no entity id (a name only) has no node
 * to point at.
 */
export function entityRelationships({ metadataRelationships, fields }: Input): LineageRelationship[] {
  const out: LineageRelationship[] = [];
  const seen = new Set<string>();
  const add = (targetEntityId: string, type: string) => {
    // One edge per target: the graph names an edge `<source>-<target>`, so a second one to the same entity would collide with it.
    if (seen.has(targetEntityId)) return;
    seen.add(targetEntityId);
    out.push({ targetEntityId, type });
  };

  for (const relationship of metadataRelationships) add(relationship.targetEntityId, relationship.cardinality);
  for (const field of fields) {
    if (!holdsEntityReference(field.type, field.decorators)) continue;
    const target = referencedEntityId(field.decorators);
    if (target) add(target, field.type === "reference" ? "many-to-one" : "one-to-many");
  }
  return out;
}

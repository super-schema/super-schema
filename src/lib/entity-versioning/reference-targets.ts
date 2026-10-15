import { inSameLine } from "@/services/name-registry.service";
import { sanitizeIdentifier } from "@/lib/compiler/typespec-generator";

export interface ReferenceSourceField {
  id: string;
  decorators: unknown;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function nonBlank(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
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
    const target = nonBlank(asRecord(field.decorators).referencedEntityId);
    if (target) ids.add(target);
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

/**
 * Names of entities referenced only by name: `decorators.referencedEntityName` on fields that carry no
 * `referencedEntityId`. Every reference-creating path (type picker, entity wizard, importers, TypeSpec
 * source save) stores just the name, so these must be resolved to ids before they can be pinned.
 * Trimmed, deduped case-insensitively (first spelling wins), sorted.
 */
export function collectReferencedEntityNames(fields: ReferenceSourceField[]): string[] {
  const byKey = new Map<string, string>();
  for (const field of fields) {
    const decorators = asRecord(field.decorators);
    if (nonBlank(decorators.referencedEntityId)) continue;
    const name = nonBlank(decorators.referencedEntityName);
    if (name && !byKey.has(name.toLowerCase())) byKey.set(name.toLowerCase(), name);
  }
  return [...byKey.values()].sort();
}

export interface LinePlacement {
  tenantId: string;
  domainId: string | null;
  productId: string | null;
}

export interface NamedEntity extends LinePlacement {
  id: string;
  name: string;
}

/**
 * True when `candidate` sits in `owner`'s line as an ancestor or the same level: the tenant level,
 * the owner's domain level, or the owner's own product. `inSameLine` (the name registry's rule) also
 * admits descendants; those are excluded because sibling products may reuse a name.
 */
export function isInLineOf(owner: LinePlacement, candidate: LinePlacement): boolean {
  if (!inSameLine(owner, candidate)) return false;
  if (candidate.domainId && candidate.domainId !== owner.domainId) return false;
  if (candidate.productId && candidate.productId !== owner.productId) return false;
  return true;
}

const exactKey = (name: string) => name.trim().toLowerCase();
const identifierKey = (name: string) => sanitizeIdentifier(name.trim()).toLowerCase();

/**
 * Resolve by-name references against the entities in the owner's line (tenant ∪ its domain ∪ its
 * product; names are line-unique). Matching is case-insensitive, first on the name itself and then
 * on its TypeSpec identifier form (the TypeSpec source tab stores `Line_Item` for "Line Item").
 * A name that matches the owner itself is a self-reference and is dropped silently; a name with no
 * (or an ambiguous) match is returned in `unresolvedNames` — it cannot be pinned.
 */
export function resolveReferencedEntityNames(
  owner: NamedEntity,
  names: string[],
  candidates: NamedEntity[]
): { entityIds: string[]; unresolvedNames: string[] } {
  const inLine = candidates.filter((c) => isInLineOf(owner, c));
  const ids = new Set<string>();
  const unresolvedNames: string[] = [];

  for (const name of names) {
    const exact = inLine.filter((c) => exactKey(c.name) === exactKey(name));
    const matches = exact.length > 0 ? exact : inLine.filter((c) => identifierKey(c.name) === identifierKey(name));
    const isSelf =
      exactKey(owner.name) === exactKey(name) ||
      (matches.length === 0 && identifierKey(owner.name) === identifierKey(name)) ||
      (matches.length === 1 && matches[0].id === owner.id);
    if (isSelf) continue;
    if (matches.length === 1) ids.add(matches[0].id);
    else unresolvedNames.push(name);
  }

  return { entityIds: [...ids].sort(), unresolvedNames };
}

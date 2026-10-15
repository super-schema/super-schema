import type { PrismaClient, Prisma } from "@/generated/prisma/client";
import {
  collectReferencedEntityIds,
  collectReferencedEntityNames,
  resolveReferencedEntityNames,
  type NamedEntity,
  type ReferenceSourceField,
} from "./reference-targets";

type Db = PrismaClient | Prisma.TransactionClient;

/** Entities in `entity`'s line: tenant level, its domain level, and its own product. */
export async function loadLineEntities(db: Db, entity: NamedEntity): Promise<NamedEntity[]> {
  const levels: Prisma.EntityWhereInput[] = [{ domainId: null }];
  if (entity.domainId) levels.push({ domainId: entity.domainId, productId: null });
  if (entity.productId) levels.push({ productId: entity.productId });
  return db.entity.findMany({
    where: { tenantId: entity.tenantId, OR: levels },
    select: { id: true, name: true, tenantId: true, domainId: true, productId: true },
  });
}

export interface ResolvedEntityReferences {
  /** Referenced entity ids, sorted: ids stored on the fields / relationships plus the by-name references resolved in the line. */
  targetIds: string[];
  /** By-name references that match no (or more than one) entity in the line — they cannot be pinned. */
  unresolvedNames: string[];
}

/**
 * The entities an entity's draft references. References stored by name only (every creation path today) are
 * resolved against the entity's line. Shared by publish (which pins them) and the draft artifact renderer (which
 * renders against their latest published versions), so both agree on what a draft references.
 */
export async function resolveEntityReferences(
  db: Db,
  entity: NamedEntity & { metadata: unknown; fields: ReferenceSourceField[] }
): Promise<ResolvedEntityReferences> {
  const names = collectReferencedEntityNames(entity.fields);
  const byName =
    names.length > 0
      ? resolveReferencedEntityNames(entity, names, await loadLineEntities(db, entity))
      : { entityIds: [], unresolvedNames: [] };
  const targetIds = [
    ...new Set([...collectReferencedEntityIds(entity.id, entity.fields, entity.metadata), ...byName.entityIds]),
  ].sort();
  return { targetIds, unresolvedNames: byName.unresolvedNames };
}

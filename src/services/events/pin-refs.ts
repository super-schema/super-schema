// src/services/events/pin-refs.ts
// The entity pins of an event document, checked against the database. The save and the preview of an unsaved document apply the same rule to
// each pin (an entity of the event's tenant, and a version of that entity when pinned), so they cannot disagree about which pin names an entity
// at all. A preview also applies the caller's read scope; the save does not yet (KD-044).
import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { entityPlaceOf, type PlaceReader } from "@/lib/access/entity-reader";
import { collectDocumentRefs, collectPinSites } from "@/lib/events/document/edges";
import type { DocumentProblem, EventDocument } from "@/lib/events/document/types";

type Db = PrismaClient | Prisma.TransactionClient;

const ENTITY_PLACE = {
  id: true, name: true, tenantId: true, domainId: true, productId: true, product: { select: { domainId: true } },
} satisfies Prisma.EntitySelect;

/**
 * The entity pins of `doc`, in `tenantId` only. An entity must exist in the tenant; a pinned version must be a version of that entity. `canRead`
 * (a preview: `entityReader` over the caller's roles) also makes an entity the caller may not read unknown. Every such refusal carries the
 * message of a missing entity, or of a version that is not the entity's, so a foreign or unreadable id reveals nothing about what it names.
 * Two batched reads however large the document is.
 */
export async function validatePinRefs(
  db: Db,
  tenantId: string,
  doc: EventDocument,
  canRead?: PlaceReader
): Promise<DocumentProblem[]> {
  const refs = collectDocumentRefs(doc);
  const [entities, versions] = await Promise.all([
    refs.entityIds.length === 0 ? [] : db.entity.findMany({ where: { id: { in: refs.entityIds }, tenantId }, select: ENTITY_PLACE }),
    refs.pinnedVersionIds.length === 0
      ? []
      : db.entityVersion.findMany({ where: { id: { in: refs.pinnedVersionIds }, entity: { tenantId } }, select: { id: true, entityId: true } }),
  ]);
  const entityById = new Map(entities.map((e) => [e.id, e]));
  const versionById = new Map(versions.map((v) => [v.id, v]));

  const problems: DocumentProblem[] = [];
  for (const { pointer, pin } of collectPinSites(doc)) {
    const entity = entityById.get(pin.entityId);
    if (!entity || (canRead !== undefined && !canRead(entityPlaceOf(entity)))) {
      problems.push({ pointer: `${pointer}/entityId`, message: `Entity "${pin.entityId}" not found in this tenant` });
      continue;
    }
    if (pin.entityVersionId === null) continue;
    const version = versionById.get(pin.entityVersionId);
    if (!version || version.entityId !== entity.id) {
      problems.push({ pointer: `${pointer}/entityVersionId`, message: `"${pin.entityVersionId}" is not a published version of ${entity.name}` });
    }
  }
  return problems;
}

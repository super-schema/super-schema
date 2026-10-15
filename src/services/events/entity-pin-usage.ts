// src/services/events/entity-pin-usage.ts
import type { PrismaClient, Prisma } from "@/generated/prisma/client";
import { dbErrorResult } from "@/lib/db-error";
import { formatVersionLabel } from "@/lib/entity-versioning/version-math";
import { isConcurrentWriteFailure } from "@/services/events/publish-concurrency";
import { GENERIC_ACTION_ERROR } from "@/types/action-result";
import type { ServiceError } from "@/types/result";

type Db = PrismaClient | Prisma.TransactionClient;

export interface NamedRef {
  id: string;
  name: string;
}

/** An entity whose PUBLISHED versions pin a version of the entity being deleted (ENTITY_VERSION -> ENTITY_VERSION `FIELD` edges). */
export interface EntityReferrer extends NamedRef {
  /** Labels ("1.0") of the referencing published versions, oldest first. */
  versions: string[];
}

export interface EntityPinUsage {
  messages: NamedRef[];
  traits: NamedRef[];
  /** Other entities of the same tenant that reference one of this entity's versions. Self references are not listed. */
  entities: EntityReferrer[];
}

/** The entity being deleted: `tenantId` bounds every lookup so other tenants' records are never read or named. */
export interface DeletableEntity {
  id: string;
  name: string;
  tenantId: string;
}

const MAX_NAMED = 5;
const MAX_NAMED_VERSIONS = 3;
/** Upper bound on the edge rows read: any hit blocks the delete, only the first few are ever named. */
const MAX_EDGE_SCAN = 500;

/** Prisma maps a Postgres foreign-key violation (SQLSTATE 23503) to P2003. */
export function isForeignKeyViolation(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { code?: unknown }).code === "P2003";
}

/**
 * Other entities of the entity's tenant that reference one of its versions. `ENTITY_VERSION -> ENTITY_VERSION` edges
 * (`schema_references`, role FIELD, written when the referencing version is published) are polymorphic and have NO foreign
 * key, so nothing in the database stops the delete: the guard has to. A published version is immutable, so such an edge
 * would dangle for good (spec §6.1: a version referenced by any published version cannot be deleted).
 *
 * Referencing versions of the SAME entity (a recursive entity) do not count: they go away with it. Sources are matched
 * through their entity's `tenantId`, so a stray cross-tenant edge neither blocks nor is named.
 */
async function findEntityReferrers(db: Db, entity: { id: string; tenantId: string }): Promise<EntityReferrer[]> {
  const versions = await db.entityVersion.findMany({ where: { entityId: entity.id }, select: { id: true } });
  if (versions.length === 0) return [];
  const edges = await db.schemaReference.findMany({
    where: { fromKind: "ENTITY_VERSION", toKind: "ENTITY_VERSION", toId: { in: versions.map((v) => v.id) }, isDraft: false },
    select: { fromId: true },
    distinct: ["fromId"],
    take: MAX_EDGE_SCAN,
  });
  if (edges.length === 0) return [];
  const sources = await db.entityVersion.findMany({
    where: { id: { in: edges.map((e) => e.fromId) }, entity: { tenantId: entity.tenantId, id: { not: entity.id } } },
    select: { major: true, minor: true, entity: { select: { id: true, name: true } } },
    orderBy: [{ entity: { name: "asc" } }, { entityId: "asc" }, { sequence: "asc" }],
  });
  const byEntity = new Map<string, EntityReferrer>();
  for (const v of sources) {
    const entry = byEntity.get(v.entity.id) ?? { id: v.entity.id, name: v.entity.name, versions: [] };
    entry.versions.push(formatVersionLabel(v));
    byEntity.set(v.entity.id, entry);
  }
  return [...byEntity.values()];
}

/**
 * What keeps an entity alive:
 * - messages and traits whose pins hold it (D3: pin FKs are NO ACTION): the entity or one of its versions is the current
 *   payload / headers / key pin, or a published message version pins one of its versions;
 * - other entities whose published versions reference one of its versions (no FK: only this guard stops the delete).
 * Everything is read through `entity.tenantId`.
 */
export async function findEntityPinUsage(db: Db, entity: { id: string; tenantId: string }): Promise<EntityPinUsage> {
  const entityId = entity.id;
  const ofEntity = { entityId };
  const [messages, traits, entities] = await Promise.all([
    db.message.findMany({
      where: {
        tenantId: entity.tenantId,
        OR: [
          { payloadEntityId: entityId },
          { headersEntityId: entityId },
          { keyEntityId: entityId },
          { payloadEntityVersion: ofEntity },
          { headersEntityVersion: ofEntity },
          { keyEntityVersion: ofEntity },
          {
            versions: {
              some: {
                OR: [{ payloadEntityVersion: ofEntity }, { headersEntityVersion: ofEntity }, { keyEntityVersion: ofEntity }],
              },
            },
          },
        ],
      },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
    db.trait.findMany({
      where: { tenantId: entity.tenantId, OR: [{ headersEntityId: entityId }, { headersEntityVersion: ofEntity }] },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
    findEntityReferrers(db, entity),
  ]);
  return { messages, traits, entities };
}

function nameList(label: string, refs: NamedRef[]): string {
  const shown = refs.slice(0, MAX_NAMED).map((r) => `"${r.name}"`);
  const more = refs.length - shown.length;
  const names = more > 0 ? `${shown.join(", ")} and ${more} more` : shown.join(", ");
  return `${label}${refs.length === 1 ? "" : "s"} ${names}`;
}

function versionList(versions: string[]): string {
  const shown = versions.slice(0, MAX_NAMED_VERSIONS).map((v) => `v${v}`);
  const more = versions.length - shown.length;
  return more > 0 ? `${shown.join(", ")} and ${more} more` : shown.join(", ");
}

/** `Entity "Order" (v1.0, v2.0)` / `Entities "Order" (v1.0), "Cart" (v2.0) and 3 more`. */
function referrerList(refs: EntityReferrer[]): string {
  const shown = refs.slice(0, MAX_NAMED).map((r) => `"${r.name}" (${versionList(r.versions)})`);
  const more = refs.length - shown.length;
  return `${refs.length === 1 ? "Entity" : "Entities"} ${shown.join(", ")}${more > 0 ? ` and ${more} more` : ""}`;
}

function suggestedFixFor(usage: EntityPinUsage): string {
  if (usage.entities.length === 0) return "Re-pin or delete those messages and traits first, then delete the entity.";
  const shown = usage.entities.slice(0, 3).map((r) => `"${r.name}"`);
  const more = usage.entities.length - shown.length;
  const referrers = `${shown.join(", ")}${more > 0 ? ` and ${more} more` : ""}`;
  const holders = usage.messages.length > 0 || usage.traits.length > 0 ? ", re-pin or delete the messages and traits that use it," : "";
  return `Published versions cannot be changed: delete the referencing entities first (${referrers}; deleting an entity removes its versions)${holders} then delete this entity. Or keep it.`;
}

/** IN_USE error naming what holds the entity (messages / traits by name, referencing entities by name + version), or null when nothing does. */
export function entityInUseError(entityName: string, usage: EntityPinUsage): ServiceError | null {
  const used: string[] = [];
  if (usage.messages.length > 0) used.push(nameList("Message", usage.messages));
  if (usage.traits.length > 0) used.push(nameList("Trait", usage.traits));
  const clauses: string[] = [];
  if (used.length > 0) clauses.push(`used by ${used.join(" and ")}`);
  if (usage.entities.length > 0) clauses.push(`referenced by published versions of ${referrerList(usage.entities)}`);
  if (clauses.length === 0) return null;
  return {
    code: "IN_USE",
    message: `Entity "${entityName}" cannot be deleted: it is ${clauses.join(" and ")}.`,
    details: usage,
    suggestedFix: suggestedFixFor(usage),
  };
}

/**
 * The IN_USE error when anything pins or references the entity, null otherwise. Run it BEFORE the delete (entity-version
 * references have no FK, so the database would let the delete through) and again after a P2003 (a pin that landed meanwhile).
 */
export async function explainEntityDeleteFailure(db: Db, entity: DeletableEntity): Promise<ServiceError | null> {
  return entityInUseError(entity.name, await findEntityPinUsage(db, entity));
}

/** The retryable "something changed under the delete" failure (lock timeout, deadlock, serialization failure, ...). */
export const entityDeleteConflict = (): ServiceError => ({
  code: "CONFLICT",
  message: "Entity changed concurrently, try again",
  suggestedFix: "Reload and try deleting again.",
});

/**
 * A throw out of the entity delete, as a failure that never carries driver text:
 * - P2003 (a message / trait pin, NO ACTION FK) -> IN_USE naming what holds it, or a generic IN_USE when nothing explains it
 *   (or when the entity row itself is unknown, i.e. only an id is at hand);
 * - lock timeout / deadlock / serialization failure / interactive-transaction expiry (`isConcurrentWriteFailure`) -> retryable CONFLICT;
 * - anything else -> DB_ERROR with the generic message (the original is logged by `dbErrorResult`).
 */
export async function entityDeleteFailure(db: Db, entity: DeletableEntity | { id: string }, e: unknown): Promise<ServiceError> {
  if (isForeignKeyViolation(e)) {
    if ("name" in entity) {
      try {
        const inUse = await explainEntityDeleteFailure(db, entity);
        if (inUse) return inUse;
      } catch (explainError: unknown) {
        return opaque(`deleteEntity ${entity.id} explain`, explainError);
      }
    }
    return {
      code: "IN_USE",
      message: "This entity is referenced by another record and cannot be deleted.",
      suggestedFix: "Remove the references first.",
    };
  }
  if (isConcurrentWriteFailure(e)) return entityDeleteConflict();
  return opaque(`deleteEntity ${entity.id}`, e);
}

/** DB_ERROR with only the generic message; the cause is logged server-side. */
function opaque(context: string, cause: unknown): ServiceError {
  const failed = dbErrorResult(context, cause);
  return failed.success ? { code: "DB_ERROR", message: GENERIC_ACTION_ERROR } : failed.error;
}

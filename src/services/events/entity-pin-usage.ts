// src/services/events/entity-pin-usage.ts
import type { PrismaClient, Prisma } from "@/generated/prisma/client";
import type { ServiceError } from "@/types/result";

type Db = PrismaClient | Prisma.TransactionClient;

export interface NamedRef {
  id: string;
  name: string;
}

export interface EntityPinUsage {
  messages: NamedRef[];
  traits: NamedRef[];
}

const MAX_NAMED = 5;

/** Prisma maps a Postgres foreign-key violation (SQLSTATE 23503) to P2003. */
export function isForeignKeyViolation(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { code?: unknown }).code === "P2003";
}

/**
 * Messages and traits whose pins keep an entity alive (D3: pin FKs are NO ACTION): the entity or one of its
 * versions is the current payload / headers / key pin, or a published message version pins one of its versions.
 */
export async function findEntityPinUsage(db: Db, entityId: string): Promise<EntityPinUsage> {
  const ofEntity = { entityId };
  const [messages, traits] = await Promise.all([
    db.message.findMany({
      where: {
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
      where: { OR: [{ headersEntityId: entityId }, { headersEntityVersion: ofEntity }] },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
  ]);
  return { messages, traits };
}

function nameList(label: string, refs: NamedRef[]): string {
  const shown = refs.slice(0, MAX_NAMED).map((r) => `"${r.name}"`);
  const more = refs.length - shown.length;
  const names = more > 0 ? `${shown.join(", ")} and ${more} more` : shown.join(", ");
  return `${label}${refs.length === 1 ? "" : "s"} ${names}`;
}

/** IN_USE error naming the pinning messages / traits, or null when nothing pins the entity. */
export function entityInUseError(entityName: string, usage: EntityPinUsage): ServiceError | null {
  const parts: string[] = [];
  if (usage.messages.length > 0) parts.push(nameList("Message", usage.messages));
  if (usage.traits.length > 0) parts.push(nameList("Trait", usage.traits));
  if (parts.length === 0) return null;
  return {
    code: "IN_USE",
    message: `Entity "${entityName}" cannot be deleted: it is used by ${parts.join(" and ")}.`,
    details: usage,
    suggestedFix: "Re-pin or delete those messages and traits first, then delete the entity.",
  };
}

/** After a P2003 on `entity.delete`: the IN_USE error when pins explain it, null when the cause is something else. */
export async function explainEntityDeleteFailure(db: Db, entity: { id: string; name: string }): Promise<ServiceError | null> {
  return entityInUseError(entity.name, await findEntityPinUsage(db, entity.id));
}

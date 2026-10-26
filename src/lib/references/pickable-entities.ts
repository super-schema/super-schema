import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { TENANT_PLACEHOLDER, type PickableEntity } from "./entity-reference";

type DbClient = PrismaClient | Prisma.TransactionClient;

/**
 * More entities than this are not offered: the picker is a list, and a tenant past this needs a search that asks the server. The cut is
 * by name, so it is stable.
 */
export const MAX_PICKABLE_ENTITIES = 2000;

/**
 * The entities of ONE tenant a reference field can be pointed at, with the domain and product names that make their qualified name
 * (`domain / product / entity`; `_tenant` stands in for a missing one). Reads names and ids only, never fields or schema versions, and only
 * inside `tenantId`: the caller derives it from the server context (never from the client), so another tenant's entity is never offered.
 *
 * `readable` restricts the list to the entities the CALLER may read (`readableWhere(assignments, "entity.read", tenantId)`: nothing added for a tenant or
 * platform role, the rows under the caller's domains and products otherwise), so a role scoped to one domain is not offered another domain's entity names.
 * Left out, every entity of the tenant is offered (a caller that has already decided).
 *
 * Fail-soft: a failed lookup is logged and reads as no entities, so the page still renders and the picker still takes a typed name.
 */
export async function loadPickableEntities(db: Pick<DbClient, "entity">, tenantId: string, readable: Prisma.EntityWhereInput = {}): Promise<PickableEntity[]> {
  if (typeof tenantId !== "string" || tenantId.length === 0) return [];
  try {
    const rows = await db.entity.findMany({
      where: { ...readable, tenantId },
      orderBy: [{ name: "asc" }, { id: "asc" }],
      select: { id: true, name: true, domain: { select: { name: true } }, product: { select: { name: true } } },
      take: MAX_PICKABLE_ENTITIES,
    });
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      domain: row.domain?.name ?? TENANT_PLACEHOLDER,
      product: row.product?.name ?? TENANT_PLACEHOLDER,
    }));
  } catch (e: unknown) {
    console.error("[loadPickableEntities] the entity list for the reference picker could not be loaded", e);
    return [];
  }
}

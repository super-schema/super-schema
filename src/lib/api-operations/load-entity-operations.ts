/**
 * Reads an entity's API operations from the database in the contract shape: the operations of every ENTITY-scoped service of the
 * entity (`ServiceDefinition.scope = ENTITY`, `entityId`), each service's `basePath` applied, services and operations in creation order.
 *
 * Every column of the rows is read (no `select`) and handed to the adapter (`readApiOperations`), so this works on the schema before the
 * Phase A migration (legacy `location: "body"` parameters, no operationId / tags / requestBody columns) and after it alike.
 */

import type { ApiOperation } from "@/types/schemas/api-operation";
import { readApiOperations, type ApiOperationRowLike } from "./to-typespec";

/** The one Prisma delegate this needs (a `PrismaClient` or a transaction client is one). */
export interface ApiOperationsDb {
  serviceDefinition: {
    findMany(args: {
      where: { entityId: string; scope: "ENTITY" };
      orderBy: { createdAt: "asc" };
      include: { operations: { orderBy: { createdAt: "asc" }; include: { parameters: true; responses: true } } };
    }): Promise<Array<{ basePath: string; operations: ReadonlyArray<unknown> }>>;
  };
}

/**
 * The entity's API operations (see the module comment). A row that is not a valid operation is left out (see `readApiOperations`):
 * generation must not fail on one malformed legacy row. An empty list when the entity has none, or when `db` has no
 * `serviceDefinition` delegate (a partial test double).
 */
export async function loadEntityApiOperations(db: unknown, entityId: string): Promise<ApiOperation[]> {
  const delegate = (db as Partial<ApiOperationsDb> | null | undefined)?.serviceDefinition;
  if (!delegate || typeof delegate.findMany !== "function") return [];
  const services = await delegate.findMany({
    where: { entityId, scope: "ENTITY" },
    orderBy: { createdAt: "asc" },
    include: { operations: { orderBy: { createdAt: "asc" }, include: { parameters: true, responses: true } } },
  });
  if (!Array.isArray(services)) return [];
  return services.flatMap((service) =>
    readApiOperations(service.operations as ReadonlyArray<ApiOperationRowLike>, { basePath: service.basePath }).operations
  );
}

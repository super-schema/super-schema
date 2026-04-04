/**
 * Emission service — orchestrates the full emission pipeline.
 *
 * Takes an entity ID, loads entity + fields from Prisma,
 * then delegates to emitFromData() for the pure pipeline.
 */

import { prisma } from "@/lib/db";
import type { PrismaEntityInput, PrismaFieldInput } from "@/lib/compiler/compiler.service";
import type { EmissionResult } from "./emission.types";
import { emitFromData } from "./emit-from-data";
import { getOverridesForEntity } from "@/services/type-mapping.service";
import type { ServiceContext } from "@/types/service-context";

// Re-export the pure function for convenience
export { emitFromData } from "./emit-from-data";

// ---------------------------------------------------------------------------
// Public API — DB-backed emission
// ---------------------------------------------------------------------------

/**
 * Run the full emission pipeline for an entity.
 *
 * 1. Load entity + fields from DB
 * 2. Delegate to emitFromData() for compilation + emission
 */
export async function emitEntity(entityId: string): Promise<EmissionResult> {
  // 1. Load entity + fields
  const entity = await prisma.entity.findUnique({
    where: { id: entityId },
    include: { domain: true },
  });

  if (!entity) {
    throw new Error(`Entity not found: ${entityId}`);
  }

  const fields = await prisma.field.findMany({
    where: { entityId },
    orderBy: { sortOrder: "asc" },
  });

  // 2. Map to input shapes
  const prismaEntity: PrismaEntityInput = {
    id: entity.id,
    name: entity.name,
    description: entity.description,
    status: entity.status,
    version: entity.version,
    domainId: entity.domainId,
    metadata: entity.metadata,
    domain: entity.domain
      ? { id: entity.domain.id, name: entity.domain.name, slug: entity.domain.slug }
      : null,
  };

  const prismaFields: PrismaFieldInput[] = fields.map((f) => ({
    id: f.id,
    name: f.name,
    type: f.type,
    precision: f.precision,
    scale: f.scale,
    nullable: f.nullable,
    isKey: f.isKey,
    fieldNumber: f.fieldNumber,
    description: f.description,
    classification: f.classification,
    aliases: f.aliases,
    decorators: f.decorators,
    sortOrder: f.sortOrder,
  }));

  // Load any overrides for this entity
  const serviceCtx: ServiceContext = {
    userId: "system",
    userRole: "ADMIN",
    prisma,
  };
  const overridesResult = await getOverridesForEntity(entityId, serviceCtx);
  const overridePolicies = overridesResult.success ? overridesResult.data : [];

  return emitFromData(prismaEntity, prismaFields, overridePolicies);
}

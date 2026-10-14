import type { PrismaClient, Prisma } from "@/generated/prisma/client";
import { compileEntity } from "@/lib/compiler/compiler.service";
import type { SuperSchemaModel } from "@/types/super-schema-model";
import { ok, err, type Result } from "@/types/result";

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * Load an entity and its field rows and build the emitter-facing
 * SuperSchemaModel. Shared by the TypeSpec Source tab's lazy generation and
 * the one-time batch migration so both produce identical source.
 */
export async function loadEntityModel(db: Db, entityId: string): Promise<Result<SuperSchemaModel>> {
  const entity = await db.entity.findUnique({ where: { id: entityId }, include: { domain: true } });
  if (!entity) {
    return err({ code: "NOT_FOUND", message: `Entity "${entityId}" not found` });
  }
  const fields = await db.field.findMany({ where: { entityId }, orderBy: { sortOrder: "asc" } });

  return ok(
    compileEntity(
      {
        id: entity.id,
        name: entity.name,
        description: entity.description,
        status: entity.status,
        version: entity.version,
        domainId: entity.domainId,
        metadata: entity.metadata,
        domain: entity.domain
          ? { id: entity.domain.id, name: entity.domain.name, slug: entity.domain.name.toLowerCase().replace(/\s+/g, "-") }
          : null,
      },
      fields.map((f) => ({
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
      }))
    )
  );
}

import type { PrismaClient, Prisma } from "@/generated/prisma/client";
import { generateTypeSpec } from "@/lib/compiler/typespec-generator";
import { compileTypeSpecWithGovernance, type GovernanceDiagnostic } from "@/lib/compiler/typespec-compiler";
import { loadEntityModel } from "@/lib/compiler/entity-model-loader";
import type { SuperSchemaModel } from "@/types/super-schema-model";
import { ok, err, type Result } from "@/types/result";

type Db = PrismaClient | Prisma.TransactionClient;

export type EntityMigrationOutcome = {
  entityId: string;
  status: "SKIPPED" | "MIGRATED" | "FLAGGED";
  diagnostics?: GovernanceDiagnostic[];
};
export type MigrationSummary = { migrated: number; skipped: number; flagged: number; outcomes: EntityMigrationOutcome[] };
export type MigrationDeps = {
  generate: (model: SuperSchemaModel) => string;
  compile: typeof compileTypeSpecWithGovernance;
};

const defaultDeps: MigrationDeps = { generate: generateTypeSpec, compile: compileTypeSpecWithGovernance };

/**
 * Story 12.7: give one entity its canonical typespecSource. Idempotent — an
 * entity that already has source is skipped. Generated source must compile
 * clean under the real compiler before it is written; otherwise the entity is
 * flagged in metadata.typespecMigration and left on the old path.
 */
export async function migrateEntityTypeSpecSource(
  db: Db,
  entityId: string,
  deps: MigrationDeps = defaultDeps
): Promise<Result<EntityMigrationOutcome>> {
  const entity = await db.entity.findUnique({ where: { id: entityId } });
  if (!entity) return err({ code: "NOT_FOUND", message: `Entity "${entityId}" not found` });
  if (entity.typespecSource) return ok({ entityId, status: "SKIPPED" });

  const model = await loadEntityModel(db, entityId);
  if (!model.success) return model;

  const source = deps.generate(model.data);
  const compiled = await deps.compile(source);
  const metadata = (entity.metadata as Record<string, unknown> | null) ?? {};

  if (!compiled.success) {
    await db.entity.update({
      where: { id: entityId },
      data: {
        metadata: {
          ...metadata,
          typespecMigration: { status: "FLAGGED", at: new Date().toISOString(), diagnostics: compiled.diagnostics },
        } as unknown as Prisma.InputJsonValue,
      },
    });
    return ok({ entityId, status: "FLAGGED", diagnostics: compiled.diagnostics });
  }

  const rest = { ...metadata };
  delete rest.typespecMigration;
  await db.entity.update({
    where: { id: entityId },
    data: { typespecSource: source, metadata: rest as Prisma.InputJsonValue },
  });
  return ok({ entityId, status: "MIGRATED" });
}

export async function runTypeSpecSourceMigration(
  db: Db,
  deps: MigrationDeps = defaultDeps
): Promise<Result<MigrationSummary>> {
  const ids = await db.entity.findMany({ select: { id: true }, orderBy: { createdAt: "asc" } });
  const summary: MigrationSummary = { migrated: 0, skipped: 0, flagged: 0, outcomes: [] };
  for (const { id } of ids) {
    const res = await migrateEntityTypeSpecSource(db, id, deps);
    if (!res.success) return res;
    summary.outcomes.push(res.data);
    if (res.data.status === "MIGRATED") summary.migrated++;
    else if (res.data.status === "SKIPPED") summary.skipped++;
    else summary.flagged++;
  }
  return ok(summary);
}

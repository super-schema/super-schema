import type { PrismaClient, Prisma } from "@/generated/prisma/client";
import { generateTypeSpec } from "@/lib/compiler/typespec-generator";
import { compileTypeSpecWithGovernance, type GovernanceDiagnostic } from "@/lib/compiler/typespec-compiler";
import { loadEntityModel } from "@/lib/compiler/entity-model-loader";
import type { SuperSchemaModel } from "@/types/super-schema-model";
import { ok, err, type Result } from "@/types/result";
import { FLAGGED_WRITE_SQL, MIGRATED_WRITE_SQL } from "@/lib/entity-versioning/draft-state";

type Db = PrismaClient | Prisma.TransactionClient;

export type EntityMigrationOutcome = {
  entityId: string;
  status: "SKIPPED" | "MIGRATED" | "FLAGGED" | "ERROR";
  diagnostics?: GovernanceDiagnostic[];
  /** Set when status is "ERROR". */
  error?: string;
};
export type MigrationSummary = {
  migrated: number;
  skipped: number;
  flagged: number;
  errored: number;
  outcomes: EntityMigrationOutcome[];
};
export type MigrationDeps = {
  generate: (model: SuperSchemaModel) => string;
  compile: typeof compileTypeSpecWithGovernance;
};

const defaultDeps: MigrationDeps = { generate: generateTypeSpec, compile: compileTypeSpecWithGovernance };

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Story 12.7: give one entity its canonical typespecSource. Idempotent — an
 * entity that already has source is skipped. Generated source must compile
 * clean under the real compiler before it is written; otherwise the entity is
 * flagged in metadata.typespecMigration and left on the old path.
 *
 * Writes are guarded on `typespecSource IS NULL`, so source saved by a user
 * between our read and our write is never overwritten (outcome: SKIPPED). Each
 * write touches only its own key in one statement, so a metadata write that
 * lands during the compile is never reverted by this one.
 * An unexpected throw (compiler, DB) is returned as an ERROR outcome — it
 * never crosses the service boundary.
 */
export async function migrateEntityTypeSpecSource(
  db: Db,
  entityId: string,
  deps: MigrationDeps = defaultDeps
): Promise<Result<EntityMigrationOutcome>> {
  try {
    const entity = await db.entity.findUnique({ where: { id: entityId } });
    if (!entity) return err({ code: "NOT_FOUND", message: `Entity "${entityId}" not found` });
    if (entity.typespecSource) return ok({ entityId, status: "SKIPPED" });

    const model = await loadEntityModel(db, entityId);
    if (!model.success) return model;

    const source = deps.generate(model.data);
    const compiled = await deps.compile(source);

    if (!compiled.success) {
      const marker = { status: "FLAGGED", at: new Date().toISOString(), diagnostics: compiled.diagnostics };
      const count = await db.$executeRawUnsafe(FLAGGED_WRITE_SQL, entityId, JSON.stringify(marker));
      if (count === 0) return ok({ entityId, status: "SKIPPED" });
      return ok({ entityId, status: "FLAGGED", diagnostics: compiled.diagnostics });
    }

    const count = await db.$executeRawUnsafe(MIGRATED_WRITE_SQL, entityId, source);
    if (count === 0) return ok({ entityId, status: "SKIPPED" });
    return ok({ entityId, status: "MIGRATED" });
  } catch (e) {
    return ok({ entityId, status: "ERROR", error: messageOf(e) });
  }
}

/**
 * Migrate every entity. Never aborts the batch on a per-entity problem: a
 * failed result or unexpected throw becomes an ERROR outcome and the loop
 * continues. Only failing to list the entities at all is a failed Result.
 */
export async function runTypeSpecSourceMigration(
  db: Db,
  deps: MigrationDeps = defaultDeps
): Promise<Result<MigrationSummary>> {
  let ids: Array<{ id: string }>;
  try {
    ids = await db.entity.findMany({ select: { id: true }, orderBy: { createdAt: "asc" } });
  } catch (e) {
    return err({ code: "DB_ERROR", message: `Failed to list entities: ${messageOf(e)}` });
  }

  const summary: MigrationSummary = { migrated: 0, skipped: 0, flagged: 0, errored: 0, outcomes: [] };
  for (const { id } of ids) {
    const res = await migrateEntityTypeSpecSource(db, id, deps);
    const outcome: EntityMigrationOutcome = res.success
      ? res.data
      : { entityId: id, status: "ERROR", error: `${res.error.code}: ${res.error.message}` };
    summary.outcomes.push(outcome);
    if (outcome.status === "MIGRATED") summary.migrated++;
    else if (outcome.status === "SKIPPED") summary.skipped++;
    else if (outcome.status === "FLAGGED") summary.flagged++;
    else summary.errored++;
  }
  return ok(summary);
}

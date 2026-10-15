import type { PrismaClient, Prisma } from "@/generated/prisma/client";
import { loadEntityModel } from "@/lib/compiler/entity-model-loader";
import { generateTypeSpec } from "@/lib/compiler/typespec-generator";
import { isSourceStale, MARK_SOURCE_STALE_IF_UNCHANGED_SQL } from "@/lib/entity-versioning/draft-state";
import {
  compareSourceProjection,
  projectRowFields,
  projectSourceFields,
} from "@/lib/entity-versioning/source-projection";
import type { SuperSchemaModel } from "@/types/super-schema-model";
import { ok, err, type Result } from "@/types/result";

type Db = PrismaClient | Prisma.TransactionClient;

export type StaleFlagStatus = "CONSISTENT" | "WOULD_FLAG" | "FLAGGED" | "ALREADY_STALE" | "CHANGED" | "ERROR";

export interface StaleFlagOutcome {
  entityId: string;
  entityName: string;
  status: StaleFlagStatus;
  /** Why the stored source disagrees with the field rows (WOULD_FLAG / FLAGGED / CHANGED). */
  reasons?: string[];
  error?: string;
}

export interface StaleFlagSummary {
  checked: number;
  consistent: number;
  /** FLAGGED, or WOULD_FLAG on a dry run. */
  flagged: number;
  alreadyStale: number;
  /** Differed, but the source changed (or was marked) between read and write: left alone. */
  changed: number;
  errored: number;
  outcomes: StaleFlagOutcome[];
}

export interface StaleFlagDeps {
  loadModel: (db: Db, entityId: string) => Promise<Result<SuperSchemaModel>>;
  generate: (model: SuperSchemaModel) => string;
}

const defaultDeps: StaleFlagDeps = { loadModel: loadEntityModel, generate: generateTypeSpec };

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

type Candidate = {
  id: string;
  name: string;
  typespecSource: string | null;
  metadata: unknown;
  fields: Array<{ name: string; type: string; decorators: unknown }>;
};

async function checkEntity(db: Db, entity: Candidate, dryRun: boolean, deps: StaleFlagDeps): Promise<StaleFlagOutcome> {
  const base = { entityId: entity.id, entityName: entity.name };
  const source = entity.typespecSource;
  if (source === null) return { ...base, status: "CONSISTENT" };
  if (isSourceStale(entity.metadata)) return { ...base, status: "ALREADY_STALE" };

  const model = await deps.loadModel(db, entity.id);
  if (!model.success) return { ...base, status: "ERROR", error: `${model.error.code}: ${model.error.message}` };

  const { differs, reasons } = compareSourceProjection(
    projectSourceFields(source, entity.name),
    projectRowFields(entity.fields),
    projectSourceFields(deps.generate(model.data), entity.name)
  );
  if (!differs) return { ...base, status: "CONSISTENT" };
  if (dryRun) return { ...base, status: "WOULD_FLAG", reasons };

  const count = await db.$executeRawUnsafe(MARK_SOURCE_STALE_IF_UNCHANGED_SQL, entity.id, source);
  return { ...base, status: count > 0 ? "FLAGGED" : "CHANGED", reasons };
}

/**
 * One-time backfill for entities whose stored `typespecSource` predates the `sourceStale` marker (R42):
 * for every entity with source and no marker, compare the source's field projection (names + logical
 * types) with the field rows and set `metadata.sourceStale = true` only where they differ, so publish
 * regenerates exactly those sources and no others. Idempotent; `dryRun` reports without writing.
 * A per-entity failure is an ERROR outcome; only failing to list the entities is a failed Result.
 */
export async function flagStaleTypeSpecSources(
  db: Db,
  opts: { dryRun: boolean; entityIds?: string[] },
  deps: StaleFlagDeps = defaultDeps
): Promise<Result<StaleFlagSummary>> {
  let entities: Candidate[];
  try {
    entities = await db.entity.findMany({
      where: { typespecSource: { not: null }, ...(opts.entityIds && { id: { in: opts.entityIds } }) },
      select: {
        id: true,
        name: true,
        typespecSource: true,
        metadata: true,
        fields: { orderBy: { sortOrder: "asc" }, select: { name: true, type: true, decorators: true } },
      },
      orderBy: { createdAt: "asc" },
    });
  } catch (e) {
    return err({ code: "DB_ERROR", message: `Failed to list entities: ${messageOf(e)}` });
  }

  const summary: StaleFlagSummary = {
    checked: 0, consistent: 0, flagged: 0, alreadyStale: 0, changed: 0, errored: 0, outcomes: [],
  };
  for (const entity of entities) {
    let outcome: StaleFlagOutcome;
    try {
      outcome = await checkEntity(db, entity, opts.dryRun, deps);
    } catch (e) {
      outcome = { entityId: entity.id, entityName: entity.name, status: "ERROR", error: messageOf(e) };
    }
    summary.checked++;
    summary.outcomes.push(outcome);
    if (outcome.status === "CONSISTENT") summary.consistent++;
    else if (outcome.status === "WOULD_FLAG" || outcome.status === "FLAGGED") summary.flagged++;
    else if (outcome.status === "ALREADY_STALE") summary.alreadyStale++;
    else if (outcome.status === "CHANGED") summary.changed++;
    else summary.errored++;
  }
  return ok(summary);
}

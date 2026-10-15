/**
 * Entity versioning — Draft + Publish (spec §5, Phase 2a "slim").
 *
 * The Entity row + its fields are the draft. publishEntity freezes the draft
 * into an immutable EntityVersion (MAJOR.MINOR), pins every referenced
 * entity's latest published version in SchemaReference (role FIELD), and
 * moves the draft pointers — one transaction, entity row locked.
 *
 * Deferred to Phase 2b: Data Type closure in resolvedSource (14.2), per-format
 * compatibility rule tables + compatReport (14.3), MAJOR governance (14.4),
 * EntityVersionArtifact (14.5).
 */

import type { EntityVersion, PrismaClient, Prisma } from "@/generated/prisma/client";
import { withAudit, AuditUserMissingError } from "@/lib/audit";
import { ok, err, type Result } from "@/types/result";
import type { ServiceContext } from "@/types/service-context";
import type { FieldSnapshot } from "@/services/version-history/version.types";
import { toFieldSnapshot } from "@/lib/diff/field-snapshot";
import { resolveEntityReferences } from "@/lib/entity-versioning/line-references";
import { analyzePublish, planPublish, type PublishAnalysis, type PublishState } from "@/lib/entity-versioning/publish-plan";
import { formatVersionLabel, parseVersionLabel } from "@/lib/entity-versioning/version-math";
import type { EntityVersionSummary, PublishInput } from "@/lib/entity-versioning/types";
import { isSourceStale, WRITE_BACK_SOURCE_SQL } from "@/lib/entity-versioning/draft-state";
import {
  needsRegeneration,
  compileRegeneratedSource,
  confirmRegeneratedSource,
  freezableStoredSource,
} from "@/lib/entity-versioning/resolve-source";
import { ServiceErrorRejection } from "@/services/scoped-create.service";

type Db = PrismaClient | Prisma.TransactionClient;

const SUMMARY_SELECT = {
  id: true,
  entityId: true,
  major: true,
  minor: true,
  sequence: true,
  changeKind: true,
  changeSummary: true,
  publishedById: true,
  publishedAt: true,
  publishedBy: { select: { name: true } },
} satisfies Prisma.EntityVersionSelect;

type SummaryRow = Prisma.EntityVersionGetPayload<{ select: typeof SUMMARY_SELECT }>;

function toSummary(v: SummaryRow): EntityVersionSummary {
  return {
    id: v.id,
    entityId: v.entityId,
    major: v.major,
    minor: v.minor,
    label: formatVersionLabel(v),
    sequence: v.sequence,
    changeKind: v.changeKind,
    changeSummary: v.changeSummary,
    publishedById: v.publishedById,
    publishedByName: v.publishedBy.name,
    publishedAt: v.publishedAt.toISOString(),
  };
}

function entityNotFound(entityId: string) {
  return err({
    code: "NOT_FOUND",
    message: `Entity with ID "${entityId}" not found`,
    suggestedFix: "Verify the entity ID and try again.",
  });
}

function isUniqueViolation(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { code?: unknown }).code === "P2002";
}

/** The planner's state plus whether the stored source lags the field rows (R42). */
type LoadedPublishState = PublishState & { sourceStale: boolean };

async function loadPublishState(db: Db, entityId: string): Promise<Result<LoadedPublishState>> {
  const entity = await db.entity.findUnique({
    where: { id: entityId },
    include: {
      fields: { orderBy: { sortOrder: "asc" } },
      latestVersion: { select: { id: true, major: true, minor: true, sequence: true, fieldSnapshot: true } },
    },
  });
  if (!entity) return entityNotFound(entityId);

  // References stored by name only (every creation path today) are resolved against the entity's line
  // (shared with the draft artifact renderer: src/lib/entity-versioning/line-references.ts).
  const { targetIds, unresolvedNames } = await resolveEntityReferences(db, entity);
  const targets =
    targetIds.length > 0
      ? await db.entity.findMany({ where: { id: { in: targetIds } }, select: { id: true, name: true, latestVersionId: true } })
      : [];
  const byId = new Map(targets.map((t) => [t.id, t]));

  return ok({
    sourceStale: isSourceStale(entity.metadata),
    entity: {
      id: entity.id,
      name: entity.name,
      status: entity.status,
      version: entity.version,
      hasUnpublishedChanges: entity.hasUnpublishedChanges,
      typespecSource: entity.typespecSource,
    },
    latest: entity.latestVersion
      ? {
          id: entity.latestVersion.id,
          major: entity.latestVersion.major,
          minor: entity.latestVersion.minor,
          sequence: entity.latestVersion.sequence,
          fieldSnapshot: entity.latestVersion.fieldSnapshot as unknown as FieldSnapshot[],
        }
      : null,
    currentFields: entity.fields.map(toFieldSnapshot),
    references: targetIds.map((id) => {
      const t = byId.get(id);
      return { entityId: id, entityName: t?.name ?? null, latestVersionId: t?.latestVersionId ?? null };
    }),
    unresolvedReferenceNames: unresolvedNames,
  });
}

/** What the publish dialog shows: suggested bump, next labels, reasons, blockers, pins. */
export async function previewPublish(entityId: string, ctx: ServiceContext): Promise<Result<PublishAnalysis>> {
  const state = await loadPublishState(ctx.prisma, entityId);
  if (!state.success) return state;
  return ok(analyzePublish(state.data));
}

export async function publishEntity(
  entityId: string,
  opts: PublishInput,
  ctx: ServiceContext
): Promise<Result<EntityVersionSummary>> {
  const db = ctx.prisma;
  const changeSummary = opts.changeSummary?.trim() ? opts.changeSummary.trim() : null;
  try {
    // Phase 1 — no lock, no transaction. Fail fast on blockers, and when the stored source is stale or
    // missing regenerate it and gate it with the real compiler. The compile can take seconds, so it
    // must never run while holding the row lock (or PGlite's single connection).
    const pre = await loadPublishState(db, entityId);
    if (!pre.success) return err(pre.error);
    const prePlan = planPublish(pre.data, opts.bump);
    if (!prePlan.success) return err(prePlan.error);
    let precompiled: string | null = null;
    if (needsRegeneration(pre.data.entity.typespecSource, pre.data.sourceStale)) {
      const compiled = await compileRegeneratedSource(db, entityId);
      if (!compiled.success) return err(compiled.error);
      precompiled = compiled.data;
    }

    const created = await withAudit({
      action: "PUBLISH_VERSION",
      entityType: "Entity",
      entityId,
      userId: ctx.userId,
      fn: () =>
        db.$transaction(
          async (tx) => {
            // Row lock: serialises concurrent publishes of this entity, and makes a
            // concurrent draft edit's hasUnpublishedChanges=true land after our false.
            await tx.$queryRaw`SELECT "id" FROM "entities" WHERE "id" = ${entityId} FOR UPDATE`;

            const state = await loadPublishState(tx, entityId);
            if (!state.success) throw new ServiceErrorRejection(state.error);
            const plan = planPublish(state.data, opts.bump);
            if (!plan.success) throw new ServiceErrorRejection(plan.error);

            // Phase 2 — the source to freeze (R42/R45/R46). A fresh stored source is used as-is, except
            // that legacy `@tag` lines (stored before Story 16.6) are upgraded first (R53). A
            // regenerated one is only valid if the text phase 1 compiled is still exactly what the
            // locked rows generate; otherwise an edit landed in between: abort, retryable.
            const stored = state.data.entity.typespecSource;
            let source: string;
            let writeBack = false;
            if (stored && !needsRegeneration(stored, state.data.sourceStale)) {
              const frozen = freezableStoredSource(stored);
              source = frozen.source;
              writeBack = frozen.upgraded;
            } else {
              if (precompiled === null) {
                // Became stale/missing after phase 1 looked.
                throw new ServiceErrorRejection({
                  code: "CONFLICT",
                  message: "Entity changed during publish, try again",
                  suggestedFix: "Publish again.",
                });
              }
              const confirmed = await confirmRegeneratedSource(tx, entityId, precompiled);
              if (!confirmed.success) throw new ServiceErrorRejection(confirmed.error);
              source = precompiled;
              writeBack = true;
            }

            const version = await tx.entityVersion.create({
              data: {
                entityId,
                major: plan.data.version.major,
                minor: plan.data.version.minor,
                sequence: plan.data.sequence,
                resolvedSource: source,
                fieldSnapshot: state.data.currentFields as unknown as Prisma.InputJsonValue,
                changeKind: plan.data.changeKind,
                compatReport: {},
                changeSummary,
                publishedById: ctx.userId,
              },
              select: SUMMARY_SELECT,
            });

            if (plan.data.pins.length > 0) {
              await tx.schemaReference.createMany({
                data: plan.data.pins.map((pin) => ({
                  fromKind: "ENTITY_VERSION" as const,
                  fromId: version.id,
                  role: "FIELD" as const,
                  toKind: "ENTITY_VERSION" as const,
                  toId: pin.versionId,
                  isDraft: false,
                })),
                skipDuplicates: true,
              });
            }

            // A regenerated or upgraded source is written back (and sourceStale cleared) in this same
            // transaction, so the entity's canonical source matches what was just frozen.
            if (writeBack) {
              await tx.$executeRawUnsafe(WRITE_BACK_SOURCE_SQL, entityId, source);
            }

            await tx.entity.update({
              where: { id: entityId },
              data: { latestVersionId: version.id, hasUnpublishedChanges: false, version: version.sequence },
              select: { id: true },
            });
            return version;
          },
          { timeout: 15_000 }
        ),
    });
    return ok(toSummary(created));
  } catch (e: unknown) {
    if (e instanceof ServiceErrorRejection) return err(e.serviceError);
    if (e instanceof AuditUserMissingError) return err({ code: "UNAUTHORIZED", message: e.message });
    if (isUniqueViolation(e)) {
      return err({
        code: "CONFLICT",
        message: "Another publish of this entity completed first.",
        suggestedFix: "Reload the entity and publish again.",
      });
    }
    return err({ code: "DB_ERROR", message: e instanceof Error ? e.message : "Publish failed" });
  }
}

/** Published versions, newest first (Message pickers + version list). */
export async function listEntityVersions(
  entityId: string,
  ctx: ServiceContext
): Promise<Result<EntityVersionSummary[]>> {
  const exists = await ctx.prisma.entity.findUnique({ where: { id: entityId }, select: { id: true } });
  if (!exists) return entityNotFound(entityId);
  const rows = await ctx.prisma.entityVersion.findMany({
    where: { entityId },
    orderBy: { sequence: "desc" },
    select: SUMMARY_SELECT,
  });
  return ok(rows.map(toSummary));
}

/** One frozen version by label ("2.1" or "v2.1"), incl. resolvedSource + fieldSnapshot. */
export async function getEntityVersion(
  entityId: string,
  label: string,
  ctx: ServiceContext
): Promise<Result<EntityVersion>> {
  const parsed = parseVersionLabel(label);
  if (!parsed.success) return parsed;
  const row = await ctx.prisma.entityVersion.findUnique({
    where: { entityId_major_minor: { entityId, major: parsed.data.major, minor: parsed.data.minor } },
  });
  if (!row) {
    return err({
      code: "NOT_FOUND",
      message: `Version ${formatVersionLabel(parsed.data)} of entity "${entityId}" not found`,
      suggestedFix: "List the entity's published versions and pick one of them.",
    });
  }
  return ok(row);
}

/** The latest published version, or null when the entity was never published. */
export async function getLatestPublishedVersion(
  entityId: string,
  ctx: ServiceContext
): Promise<Result<EntityVersion | null>> {
  const entity = await ctx.prisma.entity.findUnique({ where: { id: entityId }, select: { latestVersion: true } });
  if (!entity) return entityNotFound(entityId);
  return ok(entity.latestVersion);
}

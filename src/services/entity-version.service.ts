/**
 * Entity versioning — Draft → Save snapshot → Promote (spec §5, phase 1 SemVer snapshots).
 *
 * The Entity row + its fields are the draft. publishEntity ("Save snapshot") writes the draft into the entity's one open SNAPSHOT
 * version (`x.y.z_snapshot`): it creates it when none is open, otherwise updates it in place (raised, never lowered), pins every
 * directly referenced entity in SchemaReference (role FIELD) at the version the save recorded for it (a pinned version, otherwise
 * the latest published one), and clears the draft flag — one transaction, entity row locked. promoteEntityVersion turns the open
 * snapshot into the immutable RELEASED `x.y.z` (same row; the database refuses any later update) and points `latestVersionId` at it.
 * `latestVersionId` is the latest release, or the open snapshot while the entity has none.
 *
 * The draft is judged against its REAL reference closure (`loadPublishClosure`: the entity at its saved rows, everything it
 * references, transitively, at its latest PUBLISHED version or pin, never a draft): a member that was never published or a pin that is
 * gone blocks the publish with a message naming the entity, the closure's combined TypeSpec is what the compile gate checks, and the
 * version used of every referenced entity is recorded on the published version (`compatReport.referencedVersions`, see
 * referenced-versions.ts) so staleness can be reported later (`loadReferenceStaleness`).
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
import {
  analyzePublish,
  planPromote,
  planPublish,
  type PublishAnalysis,
  type PublishPlan,
  type PublishState,
} from "@/lib/entity-versioning/publish-plan";
import { formatVersionLabel, parseVersionLabel, storedVersionWhere } from "@/lib/entity-versioning/version-math";
import type { EntityVersionSummary, PublishInput, VersionNumber } from "@/lib/entity-versioning/types";
import { isSourceStale, WRITE_BACK_SOURCE_SQL } from "@/lib/entity-versioning/draft-state";
import {
  needsRegeneration,
  compileClosure,
  compileRegeneratedSource,
  confirmRegeneratedSource,
  freezableStoredSource,
} from "@/lib/entity-versioning/resolve-source";
import { loadPublishClosure } from "@/lib/entity-versioning/publish-closure";
import { entityReader } from "@/lib/access/entity-reader";
import type { ClosureReader } from "@/lib/references/closure";
import { entitySnapshotReport } from "@/lib/entity-versioning/entity-snapshot";
import {
  readReferencedVersions,
  referencedVersionsReport,
  referenceStaleness,
  type ReferenceStaleness,
  type ReferencedVersion,
} from "@/lib/entity-versioning/referenced-versions";
import type { ReferenceClosure } from "@/lib/references/closure";
import { ServiceErrorRejection } from "@/services/scoped-create.service";

type Db = PrismaClient | Prisma.TransactionClient;

const SUMMARY_SELECT = {
  id: true,
  entityId: true,
  major: true,
  minor: true,
  patch: true,
  stage: true,
  sequence: true,
  changeKind: true,
  changeSummary: true,
  publishedById: true,
  publishedAt: true,
  releasedAt: true,
  publishedBy: { select: { name: true } },
} satisfies Prisma.EntityVersionSelect;

type SummaryRow = Prisma.EntityVersionGetPayload<{ select: typeof SUMMARY_SELECT }>;

function toSummary(v: SummaryRow): EntityVersionSummary {
  return {
    id: v.id,
    entityId: v.entityId,
    major: v.major,
    minor: v.minor,
    patch: v.patch,
    stage: v.stage,
    label: formatVersionLabel(v, v.stage),
    sequence: v.sequence,
    changeKind: v.changeKind,
    changeSummary: v.changeSummary,
    publishedById: v.publishedById,
    publishedByName: v.publishedBy.name,
    publishedAt: v.publishedAt.toISOString(),
    releasedAt: v.releasedAt ? v.releasedAt.toISOString() : null,
  };
}

function entityNotFound(entityId: string) {
  return err({
    code: "NOT_FOUND",
    message: `Entity with ID "${entityId}" not found`,
    suggestedFix: "Verify the entity ID and try again.",
  });
}

const isJsonObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function isUniqueViolation(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { code?: unknown }).code === "P2002";
}

/**
 * The planner's state plus whether the stored source lags the field rows (R42) and the closure the publish is judged against
 * (`null` exactly when `closureBlocker` is set: the plan then refuses before anything uses it).
 */
type LoadedPublishState = PublishState & {
  /** When the open snapshot was last written (null: none open): with the ids, what tells a save or promote that the other ran first. */
  openSnapshotUpdatedAt: Date | null;
  sourceStale: boolean;
  closure: ReferenceClosure | null;
  /** The tenant of the entity being published: every other entity or version the publish reads or links to must belong to it. */
  tenantId: string;
};

/**
 * The EntityVersion each direct-reference edge (`SchemaReference`, read by the artifact renderer, usage and pin-usage) points at, in
 * `plan.pins` order. It is the version the closure USED, the one recorded in `referencedVersions`: the pinned version for a pinned
 * reference, the latest published one at publish time otherwise, so an edge never contradicts the record. A direct reference the
 * closure did not use (found only through the relationships metadata, which the closure does not follow) keeps the latest published
 * version the planner found. A recorded version whose row cannot be read here (it was just read by the closure, in this same
 * transaction) aborts the publish, retryable.
 */
async function edgeTargetVersionIds(db: Db, plan: PublishPlan, tenantId: string): Promise<string[]> {
  const used = new Map(plan.referencedVersions.flatMap((r) => (r.ref.entityId ? [[r.ref.entityId, r.version] as const] : [])));
  const wanted = plan.pins.flatMap((pin) => {
    const label = used.get(pin.entityId);
    const parsed = label === undefined ? undefined : parseVersionLabel(label);
    return parsed?.success ? [{ entityId: pin.entityId, ...storedVersionWhere(parsed.data) }] : [];
  });
  // Bound to the publishing entity's tenant: an edge never links to a version another tenant owns, whatever the pins say.
  const rows =
    wanted.length === 0
      ? []
      : await db.entityVersion.findMany({ where: { OR: wanted, entity: { tenantId } }, select: { id: true, entityId: true, major: true, minor: true, patch: true, stage: true } });
  const idOf = new Map(rows.map((row) => [`${row.entityId}@${formatVersionLabel(row, row.stage)}`, row.id]));

  return plan.pins.map((pin) => {
    const label = used.get(pin.entityId);
    if (label === undefined) return pin.versionId;
    // Compared in the form the rows are keyed by: a recorded label in an older form ("2.1") names the same version as "2.1.0".
    const parsed = parseVersionLabel(label);
    const id = idOf.get(`${pin.entityId}@${parsed.success ? formatVersionLabel(parsed.data, parsed.data.stage) : label}`);
    if (!id) {
      throw new ServiceErrorRejection({
        code: "CONFLICT",
        message: "A referenced entity changed during publish, try again",
        suggestedFix: "Publish again.",
      });
    }
    return id;
  });
}

/** The same recorded versions, in the same order (the closure is deterministic): did a referenced entity move between two loads? */
function sameReferencedVersions(a: readonly ReferencedVersion[], b: readonly ReferencedVersion[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Which stored versions a save or promote was decided against: the latest release and the open snapshot (and when it was last written). */
function versionStateKey(s: Pick<LoadedPublishState, "latestRelease" | "openSnapshot" | "openSnapshotUpdatedAt">): string {
  return `${s.latestRelease?.id ?? "-"}|${snapshotKey(s.openSnapshot, s.openSnapshotUpdatedAt)}`;
}

/** The open snapshot as one comparable value: which row, at which number, last written when ("-": none open). */
function snapshotKey(snapshot: (VersionNumber & { id: string }) | null, updatedAt: Date | null): string {
  return snapshot ? `${snapshot.id}@${formatVersionLabel(snapshot)}@${updatedAt?.getTime() ?? ""}` : "-";
}

/** Another save or promote of the entity committed between what the caller decided on and the row lock: retryable. */
const VERSIONS_MOVED = {
  code: "CONFLICT",
  message: "Another save or promote of this entity completed first, try again",
  suggestedFix: "Reload the entity and try again.",
} as const;

function failure(e: unknown, fallback: string): Result<never> {
  if (e instanceof ServiceErrorRejection) return err(e.serviceError);
  if (e instanceof AuditUserMissingError) return err({ code: "UNAUTHORIZED", message: e.message });
  if (isUniqueViolation(e)) {
    // The (entity, number) key, the (entity, sequence) key or the one-open-snapshot index decided a race the row lock did not see.
    return err({
      code: "CONFLICT",
      message: "Another publish of this entity completed first.",
      suggestedFix: "Reload the entity and publish again.",
    });
  }
  return err({ code: "DB_ERROR", message: e instanceof Error ? e.message : fallback });
}

/**
 * `reader` is who may read what (KD-045): the closure the publish is judged against (and compiled from) holds only entities the caller's roles
 * cover; one they may not read blocks the publish with REFERENCE_NOT_READABLE (a message that names nothing of it) before its published content is
 * read, and the direct references below leave it out (its name is not shown, no pin is made to it).
 */
async function loadPublishState(db: Db, entityId: string, reader: ClosureReader): Promise<Result<LoadedPublishState>> {
  const entity = await db.entity.findUnique({
    where: { id: entityId },
    include: {
      fields: { orderBy: { sortOrder: "asc" } },
    },
  });
  if (!entity) return entityNotFound(entityId);

  // New snapshot numbers count from the highest RELEASE (and the bump is suggested from its fields); a save writes the open snapshot.
  const latestRelease = await db.entityVersion.findFirst({
    where: { entityId, stage: "RELEASED" },
    orderBy: [{ major: "desc" }, { minor: "desc" }, { patch: "desc" }],
    select: { id: true, major: true, minor: true, patch: true, sequence: true, fieldSnapshot: true },
  });
  const openSnapshot = await db.entityVersion.findFirst({
    where: { entityId, stage: "SNAPSHOT" },
    select: { id: true, major: true, minor: true, patch: true, sequence: true, updatedAt: true },
  });

  // References stored by name only (every creation path today) are resolved against the entity's line
  // (shared with the draft artifact renderer: src/lib/entity-versioning/line-references.ts).
  const { targetIds, unresolvedNames } = await resolveEntityReferences(db, entity);
  // Only entities of THIS entity's tenant: an id of another tenant's entity (stored by a client that forged it) is not found, so it reads as a
  // missing reference and blocks the publish instead of showing that entity's name or pinning its latest version.
  const found =
    targetIds.length > 0
      ? await db.entity.findMany({
          where: { id: { in: targetIds }, tenantId: entity.tenantId },
          select: { id: true, name: true, latestVersionId: true, domainId: true, productId: true, product: { select: { domainId: true } } },
        })
      : [];
  // One the caller may not read is not shown (not its name, not a pin to its version): the closure below says why the publish is blocked.
  const unreadable = new Set(
    found
      .filter((t) => !reader({ tenantId: entity.tenantId, domainId: t.domainId ?? t.product?.domainId ?? null, productId: t.productId ?? null }))
      .map((t) => t.id)
  );
  const targets = found.filter((t) => !unreadable.has(t.id));
  const byId = new Map(targets.map((t) => [t.id, t]));

  // The real closure: the draft at its saved rows, every member at its published version or pin. The direct references above only
  // see one level (and only by id or by name in the line); this sees the whole closure, and what it used is what gets recorded.
  const published = await loadPublishClosure(db, { id: entity.id, tenantId: entity.tenantId, name: entity.name }, { reader });

  return ok({
    closure: published.success ? published.data.closure : null,
    closureBlocker: published.success ? undefined : published.error,
    referencedVersions: published.success ? published.data.referencedVersions : [],
    sourceStale: isSourceStale(entity.metadata),
    tenantId: entity.tenantId,
    entity: {
      id: entity.id,
      name: entity.name,
      status: entity.status,
      version: entity.version,
      hasUnpublishedChanges: entity.hasUnpublishedChanges,
      typespecSource: entity.typespecSource,
    },
    latestRelease: latestRelease
      ? {
          id: latestRelease.id,
          major: latestRelease.major,
          minor: latestRelease.minor,
          patch: latestRelease.patch,
          sequence: latestRelease.sequence,
          fieldSnapshot: latestRelease.fieldSnapshot as unknown as FieldSnapshot[],
        }
      : null,
    openSnapshot: openSnapshot
      ? { id: openSnapshot.id, major: openSnapshot.major, minor: openSnapshot.minor, patch: openSnapshot.patch, sequence: openSnapshot.sequence }
      : null,
    openSnapshotUpdatedAt: openSnapshot?.updatedAt ?? null,
    currentFields: entity.fields.map(toFieldSnapshot),
    references: targetIds.filter((id) => !unreadable.has(id)).map((id) => {
      const t = byId.get(id);
      return { entityId: id, entityName: t?.name ?? null, latestVersionId: t?.latestVersionId ?? null };
    }),
    unresolvedReferenceNames: unresolvedNames,
  });
}

/** What the publish dialog shows: suggested bump, next labels, reasons, blockers, pins. */
export async function previewPublish(entityId: string, ctx: ServiceContext): Promise<Result<PublishAnalysis>> {
  const state = await loadPublishState(ctx.prisma, entityId, entityReader(ctx.assignments));
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
  // Who may read what (KD-045): the closure is judged and compiled over entities the caller's roles cover, and no others.
  const reader = entityReader(ctx.assignments);
  try {
    // Phase 1 — no lock, no transaction. Fail fast on blockers, and when the stored source is stale or
    // missing regenerate it and gate it with the real compiler. The compile can take seconds, so it
    // must never run while holding the row lock (or PGlite's single connection).
    const pre = await loadPublishState(db, entityId, reader);
    if (!pre.success) return err(pre.error);
    const prePlan = planPublish(pre.data, opts.bump);
    if (!prePlan.success) return err(prePlan.error);
    // A closure blocker (a member never published, a pin that is gone, ...) was already a plan blocker above, so the closure is here.
    const closure = pre.data.closure;
    if (!closure) return err({ code: "PUBLISH_BLOCKED", message: "The entity's references could not be resolved", suggestedFix: "Publish again." });
    let precompiled: string | null = null;
    if (needsRegeneration(pre.data.entity.typespecSource, pre.data.sourceStale)) {
      const compiled = await compileRegeneratedSource(db, entityId, closure);
      if (!compiled.success) return err(compiled.error);
      precompiled = compiled.data;
    } else if (closure.entities.length > 1) {
      // A fresh stored source is frozen as it is, but when it refers to other entities the combined closure it belongs to must still
      // compile: that is what every consumer will emit. An entity that references nothing is not compiled here (unchanged).
      const gated = await compileClosure(closure);
      if (!gated.success) return err(gated.error);
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

            const state = await loadPublishState(tx, entityId, reader);
            if (!state.success) throw new ServiceErrorRejection(state.error);
            // Phase 1 planned against the versions it read (create a snapshot, or update THAT snapshot). If a promote released it, or
            // another save created or rewrote it, since, that plan is void: abort, retryable (never a second snapshot, never a write
            // to a row that is now a release).
            if (versionStateKey(pre.data) !== versionStateKey(state.data)) throw new ServiceErrorRejection(VERSIONS_MOVED);
            const plan = planPublish(state.data, opts.bump);
            if (!plan.success) throw new ServiceErrorRejection(plan.error);

            // The compile in phase 1 vouches for the closure it compiled. If a referenced entity published (or a pin moved) since,
            // what would be recorded is no longer what was checked: abort, retryable, like an edit to the entity itself.
            if (!sameReferencedVersions(prePlan.data.referencedVersions, plan.data.referencedVersions)) {
              throw new ServiceErrorRejection({
                code: "CONFLICT",
                message: "A referenced entity changed during publish, try again",
                suggestedFix: "Publish again.",
              });
            }

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

            // What a save writes into the snapshot, created or updated alike. The owner and the sequence are set when it is
            // created and never written again.
            const content = {
              major: plan.data.version.major,
              minor: plan.data.version.minor,
              patch: plan.data.version.patch,
              resolvedSource: source,
              fieldSnapshot: state.data.currentFields as unknown as Prisma.InputJsonValue,
              changeKind: plan.data.changeKind,
              // The exact version of every referenced entity the closure used (pinned or latest published); no column needed.
              // The entity's own name, description, status and metadata as they are now (the closure's root is read from its saved rows,
              // under the row lock): published output of this version, and of whatever references it, reads them from here, not from
              // the live row (final wave 2b, G7). No column needed either.
              compatReport: {
                ...referencedVersionsReport(plan.data.referencedVersions),
                ...(state.data.closure ? entitySnapshotReport(state.data.closure.root.entity) : {}),
              } as unknown as Prisma.InputJsonValue,
              changeSummary,
              publishedById: ctx.userId,
              // When the snapshot was last saved, and by whom; released only by a promote.
              publishedAt: new Date(),
            } satisfies Prisma.EntityVersionUncheckedUpdateManyInput;

            let version: SummaryRow;
            if (plan.data.mode === "CREATE") {
              version = await tx.entityVersion.create({
                data: { entityId, sequence: plan.data.sequence, stage: "SNAPSHOT", ...content },
                select: SUMMARY_SELECT,
              });
            } else {
              const snapshotId = plan.data.snapshotId as string;
              // Only while it is still this entity's snapshot (the lock and the check above make that certain; the filter keeps a
              // release out of reach even if they did not).
              const updated = await tx.entityVersion.updateMany({ where: { id: snapshotId, entityId, stage: "SNAPSHOT" }, data: content });
              if (updated.count !== 1) throw new ServiceErrorRejection(VERSIONS_MOVED);
              // The snapshot's pins are re-made below from this save's closure.
              await tx.schemaReference.deleteMany({ where: { fromKind: "ENTITY_VERSION", fromId: snapshotId, role: "FIELD" } });
              version = await tx.entityVersion.findUniqueOrThrow({ where: { id: snapshotId }, select: SUMMARY_SELECT });
            }

            if (plan.data.pins.length > 0) {
              const targets = await edgeTargetVersionIds(tx, plan.data, state.data.tenantId);
              await tx.schemaReference.createMany({
                data: plan.data.pins.map((pin, i) => ({
                  fromKind: "ENTITY_VERSION" as const,
                  fromId: version.id,
                  role: "FIELD" as const,
                  toKind: "ENTITY_VERSION" as const,
                  toId: targets[i],
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

            // `latestVersionId` stays on the latest release; only an entity with no release points at its snapshot (bootstrap).
            await tx.entity.update({
              where: { id: entityId },
              data: {
                hasUnpublishedChanges: false,
                version: version.sequence,
                ...(state.data.latestRelease ? {} : { latestVersionId: version.id }),
              },
              select: { id: true },
            });
            return version;
          },
          { timeout: 15_000 }
        ),
    });
    return ok(toSummary(created));
  } catch (e: unknown) {
    return failure(e, "Publish failed");
  }
}

/**
 * What stands between the open snapshot and a release, besides the planner's checks: the entities it references only at a snapshot
 * (a release may only reference releases), and its recorded `referencedVersions` with every snapshot label that has since been
 * released rewritten to the released label (`null` when nothing needs rewriting).
 *
 * A snapshot reference is a pin edge from the snapshot whose target row is still a SNAPSHOT, or a recorded snapshot label that does
 * not name a RELEASED row of the same number (still a snapshot, or renumbered since). A released or legacy label ("2.1" is 2.1.0)
 * never names a snapshot. Every row read is bound to the entity's tenant.
 */
async function snapshotReferences(
  db: Db,
  snapshotId: string,
  tenantId: string
): Promise<{ names: string[]; releasedRecord: ReferencedVersion[] | null; compatReport: unknown }> {
  const names = new Set<string>();

  const edges = await db.schemaReference.findMany({
    where: { fromKind: "ENTITY_VERSION", fromId: snapshotId, toKind: "ENTITY_VERSION" },
    select: { toId: true },
  });
  if (edges.length > 0) {
    const targets = await db.entityVersion.findMany({
      where: { id: { in: edges.map((edge) => edge.toId) }, stage: "SNAPSHOT", entity: { tenantId } },
      select: { entity: { select: { name: true } } },
    });
    for (const target of targets) names.add(target.entity.name);
  }

  const row = await db.entityVersion.findUnique({ where: { id: snapshotId }, select: { compatReport: true } });
  const recorded = readReferencedVersions(row?.compatReport);
  let rewritten = false;
  const releasedRecord: ReferencedVersion[] = [];
  for (const entry of recorded) {
    const parsed = parseVersionLabel(entry.version);
    if (!parsed.success || parsed.data.stage !== "SNAPSHOT") {
      releasedRecord.push(entry);
      continue;
    }
    const { major, minor, patch } = parsed.data;
    const target = entry.ref.entityId
      ? await db.entityVersion.findFirst({
          where: { entityId: entry.ref.entityId, major, minor, patch, entity: { tenantId } },
          select: { stage: true },
        })
      : null;
    if (target?.stage === "RELEASED") {
      releasedRecord.push({ ...entry, version: formatVersionLabel(parsed.data) });
      rewritten = true;
    } else {
      names.add(entry.ref.entity);
      releasedRecord.push(entry);
    }
  }

  return { names: [...names].sort(), releasedRecord: rewritten ? releasedRecord : null, compatReport: row?.compatReport };
}

/**
 * Promote the entity's open snapshot to its release (`x.y.z_snapshot` → `x.y.z`, same row, frozen from then on) and point
 * `latestVersionId` at it. Refused when there is no snapshot (NO_SNAPSHOT), the draft has edits the snapshot does not hold
 * (DRAFT_NOT_SAVED), the entity is retired or its references no longer resolve (PUBLISH_BLOCKED, the save's own blockers), or the
 * snapshot references a snapshot (SNAPSHOT_REFERENCES, naming the entities). The same row lock as a save serialises the two; a save
 * that committed after this call first looked at the snapshot makes it a CONFLICT (promote what you saw, or nothing).
 */
export async function promoteEntityVersion(entityId: string, ctx: ServiceContext): Promise<Result<EntityVersionSummary>> {
  const db = ctx.prisma;
  const reader = entityReader(ctx.assignments);
  try {
    // The snapshot the caller is promoting, as it is now (no lock): a save that lands before the lock below changes it.
    const seen = await db.entityVersion.findFirst({
      where: { entityId, stage: "SNAPSHOT" },
      select: { id: true, major: true, minor: true, patch: true, updatedAt: true },
    });

    const promoted = await withAudit({
      action: "PROMOTE_VERSION",
      entityType: "Entity",
      entityId,
      userId: ctx.userId,
      fn: () =>
        db.$transaction(
          async (tx) => {
            // The same row lock as a save: a save and a promote of one entity never interleave.
            await tx.$queryRaw`SELECT "id" FROM "entities" WHERE "id" = ${entityId} FOR UPDATE`;

            const state = await loadPublishState(tx, entityId, reader);
            if (!state.success) throw new ServiceErrorRejection(state.error);
            const snapshot = state.data.openSnapshot;
            if (snapshotKey(seen, seen?.updatedAt ?? null) !== snapshotKey(snapshot, state.data.openSnapshotUpdatedAt)) {
              throw new ServiceErrorRejection(VERSIONS_MOVED);
            }

            // `hasUnpublishedChanges` is false exactly when the draft is what the open snapshot holds (a save clears it, an edit sets it).
            const draftDirty = state.data.entity.hasUnpublishedChanges;
            const basic = planPromote({ ...state.data, draftDirty, snapshotReferences: [] });
            if (!basic.success) throw new ServiceErrorRejection(basic.error);

            // The save's blockers still hold for a release: a retired entity is read-only, and a closure that no longer resolves (a
            // reference deleted, a pin gone, one the caller may not read) is not released. "No changes" is the normal state here.
            const blockers = analyzePublish(state.data).blockers.filter((b) => b.kind !== "NO_CHANGES");
            if (blockers.length > 0) {
              throw new ServiceErrorRejection({
                code: "PUBLISH_BLOCKED",
                message: blockers.map((b) => b.message).join("; "),
                details: { blockers },
                suggestedFix: "Resolve every blocker, then promote again.",
              });
            }

            const refs = await snapshotReferences(tx, basic.data.snapshotId, state.data.tenantId);
            const plan = planPromote({ ...state.data, draftDirty, snapshotReferences: refs.names });
            if (!plan.success) throw new ServiceErrorRejection(plan.error);

            const releasedRecord = refs.releasedRecord;
            const updated = await tx.entityVersion.updateMany({
              where: { id: plan.data.snapshotId, entityId, stage: "SNAPSHOT" },
              data: {
                stage: "RELEASED",
                releasedAt: new Date(),
                releasedById: ctx.userId,
                ...(releasedRecord
                  ? {
                      compatReport: {
                        ...(isJsonObject(refs.compatReport) ? refs.compatReport : {}),
                        ...referencedVersionsReport(releasedRecord),
                      } as unknown as Prisma.InputJsonValue,
                    }
                  : {}),
              },
            });
            if (updated.count !== 1) throw new ServiceErrorRejection(VERSIONS_MOVED);

            await tx.entity.update({ where: { id: entityId }, data: { latestVersionId: plan.data.snapshotId }, select: { id: true } });
            return tx.entityVersion.findUniqueOrThrow({ where: { id: plan.data.snapshotId }, select: SUMMARY_SELECT });
          },
          { timeout: 15_000 }
        ),
    });
    return ok(toSummary(promoted));
  } catch (e: unknown) {
    return failure(e, "Promote failed");
  }
}

/** Stored versions: the open snapshot first, then the releases, newest first (Message pickers + version list). */
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
  // Stable: releases keep their newest-first order behind the snapshot.
  const ordered = [...rows.filter((v) => v.stage === "SNAPSHOT"), ...rows.filter((v) => v.stage !== "SNAPSHOT")];
  return ok(ordered.map(toSummary));
}

/** One frozen version by label ("2.1.0", "v2.1.0", legacy "2.1"), incl. resolvedSource + fieldSnapshot. */
export async function getEntityVersion(
  entityId: string,
  label: string,
  ctx: ServiceContext
): Promise<Result<EntityVersion>> {
  const parsed = parseVersionLabel(label);
  if (!parsed.success) return parsed;
  const { stage, ...number } = storedVersionWhere(parsed.data);
  const row = await ctx.prisma.entityVersion.findUnique({ where: { entityId_major_minor_patch: { entityId, ...number }, stage } });
  if (!row) {
    return err({
      code: "NOT_FOUND",
      message: `Version ${formatVersionLabel(parsed.data, parsed.data.stage)} of entity "${entityId}" not found`,
      suggestedFix: "List the entity's published versions and pick one of them.",
    });
  }
  return ok(row);
}

/** The highest RELEASED version; with no release yet, the open snapshot; null when nothing was ever saved. */
export async function getLatestPublishedVersion(
  entityId: string,
  ctx: ServiceContext
): Promise<Result<EntityVersion | null>> {
  const entity = await ctx.prisma.entity.findUnique({ where: { id: entityId }, select: { id: true } });
  if (!entity) return entityNotFound(entityId);
  const release = await ctx.prisma.entityVersion.findFirst({
    where: { entityId, stage: "RELEASED" },
    orderBy: [{ major: "desc" }, { minor: "desc" }, { patch: "desc" }],
  });
  if (release) return ok(release);
  return ok(await ctx.prisma.entityVersion.findFirst({ where: { entityId, stage: "SNAPSHOT" } }));
}

/**
 * The references of the entity's latest published version that have fallen behind: an UNPINNED reference whose entity has a newer
 * published version than the one recorded when this version was published (a pinned one is never stale). Empty for an entity that
 * was never published and for a version published before references were recorded. Feeds the entity's alerts.
 */
export async function loadReferenceStaleness(db: Db, entityId: string): Promise<Result<ReferenceStaleness[]>> {
  const entity = await db.entity.findUnique({
    where: { id: entityId },
    select: { tenantId: true, latestVersion: { select: { compatReport: true } } },
  });
  if (!entity) return entityNotFound(entityId);

  const recorded = readReferencedVersions(entity.latestVersion?.compatReport);
  const ids = [...new Set(recorded.flatMap((r) => (!r.pinned && r.ref.entityId ? [r.ref.entityId] : [])))];
  if (ids.length === 0) return ok([]);

  const referenced = await db.entity.findMany({
    where: { id: { in: ids }, tenantId: entity.tenantId },
    select: { id: true, latestVersion: { select: { major: true, minor: true, patch: true, stage: true } } },
  });
  const latest = new Map(
    referenced.flatMap((e) => (e.latestVersion ? [[e.id, formatVersionLabel(e.latestVersion, e.latestVersion.stage)] as const] : []))
  );
  return ok(referenceStaleness({ referencedVersions: recorded }, latest));
}

// src/services/events/event-publish.service.ts
// Save snapshot → promote of a self-contained event (spec 2026-10-15-events-self-contained-design §5 / §10, phase 1 SemVer snapshots).
// `publishEvent` ("Save snapshot") writes the draft into the event's one open SNAPSHOT version (`x.y.z_snapshot`): it creates it when
// none is open, otherwise updates it in place (raised, never lowered). A version holds the fully resolved AsyncAPI document
// (`info.version` = the full label), the v2 draft it came from, the library traits frozen at that moment and the stored
// `ResolvedEventSpec` that other events' external references reuse. `promoteEvent` turns the open snapshot into the immutable RELEASED
// `x.y.z` (same row; the database refuses any later update). `latestVersionId` is the latest release, or the open snapshot while the
// event has none. Structure: an unlocked `prepare` plans and renders, then ONE transaction locks, re-verifies everything the plan
// depended on (the snapshot loader reads the latest release and the open snapshot, so a save or promote that landed meanwhile is seen)
// and only then writes.
import { isDeepStrictEqual } from "node:util";
import { Prisma, type PrismaClient } from "@/generated/prisma/client";
import { planPromote } from "@/lib/entity-versioning/publish-plan";
import { isBumpKind, MAX_CHANGE_SUMMARY, type BumpKind, type PublishInput } from "@/lib/entity-versioning/types";
import { savedSince, snapshotKey, versionsMoved } from "@/lib/entity-versioning/snapshot-drift";
import { formatVersionLabel } from "@/lib/entity-versioning/version-math";
import {
  GENERIC_VALIDATION_FAILURE, normalizeDiagnostics, type Diagnostic, type EmitOutput, type ResolvedEventSpec,
} from "@/lib/event-specs";
import { classifyEventBump } from "@/lib/events/document/bump";
import { collectDocumentEdges, collectDocumentRefs, collectPinSites } from "@/lib/events/document/edges";
import { parseEventDocument } from "@/lib/events/document/parse";
import { isJsonObject } from "@/lib/events/inputs";
import { effectiveRepresentationFormats } from "@/lib/events/document/representation";
import {
  analyzeVersionedPublish, planVersionedPublish, provisionalLabel,
  type EventPublishAnalysis, type EventPublishBlocker, type VersionedPublishInput,
} from "@/lib/events/publish-plan";
import type { EventVersionSummary } from "@/lib/events/types";
import { ok, err, type Result, type ServiceError } from "@/types/result";
import type { ServiceContext } from "@/types/service-context";
import { admitCompilerRuns, compilerBusyError, shareInUseError } from "@/lib/emission/emission-admission";
import { getSharedArtifactRenderer } from "./artifact-renderer";
import { auditedWrite } from "./audited";
import { emitResolved, withInternalKeys, type EmitDeps } from "./event-emit.service";
import { gatherPublishFacts, parseFrozenTraits, type PublishFacts } from "./event-publish-facts";
import { eventRenderShare, loadEventSnapshot, resolveEventSnapshot, type EventSnapshot } from "./event-snapshot";
import { isConcurrentWriteFailure } from "./publish-concurrency";
import { replaceReferences } from "./schema-references";
import { assertOwnedEvent, guardRead } from "./service-guards";
import { toEventVersionSummary, VERSION_SUMMARY_SELECT } from "./version-summary";

type Db = PrismaClient | Prisma.TransactionClient;

const notFound = (eventId: string) => err({ code: "NOT_FOUND", message: `Event "${eventId}" not found` });

/** The retryable "something changed under the publish" failure (lock re-verification, unique index, FK to a removed row, lock timeout / deadlock — see `isConcurrentWriteFailure`). */
const changedDuringPublish = () =>
  err({ code: "CONFLICT", message: "The event changed while publishing.", suggestedFix: "Reload the event and publish again." });

interface Prepared {
  snapshot: EventSnapshot;
  facts: PublishFacts;
  /** The planner input including the emission's validation errors: every blocker together. */
  input: VersionedPublishInput;
  resolved: ResolvedEventSpec | null;
  output: EmitOutput | null;
  diagnostics: Diagnostic[];
}

/**
 * The adapter's own failures (a validator or the @asyncapi/parser threw). The adapter and the parser validator already log the
 * raw exception and return the generic message; this stays as the backstop for any other adapter failure code: logged
 * server-side only, the browser gets the generic message under the same code (R67).
 */
function emitFailure(eventId: string, error: ServiceError): Result<never> {
  console.error(`[event-publish] emission of ${eventId} failed (${error.code}):`, error.message);
  return err({ code: error.code, message: GENERIC_VALIDATION_FAILURE });
}

/** An emission error as a blocker at its pointer: unresolved references keep their kind, everything else is a validation error. */
const diagnosticBlocker = (d: Diagnostic): EventPublishBlocker => ({
  kind: d.code === "UNRESOLVED_REFERENCE" ? "UNRESOLVED_REFERENCE" : "VALIDATION_ERROR",
  message: d.message,
  pointer: d.pointer,
});

/**
 * Snapshot → facts → label → render + emit with `info.version` = label → every blocker together. The label comes from the planner;
 * when the plan fails (blockers, BUMP_TOO_LOW, …) the provisional label stands in so the emission can still report its validation
 * errors alongside the other blockers. Nothing is locked or written here.
 */
async function prepare(db: Db, eventId: string, requested: BumpKind | undefined, ctx: ServiceContext, deps: EmitDeps): Promise<Result<Prepared>> {
  const snapshot = await loadEventSnapshot(db, eventId);
  if (!snapshot.success) return snapshot;
  const facts = await gatherPublishFacts(db, snapshot.data);
  if (!facts.success) return facts;

  const base: VersionedPublishInput = {
    latestRelease: facts.data.latestRelease,
    openSnapshot: facts.data.openSnapshot,
    hasChanges: facts.data.hasChanges,
    blockers: facts.data.blockers,
    bump: facts.data.classifiable && facts.data.previous ? classifyEventBump(facts.data.previous, facts.data.current) : null,
  };
  const planned = planVersionedPublish(base, requested);
  const label = planned.success ? planned.data.label : provisionalLabel(analyzeVersionedPublish(base));

  // The renders and the emission run under the caller's compiler share, one unit per render (src/lib/emission/emission-admission.ts): refused at once otherwise.
  const share = admitCompilerRuns(ctx.userId, eventRenderShare(snapshot.data));
  if (!share) return err(shareInUseError());
  let draft: Awaited<ReturnType<typeof resolveEventSnapshot>>;
  let output: EmitOutput | null = null;
  let diagnostics: ReturnType<typeof normalizeDiagnostics>;
  try {
    draft = await resolveEventSnapshot(snapshot.data, deps.renderer ?? getSharedArtifactRenderer(ctx.prisma), label);
    // A busy compiler is a retry, not a blocker of the publish: the plan would be built from missing renders.
    if (draft.busy) return err(compilerBusyError());
    diagnostics = normalizeDiagnostics(draft.diagnostics);
    if (draft.resolved) {
      const out = await emitResolved(draft.resolved, snapshot.data.event.specType, await withInternalKeys(deps, snapshot.data.event.tenantId, ctx.prisma));
      if (!out.success) return emitFailure(eventId, out.error);
      output = out.data;
      diagnostics = normalizeDiagnostics([...draft.diagnostics, ...out.data.diagnostics]);
    }
  } finally {
    share();
  }
  const emissionBlockers = diagnostics.filter((d) => d.severity === "error").map(diagnosticBlocker);
  return ok({
    snapshot: snapshot.data,
    facts: facts.data,
    input: { ...base, blockers: [...facts.data.blockers, ...emissionBlockers] },
    resolved: draft.resolved,
    output,
    diagnostics,
  });
}

/** What the publish dialog shows. Never writes (no version, no audit row, no edge). */
export async function previewEventPublish(eventId: string, productId: string, ctx: ServiceContext, deps: EmitDeps = {}): Promise<Result<EventPublishAnalysis>> {
  return guardRead(async () => {
    const owned = await assertOwnedEvent(ctx.prisma, eventId, productId);
    if (!owned.success) return owned;
    const prepared = await prepare(ctx.prisma, eventId, undefined, ctx, deps);
    if (!prepared.success) return prepared;
    return ok(analyzeVersionedPublish(prepared.data.input));
  });
}

/**
 * Save the draft as the event's open snapshot (CREATE `x.y.z_snapshot` when none is open, else UPDATE it in place: only while it is a
 * SNAPSHOT, never its owner or sequence). Ownership, then an unlocked plan (read, render, emit with `info.version` = the snapshot
 * label, validate — nothing is written or audited on a failure there), then ONE transaction that re-verifies everything under the
 * locks and aborts with a retryable CONFLICT when the plan was computed from anything that has since changed (including the latest
 * release and the open snapshot, last written when: a promote or another save that landed in between).
 *
 * Lock contract (spec §10): `event_specs` row FOR UPDATE → the pinned entities' rows `FOR SHARE ... ORDER BY id` → re-read the
 * snapshot and the facts and compare → only then write the version row, the frozen edges and (before any release) the event's pointer. A save of the
 * draft (which updates the event row first) therefore either finished before the lock (the re-verification sees it) or waits for
 * this commit. An entity delete serializes against the publish on the entity's row: `deleteEntity` / `deleteEntityAction` lock it
 * FOR UPDATE in the one transaction that holds their guard and the delete (`deleteEntityGuarded`), so whichever takes the row
 * first wins. A delete that went first removes the entity (and its versions) before our `FOR SHARE` is granted, the
 * re-verification no longer finds the pinned version and the publish fails with a retryable CONFLICT, nothing written; a publish
 * that went first has committed its published edge before the delete's guard reads, so the delete is IN_USE. The two lock orders
 * cannot close a cycle: the delete takes one entity row and nothing else first. Retiring an entity is NOT ordered this way: its
 * guard is a courtesy check (nothing dangles when a pin reaches an entity that is retired meanwhile), and a publish does not look at
 * the entity's status.
 */
export async function publishEvent(eventId: string, productId: string, input: PublishInput, ctx: ServiceContext, deps: EmitDeps = {}): Promise<Result<EventVersionSummary>> {
  // Untrusted action input: null / non-object → no options; a bump or summary of the wrong type is rejected, never coerced.
  const opts: Partial<PublishInput> = typeof input === "object" && input !== null ? input : {};
  if (opts.bump !== undefined && !isBumpKind(opts.bump)) return err({ code: "VALIDATION_ERROR", message: "bump must be MAJOR, MINOR or PATCH" });
  if (opts.changeSummary !== undefined && opts.changeSummary !== null && typeof opts.changeSummary !== "string") {
    return err({ code: "VALIDATION_ERROR", message: "Change summary must be a string" });
  }
  const bump = opts.bump;
  const changeSummary = opts.changeSummary?.trim() ? opts.changeSummary.trim() : null;
  // The summary is stored in the immutable version row and audit entry: bounded here (the entity publish action's cap), before anything is read.
  if (changeSummary !== null && changeSummary.length > MAX_CHANGE_SUMMARY) {
    return err({ code: "VALIDATION_ERROR", message: `Change summary must be at most ${MAX_CHANGE_SUMMARY} characters` });
  }

  // Phase 1: ownership (once — scope never changes) + the unlocked plan.
  const prepared = await guardRead(async () => {
    const owned = await assertOwnedEvent(ctx.prisma, eventId, productId);
    if (!owned.success) return owned;
    return prepare(ctx.prisma, eventId, bump, ctx, deps);
  });
  if (!prepared.success) return prepared;
  const plan = planVersionedPublish(prepared.data.input, bump);
  if (!plan.success) return plan; // PUBLISH_BLOCKED (all blockers), BUMP_TOO_LOW, INVALID_PLAN_INPUT — straight to the UI
  const { snapshot, facts, resolved, output, diagnostics } = prepared.data;
  if (!output || !resolved) return err({ code: "PUBLISH_BLOCKED", message: "The event could not be emitted" });

  return auditedWrite({
    action: "PUBLISH_VERSION", entityType: "EventSpec", entityId: eventId, userId: ctx.userId,
    run: async () => {
      try {
        return await ctx.prisma.$transaction(
          async (tx): Promise<Result<EventVersionSummary>> => {
            const locked = await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "event_specs" WHERE "id" = ${eventId} FOR UPDATE`;
            if (locked.length === 0) return notFound(eventId);
            if (facts.lockEntityIds.length > 0) {
              await tx.$queryRaw`SELECT "id" FROM "entities" WHERE "id" IN (${Prisma.join(facts.lockEntityIds)}) ORDER BY "id" FOR SHARE`;
            }

            // Re-verify under the locks: the draft, the library traits and referenced event versions the document was rendered with,
            // the pins, the facts (changes, entity names) — the plan and the emitted document are only valid for exactly this state.
            const fresh = await loadEventSnapshot(tx, eventId);
            if (!fresh.success) return fresh;
            const freshFacts = await gatherPublishFacts(tx, fresh.data);
            if (!freshFacts.success) return freshFacts;
            if (!isDeepStrictEqual(fresh.data, snapshot) || !isDeepStrictEqual(freshFacts.data, facts)) return changedDuringPublish();

            const content = {
              major: plan.data.version.major,
              minor: plan.data.version.minor,
              patch: plan.data.version.patch,
              document: output.document as unknown as Prisma.InputJsonValue, // the assembled AsyncAPI, info.version = the snapshot label
              sourceDocument: snapshot.document as unknown as Prisma.InputJsonValue, // the v2 draft: input of the next classification
              resolvedSpec: resolved as unknown as Prisma.InputJsonValue, // external refs reuse this without re-rendering
              frozenTraits: [...snapshot.libraryTraits.values()] as unknown as Prisma.InputJsonValue,
              changeKind: plan.data.changeKind,
              // reasons / diagnostics as before; `representations` = the format every message was emitted in: the baseline the next
              // publish compares an entity's recorded source format against (it is not part of the draft document)
              compatReport: {
                reasons: plan.data.reasons,
                diagnostics: diagnostics.filter((d) => d.severity !== "error"),
                representations: effectiveRepresentationFormats(snapshot.document, snapshot.entityFormats),
              } as unknown as Prisma.InputJsonValue,
              changeSummary,
              publishedById: ctx.userId,
              // when this content was saved: a pin to this row from a snapshot saved before it is stale (see `snapshotReferences`)
              publishedAt: new Date(),
            };
            let versionId: string;
            if (plan.data.mode === "CREATE") {
              const created = await tx.eventSpecVersion.create({
                data: { eventSpecId: eventId, sequence: plan.data.sequence, stage: "SNAPSHOT", ...content },
                select: { id: true },
              });
              versionId = created.id;
            } else {
              // Only the open snapshot, and only while it is one: a released row is never reached (the trigger is the backstop).
              // Owner and sequence are never rewritten.
              const updated = await tx.eventSpecVersion.updateMany({
                where: { id: plan.data.snapshotId!, eventSpecId: eventId, stage: "SNAPSHOT" },
                data: content,
              });
              if (updated.count !== 1) return changedDuringPublish();
              versionId = plan.data.snapshotId!;
            }
            await replaceReferences(tx, { kind: "EVENT_SPEC_VERSION", id: versionId }, collectDocumentEdges(snapshot.document), false);
            // `latestVersionId` is the latest release, or the open snapshot while there is none.
            await tx.eventSpec.update({
              where: { id: eventId },
              data: { hasUnpublishedChanges: false, ...(facts.latestRelease ? {} : { latestVersionId: versionId }) },
              select: { id: true },
            });
            const version = await tx.eventSpecVersion.findUniqueOrThrow({ where: { id: versionId }, select: VERSION_SUMMARY_SELECT });
            return ok(toEventVersionSummary(version));
          },
          { timeout: 15_000 }
        );
      } catch (e: unknown) {
        if (isConcurrentWriteFailure(e)) return changedDuringPublish();
        throw e;
      }
    },
  });
}

/** Another save or promote of the event committed between what the caller decided on and the row lock: retryable. */
const versionsMovedErr = () => err(versionsMoved("event"));

/** `stored` with `info.version` set to `label` (the rest untouched), or null when it is not a document with an `info` object. */
function withInfoVersion(stored: unknown, label: string): Prisma.InputJsonValue | null {
  if (!isJsonObject(stored) || !isJsonObject(stored.info)) return null;
  return { ...stored, info: { ...stored.info, version: label } } as unknown as Prisma.InputJsonValue;
}

/**
 * What the open snapshot references only at a snapshot or saved again since it was (a release may only reference releases), after locking what it
 * references so no save or promote of it can land while the promote decides: every entity version it pins (a payload / key /
 * headers pin, a frozen library trait's headers pin, the entities' rows FOR SHARE) and every event version it references (an external
 * ref, the events' rows FOR SHARE). `changed`: saved again AFTER this snapshot was saved (`savedSince`), even if released since — its
 * content is not what this snapshot rendered, so this event must be saved again first. `snapshots`: otherwise still a SNAPSHOT —
 * promote it first. Every row
 * read is bound to the event's tenant. Lock order: the event's own row (held by the caller) → entities by id → events by id.
 */
async function snapshotReferences(
  tx: Prisma.TransactionClient,
  own: { publishedAt: Date; sourceDocument: unknown; frozenTraits: unknown },
  tenantId: string
): Promise<Result<{ snapshots: string[]; changed: string[] }>> {
  const parsed = parseEventDocument(own.sourceDocument);
  const traits = parseFrozenTraits(own.frozenTraits);
  if (!parsed.success || !traits) return err({ code: "DATA_CORRUPT", message: "The stored snapshot is not a valid event document (v2)" });
  const pins = [
    ...collectPinSites(parsed.data).map((site) => site.pin),
    ...traits.map((t) => ({ entityId: t.headersEntityId, entityVersionId: t.headersEntityVersionId })),
  ];
  const entityIds = [...new Set(pins.flatMap((p) => (p.entityId ? [p.entityId] : [])))].sort();
  const entityVersionIds = [...new Set(pins.flatMap((p) => (p.entityVersionId ? [p.entityVersionId] : [])))];
  const eventVersionIds = collectDocumentRefs(parsed.data).externalVersionIds;

  if (entityIds.length > 0) {
    await tx.$queryRaw`SELECT "id" FROM "entities" WHERE "id" IN (${Prisma.join(entityIds)}) ORDER BY "id" FOR SHARE`;
  }
  if (eventVersionIds.length > 0) {
    const owners = await tx.eventSpecVersion.findMany({ where: { id: { in: eventVersionIds }, eventSpec: { tenantId } }, select: { eventSpecId: true } });
    const eventIds = [...new Set(owners.map((o) => o.eventSpecId))].sort();
    if (eventIds.length > 0) await tx.$queryRaw`SELECT "id" FROM "event_specs" WHERE "id" IN (${Prisma.join(eventIds)}) ORDER BY "id" FOR SHARE`;
  }

  const snapshots = new Set<string>();
  const changed = new Set<string>();
  const classify = (target: { stage: string; publishedAt: Date }, name: string) => {
    if (savedSince(target, own)) changed.add(name);
    else if (target.stage === "SNAPSHOT") snapshots.add(name);
  };
  const [entityTargets, eventTargets] = await Promise.all([
    entityVersionIds.length > 0
      ? tx.entityVersion.findMany({
          where: { id: { in: entityVersionIds }, entity: { tenantId } },
          select: { stage: true, publishedAt: true, entity: { select: { name: true } } },
        })
      : [],
    eventVersionIds.length > 0
      ? tx.eventSpecVersion.findMany({
          where: { id: { in: eventVersionIds }, eventSpec: { tenantId } },
          select: { stage: true, publishedAt: true, eventSpec: { select: { name: true } } },
        })
      : [],
  ]);
  for (const t of entityTargets) classify(t, t.entity.name);
  for (const t of eventTargets) classify(t, t.eventSpec.name);
  return ok({ snapshots: [...snapshots].sort(), changed: [...changed].sort() });
}

/**
 * Promote the event's open snapshot to its release (`x.y.z_snapshot` → `x.y.z`, same row, frozen from then on) and point
 * `latestVersionId` at it. The stored AsyncAPI `document` and `resolvedSpec` are rewritten in the same UPDATE with `info.version` =
 * the released label (the only place the label appears in them; nothing is re-rendered, so the release is exactly what was saved).
 *
 * Refused when there is no snapshot (NO_SNAPSHOT), the draft differs from it (DRAFT_NOT_SAVED: the draft's own changes against the
 * snapshot, `draftChanged`), a pin no longer resolves (PUBLISH_BLOCKED, the save's own blockers), the snapshot is not
 * above the latest release (SNAPSHOT_NOT_AHEAD), or it references a snapshot (SNAPSHOT_REFERENCES, naming the entities / events).
 * The same row lock as a save serialises the two; a save that committed after this call first looked at the snapshot makes it a
 * CONFLICT (promote what you saw, or nothing).
 */
export async function promoteEvent(eventId: string, productId: string, ctx: ServiceContext): Promise<Result<EventVersionSummary>> {
  // Ownership, then the snapshot the caller is promoting as it is now (no lock): a save that lands before the lock below changes it.
  const seen = await guardRead(async () => {
    const owned = await assertOwnedEvent(ctx.prisma, eventId, productId);
    if (!owned.success) return owned;
    return ok(await ctx.prisma.eventSpecVersion.findFirst({
      where: { eventSpecId: eventId, stage: "SNAPSHOT" },
      select: { id: true, major: true, minor: true, patch: true, updatedAt: true },
    }));
  });
  if (!seen.success) return seen;

  return auditedWrite({
    action: "PROMOTE_VERSION", entityType: "EventSpec", entityId: eventId, userId: ctx.userId,
    run: async () => {
      try {
        return await ctx.prisma.$transaction(
          async (tx): Promise<Result<EventVersionSummary>> => {
            // The same row lock as a save: a save and a promote of one event never interleave.
            const locked = await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "event_specs" WHERE "id" = ${eventId} FOR UPDATE`;
            if (locked.length === 0) return notFound(eventId);

            const fresh = await loadEventSnapshot(tx, eventId);
            if (!fresh.success) return fresh;
            const open = fresh.data.openSnapshot;
            if (snapshotKey(seen.data, seen.data?.updatedAt) !== snapshotKey(open, open?.updatedAt)) return versionsMovedErr();
            const facts = await gatherPublishFacts(tx, fresh.data);
            if (!facts.success) return facts;

            const state = { latestRelease: facts.data.latestRelease, openSnapshot: facts.data.openSnapshot, draftDirty: facts.data.draftChanged };
            const basic = planPromote({ ...state, snapshotReferences: [] });
            if (!basic.success) return basic;
            // The save's blockers still hold for a release: a pin that no longer resolves is not released.
            if (facts.data.blockers.length > 0) {
              return err({
                code: "PUBLISH_BLOCKED",
                message: facts.data.blockers.map((b) => b.message).join("; "),
                details: { blockers: facts.data.blockers },
                suggestedFix: "Resolve every blocker, then promote again.",
              });
            }

            const refs = await snapshotReferences(tx, open!, fresh.data.event.tenantId);
            if (!refs.success) return refs;
            const plan = planPromote({ ...state, snapshotReferences: refs.data.snapshots, changedReferences: refs.data.changed });
            if (!plan.success) return plan;

            const stored = await tx.eventSpecVersion.findUniqueOrThrow({ where: { id: plan.data.snapshotId }, select: { document: true, resolvedSpec: true } });
            const document = withInfoVersion(stored.document, plan.data.label);
            if (!document) return err({ code: "DATA_CORRUPT", message: `The stored document of v${formatVersionLabel(open!, "SNAPSHOT")} is invalid` });
            const resolvedSpec = stored.resolvedSpec === null ? null : withInfoVersion(stored.resolvedSpec, plan.data.label);
            if (stored.resolvedSpec !== null && !resolvedSpec) {
              return err({ code: "DATA_CORRUPT", message: `The stored resolved spec of v${formatVersionLabel(open!, "SNAPSHOT")} is invalid` });
            }
            const updated = await tx.eventSpecVersion.updateMany({
              where: { id: plan.data.snapshotId, eventSpecId: eventId, stage: "SNAPSHOT" },
              data: {
                stage: "RELEASED",
                releasedAt: new Date(),
                releasedById: ctx.userId,
                document,
                ...(resolvedSpec ? { resolvedSpec } : {}),
              },
            });
            if (updated.count !== 1) return versionsMovedErr();

            await tx.eventSpec.update({ where: { id: eventId }, data: { latestVersionId: plan.data.snapshotId }, select: { id: true } });
            const version = await tx.eventSpecVersion.findUniqueOrThrow({ where: { id: plan.data.snapshotId }, select: VERSION_SUMMARY_SELECT });
            return ok(toEventVersionSummary(version));
          },
          { timeout: 15_000 }
        );
      } catch (e: unknown) {
        if (isConcurrentWriteFailure(e)) return versionsMovedErr();
        throw e;
      }
    },
  });
}

/** Stored versions: the open snapshot first, then the releases, newest first. */
export async function listEventVersions(eventId: string, productId: string, ctx: ServiceContext): Promise<Result<EventVersionSummary[]>> {
  return guardRead(async () => {
    const owned = await assertOwnedEvent(ctx.prisma, eventId, productId);
    if (!owned.success) return owned;
    const rows = await ctx.prisma.eventSpecVersion.findMany({ where: { eventSpecId: eventId }, orderBy: { sequence: "desc" }, select: VERSION_SUMMARY_SELECT });
    const ordered = [...rows.filter((v) => v.stage === "SNAPSHOT"), ...rows.filter((v) => v.stage !== "SNAPSHOT")];
    return ok(ordered.map(toEventVersionSummary));
  });
}

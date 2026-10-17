// src/services/events/event-publish.service.ts
// Publish of a self-contained event (spec 2026-10-15-events-self-contained-design §5 / §10): an immutable version holding the fully
// resolved AsyncAPI document, the v2 draft it came from, the library traits frozen at that moment and the stored `ResolvedEventSpec`
// that other events' external references reuse. Structure: an unlocked `prepare` plans and renders, then ONE transaction locks,
// re-verifies everything the plan depended on and only then writes.
import { isDeepStrictEqual } from "node:util";
import { Prisma, type PrismaClient } from "@/generated/prisma/client";
import { isBumpKind, MAX_CHANGE_SUMMARY, type BumpKind, type PublishInput } from "@/lib/entity-versioning/types";
import {
  GENERIC_VALIDATION_FAILURE, normalizeDiagnostics, type Diagnostic, type EmitOutput, type ResolvedEventSpec,
} from "@/lib/event-specs";
import { classifyEventBump } from "@/lib/events/document/bump";
import { collectDocumentEdges } from "@/lib/events/document/edges";
import { effectiveRepresentationFormats } from "@/lib/events/document/representation";
import {
  analyzeVersionedPublish, planVersionedPublish, provisionalLabel,
  type EventPublishAnalysis, type EventPublishBlocker, type VersionedPublishInput,
} from "@/lib/events/publish-plan";
import type { EventVersionSummary } from "@/lib/events/types";
import { ok, err, type Result, type ServiceError } from "@/types/result";
import type { ServiceContext } from "@/types/service-context";
import { getSharedArtifactRenderer } from "./artifact-renderer";
import { auditedWrite } from "./audited";
import { emitResolved, type EmitDeps } from "./event-emit.service";
import { gatherPublishFacts, type PublishFacts } from "./event-publish-facts";
import { loadEventSnapshot, resolveEventSnapshot, type EventSnapshot } from "./event-snapshot";
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
    latest: facts.data.latest,
    hasChanges: facts.data.hasChanges,
    blockers: facts.data.blockers,
    bump: facts.data.classifiable && facts.data.previous ? classifyEventBump(facts.data.previous, facts.data.current) : null,
  };
  const planned = planVersionedPublish(base, requested);
  const label = planned.success ? planned.data.label : provisionalLabel(analyzeVersionedPublish(base));

  const draft = await resolveEventSnapshot(snapshot.data, deps.renderer ?? getSharedArtifactRenderer(ctx.prisma), label);
  let output: EmitOutput | null = null;
  let diagnostics = normalizeDiagnostics(draft.diagnostics);
  if (draft.resolved) {
    const out = await emitResolved(draft.resolved, snapshot.data.event.specType, deps);
    if (!out.success) return emitFailure(eventId, out.error);
    output = out.data;
    diagnostics = normalizeDiagnostics([...draft.diagnostics, ...out.data.diagnostics]);
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
 * Ownership, then an unlocked plan (read, render, emit, validate — nothing is written or audited on a failure there), then ONE
 * transaction that re-verifies everything under the locks and aborts with a retryable CONFLICT when the plan was computed from
 * anything that has since changed.
 *
 * Lock contract (spec §10): `event_specs` row FOR UPDATE → the pinned entities' rows `FOR SHARE ... ORDER BY id` → re-read the
 * snapshot and the facts and compare → only then write the version row, the frozen edges and the event's pointer. A save of the
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
  if (opts.bump !== undefined && !isBumpKind(opts.bump)) return err({ code: "VALIDATION_ERROR", message: "bump must be MAJOR or MINOR" });
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

            const version = await tx.eventSpecVersion.create({
              data: {
                eventSpecId: eventId,
                major: plan.data.version.major,
                minor: plan.data.version.minor,
                sequence: plan.data.sequence,
                document: output.document as unknown as Prisma.InputJsonValue, // the assembled AsyncAPI, info.version = label
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
              },
              select: VERSION_SUMMARY_SELECT,
            });
            await replaceReferences(tx, { kind: "EVENT_SPEC_VERSION", id: version.id }, collectDocumentEdges(snapshot.document), false);
            await tx.eventSpec.update({ where: { id: eventId }, data: { latestVersionId: version.id, hasUnpublishedChanges: false }, select: { id: true } });
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

export async function listEventVersions(eventId: string, productId: string, ctx: ServiceContext): Promise<Result<EventVersionSummary[]>> {
  return guardRead(async () => {
    const owned = await assertOwnedEvent(ctx.prisma, eventId, productId);
    if (!owned.success) return owned;
    const rows = await ctx.prisma.eventSpecVersion.findMany({ where: { eventSpecId: eventId }, orderBy: { sequence: "desc" }, select: VERSION_SUMMARY_SELECT });
    return ok(rows.map(toEventVersionSummary));
  });
}

import { isDeepStrictEqual } from "node:util";
import { Prisma, type PrismaClient } from "@/generated/prisma/client";
import { resolveScope } from "@/lib/asset-scope";
import { isBumpKind, type BumpKind, type PublishInput } from "@/lib/entity-versioning/types";
import { normalizeDiagnostics, type Diagnostic, type EmitOutput, type EventSpecDocument, type ResolvedChannel } from "@/lib/event-specs";
import { stableStringify, type EventSpecBumpSide, type MessageVersionInfo } from "@/lib/events/bump-rules";
import { assertOwnedBy } from "@/lib/events/ownership";
import {
  analyzeVersionedPublish, eventSpecPublishInput, planVersionedPublish, provisionalLabel,
  type EventPublishAnalysis, type EventSpecPublishFacts, type VersionedPublishInput,
} from "@/lib/events/publish-plan";
import type { EventVersionSummary, FrozenTrait } from "@/lib/events/types";
import { assertNameAvailable } from "@/services/name-registry.service";
import { ok, err, type Result, type ServiceError } from "@/types/result";
import type { ServiceContext } from "@/types/service-context";
import { getSharedArtifactRenderer } from "./artifact-renderer";
import { auditedWrite } from "./audited";
import { emitResolved, type EmitDeps } from "./event-spec-emit.service";
import { loadDraftSnapshot, resolveSnapshot, type DraftSnapshot } from "./event-spec-resolver";
import { replaceReferences } from "./schema-references";
import { guardRead, requireId } from "./service-guards";
import { toEventVersionSummary, VERSION_SUMMARY_SELECT } from "./version-summary";

type Db = PrismaClient | Prisma.TransactionClient;
type Facts = Omit<EventSpecPublishFacts, "diagnostics">;

const notFound = (specId: string) => err({ code: "NOT_FOUND", message: `Event spec "${specId}" not found` });
const isString = (v: string | undefined): v is string => typeof v === "string";

/** The retryable "something changed under the publish" failure (lock re-verification, unique index, FK to a removed row). */
const changedDuringPublish = (message = "The event spec changed while publishing.") =>
  err({ code: "CONFLICT", message, suggestedFix: "Reload the event spec and publish again." });
const PINNED_MESSAGE_REMOVED = "A message pinned by this spec was removed; reload and retry";

/**
 * Prisma codes that mean a concurrent writer beat this publish: P2002 (unique version label / sequence), P2003 (FK to a row a
 * concurrent delete removed — auditedWrite would misreport it as IN_USE) and P2034 (write conflict / deadlock).
 */
const CONCURRENT_WRITE_CODES = new Set(["P2002", "P2003", "P2034"]);
function isConcurrentWriteFailure(e: unknown): boolean {
  const code = typeof e === "object" && e !== null ? (e as { code?: unknown }).code : undefined;
  return typeof code === "string" && CONCURRENT_WRITE_CODES.has(code);
}

/**
 * Spec §10 ownership, checked ONCE per call before anything is read, rendered or written (a spec's level columns never change):
 * the page's product must own the spec — the same scope + `assertOwnedBy` checks as `updateEventSpecDocument` (unknown spec or
 * product → NOT_FOUND, another product's or tenant's spec → FORBIDDEN). Neither error carries `details`, and the label is the
 * caller's own id (never the row's name), so a foreign spec's name, document, versions or publishers never leak.
 *
 * Same shape as `assertOwnedMessage` in message-publish.service.ts (that helper is message-specific and private there).
 */
async function assertOwnedEventSpec(db: PrismaClient, specId: string, productId: string): Promise<Result<void>> {
  const specIdOk = requireId(specId, "specId");
  if (!specIdOk.success) return specIdOk;
  const productIdOk = requireId(productId, "productId");
  if (!productIdOk.success) return productIdOk;
  const scope = await resolveScope(db, { level: "PRODUCT", productId: productIdOk.data });
  if (!scope.success) return scope;
  const row = await db.eventSpec.findUnique({ where: { id: specId }, select: { tenantId: true, domainId: true, productId: true } });
  if (!row) return notFound(specId);
  return assertOwnedBy(row, scope.data, `Event spec "${specId}"`);
}

function bumpSide(
  document: EventSpecDocument,
  channels: ResolvedChannel[],
  traits: FrozenTrait[],
  versionIds: string[],
  info: Record<string, MessageVersionInfo>
): EventSpecBumpSide {
  return {
    document,
    channelAddresses: Object.fromEntries(channels.map((c) => [c.id, c.address])),
    channelNames: Object.fromEntries(channels.map((c) => [c.id, c.name])),
    messageVersions: Object.fromEntries(versionIds.filter((id) => info[id]).map((id) => [id, info[id]])),
    traitNames: Object.fromEntries(traits.map((t) => [t.id, t.name])),
  };
}

async function gatherFacts(db: Db, snapshot: DraftSnapshot): Promise<Result<Facts>> {
  const { latest, spec } = snapshot;
  const published = snapshot.messages.filter((m) => !m.unpublished).map((m) => m.id);
  // D8: live Channel / Trait edits count as spec changes (compare the live rows with the copies frozen into the latest version).
  const liveChanged = latest !== null
    && (stableStringify(latest.frozenChannels) !== stableStringify(snapshot.channels) || stableStringify(latest.frozenTraits) !== stableStringify(snapshot.traits));
  const name = await assertNameAvailable(db, {
    name: spec.name, tenantId: spec.tenantId, domainId: spec.domainId, productId: spec.productId, exclude: { kind: "eventSpec", id: spec.id },
  });
  if (!name.success && name.error.code !== "NAME_CONFLICT") return name;
  return ok({
    latest: latest ? { major: latest.major, minor: latest.minor, sequence: latest.sequence } : null,
    hasChanges: spec.hasUnpublishedChanges || liveChanged,
    previous: latest ? bumpSide(latest.sourceDocument, latest.frozenChannels, latest.frozenTraits, latest.messageVersionIds, snapshot.messageVersionInfo) : null,
    current: bumpSide(snapshot.document, snapshot.channels, snapshot.traits, published, snapshot.messageVersionInfo),
    unresolved: snapshot.unresolved,
    unpublishedMessages: snapshot.messages.filter((m) => m.unpublished).map((m) => ({ id: m.messageId, name: m.name })),
    nameConflict: name.success ? null : name.error.message,
  });
}

interface Prepared {
  snapshot: DraftSnapshot;
  facts: Facts;
  /** The planner input including the emission's validation errors: every blocker together. */
  input: VersionedPublishInput;
  output: EmitOutput | null;
  diagnostics: Diagnostic[];
}

const GENERIC_EMIT_FAILURE = "The event spec could not be validated. Try again; if it keeps failing, contact an administrator.";

/**
 * The adapter's own failures (a validator or the @asyncapi/parser threw) carry raw exception text: it is logged server-side
 * only and the browser gets a generic message under the same code (R67).
 */
function emitFailure(specId: string, error: ServiceError): Result<never> {
  console.error(`[event-spec-publish] emission of ${specId} failed (${error.code}):`, error.message);
  return err({ code: error.code, message: GENERIC_EMIT_FAILURE });
}

/**
 * D11: snapshot → facts → label → render + emit with `info.version` = label → every blocker together.
 * The label comes from the planner; when the plan fails (blockers, BUMP_TOO_LOW, …) the provisional label stands in so the
 * emission can still report its validation errors alongside the other blockers. Nothing is locked or written here.
 */
async function prepare(db: Db, specId: string, requested: BumpKind | undefined, ctx: ServiceContext, deps: EmitDeps): Promise<Result<Prepared>> {
  const snapshot = await loadDraftSnapshot(db, specId);
  if (!snapshot.success) return snapshot;
  const facts = await gatherFacts(db, snapshot.data);
  if (!facts.success) return facts;

  const base = eventSpecPublishInput({ ...facts.data, diagnostics: [] });
  const planned = planVersionedPublish(base, requested);
  const label = planned.success ? planned.data.label : provisionalLabel(analyzeVersionedPublish(base));

  const draft = await resolveSnapshot(snapshot.data, deps.renderer ?? getSharedArtifactRenderer(ctx.prisma), label);
  let output: EmitOutput | null = null;
  let diagnostics = draft.diagnostics;
  if (draft.resolved) {
    const out = await emitResolved(draft.resolved, snapshot.data.spec.specType, deps);
    if (!out.success) return emitFailure(specId, out.error);
    output = out.data;
    diagnostics = normalizeDiagnostics([...draft.diagnostics, ...out.data.diagnostics]);
  }
  // With unresolved draft references the resolver reports only those (same ids and pointers as the facts' UNRESOLVED_REFERENCE
  // blockers). Otherwise every error counts — including a renderer failure that happens to use the UNRESOLVED_REFERENCE code.
  const emitted = snapshot.data.unresolved.length > 0 ? [] : diagnostics;
  return ok({ snapshot: snapshot.data, facts: facts.data, input: eventSpecPublishInput({ ...facts.data, diagnostics: emitted }), output, diagnostics });
}

export async function previewEventSpecPublish(specId: string, productId: string, ctx: ServiceContext, deps: EmitDeps = {}): Promise<Result<EventPublishAnalysis>> {
  return guardRead(async () => {
    const owned = await assertOwnedEventSpec(ctx.prisma, specId, productId);
    if (!owned.success) return owned;
    const prepared = await prepare(ctx.prisma, specId, undefined, ctx, deps);
    if (!prepared.success) return prepared;
    return ok(analyzeVersionedPublish(prepared.data.input));
  });
}

/**
 * Mirrors `publishMessage`: ownership, then an unlocked plan (read, render, emit, validate — nothing is written or audited on a
 * failure there), then ONE transaction that re-verifies everything under the locks and aborts with a retryable CONFLICT when the
 * plan was computed from anything that has since changed.
 *
 * Lock contract (R57 / R60, see `deleteMessage`): `event_specs` row FOR UPDATE → the pinned messages' rows
 * `FOR SHARE ... ORDER BY id` → verify every pinned message version still exists → only then write the version row, the frozen
 * edges and the spec pointer. A concurrent message delete (which takes `messages` FOR UPDATE) therefore either finished first
 * (this publish fails the verification) or waits for this commit (and then sees the pinning version and returns IN_USE).
 */
export async function publishEventSpec(specId: string, productId: string, input: PublishInput, ctx: ServiceContext, deps: EmitDeps = {}): Promise<Result<EventVersionSummary>> {
  // Untrusted action input: null / non-object → no options; a bump or summary of the wrong type is rejected, never coerced.
  const opts: Partial<PublishInput> = typeof input === "object" && input !== null ? input : {};
  if (opts.bump !== undefined && !isBumpKind(opts.bump)) return err({ code: "VALIDATION_ERROR", message: "bump must be MAJOR or MINOR" });
  if (opts.changeSummary !== undefined && opts.changeSummary !== null && typeof opts.changeSummary !== "string") {
    return err({ code: "VALIDATION_ERROR", message: "Change summary must be a string" });
  }
  const bump = opts.bump;
  const changeSummary = opts.changeSummary?.trim() ? opts.changeSummary.trim() : null;

  // Phase 1: ownership (once — scope never changes) + the unlocked plan.
  const prepared = await guardRead(async () => {
    const owned = await assertOwnedEventSpec(ctx.prisma, specId, productId);
    if (!owned.success) return owned;
    return prepare(ctx.prisma, specId, bump, ctx, deps);
  });
  if (!prepared.success) return prepared;
  const plan = planVersionedPublish(prepared.data.input, bump);
  if (!plan.success) return plan; // PUBLISH_BLOCKED (all blockers), BUMP_TOO_LOW, INVALID_PLAN_INPUT — straight to the UI
  const { snapshot, facts, output, diagnostics } = prepared.data;
  if (!output) return err({ code: "PUBLISH_BLOCKED", message: "The event spec could not be emitted" });

  const messageVersionIds = [...new Set(snapshot.messages.filter((m) => !m.unpublished).map((m) => m.id))];
  const messageIds = [...new Set(messageVersionIds.map((id) => snapshot.messageVersionInfo[id]?.messageId).filter(isString))];

  return auditedWrite({
    action: "PUBLISH_VERSION", entityType: "EventSpec", entityId: specId, userId: ctx.userId,
    run: async () => {
      try {
        return await ctx.prisma.$transaction(
          async (tx): Promise<Result<EventVersionSummary>> => {
            const locked = await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "event_specs" WHERE "id" = ${specId} FOR UPDATE`;
            if (locked.length === 0) return notFound(specId);

            if (messageIds.length > 0) {
              await tx.$queryRaw`SELECT "id" FROM "messages" WHERE "id" IN (${Prisma.join(messageIds)}) ORDER BY "id" FOR SHARE`;
            }
            const pinned = await tx.messageVersion.findMany({ where: { id: { in: messageVersionIds } }, select: { id: true } });
            if (pinned.length !== messageVersionIds.length) return changedDuringPublish(PINNED_MESSAGE_REMOVED);

            // Re-verify under the locks: the draft (updatedAt / latest version), the live channels and traits the document was
            // rendered with, the message versions, the facts (name, changes) — the plan and the emitted document are only valid
            // for exactly this state.
            const fresh = await loadDraftSnapshot(tx, specId);
            if (!fresh.success) return fresh;
            const freshFacts = await gatherFacts(tx, fresh.data);
            if (!freshFacts.success) return freshFacts;
            if (!isDeepStrictEqual(fresh.data, snapshot) || !isDeepStrictEqual(freshFacts.data, facts)) return changedDuringPublish();

            const version = await tx.eventSpecVersion.create({
              data: {
                eventSpecId: specId,
                major: plan.data.version.major,
                minor: plan.data.version.minor,
                sequence: plan.data.sequence,
                document: output.document as unknown as Prisma.InputJsonValue,
                sourceDocument: snapshot.document as unknown as Prisma.InputJsonValue,
                frozenChannels: snapshot.channels as unknown as Prisma.InputJsonValue,
                frozenTraits: snapshot.traits as unknown as Prisma.InputJsonValue,
                messageVersionIds,
                changeKind: plan.data.changeKind,
                compatReport: { reasons: plan.data.reasons, diagnostics: diagnostics.filter((d) => d.severity !== "error") } as unknown as Prisma.InputJsonValue,
                changeSummary,
                publishedById: ctx.userId,
              },
              select: VERSION_SUMMARY_SELECT,
            });
            await replaceReferences(
              tx,
              { kind: "EVENT_SPEC_VERSION", id: version.id },
              messageVersionIds.map((toId) => ({ role: "MESSAGE" as const, toKind: "MESSAGE_VERSION" as const, toId })),
              false
            );
            await tx.eventSpec.update({ where: { id: specId }, data: { latestVersionId: version.id, hasUnpublishedChanges: false }, select: { id: true } });
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

export async function listEventSpecVersions(specId: string, productId: string, ctx: ServiceContext): Promise<Result<EventVersionSummary[]>> {
  return guardRead(async () => {
    const owned = await assertOwnedEventSpec(ctx.prisma, specId, productId);
    if (!owned.success) return owned;
    const rows = await ctx.prisma.eventSpecVersion.findMany({ where: { eventSpecId: specId }, orderBy: { sequence: "desc" }, select: VERSION_SUMMARY_SELECT });
    return ok(rows.map(toEventVersionSummary));
  });
}

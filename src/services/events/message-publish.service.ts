import { isDeepStrictEqual } from "node:util";
import type { PrismaClient, Prisma } from "@/generated/prisma/client";
import { formatVersionLabel, parseVersionLabel } from "@/lib/entity-versioning/version-math";
import type { PublishInput } from "@/lib/entity-versioning/types";
import { readMessageSpec, validateMessageSpec } from "@/lib/events/catalog-specs";
import {
  analyzeVersionedPublish, messagePublishInput, planVersionedPublish,
  type EventPublishAnalysis, type MessagePublishState, type PinState,
} from "@/lib/events/publish-plan";
import type { EventVersionSummary, MessageResolvedSpec, PinRole } from "@/lib/events/types";
import { assertNameAvailable } from "@/services/name-registry.service";
import { auditedWrite } from "@/services/events/audited";
import { pinEdges, replaceReferences } from "@/services/events/schema-references";
import { toEventVersionSummary, VERSION_SUMMARY_SELECT } from "@/services/events/version-summary";
import { ok, err, type Result } from "@/types/result";
import type { ServiceContext } from "@/types/service-context";

type Db = PrismaClient | Prisma.TransactionClient;

const notFound = (messageId: string) => err({ code: "NOT_FOUND", message: `Message "${messageId}" not found` });
const isString = (v: string | null): v is string => typeof v === "string";

/** The retryable "something changed under the publish" failure (lock re-verification, unique index, FK to a removed row). */
const changedDuringPublish = () =>
  err({ code: "CONFLICT", message: "Message changed during publish, try again", suggestedFix: "Reload the message and publish again." });

/**
 * Prisma codes that mean a concurrent writer beat this publish: P2002 (unique version label / sequence), P2003 (FK to a row a
 * concurrent delete removed — auditedWrite would misreport it as IN_USE) and P2034 (write conflict / deadlock).
 */
const CONCURRENT_WRITE_CODES = new Set(["P2002", "P2003", "P2034"]);
function isConcurrentWriteFailure(e: unknown): boolean {
  const code = typeof e === "object" && e !== null ? (e as { code?: unknown }).code : undefined;
  return typeof code === "string" && CONCURRENT_WRITE_CODES.has(code);
}

export async function loadMessagePublishState(db: Db, messageId: string): Promise<Result<MessagePublishState>> {
  const row = await db.message.findUnique({
    where: { id: messageId },
    select: {
      id: true, name: true, spec: true, hasUnpublishedChanges: true, tenantId: true, domainId: true, productId: true,
      payloadEntityId: true, payloadEntityVersionId: true, headersEntityId: true, headersEntityVersionId: true, keyEntityId: true, keyEntityVersionId: true,
      latestVersion: { select: { major: true, minor: true, sequence: true, resolvedSpec: true } },
    },
  });
  if (!row) return notFound(messageId);
  const spec = readMessageSpec(row.spec);
  const latestResolved = row.latestVersion ? (row.latestVersion.resolvedSpec as unknown as MessageResolvedSpec) : null;

  const roles: Array<[PinRole, string | null, string | null]> = [
    ["payload", row.payloadEntityId, row.payloadEntityVersionId],
    ["headers", row.headersEntityId, row.headersEntityVersionId],
    ["key", row.keyEntityId, row.keyEntityVersionId],
  ];
  const used = roles.filter((r): r is [PinRole, string, string | null] => r[1] !== null);
  const traitIds = [...new Set([...spec.traitIds, ...(latestResolved?.spec.traitIds ?? [])])];
  const [entities, versions, traits] = await Promise.all([
    db.entity.findMany({ where: { id: { in: used.map((r) => r[1]) } }, select: { id: true, name: true, latestVersion: { select: { major: true, minor: true } } } }),
    db.entityVersion.findMany({ where: { id: { in: used.map((r) => r[2]).filter(isString) } }, select: { id: true, entityId: true, major: true, minor: true } }),
    traitIds.length > 0 ? db.trait.findMany({ where: { id: { in: traitIds } }, select: { id: true, name: true, kind: true } }) : Promise.resolve([]),
  ]);

  const pins: PinState[] = used.map(([role, entityId, versionId]) => {
    const entity = entities.find((e) => e.id === entityId);
    const version = versionId ? versions.find((v) => v.id === versionId && v.entityId === entityId) : undefined;
    return {
      role,
      entityId,
      entityName: entity?.name ?? null,
      version: version ? { id: version.id, label: formatVersionLabel(version), major: version.major } : null,
      latestLabel: entity?.latestVersion ? formatVersionLabel(entity.latestVersion) : null,
    };
  });

  const name = await assertNameAvailable(db, {
    name: row.name, tenantId: row.tenantId, domainId: row.domainId, productId: row.productId, exclude: { kind: "message", id: row.id },
  });
  if (!name.success && name.error.code !== "NAME_CONFLICT") return name;

  return ok({
    name: row.name,
    hasUnpublishedChanges: row.hasUnpublishedChanges,
    spec,
    pins,
    missingTraitIds: spec.traitIds.filter((id) => !traits.some((t) => t.id === id && t.kind === "MESSAGE")),
    traitNames: Object.fromEntries(traits.map((t) => [t.id, t.name])),
    specProblems: validateMessageSpec(spec),
    nameConflict: name.success ? null : name.error.message,
    latest: row.latestVersion && latestResolved
      ? { major: row.latestVersion.major, minor: row.latestVersion.minor, sequence: row.latestVersion.sequence, resolved: latestResolved }
      : null,
  });
}

export async function previewMessagePublish(messageId: string, ctx: ServiceContext): Promise<Result<EventPublishAnalysis>> {
  const state = await loadMessagePublishState(ctx.prisma, messageId);
  if (!state.success) return state;
  return ok(analyzeVersionedPublish(messagePublishInput(state.data).input));
}

type PlanInputs = ReturnType<typeof messagePublishInput>;

async function readPlanInputs(db: Db, messageId: string): Promise<Result<PlanInputs>> {
  const state = await loadMessagePublishState(db, messageId);
  return state.success ? ok(messagePublishInput(state.data)) : state;
}

/**
 * Mirrors Track B's `publishEntity`: plan from an unlocked read first (fail fast on blockers, no transaction, nothing audited),
 * then ONE transaction that locks the message row, re-reads everything and aborts with a retryable CONFLICT when the planning
 * inputs (spec, pins and the pinned entity versions that still exist, latest version, blockers, bump) are not exactly what the
 * plan was computed from. A concurrent publish therefore loses with CONFLICT instead of stacking a second version.
 *
 * Lock contract (see `deleteMessage`): no `FOR SHARE` here. Inserting the `message_versions` row takes `FOR KEY SHARE` on the
 * message row through the FK and this transaction updates `messages`, so it serializes against a delete (`FOR UPDATE`) on its
 * own — whoever locks the row first wins, and a delete that wins makes the re-read below return NOT_FOUND.
 */
export async function publishMessage(messageId: string, input: PublishInput, ctx: ServiceContext): Promise<Result<EventVersionSummary>> {
  const changeSummary = input.changeSummary?.trim() ? input.changeSummary.trim() : null;

  let planned: Result<PlanInputs>;
  try {
    planned = await readPlanInputs(ctx.prisma, messageId);
  } catch (e: unknown) {
    return err({ code: "DB_ERROR", message: e instanceof Error ? e.message : "Publish failed" });
  }
  if (!planned.success) return planned;
  const prePlan = planVersionedPublish(planned.data.input, input.bump);
  if (!prePlan.success) return prePlan;
  const plannedFrom = planned.data;

  return auditedWrite({
    action: "PUBLISH_VERSION", entityType: "Message", entityId: messageId, userId: ctx.userId,
    run: async () => {
      try {
        return await ctx.prisma.$transaction(
          async (tx): Promise<Result<EventVersionSummary>> => {
            const locked = await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "messages" WHERE "id" = ${messageId} FOR UPDATE`;
            if (locked.length === 0) return notFound(messageId);

            const current = await readPlanInputs(tx, messageId);
            if (!current.success) return current;
            // Re-verify under the lock: spec, pins (incl. that the pinned entity versions still exist), latest version, blockers.
            if (!isDeepStrictEqual(current.data, plannedFrom)) return changedDuringPublish();

            const plan = planVersionedPublish(current.data.input, input.bump);
            if (!plan.success) return plan;
            const resolved = current.data.resolved;
            if (!resolved) return err({ code: "PUBLISH_BLOCKED", message: "The message pins could not be resolved" });

            const version = await tx.messageVersion.create({
              data: {
                messageId,
                major: plan.data.version.major,
                minor: plan.data.version.minor,
                sequence: plan.data.sequence,
                resolvedSpec: resolved as unknown as Prisma.InputJsonValue,
                payloadEntityVersionId: resolved.payload.entityVersionId,
                headersEntityVersionId: resolved.headers?.entityVersionId ?? null,
                keyEntityVersionId: resolved.key?.entityVersionId ?? null,
                changeKind: plan.data.changeKind,
                compatReport: { reasons: plan.data.reasons },
                changeSummary,
                publishedById: ctx.userId,
              },
              select: VERSION_SUMMARY_SELECT,
            });
            await replaceReferences(
              tx,
              { kind: "MESSAGE_VERSION", id: version.id },
              pinEdges({ payload: resolved.payload.entityVersionId, headers: resolved.headers?.entityVersionId ?? null, key: resolved.key?.entityVersionId ?? null }),
              false
            );
            await tx.message.update({ where: { id: messageId }, data: { latestVersionId: version.id, hasUnpublishedChanges: false }, select: { id: true } });
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

export async function listMessageVersions(messageId: string, ctx: ServiceContext): Promise<Result<EventVersionSummary[]>> {
  const exists = await ctx.prisma.message.findUnique({ where: { id: messageId }, select: { id: true } });
  if (!exists) return notFound(messageId);
  const rows = await ctx.prisma.messageVersion.findMany({ where: { messageId }, orderBy: { sequence: "desc" }, select: VERSION_SUMMARY_SELECT });
  return ok(rows.map(toEventVersionSummary));
}

export async function getMessageVersion(
  messageId: string,
  label: string,
  ctx: ServiceContext
): Promise<Result<{ summary: EventVersionSummary; resolvedSpec: MessageResolvedSpec }>> {
  const parsed = parseVersionLabel(label);
  if (!parsed.success) return parsed;
  const row = await ctx.prisma.messageVersion.findUnique({
    where: { messageId_major_minor: { messageId, major: parsed.data.major, minor: parsed.data.minor } },
    select: { ...VERSION_SUMMARY_SELECT, resolvedSpec: true },
  });
  if (!row) return err({ code: "NOT_FOUND", message: `Version ${formatVersionLabel(parsed.data)} of message "${messageId}" not found` });
  return ok({ summary: toEventVersionSummary(row), resolvedSpec: row.resolvedSpec as unknown as MessageResolvedSpec });
}

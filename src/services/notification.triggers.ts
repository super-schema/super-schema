/**
 * Notification Triggers — the helpers that create in-app notifications AND dispatch webhook events for governance, annotation and emission
 * events.
 *
 * Each is called by a write path AFTER its write has committed, through `runAfterResponse` (src/lib/after-response.ts), so that a notification
 * or a delivery never delays or fails the write. The callers: an emission (the REST emit route and the UI's emit and generate actions, through
 * `notifyEntityEmitted`) and a governance decision (through `notifyGovernanceRequestDecided`). The other triggers have no production caller yet:
 * nothing raises a governance request (KD-022), and the app writes no annotation (`createAnnotation` is not mounted).
 *
 * Who is told. An in-app notification goes only to a user whose roles cover the entity it is about (`entity.read`, or `governance.decide` for an
 * approval): a user of another tenant, a user whose roles no longer cover the entity and a disabled user hear nothing. A webhook event goes to
 * every active endpoint of the tenant of the entity that subscribed to it (an endpoint belongs to one tenant, and `data.tenantId` names it).
 *
 * Every trigger catches its own failures and logs them to console.error: it never throws, and a failed notification does not stop the webhook
 * event (or the other way round).
 */

import { can, type ActionId, type ResourceRef } from "@/lib/access";
import { isServiceUserId } from "@/lib/access/api-key";
import { loadActorAssignments } from "@/lib/access/granter";
import { prisma } from "@/lib/db";
import { createNotification } from "@/services/notification.service";
import { dispatchEvent } from "@/services/webhook.service";
import type { CreateNotificationInput, EntityRef } from "@/types/schemas/notification";
import type { WebhookPayload } from "@/types/schemas/webhook";
import type { ServiceContext } from "@/types/service-context";

// ---------------------------------------------------------------------------
// Shared steps
// ---------------------------------------------------------------------------

/** Where the entity lives (tenant, domain, product), or null when there is no such entity. */
async function placeOfEntity(entityId: string): Promise<ResourceRef | null> {
  const row = await prisma.entity.findUnique({
    where: { id: entityId },
    select: { tenantId: true, domainId: true, productId: true, product: { select: { domainId: true } } },
  });
  return row ? { tenantId: row.tenantId, domainId: row.domainId ?? row.product?.domainId ?? null, productId: row.productId ?? null } : null;
}

/** The users among `userIds` whose roles let them do `action` on `place`. A user who does not exist, is disabled or holds no such role is not one. */
async function coveredUsers(userIds: readonly string[], action: ActionId, place: ResourceRef): Promise<string[]> {
  const covered: string[] = [];
  for (const userId of [...new Set(userIds)]) {
    const assignments = await loadActorAssignments(prisma, userId);
    if (assignments !== null && can(assignments, action, place)) covered.push(userId);
  }
  return covered;
}

/** One in-app notification to each covered user. A failure is logged; it neither throws nor stops the notifications of the other users. */
async function notifyUsers(
  userIds: readonly string[],
  action: ActionId,
  place: ResourceRef,
  notification: Omit<CreateNotificationInput, "userId">,
  ctx: ServiceContext,
  label: string
): Promise<void> {
  const users = await coveredUsers(userIds, action, place).catch((error: unknown) => {
    console.error(`${label} failed:`, error);
    return [];
  });
  for (const userId of users) {
    try {
      const created = await createNotification({ ...notification, userId }, ctx);
      if (!created.success) console.error(`${label} failed:`, created.error.message);
    } catch (error) {
      console.error(`${label} failed:`, error);
    }
  }
}

/** The event to every active endpoint that subscribed to it. A failure is logged, never thrown. */
async function sendEvent(payload: WebhookPayload, label: string): Promise<void> {
  try {
    await dispatchEvent(payload);
  } catch (error) {
    console.error(`${label} failed:`, error);
  }
}

// ---------------------------------------------------------------------------
// Governance — Approval Request
// ---------------------------------------------------------------------------

/** A breaking change needs a decision: the stewards who may decide it (`governance.decide` over the entity) hear of it, and the event is dispatched. */
export async function notifyGovernanceApprovalRequest(
  entityId: string,
  entityName: string,
  version: string,
  _domainId: string,
  stewardUserIds: string[],
  ctx: ServiceContext
): Promise<void> {
  try {
    const place = await placeOfEntity(entityId);
    if (!place) return;

    await notifyUsers(
      stewardUserIds,
      "governance.decide",
      place,
      {
        type: "APPROVAL_REQUEST",
        title: `Approval needed: ${entityName} v${version} — breaking change`,
        body: `A breaking change in ${entityName} requires your approval as a domain steward.`,
        entityRef: { entityId, versionId: version },
      },
      ctx,
      "Governance approval request notification"
    );

    await sendEvent(
      {
        event: "governance.request.created",
        timestamp: new Date().toISOString(),
        data: { tenantId: place.tenantId, entityId, entityName, version },
      },
      "Governance approval request webhook"
    );
  } catch (error) {
    console.error(
      "Failed to send governance approval request notifications:",
      error
    );
  }
}

// ---------------------------------------------------------------------------
// Governance — Decision
// ---------------------------------------------------------------------------

/** A decision on a request: the requestor hears of it (if their roles still cover the entity), and `governance.request.approved|rejected` is dispatched. */
export async function notifyGovernanceDecision(
  requestorId: string,
  entityName: string,
  decision: "approved" | "rejected",
  stewardName: string,
  entityRef: EntityRef,
  ctx: ServiceContext
): Promise<void> {
  try {
    const place = await placeOfEntity(entityRef.entityId);
    if (!place) return;

    await notifyUsers(
      [requestorId],
      "entity.read",
      place,
      {
        type: "APPROVAL_DECISION",
        title: `Your change to ${entityName} was ${decision} by ${stewardName}`,
        body: `The governance review for ${entityName} has been completed. Decision: ${decision}.`,
        entityRef,
      },
      ctx,
      "Governance decision notification"
    );

    await sendEvent(
      {
        event: decision === "approved" ? "governance.request.approved" : "governance.request.rejected",
        timestamp: new Date().toISOString(),
        data: { tenantId: place.tenantId, entityId: entityRef.entityId, entityName, decision, stewardName },
      },
      "Governance decision webhook"
    );
  } catch (error) {
    console.error(
      "Failed to send governance decision notification:",
      error
    );
  }
}

// ---------------------------------------------------------------------------
// Annotation — @-mention
// ---------------------------------------------------------------------------

/** A comment tags users: each tagged user who can read the entity hears of it. */
export async function notifyAnnotationTag(
  taggedUserIds: string[],
  authorName: string,
  entityName: string,
  fieldName: string,
  entityRef: EntityRef,
  ctx: ServiceContext
): Promise<void> {
  try {
    const place = await placeOfEntity(entityRef.entityId);
    if (!place) return;

    await notifyUsers(
      taggedUserIds,
      "entity.read",
      place,
      {
        type: "ANNOTATION_TAG",
        title: `${authorName} tagged you on ${entityName}.${fieldName}`,
        body: `You were mentioned in a comment on ${entityName}.${fieldName}.`,
        entityRef,
      },
      ctx,
      "Annotation tag notification"
    );
  } catch (error) {
    console.error("Failed to send annotation tag notifications:", error);
  }
}

// ---------------------------------------------------------------------------
// Emission — Complete
// ---------------------------------------------------------------------------

/**
 * What an emission run did with its result: `preview` emits the entity without storing anything (the REST emit route, the UI's Emit);
 * `stored` generates a schema version for one target and keeps it. The payload carries it, so a receiver can tell the two apart.
 */
export type EmissionRun = "preview" | "stored";

/**
 * An emission of the entity to `targetCount` targets completed: its owner hears of it (if their roles still cover the entity), and `emission.completed`
 * is dispatched. The owner is not told of an emission they made themselves (`ctx.userId`); the endpoints are told either way.
 */
export async function notifyEmissionComplete(
  ownerId: string,
  entityName: string,
  version: string,
  targetCount: number,
  entityRef: EntityRef,
  ctx: ServiceContext,
  run: EmissionRun
): Promise<void> {
  try {
    const place = await placeOfEntity(entityRef.entityId);
    if (!place) return;

    await notifyUsers(
      ownerId === ctx.userId ? [] : [ownerId],
      "entity.read",
      place,
      {
        type: "CHANGE_COMPLETE",
        title: `${entityName} v${version} emitted to ${targetCount} ${targetCount === 1 ? "target" : "targets"}`,
        body: `The emission of ${entityName} v${version} has been completed successfully to ${targetCount} target(s).`,
        entityRef,
      },
      ctx,
      "Emission notification"
    );

    await sendEvent(
      {
        event: "emission.completed",
        timestamp: new Date().toISOString(),
        data: { tenantId: place.tenantId, entityId: entityRef.entityId, entityName, version, targetCount, run },
      },
      "Emission webhook"
    );
  } catch (error) {
    console.error(
      "Failed to send emission complete notification:",
      error
    );
  }
}

// ---------------------------------------------------------------------------
// The write paths' entry points: they hand over an id and the trigger reads the rest
// ---------------------------------------------------------------------------

/**
 * An emission of the entity succeeded (`targetCount` targets, none invalid), as `run` says. Called after the answer is sent: the entity is read
 * here, for its owner, its name and its version.
 */
export async function notifyEntityEmitted(entityId: string, targetCount: number, ctx: ServiceContext, run: EmissionRun): Promise<void> {
  try {
    const entity = await prisma.entity.findUnique({
      where: { id: entityId },
      select: { name: true, version: true, ownerId: true },
    });
    if (!entity) return;
    await notifyEmissionComplete(
      entity.ownerId,
      entity.name,
      String(entity.version),
      targetCount,
      { entityId, versionId: String(entity.version) },
      ctx,
      run
    );
  } catch (error) {
    console.error("Failed to send emission complete notification:", error);
  }
}

/**
 * A decision (`approved` or `rejected`) was committed on the governance request `requestId` by `deciderId`. Called after the answer is sent: the
 * request and the decider's name are read here.
 */
export async function notifyGovernanceRequestDecided(
  requestId: string,
  decision: "approved" | "rejected",
  deciderId: string,
  ctx: ServiceContext
): Promise<void> {
  try {
    const request = await prisma.governanceRequest.findUnique({
      where: { id: requestId },
      select: { entityId: true, entityName: true, versionId: true, requestedBy: true },
    });
    if (!request) return;

    // The decider's display name, never an e-mail address: the name goes to every endpoint that asked for the event. A user with no name is "a steward".
    let stewardName = "the API key";
    if (!isServiceUserId(deciderId)) {
      const decider = await prisma.user.findUnique({ where: { id: deciderId }, select: { name: true } });
      stewardName = decider?.name || "a steward";
    }

    await notifyGovernanceDecision(
      request.requestedBy,
      request.entityName,
      decision,
      stewardName,
      { entityId: request.entityId, versionId: request.versionId ?? undefined },
      ctx
    );
  } catch (error) {
    console.error("Failed to send governance decision notification:", error);
  }
}

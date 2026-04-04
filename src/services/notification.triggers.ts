/**
 * Notification Triggers — Fire-and-forget helpers that create in-app
 * notifications AND dispatch webhook events for governance/annotation/emission
 * events.
 *
 * All trigger functions are wrapped in try/catch — failures are logged to
 * console.error but never throw.
 */

import { createNotification } from "@/services/notification.service";
import { dispatchEvent } from "@/services/webhook.service";
import type { ServiceContext } from "@/types/service-context";
import type { EntityRef } from "@/types/schemas/notification";

// ---------------------------------------------------------------------------
// Governance — Approval Request
// ---------------------------------------------------------------------------

export async function notifyGovernanceApprovalRequest(
  entityId: string,
  entityName: string,
  version: string,
  _domainId: string,
  stewardUserIds: string[],
  ctx: ServiceContext
): Promise<void> {
  try {
    const entityRef: EntityRef = { entityId, versionId: version };

    for (const stewardId of stewardUserIds) {
      await createNotification(
        {
          userId: stewardId,
          type: "APPROVAL_REQUEST",
          title: `Approval needed: ${entityName} v${version} — breaking change`,
          body: `A breaking change in ${entityName} requires your approval as a domain steward.`,
          entityRef,
        },
        ctx
      );
    }

    // Dispatch webhook
    await dispatchEvent({
      event: "governance.request.created",
      timestamp: new Date().toISOString(),
      data: { entityId, entityName, version },
    });
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

export async function notifyGovernanceDecision(
  requestorId: string,
  entityName: string,
  decision: "approved" | "rejected",
  stewardName: string,
  entityRef: EntityRef,
  ctx: ServiceContext
): Promise<void> {
  try {
    await createNotification(
      {
        userId: requestorId,
        type: "APPROVAL_DECISION",
        title: `Your change to ${entityName} was ${decision} by ${stewardName}`,
        body: `The governance review for ${entityName} has been completed. Decision: ${decision}.`,
        entityRef,
      },
      ctx
    );

    // Dispatch webhook
    const webhookEvent =
      decision === "approved"
        ? "governance.request.approved"
        : "governance.request.rejected";

    await dispatchEvent({
      event: webhookEvent,
      timestamp: new Date().toISOString(),
      data: {
        entityId: entityRef.entityId,
        entityName,
        decision,
        stewardName,
      },
    });
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

export async function notifyAnnotationTag(
  taggedUserIds: string[],
  authorName: string,
  entityName: string,
  fieldName: string,
  entityRef: EntityRef,
  ctx: ServiceContext
): Promise<void> {
  try {
    for (const userId of taggedUserIds) {
      await createNotification(
        {
          userId,
          type: "ANNOTATION_TAG",
          title: `${authorName} tagged you on ${entityName}.${fieldName}`,
          body: `You were mentioned in a comment on ${entityName}.${fieldName}.`,
          entityRef,
        },
        ctx
      );
    }
  } catch (error) {
    console.error("Failed to send annotation tag notifications:", error);
  }
}

// ---------------------------------------------------------------------------
// Emission — Complete
// ---------------------------------------------------------------------------

export async function notifyEmissionComplete(
  ownerId: string,
  entityName: string,
  version: string,
  targetCount: number,
  entityRef: EntityRef,
  ctx: ServiceContext
): Promise<void> {
  try {
    await createNotification(
      {
        userId: ownerId,
        type: "CHANGE_COMPLETE",
        title: `${entityName} v${version} emitted to ${targetCount} targets`,
        body: `The emission of ${entityName} v${version} has been completed successfully to ${targetCount} target(s).`,
        entityRef,
      },
      ctx
    );

    // Dispatch webhook
    await dispatchEvent({
      event: "emission.completed",
      timestamp: new Date().toISOString(),
      data: { entityId: entityRef.entityId, entityName, version, targetCount },
    });
  } catch (error) {
    console.error(
      "Failed to send emission complete notification:",
      error
    );
  }
}

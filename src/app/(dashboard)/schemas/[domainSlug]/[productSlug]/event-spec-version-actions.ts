"use server";

import { getActionContext, NOT_AUTHENTICATED, runMutation, sanitizeActionError, toActionResult, withOwnedTarget } from "@/lib/action-context";
import { isBumpKind, type PublishInput } from "@/lib/entity-versioning/types";
import type { EventPublishAnalysis } from "@/lib/events/publish-plan";
import type { EventVersionSummary } from "@/lib/events/types";
import { listEventSpecVersions, previewEventSpecPublish, publishEventSpec } from "@/services/events/event-spec-publish.service";
import type { ActionResult } from "@/types/action-result";
import { err } from "@/types/result";

const MAX_CHANGE_SUMMARY = 500;

/** The product the page acts under: CLIENT-supplied, so `withOwnedTarget` requires it to lie in the ACTIVE tenant before any service runs. */
const productOwner = (productId: string) => ({ level: "PRODUCT" as const, productId });

/**
 * Every action takes the page's owning `productId` after the spec id (same order as `updateEventSpecDocumentAction`); the service
 * returns FORBIDDEN for another product's / tenant's spec and NOT_FOUND for an unknown one, before reading, rendering or writing
 * anything. Read-only: needs a session but never revalidates.
 */
export async function getEventSpecPublishPreviewAction(specId: string, productId: string): Promise<ActionResult<EventPublishAnalysis>> {
  const ctx = await getActionContext();
  if (!ctx) return NOT_AUTHENTICATED;
  return toActionResult(await sanitizeActionError(withOwnedTarget(productOwner(productId), () => previewEventSpecPublish(specId, productId, ctx)), "getEventSpecPublishPreviewAction"));
}

/** Planner error codes (`PUBLISH_BLOCKED` with every blocker in `details`, `BUMP_TOO_LOW`, `INVALID_PLAN_INPUT`) reach the UI unchanged. */
export async function publishEventSpecAction(specId: string, productId: string, input: PublishInput): Promise<ActionResult<EventVersionSummary>> {
  return runMutation(async (ctx) => {
    const raw: Partial<PublishInput> = typeof input === "object" && input !== null ? input : {};
    if (raw.bump !== undefined && !isBumpKind(raw.bump)) return err({ code: "VALIDATION_ERROR", message: "bump must be MAJOR or MINOR" });
    if (raw.changeSummary !== undefined && (typeof raw.changeSummary !== "string" || raw.changeSummary.length > MAX_CHANGE_SUMMARY)) {
      return err({ code: "VALIDATION_ERROR", message: `Change summary must be at most ${MAX_CHANGE_SUMMARY} characters` });
    }
    return sanitizeActionError(withOwnedTarget(productOwner(productId), () => publishEventSpec(specId, productId, { bump: raw.bump, changeSummary: raw.changeSummary }, ctx)), "publishEventSpecAction");
  });
}

/** Read-only: needs a session but never revalidates. */
export async function listEventSpecVersionsAction(specId: string, productId: string): Promise<ActionResult<EventVersionSummary[]>> {
  const ctx = await getActionContext();
  if (!ctx) return NOT_AUTHENTICATED;
  return toActionResult(await sanitizeActionError(withOwnedTarget(productOwner(productId), () => listEventSpecVersions(specId, productId, ctx)), "listEventSpecVersionsAction"));
}

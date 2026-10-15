"use server";

import { getActionContext, NOT_AUTHENTICATED, runMutation, toActionResult } from "@/lib/action-context";
import { isBumpKind, type PublishInput } from "@/lib/entity-versioning/types";
import type { EventPublishAnalysis } from "@/lib/events/publish-plan";
import type { EventVersionSummary } from "@/lib/events/types";
import { listMessageVersions, previewMessagePublish, publishMessage } from "@/services/events/message-publish.service";
import type { ActionResult } from "@/types/action-result";
import { err, type Result } from "@/types/result";

const MAX_CHANGE_SUMMARY = 500;
const GENERIC_ERROR = "Something went wrong. Try again; if it keeps happening, contact an administrator.";

/**
 * Never lets raw database / driver text reach the browser: a service `DB_ERROR` or a thrown error becomes a generic message and
 * the original is logged server-side. Every other service error (planner codes, blockers, CONFLICT, NOT_FOUND…) passes through.
 */
async function sanitized<T>(label: string, run: () => Promise<Result<T>>): Promise<Result<T>> {
  try {
    const result = await run();
    if (!result.success && result.error.code === "DB_ERROR") {
      console.error(`[${label}] database error`, result.error.message);
      return err({ code: "DB_ERROR", message: GENERIC_ERROR });
    }
    return result;
  } catch (e: unknown) {
    console.error(`[${label}] unexpected error`, e);
    return err({ code: "INTERNAL_ERROR", message: GENERIC_ERROR });
  }
}

/** Read-only: needs a session but never revalidates. */
export async function getMessagePublishPreviewAction(messageId: string): Promise<ActionResult<EventPublishAnalysis>> {
  const ctx = await getActionContext();
  if (!ctx) return NOT_AUTHENTICATED;
  return toActionResult(await sanitized("getMessagePublishPreviewAction", () => previewMessagePublish(messageId, ctx)));
}

/** Planner error codes (`PUBLISH_BLOCKED` with every blocker in `details`, `BUMP_TOO_LOW`, `INVALID_PLAN_INPUT`) reach the UI unchanged. */
export async function publishMessageAction(messageId: string, input: PublishInput): Promise<ActionResult<EventVersionSummary>> {
  return runMutation(async (ctx) => {
    const raw: Partial<PublishInput> = typeof input === "object" && input !== null ? input : {};
    if (raw.bump !== undefined && !isBumpKind(raw.bump)) return err({ code: "VALIDATION_ERROR", message: "bump must be MAJOR or MINOR" });
    if (raw.changeSummary !== undefined && (typeof raw.changeSummary !== "string" || raw.changeSummary.length > MAX_CHANGE_SUMMARY)) {
      return err({ code: "VALIDATION_ERROR", message: `Change summary must be at most ${MAX_CHANGE_SUMMARY} characters` });
    }
    return sanitized("publishMessageAction", () => publishMessage(messageId, { bump: raw.bump, changeSummary: raw.changeSummary }, ctx));
  });
}

/** Read-only: needs a session but never revalidates. */
export async function listMessageVersionsAction(messageId: string): Promise<ActionResult<EventVersionSummary[]>> {
  const ctx = await getActionContext();
  if (!ctx) return NOT_AUTHENTICATED;
  return toActionResult(await sanitized("listMessageVersionsAction", () => listMessageVersions(messageId, ctx)));
}

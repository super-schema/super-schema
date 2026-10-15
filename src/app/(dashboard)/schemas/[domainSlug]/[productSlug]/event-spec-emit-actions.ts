"use server";

import { getActionContext, NOT_AUTHENTICATED, toActionResult } from "@/lib/action-context";
import { emitEventSpec, type EmitTarget, type EventSpecEmission } from "@/services/events/event-spec-emit.service";
import type { ActionResult } from "@/types/action-result";

const UNEXPECTED_FAILURE = {
  success: false,
  error: "The event spec could not be read or emitted. Try again; if it keeps failing, contact an administrator.",
  code: "INTERNAL_ERROR",
} as const satisfies ActionResult<never>;

/** Read-style action: authenticate, call the service, never revalidate. An unexpected throw is logged and returned generically. */
async function emitAction(specId: string, target: EmitTarget): Promise<ActionResult<EventSpecEmission>> {
  try {
    const ctx = await getActionContext();
    if (!ctx) return NOT_AUTHENTICATED;
    return toActionResult(await emitEventSpec(specId, target, ctx));
  } catch (e: unknown) {
    console.error("[event-spec-emit-actions] unexpected failure:", e);
    return UNEXPECTED_FAILURE;
  }
}

/** Read-only: no revalidation. Draft emission renders artifacts on demand (D9) and validates with @asyncapi/parser. */
export async function emitEventSpecDraftAction(specId: string): Promise<ActionResult<EventSpecEmission>> {
  return emitAction(specId, { draft: true });
}

export async function getEventSpecVersionDocumentAction(specId: string, label: string): Promise<ActionResult<EventSpecEmission>> {
  return emitAction(specId, { versionLabel: label });
}

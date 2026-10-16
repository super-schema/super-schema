"use server";

import { unstable_rethrow } from "next/navigation";
import { getActionContext, NOT_AUTHENTICATED, runMutation, toActionResult, withOwnedTarget } from "@/lib/action-context";
import { emitEventDocumentPreview, emitEventDraft, type EventEmission } from "@/services/events/event-emit.service";
import { createEvent, deleteEvent, renameEvent, updateEventDocument, type EventDetail } from "@/services/events/event.service";
import { GENERIC_ACTION_ERROR, type ActionResult } from "@/types/action-result";
import type { Result } from "@/types/result";
import type { ServiceContext } from "@/types/service-context";

const productOwner = (productId: string) => ({ level: "PRODUCT" as const, productId });

/**
 * Server actions of the self-contained Event (the services are `event.service.ts`; the old catalog-id ones stay in
 * `event-spec-actions.ts`). The `productId` is CLIENT-supplied and the service only compares the row against it:
 * `withOwnedTarget` first requires that product to lie in the ACTIVE tenant (a foreign one is the NOT_FOUND of an unknown
 * product and the service never runs). `runMutation` revalidates `/schemas` on success only.
 */
export async function createEventAction(productId: string, input: { name: string; description?: string }): Promise<ActionResult<EventDetail>> {
  return runMutation((ctx) => withOwnedTarget(productOwner(productId), () => createEvent(productId, input, ctx)), "createEventAction");
}

export async function updateEventDocumentAction(eventId: string, productId: string, document: unknown): Promise<ActionResult<EventDetail>> {
  return runMutation((ctx) => withOwnedTarget(productOwner(productId), () => updateEventDocument(eventId, document, productOwner(productId), ctx)), "updateEventDocumentAction");
}

export async function renameEventAction(eventId: string, productId: string, name: string): Promise<ActionResult<EventDetail>> {
  return runMutation((ctx) => withOwnedTarget(productOwner(productId), () => renameEvent(eventId, name, productOwner(productId), ctx)), "renameEventAction");
}

export async function deleteEventAction(eventId: string, productId: string): Promise<ActionResult<{ id: string }>> {
  return runMutation((ctx) => withOwnedTarget(productOwner(productId), () => deleteEvent(eventId, productOwner(productId), ctx)), "deleteEventAction");
}

/**
 * Read-style action: authenticate, run the service behind the same parent check as the mutations, never revalidate. The emit
 * service compares the event with the client-supplied product only, so without `withOwnedTarget` a foreign product + a foreign
 * event would be self-consistent. A failed Result goes through `toActionResult` (raw database text is replaced and logged under
 * `label`); an unexpected throw is logged and answered generically, except Next's own control-flow throws, which pass through.
 */
async function readAction<T>(productId: string, label: string, run: (ctx: ServiceContext) => Promise<Result<T>>): Promise<ActionResult<T>> {
  try {
    const ctx = await getActionContext();
    if (!ctx) return NOT_AUTHENTICATED;
    return toActionResult(await withOwnedTarget(productOwner(productId), () => run(ctx)), label);
  } catch (e: unknown) {
    unstable_rethrow(e);
    console.error(`[${label}] unexpected error`, e);
    return { success: false, error: GENERIC_ACTION_ERROR, code: "INTERNAL_ERROR" };
  }
}

/**
 * The AsyncAPI emission of a document the user has NOT saved (the builder's Preview tab). Nothing is written. A render failure
 * is a success whose `document` / `json` / `yaml` are null and whose `diagnostics` say why; an invalid document is a
 * `VALIDATION_ERROR` with `details.problems`.
 */
export async function previewEventDocumentAction(eventId: string, productId: string, document: unknown): Promise<ActionResult<EventEmission>> {
  return readAction(productId, "previewEventDocumentAction", (ctx) => emitEventDocumentPreview(eventId, productId, document, ctx));
}

/** The AsyncAPI emission of the SAVED draft (what Publish will cut from). Read-only; same nullable artifacts as the preview. */
export async function emitEventDraftAction(eventId: string, productId: string): Promise<ActionResult<EventEmission>> {
  return readAction(productId, "emitEventDraftAction", (ctx) => emitEventDraft(eventId, productId, ctx));
}

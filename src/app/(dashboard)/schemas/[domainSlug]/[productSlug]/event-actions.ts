"use server";

import { unstable_rethrow } from "next/navigation";
import { getActionContext, NOT_AUTHENTICATED, runMutation, toActionResult, withOwnedTarget } from "@/lib/action-context";
import { getActiveTenantId } from "@/lib/active-tenant";
import type { PublishInput } from "@/lib/entity-versioning/types";
import type { ExternalEventCandidate, ExternalRefInput, ExternalRefStatus, ExternalVersionItems, ExternalVersionOption } from "@/lib/events/external-refs";
import type { EventPublishAnalysis } from "@/lib/events/publish-plan";
import type { EntityPin, EventVersionSummary } from "@/lib/events/types";
import { importAsyncApi, previewAsyncApiImport, type AsyncApiImportInput, type AsyncApiImportPreview } from "@/services/events/asyncapi-import.service";
import { emitEventDocumentPreview, emitEventDraft, emitEventStoredVersion, type EventEmission } from "@/services/events/event-emit.service";
import { listEventVersions, previewEventPublish, publishEvent } from "@/services/events/event-publish.service";
import { createEvent, deleteEvent, renameEvent, updateEventDocument, type EventDetail } from "@/services/events/event.service";
import {
  getExternalRefStatuses, getExternalVersionItems, listExternalEventCandidates, listExternalEventVersions,
} from "@/services/events/external-refs.service";
import { renderPinJsonSchema } from "@/services/events/pin-json-schema.service";
import { requireOwnedEvent } from "@/services/events/service-guards";
import { GENERIC_ACTION_ERROR, type ActionResult } from "@/types/action-result";
import { ok, type Result } from "@/types/result";
import type { ServiceContext } from "@/types/service-context";

const productOwner = (productId: string) => ({ level: "PRODUCT" as const, productId });

/**
 * Server actions of the self-contained Event (the services are `event.service.ts`). The `productId` is CLIENT-supplied and the
 * service only compares the row against it:
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

// ── External event references: read actions ────────────────────────────────────────────────────────────────────────────
// The loaders of `external-refs.service.ts` for the reference picker and the "newer version available" badge. `productId` is
// the product the user works in (checked by `readAction` -> `withOwnedTarget`, like every action above). The tenant is the
// server-resolved ACTIVE tenant, and the event the candidate list leaves out is checked to be one of that product's events:
// neither is ever taken on trust from the client.

/** Published events of the tenant to reference, searched by event / domain / product name. `eventId` is the event being edited (never offered). */
export async function listExternalEventCandidatesAction(productId: string, eventId: string, query?: string): Promise<ActionResult<ExternalEventCandidate[]>> {
  return readAction(productId, "listExternalEventCandidatesAction", async (ctx) => {
    const own = await requireOwnedEvent(ctx, eventId, productOwner(productId));
    if (!own.success) return own;
    return listExternalEventCandidates(ctx, { tenantId: await getActiveTenantId(), excludeEventId: own.data, query });
  });
}

/** The referenceable versions of the event `sourceEventId` (any product of the tenant), newest first. */
export async function listExternalEventVersionsAction(productId: string, sourceEventId: string): Promise<ActionResult<ExternalVersionOption[]>> {
  return readAction(productId, "listExternalEventVersionsAction", async (ctx) =>
    listExternalEventVersions(ctx, { tenantId: await getActiveTenantId(), eventId: sourceEventId }));
}

/** The channels and messages the published version `eventVersionId` offers. */
export async function getExternalVersionItemsAction(productId: string, eventVersionId: string): Promise<ActionResult<ExternalVersionItems>> {
  return readAction(productId, "getExternalVersionItemsAction", async (ctx) =>
    getExternalVersionItems(ctx, { tenantId: await getActiveTenantId(), eventVersionId }));
}

/** One status per referenced version: is a newer version published, is it a new major, which referenced items did it drop. */
export async function getExternalRefStatusesAction(productId: string, refs: ExternalRefInput[]): Promise<ActionResult<ExternalRefStatus[]>> {
  return readAction(productId, "getExternalRefStatusesAction", async (ctx) =>
    getExternalRefStatuses(ctx, { tenantId: await getActiveTenantId(), refs }));
}

// ── Message examples ───────────────────────────────────────────────────────────────────────────────────────────────────
// The schema a message's example payload / headers is checked against, and generated from (`pin-json-schema.service.ts`).

/**
 * The JSON Schema (draft-07, one self-contained document) of the entity a message pins: a pinned version renders that version, an
 * unpinned pin the entity's current draft. `pin` is CLIENT-supplied: the service validates its shape, and the tenant is the
 * server-resolved ACTIVE one, so an entity of another tenant reads exactly like a missing one (NOT_FOUND). Failures that carry raw
 * renderer text are already replaced by the service; a schema over 512 KB is TOO_LARGE.
 */
export async function pinJsonSchemaAction(productId: string, pin: EntityPin): Promise<ActionResult<{ schema: Record<string, unknown> }>> {
  return readAction(productId, "pinJsonSchemaAction", async (ctx) => renderPinJsonSchema(ctx, { tenantId: await getActiveTenantId(), pin }));
}

// ── Publish, versions ──────────────────────────────────────────────────────────────────────────────────────────────────
// The services are `event-publish.service.ts` (publish, preview, list) and `event-emit.service.ts` (a stored version's code). All four
// take the CLIENT-supplied `productId` and the service compares the event against it, behind the same parent check as above.

/** What the Publish dialog shows: the version a publish would write, the suggested bump and EVERY blocker. Writes nothing. */
export async function previewEventPublishAction(eventId: string, productId: string): Promise<ActionResult<EventPublishAnalysis>> {
  return readAction(productId, "previewEventPublishAction", (ctx) => previewEventPublish(eventId, productId, ctx));
}

/**
 * Cuts an immutable version from the SAVED draft. `input` (bump, change summary) is untrusted; the service validates it and the
 * raise-only bump rule. A blocked plan answers PUBLISH_BLOCKED with every blocker in `details.blockers`, a save racing the publish a
 * retryable CONFLICT.
 */
export async function publishEventAction(eventId: string, productId: string, input: PublishInput): Promise<ActionResult<EventVersionSummary>> {
  return runMutation((ctx) => withOwnedTarget(productOwner(productId), () => publishEvent(eventId, productId, input, ctx)), "publishEventAction");
}

/** The published versions of the event, newest first. */
export async function listEventVersionsAction(eventId: string, productId: string): Promise<ActionResult<EventVersionSummary[]>> {
  return readAction(productId, "listEventVersionsAction", (ctx) => listEventVersions(eventId, productId, ctx));
}

/** The stored AsyncAPI document of one published version (`label` like "1.1"), exactly as it was saved, as YAML and JSON text. */
export async function readEventVersionAction(eventId: string, productId: string, label: string): Promise<ActionResult<{ yaml: string; json: string }>> {
  return readAction(productId, "readEventVersionAction", async (ctx) => {
    const stored = await emitEventStoredVersion(eventId, productId, label, ctx);
    return stored.success ? ok({ yaml: stored.data.yaml, json: stored.data.json }) : stored;
  });
}

// ── Import an AsyncAPI 3.0 document ────────────────────────────────────────────────────────────────────────────────────
// The services are `asyncapi-import.service.ts`. `input` is the file text and two optional names, all untrusted: the service validates
// them and bounds what the parser is GIVEN (1 MiB, entries per object and list, expanded size, entity counts); the read of the file (4 s) and
// the parser (15 s) run in a child process with a hard time limit, so a hostile file is refused instead of holding the server (the rest of the
// pipeline is not interruptible, see `src/services/events/import-limits.ts`, KNOWN LIMITATION). The product is checked first, like every action above.

/** What importing the document into this product would do (resolved event name, counts, entities with their final names, warnings). Writes nothing. */
export async function previewAsyncApiImportAction(productId: string, input: AsyncApiImportInput): Promise<ActionResult<AsyncApiImportPreview>> {
  return readAction(productId, "previewAsyncApiImportAction", (ctx) => previewAsyncApiImport(productId, input, ctx));
}

/**
 * Imports the document: draft entities for the payloads, then the event that pins them. A failure after the entities were created
 * deletes them again (`details.leftovers` names anything that could not be deleted), so a failed import leaves no event and no entity behind
 * (the tenant's built-in library traits, installed idempotently before the first entity is written, stay).
 */
export async function importAsyncApiAction(productId: string, input: AsyncApiImportInput): Promise<ActionResult<{ eventId: string; preview: AsyncApiImportPreview }>> {
  return runMutation((ctx) => withOwnedTarget(productOwner(productId), () => importAsyncApi(productId, input, ctx)), "importAsyncApiAction");
}

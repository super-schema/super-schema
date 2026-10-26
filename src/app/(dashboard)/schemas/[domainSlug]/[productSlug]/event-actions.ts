"use server";

import { unstable_rethrow } from "next/navigation";
import { readableScopes, type ActionId } from "@/lib/access";
import { authorizeSubject, contextOf, runMutation, toActionResult } from "@/lib/action-context";
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
import { err, ok, type Result, type ServiceError } from "@/types/result";
import type { ServiceContext } from "@/types/service-context";

const productOwner = (productId: string) => ({ level: "PRODUCT" as const, productId });

/** What a missing product, a product of another tenant and a product nothing of the caller's covers all answer (the text `resolveScope` gives an unknown one). */
const missingProduct = (productId: unknown): ServiceError => ({ code: "NOT_FOUND", message: `Product "${typeof productId === "string" ? productId : ""}" not found` });
/** The subject of every guard below: the product the client names, read from its row (its tenant, domain and product), never taken from the client. */
const onProduct = (productId: unknown) => ({ kind: "product" as const, id: productId });

/**
 * Server actions of the self-contained Event (the services are `event.service.ts`). The `productId` is CLIENT-supplied and the
 * service only compares the row against it, so EVERY action first asks the policy over that product (an event lives in one): the product must lie
 * in the ACTIVE tenant and the caller's roles must reach the action over it (an event's own scope is its product's). A foreign product, a missing
 * one and one nothing of the caller's covers all answer the NOT_FOUND of an unknown product and the service never runs; too low a role is a
 * generic refusal. Reading is `event.read`, editing `event.write`, publishing `event.publish`, the schema pinned by a message `event.pin`,
 * importing a document `import.run`. `runMutation` revalidates `/schemas` on success only.
 */
const mutation = <T>(label: string, action: ActionId, productId: string, run: (ctx: ServiceContext) => Promise<Result<T>>): Promise<ActionResult<T>> =>
  runMutation({ action, resource: onProduct(productId), notFound: missingProduct(productId) }, run, label);

export async function createEventAction(productId: string, input: { name: string; description?: string }): Promise<ActionResult<EventDetail>> {
  return mutation("createEventAction", "event.write", productId, (ctx) => createEvent(productId, input, ctx));
}

export async function updateEventDocumentAction(eventId: string, productId: string, document: unknown): Promise<ActionResult<EventDetail>> {
  return mutation("updateEventDocumentAction", "event.write", productId, (ctx) => updateEventDocument(eventId, document, productOwner(productId), ctx));
}

export async function renameEventAction(eventId: string, productId: string, name: string): Promise<ActionResult<EventDetail>> {
  return mutation("renameEventAction", "event.write", productId, (ctx) => renameEvent(eventId, name, productOwner(productId), ctx));
}

export async function deleteEventAction(eventId: string, productId: string): Promise<ActionResult<{ id: string }>> {
  return mutation("deleteEventAction", "event.write", productId, (ctx) => deleteEvent(eventId, productOwner(productId), ctx));
}

/**
 * Read-style action: ask the policy over the product FIRST, run the service behind it, never revalidate. The emit service compares the event
 * with the client-supplied product only, so without the guard a foreign product + a foreign event would be self-consistent. `run` gets the
 * principal's context and the ACTIVE tenant id (the one the guard proved the product lies in: the server's, never the client's), and the roles
 * to restrict a tenant-wide listing with. A failed Result goes through `toActionResult` (raw database text is replaced and logged under
 * `label`); an unexpected throw is logged and answered generically, except Next's own control-flow throws, which pass through.
 */
type Reader = { ctx: ServiceContext; tenantId: string; restrictTo: { domainIds: string[]; productIds: string[] } | undefined };

async function readAction<T>(action: ActionId, productId: string, label: string, run: (reader: Reader) => Promise<Result<T>>): Promise<ActionResult<T>> {
  try {
    const access = await authorizeSubject(action, onProduct(productId), missingProduct(productId));
    if (!access.success) return toActionResult({ success: false, error: access.error }, label);
    const { principal, resource } = access.data;
    // A role over some domains or products only reads only their events when the loader lists across the tenant; a tenant-wide role is unrestricted.
    const scopes = readableScopes(principal.assignments, "event.read", resource.tenantId);
    const restrictTo = scopes.all ? undefined : { domainIds: scopes.domainIds, productIds: scopes.productIds };
    return toActionResult(await run({ ctx: contextOf(principal), tenantId: resource.tenantId, restrictTo }), label);
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
  return readAction("event.write", productId, "previewEventDocumentAction", ({ ctx }) => emitEventDocumentPreview(eventId, productId, document, ctx));
}

/** The AsyncAPI emission of the SAVED draft (what Publish will cut from). Read-only; same nullable artifacts as the preview. */
export async function emitEventDraftAction(eventId: string, productId: string): Promise<ActionResult<EventEmission>> {
  return readAction("event.read", productId, "emitEventDraftAction", ({ ctx }) => emitEventDraft(eventId, productId, ctx));
}

// ── External event references: read actions ────────────────────────────────────────────────────────────────────────────
// The loaders of `external-refs.service.ts` for the reference picker and the "newer version available" badge. `productId` is
// the product the user works in (checked by `readAction`'s guard, like every action above). The tenant is the
// server-resolved ACTIVE tenant, and the event the candidate list leaves out is checked to be one of that product's events:
// neither is ever taken on trust from the client.

/** Published events of the tenant to reference, searched by event / domain / product name. `eventId` is the event being edited (never offered). */
export async function listExternalEventCandidatesAction(productId: string, eventId: string, query?: string): Promise<ActionResult<ExternalEventCandidate[]>> {
  return readAction("event.read", productId, "listExternalEventCandidatesAction", async ({ ctx, tenantId, restrictTo }) => {
    const own = await requireOwnedEvent(ctx, eventId, productOwner(productId));
    if (!own.success) return own;
    return listExternalEventCandidates(ctx, { tenantId, excludeEventId: own.data, query, restrictTo });
  });
}

/** The referenceable versions of the event `sourceEventId` (any product of the tenant), newest first. */
export async function listExternalEventVersionsAction(productId: string, sourceEventId: string): Promise<ActionResult<ExternalVersionOption[]>> {
  return readAction("event.read", productId, "listExternalEventVersionsAction", async ({ ctx, tenantId, restrictTo }) =>
    listExternalEventVersions(ctx, { tenantId, eventId: sourceEventId, restrictTo }));
}

/** The channels and messages the published version `eventVersionId` offers. */
export async function getExternalVersionItemsAction(productId: string, eventVersionId: string): Promise<ActionResult<ExternalVersionItems>> {
  return readAction("event.read", productId, "getExternalVersionItemsAction", async ({ ctx, tenantId, restrictTo }) =>
    getExternalVersionItems(ctx, { tenantId, eventVersionId, restrictTo }));
}

/** One status per referenced version: is a newer version published, is it a new major, which referenced items did it drop. */
export async function getExternalRefStatusesAction(productId: string, refs: ExternalRefInput[]): Promise<ActionResult<ExternalRefStatus[]>> {
  return readAction("event.read", productId, "getExternalRefStatusesAction", async ({ ctx, tenantId, restrictTo }) =>
    getExternalRefStatuses(ctx, { tenantId, refs, restrictTo }));
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
  return readAction("event.pin", productId, "pinJsonSchemaAction", async ({ ctx, tenantId }) => {
    // The schema of an entity is its content: the caller must be able to read THE ENTITY, not only own the product they pin it in. One they
    // cannot read answers the very NOT_FOUND the service gives a missing or foreign one.
    const entityId = typeof pin === "object" && pin !== null ? pin.entityId : undefined;
    if (typeof entityId === "string" && entityId.trim() !== "") {
      const readable = await authorizeSubject("entity.read", { kind: "entity", id: entityId }, { code: "NOT_FOUND", message: `Entity "${entityId}" not found` });
      if (!readable.success) return err(readable.error);
    }
    return renderPinJsonSchema(ctx, { tenantId, pin });
  });
}

// ── Publish, versions ──────────────────────────────────────────────────────────────────────────────────────────────────
// The services are `event-publish.service.ts` (publish, preview, list) and `event-emit.service.ts` (a stored version's code). All four
// take the CLIENT-supplied `productId` and the service compares the event against it, behind the same parent check as above.

/** What the Publish dialog shows: the version a publish would write, the suggested bump and EVERY blocker. Writes nothing. */
export async function previewEventPublishAction(eventId: string, productId: string): Promise<ActionResult<EventPublishAnalysis>> {
  return readAction("event.read", productId, "previewEventPublishAction", ({ ctx }) => previewEventPublish(eventId, productId, ctx));
}

/**
 * Cuts an immutable version from the SAVED draft. `input` (bump, change summary) is untrusted; the service validates it and the
 * raise-only bump rule. A blocked plan answers PUBLISH_BLOCKED with every blocker in `details.blockers`, a save racing the publish a
 * retryable CONFLICT.
 */
export async function publishEventAction(eventId: string, productId: string, input: PublishInput): Promise<ActionResult<EventVersionSummary>> {
  return mutation("publishEventAction", "event.publish", productId, (ctx) => publishEvent(eventId, productId, input, ctx));
}

/** The published versions of the event, newest first. */
export async function listEventVersionsAction(eventId: string, productId: string): Promise<ActionResult<EventVersionSummary[]>> {
  return readAction("event.read", productId, "listEventVersionsAction", ({ ctx }) => listEventVersions(eventId, productId, ctx));
}

/** The stored AsyncAPI document of one published version (`label` like "1.1"), exactly as it was saved, as YAML and JSON text. */
export async function readEventVersionAction(eventId: string, productId: string, label: string): Promise<ActionResult<{ yaml: string; json: string }>> {
  return readAction("event.read", productId, "readEventVersionAction", async ({ ctx }) => {
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
  return readAction("import.run", productId, "previewAsyncApiImportAction", ({ ctx }) => previewAsyncApiImport(productId, input, ctx));
}

/**
 * Imports the document: draft entities for the payloads, then the event that pins them. A failure after the entities were created
 * deletes them again (`details.leftovers` names anything that could not be deleted), so a failed import leaves no event and no entity behind
 * (the tenant's built-in library traits, installed idempotently before the first entity is written, stay).
 */
export async function importAsyncApiAction(productId: string, input: AsyncApiImportInput): Promise<ActionResult<{ eventId: string; preview: AsyncApiImportPreview }>> {
  return mutation("importAsyncApiAction", "import.run", productId, (ctx) => importAsyncApi(productId, input, ctx));
}

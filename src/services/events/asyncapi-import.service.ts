// src/services/events/asyncapi-import.service.ts
// Imports an AsyncAPI 3.0 document as an event (spec 2026-10-16-events-import-and-json-validation): the file text is parsed and checked,
// every message payload / headers schema becomes a DRAFT entity of the product, and the event is created with a document that pins them
// (unpinned: the user publishes the entities, then the event). The pure parts are `src/lib/events/import/*`; the entities are
// `import-payload-entities.ts`.
//
// Order, so that a document that cannot be imported creates no event and no entity (the tenant's built-in library traits are installed
// idempotently in step 4, after the parser, and before the first entity is written) and the inputs of the slow steps are bounded: check the size of the file; parse the source
// (`parseAsyncApiSource`: linear, and it refuses what is hostile or too deep); check the entries of every object and
// list and the size of the document once its references are resolved (`import-limits.ts`, before ANYTHING slow walks the document);
// extract the payloads; check THEIR limits before any importer runs; plan the entities (and check the entity and field limits); validate
// with the AsyncAPI parser; map the document ONCE with stand-in pins (extracting the payloads succeeding does not mean mapping will: a
// missing title, an operation without a channel and an oversized expansion are only found by mapping); and only then write: entities (one
// transaction), the event, the document. If either of the last two fails, what was created is deleted again and the error says so.
// The importers and the parser are synchronous stretches of CPU that nothing can interrupt, so there is no time limit: the limits bound
// what each is given, not what the whole file can cost (see the known limitation in `import-limits.ts`).
import type { Parser } from "@asyncapi/parser";
import type { LevelScope } from "@/lib/levels";
import { resolveScope } from "@/lib/asset-scope";
import { checkImportSize } from "@/lib/compiler/import-limits";
import { mapParserDiagnostic, createAsyncApiParser } from "@/lib/event-specs/validation/asyncapi-parser-validator";
import { normalizeDiagnostics } from "@/lib/event-specs/diagnostics";
import { BUNDLED_TRAITS, bundledMarker } from "@/lib/events/bundled-traits";
import { slugKey } from "@/lib/events/document/keys";
import { isLibraryTrait, type EventDocument } from "@/lib/events/document/types";
import {
  builtInKindOfMarker, extractPayloads, mapAsyncApiToEventDocument, parseAsyncApiSource,
  type BuiltInTraitKind, type ImportWarning, type MapContext, type RawAsyncApi3,
} from "@/lib/events/import";
import { omittedWarningsMessage } from "@/lib/events/import/bound";
import { normalizeCatalogName } from "@/lib/events/inputs";
import type { EntityPin } from "@/lib/events/types";
import { ensureBundledTraits } from "@/services/events/bundled-traits.service";
import { createEvent, deleteEvent, updateEventDocument } from "@/services/events/event.service";
import {
  createNameAllocator, createPayloadEntities, deleteCreatedEntities, planPayloadEntities, resolveEntityNames,
  type CreatedPayloadEntities, type PlannedFormat, type ResolvedPayload, type UndeletedEntity,
} from "@/services/events/import-payload-entities";
import { boundText, checkEntryCounts, checkExpandedSize, checkPayloadLimits, checkPlanLimits, MAX_PARSER_PROBLEMS, MAX_PARSER_WARNINGS } from "@/services/events/import-limits";
import { guardRead, requireId } from "@/services/events/service-guards";
import { GENERIC_ACTION_ERROR, isOpaqueErrorCode } from "@/types/action-result";
import { err, ok, type Result, type ServiceError } from "@/types/result";
import type { ServiceContext } from "@/types/service-context";

export interface AsyncApiImportInput { content: string; fileName?: string; eventName?: string }

/** Longest document title the preview carries: the title is document-controlled text (up to about 1 MB), and the review only shows a heading. */
const MAX_PREVIEW_TITLE = 200;

export interface AsyncApiImportPreview {
  /** Resolved, unique in the product's line (it shares the line with entities). */
  eventName: string;
  title: string;
  counts: { servers: number; channels: number; messages: number; operations: number; traits: number; securitySchemes: number };
  entities: Array<{ requestedName: string; name: string; renamed: boolean; fields: number; format: PlannedFormat }>;
  /** Names of the built-in library traits the document's traits were mapped to, e.g. `["CloudEvents"]`. */
  builtInTraits: string[];
  warnings: ImportWarning[];
}

/** The parser is expensive to build and holds no document state: one per process, like the emit validators. */
let sharedParser: Parser | undefined;

const invalid = (message: string, suggestedFix?: string) => err({ code: "VALIDATION_ERROR", message, ...(suggestedFix && { suggestedFix }) });
const internalFailure = (label: string, cause: unknown): Result<never> => {
  console.error(`[${label}] unexpected error`, cause);
  return err({ code: "INTERNAL_ERROR", message: GENERIC_ACTION_ERROR });
};

/** The input arrives from the browser untyped: anything but `{ content: string, fileName?: string, eventName?: string }` is refused before a query or a parser runs. */
function readInput(input: unknown): Result<{ content: string; fileName?: string; eventName?: string }> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return invalid("Import input must be an object");
  const { content, fileName, eventName } = input as Record<string, unknown>;
  if (typeof content !== "string") return invalid("The AsyncAPI document must be text");
  if (fileName !== undefined && fileName !== null && typeof fileName !== "string") return invalid("The file name must be a string");
  if (eventName !== undefined && eventName !== null && typeof eventName !== "string") return invalid("The event name must be a string");
  let name: string | undefined;
  if (typeof eventName === "string" && eventName.trim() !== "") {
    const normalized = normalizeCatalogName(eventName, "Event");
    if (!normalized.success) return normalized;
    name = normalized.data;
  }
  // only the last path segment, without control characters: it is shown in a description
  const file = typeof fileName === "string" ? (fileName.split(/[\\/]/).pop() ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 120) : "";
  return ok({ content, fileName: file === "" ? undefined : file, eventName: name });
}

/**
 * The AsyncAPI parser's verdict on the document: any error blocks the import (nothing is written at all: the tenant's built-in library traits are installed only after this step); warnings are reported (the first
 * `MAX_PARSER_WARNINGS`, then one summary line); info and hints are style advice and are dropped.
 *
 * NOT time-bounded, and not interruptible: the parser is asynchronous in name only. It runs long synchronous stretches (Spectral), so a
 * timer cannot fire in the middle of them and racing it against one would only guard a promise that never settles. The caller bounds its
 * INPUT before this runs: the file (1 MiB), the entries of any one object (`checkEntryCounts`: its cost also grows with the square of
 * that) and the size of the document once its `$ref`s are replaced by their targets (`checkExpandedSize`: roughly 1 - 2.5 s per MiB
 * depending on the shape, about 5 s at 4 MiB for the densest, so the limit is 2 MiB). That bounds each piece, NOT the file: a document of
 * about 1 MiB that passes every cap can still cost about 10 s here (60 channels of 1,999 `parameters` entries: 9.4 s, 119,941
 * diagnostics; 70 objects of 1,999 keys: 3.7 s) with the event loop blocked meanwhile. A worker thread with a hard timeout is the real
 * bound; it is a known limitation and a follow-up (see `import-limits.ts`).
 */
async function validateWithParser(raw: RawAsyncApi3): Promise<Result<ImportWarning[]>> {
  sharedParser ??= createAsyncApiParser();
  const found = await sharedParser.validate(raw);
  // A crash inside the validator comes back as a diagnostic carrying the exception text and its stack: log it, never show it.
  const crash = found.find((d) => String(d.code) === "uncaught-error");
  if (crash) return internalFailure("asyncapi-import validate", crash.message);
  const diagnostics = normalizeDiagnostics(found.map(mapParserDiagnostic));
  const errors = diagnostics.filter((d) => d.severity === "error");
  if (errors.length > 0) {
    const first = errors[0];
    return err({
      code: "VALIDATION_ERROR",
      message: `The AsyncAPI document is not valid: ${boundText(first.message)} (at ${first.pointer === "" ? "the document" : boundText(first.pointer)})${errors.length > 1 ? `, and ${errors.length - 1} more problem${errors.length > 2 ? "s" : ""}` : ""}.`,
      details: { problems: errors.slice(0, MAX_PARSER_PROBLEMS).map((d) => ({ pointer: boundText(d.pointer), message: boundText(d.message), code: d.code })) },
      suggestedFix: "Fix the document and import it again.",
    });
  }
  const warnings = diagnostics.filter((d) => d.severity === "warning");
  const report = warnings.slice(0, MAX_PARSER_WARNINGS).map((d): ImportWarning => ({ pointer: boundText(d.pointer), code: "VALIDATION_WARNING", message: boundText(d.message) }));
  if (warnings.length > MAX_PARSER_WARNINGS) report.push({ pointer: "", code: "DROPPED_CONSTRUCT", message: omittedWarningsMessage(warnings.length - MAX_PARSER_WARNINGS) });
  return ok(report);
}

/** The pure layer's `IMPORT_FAILED` carries the exception text in `details.reason`: it is logged here and never forwarded. Every other failure of it is meant for the user. */
function safeImportError(error: ServiceError): ServiceError {
  if (error.code !== "IMPORT_FAILED") return error;
  console.error("[asyncapi-import] the document could not be processed", error.details);
  return { code: "IMPORT_FAILED", message: "The AsyncAPI document could not be processed; it is probably too large or too deeply nested.", suggestedFix: "Import a smaller or simpler document." };
}

/** The library trait of each built-in family a message trait can be mapped to, and the name of each (for the report). */
interface BuiltInTraits { ids: MapContext["builtInTraitIds"]; nameOf: Map<string, string> }
const BUILT_IN_KINDS: readonly BuiltInTraitKind[] = ["cloudEvents", "traceContext"];

/**
 * The tenant's built-in trait ids, found by the `x-bundled` marker (never by name). An import installs the built-ins first (idempotent,
 * `ensureBundledTraits`); a preview writes nothing, so a family the tenant does not have YET gets a stand-in id and the report says the
 * trait will be used (the import installs it). A family that cannot be installed (its name is taken) stays a local copy.
 */
async function loadBuiltInTraits(ctx: ServiceContext, tenantId: string, install: boolean): Promise<Result<BuiltInTraits>> {
  return guardRead(async () => {
    if (install) {
      const ensured = await ensureBundledTraits(ctx.prisma, tenantId);
      if (!ensured.success) return ensured;
    }
    const rows = await ctx.prisma.trait.findMany({ where: { tenantId, domainId: null, productId: null }, select: { id: true, spec: true }, orderBy: { id: "asc" } });
    const ids: MapContext["builtInTraitIds"] = {};
    const nameOf = new Map<string, string>();
    for (const row of rows) {
      const marker = bundledMarker(row.spec);
      const definition = marker === null ? undefined : BUNDLED_TRAITS.find((t) => t.id === marker);
      const kind = marker === null ? null : builtInKindOfMarker(marker);
      if (!definition || kind === null || ids[kind] !== undefined) continue;
      ids[kind] = row.id;
      nameOf.set(row.id, definition.name);
    }
    if (!install) {
      for (const kind of BUILT_IN_KINDS) {
        const definition = BUNDLED_TRAITS.find((t) => builtInKindOfMarker(t.id) === kind);
        if (ids[kind] === undefined && definition) {
          ids[kind] = `(${definition.name}, installed by the import)`;
          nameOf.set(ids[kind], definition.name);
        }
      }
    }
    return ok({ ids, nameOf });
  });
}

const countsOf = (document: EventDocument): AsyncApiImportPreview["counts"] => ({
  servers: document.servers.length, channels: document.channels.length, messages: document.messages.length, operations: document.operations.length,
  traits: document.traits.length, securitySchemes: Object.keys(document.components?.securitySchemes ?? {}).length,
});

interface Prepared {
  scope: LevelScope;
  raw: RawAsyncApi3;
  payloads: ResolvedPayload[];
  builtInTraitIds: MapContext["builtInTraitIds"];
  preview: AsyncApiImportPreview;
}

/** Everything up to (not including) the first write; the preview of an import is exactly what `importAsyncApi` then carries out. */
async function prepare(productId: string, input: unknown, ctx: ServiceContext, install: boolean): Promise<Result<Prepared>> {
  const id = requireId(productId, "productId");
  if (!id.success) return id;
  const read = readInput(input);
  if (!read.success) return read;
  const { content, fileName, eventName } = read.data;

  // 1. The product (an unknown one is NOT_FOUND before the file is looked at), the size, the file.
  const resolved = await resolveScope(ctx.prisma, { level: "PRODUCT", productId: id.data });
  if (!resolved.success) return resolved;
  const scope = resolved.data;
  const sized = checkImportSize(content, "AsyncAPI document");
  if (!sized.success) return sized;
  // 1b. Read the file (linear: it refuses what is hostile, too deep or repeated; but a flood of syntax errors still costs 5 - 9 s at 1 MiB,
  // see KNOWN LIMITATION in `import-limits.ts`), then bound what everything slow is given: the entries of
  // one object (the AsyncAPI parser's cost grows with their square) and of one list (the mapper de-duplicates quadratically), and the size
  // of the document once every reference is replaced by its target (a few bytes of references to a shared definition can be megabytes).
  const parsed = parseAsyncApiSource(content);
  if (!parsed.success) return parsed;
  const raw = parsed.data;
  const entryCounts = checkEntryCounts(raw);
  if (!entryCounts.success) return entryCounts;
  const expandedLimit = checkExpandedSize(raw);
  if (!expandedLimit.success) return expandedLimit;

  // 2. The payloads, BOUNDED before any importer runs (an importer is synchronous and cannot be interrupted): how many, how big, how
  // big together (a schema several messages share counts per message). Then the entities they become and, before the first write, how
  // many entities and fields that is.
  const extracted = extractPayloads(raw);
  if (!extracted.success) return err(safeImportError(extracted.error));
  const payloadLimits = checkPayloadLimits(extracted.data);
  if (!payloadLimits.success) return payloadLimits;
  const planned = planPayloadEntities(extracted.data, fileName);
  const planLimits = checkPlanLimits(planned.plans);
  if (!planLimits.success) return planLimits;

  // 3. The AsyncAPI parser: an error means nothing is written at all (the built-in traits are installed in step 4). It cannot be interrupted; what it is given was bounded above.
  const validated = await validateWithParser(raw);
  if (!validated.success) return validated;

  // 4. Map the document once with stand-in pins: a document the mapper rejects must create no event and no entity (the built-in traits are installed just before, idempotently).
  const builtIns = await loadBuiltInTraits(ctx, scope.tenantId, install);
  if (!builtIns.success) return builtIns;
  const standIn = new Map<string, EntityPin>(planned.plans.map((plan) => [plan.pinKey, { entityId: "placeholder", entityVersionId: null }]));
  const mapped = mapAsyncApiToEventDocument(raw, { payloadPins: standIn, builtInTraitIds: builtIns.data.ids });
  if (!mapped.success) return err(safeImportError(mapped.error));
  const { document } = mapped.data;

  // 5. Names, the entities' first (they and the event share one line), the event's last.
  const allocator = await createNameAllocator(ctx.prisma, scope);
  if (!allocator.success) return allocator;
  const named = await resolveEntityNames(planned.plans, allocator.data);
  if (!named.success) return named;
  // a title with no letter or digit in it (only symbols, or another script) has no slug to speak of
  const requestedEventName = eventName ?? (/[A-Za-z0-9]/.test(document.info.title) ? slugKey(document.info.title) : "imported-event");
  const finalEventName = await allocator.data.allocate(requestedEventName, "event");
  if (!finalEventName.success) return finalEventName;
  const eventWarnings: ImportWarning[] = finalEventName.data === requestedEventName ? [] : [{
    pointer: "", code: "ENTITY_RENAMED", message: `The name "${requestedEventName}" is already used in this product, so the event is named "${finalEventName.data}"`,
  }];

  const usedBuiltIns = [...new Set(document.traits.filter(isLibraryTrait).flatMap((t) => builtIns.data.nameOf.get(t.libraryTraitId) ?? []))];
  const preview: AsyncApiImportPreview = {
    eventName: finalEventName.data, title: boundText(document.info.title, MAX_PREVIEW_TITLE), counts: countsOf(document),
    entities: named.data.payloads.flatMap((payload) => payload.entities.map(({ requestedName, name, renamed, fields, format }) => ({ requestedName, name, renamed, fields, format }))),
    builtInTraits: usedBuiltIns,
    warnings: [...validated.data, ...mapped.data.warnings, ...planned.warnings, ...named.data.warnings, ...eventWarnings],
  };
  return ok({ scope, raw, payloads: named.data.payloads, builtInTraitIds: builtIns.data.ids, preview });
}

/**
 * What an import of this document would do, with nothing written: the resolved event name, the counts, every entity with the name it
 * would get, the built-in traits that would be used and everything the importer had to change or leave out. Fails exactly like the
 * import (an invalid, unsupported or hostile document, a document the mapper rejects, an unknown product).
 */
export async function previewAsyncApiImport(productId: string, input: AsyncApiImportInput, ctx: ServiceContext): Promise<Result<AsyncApiImportPreview>> {
  try {
    const prepared = await prepare(productId, input, ctx, false);
    return prepared.success ? ok(prepared.data.preview) : prepared;
  } catch (e: unknown) {
    return internalFailure("previewAsyncApiImport", e);
  }
}

/**
 * The failure of an import after entities were created, once they (and the event, when it was created) were deleted again. The
 * cause's code and message stay (a database failure becomes `IMPORT_FAILED`: its text is never shown); the message says what was
 * undone, or, when a delete failed, which entities are still there; `details.leftovers` lists them.
 */
function rolledBack(cause: ServiceError, deleted: number, leftovers: UndeletedEntity[], eventLeft: { id: string; message: string } | null): ServiceError {
  const opaque = isOpaqueErrorCode(cause.code);
  const lead = opaque ? "The import failed." : /[.!?]$/.test(cause.message) ? cause.message : `${cause.message}.`;
  const left = [...leftovers.map((l) => `the entity "${l.name}"`), ...(eventLeft ? ["the event it created"] : [])];
  const outcome = left.length === 0
    ? `Nothing was imported: ${deleted === 0 ? "nothing had been created yet" : `the ${deleted} ${deleted === 1 ? "entity" : "entities"} created for it ${deleted === 1 ? "was" : "were"} deleted again`}.`
    : `The import could not be undone completely: ${left.join(", ")} ${left.length === 1 ? "is" : "are"} still in the product; delete ${left.length === 1 ? "it" : "them"} by hand.`;
  return {
    code: opaque ? "IMPORT_FAILED" : cause.code,
    message: `${lead} ${outcome}`,
    ...(cause.suggestedFix && !opaque && { suggestedFix: cause.suggestedFix }),
    details: {
      ...(cause.details && !opaque && { cause: cause.details }),
      deletedEntities: deleted,
      leftovers: [
        ...leftovers.map((l) => ({ kind: "entity", id: l.id, name: l.name, code: l.code, message: l.message })),
        ...(eventLeft ? [{ kind: "event", id: eventLeft.id, message: eventLeft.message }] : []),
      ],
    },
  };
}

/**
 * Imports the document: the entities (drafts, unpublished, `metadata.sourceFormat` set) in one transaction, then the event named
 * `preview.eventName`, whose document pins them without a version. If the event cannot be created or its document cannot be saved,
 * everything created is deleted again and the failure says so (`details.leftovers` names anything that could not be deleted).
 * A document that fails any check before the first write creates no event and no entity (the tenant's built-in library traits are
 * installed idempotently before the first entity is written, as a tenant-level step of the import). Never throws.
 */
export async function importAsyncApi(productId: string, input: AsyncApiImportInput, ctx: ServiceContext): Promise<Result<{ eventId: string; preview: AsyncApiImportPreview }>> {
  let prepared: Result<Prepared>;
  try {
    prepared = await prepare(productId, input, ctx, true);
  } catch (e: unknown) {
    return internalFailure("importAsyncApi", e);
  }
  if (!prepared.success) return prepared;
  const { raw, payloads, builtInTraitIds, preview } = prepared.data;

  let written: CreatedPayloadEntities = { roots: new Map(), created: [] };
  if (payloads.length > 0) {
    const created = await createPayloadEntities(productId, payloads, ctx);
    if (!created.success) return created;
    written = created.data;
  }

  const owner = { level: "PRODUCT" as const, productId };
  let eventId: string | null = null;
  const undo = async (cause: ServiceError): Promise<Result<never>> => {
    let eventLeft: { id: string; message: string } | null = null;
    try {
      if (eventId !== null) {
        const removed = await deleteEvent(eventId, owner, ctx);
        // an event that is already gone (NOT_FOUND: something else removed it) is what the rollback wants, not a leftover
        if (!removed.success && removed.error.code !== "NOT_FOUND") eventLeft = { id: eventId, message: removed.error.message };
      }
    } catch (e: unknown) {
      console.error(`[importAsyncApi] deleting event ${eventId} failed`, e);
      eventLeft = { id: eventId as string, message: "The event could not be deleted" };
    }
    const leftovers = await deleteCreatedEntities(written.created, ctx);
    return { success: false, error: rolledBack(cause, written.created.length - leftovers.length, leftovers, eventLeft) };
  };

  try {
    const pins = new Map<string, EntityPin>([...written.roots].map(([key, entityId]) => [key, { entityId, entityVersionId: null }]));
    const mapped = mapAsyncApiToEventDocument(raw, { payloadPins: pins, builtInTraitIds });
    if (!mapped.success) return await undo(safeImportError(mapped.error));
    const { document } = mapped.data;
    const event = await createEvent(productId, { name: preview.eventName, title: document.info.title, description: document.info.description }, ctx);
    if (!event.success) return await undo(event.error);
    eventId = event.data.id;
    const saved = await updateEventDocument(eventId, document, owner, ctx);
    if (!saved.success) return await undo(saved.error);
    return ok({ eventId, preview });
  } catch (e: unknown) {
    console.error("[importAsyncApi] unexpected error", e);
    return await undo({ code: "INTERNAL_ERROR", message: GENERIC_ACTION_ERROR });
  }
}

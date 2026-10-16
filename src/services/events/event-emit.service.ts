// src/services/events/event-emit.service.ts
// Emission of a self-contained event (spec 2026-10-15-events-self-contained-design §7): the saved draft, an unsaved document
// (preview) or a published version. Nothing here writes.
import type { PrismaClient } from "@/generated/prisma/client";
import {
  canonicalizeDocumentOrder, getEventSpecAdapter, normalizeDiagnostics, StructuralAsyncApi3Validator, toJson, toYaml,
  type Diagnostic, type EmitOutput, type EventSpecValidator, type JsonObject, type ResolvedEventSpec,
} from "@/lib/event-specs";
import { AsyncApiParserValidator } from "@/lib/event-specs/validation/asyncapi-parser-validator";
import { formatVersionLabel, parseVersionLabel } from "@/lib/entity-versioning/version-math";
import { parseEventDocument } from "@/lib/events/document/parse";
import { isJsonObject } from "@/lib/events/inputs";
import { ok, err, type Result } from "@/types/result";
import type { ServiceContext } from "@/types/service-context";
import { getSharedArtifactRenderer, type ArtifactRenderer } from "./artifact-renderer";
import { DRAFT_VERSION, loadEventSnapshot, resolveEventSnapshot, type EventSnapshot } from "./event-snapshot";
import { guardRead, loadOwnedRow, requireId } from "./service-guards";

/** Collaborators of an emission, replaceable in tests: the artifact renderer and the validators run on the assembled document. */
export interface EmitDeps {
  renderer?: ArtifactRenderer;
  validators?: EventSpecValidator[];
}

let sharedValidators: EventSpecValidator[] | undefined;

/** D10: structural + @asyncapi/parser (one parser instance per process — it is expensive to build). */
export function defaultEventSpecValidators(): EventSpecValidator[] {
  sharedValidators ??= [new StructuralAsyncApi3Validator(), new AsyncApiParserValidator()];
  return sharedValidators;
}

/** Assemble, serialize and validate a resolved spec (the adapter for its `specType`); shared by emission and publish. */
export async function emitResolved(resolved: ResolvedEventSpec, specType: string, deps: EmitDeps = {}): Promise<Result<EmitOutput>> {
  const adapter = getEventSpecAdapter(specType, { validators: deps.validators ?? defaultEventSpecValidators() });
  if (!adapter.success) return adapter;
  return adapter.data.emit(resolved);
}

/**
 * `EmitOutput` whose three artifacts are null when the draft could not be resolved (a pin that does not render, an unresolved
 * reference): `diagnostics` then explain why. `EmitOutput` is assignable to it.
 */
export interface EventEmission {
  document: JsonObject | null;
  json: string | null;
  yaml: string | null;
  diagnostics: Diagnostic[];
}

/**
 * Spec §10 ownership, checked ONCE per call before anything is read, rendered or written: the page's product must own the event
 * (unknown event or product → NOT_FOUND, another product's or tenant's event → FORBIDDEN). Neither error carries `details`, and
 * the label is the caller's own id (never the row's name), so a foreign event's name, document or versions never leak.
 */
async function assertOwnedEvent(db: PrismaClient, eventId: string, productId: string): Promise<Result<void>> {
  const eventIdOk = requireId(eventId, "eventId");
  if (!eventIdOk.success) return eventIdOk;
  const productIdOk = requireId(productId, "productId");
  if (!productIdOk.success) return productIdOk;
  const owned = await loadOwnedRow(db, {
    kind: "Event", id: eventId, owner: { level: "PRODUCT", productId: productIdOk.data },
    // Only the level columns: nothing of a foreign event is read.
    load: (id) => db.eventSpec.findUnique({ where: { id }, select: { tenantId: true, domainId: true, productId: true } }),
  });
  return owned.success ? ok(undefined) : owned;
}

/** Render, resolve, assemble and validate one snapshot as the draft (`info.version` = "draft"). */
async function emitSnapshot(ctx: ServiceContext, snapshot: EventSnapshot, deps: EmitDeps): Promise<Result<EventEmission>> {
  const draft = await resolveEventSnapshot(snapshot, deps.renderer ?? getSharedArtifactRenderer(ctx.prisma), DRAFT_VERSION);
  if (!draft.resolved) return ok({ document: null, json: null, yaml: null, diagnostics: normalizeDiagnostics(draft.diagnostics) });
  const out = await emitResolved(draft.resolved, snapshot.event.specType, deps);
  if (!out.success) return out;
  return ok({
    document: out.data.document,
    json: out.data.json,
    yaml: out.data.yaml,
    diagnostics: normalizeDiagnostics([...draft.diagnostics, ...out.data.diagnostics]),
  });
}

/** The saved draft, rendered from the pinned entity versions (an unpinned pin renders the entity's current draft) and emitted. */
export async function emitEventDraft(eventId: string, productId: string, ctx: ServiceContext, deps: EmitDeps = {}): Promise<Result<EventEmission>> {
  return guardRead(async () => {
    const owned = await assertOwnedEvent(ctx.prisma, eventId, productId);
    if (!owned.success) return owned;
    const snapshot = await loadEventSnapshot(ctx.prisma, eventId);
    if (!snapshot.success) return snapshot;
    return emitSnapshot(ctx, snapshot.data, deps);
  });
}

/**
 * The same emission for a document the user has not saved: parsed with the one shared parser (problems come back as a
 * `VALIDATION_ERROR` with `details.problems` pointers), then run through the same pipeline against the event's own tenant and
 * references. Nothing is written — not the draft, not its edges.
 */
export async function emitEventDocumentPreview(
  eventId: string, productId: string, document: unknown, ctx: ServiceContext, deps: EmitDeps = {}
): Promise<Result<EventEmission>> {
  return guardRead(async () => {
    const owned = await assertOwnedEvent(ctx.prisma, eventId, productId);
    if (!owned.success) return owned;
    const parsed = parseEventDocument(document);
    if (!parsed.success) return parsed;
    const snapshot = await loadEventSnapshot(ctx.prisma, eventId, parsed.data);
    if (!snapshot.success) return snapshot;
    return emitSnapshot(ctx, snapshot.data, deps);
  });
}

/** A published version returns its stored AsyncAPI document exactly as saved (never re-rendered or regenerated). */
export async function emitEventStoredVersion(eventId: string, productId: string, version: string, ctx: ServiceContext): Promise<Result<EmitOutput>> {
  return guardRead(async () => {
    const owned = await assertOwnedEvent(ctx.prisma, eventId, productId);
    if (!owned.success) return owned;
    const label = requireId(version, "version");
    if (!label.success) return label;
    const parsed = parseVersionLabel(label.data);
    if (!parsed.success) return parsed;
    const row = await ctx.prisma.eventSpecVersion.findUnique({
      where: { eventSpecId_major_minor: { eventSpecId: eventId, major: parsed.data.major, minor: parsed.data.minor } },
      select: { document: true, major: true, minor: true, compatReport: true },
    });
    if (!row) {
      return err({ code: "NOT_FOUND", message: `Version ${formatVersionLabel(parsed.data)} of event "${eventId}" not found`, suggestedFix: "List the published versions and pick one." });
    }
    if (!isJsonObject(row.document)) {
      return err({ code: "DATA_CORRUPT", message: `Stored document of version ${formatVersionLabel(row)} is invalid` });
    }
    // jsonb returns keys shortest-first; serialize in the assembler's canonical order, like the draft emission.
    const document = canonicalizeDocumentOrder(row.document);
    const report = isJsonObject(row.compatReport) ? row.compatReport : {};
    return ok({
      document,
      json: toJson(document),
      yaml: toYaml(document),
      diagnostics: Array.isArray(report.diagnostics) ? (report.diagnostics as unknown as Diagnostic[]) : [],
    });
  });
}

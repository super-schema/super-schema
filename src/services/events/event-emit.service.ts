// src/services/events/event-emit.service.ts
// Emission of a self-contained event (spec 2026-10-15-events-self-contained-design §7): the saved draft, an unsaved document
// (preview) or a published version. Nothing here writes.
import {
  canonicalizeDocumentOrder, documentSizeProblem, getEventSpecAdapter, normalizeDiagnostics, StructuralAsyncApi3Validator, toJson, toYaml,
  type Diagnostic, type EmitOutput, type EventSpecValidator, type JsonObject, type ResolvedEventSpec,
} from "@/lib/event-specs";
import { AsyncApiParserValidator } from "@/lib/event-specs/validation/asyncapi-parser-validator";
import { entityReader, type PlaceReader } from "@/lib/access/entity-reader";
import { formatVersionLabel, parseVersionLabel } from "@/lib/entity-versioning/version-math";
import { parseEventDocument } from "@/lib/events/document/parse";
import { isJsonObject } from "@/lib/events/inputs";
import { admitCompilerRuns, compilerBusyError, shareInUseError } from "@/lib/emission/emission-admission";
import { ok, err, type Result } from "@/types/result";
import type { ServiceContext } from "@/types/service-context";
import { getSharedArtifactRenderer, type ArtifactRenderer } from "./artifact-renderer";
import { DRAFT_VERSION, eventRenderShare, loadEventSnapshot, resolveEventSnapshot, type EventSnapshot } from "./event-snapshot";
import { validatePinRefs } from "./pin-refs";
import { assertOwnedEvent, guardRead, requireId } from "./service-guards";

/**
 * Collaborators of an emission, replaceable in tests: the artifact renderer and the validators run on the assembled document. `signal` is the
 * caller's: when it aborts (a client went away) the compiler runs of the draft's renders that are still queued start nothing, and a running one is killed.
 */
export interface EmitDeps {
  renderer?: ArtifactRenderer;
  validators?: EventSpecValidator[];
  signal?: AbortSignal;
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
 * Render, resolve, assemble and validate one snapshot as the draft (`info.version` = "draft"). The renders run under the caller's compiler share
 * (src/lib/emission/emission-admission.ts), one unit per render (`eventRenderShare`): a caller over its share is refused at once, and nothing is
 * rendered. A busy compiler or render queue is answered `EMITTER_BUSY` (a retry), not as a document with errors. `canRead` checks every schema
 * the renders reach (a preview).
 */
async function emitSnapshot(ctx: ServiceContext, snapshot: EventSnapshot, deps: EmitDeps, canRead?: PlaceReader): Promise<Result<EventEmission>> {
  const share = admitCompilerRuns(ctx.userId, eventRenderShare(snapshot));
  if (!share) return err(shareInUseError());
  try {
    const draft = await resolveEventSnapshot(snapshot, deps.renderer ?? getSharedArtifactRenderer(ctx.prisma), DRAFT_VERSION, canRead, { signal: deps.signal });
    if (draft.busy) return err(compilerBusyError());
    if (!draft.resolved) return ok({ document: null, json: null, yaml: null, diagnostics: normalizeDiagnostics(draft.diagnostics) });
    const out = await emitResolved(draft.resolved, snapshot.event.specType, deps);
    if (!out.success) return out;
    return ok({
      document: out.data.document,
      json: out.data.json,
      yaml: out.data.yaml,
      diagnostics: normalizeDiagnostics([...draft.diagnostics, ...out.data.diagnostics]),
    });
  } finally {
    share();
  }
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
 * `VALIDATION_ERROR` with `details.problems` pointers), its pins checked by the save's rule against the event's own tenant and then
 * against the caller's read scope, and run through the same pipeline. The caller's read scope also checks every schema the pins reach, so a
 * readable pin whose schema refers to an entity the caller's roles do not cover renders nothing. The bound of a document (`documentSizeProblem`)
 * is applied by the emission (`AsyncApi3Adapter.emit`), as for a saved draft. Nothing is written — not the draft, not its edges.
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
    // The pins are the client's words. One naming an entity outside the event's tenant, or one the caller's roles do not cover, is refused as
    // an unknown id is (the save's message, no render). The entities a pinned schema reaches are read by the caller's roles too (the renderer).
    // Not read-checked here (KD-044): an external event reference's resolved spec, and a library trait's spec, which the save's domain rule
    // (`validateDocumentRefs`) does not apply to the preview either.
    const canRead = entityReader(ctx.assignments);
    const problems = await validatePinRefs(ctx.prisma, snapshot.data.event.tenantId, parsed.data, canRead);
    if (problems.length > 0) {
      // The builder's preview shows the message alone, so the first problems are named in it (the pointers stay in `details`).
      const named = problems.slice(0, 3).map((p) => p.message).join("; ");
      const more = problems.length > 3 ? ` (and ${problems.length - 3} more)` : "";
      return err({ code: "VALIDATION_ERROR", message: `The event references ${problems.length} unknown or invalid item(s): ${named}${more}`, details: { problems } });
    }
    return emitSnapshot(ctx, snapshot.data, deps, canRead);
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
    // A stored document is served as it was published; one past the bounds is refused here too, so it cannot cost more to serve than to publish.
    const tooLarge = documentSizeProblem(document);
    if (tooLarge !== null) {
      return err({ code: "VALIDATION_ERROR", message: `Version ${formatVersionLabel(row)} of event "${eventId}" cannot be served: ${tooLarge}` });
    }
    const report = isJsonObject(row.compatReport) ? row.compatReport : {};
    return ok({
      document,
      json: toJson(document),
      yaml: toYaml(document),
      diagnostics: Array.isArray(report.diagnostics) ? (report.diagnostics as unknown as Diagnostic[]) : [],
    });
  });
}

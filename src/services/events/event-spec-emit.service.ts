import {
  getEventSpecAdapter, normalizeDiagnostics, StructuralAsyncApi3Validator, toJson, toYaml,
  type Diagnostic, type EmitOutput, type EventSpecValidator, type JsonObject, type ResolvedEventSpec,
} from "@/lib/event-specs";
import { AsyncApiParserValidator } from "@/lib/event-specs/validation/asyncapi-parser-validator";
import { formatVersionLabel, parseVersionLabel } from "@/lib/entity-versioning/version-math";
import { isJsonObject } from "@/lib/events/inputs";
import { ok, err, type Result, type ServiceError } from "@/types/result";
import type { ServiceContext } from "@/types/service-context";
import { getSharedArtifactRenderer, type ArtifactRenderer } from "./artifact-renderer";
import { DRAFT_VERSION, loadDraftSnapshot, resolveSnapshot } from "./event-spec-resolver";

export type EmitTarget = { draft: true } | { versionLabel: string };

export interface EventSpecEmission {
  specId: string;
  specName: string;
  /** "draft" or MAJOR.MINOR. */
  version: string;
  published: boolean;
  document: JsonObject | null;
  json: string | null;
  yaml: string | null;
  diagnostics: Diagnostic[];
  unpublishedMessages: Array<{ id: string; name: string }>;
}

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

const UNEXPECTED_FAILURE: ServiceError = {
  code: "INTERNAL_ERROR",
  message: "The event spec could not be read or emitted. Try again; if it keeps failing, contact an administrator.",
};

/**
 * Nothing throws across a service boundary. An unexpected throw (lost connection, driver error) is logged server-side and
 * returned as a generic failure — its text never reaches the client.
 */
async function guarded<T>(what: string, run: () => Promise<Result<T>>): Promise<Result<T>> {
  try {
    return await run();
  } catch (e: unknown) {
    console.error(`[event-spec-emit] ${what} failed:`, e);
    return err(UNEXPECTED_FAILURE);
  }
}

export async function emitResolved(resolved: ResolvedEventSpec, specType: string, deps: EmitDeps = {}): Promise<Result<EmitOutput>> {
  const adapter = getEventSpecAdapter(specType, { validators: deps.validators ?? defaultEventSpecValidators() });
  if (!adapter.success) return adapter;
  return adapter.data.emit(resolved);
}

async function emitStoredVersion(ctx: ServiceContext, specId: string, label: string): Promise<Result<EventSpecEmission>> {
  const parsed = parseVersionLabel(label);
  if (!parsed.success) return parsed;
  const row = await ctx.prisma.eventSpecVersion.findUnique({
    where: { eventSpecId_major_minor: { eventSpecId: specId, major: parsed.data.major, minor: parsed.data.minor } },
    select: { document: true, major: true, minor: true, compatReport: true, eventSpec: { select: { name: true } } },
  });
  if (!row) {
    return err({ code: "NOT_FOUND", message: `Version ${formatVersionLabel(parsed.data)} of event spec "${specId}" not found`, suggestedFix: "List the published versions and pick one." });
  }
  const document = row.document as JsonObject;
  const report = isJsonObject(row.compatReport) ? row.compatReport : {};
  return ok({
    specId,
    specName: row.eventSpec.name,
    version: formatVersionLabel(row),
    published: true,
    document,
    json: toJson(document),
    yaml: toYaml(document),
    diagnostics: Array.isArray(report.diagnostics) ? (report.diagnostics as unknown as Diagnostic[]) : [],
    unpublishedMessages: [],
  });
}

async function emitDraft(ctx: ServiceContext, specId: string, deps: EmitDeps): Promise<Result<EventSpecEmission>> {
  const snapshot = await loadDraftSnapshot(ctx.prisma, specId);
  if (!snapshot.success) return snapshot;
  const draft = await resolveSnapshot(snapshot.data, deps.renderer ?? getSharedArtifactRenderer(ctx.prisma), DRAFT_VERSION);
  const base = {
    specId,
    specName: snapshot.data.spec.name,
    version: DRAFT_VERSION,
    published: false,
    unpublishedMessages: snapshot.data.messages.filter((m) => m.unpublished).map((m) => ({ id: m.messageId, name: m.name })),
  };
  if (!draft.resolved) return ok({ ...base, document: null, json: null, yaml: null, diagnostics: normalizeDiagnostics(draft.diagnostics) });
  const out = await emitResolved(draft.resolved, snapshot.data.spec.specType, deps);
  if (!out.success) return out;
  return ok({
    ...base,
    document: out.data.document,
    json: out.data.json,
    yaml: out.data.yaml,
    diagnostics: normalizeDiagnostics([...draft.diagnostics, ...out.data.diagnostics]),
  });
}

/** Spec §7.2: a published version returns its stored document (never regenerated); a draft is resolved, rendered, emitted and validated. */
export async function emitEventSpec(specId: string, target: EmitTarget, ctx: ServiceContext, deps: EmitDeps = {}): Promise<Result<EventSpecEmission>> {
  return guarded("emitEventSpec", () =>
    "versionLabel" in target ? emitStoredVersion(ctx, specId, target.versionLabel) : emitDraft(ctx, specId, deps)
  );
}

export async function getLatestEventSpecVersionLabel(specId: string, ctx: ServiceContext): Promise<Result<string | null>> {
  return guarded("getLatestEventSpecVersionLabel", async () => {
    const row = await ctx.prisma.eventSpec.findUnique({ where: { id: specId }, select: { latestVersion: { select: { major: true, minor: true } } } });
    if (!row) return err({ code: "NOT_FOUND", message: `Event spec "${specId}" not found` });
    return ok(row.latestVersion ? formatVersionLabel(row.latestVersion) : null);
  });
}

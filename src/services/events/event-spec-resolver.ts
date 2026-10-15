import type { PrismaClient, Prisma } from "@/generated/prisma/client";
import { diagnostic } from "@/lib/event-specs/diagnostics";
import { resolveEventSpecDocument, type ResolveProblem } from "@/lib/event-specs/resolve";
import type { Diagnostic, EventSpecDocument, PayloadFormat, ResolvedChannel, ResolvedEventSpec, SchemaArtifact } from "@/lib/event-specs/types";
import { formatVersionLabel } from "@/lib/entity-versioning/version-math";
import {
  messageSourceFromDraft, messageSourceFromVersion, planArtifacts, toFrozenTrait, toResolvedChannel, toResolvedMessage, toResolvedTrait,
  traitHeadersSubject, type MessageSource,
} from "@/lib/events/catalog-mapping";
import { collectDocumentRefs, parseEventSpecDocument } from "@/lib/events/event-spec-document";
import type { FrozenTrait } from "@/lib/events/types";
import { ok, err, type Result, type ServiceError } from "@/types/result";
import type { ArtifactRenderer, ArtifactSubject } from "./artifact-renderer";

type Db = PrismaClient | Prisma.TransactionClient;

/** D13: `info.version` of a draft emission. */
export const DRAFT_VERSION = "draft";

/**
 * A MessageVersion's identity as the bump classifier needs it. Structurally identical to
 * `MessageVersionInfo` in `@/lib/events/bump-rules` (Task 6, a later wave in this branch's history) — declared here so the
 * resolver does not depend on a module that is not merged yet; the two are interchangeable.
 */
export interface MessageVersionInfo {
  messageId: string;
  messageName: string;
  major: number;
  label: string;
}

export interface LatestEventSpecVersion {
  id: string;
  major: number;
  minor: number;
  sequence: number;
  sourceDocument: EventSpecDocument;
  frozenChannels: ResolvedChannel[];
  frozenTraits: FrozenTrait[];
  messageVersionIds: string[];
}

export interface DraftSnapshot {
  spec: {
    id: string; name: string; specType: string; tenantId: string; domainId: string | null; productId: string; productSlug: string;
    updatedAt: Date; hasUnpublishedChanges: boolean; latestVersionId: string | null;
  };
  document: EventSpecDocument;
  latest: LatestEventSpecVersion | null;
  /** Referenced channels (incl. other products'), live, first-reference order. */
  channels: ResolvedChannel[];
  /** Operation traits + message traits, live, first-reference order. */
  traits: FrozenTrait[];
  messages: MessageSource[];
  /** Every MessageVersion used by the draft or by the latest version. */
  messageVersionInfo: Record<string, MessageVersionInfo>;
  /** Unresolved draft references (pointers into the draft document). */
  unresolved: ResolveProblem[];
}

const CHANNEL_SELECT = {
  id: true, name: true, address: true, protocol: true, format: true, formatDialect: true, spec: true, product: { select: { slug: true } },
} satisfies Prisma.ChannelSelect;
const TRAIT_SELECT = {
  id: true, name: true, kind: true, spec: true, headersEntityId: true, headersEntityVersionId: true,
  tenant: { select: { slug: true } }, domain: { select: { slug: true } }, product: { select: { slug: true } },
} satisfies Prisma.TraitSelect;
const VERSION_SELECT = {
  id: true, messageId: true, major: true, minor: true, resolvedSpec: true, message: { select: { name: true, product: { select: { slug: true } } } },
} satisfies Prisma.MessageVersionSelect;
const DRAFT_SELECT = {
  id: true, name: true, spec: true, payloadEntityId: true, payloadEntityVersionId: true, headersEntityId: true, headersEntityVersionId: true,
  keyEntityId: true, keyEntityVersionId: true, product: { select: { slug: true } },
} satisfies Prisma.MessageSelect;

const present = <T>(v: T | undefined): v is T => v !== undefined;

/** Spec §7.2 step 2 (DB half): everything a draft needs, without rendering any artifact. */
export async function loadDraftSnapshot(db: Db, specId: string): Promise<Result<DraftSnapshot>> {
  const row = await db.eventSpec.findUnique({
    where: { id: specId },
    select: {
      id: true, name: true, specType: true, document: true, tenantId: true, domainId: true, productId: true, updatedAt: true,
      hasUnpublishedChanges: true, latestVersionId: true, product: { select: { slug: true } },
      latestVersion: { select: { id: true, major: true, minor: true, sequence: true, sourceDocument: true, frozenChannels: true, frozenTraits: true, messageVersionIds: true } },
    },
  });
  if (!row || !row.productId || !row.product) return err({ code: "NOT_FOUND", message: `Event spec "${specId}" not found` });
  const document = parseEventSpecDocument(row.document);
  if (!document.success) return err({ code: "DATA_CORRUPT", message: `Stored draft of "${row.name}" is invalid`, details: document.error.details });

  let latest: LatestEventSpecVersion | null = null;
  if (row.latestVersion) {
    const source = parseEventSpecDocument(row.latestVersion.sourceDocument);
    if (!source.success) return err({ code: "DATA_CORRUPT", message: `Published source document of "${row.name}" is invalid` });
    latest = {
      id: row.latestVersion.id, major: row.latestVersion.major, minor: row.latestVersion.minor, sequence: row.latestVersion.sequence,
      sourceDocument: source.data,
      frozenChannels: (row.latestVersion.frozenChannels as unknown as ResolvedChannel[]) ?? [],
      frozenTraits: (row.latestVersion.frozenTraits as unknown as FrozenTrait[]) ?? [],
      messageVersionIds: row.latestVersion.messageVersionIds,
    };
  }

  const refs = collectDocumentRefs(document.data);
  const versionIds = [...new Set([...refs.messageRefIds, ...(latest?.messageVersionIds ?? [])])];
  const [channelRows, versionRows] = await Promise.all([
    db.channel.findMany({ where: { id: { in: refs.channelIds }, tenantId: row.tenantId }, select: CHANNEL_SELECT }),
    db.messageVersion.findMany({ where: { id: { in: versionIds }, message: { tenantId: row.tenantId } }, select: VERSION_SELECT }),
  ]);
  const versionById = new Map(versionRows.map((v) => [v.id, v]));
  const draftIds = refs.messageRefIds.filter((id) => !versionById.has(id));
  const draftRows = draftIds.length > 0
    ? await db.message.findMany({ where: { id: { in: draftIds }, productId: row.productId }, select: DRAFT_SELECT })
    : [];
  const draftById = new Map(draftRows.map((d) => [d.id, d]));

  const messages: MessageSource[] = refs.messageRefIds
    .map((id) => {
      const v = versionById.get(id);
      if (v) return messageSourceFromVersion(v) ?? undefined;
      const d = draftById.get(id);
      return d ? messageSourceFromDraft(d) : undefined;
    })
    .filter(present);

  const traitIds = [...new Set([...refs.traitIds, ...messages.flatMap((m) => m.spec.traitIds)])];
  const traitRows = traitIds.length > 0 ? await db.trait.findMany({ where: { id: { in: traitIds }, tenantId: row.tenantId }, select: TRAIT_SELECT }) : [];
  const traitById = new Map(traitRows.map((t) => [t.id, toFrozenTrait(t)]));
  const traits = traitIds.map((id) => traitById.get(id)).filter(present);
  const channelById = new Map(channelRows.map((c) => [c.id, toResolvedChannel(c)]));
  const channels = refs.channelIds.map((id) => channelById.get(id)).filter(present);

  const messageVersionInfo: Record<string, MessageVersionInfo> = {};
  for (const v of versionRows) messageVersionInfo[v.id] = { messageId: v.messageId, messageName: v.message.name, major: v.major, label: formatVersionLabel(v) };

  // Reference check with an artifact-less catalog: every unresolved id is reported together, with a draft pointer.
  const skeleton = resolveEventSpecDocument(
    document.data,
    { channels, messages: messages.map((m) => toResolvedMessage(m, { payloads: [], keys: [] })), traits: traits.map((t) => toResolvedTrait(t)) },
    { productSlug: row.product.slug, version: DRAFT_VERSION }
  );
  const unresolved: ResolveProblem[] = skeleton.success
    ? []
    : ((skeleton.error.details as { problems?: ResolveProblem[] } | undefined)?.problems ?? [{ pointer: "", message: skeleton.error.message }]);

  return ok({
    spec: {
      id: row.id, name: row.name, specType: row.specType, tenantId: row.tenantId, domainId: row.domainId, productId: row.productId,
      productSlug: row.product.slug, updatedAt: row.updatedAt, hasUnpublishedChanges: row.hasUnpublishedChanges, latestVersionId: row.latestVersionId,
    },
    document: document.data,
    latest,
    channels,
    traits,
    messages,
    messageVersionInfo,
    unresolved,
  });
}

/**
 * Codes whose message is written by our own loader / combiner / limiter and is safe to show to the user. Anything else —
 * an unexpected throw wrapped as `ARTIFACT_RENDER_FAILED` without a cause, `EMITTER_FAILED` (raw `tsp` stdout / stderr with
 * temp paths), `ARTIFACT_PARSE_FAILED`, or a code this list does not know — is replaced by a generic text; the original is
 * logged server-side only.
 */
const USER_FACING_RENDER_CODES = new Set([
  "NOT_FOUND", "UNRESOLVED_REFERENCE", "UNPUBLISHED_REFERENCE", "ROOT_MODEL_NOT_FOUND", "ROOT_SCHEMA_NOT_FOUND",
  "SCHEMA_BUNDLE_UNRESOLVED", "REFERENCE_CLOSURE_TOO_LARGE", "CONFLICTING_PINS", "TYPESPEC_DECLARATION_CONFLICT",
  "TYPESPEC_IMPORT_NOT_ALLOWED", "TYPESPEC_PARSE_ERROR", "PROTO_NOT_SELF_CONTAINED", "AVRO_NAME_CONFLICT", "EMITTER_TIMEOUT",
  "UNSUPPORTED_FORMAT",
]);
const GENERIC_RENDER_FAILURE = "Artifact render failed";
const MAX_RENDER_DETAIL = 400;
/** Absolute multi-segment filesystem paths (temp workspaces) — never shown, even inside an otherwise user-facing message. */
const FILE_PATH = /(?<![\w#:.@-])\/(?:[\w.@+~-]+\/){2,}[\w.@+~-]*|superschema-tsp-[\w-]+/g;
const userFacing = (text: string): string => text.replace(FILE_PATH, "<path>").slice(0, MAX_RENDER_DETAIL);

/**
 * A render failure as a diagnostic. The renderer returns `ARTIFACT_RENDER_FAILED` for combine / emit errors (the
 * underlying code is in `details.cause`) and the loader's own code for everything else; both shapes keep their code, and
 * the cause code is appended (`[EMITTER_FAILED]`). Only messages from `USER_FACING_RENDER_CODES` are shown (scrubbed of file
 * paths, capped); unexpected failures get a generic text and are logged.
 */
function renderDiagnostic(what: string, format: PayloadFormat, error: ServiceError): Diagnostic {
  const cause = (error.details as { cause?: unknown } | undefined)?.cause;
  const causeCode = typeof cause === "string" ? cause : undefined;
  const effective = error.code === "ARTIFACT_RENDER_FAILED" ? causeCode : error.code;
  const shown = effective !== undefined && USER_FACING_RENDER_CODES.has(effective);
  if (!shown) console.error(`[event-spec-resolver] ${what} (${format}) render failed (${error.code}${causeCode ? `/${causeCode}` : ""}):`, error.message);
  const text = shown ? userFacing(error.message) : GENERIC_RENDER_FAILURE;
  const parts = [`${what} (${format}): ${text}`];
  if (causeCode && causeCode !== error.code && !text.includes(causeCode)) parts.push(`[${causeCode}]`);
  if (shown && error.suggestedFix) parts.push(`Fix: ${userFacing(error.suggestedFix)}`);
  return diagnostic("error", error.code, parts.join(" "), "");
}

/** Spec §7.2 step 3: render every artifact in the channels' format profiles, then build the ResolvedEventSpec. */
export async function resolveSnapshot(
  snapshot: DraftSnapshot,
  renderer: ArtifactRenderer,
  version: string
): Promise<{ resolved: ResolvedEventSpec | null; diagnostics: Diagnostic[] }> {
  if (snapshot.unresolved.length > 0) {
    return { resolved: null, diagnostics: snapshot.unresolved.map((p) => diagnostic("error", "UNRESOLVED_REFERENCE", `Draft reference: ${p.message}`, p.pointer)) };
  }
  const diagnostics: Diagnostic[] = [];
  const render = async (subject: ArtifactSubject | null, format: PayloadFormat, what: string): Promise<SchemaArtifact | undefined> => {
    if (!subject) return undefined;
    const r = await renderer.render(subject, format);
    if (!r.success) {
      diagnostics.push(renderDiagnostic(what, format, r.error));
      return undefined;
    }
    for (const w of r.data.warnings) diagnostics.push(diagnostic("warning", "TYPESPEC_DUPLICATE_DECLARATION", `${what}: ${w}`, ""));
    return r.data.artifact;
  };
  const isArtifact = (a: SchemaArtifact | undefined): a is SchemaArtifact => a !== undefined;

  const needs = planArtifacts(snapshot.document, new Map(snapshot.channels.map((c) => [c.id, c])));
  const messages = await Promise.all(
    snapshot.messages.map(async (m) => {
      const need = needs.get(m.id) ?? { payloadFormats: [], keyFormats: [] };
      const [payloads, keys, headers] = await Promise.all([
        Promise.all(need.payloadFormats.map((f) => render(m.payload, f, `Message ${m.name} payload`))),
        Promise.all(need.keyFormats.map((f) => render(m.key, f, `Message ${m.name} key`))),
        render(m.headers, "json-schema", `Message ${m.name} headers`),
      ]);
      return toResolvedMessage(m, { payloads: payloads.filter(isArtifact), keys: keys.filter(isArtifact), headers });
    })
  );
  const traits = await Promise.all(
    snapshot.traits.map(async (t) => toResolvedTrait(t, await render(traitHeadersSubject(t), "json-schema", `Trait ${t.name} headers`)))
  );
  const resolved = resolveEventSpecDocument(snapshot.document, { channels: snapshot.channels, messages, traits }, { productSlug: snapshot.spec.productSlug, version });
  if (!resolved.success) return { resolved: null, diagnostics: [...diagnostics, diagnostic("error", resolved.error.code, resolved.error.message, "")] };
  return { resolved: resolved.data, diagnostics };
}

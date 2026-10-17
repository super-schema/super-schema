// src/services/events/event-snapshot.ts
// DB half and render half of a self-contained event's emission (spec 2026-10-15-events-self-contained-design §7), for document v2.
// `loadEventSnapshot` reads, `resolveEventSnapshot` renders and resolves. Nothing is written.
import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { diagnostic } from "@/lib/event-specs/diagnostics";
import type { Diagnostic, PayloadFormat, ResolvedChannel, ResolvedMessage, ResolvedEventSpec, ResolvedTrait, SchemaArtifact } from "@/lib/event-specs/types";
import { toFrozenTrait, traitHeadersSubject } from "@/lib/events/catalog-mapping";
import { collectDocumentRefs } from "@/lib/events/document/edges";
import { parseEventDocument } from "@/lib/events/document/parse";
import { entitySourceFormat } from "@/lib/events/document/representation";
import { planDocumentArtifacts, resolveDocument, type ExternalItems, type MessageArtifacts } from "@/lib/events/document/resolve";
import { isLibraryTrait, type DocExternalRef, type DocumentProblem, type EventDocument } from "@/lib/events/document/types";
import { referenceableItems } from "@/lib/events/external-refs";
import { isJsonObject } from "@/lib/events/inputs";
import type { EntityPin, FrozenTrait } from "@/lib/events/types";
import { ok, err, type Result, type ServiceError } from "@/types/result";
import type { ArtifactRenderer, ArtifactSubject } from "./artifact-renderer";

type Db = PrismaClient | Prisma.TransactionClient;

/** `info.version` of a draft / preview emission (D13). */
export const DRAFT_VERSION = "draft";

/** A library trait row with the slugs its owner label needs (`toFrozenTrait`). */
export const TRAIT_SELECT = {
  id: true, name: true, kind: true, spec: true, headersEntityId: true, headersEntityVersionId: true,
  tenant: { select: { slug: true } }, domain: { select: { slug: true } }, product: { select: { slug: true } },
} satisfies Prisma.TraitSelect;

export interface EventSnapshot {
  event: { id: string; name: string; tenantId: string; domainId: string; productId: string; productSlug: string; specType: string };
  document: EventDocument;
  /**
   * The latest published version. `sourceDocument`, `frozenTraits` and `compatReport` are stored JSON, handed over as read: whoever
   * uses them parses and shape-checks them (publish does — `event-publish-facts.ts`).
   */
  latest: { id: string; major: number; minor: number; sequence: number; sourceDocument: unknown; resolvedSpec: unknown; frozenTraits: unknown; compatReport: unknown } | null;
  /** The tenant's library traits the document points at, by `libraryTraitId`. A trait that was not found is simply absent. */
  libraryTraits: Map<string, FrozenTrait>;
  /** What each `externalRefs[]` entry resolves to, by ref key, from the referenced version's stored `resolvedSpec`. A ref that cannot be resolved is absent. */
  external: Map<string, ExternalItems>;
  /** Major of every referenced event version that exists in the tenant, by `eventVersionId` (also when it has no `resolvedSpec`). */
  externalMajors: Record<string, number>;
  /**
   * The representation each payload entity was imported in (`entity.metadata.sourceFormat`), by entity id: what a message's "Auto"
   * follows. Only entities of the event's tenant, and only those that record a usable format (Avro / JSON Schema / Protobuf).
   */
  entityFormats: Map<string, PayloadFormat>;
}

const EVENT_SELECT = {
  id: true, name: true, specType: true, document: true, tenantId: true, domainId: true, productId: true,
  product: { select: { slug: true } },
  latestVersion: { select: { id: true, major: true, minor: true, sequence: true, sourceDocument: true, resolvedSpec: true, frozenTraits: true, compatReport: true } },
} satisfies Prisma.EventSpecSelect;

const EXTERNAL_VERSION_SELECT = { id: true, major: true, resolvedSpec: true } satisfies Prisma.EventSpecVersionSelect;

const byId = (list: unknown, id: string) => (Array.isArray(list) ? list.find((x): x is Record<string, unknown> => isJsonObject(x) && x.id === id) : undefined);

/**
 * The referenced item inside a published version's stored `resolvedSpec`, or null when it cannot be used: the version has no
 * `resolvedSpec` (published before document v2), the item is not in it, or it is not `isReferenceableItem` (the resolver then
 * reports the ref as unresolved, instead of the assembler crashing on a malformed stored value).
 * An external message brings the traits it lists in `traitRefs` — those that the stored spec holds; the resolver flags any it lacks.
 */
function externalItems(ref: DocExternalRef, resolvedSpec: unknown): ExternalItems | null {
  if (!isJsonObject(resolvedSpec)) return null;
  // The one rule every reader shares (`isReferenceableItem`): the entry must have the shape the assembler needs.
  const item = referenceableItems(resolvedSpec, ref.kind)?.get(ref.itemKey);
  if (!item) return null;
  if (ref.kind === "channel") return { channel: item as unknown as ResolvedChannel };
  const traits: ResolvedTrait[] = [];
  for (const id of item.traitRefs as string[]) {
    const trait = byId(resolvedSpec.traits, id);
    if (trait) traits.push(trait as unknown as ResolvedTrait);
  }
  return { message: item as unknown as ResolvedMessage, traits };
}

/**
 * Everything an event emission needs from the database, without rendering any artifact. `override` replaces the stored draft
 * (a preview of unsaved edits): the stored document is then not even parsed. Library traits and referenced event versions are
 * read inside the event's tenant only — another tenant's rows never resolve. Other products' events are visible only through
 * a published version that this event references.
 */
export async function loadEventSnapshot(db: Db, eventId: string, override?: EventDocument): Promise<Result<EventSnapshot>> {
  const row = await db.eventSpec.findUnique({ where: { id: eventId }, select: EVENT_SELECT });
  if (!row || !row.domainId || !row.productId || !row.product) return err({ code: "NOT_FOUND", message: `Event "${eventId}" not found` });

  let document: EventDocument;
  if (override) document = override;
  else {
    const parsed = parseEventDocument(row.document);
    if (!parsed.success) return err({ code: "DATA_CORRUPT", message: `Stored draft of "${row.name}" is invalid`, details: parsed.error.details });
    document = parsed.data;
  }

  const refs = collectDocumentRefs(document);
  const payloadEntityIds = [...new Set(document.messages.map((m) => m.payload.entityId).filter((id) => id !== ""))];
  const [traitRows, versionRows, entityRows] = await Promise.all([
    refs.libraryTraitIds.length > 0
      ? db.trait.findMany({ where: { id: { in: refs.libraryTraitIds }, tenantId: row.tenantId }, select: TRAIT_SELECT })
      : [],
    refs.externalVersionIds.length > 0
      ? db.eventSpecVersion.findMany({ where: { id: { in: refs.externalVersionIds }, eventSpec: { tenantId: row.tenantId } }, select: EXTERNAL_VERSION_SELECT })
      : [],
    // Only the metadata of the event's own tenant's payload entities: another tenant's entity never says how a message renders.
    payloadEntityIds.length > 0
      ? db.entity.findMany({ where: { id: { in: payloadEntityIds }, tenantId: row.tenantId }, select: { id: true, metadata: true } })
      : [],
  ]);

  const entityFormats = new Map<string, PayloadFormat>();
  for (const entity of entityRows) {
    const format = entitySourceFormat(entity.metadata);
    if (format) entityFormats.set(entity.id, format);
  }

  const traitById = new Map(traitRows.map((t) => [t.id, toFrozenTrait(t)]));
  const libraryTraits = new Map<string, FrozenTrait>();
  for (const id of refs.libraryTraitIds) {
    const trait = traitById.get(id);
    if (trait) libraryTraits.set(id, trait);
  }

  const versionById = new Map(versionRows.map((v) => [v.id, v]));
  const external = new Map<string, ExternalItems>();
  for (const ref of document.externalRefs) {
    if (external.has(ref.key)) continue;
    const items = externalItems(ref, versionById.get(ref.eventVersionId)?.resolvedSpec);
    if (items) external.set(ref.key, items);
  }
  const externalMajors: Record<string, number> = {};
  for (const id of refs.externalVersionIds) {
    const version = versionById.get(id);
    if (version) externalMajors[id] = version.major;
  }

  return ok({
    event: { id: row.id, name: row.name, tenantId: row.tenantId, domainId: row.domainId, productId: row.productId, productSlug: row.product.slug, specType: row.specType },
    document,
    latest: row.latestVersion
      ? {
          id: row.latestVersion.id, major: row.latestVersion.major, minor: row.latestVersion.minor, sequence: row.latestVersion.sequence,
          sourceDocument: row.latestVersion.sourceDocument, resolvedSpec: row.latestVersion.resolvedSpec, frozenTraits: row.latestVersion.frozenTraits,
          compatReport: row.latestVersion.compatReport,
        }
      : null,
    libraryTraits,
    external,
    externalMajors,
    entityFormats,
  });
}

/**
 * Codes whose message is written by our own loader / combiner / limiter and is safe to show to the user. Anything else — an
 * unexpected throw wrapped as `ARTIFACT_RENDER_FAILED` without a cause, `EMITTER_FAILED` (raw `tsp` stdout / stderr with temp
 * paths), `ARTIFACT_PARSE_FAILED`, or a code this list does not know — is replaced by a generic text; the original is logged
 * server-side only (R67).
 */
const USER_FACING_RENDER_CODES = new Set([
  "NOT_FOUND", "UNRESOLVED_REFERENCE", "UNPUBLISHED_REFERENCE", "ROOT_MODEL_NOT_FOUND", "ROOT_SCHEMA_NOT_FOUND",
  "SCHEMA_BUNDLE_UNRESOLVED", "REFERENCE_CLOSURE_TOO_LARGE", "CONFLICTING_PINS", "TYPESPEC_DECLARATION_CONFLICT",
  "TYPESPEC_IMPORT_NOT_ALLOWED", "TYPESPEC_PARSE_ERROR", "PROTO_NOT_SELF_CONTAINED", "AVRO_NAME_CONFLICT", "EMITTER_TIMEOUT",
  "UNSUPPORTED_FORMAT",
  "AVRO_SYMBOL_COLLISION", "AVRO_INVALID_SYMBOL", "ENUM_NO_VALUES", "ROOT_MESSAGE_NOT_FOUND",
]);
const GENERIC_RENDER_FAILURE = "Artifact render failed";
const MAX_RENDER_DETAIL = 400;
/** Absolute multi-segment filesystem paths (temp workspaces) — never shown, even inside an otherwise user-facing message. */
const FILE_PATH = /(?<![\w#:.@-])\/(?:[\w.@+~-]+\/){2,}[\w.@+~-]*|superschema-tsp-[\w-]+/g;
const userFacing = (text: string): string => text.replace(FILE_PATH, "<path>").slice(0, MAX_RENDER_DETAIL);

/** A render failure as an error diagnostic at `pointer` (into the draft document). */
function renderDiagnostic(what: string, format: PayloadFormat, error: ServiceError, pointer: string): Diagnostic {
  const cause = (error.details as { cause?: unknown } | undefined)?.cause;
  const causeCode = typeof cause === "string" ? cause : undefined;
  const effective = error.code === "ARTIFACT_RENDER_FAILED" ? causeCode : error.code;
  const shown = effective !== undefined && USER_FACING_RENDER_CODES.has(effective);
  if (!shown) console.error(`[event-snapshot] ${what} (${format}) render failed (${error.code}${causeCode ? `/${causeCode}` : ""}):`, error.message);
  const text = shown ? userFacing(error.message) : GENERIC_RENDER_FAILURE;
  const parts = [`${what} (${format}): ${text}`];
  if (causeCode && causeCode !== error.code && !text.includes(causeCode)) parts.push(`[${causeCode}]`);
  if (shown && error.suggestedFix) parts.push(`Fix: ${userFacing(error.suggestedFix)}`);
  return diagnostic("error", error.code, parts.join(" "), pointer);
}

/** Pinned → that immutable version; unpinned → the entity's current draft (preview only: publish refuses an unpinned pin). */
const pinSubject = (pin: EntityPin): ArtifactSubject =>
  pin.entityVersionId ? { kind: "version", entityVersionId: pin.entityVersionId } : { kind: "draft", entityId: pin.entityId };

const unpublishedPin = (what: string, pointer: string): Diagnostic =>
  diagnostic("info", "UNPUBLISHED_PIN", `${what} is not pinned to a published version; the preview uses the entity's current draft`, pointer);

/** Resolver problems (pointers into the draft document) as diagnostics; any other failure has no pointer to give. */
function problemDiagnostics(error: ServiceError): Diagnostic[] {
  const problems = (error.details as { problems?: DocumentProblem[] } | undefined)?.problems;
  if (!Array.isArray(problems) || problems.length === 0) return [diagnostic("error", error.code, error.message, "")];
  return problems.map((p) => diagnostic("error", "UNRESOLVED_REFERENCE", p.message, p.pointer));
}

type Rendered = { artifact?: SchemaArtifact; diagnostics: Diagnostic[] };

/**
 * Render every artifact the document needs, then build the `ResolvedEventSpec`. Every diagnostic produced here points into the
 * DRAFT document (`/messages/0/payload`, `/traits/1/headers`, `/externalRefs/2`, …); the assembler's and the validators'
 * diagnostics, added by the emit step, point into the emitted AsyncAPI document.
 *
 * Every message is rendered (emitAll: the emission shows everything the user defined): payload in each message's effective
 * representation on the channels that carry it — its own choice, the channel's explicit format, the entity's recorded source
 * format, the protocol default — or JSON Schema when no channel carries it; Kafka key per `planDocumentArtifacts`; headers as
 * JSON Schema. A message whose payload failed to render is left out, so the
 * resolver reports it unresolved. Header / key failures are reported but do not stop resolution (the assembler omits the
 * artifact; the error diagnostic still blocks publish). Every local trait with a headers pin and every library trait with a
 * headers pin renders its headers as JSON Schema whether or not anything uses it.
 */
export async function resolveEventSnapshot(
  snapshot: EventSnapshot,
  renderer: ArtifactRenderer,
  version: string
): Promise<{ resolved: ResolvedEventSpec | null; diagnostics: Diagnostic[] }> {
  const doc = snapshot.document;
  const render = async (subject: ArtifactSubject, format: PayloadFormat, what: string, pointer: string): Promise<Rendered> => {
    const r = await renderer.render(subject, format);
    if (!r.success) return { diagnostics: [renderDiagnostic(what, format, r.error, pointer)] };
    const diagnostics: Diagnostic[] = [];
    for (const w of r.data.warnings) diagnostics.push(diagnostic("warning", "TYPESPEC_DUPLICATE_DECLARATION", `${what}: ${w}`, pointer));
    for (const n of r.data.notes ?? []) diagnostics.push(diagnostic("warning", n.code, `${what}: ${n.message}`, pointer));
    return { artifact: r.data.artifact, diagnostics };
  };
  const rendered = (list: Rendered[]): SchemaArtifact[] => list.flatMap((r) => (r.artifact ? [r.artifact] : []));

  const plan = planDocumentArtifacts(doc, snapshot.entityFormats, { emitAll: true });
  const artifacts = new Map<string, MessageArtifacts>();
  const messageJobs = doc.messages.map(async (m, i): Promise<Diagnostic[]> => {
    const need = plan.get(m.key);
    if (!need) return [];
    const at = `/messages/${i}`;
    const { keyPin, headers: headersPin } = m;
    const [payloads, keys, headers] = await Promise.all([
      Promise.all(need.payloadFormats.map((f) => render(pinSubject(m.payload), f, `Message ${m.key} payload`, `${at}/payload`))),
      keyPin ? Promise.all(need.keyFormats.map((f) => render(pinSubject(keyPin), f, `Message ${m.key} key`, `${at}/keyPin`))) : Promise.resolve([]),
      headersPin ? render(pinSubject(headersPin), "json-schema", `Message ${m.key} headers`, `${at}/headers`) : Promise.resolve(undefined),
    ]);
    // a message whose payload failed in ANY format is skipped; the resolver reports it as having no rendered payload
    if (payloads.every((p) => p.artifact) && !artifacts.has(m.key)) {
      artifacts.set(m.key, { payloads: rendered(payloads), keys: rendered(keys), ...(headers?.artifact && { headers: headers.artifact }) });
    }
    return [
      ...(m.payload.entityVersionId === null ? [unpublishedPin(`Message ${m.key} payload`, `${at}/payload`)] : []),
      ...(keyPin && keyPin.entityVersionId === null && need.keyFormats.length > 0 ? [unpublishedPin(`Message ${m.key} key`, `${at}/keyPin`)] : []),
      ...(headersPin && headersPin.entityVersionId === null ? [unpublishedPin(`Message ${m.key} headers`, `${at}/headers`)] : []),
      ...payloads.flatMap((p) => p.diagnostics),
      ...keys.flatMap((k) => k.diagnostics),
      ...(headers?.diagnostics ?? []),
    ];
  });

  const localTraitHeaders = new Map<string, SchemaArtifact>();
  const libraryTraitHeaders = new Map<string, SchemaArtifact>();
  type HeaderJob = { what: string; pointer: string; subject: ArtifactSubject; unpinned: boolean; store: (artifact: SchemaArtifact) => void };
  const headerJobs: HeaderJob[] = [];
  const seenLibraryTraits = new Set<string>();
  doc.traits.forEach((t, i) => {
    const what = `Trait ${t.key} headers`;
    if (!isLibraryTrait(t)) {
      const { key, headers } = t;
      if (headers) {
        headerJobs.push({ what, pointer: `/traits/${i}/headers`, subject: pinSubject(headers), unpinned: headers.entityVersionId === null, store: (a) => { if (!localTraitHeaders.has(key)) localTraitHeaders.set(key, a); } });
      }
      return;
    }
    const { libraryTraitId } = t;
    if (seenLibraryTraits.has(libraryTraitId)) return;
    seenLibraryTraits.add(libraryTraitId);
    const frozen = snapshot.libraryTraits.get(libraryTraitId);
    const subject = frozen ? traitHeadersSubject(frozen) : null;
    if (subject) headerJobs.push({ what, pointer: `/traits/${i}`, subject, unpinned: false, store: (a) => { libraryTraitHeaders.set(libraryTraitId, a); } });
  });
  const traitJobs = headerJobs.map(async (job): Promise<Diagnostic[]> => {
    const r = await render(job.subject, "json-schema", job.what, job.pointer);
    if (r.artifact) job.store(r.artifact);
    return [...(job.unpinned ? [unpublishedPin(job.what, job.pointer)] : []), ...r.diagnostics];
  });

  const [messageDiagnostics, traitDiagnostics] = await Promise.all([Promise.all(messageJobs), Promise.all(traitJobs)]);
  const diagnostics = [...messageDiagnostics.flat(), ...traitDiagnostics.flat()];

  const resolved = resolveDocument({
    doc, productSlug: snapshot.event.productSlug, version,
    artifacts, localTraitHeaders, libraryTraits: snapshot.libraryTraits, libraryTraitHeaders, external: snapshot.external,
    // The emission shows everything the user defined, not only what an operation reaches; Auto follows the entities' recorded formats.
    entityFormats: snapshot.entityFormats, emitAll: true, emitChannelServers: true,
  });
  if (!resolved.success) return { resolved: null, diagnostics: [...diagnostics, ...problemDiagnostics(resolved.error)] };
  return { resolved: resolved.data, diagnostics };
}

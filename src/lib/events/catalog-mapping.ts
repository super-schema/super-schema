import type {
  EventSpecDocument, JsonSchemaDialect, PayloadFormat, ResolvedChannel, ResolvedMessage, ResolvedTrait, SchemaArtifact, TraitKind,
} from "@/lib/event-specs/types";
import type { ArtifactSubject } from "@/services/events/artifact-renderer";
import { readChannelSpec, readMessageSpec } from "./catalog-specs";
import { isJsonObject } from "./inputs";
import type { FrozenTrait, MessageResolvedSpec, MessageSpec } from "./types";

function compact<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

export interface ChannelRow {
  id: string;
  name: string;
  address: string | null;
  protocol: string;
  format: string;
  formatDialect: string | null;
  spec: unknown;
  product: { slug: string } | null;
}

export function toResolvedChannel(row: ChannelRow): ResolvedChannel {
  const spec = readChannelSpec(row.spec);
  return compact<ResolvedChannel>({
    id: row.id,
    name: row.name,
    productSlug: row.product?.slug ?? "",
    address: row.address,
    protocol: row.protocol,
    profile:
      row.format === "json-schema"
        ? { format: "json-schema", dialect: (row.formatDialect as JsonSchemaDialect | null) ?? "draft-07" }
        : { format: row.format as PayloadFormat },
    title: spec.title,
    summary: spec.summary,
    description: spec.description,
    parameters: spec.parameters,
    bindings: spec.bindings,
    tags: spec.tags,
    externalDocs: spec.externalDocs,
  });
}

export interface MessageSource {
  /** MessageVersion id, or the Message id for a draft preview (D4). */
  id: string;
  messageId: string;
  name: string;
  productSlug: string;
  spec: MessageSpec;
  payload: ArtifactSubject;
  headers: ArtifactSubject | null;
  key: ArtifactSubject | null;
  unpublished: boolean;
}

export interface MessageVersionRow {
  id: string;
  messageId: string;
  major: number;
  minor: number;
  resolvedSpec: unknown;
  message: { name: string; product: { slug: string } | null };
}

export function messageSourceFromVersion(row: MessageVersionRow): MessageSource | null {
  if (!isJsonObject(row.resolvedSpec) || !isJsonObject(row.resolvedSpec.payload)) return null;
  const resolved = row.resolvedSpec as unknown as MessageResolvedSpec;
  const subject = (pin: MessageResolvedSpec["headers"]): ArtifactSubject | null =>
    pin ? { kind: "version", entityVersionId: pin.entityVersionId } : null;
  return {
    id: row.id,
    messageId: row.messageId,
    name: typeof resolved.name === "string" ? resolved.name : row.message.name,
    productSlug: row.message.product?.slug ?? "",
    spec: readMessageSpec(resolved.spec),
    payload: { kind: "version", entityVersionId: resolved.payload.entityVersionId },
    headers: subject(resolved.headers),
    key: subject(resolved.key),
    unpublished: false,
  };
}

export interface MessageDraftRow {
  id: string;
  name: string;
  spec: unknown;
  payloadEntityId: string;
  payloadEntityVersionId: string | null;
  headersEntityId: string | null;
  headersEntityVersionId: string | null;
  keyEntityId: string | null;
  keyEntityVersionId: string | null;
  product: { slug: string } | null;
}

const draftSubject = (entityId: string | null, versionId: string | null): ArtifactSubject | null =>
  entityId ? (versionId ? { kind: "version", entityVersionId: versionId } : { kind: "draft", entityId }) : null;

export function messageSourceFromDraft(row: MessageDraftRow): MessageSource {
  return {
    id: row.id,
    messageId: row.id,
    name: row.name,
    productSlug: row.product?.slug ?? "",
    spec: readMessageSpec(row.spec),
    payload: draftSubject(row.payloadEntityId, row.payloadEntityVersionId) as ArtifactSubject,
    headers: draftSubject(row.headersEntityId, row.headersEntityVersionId),
    key: draftSubject(row.keyEntityId, row.keyEntityVersionId),
    unpublished: true,
  };
}

export interface TraitRow {
  id: string;
  name: string;
  kind: TraitKind;
  spec: unknown;
  headersEntityId: string | null;
  headersEntityVersionId: string | null;
  tenant: { slug: string };
  domain: { slug: string } | null;
  product: { slug: string } | null;
}

export function toFrozenTrait(row: TraitRow): FrozenTrait {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    ownerSlug: row.product?.slug ?? row.domain?.slug ?? row.tenant.slug,
    spec: isJsonObject(row.spec) ? row.spec : {},
    headersEntityId: row.headersEntityId,
    headersEntityVersionId: row.headersEntityVersionId,
  };
}

export function traitHeadersSubject(t: FrozenTrait): ArtifactSubject | null {
  return draftSubject(t.headersEntityId, t.headersEntityVersionId);
}

export function toResolvedTrait(t: FrozenTrait, headers?: SchemaArtifact): ResolvedTrait {
  const resolved: ResolvedTrait = { id: t.id, name: t.name, kind: t.kind, ownerSlug: t.ownerSlug, spec: t.spec };
  if (headers) resolved.headers = headers;
  return resolved;
}

export function toResolvedMessage(
  source: MessageSource,
  artifacts: { payloads: SchemaArtifact[]; headers?: SchemaArtifact; keys: SchemaArtifact[] }
): ResolvedMessage {
  const s = source.spec;
  return compact<ResolvedMessage>({
    id: source.id,
    name: source.name,
    productSlug: source.productSlug,
    title: s.title,
    summary: s.summary,
    description: s.description,
    contentType: s.contentType,
    correlationId: s.correlationId,
    tags: s.tags,
    externalDocs: s.externalDocs,
    bindings: s.bindings,
    examples: s.examples,
    traitRefs: [...s.traitIds],
    payloads: artifacts.payloads,
    headers: artifacts.headers,
    keys: artifacts.keys.length > 0 ? artifacts.keys : undefined,
    unpublished: source.unpublished || undefined,
  });
}

/** Spec §7.2 step 3: payload formats = the channels' formats; Kafka keys = Avro on Avro channels, else JSON Schema. */
export function planArtifacts(
  doc: EventSpecDocument,
  channels: Map<string, ResolvedChannel>
): Map<string, { payloadFormats: PayloadFormat[]; keyFormats: PayloadFormat[] }> {
  const needs = new Map<string, { payload: Set<PayloadFormat>; key: Set<PayloadFormat> }>();
  const add = (channelId: string | undefined, messageIds: string[] | undefined) => {
    const channel = channelId ? channels.get(channelId) : undefined;
    if (!channel || !messageIds) return;
    for (const id of messageIds) {
      const entry = needs.get(id) ?? { payload: new Set<PayloadFormat>(), key: new Set<PayloadFormat>() };
      entry.payload.add(channel.profile.format);
      if (channel.protocol === "kafka") entry.key.add(channel.profile.format === "avro" ? "avro" : "json-schema");
      needs.set(id, entry);
    }
  };
  for (const op of doc.operations) {
    add(op.channelId, op.messageVersionIds);
    add(op.reply?.channelId, op.reply?.messageVersionIds); // reply messages need a reply channel (assembler rule)
  }
  return new Map([...needs].map(([id, e]) => [id, { payloadFormats: [...e.payload].sort(), keyFormats: [...e.key].sort() }]));
}

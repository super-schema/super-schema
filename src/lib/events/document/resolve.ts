// src/lib/events/document/resolve.ts
// Event document v2 → ResolvedEventSpec (spec 2026-10-15-events-self-contained-design §4–§5). Pure — client-safe.
// Same output type and error shape as the v1 resolver (`src/lib/event-specs/resolve.ts`); the difference is that every
// reference here is a local key, so ids in the resolved spec ARE the document keys.
import { err, ok, type Result } from "@/types/result";
import type {
  EventSpecLocalComponents, EventSpecServer, FormatProfile, PayloadFormat, ResolvedChannel, ResolvedEventSpec, ResolvedMessage, ResolvedOperation,
  ResolvedTrait, SchemaArtifact, TraitKind,
} from "@/lib/event-specs/types";
import { sameProfile } from "@/lib/event-specs/schema-format";
import { toResolvedTrait } from "@/lib/events/catalog-mapping";
import type { FrozenTrait } from "@/lib/events/types";
import { createRepresentations, type EntityFormats, type RepresentationEngine } from "./representation";
import {
  isLibraryTrait, type DocChannel, type DocMessage, type DocServer, type DocumentProblem, type EventDocument,
} from "./types";

export interface MessageArtifacts { payloads: SchemaArtifact[]; headers?: SchemaArtifact; keys: SchemaArtifact[] }
export interface ExternalItems { channel?: ResolvedChannel; message?: ResolvedMessage; traits?: ResolvedTrait[] }
export interface ResolveDocumentInput {
  doc: EventDocument;
  productSlug: string;
  version: string;                                   // "MAJOR.MINOR" or a provisional label
  artifacts: ReadonlyMap<string, MessageArtifacts>;  // by local message key
  localTraitHeaders: ReadonlyMap<string, SchemaArtifact>; // by local trait key
  libraryTraits: ReadonlyMap<string, FrozenTrait>;   // by libraryTraitId
  libraryTraitHeaders: ReadonlyMap<string, SchemaArtifact>; // by libraryTraitId
  external: ReadonlyMap<string, ExternalItems>;      // by externalRef key
  /**
   * Carry each local channel's `serverKeys` into `ResolvedChannel.serverRefs`, so the assembler emits AsyncAPI's `channels.<c>.servers`.
   * Off by default: until now `serverKeys` never reached the emitted document, and switching it on changes the emitted bytes of every
   * existing document that lists servers on a channel — a decision for the caller, not for the resolver.
   */
  emitChannelServers?: boolean;
  /**
   * The recorded source format of each payload entity (by entity id): what "Auto" follows for a message that does not choose a
   * representation (see `resolveRepresentations`). Absent / empty = no entity records one; the protocol default decides.
   */
  entityFormats?: EntityFormats;
  /**
   * Carry EVERY local channel, message and trait — not only what operations reach — and mark the spec `emitAll`, so the assembler
   * emits channels without an operation, the messages each channel allows, messages no channel carries, and unused traits. Off by
   * default: published versions emit what operations use. A message that is not reached then needs a rendered payload too
   * (`planDocumentArtifacts(doc, entityFormats, { emitAll: true })` plans for it).
   */
  emitAll?: boolean;
}

type FormatPlan = { payloadFormats: PayloadFormat[]; keyFormats: PayloadFormat[] };
type Indexed<T> = { item: T; index: number };

const compact = <T extends object>(value: T): T => Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
/** Resolved specs are stored and mutated downstream: never share nested objects with the draft document. */
const clone = <T>(value: T): T => structuredClone(value);

/** First item wins per key (the parser rejects duplicates); keeps the original array index for problem pointers. */
function indexByKey<T extends { key: string }>(items: readonly T[], accept: (item: T) => boolean = () => true): Map<string, Indexed<T>> {
  const out = new Map<string, Indexed<T>>();
  items.forEach((item, index) => { if (accept(item) && !out.has(item.key)) out.set(item.key, { item, index }); });
  return out;
}

const NO_FORMATS: EntityFormats = new Map();

/**
 * Which payload / Kafka-key formats each local message must be rendered in: for every local channel that lists it, or that an
 * operation or reply puts it on, the message's EFFECTIVE representation on that channel (`representation.ts`: the message's own,
 * else the channel's explicit format, else the entity's recorded format, else the protocol default). External channels are skipped —
 * they bring their own rendered messages.
 * A Kafka key is emitted on Kafka channels only, as Avro on an Avro payload and as JSON Schema otherwise (the assembler's `kafkaKeyProfile`).
 * `emitAll` also plans a message that no channel or operation carries, in its own effective format (and with no key).
 */
export function planDocumentArtifacts(doc: EventDocument, entityFormats: EntityFormats = NO_FORMATS, options: { emitAll?: boolean } = {}): Map<string, FormatPlan> {
  const engine = createRepresentations(doc, entityFormats);
  const channelByKey = indexByKey(doc.channels);
  const plan = new Map<string, { payloadFormats: Set<PayloadFormat>; keyFormats: Set<PayloadFormat> }>();
  const add = (channelKey: string | undefined, messageKeys: readonly string[] | undefined) => {
    const channel = channelKey === undefined ? undefined : channelByKey.get(channelKey)?.item;
    if (!channel) return;
    for (const key of messageKeys ?? []) {
      const { format } = engine.profileOn(key, channel.key) as FormatProfile;
      const entry = plan.get(key) ?? { payloadFormats: new Set<PayloadFormat>(), keyFormats: new Set<PayloadFormat>() };
      entry.payloadFormats.add(format);
      if (channel.protocol === "kafka") entry.keyFormats.add(format === "avro" ? "avro" : "json-schema");
      plan.set(key, entry);
    }
  };
  for (const c of doc.channels) add(c.key, c.messageKeys);
  for (const o of doc.operations) { add(o.channelKey, o.messageKeys); add(o.reply?.channelKey, o.reply?.messageKeys); }
  if (options.emitAll) {
    for (const m of doc.messages) {
      const effective = engine.headline(m.key);
      if (plan.has(m.key) || !effective) continue;
      plan.set(m.key, { payloadFormats: new Set([effective.format]), keyFormats: new Set() });
    }
  }
  return new Map([...plan].map(([key, v]) => [key, { payloadFormats: [...v.payloadFormats].sort(), keyFormats: [...v.keyFormats].sort() }]));
}

const toResolvedServer = (s: DocServer): EventSpecServer =>
  compact<EventSpecServer>({
    key: s.key, protocol: s.protocol, host: s.host, pathname: s.pathname, protocolVersion: s.protocolVersion, description: s.description, externalRef: s.externalRef,
    title: s.title, summary: s.summary, variables: clone(s.variables), security: clone(s.security), tags: clone(s.tags), externalDocs: clone(s.externalDocs), bindings: clone(s.bindings),
  });

/**
 * The profile a message carries on the resolved spec: its own representation, or what Auto gave it (entity format, protocol default).
 * Unset when a channel with an explicit format decides — the way every document has always been emitted.
 */
function messageProfile(engine: RepresentationEngine, key: string): FormatProfile | undefined {
  const effective = engine.headline(key);
  if (!effective || effective.source === "channel") return undefined;
  return effective.dialect ? { format: effective.format, dialect: effective.dialect } : { format: effective.format };
}

/**
 * A local channel. Its `profile` is its explicit format, or — with no explicit format — that of its messages' majority (the first
 * message listed wins a tie; no messages = the protocol default), which is what places Kafka keys and names variants for a message
 * that has no profile of its own. `messageProfiles` lists only the messages whose effective profile on THIS channel differs from
 * what the assembler would otherwise pick for them (`message.profile ?? channel.profile`).
 */
function toLocalChannel(c: DocChannel, productSlug: string, engine: RepresentationEngine, emitServers: boolean, emitAll: boolean): ResolvedChannel {
  const profile = engine.channelProfile(c.key) as FormatProfile;
  const differing: Array<[string, FormatProfile]> = [];
  for (const messageKey of engine.messagesOn(c.key)) {
    const actual = engine.profileOn(messageKey, c.key) as FormatProfile;
    if (!sameProfile(actual, messageProfile(engine, messageKey) ?? profile)) differing.push([messageKey, actual]);
  }
  return compact<ResolvedChannel>({
    id: c.key, name: c.key, productSlug, address: c.address, protocol: c.protocol, profile,
    title: c.title, summary: c.summary, description: c.description,
    parameters: clone(c.parameters), bindings: clone(c.bindings), tags: clone(c.tags), externalDocs: clone(c.externalDocs),
    serverRefs: emitServers && c.serverKeys.length > 0 ? [...c.serverKeys] : undefined,
    messageRefs: emitAll && c.messageKeys.length > 0 ? [...c.messageKeys] : undefined,
    messageProfiles: differing.length > 0 ? Object.fromEntries(differing) : undefined,
  });
}

const toLocalMessage = (m: DocMessage, productSlug: string, artifacts: MessageArtifacts, profile: FormatProfile | undefined): ResolvedMessage => compact<ResolvedMessage>({
  id: m.key, name: m.key, productSlug, messageName: m.name,
  title: m.title, summary: m.summary, description: m.description, contentType: m.contentType,
  correlationId: clone(m.correlationId), tags: clone(m.tags), externalDocs: clone(m.externalDocs), deprecated: m.deprecated, bindings: clone(m.bindings), examples: clone(m.examples),
  traitRefs: [...m.traitKeys],
  payloads: [...artifacts.payloads], headers: artifacts.headers,
  keys: artifacts.keys.length > 0 ? [...artifacts.keys] : undefined,
  profile,
});

type ExternalResolved = { channel?: ResolvedChannel; message?: ResolvedMessage; traits: ResolvedTrait[] };

/**
 * Document → `ResolvedEventSpec`. Like the v1 resolver, only what operations use is carried over (channels, messages,
 * and the traits of used messages and operations, in first-reference order) and every unresolved reference is reported
 * together as one `UNRESOLVED_REFERENCES` error with a pointer into the document.
 *
 * Checked regardless of use: every library trait and every external ref must resolve. Checked when used: a local message
 * needs a rendered payload; operation / reply channel, message and trait keys must resolve (the parser does not subset-check
 * messages against an external channel, so this does not assume a message exists on its channel).
 */
export function resolveDocument(input: ResolveDocumentInput): Result<ResolvedEventSpec> {
  const { doc, productSlug, version } = input;
  const engine = createRepresentations(doc, input.entityFormats ?? NO_FORMATS);
  const emitAll = input.emitAll === true;
  const problems: DocumentProblem[] = [];
  const problem = (pointer: string, message: string) => { problems.push({ pointer, message }); };

  const localChannels = indexByKey(doc.channels);
  const localMessages = indexByKey(doc.messages);
  const localTraits = indexByKey(doc.traits);
  const externalChannelRefs = indexByKey(doc.externalRefs, (r) => r.kind === "channel");
  const externalMessageRefs = indexByKey(doc.externalRefs, (r) => r.kind === "message");

  // ── library + local traits: resolved once each; a trait that failed is absent here and already reported ──
  const resolvedTraits = new Map<string, ResolvedTrait>();
  doc.traits.forEach((t, i) => {
    if (resolvedTraits.has(t.key)) return;
    if (!isLibraryTrait(t)) {
      const headers = input.localTraitHeaders.get(t.key);
      resolvedTraits.set(t.key, compact<ResolvedTrait>({ id: t.key, name: t.key, kind: t.kind, ownerSlug: productSlug, spec: clone(t.spec), headers: clone(headers) }));
      return;
    }
    const pointer = `/traits/${i}/libraryTraitId`;
    const frozen = input.libraryTraits.get(t.libraryTraitId);
    if (!frozen) { problem(pointer, `Library trait "${t.libraryTraitId}" was not found`); return; }
    if (frozen.kind !== t.kind) {
      problem(pointer, `Library trait "${t.libraryTraitId}" is a ${frozen.kind} trait, but "${t.key}" is declared as a ${t.kind} trait`);
      return;
    }
    resolvedTraits.set(t.key, { ...clone(toResolvedTrait(frozen, input.libraryTraitHeaders.get(t.libraryTraitId))), id: t.key });
  });

  // ── external refs: substituted under the ref key; an external message brings its own traits, id-scoped to its event version ──
  const external = new Map<string, ExternalResolved>();
  doc.externalRefs.forEach((ref, i) => {
    if (external.has(ref.key)) return;
    const pointer = `/externalRefs/${i}`;
    const items = input.external.get(ref.key);
    if (ref.kind === "channel") {
      if (!items?.channel) { problem(pointer, `External channel "${ref.itemKey}" (reference "${ref.key}") was not found in event version ${ref.eventVersionId}`); return; }
      external.set(ref.key, { channel: { ...clone(items.channel), id: ref.key }, traits: [] });
      return;
    }
    if (!items?.message) { problem(pointer, `External message "${ref.itemKey}" (reference "${ref.key}") was not found in event version ${ref.eventVersionId}`); return; }
    // The upstream document's trait keys are not ours: scope them so "CloudEvents" upstream never captures a local "CloudEvents".
    const scoped = (id: string) => `${ref.eventVersionId}:${id}`;
    const supplied = new Map((items.traits ?? []).map((t) => [t.id, t]));
    const traits: ResolvedTrait[] = [];
    const traitRefs: string[] = [];
    for (const id of items.message.traitRefs ?? []) {
      const trait = supplied.get(id);
      if (!trait || trait.kind !== "MESSAGE") {
        problem(pointer, `External message "${ref.itemKey}" (reference "${ref.key}") uses trait "${id}", which event version ${ref.eventVersionId} did not supply`);
        continue;
      }
      traits.push({ ...clone(trait), id: scoped(id) });
      traitRefs.push(scoped(id));
    }
    external.set(ref.key, { message: { ...clone(items.message), id: ref.key, traitRefs }, traits });
  });

  // ── walk the operations: take what they use, in first-reference order ──
  const channels = new Map<string, ResolvedChannel>();
  const messages = new Map<string, ResolvedMessage>();
  const traits = new Map<string, ResolvedTrait>();
  const visitedMessages = new Set<string>();

  const takeTrait = (key: string, kind: TraitKind, pointer: string) => {
    const declared = localTraits.get(key);
    if (!declared) { problem(pointer, `Unknown trait "${key}"`); return; }
    if (declared.item.kind !== kind) { problem(pointer, `Trait "${key}" is a ${declared.item.kind} trait, expected a ${kind} trait`); return; }
    const trait = resolvedTraits.get(key);
    if (trait && !traits.has(trait.id)) traits.set(trait.id, trait);
  };
  const takeChannel = (key: string, pointer: string) => {
    if (channels.has(key)) return;
    const local = localChannels.get(key);
    if (local) { channels.set(key, toLocalChannel(local.item, productSlug, engine, input.emitChannelServers === true, emitAll)); return; }
    if (!externalChannelRefs.has(key)) { problem(pointer, `Unknown channel "${key}"`); return; }
    const channel = external.get(key)?.channel; // absent = the ref itself is unresolved, already reported
    if (channel) channels.set(key, channel);
  };
  const takeMessage = (key: string, pointer: string) => {
    const local = localMessages.get(key);
    if (local) {
      if (visitedMessages.has(key)) return;
      visitedMessages.add(key);
      const at = `/messages/${local.index}`;
      const artifacts = input.artifacts.get(key);
      if (!artifacts || artifacts.payloads.length === 0) problem(at, `Message "${key}" has no rendered payload`);
      else messages.set(key, toLocalMessage(local.item, productSlug, artifacts, messageProfile(engine, key)));
      local.item.traitKeys.forEach((traitKey, j) => takeTrait(traitKey, "MESSAGE", `${at}/traitKeys/${j}`));
      return;
    }
    if (!externalMessageRefs.has(key)) { problem(pointer, `Unknown message "${key}"`); return; }
    const resolved = external.get(key);
    if (!resolved?.message || messages.has(key)) return;
    messages.set(key, resolved.message);
    for (const trait of resolved.traits) if (!traits.has(trait.id)) traits.set(trait.id, trait);
  };

  const operations = doc.operations.map((op, i): ResolvedOperation => {
    const p = `/operations/${i}`;
    takeChannel(op.channelKey, `${p}/channelKey`);
    op.messageKeys.forEach((k, j) => takeMessage(k, `${p}/messageKeys/${j}`));
    op.traitKeys.forEach((k, j) => takeTrait(k, "OPERATION", `${p}/traitKeys/${j}`));
    if (op.reply?.channelKey !== undefined) takeChannel(op.reply.channelKey, `${p}/reply/channelKey`);
    op.reply?.messageKeys?.forEach((k, j) => takeMessage(k, `${p}/reply/messageKeys/${j}`));

    const resolved: ResolvedOperation = { key: op.key, action: op.action, channelRef: op.channelKey, messageRefs: [...op.messageKeys], traitRefs: [...op.traitKeys] };
    if (op.title !== undefined) resolved.title = op.title;
    if (op.summary !== undefined) resolved.summary = op.summary;
    if (op.description !== undefined) resolved.description = op.description;
    if (op.security !== undefined) resolved.security = [...op.security];
    if (op.tags !== undefined) resolved.tags = clone(op.tags);
    if (op.externalDocs !== undefined) resolved.externalDocs = clone(op.externalDocs);
    if (op.bindings !== undefined) resolved.bindings = clone(op.bindings);
    if (op.reply) {
      resolved.reply = {};
      if (op.reply.address !== undefined) resolved.reply.address = clone(op.reply.address);
      if (op.reply.channelKey !== undefined) resolved.reply.channelRef = op.reply.channelKey;
      if (op.reply.messageKeys !== undefined) resolved.reply.messageRefs = [...op.reply.messageKeys];
    }
    return resolved;
  });

  if (emitAll) {
    // Everything else the user defined, after what operations reach: every channel and the messages it allows, every message
    // (also those no channel carries), every trait.
    doc.channels.forEach((c, i) => {
      takeChannel(c.key, `/channels/${i}`);
      c.messageKeys.forEach((k, j) => takeMessage(k, `/channels/${i}/messageKeys/${j}`));
    });
    doc.messages.forEach((m, i) => takeMessage(m.key, `/messages/${i}`));
    for (const trait of resolvedTraits.values()) if (!traits.has(trait.id)) traits.set(trait.id, trait);
  }

  if (problems.length > 0) {
    return err({
      code: "UNRESOLVED_REFERENCES",
      message: `${problems.length} reference(s) in the event document could not be resolved`,
      details: { problems },
    });
  }

  const spec: ResolvedEventSpec = {
    productSlug,
    info: { ...clone(doc.info), version },
    servers: doc.servers.map(toResolvedServer),
    operations,
    channels: [...channels.values()],
    messages: [...messages.values()],
    traits: [...traits.values()],
    // `DocSecurityScheme` carries type-specific extras as `unknown`; they are JSON (the parser read them from JSON).
    components: clone(doc.components ?? {}) as EventSpecLocalComponents,
  };
  if (doc.defaultContentType !== undefined) spec.defaultContentType = doc.defaultContentType;
  if (emitAll) spec.emitAll = true;
  return ok(spec);
}

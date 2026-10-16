// src/lib/events/document/representation.ts
// Which schema representation (Avro / JSON Schema / Protobuf) every message of an event document is emitted in (spec R4).
// Pure — client-safe: the builder shows `reason` verbatim, the server renders the artifacts these answers ask for.
//
// A message's representation, in order:
//   1. `message.representation`                              the user picked one on the message          → source "message"
//   2. the explicit `format` of a channel carrying it        the channel overrides Auto                  → source "channel"
//   3. the payload entity's recorded source format           an Avro-imported entity stays Avro          → source "entity"
//   4. the protocol default of the first channel carrying it Kafka → Avro, everything else → JSON Schema → source "protocol"
//   5. JSON Schema (draft-07)                                nothing else is known                       → source "default"
// A channel "carries" a message when it lists it in `messageKeys` or an operation / reply puts the message on it. Only local
// channels count: an external channel brings its own rendered messages.
import { DEFAULT_JSON_SCHEMA_DIALECT, formatSuffix, normalizeProfile } from "@/lib/event-specs/schema-format";
import type { FormatProfile, JsonSchemaDialect, PayloadFormat } from "@/lib/event-specs/types";
import type { DocChannel, DocMessage, EventDocument } from "./types";

export type RepresentationSource = "message" | "channel" | "entity" | "protocol" | "default";

/** What one message resolves to. `reason` is a short human sentence the UI shows verbatim. `dialect` is set for JSON Schema only. */
export interface EffectiveRepresentation {
  format: PayloadFormat;
  dialect?: JsonSchemaDialect;
  source: RepresentationSource;
  reason: string;
}

/** The recorded source format of each entity (by entity id). An entity that is absent, or maps to `undefined`, has none. */
export type EntityFormats = ReadonlyMap<string, PayloadFormat | undefined>;

export interface RepresentationOptions {
  /** entityId → entity name ("Order"), for the reason of an entity-derived representation. */
  entityLabels?: ReadonlyMap<string, string>;
}

const FORMAT_LABELS: Record<PayloadFormat, string> = { avro: "Avro", "json-schema": "JSON Schema", protobuf: "Protobuf" };
const PROTOCOL_LABELS: Record<string, string> = {
  kafka: "Kafka", googlepubsub: "Google Pub/Sub", amqp: "AMQP", amqp1: "AMQP 1.0", mqtt: "MQTT", mqtt5: "MQTT 5", nats: "NATS",
  pulsar: "Pulsar", http: "HTTP", ws: "WebSocket", sns: "Amazon SNS", sqs: "Amazon SQS", redis: "Redis",
};

/** The import `sourceFormat` strings that are also schema representations an event can emit. Everything else says nothing. */
const SOURCE_FORMATS: Record<string, PayloadFormat> = { avro: "avro", protobuf: "protobuf", "json-schema": "json-schema" };

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
const toSourceFormat = (value: unknown): PayloadFormat | undefined =>
  typeof value === "string" && Object.hasOwn(SOURCE_FORMATS, value.trim().toLowerCase()) ? SOURCE_FORMATS[value.trim().toLowerCase()] : undefined;

/**
 * The representation an entity was imported in, from its `metadata`: `sourceFormat` ("avro" | "protobuf" | "json-schema" map to
 * themselves; typespec, openapi, bigquery-ddl and anything else say nothing). The drift record `importedFrom.format` is read as a
 * fallback, since it records the same fact. Never throws.
 */
export function entitySourceFormat(metadata: unknown): PayloadFormat | undefined {
  const record = asRecord(metadata);
  if (!record) return undefined;
  return toSourceFormat(record.sourceFormat) ?? toSourceFormat(asRecord(record.importedFrom)?.format);
}

/** "Avro", "JSON Schema (draft-07)", "Protobuf". JSON Schema is named without a dialect when none is known. */
export function describeRepresentation(effective: { format: PayloadFormat; dialect?: JsonSchemaDialect }): string {
  if (effective.format !== "json-schema") return FORMAT_LABELS[effective.format];
  return effective.dialect ? `${FORMAT_LABELS["json-schema"]} (${effective.dialect})` : FORMAT_LABELS["json-schema"];
}

/** Kafka → Avro (the schema registry norm); every other protocol → JSON Schema. Protocol ids are the lowercase AsyncAPI ones, as everywhere else. */
export function protocolDefaultFormat(protocol: string): PayloadFormat {
  return protocol === "kafka" ? "avro" : "json-schema";
}

const protocolLabel = (protocol: string): string => PROTOCOL_LABELS[protocol.toLowerCase()] ?? protocol;

/** The profile of `format` on `channel`: JSON Schema takes the channel's dialect (draft-07 by default), other formats have none. */
const profileOfFormat = (format: PayloadFormat, channel: DocChannel | undefined): FormatProfile =>
  format === "json-schema" ? { format, dialect: channel?.formatDialect ?? DEFAULT_JSON_SCHEMA_DIALECT } : { format };

/**
 * The profile of a channel with an explicit format — exactly what the assembler has always used for it: the dialect only when the
 * channel names one (the assembler applies draft-07 itself), so existing documents emit unchanged.
 */
const explicitProfile = (format: PayloadFormat, channel: DocChannel): FormatProfile =>
  channel.formatDialect !== undefined ? { format, dialect: channel.formatDialect } : { format };

function firstByKey<T extends { key: string }>(items: readonly T[]): Map<string, T> {
  const out = new Map<string, T>();
  for (const item of items) if (!out.has(item.key)) out.set(item.key, item);
  return out;
}

export interface RepresentationEngine {
  /** The message's effective representation (one answer per message), or undefined for a key that is not a local message. */
  headline(messageKey: string): EffectiveRepresentation | undefined;
  /**
   * The profile `messageKey` is rendered as on the local channel `channelKey`, or undefined when that channel is not in the document.
   * A message that is not local (an external reference) follows the channel: its explicit format, else its protocol default.
   */
  profileOn(messageKey: string, channelKey: string): FormatProfile | undefined;
  /**
   * The profile of a local channel: its explicit format when it has one; otherwise that of the MAJORITY of its (local) messages,
   * a tie going to the message listed first; a channel without messages gets its protocol default.
   */
  channelProfile(channelKey: string): FormatProfile | undefined;
  /** Keys of the local channels that carry the message, in document order (channels listing it first, then operation / reply channels). */
  carriers(messageKey: string): readonly string[];
  /** Keys of the local messages the channel carries, in listing order (then those only an operation puts on it). */
  messagesOn(channelKey: string): readonly string[];
}

/** The resolver behind `resolveRepresentations`, also used per (message, channel) by the artifact plan and the document resolver. */
export function createRepresentations(doc: EventDocument, entityFormats: EntityFormats, options: RepresentationOptions = {}): RepresentationEngine {
  const channelByKey = firstByKey(doc.channels);
  const messageByKey = firstByKey(doc.messages);

  const carriersOf = new Map<string, string[]>();
  const messagesOf = new Map<string, string[]>();
  const link = (channelKey: string | undefined, messageKeys: readonly string[] | undefined) => {
    const channel = channelKey === undefined ? undefined : channelByKey.get(channelKey);
    if (!channel) return;
    for (const messageKey of messageKeys ?? []) {
      const carriers = carriersOf.get(messageKey) ?? [];
      if (!carriers.includes(channel.key)) carriers.push(channel.key);
      carriersOf.set(messageKey, carriers);
      if (!messageByKey.has(messageKey)) continue;
      const messages = messagesOf.get(channel.key) ?? [];
      if (!messages.includes(messageKey)) messages.push(messageKey);
      messagesOf.set(channel.key, messages);
    }
  };
  for (const channel of channelByKey.values()) link(channel.key, channel.messageKeys);
  for (const o of doc.operations) { link(o.channelKey, o.messageKeys); link(o.reply?.channelKey, o.reply?.messageKeys); }

  const carriers = (messageKey: string): readonly string[] => carriersOf.get(messageKey) ?? [];
  const messagesOn = (channelKey: string): readonly string[] => messagesOf.get(channelKey) ?? [];
  const carrierChannels = (messageKey: string): DocChannel[] => carriers(messageKey).map((key) => channelByKey.get(key) as DocChannel);

  const profileOn = (messageKey: string, channelKey: string): FormatProfile | undefined => {
    const channel = channelByKey.get(channelKey);
    if (!channel) return undefined;
    const message: DocMessage | undefined = messageByKey.get(messageKey);
    if (message?.representation) return profileOfFormat(message.representation, channel);
    if (channel.format !== undefined) return explicitProfile(channel.format, channel);
    if (!message) return profileOfFormat(protocolDefaultFormat(channel.protocol), channel);
    const fromEntity = entityFormats.get(message.payload.entityId);
    if (fromEntity) return profileOfFormat(fromEntity, channel);
    // Auto: the protocol of the first channel WITHOUT a format that carries the message decides, for all of them.
    const decisive = carrierChannels(messageKey).find((c) => c.format === undefined) ?? channel;
    return profileOfFormat(protocolDefaultFormat(decisive.protocol), channel);
  };

  const channelProfile = (channelKey: string): FormatProfile | undefined => {
    const channel = channelByKey.get(channelKey);
    if (!channel) return undefined;
    if (channel.format !== undefined) return explicitProfile(channel.format, channel);
    const tally = new Map<string, { profile: FormatProfile; count: number }>();
    for (const messageKey of messagesOn(channelKey)) {
      const profile = profileOn(messageKey, channelKey) as FormatProfile;
      const id = formatSuffix(normalizeProfile(profile));
      const seen = tally.get(id);
      if (seen) seen.count += 1;
      else tally.set(id, { profile, count: 1 });
    }
    let best: { profile: FormatProfile; count: number } | undefined;
    for (const entry of tally.values()) if (!best || entry.count > best.count) best = entry; // strict ">": the first listed wins a tie
    return best?.profile ?? profileOfFormat(protocolDefaultFormat(channel.protocol), channel);
  };

  const headline = (messageKey: string): EffectiveRepresentation | undefined => {
    const message = messageByKey.get(messageKey);
    if (!message) return undefined;
    const channels = carrierChannels(messageKey);
    const dialectOf = (format: PayloadFormat, channel: DocChannel | undefined) => (format === "json-schema" ? { dialect: channel?.formatDialect ?? DEFAULT_JSON_SCHEMA_DIALECT } : {});

    if (message.representation) {
      return { format: message.representation, ...dialectOf(message.representation, channels[0]), source: "message", reason: "Chosen on the message" };
    }
    const explicit = channels.find((c) => c.format !== undefined);
    if (explicit?.format !== undefined) {
      return { format: explicit.format, ...dialectOf(explicit.format, explicit), source: "channel", reason: `Set by channel ${explicit.key}` };
    }
    const fromEntity = entityFormats.get(message.payload.entityId);
    if (fromEntity) {
      const label = options.entityLabels?.get(message.payload.entityId);
      return {
        format: fromEntity, ...dialectOf(fromEntity, channels[0]), source: "entity",
        reason: `Auto: the ${label === undefined ? "payload entity" : `entity ${label}`} was imported from ${FORMAT_LABELS[fromEntity]}`,
      };
    }
    const first = channels[0];
    if (first) {
      const format = protocolDefaultFormat(first.protocol);
      return {
        format, ...dialectOf(format, first), source: "protocol",
        reason: `Auto: ${protocolLabel(first.protocol)} channels default to ${FORMAT_LABELS[format]}`,
      };
    }
    return {
      format: "json-schema", dialect: DEFAULT_JSON_SCHEMA_DIALECT, source: "default",
      reason: "Auto: no channel carries this message yet, so it defaults to JSON Schema",
    };
  };

  return { headline, profileOn, channelProfile, carriers, messagesOn };
}

/** The effective representation of every local message, by message key, in document order. Never mutates its inputs. */
export function resolveRepresentations(doc: EventDocument, entityFormats: EntityFormats, options: RepresentationOptions = {}): Map<string, EffectiveRepresentation> {
  const engine = createRepresentations(doc, entityFormats, options);
  const out = new Map<string, EffectiveRepresentation>();
  for (const message of doc.messages) {
    if (out.has(message.key)) continue;
    const effective = engine.headline(message.key);
    if (effective) out.set(message.key, effective);
  }
  return out;
}

/** `resolveRepresentations` reduced to the format per message key — the `representations` of an `EventBumpSide`. */
export function effectiveRepresentationFormats(doc: EventDocument, entityFormats: EntityFormats): Record<string, PayloadFormat> {
  const out: Record<string, PayloadFormat> = {};
  for (const [key, effective] of resolveRepresentations(doc, entityFormats)) Object.defineProperty(out, key, { value: effective.format, enumerable: true, writable: true, configurable: true });
  return out;
}

import type {
  Diagnostic,
  FormatProfile,
  JsonObject,
  JsonValue,
  ResolvedChannel,
  ResolvedEventSpec,
  ResolvedMessage,
  ResolvedOperation,
  ResolvedTrait,
  TraitKind,
} from "./types";
import { compareStrings, diagnostic, normalizeDiagnostics } from "./diagnostics";
import { jsonPointer, localRef } from "./json-pointer";
import { contentTypeFor, formatSuffix, normalizeProfile, schemaFormatFor } from "./schema-format";
import { qualifyNames, type NameCandidate } from "./qualify";
import { headersSchema, kafkaKeyProfile, placeKafkaKey, selectArtifact } from "./message-schemas";
import { isReservedKey, setOwn } from "./own-property";

/**
 * Spec §7.2 steps 3–5: assemble an AsyncAPI 3.0.0 document from a
 * `ResolvedEventSpec`. Pure and deterministic: maps (servers, channels,
 * operations, components.*) are sorted by key; authored lists (operation
 * messages, trait lists) keep their order; the input is never mutated.
 * Problems never throw — they come back as diagnostics.
 */

export const ASYNCAPI_VERSION = "3.0.0";

export type AssemblyResult = { document: JsonObject; diagnostics: Diagnostic[] };

type MessageVariant = {
  key: string;
  message: ResolvedMessage;
  profile: FormatProfile;
  suffix: string;
  /** Used on at least one Kafka channel → carries `bindings.kafka.key`. */
  kafka: boolean;
};

/** Build an object with keys in the given order, dropping `undefined` values. */
function ordered(entries: Array<[string, JsonValue | undefined]>): JsonObject {
  const out: JsonObject = {};
  for (const [key, value] of entries) if (value !== undefined) setOwn(out, key, value);
  return out;
}

function sortedRecord(record: Record<string, JsonValue> | undefined): JsonObject | undefined {
  if (!record) return undefined;
  const keys = Object.keys(record).sort(compareStrings);
  if (keys.length === 0) return undefined;
  const out: JsonObject = {};
  // `setOwn`: a key named `__proto__` must become an entry, not the object's prototype
  for (const key of keys) setOwn(out, key, structuredClone(record[key]));
  return out;
}

function nonEmpty(obj: JsonObject): JsonObject | undefined {
  return Object.keys(obj).length > 0 ? obj : undefined;
}

function clone<T extends JsonValue>(value: T | undefined): T | undefined {
  return value === undefined ? undefined : structuredClone(value);
}

function ref(...segments: string[]): JsonObject {
  return { $ref: localRef(...segments) };
}

/** A copy of a list, or `undefined` when it is absent or empty (new fields never emit an empty container). */
function nonEmptyList<T extends JsonValue>(value: T[] | undefined): T[] | undefined {
  return value && value.length > 0 ? structuredClone(value) : undefined;
}

/** `security: ["basic"]` (keys of `components.securitySchemes`) → `[{ $ref: "#/components/securitySchemes/basic" }]`. */
function securityRefs(keys: string[] | undefined): JsonObject[] | undefined {
  return keys && keys.length > 0 ? keys.map((key) => ref("components", "securitySchemes", key)) : undefined;
}

/**
 * An operation trait's spec as emitted: verbatim, except that `security` entries given as scheme keys (how the document model
 * writes them) become `$ref`s; entries that are already objects (a library trait's native form) are left alone.
 */
function operationTraitSpec(spec: JsonObject): JsonObject {
  const out = structuredClone(spec);
  if (Array.isArray(out.security)) {
    out.security = out.security.map((entry) => (typeof entry === "string" ? ref("components", "securitySchemes", entry) : entry));
  }
  return out;
}

function indexById<T extends { id: string }>(items: T[], kind: string, diagnostics: Diagnostic[]): Map<string, T> {
  const map = new Map<string, T>();
  for (const item of items) {
    if (map.has(item.id)) {
      diagnostics.push(
        diagnostic("error", "DUPLICATE_ID", `Duplicate ${kind} id "${item.id}"; the first one is used`, ""),
      );
      continue;
    }
    map.set(item.id, item);
  }
  return map;
}

/**
 * The format profile `message` is emitted in on `channel`: the channel's per-message entry, else the message's own profile (it
 * chose a representation, or follows Auto), else the channel's profile — which is all an explicit-format channel ever needed.
 */
function profileOn(channel: ResolvedChannel, message: ResolvedMessage): FormatProfile {
  const own = channel.messageProfiles && Object.prototype.hasOwnProperty.call(channel.messageProfiles, message.id) ? channel.messageProfiles[message.id] : undefined;
  return own ?? message.profile ?? channel.profile;
}

/** What a message nothing carries is emitted as: the default profile of JSON Schema (draft-07). */
const UNCARRIED_PROFILE: FormatProfile = { format: "json-schema" };

export function assembleAsyncApi3(spec: ResolvedEventSpec): AssemblyResult {
  const diagnostics: Diagnostic[] = [];
  /**
   * `__proto__` / `constructor` / `prototype` collide with `Object.prototype`: as a document key they would be
   * silently dropped (or reshape the object). They are never valid names — fail with a clear message (the key is
   * still written as an own entry, so references resolve and no confusing "unresolved ref" follows it).
   */
  const rejectReservedKey = (kind: string, key: string, pointer: string): void => {
    if (!isReservedKey(key)) return;
    diagnostics.push(
      diagnostic("error", "RESERVED_KEY", `${kind} "${key}" is reserved and cannot be used as a document key — rename it`, pointer),
    );
  };
  const channelsById = indexById(spec.channels, "channel", diagnostics);
  const messagesById = indexById(spec.messages, "message", diagnostics);
  const traitsById = indexById(spec.traits, "trait", diagnostics);

  // ── 1. Walk operations: which channels, message variants and traits are used ──
  const operations = [...spec.operations].sort((a, b) => compareStrings(a.key, b.key));
  const usedChannels = new Map<string, ResolvedChannel>();
  const channelVariants = new Map<string, Set<string>>();
  const variants = new Map<string, MessageVariant>();
  const usedOperationTraits = new Map<string, ResolvedTrait>();
  const emitted: ResolvedOperation[] = [];
  const operationKeys = new Set<string>();

  const traitOfKind = (id: string, kind: TraitKind): ResolvedTrait | undefined => {
    const trait = traitsById.get(id);
    return trait && trait.kind === kind ? trait : undefined;
  };

  const takeMessage = (channel: ResolvedChannel, messageId: string, pointer: string): void => {
    const message = messagesById.get(messageId);
    if (!message) {
      diagnostics.push(
        diagnostic("error", "UNKNOWN_MESSAGE_REF", `Message "${messageId}" is not in the resolved spec`, pointer),
      );
      return;
    }
    const profile = normalizeProfile(profileOn(channel, message));
    const suffix = formatSuffix(profile);
    const key = `${message.id}|${suffix}`;
    const variant = variants.get(key) ?? { key, message, profile, suffix, kafka: false };
    if (channel.protocol === "kafka") variant.kafka = true;
    variants.set(key, variant);
    usedChannels.set(channel.id, channel);
    const set = channelVariants.get(channel.id) ?? new Set<string>();
    set.add(key);
    channelVariants.set(channel.id, set);
  };

  for (const op of operations) {
    const opPointer = jsonPointer("operations", op.key);
    rejectReservedKey("Operation key", op.key, opPointer);
    if (operationKeys.has(op.key)) {
      diagnostics.push(
        diagnostic("error", "DUPLICATE_OPERATION_KEY", `Operation key "${op.key}" is used more than once`, opPointer),
      );
      continue;
    }
    operationKeys.add(op.key);
    const channel = channelsById.get(op.channelRef);
    if (!channel) {
      diagnostics.push(
        diagnostic(
          "error",
          "UNKNOWN_CHANNEL_REF",
          `Channel "${op.channelRef}" is not in the resolved spec`,
          `${opPointer}/channel`,
        ),
      );
      continue;
    }
    usedChannels.set(channel.id, channel);
    op.messageRefs.forEach((id, i) => takeMessage(channel, id, `${opPointer}/messages/${i}`));
    op.traitRefs.forEach((id, i) => {
      const trait = traitOfKind(id, "OPERATION");
      if (trait) usedOperationTraits.set(trait.id, trait);
      else
        diagnostics.push(
          diagnostic(
            "error",
            "UNKNOWN_TRAIT_REF",
            `Operation trait "${id}" is not in the resolved spec`,
            `${opPointer}/traits/${i}`,
          ),
        );
    });
    if (op.reply) {
      const replyMessages = op.reply.messageRefs ?? [];
      const replyChannel = op.reply.channelRef ? channelsById.get(op.reply.channelRef) : undefined;
      if (op.reply.channelRef && !replyChannel) {
        diagnostics.push(
          diagnostic(
            "error",
            "UNKNOWN_CHANNEL_REF",
            `Reply channel "${op.reply.channelRef}" is not in the resolved spec`,
            `${opPointer}/reply/channel`,
          ),
        );
      } else if (!op.reply.channelRef && replyMessages.length > 0) {
        diagnostics.push(
          diagnostic(
            "error",
            "REPLY_CHANNEL_REQUIRED",
            "Reply messages need a reply channel",
            `${opPointer}/reply/messages`,
          ),
        );
      }
      if (replyChannel) {
        usedChannels.set(replyChannel.id, replyChannel);
        replyMessages.forEach((id, i) => takeMessage(replyChannel, id, `${opPointer}/reply/messages/${i}`));
      }
    }
    emitted.push(op);
  }

  // emitAll: also everything the spec carries that no operation reaches — channels, the messages they allow, messages no channel
  // carries (emitted as components only, in their own profile) and unused traits.
  if (spec.emitAll) {
    for (const channel of channelsById.values()) {
      usedChannels.set(channel.id, channel);
      (channel.messageRefs ?? []).forEach((id, i) => takeMessage(channel, id, jsonPointer("channels", channel.id, "messages", i)));
    }
    const carried = new Set([...variants.values()].map((v) => v.message.id));
    for (const message of messagesById.values()) {
      if (carried.has(message.id)) continue;
      const profile = normalizeProfile(message.profile ?? UNCARRIED_PROFILE);
      const suffix = formatSuffix(profile);
      const key = `${message.id}|${suffix}`;
      variants.set(key, { key, message, profile, suffix, kafka: false });
    }
    for (const trait of traitsById.values()) if (trait.kind === "OPERATION") usedOperationTraits.set(trait.id, trait);
  }

  const usedMessageTraits = new Map<string, ResolvedTrait>();
  if (spec.emitAll) for (const trait of traitsById.values()) if (trait.kind === "MESSAGE") usedMessageTraits.set(trait.id, trait);
  for (const variant of variants.values()) {
    for (const id of variant.message.traitRefs) {
      const trait = traitOfKind(id, "MESSAGE");
      if (trait) usedMessageTraits.set(trait.id, trait);
    }
  }

  // ── 2. Qualify names (spec §7.2 step 5) ──
  const disambiguationWarnings = (keys: string[], names: Map<string, string>, prefix: string[]): void => {
    for (const key of keys) {
      const name = names.get(key) as string;
      diagnostics.push(
        diagnostic(
          "warning",
          "NAME_DISAMBIGUATED",
          `Name clash resolved with a numeric suffix: "${name}"`,
          jsonPointer(...prefix, name),
        ),
      );
    }
  };

  const channelNames = qualifyNames(
    [...usedChannels.values()].map((c) => ({ key: c.id, name: c.name, owner: c.productSlug })),
    spec.productSlug,
  );
  disambiguationWarnings(channelNames.disambiguated, channelNames.names, ["channels"]);

  const variantCount = new Map<string, number>();
  for (const v of variants.values()) variantCount.set(v.message.id, (variantCount.get(v.message.id) ?? 0) + 1);
  const messageNames = qualifyNames(
    [...variants.values()].map(
      (v): NameCandidate => ({
        key: v.key,
        name: (variantCount.get(v.message.id) ?? 0) > 1 ? `${v.message.name}_${v.suffix}` : v.message.name,
        owner: v.message.productSlug,
      }),
    ),
    spec.productSlug,
  );
  disambiguationWarnings(messageNames.disambiguated, messageNames.names, ["components", "messages"]);

  const traitCandidates = (traits: Map<string, ResolvedTrait>): NameCandidate[] =>
    [...traits.values()].map((t) => ({ key: t.id, name: t.name, owner: t.ownerSlug }));
  const messageTraitNames = qualifyNames(traitCandidates(usedMessageTraits), spec.productSlug);
  disambiguationWarnings(messageTraitNames.disambiguated, messageTraitNames.names, ["components", "messageTraits"]);
  const operationTraitNames = qualifyNames(traitCandidates(usedOperationTraits), spec.productSlug);
  disambiguationWarnings(operationTraitNames.disambiguated, operationTraitNames.names, [
    "components",
    "operationTraits",
  ]);

  const channelKey = (id: string) => channelNames.names.get(id) as string;
  const messageKey = (variantKey: string) => messageNames.names.get(variantKey) as string;
  const variantOn = (channel: ResolvedChannel, messageId: string) =>
    `${messageId}|${formatSuffix(profileOn(channel, messagesById.get(messageId) as ResolvedMessage))}`;
  const byName = <T>(entries: Array<[string, T]>) => entries.sort((a, b) => compareStrings(a[0], b[0]));

  // ── 3. components.messages ──
  const componentMessages: JsonObject = {};
  for (const [name, variant] of byName(
    [...variants.values()].map((v): [string, MessageVariant] => [messageKey(v.key), v]),
  )) {
    const msg = variant.message;
    const base = ["components", "messages", name];

    const traitRefs: JsonObject[] = [];
    msg.traitRefs.forEach((id, i) => {
      const trait = traitOfKind(id, "MESSAGE");
      if (trait) traitRefs.push(ref("components", "messageTraits", messageTraitNames.names.get(trait.id) as string));
      else
        diagnostics.push(
          diagnostic(
            "error",
            "UNKNOWN_TRAIT_REF",
            `Message trait "${id}" is not in the resolved spec`,
            jsonPointer(...base, "traits", i),
          ),
        );
    });

    let headers: JsonObject | undefined;
    if (msg.headers) {
      const h = headersSchema(msg.headers, jsonPointer(...base, "headers"));
      diagnostics.push(...h.diagnostics);
      headers = h.schema;
    }

    const payloadSelection = selectArtifact(
      msg.payloads,
      variant.profile,
      "payload",
      jsonPointer(...base, "payload", "schema"),
    );
    diagnostics.push(...payloadSelection.diagnostics);
    const payload =
      payloadSelection.schema === undefined
        ? undefined
        : { schemaFormat: schemaFormatFor(variant.profile), schema: payloadSelection.schema };

    let bindings = clone(msg.bindings);
    if (variant.kafka && msg.keys && msg.keys.length > 0) {
      const keyPointer = jsonPointer(...base, "bindings", "kafka", "key");
      const keyProfile = kafkaKeyProfile(variant.profile);
      const keySelection = selectArtifact(msg.keys, keyProfile, "key", keyPointer);
      diagnostics.push(...keySelection.diagnostics);
      if (keySelection.schema !== undefined) {
        // The Kafka message binding types `key` as a JSON Schema Object (or $ref): a bare Avro record (`type: "record"`) is
        // rejected by @asyncapi/parser, so an Avro key is tagged like a payload — a Multi Format Schema Object.
        const key =
          keyProfile.format === "avro"
            ? { schemaFormat: schemaFormatFor(keyProfile), schema: keySelection.schema }
            : keySelection.schema;
        const placed = placeKafkaKey(bindings, key);
        bindings = placed.bindings;
        if (placed.overridden) {
          diagnostics.push(
            diagnostic(
              "warning",
              "KEY_BINDING_OVERRIDDEN",
              "bindings.kafka.key was replaced by the pinned key schema",
              keyPointer,
            ),
          );
        }
      }
    }

    if (msg.unpublished) {
      diagnostics.push(
        diagnostic(
          "info",
          "UNPUBLISHED_MESSAGE",
          `Message "${msg.name}" is an unpublished draft`,
          jsonPointer(...base),
        ),
      );
    }

    // R28: a message emitted in several formats gets a per-format contentType; a single-format
    // message keeps its explicit contentType, falling back to the same format-derived default.
    const contentType =
      msg.contentType !== undefined && (variantCount.get(msg.id) ?? 0) <= 1
        ? msg.contentType
        : contentTypeFor(variant.profile);

    rejectReservedKey("Message name", name, jsonPointer(...base));
    setOwn(
      componentMessages,
      name,
      ordered([
        ["name", msg.messageName ?? (name !== msg.name ? msg.name : undefined)],
        ["title", msg.title],
        ["summary", msg.summary],
        ["description", msg.description],
        ["contentType", contentType],
        ["correlationId", clone(msg.correlationId)],
        ["traits", traitRefs.length > 0 ? traitRefs : undefined],
        ["headers", headers],
        ["payload", payload],
        ["tags", clone(msg.tags)],
        ["externalDocs", clone(msg.externalDocs)],
        ["deprecated", msg.deprecated],
        ["bindings", bindings],
        ["examples", clone(msg.examples)],
      ]),
    );
  }

  // ── 4. components.messageTraits / operationTraits ──
  const componentMessageTraits: JsonObject = {};
  for (const [name, trait] of byName(
    [...usedMessageTraits.values()].map((t): [string, ResolvedTrait] => [
      messageTraitNames.names.get(t.id) as string,
      t,
    ]),
  )) {
    rejectReservedKey("Message trait name", name, jsonPointer("components", "messageTraits", name));
    if (!trait.headers) {
      setOwn(componentMessageTraits, name, structuredClone(trait.spec));
      continue;
    }
    const h = headersSchema(trait.headers, jsonPointer("components", "messageTraits", name, "headers"));
    diagnostics.push(...h.diagnostics);
    const rest = Object.entries(trait.spec).filter(([k]) => k !== "headers");
    setOwn(
      componentMessageTraits,
      name,
      ordered([
        ["headers", h.schema],
        ...rest.map(([k, v]): [string, JsonValue] => [k, structuredClone(v)]),
      ]),
    );
  }
  const componentOperationTraits: JsonObject = {};
  for (const [name, trait] of byName(
    [...usedOperationTraits.values()].map((t): [string, ResolvedTrait] => [
      operationTraitNames.names.get(t.id) as string,
      t,
    ]),
  )) {
    rejectReservedKey("Operation trait name", name, jsonPointer("components", "operationTraits", name));
    setOwn(componentOperationTraits, name, operationTraitSpec(trait.spec));
  }

  // ── 5. channels ──
  const serverKeys = new Set(spec.servers.map((s) => s.key));
  const channels: JsonObject = {};
  for (const [name, channel] of byName(
    [...usedChannels.values()].map((c): [string, ResolvedChannel] => [channelKey(c.id), c]),
  )) {
    const messages: JsonObject = {};
    const keys = [...(channelVariants.get(channel.id) ?? [])].map(messageKey).sort(compareStrings);
    for (const key of keys) setOwn(messages, key, ref("components", "messages", key));
    rejectReservedKey("Channel name", name, jsonPointer("channels", name));
    const channelServers: JsonObject[] = [];
    (channel.serverRefs ?? []).forEach((key, i) => {
      if (serverKeys.has(key)) channelServers.push(ref("servers", key));
      else
        diagnostics.push(
          diagnostic("error", "UNKNOWN_SERVER_REF", `Server "${key}" is not in the resolved spec`, jsonPointer("channels", name, "servers", i)),
        );
    });
    setOwn(
      channels,
      name,
      ordered([
        ["address", channel.address],
        ["messages", nonEmpty(messages)],
        ["title", channel.title],
        ["summary", channel.summary],
        ["description", channel.description],
        ["servers", channelServers.length > 0 ? channelServers : undefined],
        ["parameters", sortedRecord(channel.parameters)],
        ["tags", clone(channel.tags)],
        ["externalDocs", clone(channel.externalDocs)],
        ["bindings", clone(channel.bindings)],
      ]),
    );
  }

  // ── 6. operations ──
  const operationsOut: JsonObject = {};
  for (const op of emitted) {
    const channel = channelsById.get(op.channelRef) as ResolvedChannel;
    const cKey = channelKey(channel.id);
    const messageRefs = op.messageRefs
      .filter((id) => messagesById.has(id))
      .map((id) => ref("channels", cKey, "messages", messageKey(variantOn(channel, id))));
    const traitRefs = op.traitRefs
      .filter((id) => usedOperationTraits.has(id))
      .map((id) => ref("components", "operationTraits", operationTraitNames.names.get(id) as string));

    let reply: JsonObject | undefined;
    if (op.reply) {
      const replyChannel = op.reply.channelRef ? channelsById.get(op.reply.channelRef) : undefined;
      const rKey = replyChannel ? channelKey(replyChannel.id) : undefined;
      const replyMessages =
        replyChannel && rKey
          ? (op.reply.messageRefs ?? [])
              .filter((id) => messagesById.has(id))
              .map((id) => ref("channels", rKey, "messages", messageKey(variantOn(replyChannel, id))))
          : [];
      reply = nonEmpty(
        ordered([
          ["address", clone(op.reply.address)],
          ["channel", rKey ? ref("channels", rKey) : undefined],
          ["messages", replyMessages.length > 0 ? replyMessages : undefined],
        ]),
      );
    }

    setOwn(
      operationsOut,
      op.key,
      ordered([
        ["action", op.action],
        ["channel", ref("channels", cKey)],
        ["title", op.title],
        ["summary", op.summary],
        ["description", op.description],
        ["security", securityRefs(op.security)],
        ["tags", nonEmptyList(op.tags)],
        ["externalDocs", clone(op.externalDocs)],
        ["bindings", clone(op.bindings)],
        ["traits", traitRefs.length > 0 ? traitRefs : undefined],
        ["messages", messageRefs.length > 0 ? messageRefs : undefined],
        ["reply", reply],
      ]),
    );
  }

  // ── 7. servers ──
  const servers: JsonObject = {};
  for (const server of [...spec.servers].sort((a, b) => compareStrings(a.key, b.key))) {
    if (Object.prototype.hasOwnProperty.call(servers, server.key)) {
      diagnostics.push(
        diagnostic(
          "error",
          "DUPLICATE_SERVER_KEY",
          `Server key "${server.key}" is used more than once`,
          jsonPointer("servers", server.key),
        ),
      );
      continue;
    }
    rejectReservedKey("Server key", server.key, jsonPointer("servers", server.key));
    setOwn(
      servers,
      server.key,
      ordered([
        ["host", server.host],
        ["protocol", server.protocol],
        ["protocolVersion", server.protocolVersion],
        ["pathname", server.pathname],
        ["title", server.title],
        ["summary", server.summary],
        ["description", server.description],
        ["variables", sortedRecord(server.variables)],
        ["security", securityRefs(server.security)],
        ["tags", nonEmptyList(server.tags)],
        ["externalDocs", server.externalDocs ? clone(server.externalDocs) : server.externalRef ? { url: server.externalRef } : undefined],
        ["bindings", clone(server.bindings)],
      ]),
    );
  }

  // ── 8. document ──
  const components = ordered([
    ["messages", nonEmpty(componentMessages)],
    ["messageTraits", nonEmpty(componentMessageTraits)],
    ["operationTraits", nonEmpty(componentOperationTraits)],
    ["parameters", sortedRecord(spec.components.parameters)],
    ["correlationIds", sortedRecord(spec.components.correlationIds)],
    ["securitySchemes", sortedRecord(spec.components.securitySchemes)],
    ["operationBindings", sortedRecord(spec.components.operationBindings)],
  ]);

  const document = ordered([
    ["asyncapi", ASYNCAPI_VERSION],
    [
      "info",
      ordered([
        ["title", spec.info.title],
        ["version", spec.info.version],
        ["description", spec.info.description],
        ["termsOfService", spec.info.termsOfService],
        ["contact", clone(spec.info.contact)],
        ["license", clone(spec.info.license)],
        ["tags", clone(spec.info.tags)],
        ["externalDocs", clone(spec.info.externalDocs)],
      ]),
    ],
    ["servers", nonEmpty(servers)],
    ["defaultContentType", spec.defaultContentType],
    ["channels", nonEmpty(channels)],
    ["operations", nonEmpty(operationsOut)],
    ["components", nonEmpty(components)],
  ]);

  return { document, diagnostics: normalizeDiagnostics(diagnostics) };
}

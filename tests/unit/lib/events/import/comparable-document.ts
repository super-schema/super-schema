// tests/unit/lib/events/import/comparable-document.ts
// Test helper (never part of src): what two event documents must have in common for one to be "the same event" as the other after the
// original went through the assembler and back through the importer. It removes exactly what that trip cannot carry, and nothing else:
//
//  - entity pins: the importer pins placeholders, the original pins real entities (only whether a payload / headers pin EXISTS is compared)
//  - `origin` of servers and channels, `representation` of messages, `format` / `formatDialect` of channels: provenance and emission
//    choices that a file does not record (the importer leaves them to Auto)
//  - a Kafka key pin: it is emitted as `bindings.kafka.key` (a schema), so that binding key is ignored on both sides
//  - the content type the assembler DERIVES from the payload format (avro/binary, application/json, application/x-protobuf)
//  - a library trait: it is emitted as a local trait with the library's spec, so the original is expanded the same way (`libraryTraits`),
//    and a trait's `headers` (a pinned entity before, an inline schema after) are not compared
//  - a server's `externalRef`: emitted as `externalDocs: { url }`
//  - a message emitted in several formats: the assembler writes one message per format (`Name_avro`, `Name_json`); they are folded back into one
//  - ordering of every list that has no meaning in its order
//  - with `serverLinks: false` (a file emitted without `channels.<c>.servers`): the channel → server links and the channel protocol, which
//    the importer can only guess without them
//  - with `reachableOnly`: only what operations reach (the assembler emits nothing else)
import { FORMAT_CONTENT_TYPES } from "@/lib/event-specs/schema-format";
import type { DocChannel, DocMessage, DocTrait, EventDocument } from "@/lib/events/document/types";
import type { FrozenTrait } from "@/lib/events/types";

export interface ComparableOptions {
  /** Default true. */
  serverLinks?: boolean;
  reachableOnly?: boolean;
  libraryTraits?: ReadonlyMap<string, FrozenTrait>;
}

const FORMAT_SUFFIXES = ["avro", "proto", "json", "json2020"];
const DERIVED_CONTENT_TYPES = new Set<string>(Object.values(FORMAT_CONTENT_TYPES));
const byKey = <T extends { key: string }>(a: T, b: T) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
const defined = <T extends object>(value: T): T => Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
/** A copy of `value` without `keys`. */
const omit = <T extends object>(value: T, ...keys: string[]): Record<string, unknown> => Object.fromEntries(Object.entries(value).filter(([k]) => !keys.includes(k)));

/** What operations reach: their channels (and reply channels), the messages they put on them, the traits of both. */
function reachable(doc: EventDocument): EventDocument {
  const onChannel = new Map<string, Set<string>>();
  const take = (channelKey: string | undefined, messageKeys: readonly string[] | undefined) => {
    if (channelKey === undefined) return;
    const set = onChannel.get(channelKey) ?? new Set<string>();
    for (const k of messageKeys ?? []) set.add(k);
    onChannel.set(channelKey, set);
  };
  for (const o of doc.operations) { take(o.channelKey, o.messageKeys); take(o.reply?.channelKey, o.reply?.messageKeys); }
  const channels = doc.channels.filter((c) => onChannel.has(c.key)).map((c) => ({ ...c, messageKeys: c.messageKeys.filter((k) => onChannel.get(c.key)?.has(k)) }));
  const messageKeys = new Set(channels.flatMap((c) => c.messageKeys));
  const messages = doc.messages.filter((m) => messageKeys.has(m.key));
  const traitKeys = new Set([...messages.flatMap((m) => m.traitKeys), ...doc.operations.flatMap((o) => o.traitKeys)]);
  return { ...doc, channels, messages, traits: doc.traits.filter((t) => traitKeys.has(t.key)) };
}

/** `Name_avro` + `Name_json` (both named `Name`) → one message `Name`, every reference rewritten. */
function foldFormatVariants(doc: EventDocument): EventDocument {
  const rename = new Map<string, string>();
  for (const m of doc.messages) {
    const suffix = m.name !== undefined ? FORMAT_SUFFIXES.find((s) => m.key === `${m.name}_${s}`) : undefined;
    if (suffix !== undefined && m.name !== undefined) rename.set(m.key, m.name);
  }
  if (rename.size === 0) return doc;
  const swap = (k: string) => rename.get(k) ?? k;
  const swapAll = (keys: string[]) => [...new Set(keys.map(swap))];
  const seen = new Set<string>();
  const messages: DocMessage[] = [];
  for (const m of doc.messages) {
    const key = swap(m.key);
    if (seen.has(key)) continue;
    seen.add(key);
    messages.push(rename.has(m.key) ? defined({ ...m, key, name: undefined }) : m);
  }
  return {
    ...doc, messages,
    channels: doc.channels.map((c) => ({ ...c, messageKeys: swapAll(c.messageKeys) })),
    operations: doc.operations.map((o) => ({
      ...o, messageKeys: swapAll(o.messageKeys),
      ...(o.reply?.messageKeys ? { reply: { ...o.reply, messageKeys: swapAll(o.reply.messageKeys) } } : {}),
    })),
  };
}

const withoutKafkaKey = (bindings: DocMessage["bindings"]): DocMessage["bindings"] => {
  if (!bindings) return undefined;
  const kafka = bindings.kafka;
  if (typeof kafka !== "object" || kafka === null || Array.isArray(kafka)) return bindings;
  const kafkaRest = omit(kafka, "key");
  const rest = omit(bindings, "kafka");
  const next = Object.keys(kafkaRest).length > 0 ? { ...rest, kafka: kafkaRest } : rest;
  return Object.keys(next).length > 0 ? (next as DocMessage["bindings"]) : undefined;
};

function comparableTrait(t: DocTrait, libraryTraits: ComparableOptions["libraryTraits"]): unknown {
  let spec = "spec" in t ? t.spec : undefined;
  if ("libraryTraitId" in t) {
    const library = libraryTraits?.get(t.libraryTraitId);
    if (!library) throw new Error(`the test needs the library trait ${t.libraryTraitId}`);
    spec = library.spec;
  }
  return { key: t.key, kind: t.kind, spec: omit(spec ?? {}, "headers") };
}

export function comparableDocument(source: EventDocument, options: ComparableOptions = {}): unknown {
  const serverLinks = options.serverLinks ?? true;
  let doc = structuredClone(source);
  if (options.reachableOnly) doc = reachable(doc);
  doc = foldFormatVariants(doc);
  return {
    info: doc.info,
    defaultContentType: doc.defaultContentType,
    servers: [...doc.servers].sort(byKey).map((s) => defined({
      ...omit(s, "origin", "externalRef"),
      externalDocs: s.externalDocs ?? (s.externalRef !== undefined ? { url: s.externalRef } : undefined),
    })),
    channels: [...doc.channels].sort(byKey).map((c: DocChannel) => defined({
      ...omit(c, "origin", "format", "formatDialect", "serverKeys", "protocol", "messageKeys"),
      messageKeys: [...c.messageKeys].sort(),
      ...(serverLinks ? { serverKeys: [...c.serverKeys].sort(), protocol: c.protocol } : {}),
    })),
    messages: [...doc.messages].sort(byKey).map((m) => defined({
      ...omit(m, "payload", "headers", "keyPin", "representation", "contentType", "bindings"),
      contentType: m.contentType !== undefined && DERIVED_CONTENT_TYPES.has(m.contentType) ? undefined : m.contentType,
      bindings: withoutKafkaKey(m.bindings),
      payload: "pinned", headers: m.headers ? "pinned" : undefined,
    })),
    traits: [...doc.traits].sort(byKey).map((t) => comparableTrait(t, options.libraryTraits)),
    operations: [...doc.operations].sort(byKey),
    components: doc.components,
  };
}

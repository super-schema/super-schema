// src/lib/events/import/message-index.ts
// Which messages an AsyncAPI document defines, and the document key each one gets. Pure — client-safe.
//
// Both `extractPayloads` (payload.ts) and the mapper (map-document.ts) need the SAME key for the same message, so both read it from here:
// a component message keeps its component key (`components.messages.X` is key `X`); an inline message of a channel is keyed by its
// channel-local key; a key that is not valid, or is taken, is adjusted the same way for both.
import { ok, type Result } from "@/types/result";
import { jsonPointer } from "@/lib/event-specs/json-pointer";
import { assignKeys, type KeyRequest } from "./keys";
import { isRef, type RefResolver } from "./refs";
import type { ImportWarning, RawAsyncApi3 } from "./types";

export const isBag = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The entries of a map-like value; anything else has none. */
export const entriesOf = (v: unknown): Array<[string, unknown]> => (isBag(v) ? Object.entries(v) : []);

export interface IndexedMessage {
  /** The key the message gets in the event document. */
  key: string;
  /** Where the message is defined: `/components/messages/X`, or `/channels/c/messages/k` for an inline one. */
  pointer: string;
  /** The message object as written (refs inside it are untouched). */
  node: Record<string, unknown>;
  /** The key it was written under (the component key, or the first channel-local key it was found under). */
  sourceKey: string;
}

export interface MessageIndex {
  /** Component messages first (file order), then inline ones in channel order. */
  messages: IndexedMessage[];
  /** By component key as written in the source (before any key adjustment). */
  byComponentKey: Map<string, IndexedMessage>;
  /** By channel key as written in the source: the channel's messages by their channel-local key. */
  channels: Map<string, Map<string, IndexedMessage>>;
  /** `KEY_ADJUSTED` and the like, in the order they were found. */
  warnings: ImportWarning[];
}

export function indexMessages(raw: RawAsyncApi3, refs: RefResolver): Result<MessageIndex> {
  const warnings: ImportWarning[] = [];
  const byPointer = new Map<string, IndexedMessage>();
  const byComponentKey = new Map<string, IndexedMessage>();
  const channels = new Map<string, Map<string, IndexedMessage>>();
  const ordered: IndexedMessage[] = [];
  const requests = { component: [] as KeyRequest[], inline: [] as KeyRequest[] };

  const define = (value: unknown, at: string, sourceKey: string, component: boolean): Result<IndexedMessage | null> => {
    const target = refs.deref(value, at);
    if (!target.success) return target;
    const known = byPointer.get(target.data.pointer);
    if (known) return ok(known);
    if (!isBag(target.data.value)) {
      warnings.push({ pointer: at, code: "SANITIZED_VALUE", message: `A message must be an object; "${sourceKey}" is not, so it was left out` });
      return ok(null);
    }
    const message: IndexedMessage = { key: "", pointer: target.data.pointer, node: target.data.value, sourceKey };
    byPointer.set(message.pointer, message);
    ordered.push(message);
    (component ? requests.component : requests.inline).push({ id: message.pointer, key: sourceKey, pointer: at });
    return ok(message);
  };

  const components = entriesOf(isBag(raw.components) ? raw.components.messages : undefined);
  // A component that is only an alias (`X: { $ref: '#/components/messages/Y' }`) is defined after the ones that hold a message themselves,
  // so `Y` keeps the key `Y` whichever comes first in the file.
  for (const [key, value] of [...components.filter(([, v]) => !isRef(v)), ...components.filter(([, v]) => isRef(v))]) {
    const message = define(value, jsonPointer("components", "messages", key), key, true);
    if (!message.success) return message;
    if (message.data) byComponentKey.set(key, message.data);
  }
  for (const [channelKey, channelValue] of entriesOf(raw.channels)) {
    const channelAt = jsonPointer("channels", channelKey);
    const channel = refs.deref(channelValue, channelAt);
    if (!channel.success) return channel;
    if (!isBag(channel.data.value)) continue;
    const local = new Map<string, IndexedMessage>();
    channels.set(channelKey, local);
    for (const [localKey, value] of entriesOf(channel.data.value.messages)) {
      const message = define(value, `${channel.data.pointer}${jsonPointer("messages", localKey)}`, localKey, false);
      if (!message.success) return message;
      if (message.data) local.set(localKey, message.data);
    }
  }

  const taken = new Set<string>();
  const componentKeys = assignKeys(requests.component, taken, "message", warnings);
  const inlineKeys = assignKeys(requests.inline, taken, "message", warnings);
  for (const message of ordered) message.key = (componentKeys.get(message.pointer) ?? inlineKeys.get(message.pointer)) as string;
  return ok({ messages: ordered, byComponentKey, channels, warnings });
}

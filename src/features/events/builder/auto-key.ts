// src/features/events/builder/auto-key.ts
// Generated identifiers (round-2 R3). A new item is created with a placeholder key (`server`, `server-2`, …). Once the user has typed
// something to name it by (a title, a host, an address, …) the key is renamed ONCE to a readable one through `renameKey`, so every
// reference follows. After that, and after any manual rename, the key never changes on its own. Pure — no React.
import { renameKey, type KeyKind } from "@/lib/events/document/keys";
import type { EventDocument } from "@/lib/events/document/types";
import { suggestKey } from "@/lib/events/templates/keys";

/** What a freshly created item's key looks like: the kind's own name, optionally with a counter. */
const PLACEHOLDER = /^(server|channel|message|operation|trait)(-\d+)?$/;

/** True while `key` is one a new item was created with (and therefore may still be replaced by a generated name). */
export const isPlaceholderKey = (key: string): boolean => PLACEHOLDER.test(key);

/** Every key of the namespace `kind` lives in: channels and messages share theirs with the external references of the same kind. */
export function takenKeys(doc: EventDocument, kind: KeyKind): string[] {
  const channelish = () => [...doc.channels.map((c) => c.key), ...doc.externalRefs.filter((r) => r.kind === "channel").map((r) => r.key)];
  const messageish = () => [...doc.messages.map((m) => m.key), ...doc.externalRefs.filter((r) => r.kind === "message").map((r) => r.key)];
  switch (kind) {
    case "server": return doc.servers.map((s) => s.key);
    case "operation": return doc.operations.map((o) => o.key);
    case "trait": return doc.traits.map((t) => t.key);
    case "channel": return channelish();
    case "message": return messageish();
    // External references are unique across both kinds and may not shadow a local channel or message.
    case "externalRef": return [...doc.externalRefs.map((r) => r.key), ...doc.channels.map((c) => c.key), ...doc.messages.map((m) => m.key)];
  }
}

/** The key a new item of `kind` starts with: the kind itself, `-2`, `-3`, … while taken. It always looks like a placeholder. */
export function newKey(doc: EventDocument, kind: KeyKind): string {
  return suggestKey(kind, {}, takenKeys(doc, kind));
}

/**
 * Give the item `key` of `kind` a generated key from `values`, once.
 *
 * `values` are the texts the key can come from (see `suggestKey`): server `{ title, host }`, channel `{ title, address }`,
 * message `{ name, title }`, operation `{ title, action, channel }`, trait `{ name, title }`.
 * Returns `doc` itself (same reference) when nothing changes: the key is no placeholder any more, the item is not in the document,
 * or there is nothing to name it by yet. Otherwise a new document in which the key and every reference to it were renamed.
 */
export function autoRenameKey(doc: EventDocument, kind: KeyKind, key: string, values: Record<string, unknown>): EventDocument {
  if (kind === "externalRef" || !isPlaceholderKey(key)) return doc;
  const pool = takenKeys(doc, kind);
  const self = pool.indexOf(key);
  if (self < 0) return doc;
  // Nothing usable typed yet: the suggestion is just the kind's name again.
  if (suggestKey(kind, values, []) === kind) return doc;
  const next = suggestKey(kind, values, pool.filter((_, i) => i !== self));
  if (next === key) return doc;
  const renamed = renameKey(doc, kind, key, next);
  return renamed.success ? renamed.data : doc;
}

/**
 * For a `blur` handler on a form's wrapper: true when focus left the wrapper altogether (to another part of the page, or nowhere),
 * false when it only moved between two fields inside it. A generated key is committed on leaving, so the title wins over the host
 * whichever the user filled first, and typing never renames under the user's hands.
 */
export const leftForm = (event: { currentTarget: Element; relatedTarget: EventTarget | null }): boolean =>
  !(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget);

// src/lib/events/document/keys.ts
// Key helpers for the v2 event document: slugging, uniqueness, and rename-with-reference-rewrite. Pure — client-safe.
import { err, ok, type Result } from "@/types/result";
import { isReservedKey } from "@/lib/event-specs/own-property";
import { KEY_MAX_LENGTH, KEY_PATTERN, type EventDocument } from "./types";
import { ANY_PROPERTIES } from "./wording";

export type KeyKind = "server" | "channel" | "message" | "trait" | "operation" | "externalRef";

/** Title → valid key (`^[a-zA-Z0-9._-]+$`, ≤ 64, never an `Object.prototype` name). Never empty. */
export function slugKey(text: string): string {
  const slug = text.trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/-{2,}/g, "-").replace(/^-+|-+$/g, "").slice(0, KEY_MAX_LENGTH).replace(/-+$/g, "");
  if (!slug) return "item";
  return isReservedKey(slug) ? `${slug}-1` : slug;
}

/** `base`, or `base-2`, `base-3`, … (the base is shortened so the result stays within `KEY_MAX_LENGTH`). */
export function uniqueKey(base: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  if (!used.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const suffix = `-${n}`;
    const candidate = `${base.slice(0, KEY_MAX_LENGTH - suffix.length)}${suffix}`;
    if (!used.has(candidate)) return candidate;
  }
}

/**
 * Rename one key and rewrite every reference to it (E9). Returns a new document; the input is never mutated.
 * Refuses an invalid key, an unknown `from`, and a `to` that is already taken in the key's namespace.
 */
export function renameKey(doc: EventDocument, kind: KeyKind, from: string, to: string): Result<EventDocument> {
  const fail = (message: string) => err({ code: "VALIDATION_ERROR" as const, message });
  if (!KEY_PATTERN.test(to) || to.length > KEY_MAX_LENGTH || isReservedKey(to)) return fail(`"${to}" is not a valid key`);
  const next = structuredClone(doc);
  const swap = (k: string) => (k === from ? to : k);
  const swapAll = (keys: string[]) => keys.map(swap);
  // Namespaces: channel-ish = channels + externalRefs(channel); message-ish = messages + externalRefs(message).
  const refKind = (key: string) => next.externalRefs.find((r) => r.key === key)?.kind;
  const channelish = () => [...next.channels.map((c) => c.key), ...next.externalRefs.filter((r) => r.kind === "channel").map((r) => r.key)];
  const messageish = () => [...next.messages.map((m) => m.key), ...next.externalRefs.filter((r) => r.kind === "message").map((r) => r.key)];
  const exists = { server: () => next.servers.map((s) => s.key), operation: () => next.operations.map((o) => o.key),
    trait: () => next.traits.map((t) => t.key), channel: channelish, message: messageish,
    externalRef: () => (refKind(from) === "channel" ? channelish() : messageish()) };
  const pool = exists[kind]();
  // A trait is "message properties" / "operation properties" to the user; no key means no kind to name, so both.
  if (!pool.includes(from)) return fail(`No ${kind === "trait" ? ANY_PROPERTIES : kind} with key "${from}"`);
  if (from === to) return ok(next);
  if (pool.includes(to)) return fail(`The key "${to}" is already used`);
  // External-reference keys are unique across both kinds (the parser checks them overall).
  if (kind === "externalRef" && next.externalRefs.some((r) => r.key === to)) return fail(`The key "${to}" is already used`);

  const asChannel = kind === "channel" || (kind === "externalRef" && refKind(from) === "channel");
  const asMessage = kind === "message" || (kind === "externalRef" && refKind(from) === "message");
  if (kind === "server") next.servers.forEach((s) => { if (s.key === from) s.key = to; });
  if (kind === "server") next.channels.forEach((c) => { c.serverKeys = swapAll(c.serverKeys); });
  if (kind === "operation") next.operations.forEach((o) => { if (o.key === from) o.key = to; });
  if (kind === "trait") {
    next.traits.forEach((t) => { if (t.key === from) t.key = to; });
    next.messages.forEach((m) => { m.traitKeys = swapAll(m.traitKeys); });
    next.operations.forEach((o) => { o.traitKeys = swapAll(o.traitKeys); });
  }
  if (kind === "channel") next.channels.forEach((c) => { if (c.key === from) c.key = to; });
  if (kind === "message") next.messages.forEach((m) => { if (m.key === from) m.key = to; });
  if (kind === "externalRef") next.externalRefs.forEach((r) => { if (r.key === from) r.key = to; });
  if (asChannel) next.operations.forEach((o) => {
    o.channelKey = swap(o.channelKey);
    if (o.reply?.channelKey !== undefined) o.reply.channelKey = swap(o.reply.channelKey);
  });
  if (asMessage) {
    next.channels.forEach((c) => { c.messageKeys = swapAll(c.messageKeys); });
    next.operations.forEach((o) => {
      o.messageKeys = swapAll(o.messageKeys);
      if (o.reply?.messageKeys) o.reply.messageKeys = swapAll(o.reply.messageKeys);
    });
  }
  return ok(next);
}

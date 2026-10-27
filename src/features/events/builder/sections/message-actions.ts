// src/features/events/builder/sections/message-actions.ts
// Whole-message edits of the document, as pure functions: copy a message, and take one out with every reference to it. No React.
import type { DocMessage, EventDocument } from "@/lib/events/document/types";
import { newKey } from "../auto-key";
import { withoutMessage } from "./graph-parts";

/**
 * The document with a copy of the message `key` appended, and the copy's key (a placeholder key, named from its name or title once the
 * user edits it). The copy shares nothing with the original and is on no channel and no operation: a channel has to allow it, as for
 * any new message. Null when `key` is not a local message.
 */
export function duplicateMessage(doc: EventDocument, key: string): { doc: EventDocument; key: string } | null {
  const original = doc.messages.find((m) => m.key === key);
  if (!original) return null;
  const copyKey = newKey(doc, "message");
  const copy: DocMessage = { ...structuredClone(original), key: copyKey };
  return { doc: { ...doc, messages: [...doc.messages, copy] }, key: copyKey };
}

/**
 * The document without the message at `index` and, unless another definition of the same key stays (a second local message, or an
 * external reference standing in for it), without any reference to it in channels, operations and replies.
 */
export function removeMessageAt(doc: EventDocument, index: number): EventDocument {
  const key = doc.messages[index].key;
  const messagesLeft = doc.messages.filter((_, i) => i !== index);
  const stillDefined = messagesLeft.some((m) => m.key === key) || doc.externalRefs.some((r) => r.kind === "message" && r.key === key);
  return stillDefined ? { ...doc, messages: messagesLeft } : withoutMessage({ ...doc, messages: messagesLeft }, key);
}

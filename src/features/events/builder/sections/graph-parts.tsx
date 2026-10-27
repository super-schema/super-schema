"use client";

// src/features/events/builder/sections/graph-parts.tsx
// What the Channels, Messages and Operations sections share, because they all edit the same channel <-> message <-> operation graph:
// document helpers (who uses what, allow / disallow a message on a channel, rename with the item kept selected) and the small
// controls around them (a checklist, the selectable list, a polite notice). ChannelsSection re-exports the ones Operations imports.
import type { ReactNode } from "react";
import { renameKey, type KeyKind } from "@/lib/events/document/keys";
import type { DocChannel, DocExternalRef, DocMessage, DocOperation, DocumentProblem, EventDocument } from "@/lib/events/document/types";
import type { DraftState } from "../use-event-draft";

// ── document helpers (pure) ─────────────────────────────────────────────────────────────────────────────────────────────

/** Channel-ish namespace of the document: local channels plus external channel references. */
export const allChannelKeys = (doc: EventDocument): string[] => [
  ...doc.channels.map((c) => c.key),
  ...doc.externalRefs.filter((r) => r.kind === "channel").map((r) => r.key),
];
/** Message-ish namespace of the document: local messages plus external message references. */
export const allMessageKeys = (doc: EventDocument): string[] => [
  ...doc.messages.map((m) => m.key),
  ...doc.externalRefs.filter((r) => r.kind === "message").map((r) => r.key),
];

/** What a channel is called in a list or a checklist: its title, else its address, else its (generated) key. */
export const channelLabel = (c: Pick<DocChannel, "key" | "title" | "address">): string => c.title?.trim() || c.address?.trim() || c.key;
/** What a message is called in a list or a checklist: its name, else its title, else its (generated) key. */
export const messageLabel = (m: Pick<DocMessage, "key" | "name" | "title">): string => m.name?.trim() || m.title?.trim() || m.key;

/** Operations that use `messageKey` on `channelKey`, as one of their own messages or as a reply sent on that channel. */
export function operationsUsingMessage(doc: EventDocument, channelKey: string, messageKey: string): DocOperation[] {
  return doc.operations.filter((o) =>
    (o.channelKey === channelKey && o.messageKeys.includes(messageKey))
    || (o.reply?.channelKey === channelKey && (o.reply.messageKeys ?? []).includes(messageKey)));
}

/**
 * Allow or disallow `messageKey` on `channelKey` (`channels[].messageKeys`). Disallowing is refused while an operation uses the
 * message on that channel: the result then names those operations and the document is left alone, so it never gains a
 * "message not allowed on channel" problem from this edit.
 */
export function setMessageAllowed(
  doc: EventDocument, channelKey: string, messageKey: string, allowed: boolean,
): { doc: EventDocument } | { blockedBy: DocOperation[] } {
  if (!allowed) {
    const blockedBy = operationsUsingMessage(doc, channelKey, messageKey);
    if (blockedBy.length > 0) return { blockedBy };
  }
  return {
    doc: {
      ...doc,
      channels: doc.channels.map((c) => {
        if (c.key !== channelKey) return c;
        if (allowed) return c.messageKeys.includes(messageKey) ? c : { ...c, messageKeys: [...c.messageKeys, messageKey] };
        return c.messageKeys.includes(messageKey) ? { ...c, messageKeys: c.messageKeys.filter((k) => k !== messageKey) } : c;
      }),
    },
  };
}

/** The sentence shown when `setMessageAllowed` refuses. */
export function blockedText(messageKey: string, channelKey: string, operations: DocOperation[]): string {
  const one = operations.length === 1;
  const names = operations.map((o) => `"${o.key}"`).join(", ");
  return `Cannot remove "${messageKey}" from channel "${channelKey}": ${one ? "operation" : "operations"} ${names} ${one ? "uses" : "use"} it. Remove it from ${one ? "that operation" : "those operations"} first.`;
}

/** `doc` without `messageKey` anywhere: channels, operations and operation replies. Untouched items keep their identity. */
export function withoutMessage(doc: EventDocument, messageKey: string): EventDocument {
  const dropFromOperation = (o: DocOperation): DocOperation => {
    const inOwn = o.messageKeys.includes(messageKey);
    const inReply = o.reply?.messageKeys?.includes(messageKey) ?? false;
    if (!inOwn && !inReply) return o;
    const next: DocOperation = { ...o, messageKeys: o.messageKeys.filter((k) => k !== messageKey) };
    if (o.reply?.messageKeys) next.reply = { ...o.reply, messageKeys: o.reply.messageKeys.filter((k) => k !== messageKey) };
    return next;
  };
  return {
    ...doc,
    channels: doc.channels.map((c) => (c.messageKeys.includes(messageKey) ? { ...c, messageKeys: c.messageKeys.filter((k) => k !== messageKey) } : c)),
    operations: doc.operations.map(dropFromOperation),
  };
}

/** `doc` without the operations on `channelKey`, and without the reply of an operation that answers on it (what removing a channel does). */
export function withoutChannel(doc: EventDocument, channelKey: string): EventDocument {
  return {
    ...doc,
    operations: doc.operations.filter((o) => o.channelKey !== channelKey).map((o) => {
      if (o.reply?.channelKey !== channelKey) return o;
      const next = { ...o };
      delete next.reply;
      return next;
    }),
  };
}

/**
 * Where the external reference `ref` is used: the operations that send / receive on it (a channel) or carry it (a message, own or in a
 * reply), and, for a message, the local channels that allow it. Nothing else can name an external key.
 */
export function externalRefUsage(doc: EventDocument, ref: Pick<DocExternalRef, "key" | "kind">): { operations: DocOperation[]; channels: DocChannel[] } {
  if (ref.kind === "channel") {
    return { channels: [], operations: doc.operations.filter((o) => o.channelKey === ref.key || o.reply?.channelKey === ref.key) };
  }
  return {
    channels: doc.channels.filter((c) => c.messageKeys.includes(ref.key)),
    operations: doc.operations.filter((o) => o.messageKeys.includes(ref.key) || (o.reply?.messageKeys ?? []).includes(ref.key)),
  };
}

/** `doc` without the external reference `key` and without every use of it, unless a local item still defines that key. Unknown key: `doc` itself. */
export function withoutExternalRef(doc: EventDocument, key: string): EventDocument {
  const ref = doc.externalRefs.find((r) => r.key === key);
  if (!ref) return doc;
  const next: EventDocument = { ...doc, externalRefs: doc.externalRefs.filter((r) => r.key !== key) };
  if (ref.kind === "channel") return next.channels.some((c) => c.key === key) ? next : withoutChannel(next, key);
  return next.messages.some((m) => m.key === key) ? next : withoutMessage(next, key);
}

/** Rename `from` to `to` through `renameKey` (references follow) and keep the item selected. Does nothing when the rename is refused. */
export function renameAndSelect(draft: DraftState, kind: KeyKind, from: string, to: string, onSelectItem: (key: string | null) => void) {
  if (!renameKey(draft.doc, kind, from, to).success) return;
  draft.update((d) => {
    const renamed = renameKey(d, kind, from, to);
    return renamed.success ? renamed.data : d;
  });
  onSelectItem(to);
}

export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** One RFC 6901 pointer segment: `~` and `/` escaped. */
export const pointerSegment = (name: string): string => name.replace(/~/g, "~0").replace(/\//g, "~1");

/**
 * `problems` with the first segment below `prefix` renamed: the document stores `serverKeys`, `messageKeys` and `traitKeys`, the AsyncAPI
 * templates call the same properties `servers`, `messages` and `traits`, and a form shows the problems found at its own field names.
 * `aliases` maps document property -> template field. Everything else is returned as it came.
 */
export function aliasPointers(problems: DocumentProblem[], prefix: string, aliases: Record<string, string>): DocumentProblem[] {
  return problems.map((p) => {
    if (!p.pointer.startsWith(`${prefix}/`)) return p;
    const [head, ...rest] = p.pointer.slice(prefix.length + 1).split("/");
    if (!Object.hasOwn(aliases, head)) return p;
    return { ...p, pointer: [`${prefix}/${aliases[head]}`, ...rest].join("/") };
  });
}

// ── controls ────────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface CheckOption { value: string; label: string }

/**
 * A labelled group of checkboxes (native). Keys that are checked but not offered (dangling references, or messages a channel no
 * longer allows) are still listed, marked with `strayLabel`, so the user can uncheck them. The group's error and hint are linked
 * with `aria-describedby`; every checkbox has the test id `${id}-option-${value}`.
 */
export function CheckboxGroup({ id, label, options, checked, onToggle, error, hint, empty, strayLabel = "not defined" }: {
  id: string; label: string; options: CheckOption[]; checked: string[]; onToggle: (value: string, next: boolean) => void;
  error?: string; hint?: string; empty?: string; strayLabel?: string;
}) {
  const offered = new Set(options.map((o) => o.value));
  const stray = [...new Set(checked)].filter((v) => !offered.has(v)).map((v): CheckOption => ({ value: v, label: `${v} (${strayLabel})` }));
  const all = [...options, ...stray];
  const errorId = `${id}-error`;
  const hintId = `${id}-hint`;
  const describedBy = [error ? errorId : null, hint ? hintId : null].filter(Boolean).join(" ") || undefined;
  return (
    <fieldset id={id} data-testid={id} aria-describedby={describedBy} className="space-y-space-2">
      <legend className="text-caption text-muted-foreground">{label}</legend>
      {all.length === 0 ? (
        empty && <p data-testid={`${id}-empty`} className="text-body-small text-muted-foreground">{empty}</p>
      ) : (
        <ul className="space-y-space-1">
          {all.map((o) => (
            <li key={o.value}>
              <label className="flex items-center gap-space-2 text-body-small text-foreground">
                <input
                  type="checkbox" data-testid={`${id}-option-${o.value}`} className="size-4 shrink-0 accent-primary"
                  checked={checked.includes(o.value)} onChange={(e) => onToggle(o.value, e.target.checked)}
                />
                <span>{o.label}</span>
              </label>
            </li>
          ))}
        </ul>
      )}
      {hint && <p id={hintId} data-testid={hintId} className="text-caption text-muted-foreground">{hint}</p>}
      {error && <p id={errorId} data-testid={errorId} className="text-body-small text-destructive">{error}</p>}
    </fieldset>
  );
}

/** A polite one-line explanation of something the section just did or refused (not a field error). */
export function Notice({ id, children }: { id: string; children: ReactNode }) {
  return (
    <p id={id} data-testid={id} role="status" className="rounded-md border border-warning/40 bg-warning/10 px-space-3 py-space-2 text-body-small text-foreground">
      {children}
    </p>
  );
}

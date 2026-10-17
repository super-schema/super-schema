// src/lib/events/external-refs.ts
// Client-safe types and pure helpers for the READ side of external event references (spec 2026-10-16 §5): what the picker lists
// and what the "newer version available" badge says. A reference points at an item (channel / message) of another event's
// PUBLISHED version; the item is found in that version's stored `resolvedSpec` by id (= the reference's `itemKey`), exactly as
// `externalItems` (event-snapshot) and `validateDocumentRefs` (event.service) read it.
import { isJsonObject } from "./inputs";
import type { JsonObject } from "@/lib/event-specs/types";

/** A published event the picker offers: its latest version carries a resolved spec. */
export interface ExternalEventCandidate { eventId: string; eventName: string; domainName: string; productName: string; latestVersionId: string; latestLabel: string }
/** A version of one event that can be referenced (only versions that have a resolvedSpec). */
export interface ExternalVersionOption { versionId: string; label: string; publishedAt: string }
export interface ExternalItemSummary { key: string; title?: string; summary?: string; description?: string }
export interface ExternalVersionItems { eventName: string; label: string; channels: ExternalItemSummary[]; messages: ExternalItemSummary[] }
export interface ExternalRefStatus {
  eventVersionId: string; eventId: string; eventName: string; label: string;
  latestVersionId: string; latestLabel: string;
  newerAvailable: boolean; newerIsMajor: boolean;
  /** Items the reference points at that the latest version no longer has (keys). */
  itemsMissingInLatest: string[];
}

export type ExternalItemKind = "channel" | "message";
/** What the status loader needs to know about one reference of a document: which item of which published version. */
export interface ExternalRefInput { eventVersionId: string; kind: ExternalItemKind; itemKey: string }

/** True when `latest` is a later version than `current` (versions are `MAJOR.MINOR`; compared as numbers, so 1.9 < 1.10). */
export function isNewerVersion(current: { major: number; minor: number }, latest: { major: number; minor: number }): boolean {
  return latest.major !== current.major ? latest.major > current.major : latest.minor > current.minor;
}

/**
 * THE rule for whether a stored `resolvedSpec` entry can be referenced, shared by every reader (the picker through
 * `externalItemSummaries`, save validation, the snapshot's `externalItems` and the status badge through `referenceableItems`):
 * an object with a string `id` that has the shape the assembler needs. A channel needs a `profile` object; a message needs a
 * `payloads` array and a `traitRefs` array of strings. A corrupt item is therefore never offered, never accepted on save and
 * never resolved, instead of crashing the assembler later.
 */
export function isReferenceableItem(kind: ExternalItemKind, item: unknown): boolean {
  if (!isJsonObject(item) || typeof item.id !== "string") return false;
  if (kind === "channel") return isJsonObject(item.profile);
  return Array.isArray(item.payloads) && Array.isArray(item.traitRefs) && item.traitRefs.every((id) => typeof id === "string");
}

/**
 * The referenceable channels or messages of a stored `resolvedSpec`, by id. When an id repeats, the FIRST entry that has a string id
 * is the item (the later ones are ignored even if the first is corrupt, so every reader agrees on which entry an id means); an
 * entry that is not `isReferenceableItem` is left out. `null` when there is no usable resolved spec (NULL column, not a JSON
 * object), which is what `validateDocumentRefs` calls "cannot be referenced"; an object without the array is an empty map.
 */
export function referenceableItems(resolvedSpec: unknown, kind: ExternalItemKind): Map<string, JsonObject> | null {
  if (!isJsonObject(resolvedSpec)) return null;
  const items = new Map<string, JsonObject>();
  const entries = resolvedSpec[kind === "channel" ? "channels" : "messages"];
  if (!Array.isArray(entries)) return items;
  const seen = new Set<string>();
  for (const entry of entries) {
    if (!isJsonObject(entry) || typeof entry.id !== "string" || seen.has(entry.id)) continue;
    seen.add(entry.id);
    if (isReferenceableItem(kind, entry)) items.set(entry.id, entry);
  }
  return items;
}

/**
 * The channels or messages of a stored `resolvedSpec` that can be referenced (`referenceableItems`), one summary each; a title /
 * summary / description that is not a string is left out. `null` when there is no usable resolved spec.
 */
export function externalItemSummaries(resolvedSpec: unknown, kind: ExternalItemKind): ExternalItemSummary[] | null {
  const items = referenceableItems(resolvedSpec, kind);
  if (items === null) return null;
  return [...items.values()].map((entry) => {
    const summary: ExternalItemSummary = { key: entry.id as string };
    for (const field of ["title", "summary", "description"] as const) {
      const text = entry[field];
      if (typeof text === "string") summary[field] = text;
    }
    return summary;
  });
}

/**
 * Keys (once each, in reference order) of the referenced items that `resolvedSpec` does not hold: a channel is looked up among
 * the channels and a message among the messages. Without a usable spec every referenced item counts as missing.
 */
export function missingItemKeys(resolvedSpec: unknown, refs: ReadonlyArray<{ kind: ExternalItemKind; itemKey: string }>): string[] {
  const keysOf = (kind: ExternalItemKind) => new Set((externalItemSummaries(resolvedSpec, kind) ?? []).map((item) => item.key));
  const present = { channel: keysOf("channel"), message: keysOf("message") };
  return [...new Set(refs.filter((ref) => !present[ref.kind].has(ref.itemKey)).map((ref) => ref.itemKey))];
}

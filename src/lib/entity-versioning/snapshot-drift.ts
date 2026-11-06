// src/lib/entity-versioning/snapshot-drift.ts
// The rules a save and a promote of an entity or an event share about a snapshot and what it references: when a referenced version
// "changed since" this snapshot was saved, how the open snapshot is compared between an unlocked read and the row lock, and the
// retryable failure when another save or promote landed in between. Pure, client-safe.
import type { VersionNumber } from "./types";
import { formatVersionLabel } from "./version-math";

/**
 * A referenced version was saved again AFTER `base` (the snapshot that references it) was saved: a snapshot updated in place, so its
 * content is no longer what `base` was checked / rendered against. False when either side is unknown.
 */
export function savedSince(target: { publishedAt: Date } | null | undefined, base: { publishedAt: Date } | null | undefined): boolean {
  return !!target && !!base && target.publishedAt.getTime() > base.publishedAt.getTime();
}

/** The open snapshot as one comparable value: which row, at which number, last written when ("-": none open). */
export function snapshotKey(snapshot: (VersionNumber & { id: string }) | null | undefined, updatedAt: Date | null | undefined): string {
  return snapshot ? `${snapshot.id}@${formatVersionLabel(snapshot)}@${updatedAt?.getTime() ?? ""}` : "-";
}

/** When each referenced version's content was last saved, by id: compared between a save's unlocked render and its locked write. */
export function savedStamps(rows: ReadonlyArray<{ id: string; publishedAt: Date }>): Record<string, number> {
  return Object.fromEntries([...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).map((r) => [r.id, r.publishedAt.getTime()]));
}

/** Another save or promote committed between what the caller decided on and the row lock: retryable. */
export function versionsMoved(subject: "entity" | "event"): { code: "CONFLICT"; message: string; suggestedFix: string } {
  return {
    code: "CONFLICT",
    message: `Another save or promote of this ${subject} completed first, try again.`,
    suggestedFix: `Reload the ${subject} and try again.`,
  };
}

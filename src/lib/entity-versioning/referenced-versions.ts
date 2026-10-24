/**
 * What a publish records about the entities it referenced, and the staleness derived from it (multi-entity emission, Task 8).
 * Pure and client-safe: no server imports.
 *
 * Publishing X records, for every entity in X's reference closure (X itself aside), the exact MAJOR.MINOR version the closure used:
 * the version a field PINNED, otherwise the latest published version at publish time. The record lives in the version's
 * `compatReport` JSON under the key `referencedVersions` (see {@link referencedVersionsReport}); it needs no column. It is read back
 * by {@link readReferencedVersions}; a version published before this existed simply has none recorded.
 */

import type { EntityRef } from "@/lib/references/entity-reference";
import { parseVersionLabel } from "./version-math";

/** One entity a published version used: who it is, which version of it, and whether a field pinned that version. */
export type ReferencedVersion = { ref: EntityRef; version: string; pinned: boolean };

/** An unpinned reference that is behind: `recorded` is what the published version used, `latest` what is published now. */
export type ReferenceStaleness = { ref: EntityRef; recorded: string; latest: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function readRef(value: unknown): EntityRef | undefined {
  if (!isRecord(value)) return undefined;
  const { domain, product, entity, entityId } = value;
  if (typeof domain !== "string" || typeof product !== "string" || typeof entity !== "string") return undefined;
  if (entityId !== undefined && typeof entityId !== "string") return undefined;
  return { ...(entityId !== undefined ? { entityId } : {}), domain, product, entity };
}

/**
 * The versions a publish recorded, from the stored `compatReport`. Tolerant on purpose: anything that is not a well-formed record
 * (a version published before references were recorded, `{}`, a hand-edited row) reads as nothing recorded, and one malformed entry
 * does not hide the good ones.
 */
export function readReferencedVersions(compatReport: unknown): ReferencedVersion[] {
  if (!isRecord(compatReport) || !Array.isArray(compatReport.referencedVersions)) return [];
  const read: ReferencedVersion[] = [];
  for (const raw of compatReport.referencedVersions) {
    if (!isRecord(raw) || typeof raw.version !== "string" || typeof raw.pinned !== "boolean") continue;
    const ref = readRef(raw.ref);
    if (ref) read.push({ ref, version: raw.version, pinned: raw.pinned });
  }
  return read;
}

/** The `compatReport` a publish stores: the recorded versions under their key (the column is otherwise `{}` until compatibility findings land). */
export function referencedVersionsReport(referencedVersions: readonly ReferencedVersion[]): { referencedVersions: ReferencedVersion[] } {
  return { referencedVersions: referencedVersions.map((r) => ({ ref: { ...r.ref }, version: r.version, pinned: r.pinned })) };
}

/** `latest` is strictly newer than `recorded` (numbers, not text: 1.10 is newer than 1.9). Unparsable labels are never newer. */
function isNewer(latest: string, recorded: string): boolean {
  const a = parseVersionLabel(latest);
  const b = parseVersionLabel(recorded);
  if (!a.success || !b.success) return false;
  return a.data.major !== b.data.major ? a.data.major > b.data.major : a.data.minor > b.data.minor;
}

/**
 * The references of a published version that have fallen behind: an UNPINNED reference whose entity now has a newer published version
 * than the one recorded. A pinned reference is never stale (the pin is the point). `latestPublished` maps an entity id to the label of
 * its latest published version; an entity missing from it (deleted, never published) and a reference recorded without an id are
 * skipped: there is nothing to compare. Order is the order the versions were recorded in.
 */
export function referenceStaleness(
  version: { referencedVersions: readonly ReferencedVersion[] },
  latestPublished: ReadonlyMap<string, string>
): ReferenceStaleness[] {
  const stale: ReferenceStaleness[] = [];
  for (const recorded of version.referencedVersions) {
    if (recorded.pinned || !recorded.ref.entityId) continue;
    const latest = latestPublished.get(recorded.ref.entityId);
    if (latest !== undefined && isNewer(latest, recorded.version)) {
      stale.push({ ref: recorded.ref, recorded: recorded.version, latest });
    }
  }
  return stale;
}

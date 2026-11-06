/** Entity versioning value types (spec §5). Client-safe: no server imports. */

export type BumpKind = "MAJOR" | "MINOR" | "PATCH";
export type ChangeKind = BumpKind | "INITIAL";

/** SNAPSHOT is mutable (`x.y.z_snapshot`); RELEASED is frozen (`x.y.z`). */
export type VersionStage = "SNAPSHOT" | "RELEASED";

export interface VersionNumber {
  major: number;
  minor: number;
  patch: number;
}

/** What the user chooses in the publish dialog. `bump` is ignored on a first publish (always 1.0.0). */
export interface PublishInput {
  bump?: BumpKind;
  changeSummary?: string;
}

/** The longest change summary (after trimming) an entity or an event publish accepts: the text lands in an immutable version row and audit entry. */
export const MAX_CHANGE_SUMMARY = 500;

/** A published version without its (large) frozen source and field snapshot. */
export interface EntityVersionSummary {
  id: string;
  entityId: string;
  major: number;
  minor: number;
  patch: number;
  stage: VersionStage;
  /** "2.1.0" or "2.1.0_snapshot" */
  label: string;
  sequence: number;
  changeKind: ChangeKind;
  changeSummary: string | null;
  publishedById: string;
  publishedByName: string | null;
  /** ISO-8601 */
  publishedAt: string;
  /** ISO-8601; null while a snapshot */
  releasedAt: string | null;
}

export function isBumpKind(value: unknown): value is BumpKind {
  return value === "MAJOR" || value === "MINOR" || value === "PATCH";
}

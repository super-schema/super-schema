/** Entity versioning value types (spec §5). Client-safe: no server imports. */

export type BumpKind = "MAJOR" | "MINOR";
export type ChangeKind = BumpKind | "INITIAL";

export interface VersionNumber {
  major: number;
  minor: number;
}

/** What the user chooses in the publish dialog. `bump` is ignored on a first publish (always 1.0). */
export interface PublishInput {
  bump?: BumpKind;
  changeSummary?: string;
}

/** A published version without its (large) frozen source and field snapshot. */
export interface EntityVersionSummary {
  id: string;
  entityId: string;
  major: number;
  minor: number;
  /** "2.1" */
  label: string;
  sequence: number;
  changeKind: ChangeKind;
  changeSummary: string | null;
  publishedById: string;
  publishedByName: string | null;
  /** ISO-8601 */
  publishedAt: string;
}

export function isBumpKind(value: unknown): value is BumpKind {
  return value === "MAJOR" || value === "MINOR";
}

import type { ChangeKind, VersionStage } from "@/lib/entity-versioning/types";
import { formatVersionLabel } from "@/lib/entity-versioning/version-math";
import type { EventVersionSummary } from "@/lib/events/types";

/** The EventSpecVersion columns a summary is built from. */
export const VERSION_SUMMARY_SELECT = {
  id: true, major: true, minor: true, patch: true, stage: true, sequence: true, changeKind: true, changeSummary: true, publishedAt: true,
  releasedAt: true, publishedBy: { select: { name: true } },
} as const;

export interface VersionSummaryRow {
  id: string;
  major: number;
  minor: number;
  patch: number;
  stage: VersionStage;
  sequence: number;
  changeKind: ChangeKind;
  changeSummary: string | null;
  publishedAt: Date;
  releasedAt: Date | null;
  publishedBy: { name: string | null };
}

export function toEventVersionSummary(row: VersionSummaryRow): EventVersionSummary {
  return {
    id: row.id, major: row.major, minor: row.minor, patch: row.patch, stage: row.stage, label: formatVersionLabel(row, row.stage),
    sequence: row.sequence, changeKind: row.changeKind, changeSummary: row.changeSummary, publishedByName: row.publishedBy.name,
    publishedAt: row.publishedAt.toISOString(), releasedAt: row.releasedAt ? row.releasedAt.toISOString() : null,
  };
}

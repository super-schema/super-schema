import type { ChangeKind } from "@/lib/entity-versioning/types";
import { formatVersionLabel } from "@/lib/entity-versioning/version-math";
import type { EventVersionSummary } from "@/lib/events/types";

/** Shared by MessageVersion and EventSpecVersion selects (same column names). */
export const VERSION_SUMMARY_SELECT = {
  id: true, major: true, minor: true, sequence: true, changeKind: true, changeSummary: true, publishedAt: true,
  publishedBy: { select: { name: true } },
} as const;

export interface VersionSummaryRow {
  id: string;
  major: number;
  minor: number;
  sequence: number;
  changeKind: ChangeKind;
  changeSummary: string | null;
  publishedAt: Date;
  publishedBy: { name: string | null };
}

export function toEventVersionSummary(row: VersionSummaryRow): EventVersionSummary {
  return {
    id: row.id, major: row.major, minor: row.minor, label: formatVersionLabel(row), sequence: row.sequence,
    changeKind: row.changeKind, changeSummary: row.changeSummary, publishedByName: row.publishedBy.name,
    publishedAt: row.publishedAt.toISOString(),
  };
}

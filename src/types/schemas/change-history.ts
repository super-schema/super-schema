/**
 * Change History Types & Schemas
 *
 * Unified timeline types for merging version snapshots and audit log entries.
 */

import type { ChangeRecord } from "@/services/version-history/version.types";

/** The type of change represented by a timeline entry */
export type ChangeType =
  | "version"
  | "field_edit"
  | "decorator_change"
  | "status_change"
  | "emission"
  | "governance"
  | "other";

/** A single unified timeline entry combining version and audit data */
export interface TimelineEntry {
  id: string;
  timestamp: string;
  entryType: "version" | "audit";
  changeType: ChangeType;
  summary: string;
  userId: string;
  userName?: string;
  userAvatar?: string;
  /** Version number, only present for version entries */
  versionNumber?: number;
  /** Change record, only present for version entries */
  changeRecord?: ChangeRecord | null;
  /** Audit action, only present for audit entries */
  action?: string;
  /** Entity type from audit log */
  entityType?: string;
  /** Raw metadata for extensibility */
  metadata?: Record<string, unknown>;
}

/** Filters for querying change history */
export interface ChangeHistoryFilters {
  changeTypes?: ChangeType[];
  userId?: string;
  dateFrom?: Date;
  dateTo?: Date;
}

/** Paginated change history response */
export interface ChangeHistoryPage {
  entries: TimelineEntry[];
  hasMore: boolean;
  nextCursor?: string;
  totalCount?: number;
}

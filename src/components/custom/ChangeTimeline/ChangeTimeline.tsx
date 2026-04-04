"use client";

import { useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  GitBranch,
  FileEdit,
  Palette,
  ArrowRightLeft,
  Zap,
  Shield,
  Clock,
  Plus,
  Pencil,
  Trash2,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { TimelineEntry, ChangeType } from "@/types/schemas/change-history";

// --- Utility: relative time ---

function relativeTime(timestamp: string): string {
  const now = Date.now();
  const then = new Date(timestamp).getTime();
  const diffMs = now - then;
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHr = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHr / 24);

  if (diffSec < 60) return "just now";
  if (diffMin < 60) return `${diffMin} minute${diffMin !== 1 ? "s" : ""} ago`;
  if (diffHr < 24) return `${diffHr} hour${diffHr !== 1 ? "s" : ""} ago`;
  if (diffDay < 30) return `${diffDay} day${diffDay !== 1 ? "s" : ""} ago`;

  return new Date(timestamp).toLocaleDateString();
}

function absoluteTime(timestamp: string): string {
  return new Date(timestamp).toLocaleString();
}

// --- Icons by change type ---

const CHANGE_TYPE_ICON: Record<ChangeType, React.ReactNode> = {
  version: <GitBranch className="w-4 h-4" />,
  field_edit: <FileEdit className="w-4 h-4" />,
  decorator_change: <Palette className="w-4 h-4" />,
  status_change: <ArrowRightLeft className="w-4 h-4" />,
  emission: <Zap className="w-4 h-4" />,
  governance: <Shield className="w-4 h-4" />,
  other: <Clock className="w-4 h-4" />,
};

const CHANGE_TYPE_COLOR: Record<ChangeType, string> = {
  version: "text-blue-400",
  field_edit: "text-amber-400",
  decorator_change: "text-purple-400",
  status_change: "text-emerald-400",
  emission: "text-cyan-400",
  governance: "text-red-400",
  other: "text-muted-foreground",
};

// --- Action icon for audit entries ---

function ActionIcon({ action }: { action?: string }) {
  if (!action) return null;
  const a = action.toUpperCase();
  if (a === "CREATE" || a.includes("ADD"))
    return <Plus className="w-3 h-3 text-emerald-400" />;
  if (a === "UPDATE" || a.includes("EDIT"))
    return <Pencil className="w-3 h-3 text-amber-400" />;
  if (a === "DELETE" || a.includes("REMOVE"))
    return <Trash2 className="w-3 h-3 text-red-400" />;
  return null;
}

// --- User avatar ---

function UserAvatar({
  userId,
  userName,
}: {
  userId: string;
  userName?: string;
}) {
  const initial = (userName || userId || "?")[0].toUpperCase();
  return (
    <div
      className="w-6 h-6 rounded-full bg-muted flex items-center justify-center text-caption font-medium text-muted-foreground shrink-0"
      title={userName || userId}
    >
      {initial}
    </div>
  );
}

// --- Version Entry (larger card) ---

function VersionEntry({
  entry,
  onViewDiff,
}: {
  entry: TimelineEntry;
  onViewDiff?: (versionNumber: number) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const changeRecord = entry.changeRecord;
  const hasChanges =
    changeRecord && changeRecord.changes && changeRecord.changes.length > 0;

  return (
    <div
      className="rounded-xl border border-border/50 p-space-4 cursor-pointer transition-colors hover:border-border/80"
      style={{ backgroundColor: "rgba(28, 28, 38, 0.8)" }}
      data-testid={`timeline-version-${entry.versionNumber}`}
      onClick={() => {
        if (onViewDiff && entry.versionNumber && entry.versionNumber > 1) {
          onViewDiff(entry.versionNumber);
        }
      }}
    >
      <div className="flex items-start justify-between gap-space-3">
        <div className="flex items-center gap-space-3">
          <div className={`${CHANGE_TYPE_COLOR.version}`}>
            {CHANGE_TYPE_ICON.version}
          </div>
          <Badge variant="secondary" className="font-mono text-[13px]">
            v{entry.versionNumber}
          </Badge>
          <span className="text-body-small text-foreground font-medium">
            {entry.summary}
          </span>
        </div>

        <div className="flex items-center gap-space-2 shrink-0">
          <UserAvatar userId={entry.userId} userName={entry.userName} />
          <span
            className="text-caption text-muted-foreground"
            title={absoluteTime(entry.timestamp)}
          >
            {relativeTime(entry.timestamp)}
          </span>
        </div>
      </div>

      {/* Expandable change record */}
      {hasChanges && (
        <div className="mt-space-3">
          <button
            className="flex items-center gap-1 text-caption text-muted-foreground hover:text-foreground transition-colors"
            onClick={(e) => {
              e.stopPropagation();
              setExpanded(!expanded);
            }}
            data-testid={`expand-version-${entry.versionNumber}`}
          >
            {expanded ? (
              <ChevronDown className="w-3 h-3" />
            ) : (
              <ChevronRight className="w-3 h-3" />
            )}
            {expanded ? "Collapse" : "Expand"} change record
          </button>

          {expanded && (
            <div
              className="mt-space-2 space-y-1 pl-4"
              data-testid={`change-record-${entry.versionNumber}`}
            >
              {changeRecord!.changes.map((change, idx) => (
                <div
                  key={idx}
                  className="flex items-center gap-space-2 text-caption"
                >
                  <Badge
                    variant={
                      change.type === "added"
                        ? "success"
                        : change.type === "removed"
                          ? "destructive"
                          : "warning"
                    }
                    className="text-[11px] px-1.5 py-0"
                  >
                    {change.type}
                  </Badge>
                  <span className="font-mono text-[13px] text-foreground">
                    {change.fieldName}
                  </span>
                  {change.details.changedProperties.length > 0 && (
                    <span className="text-muted-foreground">
                      ({change.details.changedProperties.join(", ")})
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// --- Audit Entry (compact line) ---

function AuditEntry({ entry }: { entry: TimelineEntry }) {
  return (
    <div
      className="flex items-center gap-space-3 px-space-3 py-space-2 rounded-lg hover:bg-muted/30 transition-colors"
      data-testid={`timeline-audit-${entry.id}`}
    >
      <div className={`${CHANGE_TYPE_COLOR[entry.changeType]} shrink-0`}>
        {CHANGE_TYPE_ICON[entry.changeType]}
      </div>

      <ActionIcon action={entry.action} />

      <span className="text-body-small text-muted-foreground flex-1 min-w-0 truncate">
        {entry.summary}
      </span>

      <UserAvatar userId={entry.userId} userName={entry.userName} />

      <span
        className="text-caption text-muted-foreground shrink-0"
        title={absoluteTime(entry.timestamp)}
      >
        {relativeTime(entry.timestamp)}
      </span>
    </div>
  );
}

// --- Main ChangeTimeline ---

export interface ChangeTimelineProps {
  entries: TimelineEntry[];
  hasMore: boolean;
  isLoadingMore?: boolean;
  onLoadMore?: () => void;
  onViewDiff?: (versionNumber: number) => void;
}

export function ChangeTimeline({
  entries,
  hasMore,
  isLoadingMore,
  onLoadMore,
  onViewDiff,
}: ChangeTimelineProps) {
  if (entries.length === 0) {
    return (
      <div
        className="flex flex-col items-center justify-center py-16 text-center"
        data-testid="timeline-empty"
      >
        <Clock className="w-10 h-10 text-muted-foreground/30 mb-space-3" />
        <p className="text-body text-muted-foreground mb-1">
          No change history yet
        </p>
        <p className="text-body-small text-muted-foreground/60">
          Changes will appear here as you edit fields and create versions.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-space-2" data-testid="change-timeline">
      {/* Timeline connector line */}
      <div className="relative">
        <div className="absolute left-[19px] top-0 bottom-0 w-px bg-border/30" />

        <div className="space-y-space-2 relative">
          {entries.map((entry) => (
            <div key={entry.id} className="relative pl-10">
              {/* Timeline dot */}
              <div
                className={`absolute left-[16px] top-3 w-[7px] h-[7px] rounded-full border-2 border-background ${
                  entry.entryType === "version"
                    ? "bg-blue-400"
                    : "bg-muted-foreground/50"
                }`}
              />

              {entry.entryType === "version" ? (
                <VersionEntry entry={entry} onViewDiff={onViewDiff} />
              ) : (
                <AuditEntry entry={entry} />
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Load More */}
      {hasMore && (
        <div className="flex justify-center pt-space-4">
          <Button
            variant="ghost"
            onClick={onLoadMore}
            disabled={isLoadingMore}
            data-testid="load-more-button"
          >
            {isLoadingMore ? "Loading..." : "Load More"}
          </Button>
        </div>
      )}
    </div>
  );
}

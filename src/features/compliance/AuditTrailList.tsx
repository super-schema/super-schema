"use client";

import { useState } from "react";
import { ChevronDown, ChevronRight, ChevronLeft } from "lucide-react";
import { AuditDiffViewer } from "./AuditDiffViewer";
import type { AuditTrailEntry } from "@/types/schemas/compliance";

const ACTION_COLORS: Record<string, string> = {
  CREATE: "bg-green-500/20 text-green-400",
  UPDATE: "bg-blue-500/20 text-blue-400",
  DELETE: "bg-red-500/20 text-red-400",
  REORDER: "bg-purple-500/20 text-purple-400",
  "annotation.create": "bg-cyan-500/20 text-cyan-400",
  "annotation.resolve": "bg-emerald-500/20 text-emerald-400",
  "compliance.query": "bg-indigo-500/20 text-indigo-400",
  "compliance.export": "bg-violet-500/20 text-violet-400",
};

function formatTimestamp(date: Date): string {
  return new Date(date).toLocaleString("en-US", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function relativeTime(date: Date): string {
  const now = Date.now();
  const diff = now - new Date(date).getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

interface AuditTrailListProps {
  entries: AuditTrailEntry[];
  total: number;
  page: number;
  pageSize: number;
  onPageChange: (page: number) => void;
  loading: boolean;
}

export function AuditTrailList({
  entries,
  total,
  page,
  pageSize,
  onPageChange,
  loading,
}: AuditTrailListProps) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const totalPages = Math.ceil(total / pageSize);

  const toggleExpand = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  if (loading) {
    return (
      <div className="flex-1 p-space-4">
        {Array.from({ length: 5 }).map((_, i) => (
          <div
            key={i}
            className="h-16 bg-muted rounded-lg animate-pulse mb-space-2"
          />
        ))}
      </div>
    );
  }

  if (entries.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted-foreground text-body-small">
        No audit entries match the current filters.
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden" data-testid="audit-trail-list">
      <div className="flex-1 overflow-y-auto p-space-4 flex flex-col gap-space-2">
        {entries.map((entry) => {
          const isExpanded = expanded.has(entry.id);
          return (
            <div
              key={entry.id}
              data-testid="audit-entry"
              data-action={entry.action}
              data-entity-type={entry.entityType}
              data-entity-id={entry.entityId}
              className="surface-1 border border-border rounded-lg overflow-hidden"
            >
              {/* Header row */}
              <div
                className="flex items-center gap-space-3 px-space-4 py-space-3 cursor-pointer hover:bg-accent/30 transition-colors"
                onClick={() => toggleExpand(entry.id)}
              >
                {isExpanded ? (
                  <ChevronDown className="w-4 h-4 text-muted-foreground shrink-0" />
                ) : (
                  <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" />
                )}

                {/* Timestamp */}
                <span
                  className="text-caption text-muted-foreground shrink-0 w-36 font-mono"
                  title={relativeTime(entry.timestamp)}
                >
                  {formatTimestamp(entry.timestamp)}
                </span>

                {/* User */}
                <span className="text-body-small text-foreground shrink-0 w-28 truncate">
                  {entry.userName || "System"}
                </span>

                {/* Action badge */}
                <span
                  className={`inline-block px-1.5 py-0.5 rounded text-caption font-medium shrink-0 ${ACTION_COLORS[entry.action] || "bg-muted text-muted-foreground"}`}
                >
                  {entry.action}
                </span>

                {/* Entity type */}
                <span className="text-caption text-muted-foreground shrink-0 w-16">
                  {entry.entityType}
                </span>

                {/* Change summary */}
                <span className="text-body-small text-muted-foreground flex-1 truncate">
                  {entry.changeSummary}
                </span>
              </div>

              {/* Expanded diff view */}
              {isExpanded && (
                <div className="border-t border-border px-space-4 py-space-3">
                  <AuditDiffViewer
                    beforeState={entry.beforeState}
                    afterState={entry.afterState}
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between px-space-4 py-space-2 border-t border-border">
          <span className="text-caption text-muted-foreground">
            Page {page} of {totalPages} ({total} entries)
          </span>
          <div className="flex items-center gap-space-2">
            <button
              disabled={page <= 1}
              onClick={() => onPageChange(page - 1)}
              className="p-1 rounded hover:bg-accent/50 disabled:opacity-30 disabled:cursor-not-allowed"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            <button
              disabled={page >= totalPages}
              onClick={() => onPageChange(page + 1)}
              className="p-1 rounded hover:bg-accent/50 disabled:opacity-30 disabled:cursor-not-allowed"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

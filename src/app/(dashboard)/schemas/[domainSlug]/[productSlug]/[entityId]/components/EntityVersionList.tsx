"use client";

import { Badge } from "@/components/ui/badge";
import { formatDateTime } from "@/lib/date-format";
import type { EntityVersionSummary } from "@/lib/entity-versioning/types";

interface EntityVersionListProps {
  /** Newest first (as returned by listEntityVersionsAction). */
  versions: EntityVersionSummary[];
}

export function EntityVersionList({ versions }: EntityVersionListProps) {
  if (versions.length === 0) {
    return (
      <p className="text-body-small text-muted-foreground" data-testid="entity-version-list-empty">
        Not published yet. Publish to cut version 1.0.
      </p>
    );
  }
  return (
    <ul className="space-y-space-2" data-testid="entity-version-list">
      {versions.map((v) => (
        <li
          key={v.id}
          className="flex items-center justify-between gap-space-3 rounded-lg border border-border/50 px-space-4 py-space-3"
        >
          <div className="flex min-w-0 items-center gap-space-3">
            <span className="font-mono text-body-small font-medium text-foreground">v{v.label}</span>
            <Badge variant="secondary">{v.changeKind}</Badge>
            {v.changeSummary && <span className="truncate text-caption text-muted-foreground">{v.changeSummary}</span>}
          </div>
          <span className="shrink-0 text-caption text-muted-foreground">
            {v.publishedByName ?? "Unknown"} · {formatDateTime(v.publishedAt)}
          </span>
        </li>
      ))}
    </ul>
  );
}

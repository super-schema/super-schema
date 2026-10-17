"use client";

import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatDateTime } from "@/lib/date-format";
import type { EventVersionSummary } from "@/lib/events/types";

export function EventVersionList({
  versions, hrefFor, emptyText, onView, selectedLabel,
}: {
  /** Newest first. */
  versions: EventVersionSummary[];
  hrefFor?: (label: string) => string;
  emptyText: string;
  /** Adds a View button to every row; pressing it passes the row's label. */
  onView?: (label: string) => void;
  /** The label whose View button is pressed (the version being shown). */
  selectedLabel?: string | null;
}) {
  if (versions.length === 0) {
    return <p className="text-body-small text-muted-foreground" data-testid="event-version-list-empty">{emptyText}</p>;
  }
  return (
    <ul className="space-y-space-2" data-testid="event-version-list">
      {versions.map((v) => (
        <li key={v.id} className="flex items-center justify-between gap-space-3 rounded-lg border border-border/50 px-space-4 py-space-3">
          <div className="flex min-w-0 items-center gap-space-3">
            {hrefFor ? (
              <Link href={hrefFor(v.label)} className="font-mono text-body-small font-medium text-primary hover:underline">v{v.label}</Link>
            ) : (
              <span className="font-mono text-body-small font-medium text-foreground">v{v.label}</span>
            )}
            <Badge variant="secondary">{v.changeKind}</Badge>
            {v.changeSummary && <span className="truncate text-caption text-muted-foreground">{v.changeSummary}</span>}
          </div>
          <div className="flex shrink-0 items-center gap-space-3">
            <span className="text-caption text-muted-foreground">
              {v.publishedByName ?? "Unknown"} · {formatDateTime(v.publishedAt)}
            </span>
            {onView && (
              <Button
                type="button" size="xs" variant={selectedLabel === v.label ? "secondary" : "outline"} aria-pressed={selectedLabel === v.label}
                aria-label={`View v${v.label}`} data-testid={`event-version-view-${v.label}`} onClick={() => onView(v.label)}
              >
                View
              </Button>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}

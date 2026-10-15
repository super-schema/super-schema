"use client";

import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { formatDateTime } from "@/lib/date-format";
import type { EventVersionSummary } from "@/lib/events/types";

export function EventVersionList({
  versions, hrefFor, emptyText,
}: {
  /** Newest first. */
  versions: EventVersionSummary[];
  hrefFor?: (label: string) => string;
  emptyText: string;
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
          <span className="shrink-0 text-caption text-muted-foreground">
            {v.publishedByName ?? "Unknown"} · {formatDateTime(v.publishedAt)}
          </span>
        </li>
      ))}
    </ul>
  );
}

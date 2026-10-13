"use client";

import { Eye } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { SchemaVersion } from "../actions";
import { formatDateOnly } from "@/lib/date-format";

// ---------------------------------------------------------------------------
// Status badge
// ---------------------------------------------------------------------------

function StatusBadge({ status }: { status: SchemaVersion["status"] }) {
  const styles: Record<string, string> = {
    draft: "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400",
    published: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400",
    deployed: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400",
  };

  const labels: Record<string, string> = {
    draft: "Draft",
    published: "Published",
    deployed: "Deployed",
  };

  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${styles[status] ?? ""}`}
    >
      {labels[status] ?? status}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Relative time helper
// ---------------------------------------------------------------------------

function relativeTime(isoDate: string): string {
  return formatDateOnly(isoDate);
}

// ---------------------------------------------------------------------------
// SchemaVersionList
// ---------------------------------------------------------------------------

export { StatusBadge, relativeTime };

interface SchemaVersionListProps {
  versions: SchemaVersion[];
  activeVersion: number | null;
  onSelectVersion: (version: number | null) => void;
}

export function SchemaVersionList({
  versions,
  activeVersion,
  onSelectVersion,
}: SchemaVersionListProps) {
  return (
    <div>
      <h4 className="text-caption font-medium text-muted-foreground mb-space-2">
        Version History
      </h4>
      <div className="space-y-space-1">
        {versions.map((v) => {
          const label =
            v.status === "deployed"
              ? `Deployed ${relativeTime(v.deployedAt!)}`
              : v.status === "published"
                ? `Published ${relativeTime(v.publishedAt!)}`
                : `Generated ${relativeTime(v.generatedAt)}`;

          return (
            <div
              key={v.version}
              className={`flex items-center justify-between rounded-md px-space-3 py-space-2 text-caption transition-colors ${
                activeVersion === v.version
                  ? "bg-muted/40 border border-border/50"
                  : "hover:bg-muted/20"
              }`}
            >
              <div className="flex items-center gap-space-2">
                <span className="font-medium text-foreground">
                  v{v.version}
                </span>
                <StatusBadge status={v.status} />
                <span className="text-muted-foreground">{label}</span>
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-caption"
                onClick={() =>
                  onSelectVersion(
                    activeVersion === v.version ? null : v.version
                  )
                }
              >
                <Eye className="w-3 h-3 mr-1" />
                View
              </Button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

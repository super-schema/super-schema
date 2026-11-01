"use client";

import { useState, useCallback } from "react";
import { ChevronDown, ChevronRight, Clock, GitCompare, Loader2 } from "lucide-react";
import { VersioningIcon } from "@/components/icons/feature-icons";
import { Button } from "@/components/ui/button";
import type { VersionSnapshot, ChangeEntry } from "@/services/version-history/version.types";
import { summarizeChanges } from "@/lib/diff/field-diff";
import { formatDateOnly, formatDateTime } from "@/lib/date-format";

interface VersionHistoryPanelProps {
  versions: VersionSnapshot[];
  open: boolean;
  onClose: () => void;
  /** Called when user initiates a comparison between two versions */
  onCompare?: (versionA: number, versionB: number) => Promise<void>;
  /** Called when user clicks "View Diff" on a version to compare with previous */
  onViewDiff?: (version: number, previousVersion: number) => Promise<void>;
}

/** Format a relative time string from an ISO timestamp */
function relativeTime(isoTimestamp: string): string {
  return formatDateOnly(isoTimestamp);
}

function ChangeEntryRow({ entry }: { entry: ChangeEntry }) {
  const typeColors: Record<string, string> = {
    added: "text-emerald-400",
    removed: "text-red-400",
    modified: "text-amber-400",
  };
  const typeLabels: Record<string, string> = {
    added: "+",
    removed: "-",
    modified: "~",
  };

  return (
    <div className="flex items-start gap-2 py-1 text-body-small">
      <span
        className={`font-mono font-bold w-4 text-center shrink-0 ${typeColors[entry.type]}`}
      >
        {typeLabels[entry.type]}
      </span>
      <div className="min-w-0">
        <span className="font-mono text-foreground">{entry.fieldName}</span>
        {entry.type === "modified" && entry.details.changedProperties.length > 0 && (
          <span className="text-muted-foreground ml-1.5">
            ({entry.details.changedProperties.join(", ")})
          </span>
        )}
      </div>
    </div>
  );
}

function VersionItem({
  version,
  previousVersion,
  onViewDiff,
}: {
  version: VersionSnapshot;
  previousVersion?: number;
  onViewDiff?: (version: number, previousVersion: number) => Promise<void>;
}) {
  const [expanded, setExpanded] = useState(false);
  const changes = version.changeRecord?.changes ?? [];
  const summary =
    version.changeRecord ? summarizeChanges(changes) : "Initial version";

  return (
    <div className="border-b border-border/50 last:border-b-0">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-start gap-2 px-3 py-2.5 text-left hover:bg-accent/30 transition-colors"
      >
        <span className="mt-0.5 shrink-0 text-muted-foreground">
          {expanded ? (
            <ChevronDown className="w-3.5 h-3.5" />
          ) : (
            <ChevronRight className="w-3.5 h-3.5" />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <span className="font-mono text-body-small font-medium text-foreground">
              v{version.version}
            </span>
            <div className="flex items-center gap-1.5">
              {previousVersion != null && onViewDiff && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onViewDiff(version.version, previousVersion);
                  }}
                  className="text-muted-foreground hover:text-foreground transition-colors p-0.5 rounded hover:bg-accent/30"
                  title={`Compare v${previousVersion} → v${version.version}`}
                  data-testid={`view-diff-v${version.version}`}
                >
                  <GitCompare className="w-3.5 h-3.5" />
                </button>
              )}
              <span
                className="text-caption text-muted-foreground shrink-0"
                title={formatDateTime(version.timestamp)}
              >
                {relativeTime(version.timestamp)}
              </span>
            </div>
          </div>
          <p className="text-caption text-muted-foreground mt-0.5 truncate">
            {summary}
          </p>
          <p className="text-caption text-muted-foreground/70 mt-0.5">
            {version.snapshot.fields.length} field{version.snapshot.fields.length !== 1 ? "s" : ""}
          </p>
        </div>
      </button>

      {expanded && changes.length > 0 && (
        <div className="px-3 pb-2.5 pl-8">
          <div className="rounded-md border border-border/30 bg-background/50 px-2 py-1.5">
            {changes.map((entry, i) => (
              <ChangeEntryRow key={`${entry.fieldName}-${i}`} entry={entry} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function ComparisonMode({
  versions,
  onCompare,
  onCancel,
}: {
  versions: VersionSnapshot[];
  onCompare: (versionA: number, versionB: number) => Promise<void>;
  onCancel: () => void;
}) {
  const [versionA, setVersionA] = useState<number | "">(
    versions.length >= 2 ? versions[versions.length - 1].version : ""
  );
  const [versionB, setVersionB] = useState<number | "">(
    versions.length >= 1 ? versions[0].version : ""
  );
  const [isComparing, setIsComparing] = useState(false);

  const handleCompare = useCallback(async () => {
    if (versionA === "" || versionB === "") return;
    setIsComparing(true);
    try {
      await onCompare(versionA, versionB);
    } finally {
      setIsComparing(false);
    }
  }, [versionA, versionB, onCompare]);

  return (
    <div className="px-4 py-3 border-b border-border/50">
      <div className="space-y-space-2">
        <div className="flex items-center gap-2">
          <label className="text-caption text-muted-foreground w-16 shrink-0">Version A</label>
          <select
            value={versionA}
            onChange={(e) => setVersionA(e.target.value ? Number(e.target.value) : "")}
            className="flex-1 rounded-md border border-border bg-transparent px-2 py-1 text-body-small text-foreground focus:outline-none focus:border-ring"
            data-testid="version-a-select"
          >
            <option value="">Select...</option>
            {versions.map((v) => (
              <option key={v.version} value={v.version}>
                v{v.version}
              </option>
            ))}
          </select>
        </div>
        <div className="flex items-center gap-2">
          <label className="text-caption text-muted-foreground w-16 shrink-0">Version B</label>
          <select
            value={versionB}
            onChange={(e) => setVersionB(e.target.value ? Number(e.target.value) : "")}
            className="flex-1 rounded-md border border-border bg-transparent px-2 py-1 text-body-small text-foreground focus:outline-none focus:border-ring"
            data-testid="version-b-select"
          >
            <option value="">Select...</option>
            {versions.map((v) => (
              <option key={v.version} value={v.version}>
                v{v.version}
              </option>
            ))}
          </select>
        </div>
        <div className="flex items-center gap-2 pt-1">
          <Button
            size="sm"
            variant="secondary"
            onClick={handleCompare}
            disabled={versionA === "" || versionB === "" || versionA === versionB || isComparing}
            data-testid="compare-button"
          >
            {isComparing ? (
              <>
                <Loader2 className="w-3.5 h-3.5 animate-spin mr-1" />
                Comparing...
              </>
            ) : (
              <>
                <GitCompare className="w-3.5 h-3.5 mr-1" />
                Compare
              </>
            )}
          </Button>
          <Button size="sm" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </div>
    </div>
  );
}

export function VersionHistoryPanel({
  versions,
  open,
  onClose,
  onCompare,
  onViewDiff,
}: VersionHistoryPanelProps) {
  const [compareMode, setCompareMode] = useState(false);

  if (!open) return null;

  // Build a map of version → previous version number for "View Diff" buttons
  const sortedVersions = [...versions].sort((a, b) => a.version - b.version);
  const previousVersionMap = new Map<number, number>();
  for (let i = 1; i < sortedVersions.length; i++) {
    previousVersionMap.set(sortedVersions[i].version, sortedVersions[i - 1].version);
  }

  return (
    <div
      className="fixed right-0 top-0 bottom-0 w-[360px] z-40 border-l border-border shadow-lg"
      style={{
        background: "rgba(28, 28, 38, 0.8)",
        backdropFilter: "blur(12px)",
        animation: "slideInRight 0.3s cubic-bezier(0.34, 1.56, 0.64, 1)",
      }}
      data-testid="version-history-panel"
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border/50">
        <div className="flex items-center gap-2">
          <VersioningIcon className="w-4 h-4 text-muted-foreground" />
          <h3 className="text-body font-medium text-foreground">
            Version History
          </h3>
        </div>
        <div className="flex items-center gap-1.5">
          {onCompare && versions.length >= 2 && !compareMode && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setCompareMode(true)}
              className="gap-1 text-xs h-7"
              data-testid="enter-compare-mode"
            >
              <GitCompare className="w-3.5 h-3.5" />
              Compare
            </Button>
          )}
          <button
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground transition-colors text-body-small px-1.5 py-0.5 rounded hover:bg-accent/30"
          >
            Close
          </button>
        </div>
      </div>

      {/* Comparison mode controls */}
      {compareMode && onCompare && (
        <ComparisonMode
          versions={sortedVersions}
          onCompare={async (a, b) => {
            await onCompare(a, b);
            setCompareMode(false);
          }}
          onCancel={() => setCompareMode(false)}
        />
      )}

      {/* Version list */}
      <div className="overflow-y-auto" style={{ maxHeight: compareMode ? "calc(100vh - 200px)" : "calc(100vh - 52px)" }}>
        {versions.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
            <Clock className="w-8 h-8 mb-2 opacity-50" />
            <p className="text-body-small">No versions yet</p>
            <p className="text-caption mt-1">
              Create a version to start tracking history
            </p>
          </div>
        ) : (
          versions.map((version) => (
            <VersionItem
              key={version.version}
              version={version}
              previousVersion={previousVersionMap.get(version.version)}
              onViewDiff={onViewDiff}
            />
          ))
        )}
      </div>

      {/* Slide-in animation */}
      <style jsx>{`
        @keyframes slideInRight {
          from {
            transform: translateX(100%);
            opacity: 0;
          }
          to {
            transform: translateX(0);
            opacity: 1;
          }
        }
      `}</style>
    </div>
  );
}

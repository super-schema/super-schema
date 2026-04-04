"use client";

/**
 * TargetStatusIndicator
 *
 * Per-target emission status display.
 * Shows colored dots and version info for each target.
 */

import type { EmissionTargetStatus } from "@/types/schemas/governance";

interface TargetStatusIndicatorProps {
  statuses: EmissionTargetStatus[];
  compact?: boolean;
}

const STATUS_COLORS: Record<string, string> = {
  current: "bg-emerald-400",
  staged: "bg-amber-400",
  behind: "bg-muted-foreground/50",
};

export function TargetStatusIndicator({
  statuses,
  compact = false,
}: TargetStatusIndicatorProps) {
  if (statuses.length === 0) return null;

  if (compact) {
    // Compact mode for status bar
    return (
      <span
        data-testid="target-status-indicator"
        className="inline-flex items-center gap-2 text-mono-small text-muted-foreground"
      >
        {statuses.map((s) => (
          <span key={s.target} className="inline-flex items-center gap-1">
            <span
              className={`w-1.5 h-1.5 rounded-full ${STATUS_COLORS[s.status] ?? STATUS_COLORS.behind}`}
            />
            <span>
              {s.target}: v{s.emittedVersion ?? 0}
              {s.stagedVersion ? ` (v${s.stagedVersion} staged)` : ""}
            </span>
          </span>
        ))}
      </span>
    );
  }

  // Full mode for entity header
  return (
    <div
      data-testid="target-status-indicator"
      className="flex items-center gap-3"
    >
      {statuses.map((s) => (
        <div
          key={s.target}
          className="flex items-center gap-1.5 text-caption"
        >
          <span
            className={`w-2 h-2 rounded-full ${STATUS_COLORS[s.status] ?? STATUS_COLORS.behind}`}
          />
          <span className="font-medium text-foreground">{s.target}</span>
          <span className="text-muted-foreground">
            {s.status === "current" && `v${s.emittedVersion} emitted`}
            {s.status === "staged" &&
              `v${s.emittedVersion ?? 0} current, v${s.stagedVersion} staged`}
            {s.status === "behind" && `v${s.emittedVersion ?? 0} current`}
          </span>
        </div>
      ))}
    </div>
  );
}

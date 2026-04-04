"use client";

import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

interface VersionBadgeProps {
  version: string | null;
  isMatched?: boolean;
  label?: string;
}

export function VersionBadge({
  version,
  isMatched,
  label,
}: VersionBadgeProps) {
  if (!version) {
    return (
      <span
        data-testid="version-badge-unknown"
        className="inline-flex items-center px-1.5 py-0.5 rounded text-caption bg-muted text-muted-foreground"
      >
        Unknown
      </span>
    );
  }

  const colorClass =
    isMatched === undefined
      ? "bg-muted text-foreground"
      : isMatched
        ? "bg-success/10 text-success"
        : "bg-warning/10 text-warning";

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            data-testid={`version-badge-${version}`}
            className={`inline-flex items-center px-1.5 py-0.5 rounded text-caption font-mono ${colorClass}`}
          >
            {version}
          </span>
        </TooltipTrigger>
        {label && (
          <TooltipContent side="top">
            <p className="text-xs">{label}</p>
          </TooltipContent>
        )}
      </Tooltip>
    </TooltipProvider>
  );
}

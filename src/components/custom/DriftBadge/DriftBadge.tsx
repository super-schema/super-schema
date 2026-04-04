"use client";

import { CheckCircle2, AlertTriangle, HelpCircle } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { DriftStatus } from "@/lib/drift/drift-comparator";

interface DriftBadgeProps {
  status: DriftStatus;
  targetFormat?: string;
  lastChecked?: string | null;
  compact?: boolean;
}

const STATUS_CONFIG: Record<
  DriftStatus,
  {
    icon: typeof CheckCircle2;
    color: string;
    bgColor: string;
    label: string;
  }
> = {
  "in-sync": {
    icon: CheckCircle2,
    color: "text-success",
    bgColor: "bg-success/10",
    label: "In Sync",
  },
  drifted: {
    icon: AlertTriangle,
    color: "text-warning",
    bgColor: "bg-warning/10",
    label: "Drifted",
  },
  unknown: {
    icon: HelpCircle,
    color: "text-muted-foreground",
    bgColor: "bg-muted",
    label: "Unknown",
  },
};

export function DriftBadge({
  status,
  targetFormat,
  lastChecked,
  compact = false,
}: DriftBadgeProps) {
  const config = STATUS_CONFIG[status];
  const Icon = config.icon;

  if (compact) {
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              data-testid={`drift-badge-${status}`}
              className={`inline-block w-2 h-2 rounded-full ${
                status === "in-sync"
                  ? "bg-success"
                  : status === "drifted"
                    ? "bg-warning"
                    : "bg-muted-foreground"
              }`}
            />
          </TooltipTrigger>
          <TooltipContent side="top">
            <p className="text-xs">
              {targetFormat ? `${targetFormat}: ` : ""}
              {config.label}
              {lastChecked ? ` (checked ${lastChecked})` : ""}
            </p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            data-testid={`drift-badge-${status}`}
            className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-caption ${config.bgColor} ${config.color}`}
          >
            <Icon className="w-3 h-3" />
            {config.label}
          </span>
        </TooltipTrigger>
        <TooltipContent side="top">
          <div className="text-xs">
            {targetFormat && (
              <p>Target: {targetFormat}</p>
            )}
            {lastChecked && (
              <p>Last checked: {lastChecked}</p>
            )}
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

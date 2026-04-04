"use client";

import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

interface ConfidenceBadgeProps {
  confidence: "high" | "medium" | "low";
  originalType: string;
  mappedType: string;
}

const CONFIDENCE_CONFIG = {
  high: {
    color: "bg-success",
    label: "High",
    description: "Direct type mapping",
  },
  medium: {
    color: "bg-warning",
    label: "Medium",
    description: "Approximate mapping — review recommended",
  },
  low: {
    color: "bg-destructive",
    label: "Low",
    description: "Ambiguous mapping — manual review required",
  },
};

export function ConfidenceBadge({
  confidence,
  originalType,
  mappedType,
}: ConfidenceBadgeProps) {
  const config = CONFIDENCE_CONFIG[confidence];

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            data-testid={`confidence-badge-${confidence}`}
            className={`inline-block w-2.5 h-2.5 rounded-full ${config.color} cursor-help`}
          />
        </TooltipTrigger>
        <TooltipContent side="top">
          <div className="text-xs">
            <p className="font-medium">{config.label} confidence</p>
            <p className="text-muted-foreground">{config.description}</p>
            <p className="text-muted-foreground mt-1">
              {originalType} &rarr; {mappedType}
            </p>
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

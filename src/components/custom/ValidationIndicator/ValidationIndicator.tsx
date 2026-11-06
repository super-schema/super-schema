"use client";

import { useId } from "react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { ValidationIndicatorProps } from "./ValidationIndicator.types";

const STATUS_COLORS: Record<string, string> = {
  complete: "#5bc27a",
  suggestion: "#e5a93b",
  error: "#e55b5b",
};

export function ValidationIndicator({
  status,
  tooltipContent,
}: ValidationIndicatorProps) {
  const color = STATUS_COLORS[status];
  const tooltipId = useId();

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger
          aria-describedby={tooltipId}
          render={
            <div tabIndex={0} role="img" aria-label={status === "complete" ? "Complete" : status === "suggestion" ? "Field information missing" : "Missing required information"} className="flex items-center justify-center w-4 h-4 shrink-0 cursor-help rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              <svg
                width="16"
                height="16"
                viewBox="0 0 16 16"
                className="animate-validation-ring"
                aria-hidden="true"
              >
                {/* Background ring */}
                <circle
                  cx="8"
                  cy="8"
                  r="6"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  className="text-muted/50"
                />
                {/* Status ring */}
                <circle
                  cx="8"
                  cy="8"
                  r="6"
                  fill="none"
                  stroke={color}
                  strokeWidth="2"
                  strokeDasharray={`${2 * Math.PI * 6}`}
                  strokeDashoffset="0"
                  strokeLinecap="round"
                  style={{
                    transition:
                      "stroke 300ms var(--transition-spring), stroke-dashoffset 300ms var(--transition-spring)",
                  }}
                  transform="rotate(-90 8 8)"
                />
                {/* Center dot */}
                {status === "complete" && (
                  <circle cx="8" cy="8" r="2.5" fill={color} />
                )}
                {status === "error" && (
                  <circle cx="8" cy="8" r="2" fill={color} />
                )}
              </svg>
            </div>
          }
        />
        <TooltipContent id={tooltipId} role="tooltip" side="right" className="max-w-xs">
          <div className="text-body-small">{tooltipContent}</div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

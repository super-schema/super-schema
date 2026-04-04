"use client";

/**
 * Classification Badge
 *
 * Status bar badge showing change classification: Non-breaking, Breaking, or Classification change.
 * Clickable to show full reasons popover.
 */

import { useState } from "react";
import type { ChangeClassification } from "@/types/schemas/classification";

interface ClassificationBadgeProps {
  classification: ChangeClassification | null;
}

const BADGE_STYLES: Record<
  string,
  { bg: string; text: string; label: string }
> = {
  "non-breaking": {
    bg: "bg-emerald-500/20",
    text: "text-emerald-400",
    label: "Non-breaking",
  },
  breaking: {
    bg: "bg-red-500/20",
    text: "text-red-400",
    label: "Breaking",
  },
  "classification-change": {
    bg: "bg-amber-500/20",
    text: "text-amber-400",
    label: "Classification change",
  },
};

export function ClassificationBadge({
  classification,
}: ClassificationBadgeProps) {
  const [showReasons, setShowReasons] = useState(false);

  if (!classification) return null;

  const style = BADGE_STYLES[classification.changeType] ?? BADGE_STYLES["non-breaking"];
  const reasonCount = classification.reasons.length;

  const label =
    classification.changeType === "breaking"
      ? `${style.label} (${reasonCount} reason${reasonCount !== 1 ? "s" : ""})`
      : style.label;

  return (
    <span className="relative inline-flex items-center">
      <button
        type="button"
        data-testid="classification-badge"
        className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-mono-small font-medium cursor-pointer ${style.bg} ${style.text} hover:opacity-80 transition-opacity`}
        onClick={() => setShowReasons(!showReasons)}
      >
        <span
          className={`w-1.5 h-1.5 rounded-full ${
            classification.changeType === "non-breaking"
              ? "bg-emerald-400"
              : classification.changeType === "breaking"
                ? "bg-red-400"
                : "bg-amber-400"
          }`}
        />
        {label}
      </button>

      {showReasons && classification.reasons.length > 0 && (
        <div
          data-testid="classification-reasons"
          className="absolute bottom-full left-0 mb-2 w-80 p-3 rounded-lg border border-border shadow-xl z-50"
          style={{
            background: "rgba(28, 28, 38, 0.95)",
            backdropFilter: "blur(12px)",
          }}
        >
          <div className="text-caption font-semibold text-foreground mb-2">
            Classification Reasons
          </div>
          <ul className="space-y-1">
            {classification.reasons.map((reason, i) => (
              <li
                key={i}
                className="text-mono-small text-muted-foreground flex items-start gap-1.5"
              >
                <span className="mt-1 w-1 h-1 rounded-full bg-muted-foreground shrink-0" />
                {reason}
              </li>
            ))}
          </ul>
          {classification.perTarget.length > 0 && (
            <div className="mt-3 pt-2 border-t border-border">
              <div className="text-caption font-semibold text-foreground mb-1">
                Per-Target Impact
              </div>
              {classification.perTarget.map((pt) => (
                <div
                  key={pt.target}
                  className="text-mono-small text-muted-foreground flex items-center gap-2 py-0.5"
                >
                  <span
                    className={`w-1.5 h-1.5 rounded-full ${
                      pt.changeType === "non-breaking"
                        ? "bg-emerald-400"
                        : pt.changeType === "breaking"
                          ? "bg-red-400"
                          : "bg-amber-400"
                    }`}
                  />
                  <span className="font-medium">{pt.target}</span>
                  <span className="opacity-70">{pt.changeType}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </span>
  );
}

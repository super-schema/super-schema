"use client";

import { Archive } from "lucide-react";

interface RetirementBannerProps {
  metadata: Record<string, unknown> | null;
}

export function RetirementBanner({ metadata }: RetirementBannerProps) {
  const deprecation = (metadata?.deprecation || {}) as {
    since?: string;
  };

  const since = deprecation.since || "unknown date";

  return (
    <div className="flex items-center gap-space-3 rounded-xl bg-muted px-space-4 py-space-3 mb-space-4">
      <Archive className="w-5 h-5 shrink-0 text-muted-foreground" />
      <span className="text-body-small text-muted-foreground">
        This entity is retired since <strong>{since}</strong>. It is read-only.
      </span>
    </div>
  );
}

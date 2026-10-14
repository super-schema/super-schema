"use client";

import Link from "next/link";
import { AlertTriangle } from "lucide-react";

interface DeprecationBannerProps {
  metadata: Record<string, unknown> | null;
  domainSlug: string | null;
  replacementEntityName?: string;
  replacementEntityId?: string;
}

export function DeprecationBanner({
  metadata,
  domainSlug,
  replacementEntityName,
  replacementEntityId,
}: DeprecationBannerProps) {
  const deprecation = (metadata?.deprecation || {}) as {
    since?: string;
    replacementEntityId?: string;
    migrationNotes?: string;
    replacement?: string;
  };

  const since = deprecation.since || "unknown date";
  const replId = replacementEntityId || deprecation.replacementEntityId;
  const replName = replacementEntityName || deprecation.replacement || replId;

  return (
    <div
      className="flex items-start gap-space-3 rounded-xl border px-space-4 py-space-3 mb-space-4"
      style={{
        backgroundColor: "rgba(229,169,59,0.15)",
        borderColor: "#e5a93b",
      }}
    >
      <AlertTriangle className="w-5 h-5 shrink-0 mt-0.5" style={{ color: "#e5a93b" }} />
      <div className="flex-1 text-body-small">
        <span className="text-foreground">
          This entity is deprecated since <strong>{since}</strong>.
        </span>
        {replId && (
          <span className="text-foreground">
            {" "}Replacement:{" "}
            <Link
              href={`/schemas?entityId=${encodeURIComponent(replId)}`}
              className="font-medium underline"
              style={{ color: "#6ba3e8" }}
            >
              {replName}
            </Link>
          </span>
        )}
        {deprecation.migrationNotes && (
          <p className="text-muted-foreground mt-1">{deprecation.migrationNotes}</p>
        )}
      </div>
    </div>
  );
}

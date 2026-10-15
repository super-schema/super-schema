"use client";

import Link from "next/link";
import { AlertTriangle } from "lucide-react";
import { assetHref } from "@/lib/navigation/asset-href";

/** The replacement entity, resolved server-side. Slugs are null for a tenant-level entity. */
export interface ReplacementEntityLink {
  name: string;
  slug: string;
  domainSlug: string | null;
  productSlug: string | null;
}

interface DeprecationBannerProps {
  metadata: Record<string, unknown> | null;
  /** null / undefined when the metadata names no replacement, or it could not be found. */
  replacementEntity?: ReplacementEntityLink | null;
}

export function DeprecationBanner({ metadata, replacementEntity }: DeprecationBannerProps) {
  const deprecation = (metadata?.deprecation || {}) as {
    since?: string;
    replacementEntityId?: string;
    migrationNotes?: string;
    replacement?: string;
  };

  const since = deprecation.since || "unknown date";
  const replId = deprecation.replacementEntityId;
  const replName = replacementEntity?.name || deprecation.replacement || replId;

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
            {replacementEntity ? (
              <Link
                href={assetHref({
                  kind: "entity",
                  slug: replacementEntity.slug,
                  domainSlug: replacementEntity.domainSlug,
                  productSlug: replacementEntity.productSlug,
                })}
                className="font-medium underline"
                style={{ color: "#6ba3e8" }}
              >
                {replName}
              </Link>
            ) : (
              // The named entity is gone or out of scope: show it, never link a dead target.
              <span className="font-medium">{replName}</span>
            )}
          </span>
        )}
        {deprecation.migrationNotes && (
          <p className="text-muted-foreground mt-1">{deprecation.migrationNotes}</p>
        )}
      </div>
    </div>
  );
}

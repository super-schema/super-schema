"use client";

import Link from "next/link";
import { otherClassificationCounts } from "@/lib/classification-counts";
import { Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { formatDateOnly } from "@/lib/date-format";
import { assetHref } from "@/lib/navigation/asset-href";
interface EntityCardProps {
  id: string;
  name: string;
  slug: string;
  description: string;
  status: string;
  version: number;
  fieldCount: number;
  domainName: string;
  /** null for tenant-level (Enterprise) entities. */
  domainSlug: string | null;
  /** null for tenant-level (Enterprise) entities. */
  productSlug: string | null;
  updatedAt: Date;
  /** The five standard levels, plus any other level present under its own name. */
  classifications?: {
    NEVER_STORED: number;
    PII: number;
    SENSITIVE: number;
    INTERNAL: number;
    PUBLIC: number;
  } & Record<string, number>;
  onDelete?: (id: string, name: string) => void;
}

export function EntityCard({
  id,
  name,
  slug,
  description,
  status,
  version,
  fieldCount,
  domainSlug,
  productSlug,
  updatedAt,
  classifications,
  onDelete,
}: EntityCardProps) {
  const statusColor =
    status === "ACTIVE"
      ? "bg-success"
      : status === "DRAFT"
        ? "bg-warning"
        : "bg-muted-foreground";

  return (
    <div
      data-testid="entity-card"
      data-entity-slug={slug}
      className="group relative surface-glass rounded-xl border border-border p-space-6 transition-all duration-200 hover:border-primary/30 hover:shadow-lg"
    >
      {onDelete && (
        <button
          type="button"
          onClick={() => onDelete(id, name)}
          className="absolute right-space-6 top-space-6 p-1 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-all"
          title={`Delete entity ${name}`}
          aria-label={`Delete entity ${name}`}
          data-testid="entity-card-delete"
        >
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      )}

      <Link href={assetHref({ kind: "entity", slug, domainSlug, productSlug })} className="block">
        {/* Header */}
        <div className="flex items-start justify-between mb-space-2 pr-space-8">
          <h3 className="text-heading-3 text-foreground font-mono group-hover:text-primary transition-colors">
            {name}
          </h3>
          <div className="flex items-center gap-space-2">
            <span className={`w-2 h-2 rounded-full ${statusColor}`} />
            <Badge variant="outline" className="text-caption">
              {status}
            </Badge>
          </div>
        </div>

        {/* Description */}
        <p className="text-body-small text-muted-foreground line-clamp-2 mb-space-3">
          {description || "No description"}
        </p>

        {/* Classification badges */}
        {classifications && (
          <div className="flex items-center gap-space-1 mb-space-3 flex-wrap">
            {classifications.NEVER_STORED > 0 && (
              <span className="badge-never-stored text-caption px-1.5 py-0.5 rounded">
                {classifications.NEVER_STORED} Never Stored
              </span>
            )}
            {classifications.PII > 0 && (
              <span className="badge-pii text-caption px-1.5 py-0.5 rounded">
                {classifications.PII} PII
              </span>
            )}
            {classifications.SENSITIVE > 0 && (
              <span className="badge-sensitive text-caption px-1.5 py-0.5 rounded">
                {classifications.SENSITIVE} Sensitive
              </span>
            )}
            {classifications.INTERNAL > 0 && (
              <span className="badge-internal text-caption px-1.5 py-0.5 rounded">
                {classifications.INTERNAL} Internal
              </span>
            )}
            {classifications.PUBLIC > 0 && (
              <span className="badge-public text-caption px-1.5 py-0.5 rounded">
                {classifications.PUBLIC} Public
              </span>
            )}
            {otherClassificationCounts(classifications).map(([level, count]) => (
              <span key={level} className="bg-muted text-muted-foreground text-caption px-1.5 py-0.5 rounded">
                {count} {level}
              </span>
            ))}
          </div>
        )}

        {/* Footer */}
        <div className="flex items-center gap-space-3 text-caption text-muted-foreground">
          <span>{fieldCount} fields</span>
          <span>v{version}</span>
          <span className="ml-auto">{formatDateOnly(updatedAt)}</span>
        </div>
      </Link>
    </div>
  );
}

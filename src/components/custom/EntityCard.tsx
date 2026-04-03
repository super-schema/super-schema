"use client";

import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { toSlug } from "@/lib/domain-utils";

interface EntityCardProps {
  id: string;
  name: string;
  description: string;
  status: string;
  version: number;
  fieldCount: number;
  domainName: string;
  domainSlug: string;
  updatedAt: Date;
  classifications?: {
    PII: number;
    SENSITIVE: number;
    INTERNAL: number;
    PUBLIC: number;
  };
}

export function EntityCard({
  id,
  name,
  description,
  status,
  version,
  fieldCount,
  domainSlug,
  updatedAt,
  classifications,
}: EntityCardProps) {
  const statusColor =
    status === "ACTIVE"
      ? "bg-success"
      : status === "DRAFT"
        ? "bg-warning"
        : "bg-muted-foreground";

  return (
    <Link
      href={`/schemas/${domainSlug}/${id}`}
      className="group block surface-glass rounded-xl border border-border p-space-6 transition-all duration-200 hover:border-primary/30 hover:shadow-lg"
    >
      {/* Header */}
      <div className="flex items-start justify-between mb-space-2">
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
        </div>
      )}

      {/* Footer */}
      <div className="flex items-center gap-space-3 text-caption text-muted-foreground">
        <span>{fieldCount} fields</span>
        <span>v{version}</span>
        <span className="ml-auto">
          {new Date(updatedAt).toLocaleDateString()}
        </span>
      </div>
    </Link>
  );
}

"use client";

import Link from "next/link";
import { Database, FlaskConical, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { formatDateOnly } from "@/lib/date-format";

interface DomainCardProps {
  id: string;
  name: string;
  slug: string;
  description: string;
  isSystem: boolean;
  entityCount: number;
  createdAt: Date;
  canDeleteDomain?: boolean;
  onRequestDelete?: () => void;
}

export function DomainCard({
  name,
  slug,
  description,
  isSystem,
  entityCount,
  createdAt,
  canDeleteDomain = false,
  onRequestDelete,
}: DomainCardProps) {
  const isPublic = name === "Public";
  const isPlayground = name === "Playground";
  const canDelete = canDeleteDomain && !isSystem && entityCount === 0;

  return (
    <div
      className={`group relative surface-glass rounded-xl border transition-all duration-200 hover:shadow-lg hover:border-primary/40 ${
        isPublic
          ? "border-primary/30"
          : isPlayground
            ? "border-secondary/30"
            : "border-border"
      }`}
    >
      <Link href={`/schemas/${slug}`} className="block p-space-6">
        {/* Title */}
        <div className="flex items-center gap-space-2 mb-space-2 pr-9">
          {isPlayground ? (
            <FlaskConical className="w-5 h-5 text-secondary shrink-0" />
          ) : (
            <Database className="w-5 h-5 text-primary shrink-0" />
          )}
          <h3 className="text-heading-2 text-foreground group-hover:text-primary transition-colors truncate">
            {name}
          </h3>
        </div>

        {/* Badges */}
        <div className="flex items-center gap-space-2 justify-end mb-space-3">
          {isSystem && (
            <Badge variant="outline" className="text-caption">
              System
            </Badge>
          )}
          <Badge variant="secondary" className="text-caption">
            {entityCount} {entityCount === 1 ? "entity" : "entities"}
          </Badge>
        </div>

        {/* Description */}
        <p className="text-body-small text-muted-foreground line-clamp-2 mb-space-3">
          {description || "No description"}
        </p>

        {/* Playground tagline */}
        {isPlayground && (
          <p className="text-caption text-secondary/70 italic mb-space-3">
            Experiment freely — create test entities without affecting production
            domains
          </p>
        )}

        {/* Footer */}
        <div className="text-caption text-muted-foreground">
          Created {formatDateOnly(createdAt)}
        </div>
      </Link>

      {canDeleteDomain && !isSystem ? (
        <button
          type="button"
          onClick={onRequestDelete}
          disabled={!canDelete}
          aria-label={`Delete domain ${name}`}
          title={
            canDelete
              ? `Delete ${name}`
              : "Delete entities in this domain before removing it"
          }
          className="absolute right-3 top-3 rounded-md p-1 text-muted-foreground transition-all hover:bg-destructive/10 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive/30 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-muted-foreground"
        >
          <Trash2 className="w-4 h-4" />
        </button>
      ) : null}
    </div>
  );
}

"use client";

import Link from "next/link";
import { Database, FlaskConical } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { toSlug } from "@/lib/domain-utils";

interface DomainCardProps {
  id: string;
  name: string;
  description: string;
  isSystem: boolean;
  entityCount: number;
  createdAt: Date;
}

export function DomainCard({
  name,
  description,
  isSystem,
  entityCount,
  createdAt,
}: DomainCardProps) {
  const slug = toSlug(name);
  const isPublic = name === "Public";
  const isPlayground = name === "Playground";

  return (
    <Link
      href={`/schemas/${slug}`}
      className={`group block surface-glass rounded-xl border p-space-6 transition-all duration-200 hover:shadow-lg hover:border-primary/40 ${
        isPublic
          ? "border-primary/30"
          : isPlayground
            ? "border-secondary/30"
            : "border-border"
      }`}
    >
      {/* Header */}
      <div className="flex items-start justify-between mb-space-3">
        <div className="flex items-center gap-space-2">
          {isPlayground ? (
            <FlaskConical className="w-5 h-5 text-secondary shrink-0" />
          ) : (
            <Database className="w-5 h-5 text-primary shrink-0" />
          )}
          <h3 className="text-heading-2 text-foreground group-hover:text-primary transition-colors">
            {name}
          </h3>
        </div>
        <div className="flex items-center gap-space-2">
          {isSystem && (
            <Badge variant="outline" className="text-caption">
              System
            </Badge>
          )}
          <Badge variant="secondary" className="text-caption">
            {entityCount} {entityCount === 1 ? "entity" : "entities"}
          </Badge>
        </div>
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
        Created {new Date(createdAt).toLocaleDateString()}
      </div>
    </Link>
  );
}

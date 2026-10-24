"use client";

/**
 * ConceptCard
 *
 * Displays a single business concept with name, definition,
 * synonyms as badges, canonical type, classification, and usage count.
 */

import type { BusinessConcept, FieldConceptLink } from "@/generated/prisma/client";

interface ConceptCardProps {
  concept: BusinessConcept & { fieldLinks: FieldConceptLink[] };
  isSelected?: boolean;
  onClick?: () => void;
}

const CLASSIFICATION_STYLES: Record<string, { bg: string; text: string }> = {
  PII: { bg: "bg-red-500/20", text: "text-red-400" },
  SENSITIVE: { bg: "bg-amber-500/20", text: "text-amber-400" },
  INTERNAL: { bg: "bg-blue-500/20", text: "text-blue-400" },
  PUBLIC: { bg: "bg-emerald-500/20", text: "text-emerald-400" },
};

export function ConceptCard({ concept, isSelected, onClick }: ConceptCardProps) {
  const fieldCount = concept.fieldLinks?.length ?? 0;
  const clsStyle = concept.classification
    ? CLASSIFICATION_STYLES[concept.classification] ?? { bg: "bg-muted", text: "text-muted-foreground" }
    : null;

  return (
    <div
      data-testid="concept-card"
      data-name={concept.name}
      onClick={onClick}
      className={`rounded-lg border border-border p-4 cursor-pointer transition-all ${
        isSelected
          ? "ring-1 ring-primary border-primary/50"
          : "hover:ring-1 hover:ring-border hover:border-border/80"
      }`}
      style={{
        background: "rgba(28, 28, 38, 0.8)",
        backdropFilter: "blur(12px)",
      }}
    >
      {/* Header */}
      <div className="flex items-start justify-between mb-2">
        <h3 className="text-body font-semibold text-foreground">
          {concept.name}
        </h3>
        <div className="flex items-center gap-1.5">
          {concept.canonicalType && (
            <span className="inline-flex items-center px-2 py-0.5 rounded text-mono-small font-medium bg-purple-500/20 text-purple-400">
              {concept.canonicalType}
            </span>
          )}
          {concept.classification && clsStyle && (
            <span
              className={`inline-flex items-center px-2 py-0.5 rounded text-mono-small font-medium ${clsStyle.bg} ${clsStyle.text}`}
            >
              {concept.classification}
            </span>
          )}
        </div>
      </div>

      {/* Definition */}
      {concept.definition && (
        <p className="text-caption text-muted-foreground mb-3 line-clamp-2">
          {concept.definition}
        </p>
      )}

      {/* Synonyms */}
      {concept.synonyms.length > 0 && (
        <div className="flex flex-wrap gap-1 mb-3">
          {concept.synonyms.map((syn) => (
            <span
              key={syn}
              className="inline-flex items-center px-1.5 py-0.5 rounded text-mono-small bg-muted text-muted-foreground"
            >
              {syn}
            </span>
          ))}
        </div>
      )}

      {/* Footer: tags + usage */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1">
          {concept.tags.slice(0, 3).map((tag) => (
            <span
              key={tag}
              className="inline-flex items-center px-1.5 py-0.5 rounded text-mono-small bg-primary/10 text-primary"
            >
              #{tag}
            </span>
          ))}
          {concept.tags.length > 3 && (
            <span className="text-mono-small text-muted-foreground">
              +{concept.tags.length - 3}
            </span>
          )}
        </div>
        <span className="text-mono-small text-muted-foreground">
          {fieldCount} field{fieldCount !== 1 ? "s" : ""} linked
        </span>
      </div>
    </div>
  );
}

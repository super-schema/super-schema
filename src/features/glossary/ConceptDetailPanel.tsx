"use client";

/**
 * ConceptDetailPanel
 *
 * Expanded view showing full concept details and all linked fields
 * with their entity/domain information.
 */

import { useState, useEffect } from "react";
import type { BusinessConcept } from "@/generated/prisma/client";

interface LinkedField {
  fieldId: string;
  fieldName: string;
  entityName: string;
  domainName: string;
  confidence: number;
}

interface ConceptDetail {
  concept: BusinessConcept;
  usageCount: number;
  fields: LinkedField[];
}

interface ConceptDetailPanelProps {
  conceptId: string;
  onClose?: () => void;
  onUnlink?: (fieldId: string, conceptId: string) => void;
  getUsage: (conceptId: string) => Promise<ConceptDetail | null>;
}

const CLASSIFICATION_STYLES: Record<string, { bg: string; text: string }> = {
  PII: { bg: "bg-red-500/20", text: "text-red-400" },
  SENSITIVE: { bg: "bg-amber-500/20", text: "text-amber-400" },
  INTERNAL: { bg: "bg-blue-500/20", text: "text-blue-400" },
  PUBLIC: { bg: "bg-emerald-500/20", text: "text-emerald-400" },
};

export function ConceptDetailPanel({
  conceptId,
  onClose,
  onUnlink,
  getUsage,
}: ConceptDetailPanelProps) {
  const [detail, setDetail] = useState<ConceptDetail | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    getUsage(conceptId).then((data) => {
      setDetail(data);
      setLoading(false);
    });
  }, [conceptId, getUsage]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full text-caption text-muted-foreground">
        Loading concept details...
      </div>
    );
  }

  if (!detail) {
    return (
      <div className="flex items-center justify-center h-full text-caption text-muted-foreground">
        Concept not found
      </div>
    );
  }

  const { concept, fields } = detail;
  const clsStyle = concept.classification
    ? CLASSIFICATION_STYLES[concept.classification] ?? { bg: "bg-muted", text: "text-muted-foreground" }
    : null;

  // Group fields by entity
  const groupedByEntity = fields.reduce(
    (acc, f) => {
      const key = `${f.domainName} / ${f.entityName}`;
      if (!acc[key]) acc[key] = [];
      acc[key].push(f);
      return acc;
    },
    {} as Record<string, LinkedField[]>
  );

  const uniqueEntities = new Set(fields.map((f) => f.entityName));

  return (
    <div data-testid="concept-detail-panel" className="space-y-4">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-heading-2 text-foreground">{concept.name}</h2>
          <p className="text-caption text-muted-foreground mt-1">
            {concept.domain} domain
          </p>
        </div>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground text-caption"
          >
            Close
          </button>
        )}
      </div>

      {/* Badges */}
      <div className="flex items-center gap-2 flex-wrap">
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

      {/* Definition */}
      {concept.definition && (
        <div>
          <h4 className="text-caption font-medium text-foreground mb-1">Definition</h4>
          <p className="text-caption text-muted-foreground">{concept.definition}</p>
        </div>
      )}

      {/* Synonyms */}
      {concept.synonyms.length > 0 && (
        <div>
          <h4 className="text-caption font-medium text-foreground mb-1">Synonyms</h4>
          <div className="flex flex-wrap gap-1">
            {concept.synonyms.map((syn) => (
              <span
                key={syn}
                className="inline-flex items-center px-1.5 py-0.5 rounded text-mono-small bg-muted text-muted-foreground"
              >
                {syn}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Tags */}
      {concept.tags.length > 0 && (
        <div>
          <h4 className="text-caption font-medium text-foreground mb-1">Tags</h4>
          <div className="flex flex-wrap gap-1">
            {concept.tags.map((tag) => (
              <span
                key={tag}
                className="inline-flex items-center px-1.5 py-0.5 rounded text-mono-small bg-primary/10 text-primary"
              >
                #{tag}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Usage summary */}
      <div className="pt-2 border-t border-border">
        <h4 className="text-caption font-medium text-foreground mb-2">
          Linked Fields ({fields.length} field{fields.length !== 1 ? "s" : ""} across{" "}
          {uniqueEntities.size} entit{uniqueEntities.size !== 1 ? "ies" : "y"})
        </h4>

        {fields.length === 0 ? (
          <p className="text-caption text-muted-foreground">
            No fields linked to this concept yet.
          </p>
        ) : (
          <div className="space-y-3">
            {Object.entries(groupedByEntity).map(([entityKey, entityFields]) => (
              <div key={entityKey}>
                <p className="text-mono-small text-muted-foreground mb-1">
                  {entityKey}
                </p>
                <div className="space-y-1">
                  {entityFields.map((f) => (
                    <div
                      key={f.fieldId}
                      className="flex items-center justify-between px-2 py-1 rounded bg-muted/50"
                    >
                      <span className="text-caption text-foreground font-mono">
                        {f.fieldName}
                      </span>
                      <div className="flex items-center gap-2">
                        <span className="text-mono-small text-muted-foreground">
                          {Math.round(f.confidence * 100)}%
                        </span>
                        {onUnlink && (
                          <button
                            type="button"
                            onClick={() => onUnlink(f.fieldId, concept.id)}
                            className="text-mono-small text-red-400 hover:text-red-300"
                          >
                            unlink
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

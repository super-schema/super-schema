"use client";

/**
 * GlossarySuggestions
 *
 * A widget for the entity field editor that shows:
 * - Currently linked business concepts for a field
 * - Suggested concepts based on field name/type matching
 * - Ability to link/unlink concepts
 */

import { useState, useEffect, useCallback } from "react";
import {
  suggestConceptsForFieldAction,
  linkFieldToConceptAction,
  unlinkFieldFromConceptAction,
} from "@/app/(dashboard)/glossary/actions";
import type { BusinessConcept, FieldConceptLink } from "@/generated/prisma/client";

interface LinkedConcept {
  id: string;
  concept: BusinessConcept;
  confidence: number;
}

interface SuggestedConcept {
  concept: BusinessConcept;
  score: number;
}

interface GlossarySuggestionsProps {
  fieldId: string;
  fieldName: string;
  fieldType: string;
  linkedConcepts?: LinkedConcept[];
  onLinksChanged?: () => void;
}

export function GlossarySuggestions({
  fieldId,
  fieldName,
  fieldType,
  linkedConcepts = [],
  onLinksChanged,
}: GlossarySuggestionsProps) {
  const [suggestions, setSuggestions] = useState<SuggestedConcept[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!fieldName || fieldName.trim().length < 2) {
      setSuggestions([]);
      return;
    }

    setLoading(true);
    suggestConceptsForFieldAction(fieldName, fieldType).then((result) => {
      if ("data" in result && result.data) {
        // Filter out already-linked concepts
        const linkedIds = new Set(linkedConcepts.map((lc) => lc.concept.id));
        const filtered = (result.data as SuggestedConcept[]).filter(
          (s) => !linkedIds.has(s.concept.id)
        );
        setSuggestions(filtered.slice(0, 5));
      }
      setLoading(false);
    });
  }, [fieldName, fieldType, linkedConcepts]);

  const handleLink = useCallback(
    async (conceptId: string, confidence: number) => {
      await linkFieldToConceptAction(fieldId, conceptId, confidence);
      onLinksChanged?.();
    },
    [fieldId, onLinksChanged]
  );

  const handleUnlink = useCallback(
    async (conceptId: string) => {
      await unlinkFieldFromConceptAction(fieldId, conceptId);
      onLinksChanged?.();
    },
    [fieldId, onLinksChanged]
  );

  const hasContent = linkedConcepts.length > 0 || suggestions.length > 0;

  if (!hasContent && !loading) return null;

  return (
    <div data-testid="glossary-suggestions" className="space-y-2">
      <h4 className="text-mono-small font-medium text-muted-foreground uppercase tracking-wide">
        Business Concepts
      </h4>

      {/* Linked concepts */}
      {linkedConcepts.length > 0 && (
        <div className="space-y-1">
          {linkedConcepts.map((lc) => (
            <div
              key={lc.concept.id}
              className="flex items-center justify-between px-2 py-1 rounded bg-primary/10"
            >
              <div className="flex items-center gap-1.5">
                <span className="inline-block w-1.5 h-1.5 rounded-full bg-primary" />
                <span className="text-caption text-foreground">
                  {lc.concept.name}
                </span>
              </div>
              <button
                type="button"
                onClick={() => handleUnlink(lc.concept.id)}
                className="text-mono-small text-muted-foreground hover:text-red-400"
              >
                unlink
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Suggestions */}
      {loading ? (
        <p className="text-mono-small text-muted-foreground">Searching concepts...</p>
      ) : (
        suggestions.length > 0 && (
          <div className="space-y-1">
            <p className="text-mono-small text-muted-foreground">Suggested:</p>
            {suggestions.map((s) => (
              <div
                key={s.concept.id}
                className="flex items-center justify-between px-2 py-1 rounded bg-muted/50 hover:bg-muted transition-colors"
              >
                <div className="flex items-center gap-1.5">
                  <span className="inline-block w-1.5 h-1.5 rounded-full bg-muted-foreground" />
                  <span className="text-caption text-muted-foreground">
                    {s.concept.name}
                  </span>
                  <span className="text-mono-small text-muted-foreground opacity-60">
                    {Math.round(s.score * 100)}%
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => handleLink(s.concept.id, s.score)}
                  className="text-mono-small text-primary hover:text-primary/80"
                >
                  link
                </button>
              </div>
            ))}
          </div>
        )
      )}
    </div>
  );
}

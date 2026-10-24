"use client";

/**
 * CreateConceptDialog
 *
 * Form dialog for creating a new business concept with
 * name, domain, definition, synonyms, canonical type,
 * classification, and tags.
 */

import { useState } from "react";
import type { CreateBusinessConceptInput } from "@/types/schemas/business-concept";

interface CreateConceptDialogProps {
  open: boolean;
  onClose: () => void;
  onSubmit: (input: CreateBusinessConceptInput) => Promise<{ error?: string } | void>;
}

const DOMAIN_OPTIONS = ["Core", "Finance", "Healthcare", "Identity", "Commerce", "Analytics"];
const CLASSIFICATION_OPTIONS = ["", "PII", "SENSITIVE", "INTERNAL", "PUBLIC"];
const TYPE_OPTIONS = ["", "string", "integer", "decimal", "boolean", "date", "datetime", "timestamp"];

export function CreateConceptDialog({ open, onClose, onSubmit }: CreateConceptDialogProps) {
  const [name, setName] = useState("");
  const [domain, setDomain] = useState("Core");
  const [definition, setDefinition] = useState("");
  const [synonymsText, setSynonymsText] = useState("");
  const [canonicalType, setCanonicalType] = useState("");
  const [classification, setClassification] = useState("");
  const [tagsText, setTagsText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (!open) return null;

  const reset = () => {
    setName("");
    setDomain("Core");
    setDefinition("");
    setSynonymsText("");
    setCanonicalType("");
    setClassification("");
    setTagsText("");
    setError(null);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setError("Concept name is required");
      return;
    }

    setSubmitting(true);
    setError(null);

    const synonyms = synonymsText
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const tags = tagsText
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);

    const input: CreateBusinessConceptInput = {
      name: name.trim(),
      domain,
      definition: definition.trim(),
      synonyms,
      canonicalType: canonicalType || undefined,
      classification: classification || undefined,
      tags,
    };

    const result = await onSubmit(input);
    setSubmitting(false);

    if (result && "error" in result && result.error) {
      setError(result.error);
      return;
    }

    reset();
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" role="dialog" aria-modal="true" aria-label="Create Business Concept" data-testid="concept-dialog">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Dialog */}
      <div
        className="relative w-full max-w-lg rounded-xl border border-border p-6 space-y-4"
        style={{
          background: "rgba(28, 28, 38, 0.95)",
          backdropFilter: "blur(16px)",
        }}
      >
        <h2 className="text-heading-2 text-foreground">Create Business Concept</h2>

        {error && (
          <div role="alert" data-testid="concept-error" className="px-3 py-2 rounded bg-red-500/10 border border-red-500/30 text-caption text-red-400">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-3">
          {/* Name */}
          <div>
            <label htmlFor="concept-name" className="block text-caption font-medium text-foreground mb-1">
              Name <span className="text-red-400">*</span>
            </label>
            <input
              id="concept-name"
              data-testid="concept-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Customer Identifier"
              className="w-full px-3 py-2 rounded border border-border bg-transparent text-caption text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </div>

          {/* Domain */}
          <div>
            <label htmlFor="concept-domain" className="block text-caption font-medium text-foreground mb-1">
              Domain
            </label>
            <select
              id="concept-domain"
              data-testid="concept-domain"
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
              className="w-full px-3 py-2 rounded border border-border bg-transparent text-caption text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
            >
              {DOMAIN_OPTIONS.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
          </div>

          {/* Definition */}
          <div>
            <label htmlFor="concept-definition" className="block text-caption font-medium text-foreground mb-1">
              Definition
            </label>
            <textarea
              id="concept-definition"
              data-testid="concept-definition"
              value={definition}
              onChange={(e) => setDefinition(e.target.value)}
              placeholder="Human-readable definition of this business concept..."
              rows={2}
              className="w-full px-3 py-2 rounded border border-border bg-transparent text-caption text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary resize-none"
            />
          </div>

          {/* Synonyms */}
          <div>
            <label htmlFor="concept-synonyms" className="block text-caption font-medium text-foreground mb-1">
              Synonyms <span className="text-muted-foreground">(comma-separated)</span>
            </label>
            <input
              id="concept-synonyms"
              data-testid="concept-synonyms"
              type="text"
              value={synonymsText}
              onChange={(e) => setSynonymsText(e.target.value)}
              placeholder="cust_id, customer_number, CustomerNo"
              className="w-full px-3 py-2 rounded border border-border bg-transparent text-caption text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </div>

          {/* Canonical Type + Classification in a row */}
          <div className="flex gap-3">
            <div className="flex-1">
              <label htmlFor="concept-type" className="block text-caption font-medium text-foreground mb-1">
                Canonical Type
              </label>
              <select
                id="concept-type"
                data-testid="concept-type"
                value={canonicalType}
                onChange={(e) => setCanonicalType(e.target.value)}
                className="w-full px-3 py-2 rounded border border-border bg-transparent text-caption text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
              >
                {TYPE_OPTIONS.map((t) => (
                  <option key={t} value={t}>
                    {t || "None"}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex-1">
              <label htmlFor="concept-classification" className="block text-caption font-medium text-foreground mb-1">
                Classification
              </label>
              <select
                id="concept-classification"
                data-testid="concept-classification"
                value={classification}
                onChange={(e) => setClassification(e.target.value)}
                className="w-full px-3 py-2 rounded border border-border bg-transparent text-caption text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
              >
                {CLASSIFICATION_OPTIONS.map((c) => (
                  <option key={c} value={c}>
                    {c || "None"}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Tags */}
          <div>
            <label htmlFor="concept-tags" className="block text-caption font-medium text-foreground mb-1">
              Tags <span className="text-muted-foreground">(comma-separated)</span>
            </label>
            <input
              id="concept-tags"
              data-testid="concept-tags"
              type="text"
              value={tagsText}
              onChange={(e) => setTagsText(e.target.value)}
              placeholder="financial, identity, temporal"
              className="w-full px-3 py-2 rounded border border-border bg-transparent text-caption text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </div>

          {/* Actions */}
          <div className="flex items-center justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={() => {
                reset();
                onClose();
              }}
              className="px-4 py-2 rounded text-caption text-muted-foreground hover:text-foreground"
            >
              Cancel
            </button>
            <button
              type="submit"
              data-testid="concept-submit"
              disabled={submitting}
              className="px-4 py-2 rounded text-caption font-medium text-white disabled:opacity-50"
              style={{
                background: "linear-gradient(135deg, #A477B2, #8B5CF6)",
              }}
            >
              {submitting ? "Creating..." : "Create Concept"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

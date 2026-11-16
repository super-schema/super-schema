"use client";

/**
 * CreateConceptDialog
 *
 * Form dialog for creating a new business concept with
 * name, domain, definition, synonyms, canonical type,
 * classification, and tags.
 */

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import type { CreateBusinessConceptInput } from "@/types/schemas/business-concept";
import { GENERIC_ACTION_ERROR } from "@/types/action-result";

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

    try {
      const result = await onSubmit(input);
      if (result && "error" in result && result.error) {
        setError(result.error);
        return;
      }
      reset();
      onClose();
    } catch (e: unknown) {
      // A rejected action (network, serialization, an unwrapped server throw) must not leave the button stuck on "Creating...".
      console.error("[create-concept-dialog] create concept failed", e);
      setError(GENERIC_ACTION_ERROR);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent data-testid="concept-dialog" className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Create Business Concept</DialogTitle>
          <DialogDescription>A shared business meaning that fields across domains can be linked to.</DialogDescription>
        </DialogHeader>

        {error && (
          <div role="alert" data-testid="concept-error" className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <FieldGroup className="gap-3">
            <Field>
              <FieldLabel htmlFor="concept-name">
                Name <span className="text-destructive" aria-hidden="true">*</span>
              </FieldLabel>
              <Input
                id="concept-name"
                data-testid="concept-name"
                type="text"
                aria-required="true"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Customer Identifier"
              />
            </Field>

            <Field>
              <FieldLabel htmlFor="concept-domain">Domain</FieldLabel>
              <NativeSelect id="concept-domain" data-testid="concept-domain" value={domain} onChange={(e) => setDomain(e.target.value)}>
                {DOMAIN_OPTIONS.map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </NativeSelect>
            </Field>

            <Field>
              <FieldLabel htmlFor="concept-definition">Definition</FieldLabel>
              <Textarea
                id="concept-definition"
                data-testid="concept-definition"
                value={definition}
                onChange={(e) => setDefinition(e.target.value)}
                placeholder="Human-readable definition of this business concept..."
                rows={2}
                className="resize-none"
              />
            </Field>

            <Field>
              <FieldLabel htmlFor="concept-synonyms">
                Synonyms <span className="font-normal text-muted-foreground">(comma-separated)</span>
              </FieldLabel>
              <Input
                id="concept-synonyms"
                data-testid="concept-synonyms"
                type="text"
                value={synonymsText}
                onChange={(e) => setSynonymsText(e.target.value)}
                placeholder="cust_id, customer_number, CustomerNo"
              />
            </Field>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field>
                <FieldLabel htmlFor="concept-type">Canonical Type</FieldLabel>
                <NativeSelect id="concept-type" data-testid="concept-type" value={canonicalType} onChange={(e) => setCanonicalType(e.target.value)}>
                  {TYPE_OPTIONS.map((t) => (
                    <option key={t} value={t}>
                      {t || "None"}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
              <Field>
                <FieldLabel htmlFor="concept-classification">Classification</FieldLabel>
                <NativeSelect
                  id="concept-classification"
                  data-testid="concept-classification"
                  value={classification}
                  onChange={(e) => setClassification(e.target.value)}
                >
                  {CLASSIFICATION_OPTIONS.map((c) => (
                    <option key={c} value={c}>
                      {c || "None"}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
            </div>

            <Field>
              <FieldLabel htmlFor="concept-tags">
                Tags <span className="font-normal text-muted-foreground">(comma-separated)</span>
              </FieldLabel>
              <Input
                id="concept-tags"
                data-testid="concept-tags"
                type="text"
                value={tagsText}
                onChange={(e) => setTagsText(e.target.value)}
                placeholder="financial, identity, temporal"
              />
            </Field>
          </FieldGroup>

          <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              reset();
              onClose();
            }}
          >
            Cancel
          </Button>
          <Button type="submit" data-testid="concept-submit" disabled={submitting}>
            {submitting ? "Creating..." : "Create Concept"}
          </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

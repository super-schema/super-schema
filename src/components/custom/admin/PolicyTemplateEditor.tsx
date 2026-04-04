"use client";

import { useState } from "react";
import type { PolicyTemplate } from "@/types/schemas/domain-policy";

interface PolicyTemplateEditorProps {
  value: PolicyTemplate | null;
  onChange: (template: PolicyTemplate) => void;
}

const CLASSIFICATION_OPTIONS = ["PII", "SENSITIVE", "INTERNAL", "PUBLIC"] as const;
const RETENTION_OPTIONS = [
  "30 days",
  "90 days",
  "1 year",
  "3 years",
  "7 years",
  "Indefinite",
] as const;

export function PolicyTemplateEditor({ value, onChange }: PolicyTemplateEditorProps) {
  const [showConfirm, setShowConfirm] = useState(false);
  const [draft, setDraft] = useState<PolicyTemplate>(value ?? {});

  function handleSave() {
    if (value) {
      // Existing template — show confirmation
      setShowConfirm(true);
    } else {
      onChange(draft);
    }
  }

  function confirmSave() {
    onChange(draft);
    setShowConfirm(false);
  }

  return (
    <div className="space-y-space-4">
      {/* Classification */}
      <div className="space-y-space-2">
        <label className="block text-body-small text-muted-foreground">
          Default Classification
        </label>
        <select
          value={draft.classification ?? ""}
          onChange={(e) =>
            setDraft({
              ...draft,
              classification: (e.target.value || undefined) as PolicyTemplate["classification"],
            })
          }
          className="w-full bg-muted rounded-md px-space-3 py-1.5 text-body-small text-foreground outline-none"
        >
          <option value="">None</option>
          {CLASSIFICATION_OPTIONS.map((opt) => (
            <option key={opt} value={opt}>{opt}</option>
          ))}
        </select>
      </div>

      {/* Retention */}
      <div className="space-y-space-2">
        <label className="block text-body-small text-muted-foreground">
          Default Retention Period
        </label>
        <select
          value={draft.retention ?? ""}
          onChange={(e) =>
            setDraft({ ...draft, retention: e.target.value || undefined })
          }
          className="w-full bg-muted rounded-md px-space-3 py-1.5 text-body-small text-foreground outline-none"
        >
          <option value="">None</option>
          {RETENTION_OPTIONS.map((opt) => (
            <option key={opt} value={opt}>{opt}</option>
          ))}
        </select>
      </div>

      {/* Naming Conventions */}
      <div className="space-y-space-2">
        <label className="block text-body-small text-muted-foreground">
          Naming Conventions
        </label>
        <input
          type="text"
          placeholder="e.g., snake_case fields, PascalCase entities"
          value={draft.namingConventions ?? ""}
          onChange={(e) =>
            setDraft({ ...draft, namingConventions: e.target.value || undefined })
          }
          className="w-full bg-muted rounded-md px-space-3 py-1.5 text-body-small text-foreground outline-none placeholder:text-muted-foreground"
        />
      </div>

      {/* Save */}
      <button
        onClick={handleSave}
        className="px-space-3 py-1.5 rounded-md bg-primary text-primary-foreground text-body-small"
      >
        Save Template
      </button>

      {/* Confirmation dialog */}
      {showConfirm && (
        <div className="p-space-3 rounded-md border border-warning bg-warning/10 space-y-space-2">
          <p className="text-body-small text-foreground">
            Template changes apply to future entities only. Existing entities are not affected.
          </p>
          <div className="flex gap-space-2">
            <button
              onClick={confirmSave}
              className="px-space-3 py-1 rounded-md bg-primary text-primary-foreground text-caption"
            >
              Confirm
            </button>
            <button
              onClick={() => setShowConfirm(false)}
              className="px-space-3 py-1 rounded-md text-caption text-muted-foreground hover:bg-muted"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

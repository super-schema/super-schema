"use client";

import { useState } from "react";
import type { PolicyTemplate, CompletenessRequirements, CompletenessRequirement } from "@/types/schemas/domain-policy";

interface PolicyTemplateEditorProps {
  value: PolicyTemplate | null;
  onChange: (template: PolicyTemplate) => void;
}

const CLASSIFICATION_OPTIONS = ["PII", "SENSITIVE", "INTERNAL", "PUBLIC", "NEVER_STORED"] as const;
const RETENTION_OPTIONS = [
  "30 days",
  "90 days",
  "1 year",
  "3 years",
  "7 years",
  "Indefinite",
] as const;

// ---------------------------------------------------------------------------
// Completeness requirement definitions
// ---------------------------------------------------------------------------

interface RequirementDef {
  key: keyof CompletenessRequirements;
  label: string;
  hasMinCount?: boolean;
}

const REQUIREMENT_DEFS: RequirementDef[] = [
  { key: "ownerRequired", label: "Owner required" },
  { key: "descriptionRequired", label: "Description required" },
  { key: "tagsMinCount", label: "Tags minimum count", hasMinCount: true },
  { key: "retentionPolicyRequired", label: "Retention policy required" },
  { key: "fieldDescriptionRequired", label: "Field descriptions required" },
  { key: "fieldClassificationExplicit", label: "Field classification explicit" },
];

const DEFAULT_REQ: CompletenessRequirement = { enabled: false, severity: "warning" };

export function PolicyTemplateEditor({ value, onChange }: PolicyTemplateEditorProps) {
  const [showConfirm, setShowConfirm] = useState(false);
  const [draft, setDraft] = useState<PolicyTemplate>(value ?? {});

  const completeness: CompletenessRequirements = draft.completenessRequirements ?? {};

  function getReq(key: keyof CompletenessRequirements): CompletenessRequirement {
    return completeness[key] ?? DEFAULT_REQ;
  }

  function setReq(key: keyof CompletenessRequirements, updated: CompletenessRequirement) {
    setDraft({
      ...draft,
      completenessRequirements: {
        ...completeness,
        [key]: updated,
      },
    });
  }

  function handleSave() {
    if (value) {
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

      {/* Completeness Requirements */}
      <div className="space-y-space-2">
        <label className="block text-body-small text-muted-foreground font-medium">
          Completeness Requirements
        </label>
        <p className="text-caption text-muted-foreground">
          Define what metadata and field properties are required for entities in this domain.
        </p>
        <div className="space-y-space-2 mt-space-2">
          {REQUIREMENT_DEFS.map((def) => {
            const r = getReq(def.key);
            return (
              <div
                key={def.key}
                className="flex items-center gap-space-3 rounded-md border border-border/50 px-space-3 py-space-2"
              >
                {/* Enable checkbox */}
                <input
                  type="checkbox"
                  checked={r.enabled}
                  onChange={(e) =>
                    setReq(def.key, { ...r, enabled: e.target.checked })
                  }
                  className="rounded border-border accent-primary"
                  id={`req-${def.key}`}
                />
                <label
                  htmlFor={`req-${def.key}`}
                  className="flex-1 text-body-small text-foreground cursor-pointer select-none"
                >
                  {def.label}
                </label>

                {/* Min count input for tags */}
                {def.hasMinCount && r.enabled && (
                  <input
                    type="number"
                    min={1}
                    value={(r.params?.minCount as number) ?? 1}
                    onChange={(e) =>
                      setReq(def.key, {
                        ...r,
                        params: { ...r.params, minCount: Math.max(1, parseInt(e.target.value) || 1) },
                      })
                    }
                    className="w-14 bg-muted rounded px-1.5 py-0.5 text-caption text-foreground outline-none text-center"
                  />
                )}

                {/* Severity dropdown */}
                <select
                  value={r.severity}
                  onChange={(e) =>
                    setReq(def.key, {
                      ...r,
                      severity: e.target.value as "error" | "warning",
                    })
                  }
                  disabled={!r.enabled}
                  className="bg-muted rounded px-space-2 py-0.5 text-caption text-foreground outline-none disabled:opacity-40"
                >
                  <option value="warning">Warning</option>
                  <option value="error">Error</option>
                </select>
              </div>
            );
          })}
        </div>
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

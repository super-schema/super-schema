"use client";

import { useState } from "react";
import { Plus, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ClassificationPicker } from "@/components/custom/ClassificationPicker";
import type { Governance } from "@/types/schemas/typespec-decorator.schema";

const RETENTION_OPTIONS = [
  { value: "", label: "Not set" },
  { value: "30d", label: "30 days" },
  { value: "90d", label: "90 days" },
  { value: "1y", label: "1 year" },
  { value: "3y", label: "3 years" },
  { value: "5y", label: "5 years" },
  { value: "7y", label: "7 years" },
  { value: "indefinite", label: "Indefinite" },
];

const ANONYMIZATION_OPTIONS = [
  { value: "", label: "None" },
  { value: "mask", label: "Mask" },
  { value: "hash", label: "Hash" },
  { value: "redact", label: "Redact" },
  { value: "pseudonymize", label: "Pseudonymize" },
];

const ENCRYPTION_OPTIONS = [
  { value: "", label: "None" },
  { value: "AES-256", label: "AES-256" },
  { value: "field-level", label: "Field-level" },
];

const QUALITY_RULE_TYPES = [
  "not-null",
  "unique",
  "range",
  "regex",
  "enum",
  "custom",
];

interface GovernancePanelProps {
  governance: Governance;
  onChange: (governance: Governance) => void;
  /** Classification from field.classification (single source of truth) */
  fieldClassification: string | null;
  /** Callback to update field.classification directly */
  onClassificationChange: (classification: string | null) => void;
}

export function GovernancePanel({ governance, onChange, fieldClassification, onClassificationChange }: GovernancePanelProps) {
  const [newAttrKey, setNewAttrKey] = useState("");
  const [newAttrValue, setNewAttrValue] = useState("");

  function update(partial: Partial<Governance>) {
    onChange({ ...governance, ...partial });
  }

  const qualityRules = governance.qualityRules ?? [];
  const lineage = governance.lineage ?? {};
  const operationalHints = governance.operationalHints ?? {};
  const customAttributes = governance.customAttributes ?? {};
  const customEntries = Object.entries(customAttributes);

  // Count active governance settings for the badge
  const activeCount =
    (fieldClassification ? 1 : 0) +
    (governance.retention ? 1 : 0) +
    (governance.anonymization ? 1 : 0) +
    (governance.encryption ? 1 : 0) +
    qualityRules.length +
    (lineage.source ? 1 : 0) +
    (lineage.upstream?.length ?? 0) +
    (lineage.downstream?.length ?? 0) +
    Object.values(operationalHints).filter(Boolean).length +
    customEntries.length;

  return (
    <div className="space-y-space-4 pb-space-2">
      {/* Active count badge */}
      {activeCount > 0 && (
        <Badge variant="secondary" className="text-[10px]">
          {activeCount} governance setting{activeCount !== 1 ? "s" : ""}
        </Badge>
      )}

      {/* Section 1: Classification (source of truth: field.classification) */}
      <div>
        <label className="text-caption text-muted-foreground mb-1 block">
          Classification
        </label>
        <div className="flex items-center gap-space-3">
          <ClassificationPicker
            value={fieldClassification}
            onChange={(level) => onClassificationChange(level)}
          />
        </div>
      </div>

      {/* Section 2: Data Protection */}
      <div className="border-t border-border/50 pt-space-3">
        <label className="text-caption text-muted-foreground mb-2 block">
          Data Protection
        </label>
        <div className="grid grid-cols-3 gap-space-3">
          <div>
            <label className="text-[10px] text-muted-foreground mb-0.5 block">
              Retention
            </label>
            <select
              value={governance.retention ?? ""}
              onChange={(e) =>
                update({ retention: e.target.value || null })
              }
              className="h-7 w-full rounded border border-border bg-background px-2 text-body-small text-foreground"
            >
              {RETENTION_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="text-[10px] text-muted-foreground mb-0.5 block">
              Anonymization
            </label>
            <select
              value={governance.anonymization ?? ""}
              onChange={(e) =>
                update({ anonymization: e.target.value || null })
              }
              className="h-7 w-full rounded border border-border bg-background px-2 text-body-small text-foreground"
            >
              {ANONYMIZATION_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="text-[10px] text-muted-foreground mb-0.5 block">
              Encryption
            </label>
            <select
              value={governance.encryption ?? ""}
              onChange={(e) =>
                update({ encryption: e.target.value || null })
              }
              className="h-7 w-full rounded border border-border bg-background px-2 text-body-small text-foreground"
            >
              {ENCRYPTION_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {/* Section 3: Quality Rules */}
      <div className="border-t border-border/50 pt-space-3">
        <label className="text-caption text-muted-foreground mb-2 block">
          Quality Rules
        </label>
        <div className="space-y-1">
          {qualityRules.map((rule, idx) => (
            <div key={idx} className="flex items-center gap-2">
              <select
                value={rule.type}
                onChange={(e) => {
                  const next = [...qualityRules];
                  next[idx] = { ...rule, type: e.target.value };
                  update({ qualityRules: next });
                }}
                className="h-6 rounded border border-border bg-background px-2 text-caption text-foreground w-32"
              >
                {QUALITY_RULE_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>

              {/* Type-specific param inputs */}
              {rule.type === "range" && (
                <div className="flex items-center gap-1">
                  <Input
                    value={
                      rule.params.min != null ? String(rule.params.min) : ""
                    }
                    onChange={(e) => {
                      const next = [...qualityRules];
                      next[idx] = {
                        ...rule,
                        params: {
                          ...rule.params,
                          min: e.target.value ? Number(e.target.value) : undefined,
                        },
                      };
                      update({ qualityRules: next });
                    }}
                    placeholder="min"
                    className="h-6 text-caption w-16 font-mono"
                  />
                  <span className="text-caption text-muted-foreground">-</span>
                  <Input
                    value={
                      rule.params.max != null ? String(rule.params.max) : ""
                    }
                    onChange={(e) => {
                      const next = [...qualityRules];
                      next[idx] = {
                        ...rule,
                        params: {
                          ...rule.params,
                          max: e.target.value ? Number(e.target.value) : undefined,
                        },
                      };
                      update({ qualityRules: next });
                    }}
                    placeholder="max"
                    className="h-6 text-caption w-16 font-mono"
                  />
                </div>
              )}

              {rule.type === "regex" && (
                <Input
                  value={
                    rule.params.pattern != null
                      ? String(rule.params.pattern)
                      : ""
                  }
                  onChange={(e) => {
                    const next = [...qualityRules];
                    next[idx] = {
                      ...rule,
                      params: { ...rule.params, pattern: e.target.value },
                    };
                    update({ qualityRules: next });
                  }}
                  placeholder="^[A-Z]+$"
                  className="h-6 text-caption flex-1 font-mono"
                />
              )}

              {rule.type === "enum" && (
                <Input
                  value={
                    rule.params.values != null
                      ? String(rule.params.values)
                      : ""
                  }
                  onChange={(e) => {
                    const next = [...qualityRules];
                    next[idx] = {
                      ...rule,
                      params: { ...rule.params, values: e.target.value },
                    };
                    update({ qualityRules: next });
                  }}
                  placeholder="val1, val2, val3"
                  className="h-6 text-caption flex-1 font-mono"
                />
              )}

              {rule.type === "custom" && (
                <Input
                  value={
                    rule.params.expression != null
                      ? String(rule.params.expression)
                      : ""
                  }
                  onChange={(e) => {
                    const next = [...qualityRules];
                    next[idx] = {
                      ...rule,
                      params: { ...rule.params, expression: e.target.value },
                    };
                    update({ qualityRules: next });
                  }}
                  placeholder="Custom expression"
                  className="h-6 text-caption flex-1 font-mono"
                />
              )}

              <button
                onClick={() => {
                  const next = qualityRules.filter((_, i) => i !== idx);
                  update({ qualityRules: next });
                }}
                className="p-0.5 text-muted-foreground hover:text-destructive shrink-0"
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          ))}

          <Button
            size="icon-xs"
            variant="ghost"
            onClick={() =>
              update({
                qualityRules: [
                  ...qualityRules,
                  { type: "not-null", params: {} },
                ],
              })
            }
            className="gap-1 w-auto px-2"
          >
            <Plus className="w-3 h-3" />
            <span className="text-caption">Add rule</span>
          </Button>
        </div>
      </div>

      {/* Section 4: Lineage */}
      <div className="border-t border-border/50 pt-space-3">
        <label className="text-caption text-muted-foreground mb-2 block">
          Lineage
        </label>
        <div className="space-y-space-2">
          <div>
            <label className="text-[10px] text-muted-foreground mb-0.5 block">
              Source
            </label>
            <Input
              value={lineage.source ?? ""}
              onChange={(e) =>
                update({
                  lineage: {
                    ...lineage,
                    source: e.target.value || null,
                  },
                })
              }
              placeholder="e.g. legacy_users.user_id"
              className="h-7 text-body-small font-mono w-full"
            />
          </div>

          <div className="grid grid-cols-2 gap-space-3">
            <div>
              <label className="text-[10px] text-muted-foreground mb-0.5 block">
                Upstream (comma-separated)
              </label>
              <Input
                value={(lineage.upstream ?? []).join(", ")}
                onChange={(e) =>
                  update({
                    lineage: {
                      ...lineage,
                      upstream: e.target.value
                        ? e.target.value.split(",").map((s) => s.trim()).filter(Boolean)
                        : [],
                    },
                  })
                }
                placeholder="system.field1, system.field2"
                className="h-7 text-body-small font-mono"
              />
            </div>

            <div>
              <label className="text-[10px] text-muted-foreground mb-0.5 block">
                Downstream (comma-separated)
              </label>
              <Input
                value={(lineage.downstream ?? []).join(", ")}
                onChange={(e) =>
                  update({
                    lineage: {
                      ...lineage,
                      downstream: e.target.value
                        ? e.target.value.split(",").map((s) => s.trim()).filter(Boolean)
                        : [],
                    },
                  })
                }
                placeholder="analytics.dim_user"
                className="h-7 text-body-small font-mono"
              />
            </div>
          </div>
        </div>
      </div>

      {/* Section 5: Operational Hints */}
      <div className="border-t border-border/50 pt-space-3">
        <label className="text-caption text-muted-foreground mb-2 block">
          Operational Hints
        </label>
        <div className="flex items-center gap-space-6">
          <label className="flex items-center gap-2 text-body-small text-muted-foreground cursor-pointer">
            <input
              type="checkbox"
              checked={operationalHints.partition ?? false}
              onChange={(e) =>
                update({
                  operationalHints: {
                    ...operationalHints,
                    partition: e.target.checked,
                  },
                })
              }
              className="accent-primary"
            />
            Partition key
          </label>

          <label className="flex items-center gap-2 text-body-small text-muted-foreground cursor-pointer">
            <input
              type="checkbox"
              checked={operationalHints.index ?? false}
              onChange={(e) =>
                update({
                  operationalHints: {
                    ...operationalHints,
                    index: e.target.checked,
                  },
                })
              }
              className="accent-primary"
            />
            Index
          </label>

          <label className="flex items-center gap-2 text-body-small text-muted-foreground cursor-pointer">
            <input
              type="checkbox"
              checked={operationalHints.cluster ?? false}
              onChange={(e) =>
                update({
                  operationalHints: {
                    ...operationalHints,
                    cluster: e.target.checked,
                  },
                })
              }
              className="accent-primary"
            />
            Cluster key
          </label>
        </div>
      </div>

      {/* Section 6: Custom Governance Attributes */}
      <div className="border-t border-border/50 pt-space-3">
        <label className="text-caption text-muted-foreground mb-2 block">
          Custom Governance Attributes
        </label>
        <div className="space-y-1">
          {customEntries.map(([key, val]) => (
            <div key={key} className="flex items-center gap-2">
              <span className="text-caption font-mono text-muted-foreground w-40 truncate">
                {key}
              </span>
              <span className="text-caption text-muted-foreground/50">=</span>
              <span className="text-caption font-mono text-foreground truncate flex-1">
                {val}
              </span>
              <button
                onClick={() => {
                  const next = { ...customAttributes };
                  delete next[key];
                  update({ customAttributes: next });
                }}
                className="p-0.5 text-muted-foreground hover:text-destructive shrink-0"
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          ))}

          {/* Add new attribute */}
          <div className="flex items-center gap-2">
            <Input
              value={newAttrKey}
              onChange={(e) => setNewAttrKey(e.target.value)}
              placeholder="attribute-name"
              className="h-6 text-caption w-40 font-mono"
              onKeyDown={(e) => {
                if (e.key === "Enter" && newAttrKey.trim()) {
                  update({
                    customAttributes: {
                      ...customAttributes,
                      [newAttrKey.trim()]: newAttrValue,
                    },
                  });
                  setNewAttrKey("");
                  setNewAttrValue("");
                }
              }}
            />
            <span className="text-caption text-muted-foreground/50">=</span>
            <Input
              value={newAttrValue}
              onChange={(e) => setNewAttrValue(e.target.value)}
              placeholder="value"
              className="h-6 text-caption flex-1 font-mono"
              onKeyDown={(e) => {
                if (e.key === "Enter" && newAttrKey.trim()) {
                  update({
                    customAttributes: {
                      ...customAttributes,
                      [newAttrKey.trim()]: newAttrValue,
                    },
                  });
                  setNewAttrKey("");
                  setNewAttrValue("");
                }
              }}
            />
            <Button
              size="icon-xs"
              variant="ghost"
              disabled={!newAttrKey.trim()}
              onClick={() => {
                update({
                  customAttributes: {
                    ...customAttributes,
                    [newAttrKey.trim()]: newAttrValue,
                  },
                });
                setNewAttrKey("");
                setNewAttrValue("");
              }}
            >
              <Plus className="w-3 h-3" />
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

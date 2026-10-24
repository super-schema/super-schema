"use client";

import { useState } from "react";
import {
  Clock,
  Calendar,
  Filter,
  Infinity,
  Trash2,
  Archive,
  ShieldAlert,
  Bell,
  Save,
  Loader2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  RetentionPolicySchema,
  formatRetentionSummary,
  type RetentionPolicy,
  type RetentionStrategy,
  type RetentionAction,
  type PeriodUnit,
} from "@/types/schemas/retention-policy.schema";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface RetentionPolicyEditorProps {
  entityId: string;
  entityName: string;
  fields: { name: string; type: string }[];
  currentPolicy: RetentionPolicy | null;
  onSave: (entityId: string, policy: RetentionPolicy) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Strategy config
// ---------------------------------------------------------------------------

const STRATEGIES: { value: RetentionStrategy; label: string; icon: typeof Clock; description: string }[] = [
  { value: "age-based", label: "Age-Based", icon: Calendar, description: "Delete/archive after a duration from a date field" },
  { value: "condition-based", label: "Condition", icon: Filter, description: "Trigger on a SQL-like condition" },
  { value: "rolling-window", label: "Rolling Window", icon: Clock, description: "Keep only the last N days/months/years" },
  { value: "indefinite", label: "Indefinite", icon: Infinity, description: "Retain forever (legal hold)" },
];

const ACTIONS: { value: RetentionAction; label: string; icon: typeof Trash2 }[] = [
  { value: "delete", label: "Delete", icon: Trash2 },
  { value: "archive", label: "Archive", icon: Archive },
  { value: "anonymize", label: "Anonymize", icon: ShieldAlert },
  { value: "notify-only", label: "Notify Only", icon: Bell },
];

const PERIOD_UNITS: { value: PeriodUnit; label: string }[] = [
  { value: "days", label: "Days" },
  { value: "months", label: "Months" },
  { value: "years", label: "Years" },
];

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function RetentionPolicyEditor({
  entityId,
  entityName,
  fields,
  currentPolicy,
  onSave,
}: RetentionPolicyEditorProps) {
  const [strategy, setStrategy] = useState<RetentionStrategy>(currentPolicy?.strategy ?? "age-based");
  const [period, setPeriod] = useState<number>(currentPolicy?.period ?? 90);
  const [periodUnit, setPeriodUnit] = useState<PeriodUnit>(currentPolicy?.periodUnit ?? "days");
  const [referenceField, setReferenceField] = useState<string>(currentPolicy?.referenceField ?? "");
  const [condition, setCondition] = useState<string>(currentPolicy?.condition ?? "");
  const [action, setAction] = useState<RetentionAction>(currentPolicy?.action ?? "delete");
  const [description, setDescription] = useState<string>(currentPolicy?.description ?? "");
  const [isSaving, setIsSaving] = useState(false);

  // Date/timestamp fields for reference field selector
  const dateFields = fields.filter((f) =>
    ["plainDate", "utcDateTime", "offsetDateTime", "unixTimestamp32", "plainTime"].includes(f.type)
  );

  function buildPolicy(): RetentionPolicy {
    const policy: RetentionPolicy = { strategy, action };

    if (strategy === "age-based" || strategy === "rolling-window") {
      policy.period = period;
      policy.periodUnit = periodUnit;
      if (referenceField) policy.referenceField = referenceField;
    }

    if (strategy === "condition-based" && condition) {
      policy.condition = condition;
    }

    if (description) policy.description = description;

    return policy;
  }

  async function handleSave() {
    const policy = buildPolicy();
    const parsed = RetentionPolicySchema.safeParse(policy);
    if (!parsed.success) return;

    setIsSaving(true);
    try {
      await onSave(entityId, parsed.data);
    } finally {
      setIsSaving(false);
    }
  }

  const preview = formatRetentionSummary(buildPolicy());

  return (
    <div className="space-y-space-4" data-testid="retention-policy-editor">
      <div className="flex items-center justify-between">
        <h3 className="text-heading-3 text-foreground">{entityName}</h3>
        <Badge variant="secondary" className="text-caption" data-testid="retention-badge">
          {preview}
        </Badge>
      </div>

      {/* Strategy selector */}
      <div>
        <label className="text-caption text-muted-foreground uppercase tracking-wider block mb-space-2">
          Strategy
        </label>
        <div className="grid grid-cols-2 gap-2">
          {STRATEGIES.map((s) => (
            <button
              key={s.value}
              type="button"
              data-testid={`retention-strategy-${s.value}`}
              aria-pressed={strategy === s.value}
              onClick={() => setStrategy(s.value)}
              className={`flex items-start gap-2 p-space-3 rounded-lg border text-left transition-colors ${
                strategy === s.value
                  ? "border-primary bg-primary/5 text-foreground"
                  : "border-border text-muted-foreground hover:border-foreground/20"
              }`}
            >
              <s.icon className="w-4 h-4 mt-0.5 shrink-0" />
              <div>
                <div className="text-body-small font-medium">{s.label}</div>
                <div className="text-[11px] text-muted-foreground">{s.description}</div>
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* Strategy-specific fields */}
      {(strategy === "age-based" || strategy === "rolling-window") && (
        <div className="space-y-space-3">
          <div className="grid grid-cols-2 gap-space-3">
            <div>
              <label className="text-caption text-muted-foreground mb-1 block">
                {strategy === "rolling-window" ? "Window Size" : "Period"}
              </label>
              <div className="flex gap-1">
                <Input
                  type="number"
                  min={1}
                  data-testid="retention-period"
                  value={period}
                  onChange={(e) => setPeriod(parseInt(e.target.value) || 1)}
                  className="h-8 w-20"
                />
                <select
                  data-testid="retention-period-unit"
                  value={periodUnit}
                  onChange={(e) => setPeriodUnit(e.target.value as PeriodUnit)}
                  className="h-8 rounded-md border border-input bg-transparent px-2 text-body-small text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                >
                  {PERIOD_UNITS.map((u) => (
                    <option key={u.value} value={u.value}>{u.label}</option>
                  ))}
                </select>
              </div>
            </div>

            <div>
              <label className="text-caption text-muted-foreground mb-1 block">
                Reference Field
              </label>
              <select
                data-testid="retention-reference-field"
                value={referenceField}
                onChange={(e) => setReferenceField(e.target.value)}
                className="h-8 w-full rounded-md border border-input bg-transparent px-2 text-body-small text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
              >
                <option value="">Select a date field...</option>
                {dateFields.map((f) => (
                  <option key={f.name} value={f.name}>{f.name} ({f.type})</option>
                ))}
                {/* Allow any field name for flexibility */}
                {fields
                  .filter((f) => !dateFields.some((df) => df.name === f.name))
                  .map((f) => (
                    <option key={f.name} value={f.name}>{f.name} ({f.type})</option>
                  ))}
              </select>
            </div>
          </div>
        </div>
      )}

      {strategy === "condition-based" && (
        <div className="space-y-space-2">
          <label className="text-caption text-muted-foreground mb-1 block">
            SQL Condition
          </label>
          <textarea
            data-testid="retention-condition"
            value={condition}
            onChange={(e) => setCondition(e.target.value)}
            placeholder="status = 'DELETED' AND created_at < NOW() - INTERVAL 1 YEAR"
            rows={3}
            className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-mono-small text-foreground focus:outline-none focus:ring-1 focus:ring-ring resize-y"
            spellCheck={false}
          />
          <div className="text-[10px] text-muted-foreground/60">
            Available fields: {fields.map((f) => f.name).join(", ")}
          </div>
        </div>
      )}

      {strategy === "indefinite" && (
        <div className="rounded-lg border border-border/50 bg-muted/30 p-space-3">
          <p className="text-caption text-muted-foreground">
            Data will be retained indefinitely. Use for legal holds, audit requirements, or regulatory compliance.
          </p>
        </div>
      )}

      {/* Action selector */}
      <div>
        <label className="text-caption text-muted-foreground uppercase tracking-wider block mb-space-2">
          Action
        </label>
        <div className="flex gap-2">
          {ACTIONS.map((a) => (
            <button
              key={a.value}
              type="button"
              data-testid={`retention-action-${a.value}`}
              aria-pressed={action === a.value}
              onClick={() => setAction(a.value)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-caption transition-colors ${
                action === a.value
                  ? "border-primary bg-primary/5 text-foreground"
                  : "border-border text-muted-foreground hover:border-foreground/20"
              }`}
            >
              <a.icon className="w-3 h-3" />
              {a.label}
            </button>
          ))}
        </div>
      </div>

      {/* Description */}
      <div>
        <label className="text-caption text-muted-foreground mb-1 block">
          Description (optional)
        </label>
        <Input
          data-testid="retention-description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="e.g., GDPR compliance — delete PII after account closure"
          className="h-8"
        />
      </div>

      {/* Preview + Save */}
      <div className="flex items-center justify-between pt-space-2 border-t border-border/50">
        <div className="text-caption text-muted-foreground">
          Preview: <span data-testid="retention-preview" className="text-foreground font-medium">{preview}</span>
        </div>
        <Button onClick={handleSave} disabled={isSaving} size="sm" className="gap-1.5" data-testid="retention-save">
          {isSaving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
          Save Policy
        </Button>
      </div>
    </div>
  );
}

"use client";

import { useId, useState } from "react";
import { DATA_TYPE_HIERARCHY } from "@/lib/data-types";
import { applicableFieldRules, resolveFieldCompletenessRules } from "@/lib/validation/field-completeness";
import type { FieldCompletenessPolicy, FieldRuleId, FieldRuleLevel } from "@/types/schemas/field-completeness-policy";

const LEVEL_LABELS: Record<FieldRuleLevel, string> = { off: "Off", suggested: "Suggested", required: "Required" };

export function FieldCompletenessPolicyEditor({ value, onChange }: {
  value?: FieldCompletenessPolicy;
  onChange: (policy: FieldCompletenessPolicy) => void;
}) {
  const id = useId();
  const [type, setType] = useState("string");
  const inherited = resolveFieldCompletenessRules(type, { ...value, [type]: {} });

  function setRule(rule: FieldRuleId, level: FieldRuleLevel | "inherit") {
    const policy = { ...value };
    const rules = { ...policy[type] };
    if (level === "inherit") delete rules[rule];
    else rules[rule] = level;
    if (Object.keys(rules).length) policy[type] = rules;
    else delete policy[type];
    onChange(policy);
  }

  return (
    <fieldset className="flex min-w-0 flex-col gap-space-3" data-testid="field-completeness-policy-editor">
      <legend className="text-body-small font-medium text-foreground">Field completeness checks</legend>
      <p className="text-caption text-muted-foreground">Choose suggested or required information for each data type. Subtypes inherit their parent&apos;s settings.</p>
      <label htmlFor={`${id}-type`} className="text-body-small text-foreground">Field check data type</label>
      <select id={`${id}-type`} value={type} onChange={(event) => setType(event.target.value)} className="w-full rounded-md bg-muted px-space-3 py-1.5 text-body-small text-foreground">
        <option value="*">All field types</option>
        {DATA_TYPE_HIERARCHY.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
      </select>
      {applicableFieldRules(type).map((rule) => (
        <div key={rule.id} className="flex min-w-0 flex-wrap items-center justify-between gap-space-2 rounded-md border border-border/50 px-space-3 py-space-2">
          <label htmlFor={`${id}-${rule.id}`} className="text-body-small text-foreground">{rule.label}</label>
          <select id={`${id}-${rule.id}`} value={value?.[type]?.[rule.id] ?? "inherit"} onChange={(event) => setRule(rule.id, event.target.value as FieldRuleLevel | "inherit")} className="max-w-full rounded bg-muted px-space-2 py-1 text-caption text-foreground">
            <option value="inherit">Default ({LEVEL_LABELS[inherited[rule.id] ?? "off"]})</option>
            <option value="off">Off</option>
            <option value="suggested">Suggested</option>
            <option value="required">Required</option>
          </select>
        </div>
      ))}
      <p className="text-caption text-muted-foreground">A field is green when all enabled checks pass, and yellow when information is missing. The tooltip separates required items from suggestions.</p>
    </fieldset>
  );
}

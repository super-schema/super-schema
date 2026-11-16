"use client";
import { useId, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { FieldGroup, FieldDescription } from "@/components/ui/field";
import { AttributeControl } from "@/components/custom/FieldAttributes/AttributeControl";
import { EnumValuesEditor } from "@/components/custom/FieldAttributes/EnumValuesEditor";
import { JsonObjectControl } from "@/components/custom/FieldAttributes/JsonObjectControl";
import {
  QUALITY_RULE_TYPES,
  QUALITY_SEVERITIES,
  isKnownQualityRuleType,
  newQualityRule,
  qualityRuleErrors,
  qualityRuleLabel,
  qualityRuleSeverity,
  qualityRuleSummary,
  withQualityParam,
  type QualityRule,
  type QualityRuleField,
} from "@/lib/field-quality-rules";
import type { Governance } from "@/types/schemas/typespec-decorator.schema";

import { NativeSelect } from "@/components/ui/native-select";
/**
 * Data quality rules for the field. Each rule is a card: quick-add buttons create it with its parameters, and the card
 * exposes exactly the inputs its type needs. Unknown parameter keys survive every edit.
 */
export function QualityPanel({
  governance: g,
  onChange,
}: {
  governance: Governance;
  onChange: (v: Governance) => void;
}) {
  const rules = (g.qualityRules ?? []) as QualityRule[];
  function setRules(next: QualityRule[]) {
    onChange({ ...g, qualityRules: next });
  }
  return (
    <FieldGroup>
      <FieldDescription>
        Dataset and business assertions for external quality tools. These do not
        automatically run against production data. Use Validation for payload
        bounds and patterns.
      </FieldDescription>
      <div role="group" aria-label="Add a quality rule" className="flex flex-wrap gap-2">
        {QUALITY_RULE_TYPES.map((type) => {
          const present = rules.some((r) => r.type === type.id);
          const blocked = type.singleton && present;
          return (
            <Button
              key={type.id}
              type="button"
              size="sm"
              variant="outline"
              disabled={blocked}
              aria-label={`Add ${type.label} rule`}
              title={blocked ? `A field has one ${type.label} rule` : type.description}
              onClick={() => setRules([...rules, newQualityRule(type.id)])}
            >
              <Plus aria-hidden="true" />
              {type.label}
            </Button>
          );
        })}
      </div>
      {rules.length === 0 && (
        <FieldDescription>No quality rules yet. Add one above.</FieldDescription>
      )}
      {rules.map((rule, index) => (
        <RuleCard
          key={index}
          index={index}
          rule={rule}
          onChange={(next) =>
            setRules(rules.map((r, i) => (i === index ? next : r)))
          }
          onRemove={() => setRules(rules.filter((_, i) => i !== index))}
        />
      ))}
    </FieldGroup>
  );
}

function RuleCard({
  index,
  rule,
  onChange,
  onRemove,
}: {
  index: number;
  rule: QualityRule;
  onChange: (rule: QualityRule) => void;
  onRemove: () => void;
}) {
  const id = useId();
  const [sample, setSample] = useState("");
  const params = rule.params;
  const label = qualityRuleLabel(rule.type);
  const scope = `${label} rule ${index + 1}`;
  const description = QUALITY_RULE_TYPES.find((t) => t.id === rule.type)?.description;
  const errors = qualityRuleErrors(rule);
  const errorFor = (field: QualityRuleField) =>
    errors.find((e) => e.field === field)?.message;
  const setParam = (key: string, value: unknown) =>
    onChange({ ...rule, params: withQualityParam(params, key, value) });
  const numberOrEmpty = (key: string) =>
    typeof params[key] === "number" ? (params[key] as number) : "";
  const text = (key: string) =>
    typeof params[key] === "string" ? (params[key] as string) : "";
  const values = Array.isArray(params.values)
    ? params.values.filter((v): v is string => typeof v === "string")
    : [];
  const pattern = text("pattern");
  let testResult = "";
  if (rule.type === "regex" && pattern && sample && !errorFor("pattern")) {
    testResult = new RegExp(pattern).test(sample)
      ? "Matches the pattern"
      : "Does not match the pattern";
  }
  return (
    <section
      aria-labelledby={`${id}-title`}
      className="flex min-w-0 flex-col gap-3 rounded-md border border-border p-3"
    >
      <header className="flex min-w-0 items-start justify-between gap-2">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h3
            id={`${id}-title`}
            className="flex flex-wrap items-center gap-2 text-sm font-medium"
          >
            {label}
            {!isKnownQualityRuleType(rule.type) && (
              <Badge variant="outline">Unrecognised type</Badge>
            )}
          </h3>
          <p className="break-words text-xs text-muted-foreground">
            {qualityRuleSummary(rule)}
          </p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={`Remove ${scope}`}
          onClick={onRemove}
        >
          <Trash2 aria-hidden="true" />
        </Button>
      </header>
      {description && <FieldDescription>{description}</FieldDescription>}
      {rule.type === "range" && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <AttributeControl label="Minimum" error={errorFor("min")}>
            <Input
              type="number"
              step="any"
              aria-label={`${scope} minimum`}
              value={numberOrEmpty("min")}
              onChange={(e) =>
                setParam("min", e.target.value === "" ? undefined : Number(e.target.value))
              }
            />
          </AttributeControl>
          <AttributeControl label="Maximum" error={errorFor("max")}>
            <Input
              type="number"
              step="any"
              aria-label={`${scope} maximum`}
              value={numberOrEmpty("max")}
              onChange={(e) =>
                setParam("max", e.target.value === "" ? undefined : Number(e.target.value))
              }
            />
          </AttributeControl>
        </div>
      )}
      {rule.type === "not-null" && (
        <AttributeControl
          label="Minimum non-null share (%)"
          help="Leave empty to require every row to be non-null."
          error={errorFor("threshold")}
        >
          <Input
            type="number"
            min={0}
            max={100}
            step="any"
            aria-label={`${scope} minimum non-null percent`}
            value={numberOrEmpty("threshold")}
            onChange={(e) =>
              setParam(
                "threshold",
                e.target.value === "" ? undefined : Number(e.target.value),
              )
            }
          />
        </AttributeControl>
      )}
      {rule.type === "regex" && (
        <>
          <AttributeControl
            label="Pattern"
            help="Regular expression, tested with the browser’s JavaScript engine."
            error={errorFor("pattern")}
          >
            <Input
              className="font-mono"
              spellCheck={false}
              aria-label={`${scope} pattern`}
              value={pattern}
              onChange={(e) => setParam("pattern", e.target.value)}
            />
          </AttributeControl>
          <AttributeControl label="Test value">
            <Input
              aria-label={`${scope} test value`}
              value={sample}
              onChange={(e) => setSample(e.target.value)}
            />
          </AttributeControl>
          {testResult && (
            <p role="status" className="text-xs">
              {testResult}
            </p>
          )}
        </>
      )}
      {rule.type === "enum" && (
        <EnumValuesEditor
          label="Allowed values"
          itemLabel="value"
          inputLabel={`${scope} new value`}
          values={values}
          onChange={(next) => setParam("values", next)}
          error={errorFor("values")}
          help="Compared exactly, so case and spacing matter."
        />
      )}
      {rule.type === "custom" && (
        <>
          <AttributeControl label="Name" help="Optional. Identifies the check in quality reports.">
            <Input
              aria-label={`${scope} name`}
              value={text("name")}
              onChange={(e) => setParam("name", e.target.value)}
            />
          </AttributeControl>
          <AttributeControl
            label="SQL or expression"
            help="Evaluated by the external quality tool, not by Super Schema."
            error={errorFor("expression")}
          >
            <Textarea
              className="font-mono"
              rows={3}
              spellCheck={false}
              aria-label={`${scope} expression`}
              value={text("expression")}
              onChange={(e) => setParam("expression", e.target.value)}
            />
          </AttributeControl>
        </>
      )}
      {!isKnownQualityRuleType(rule.type) && (
        <FieldDescription>
          This rule type is not recognised, so it has no editor. Its parameters
          are kept; edit them under Advanced.
        </FieldDescription>
      )}
      <AttributeControl
        label="Severity"
        help="Stored with the rule for the external quality tool to act on."
      >
        <NativeSelect
          aria-label={`${scope} severity`}
          value={qualityRuleSeverity(params)}
          onChange={(e) => setParam("severity", e.target.value)}
        >
          {QUALITY_SEVERITIES.map((severity) => (
            <option key={severity} value={severity}>
              {severity === "error" ? "Error" : "Warning"}
            </option>
          ))}
        </NativeSelect>
      </AttributeControl>
      <details>
        <summary className="cursor-pointer text-xs font-medium">
          Advanced: raw parameters
        </summary>
        <div className="pt-2">
          <JsonObjectControl
            label="Raw parameters"
            value={params}
            onChange={(next) => onChange({ ...rule, params: next })}
          />
        </div>
      </details>
    </section>
  );
}

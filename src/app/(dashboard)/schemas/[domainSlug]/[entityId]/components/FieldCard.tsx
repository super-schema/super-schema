"use client";

import { useState } from "react";
import { GripVertical, Trash2, Settings2, Link2 } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { ValidationIndicator } from "@/components/custom/ValidationIndicator";
import { TypePicker } from "@/components/custom/TypePicker";
import { ClassificationPicker } from "@/components/custom/ClassificationPicker";
import { getTypeInfo, isComplexType, formatComplexTypeDisplay } from "@/lib/data-types";
import { getFieldCompleteness } from "@/lib/validation/field-completeness";

interface FieldData {
  id: string;
  name: string;
  type: string;
  precision: number | null;
  scale: number | null;
  nullable: boolean;
  isKey: boolean;
  fieldNumber: number | null;
  description: string;
  classification: string | null;
  aliases: string[];
  decorators: Record<string, unknown>;
  sortOrder: number;
}

function needsPrecisionScale(typeId: string): boolean {
  const info = getTypeInfo(typeId);
  return !!info?.requiresPrecision || !!info?.requiresScale;
}

function getDecoratorSummary(decorators: Record<string, unknown>): string[] {
  const tags: string[] = [];
  const policy = (decorators.policy || {}) as Record<string, string>;
  if (policy.retention) tags.push(`retention: ${policy.retention}`);
  if (policy.anonymization) tags.push(`anon: ${policy.anonymization}`);
  if (policy.encryption) tags.push(`encrypt: ${policy.encryption}`);
  const evolution = (decorators.evolution || {}) as Record<string, unknown>;
  if (evolution.deprecated) tags.push("deprecated");
  const ts = (decorators.typespec || {}) as Record<string, Record<string, unknown>>;
  if (ts.identity?.key) tags.push("@key");
  if (ts.identity?.secret) tags.push("@secret");
  if (ts.identity?.format) tags.push(`@format(${ts.identity.format})`);
  const validationCount = Object.values(ts.validation ?? {}).filter((v) => v != null).length;
  if (validationCount > 0) tags.push(`${validationCount} validator${validationCount !== 1 ? "s" : ""}`);
  if (ts.versioning?.added) tags.push(`${ts.versioning.added}+`);
  return tags;
}

/** Render the type display for complex types */
function TypeDisplay({ type, decorators }: { type: string; decorators: Record<string, unknown> }) {
  if (!isComplexType(type)) return null;
  const display = formatComplexTypeDisplay(type, decorators);
  if (type === "reference") {
    return (
      <span className="font-mono text-[13px] text-info flex items-center gap-1">
        <Link2 className="w-3 h-3" />
        {display}
      </span>
    );
  }
  return <span className="font-mono text-[13px] text-muted-foreground">{display}</span>;
}

interface FieldCardProps {
  field: FieldData;
  index: number;
  isSelected: boolean;
  isReadOnly: boolean;
  onFieldSelect?: (fieldId: string) => void;
  onUpdateField: (id: string, data: Partial<FieldData>) => Promise<void>;
  onDeleteField: (id: string) => Promise<void>;
  onNavigateStudio: (fieldId: string) => void;
}

export function FieldCard({
  field,
  index,
  isSelected,
  isReadOnly,
  onFieldSelect,
  onUpdateField,
  onDeleteField,
  onNavigateStudio,
}: FieldCardProps) {
  const [editingField, setEditingField] = useState(false);

  const fc = getFieldCompleteness(field);
  const tooltipContent =
    fc.status === "complete"
      ? "Field complete"
      : fc.status === "error"
        ? `Missing: ${fc.missing.join(", ")}`
        : `Suggestions: ${fc.suggestions.join(", ")}`;
  const decoratorTags = getDecoratorSummary(field.decorators);
  const fieldEvolution = (field.decorators?.evolution || {}) as Record<string, unknown>;
  const isFieldDeprecated = !!fieldEvolution.deprecated;

  return (
    <div
      className={`surface-glass rounded-lg border transition-colors group cursor-pointer ${
        isSelected
          ? "border-primary ring-1 ring-primary/30"
          : "border-border/50 hover:border-border"
      }`}
      onDoubleClick={() => onNavigateStudio(field.id)}
      onClick={(e) => {
        const target = e.target as HTMLElement;
        const interactive = target.closest("input, button, select, textarea, [role='combobox']");
        if (!interactive && onFieldSelect) {
          onFieldSelect(field.id);
        }
      }}
    >
      {/* Main row */}
      <div className="flex items-center gap-space-2 px-space-3 py-space-2">
        {/* Index */}
        <span className="text-[10px] text-muted-foreground/40 font-mono w-4 text-right shrink-0 select-none">
          {index + 1}
        </span>

        {/* Validation */}
        <ValidationIndicator status={fc.status} tooltipContent={tooltipContent} />

        {/* Drag handle */}
        <div className="text-muted-foreground/30 group-hover:text-muted-foreground cursor-grab">
          <GripVertical className="w-4 h-4" />
        </div>

        {/* Name */}
        <div className="min-w-0 max-w-[120px]">
          {editingField && !isReadOnly ? (
            <Input
              defaultValue={field.name}
              className="h-7 font-mono text-body-small"
              autoFocus
              onBlur={(e) => {
                if (e.target.value !== field.name) {
                  onUpdateField(field.id, { name: e.target.value });
                }
                setEditingField(false);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                if (e.key === "Escape") setEditingField(false);
              }}
            />
          ) : (
            <span
              className={`font-mono text-body-small text-foreground truncate block ${isReadOnly ? "cursor-default" : "cursor-text"} ${isFieldDeprecated ? "line-through" : ""}`}
              onClick={() => !isReadOnly && setEditingField(true)}
            >
              {field.name}
            </span>
          )}
        </div>

        {/* Deprecated badge */}
        {isFieldDeprecated && (
          <Badge className="text-[10px] h-4 px-1 shrink-0" style={{ backgroundColor: "#e88a3b", color: "#fff" }}>
            Deprecated
          </Badge>
        )}

        {/* Tags area */}
        <div className="flex items-center gap-1 flex-wrap flex-1 min-w-0">
          {/* Type badge */}
          {isComplexType(field.type) ? (
            <TypeDisplay type={field.type} decorators={field.decorators} />
          ) : (
            <div className="shrink-0">
              <TypePicker
                value={field.type}
                onChange={(t) => {
                  const update: Partial<FieldData> = { type: t };
                  if (!needsPrecisionScale(t)) {
                    update.precision = null;
                    update.scale = null;
                  }
                  onUpdateField(field.id, update);
                }}
                compact
              />
            </div>
          )}

          {/* Precision/Scale inline */}
          {needsPrecisionScale(field.type) && (
            <span className="text-caption text-muted-foreground font-mono">
              ({field.precision ?? "?"},{field.scale ?? "?"})
            </span>
          )}

          {/* Field number badge */}
          {field.fieldNumber != null && (
            <Badge variant="outline" className="text-[10px] h-4 px-1 font-mono">
              #{field.fieldNumber}
            </Badge>
          )}

          {/* Key badge */}
          {field.isKey && (
            <Badge variant="warning" className="text-[10px] h-4 px-1">
              KEY
            </Badge>
          )}

          {/* Nullable badge */}
          {!field.nullable && !field.isKey && (
            <Badge variant="outline" className="text-[10px] h-4 px-1">
              NOT NULL
            </Badge>
          )}

          {/* Classification */}
          <ClassificationPicker
            value={field.classification}
            onChange={(cls) => onUpdateField(field.id, { classification: cls })}
          />

          {/* Aliases */}
          {field.aliases.length > 0 &&
            field.aliases.map((alias) => (
              <Badge key={alias} variant="secondary" className="text-[10px] h-4 px-1 font-mono">
                {alias}
              </Badge>
            ))}

          {/* Decorator tags */}
          {decoratorTags.map((tag) => (
            <Badge key={tag} variant="outline" className="text-[10px] h-4 px-1">
              {tag}
            </Badge>
          ))}

          {/* Description preview */}
          {field.description && (
            <span className="text-caption text-muted-foreground/60 truncate max-w-[200px]">
              {field.description}
            </span>
          )}
        </div>

        {/* Expand / actions */}
        <div className="flex items-center gap-1 shrink-0">
          <button
            onClick={() => onNavigateStudio(field.id)}
            className="p-1 text-muted-foreground/50 hover:text-foreground transition-colors rounded"
            title="Open Field Studio"
          >
            <Settings2 className="w-3.5 h-3.5" />
          </button>
          {!isReadOnly && (
            <button
              onClick={() => onDeleteField(field.id)}
              className="p-1 text-muted-foreground hover:text-destructive transition-colors rounded opacity-0 group-hover:opacity-100"
              title="Delete field"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>

    </div>
  );
}

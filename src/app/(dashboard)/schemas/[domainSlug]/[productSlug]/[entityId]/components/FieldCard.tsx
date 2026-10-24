"use client";

import { memo, useState } from "react";
import { GripVertical, Trash2, Settings2, Link2 } from "lucide-react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { ValidationIndicator } from "@/components/custom/ValidationIndicator";
import { TypePicker } from "@/components/custom/TypePicker";
import { ClassificationPicker } from "@/components/custom/ClassificationPicker";
import { getTypeInfo, isComplexType, formatComplexTypeDisplay } from "@/lib/data-types";
import { getFieldCompleteness } from "@/lib/validation/field-completeness";
import { applyReferencePick, holdsEntityReference, readFieldReference, type PickableEntity } from "@/lib/references/entity-reference";
import { ReferencePinControl, type ReferenceFieldControls } from "./ReferencePinControl";

interface FieldData {
  id: string;
  slug?: string;
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

/**
 * Render the type display for complex types. A reference that is stored fully qualified shows as `domain / product / entity`
 * (everything the user sees about a reference does); a name-only (legacy) one keeps showing its name.
 */
function TypeDisplay({ type, decorators }: { type: string; decorators: Record<string, unknown> }) {
  if (!isComplexType(type)) return null;
  const reference = type === "reference" ? readFieldReference(decorators) : undefined;
  const display =
    reference && "entity" in reference
      ? `ref(${reference.domain} / ${reference.product} / ${reference.entity})`
      : formatComplexTypeDisplay(type, decorators);
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
  /**
   * The entities of the tenant a reference can point at (with their domain and product). When given, choosing the `reference` type asks
   * for the target and writes the type and the qualified reference in one update; without it `reference` is a plain type change.
   */
  referenceTargets?: PickableEntity[];
  /** Pin control of reference fields (published versions of the referenced entity, pin / unpin). Keep it referentially stable. */
  referenceControls?: ReferenceFieldControls;
}

/**
 * Memoized: a workspace re-render (tab change, meta edit, save flash) must not
 * re-render every field row. Callers pass stable callbacks.
 */
export const FieldCard = memo(function FieldCard({
  field,
  index,
  isSelected,
  isReadOnly,
  onFieldSelect,
  onUpdateField,
  onDeleteField,
  onNavigateStudio,
  referenceTargets,
  referenceControls,
}: FieldCardProps) {
  const [editingField, setEditingField] = useState(false);

  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: field.id, disabled: isReadOnly });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : undefined,
    zIndex: isDragging ? 50 : undefined,
    boxShadow: isDragging ? "0 8px 24px rgba(0,0,0,0.18)" : undefined,
  };

  const fc = getFieldCompleteness(field);
  const tooltipContent =
    fc.status === "complete"
      ? "Field complete"
      : fc.status === "error"
        ? `Missing: ${fc.missing.join(", ")}`
        : `Suggestions: ${fc.suggestions.join(", ")}`;
  const decoratorTags = getDecoratorSummary(field.decorators);
  // The pin belongs to a reference that is stored qualified, with the id of what it references; a name-only one has nothing to pin yet.
  const storedReference = holdsEntityReference(field.type, field.decorators) ? readFieldReference(field.decorators) : undefined;
  const pinnable = storedReference && "entity" in storedReference && storedReference.entityId ? storedReference : undefined;
  const fieldEvolution = (field.decorators?.evolution || {}) as Record<string, unknown>;
  const isFieldDeprecated = !!fieldEvolution.deprecated;

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      data-testid="field-card"
      data-field={field.name}
      className={`surface-glass rounded-lg border transition-colors group cursor-pointer ${
        isSelected
          ? "border-primary ring-1 ring-primary/30"
          : "border-border/50 hover:border-border"
      }`}
      onDoubleClick={() => onNavigateStudio(field.slug || field.id)}
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
        {/* Index (display-only row number) */}
        <span className="text-[10px] text-muted-foreground/40 font-mono w-4 text-right shrink-0 select-none" aria-label={`Row ${index + 1}`}>
          {index + 1}
          {field.fieldNumber != null && field.fieldNumber !== index + 1 && (
            <span className="block text-[9px] text-muted-foreground/30" title={`Field number: ${field.fieldNumber}`}>
              (#{field.fieldNumber})
            </span>
          )}
        </span>

        {/* Validation */}
        <ValidationIndicator status={fc.status} tooltipContent={tooltipContent} />

        {/* Drag handle */}
        <div
          className="text-muted-foreground/30 group-hover:text-muted-foreground cursor-grab touch-none"
          {...listeners}
        >
          <GripVertical className="w-4 h-4" />
        </div>

        {/* Name — fixed width column for tabular alignment */}
        <div className="w-[200px] shrink-0">
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
              title={field.name}
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

        {/* Type + precision (left side, next to name) */}
        <div className="flex items-center gap-1 min-w-0">
          {isComplexType(field.type) ? (
            <>
              <TypeDisplay type={field.type} decorators={field.decorators} />
              {pinnable?.entityId && (
                <ReferencePinControl
                  fieldId={field.id}
                  referencedEntityId={pinnable.entityId}
                  referenceLabel={`${pinnable.domain} / ${pinnable.product} / ${pinnable.entity}`}
                  pinnedVersion={pinnable.pinnedVersion}
                  controls={referenceControls}
                  disabled={isReadOnly}
                />
              )}
            </>
          ) : (
            <div className="shrink-0">
              <TypePicker
                value={field.type}
                onChange={(t) => {
                  // With the reference prompt, a reference is reported WITH its target by `onComplexTypeConfig` below, which writes both in
                  // one update (the picker calls this first, with the same type).
                  if (t === "reference" && referenceTargets) return;
                  const update: Partial<FieldData> = { type: t };
                  if (!needsPrecisionScale(t)) {
                    update.precision = null;
                    update.scale = null;
                  }
                  onUpdateField(field.id, update);
                }}
                compact
                entities={referenceTargets}
                promptTypes={["reference"]}
                onComplexTypeConfig={
                  referenceTargets
                    ? (_type, config) => {
                        void onUpdateField(field.id, {
                          type: "reference",
                          precision: null,
                          scale: null,
                          decorators: applyReferencePick(field.decorators, config),
                        });
                      }
                    : undefined
                }
              />
            </div>
          )}
          {needsPrecisionScale(field.type) && (
            <span className="text-caption text-muted-foreground font-mono">
              ({field.precision ?? "?"},{field.scale ?? "?"})
            </span>
          )}
        </div>

        {/* Spacer */}
        <div className="flex-1" />

        {/* Tags (right side) — classification always last */}
        <div className="flex items-center gap-1 shrink-0">
          {field.isKey && (
            <Badge variant="warning" className="text-[10px] h-4 px-1">KEY</Badge>
          )}
          {!field.nullable && !field.isKey && (
            <Badge variant="outline" className="text-[10px] h-4 px-1">NOT NULL</Badge>
          )}
          {field.aliases.length > 0 &&
            field.aliases.map((alias) => (
              <Badge key={alias} variant="secondary" className="text-[10px] h-4 px-1 font-mono">{alias}</Badge>
            ))}
          {decoratorTags.map((tag) => (
            <Badge key={tag} variant="outline" className="text-[10px] h-4 px-1">{tag}</Badge>
          ))}
          <ClassificationPicker
            value={field.classification}
            onChange={(cls) => onUpdateField(field.id, { classification: cls })}
          />
        </div>

        {/* Expand / actions */}
        <div className="flex items-center gap-1 shrink-0">
          <button
            onClick={() => onNavigateStudio(field.slug || field.id)}
            className="p-1 text-muted-foreground/50 hover:text-foreground transition-colors rounded"
            title="Open Field Studio"
            data-testid="field-open-studio"
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

      {/* Description — always on its own line, 1-line truncated */}
      {field.description && (
        <div className="px-space-3 pb-1.5 -mt-0.5">
          <p className="text-caption text-muted-foreground/60 line-clamp-1 pl-[280px]" title={field.description}>
            {field.description}
          </p>
        </div>
      )}
    </div>
  );
});

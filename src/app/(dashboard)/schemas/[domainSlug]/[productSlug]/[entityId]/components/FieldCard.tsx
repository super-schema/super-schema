"use client";

import { memo, useCallback, useId, useState } from "react";
import { GripVertical, Trash2, Settings2, Link2, ChevronDown } from "lucide-react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ValidationIndicator } from "@/components/custom/ValidationIndicator";
import { FieldCompletenessDetails } from "@/components/custom/ValidationIndicator/FieldCompletenessDetails";
import type { FieldCompletenessPolicy } from "@/types/schemas/field-completeness-policy";
import { TypePicker } from "@/components/custom/TypePicker";
import { ClassificationPicker } from "@/components/custom/ClassificationPicker";
import { getTypeInfo, isComplexType, formatComplexTypeDisplay } from "@/lib/data-types";
import { fieldDescription, fieldDeprecation } from "@/lib/field-attributes";
import { fieldProtection } from "@/lib/compliance/field-protection";
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
  // What the field protects, as the Data Protection section stores it. Retention belongs to the entity: this reads only a legacy value on the field.
  const protection = fieldProtection(decorators, null);
  if (protection.retention) tags.push(`retention: ${protection.retention}`);
  if (protection.anonymization) tags.push(`anon: ${protection.anonymization}`);
  if (protection.encryption) tags.push(`encrypt: ${protection.encryption}`);
  if (fieldDeprecation(decorators) !== null) tags.push("deprecated");
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
      <span className="flex min-w-0 items-start gap-1 font-mono text-[13px] text-info">
        <Link2 className="mt-1 size-3 shrink-0" />
        <span className="min-w-0 [overflow-wrap:anywhere]">{display}</span>
      </span>
    );
  }
  return <span className="min-w-0 font-mono text-[13px] text-muted-foreground [overflow-wrap:anywhere]">{display}</span>;
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
  completenessPolicy?: FieldCompletenessPolicy;
}

function FieldValues({ values, isEnum, fieldName }: { values: string[]; isEnum: boolean; fieldName: string }) {
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const valuesId = useId();
  const measureValues = useCallback((node: HTMLDivElement | null) => {
    if (!node) return;
    const measure = () => setOverflows(node.scrollHeight > 20);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return (
    <div role="group" aria-label={isEnum ? "Enum values" : "Aliases"} className="flex min-w-0 items-start gap-1" onDoubleClick={(event) => event.stopPropagation()}>
      <span className="sr-only">{isEnum ? "Values" : "Aliases"}</span>
      <div id={valuesId} className={`min-w-0 flex-1 overflow-hidden ${expanded ? "" : "max-h-5"}`}>
        <div ref={measureValues} className="flex min-w-0 flex-wrap items-start gap-1">
          {values.map((value) => (
            <Badge key={value} variant="secondary" className="h-auto min-h-5 max-w-full rounded-md whitespace-normal break-all px-1 py-0 font-mono text-[10px] leading-4">{value}</Badge>
          ))}
        </div>
      </div>
      {overflows && (
        <Button type="button" variant="ghost" size="icon-xs" className="size-5 shrink-0" title={expanded ? "Show fewer values" : "Show all values"} aria-expanded={expanded} aria-controls={valuesId} aria-label={`${expanded ? "Collapse" : "Expand"} ${isEnum ? "enum values" : "aliases"} for ${fieldName}`} onClick={(event) => { event.stopPropagation(); setExpanded((current) => !current); }}>
          <ChevronDown aria-hidden="true" className={`size-3 ${expanded ? "rotate-180" : ""}`} />
        </Button>
      )}
    </div>
  );
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
  completenessPolicy,
}: FieldCardProps) {
  const description = fieldDescription(field);
  const [editingField, setEditingField] = useState(false);
  const [descriptionExpanded, setDescriptionExpanded] = useState(false);
  const [descriptionOverflows, setDescriptionOverflows] = useState(false);
  const descriptionId = useId();
  const measureDescription = useCallback((node: HTMLParagraphElement | null) => {
    if (!node || !description) return;
    const measure = () => {
      const style = window.getComputedStyle(node);
      const lineHeight = Number.parseFloat(style.lineHeight) || Number.parseFloat(style.fontSize) * 1.5;
      setDescriptionOverflows(node.scrollHeight > lineHeight * 2 + 1);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [description]);

  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
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

  const fc = getFieldCompleteness(field, completenessPolicy);
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
      data-testid="field-card"
      data-field={field.name}
      className={`surface-glass min-w-0 rounded-lg border transition-colors group cursor-pointer ${
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
      {/* Identity and actions stay together; field details have room to wrap below. */}
      <div className="grid grid-cols-[auto_auto_auto_minmax(0,1fr)_minmax(0,1fr)_auto] items-start gap-x-space-2 gap-y-space-2 px-space-3 py-space-2">
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
        <ValidationIndicator status={fc.status === "complete" ? "complete" : "suggestion"} tooltipContent={<FieldCompletenessDetails completeness={fc} />} />

        {/* Drag handle: the sortable's attributes (role=button, tabindex, aria-roledescription) belong HERE, with its listeners. On the card they made the
            whole card a button that holds the buttons, selects and inputs of the row: axe `nested-interactive`, and a screen reader that cannot reach them. */}
        <div
          ref={setActivatorNodeRef}
          {...attributes}
          aria-label={`Reorder ${field.name}`}
          className="text-muted-foreground/30 group-hover:text-muted-foreground cursor-grab touch-none"
          {...listeners}
        >
          <GripVertical className="w-4 h-4" />
        </div>

        {/* Field name on the left; type and metadata share the right column. */}
        <div className="min-w-0">
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
              className={`font-mono text-body-small text-foreground min-w-0 [overflow-wrap:anywhere] ${isReadOnly ? "cursor-default" : "cursor-text"} ${isFieldDeprecated ? "line-through" : ""}`}
              onClick={() => !isReadOnly && setEditingField(true)}
              title={field.name}
            >
              {field.name}
            </span>
          )}
        </div>
        <div className="flex min-w-0 flex-col gap-space-2">
          <div className="flex min-w-0 flex-wrap items-center gap-space-2">
            <div className="flex min-w-0 max-w-full flex-wrap items-center gap-1">
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
                <div className="min-w-0 max-w-full">
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
                    className="min-w-0 max-w-full"
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
                <span className="whitespace-nowrap text-caption text-muted-foreground font-mono">
                  ({field.precision ?? "?"},{field.scale ?? "?"})
                </span>
              )}
            </div>
            <div className="flex min-w-0 max-w-full flex-wrap items-center gap-1">
              {field.isKey && (
                <Badge variant="warning" className="text-[10px] h-4 px-1">KEY</Badge>
              )}
              {!field.nullable && !field.isKey && (
                <Badge variant="outline" className="text-[10px] h-4 px-1">NOT NULL</Badge>
              )}
              <ClassificationPicker
                value={field.classification}
                onChange={(cls) => onUpdateField(field.id, { classification: cls })}
              />
              {isFieldDeprecated && (
                <Badge className="text-[10px] h-4 px-1 shrink-0" style={{ backgroundColor: "#e88a3b", color: "#fff" }}>
                  Deprecated
                </Badge>
              )}
              {decoratorTags.map((tag) => (
                <Badge key={tag} variant="outline" className="h-auto min-h-4 max-w-full rounded-md whitespace-normal [overflow-wrap:anywhere] px-1 text-[10px]">{tag}</Badge>
              ))}
            </div>
          </div>
          {field.aliases.length > 0 && (
            <FieldValues values={field.aliases} isEnum={field.type === "enum"} fieldName={field.name} />
          )}
        </div>

        {/* Expand / actions */}
        <div className="col-start-6 row-start-1 flex shrink-0 items-center gap-1">
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={() => onNavigateStudio(field.slug || field.id)}
            className="text-muted-foreground/50 hover:text-foreground"
            title="Open Field Studio"
            aria-label="Open Field Studio"
            data-testid="field-open-studio"
          >
            <Settings2 className="w-3.5 h-3.5" />
          </Button>
          {!isReadOnly && !description && (
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={() => onDeleteField(field.id)}
              className="text-muted-foreground/50 hover:text-destructive"
              title="Delete field"
              aria-label="Delete field"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </Button>
          )}
        </div>
        {description && (
          <div className="col-span-full flex min-w-0 items-start gap-space-2" onDoubleClick={(event) => event.stopPropagation()}>
            <div className="min-w-0 flex-1">
              <p ref={measureDescription} id={descriptionId} className={`text-caption text-muted-foreground/60 [overflow-wrap:anywhere] ${descriptionExpanded ? "" : "line-clamp-2"}`} title={description}>
                {description}
              </p>
              {descriptionOverflows && (
                <Button
                  type="button"
                  variant="link"
                  size="xs"
                  className="mt-1 h-auto px-0"
                  aria-expanded={descriptionExpanded}
                  aria-controls={descriptionId}
                  aria-label={`${descriptionExpanded ? "Collapse" : "Expand"} description for ${field.name}`}
                  onClick={(event) => { event.stopPropagation(); setDescriptionExpanded((expanded) => !expanded); }}
                >
                  {descriptionExpanded ? "Show less" : "Show more"}
                </Button>
              )}
            </div>
            {!isReadOnly && (
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={() => onDeleteField(field.id)}
                className="shrink-0 text-muted-foreground/50 hover:text-destructive"
                title="Delete field"
                aria-label="Delete field"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </Button>
            )}
          </div>
        )}
      </div>
    </div>
  );
});

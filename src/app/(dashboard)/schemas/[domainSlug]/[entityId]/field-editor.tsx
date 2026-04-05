"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useCallback } from "react";
import { Plus, GripVertical, Trash2, X, Tag, Settings2, Link2, Info } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { ValidationIndicator } from "@/components/custom/ValidationIndicator";
import { TypePicker } from "@/components/custom/TypePicker";
import { ClassificationPicker } from "@/components/custom/ClassificationPicker";
import { AutocompleteInput } from "@/components/custom/AutocompleteInput";
import { getTypeInfo, isComplexType, formatComplexTypeDisplay } from "@/lib/data-types";
import {
  getFieldCompleteness,
  getEntityCompleteness,
} from "@/lib/validation/field-completeness";
import {
  getFieldNameSuggestions,
  type AutocompleteSuggestion,
  type DomainField,
} from "@/lib/autocomplete/field-name-autocomplete";
import { suggestType, type TypeSuggestion } from "@/lib/autocomplete/type-suggestion";
import { suggestClassification, type ClassificationSuggestion } from "@/lib/autocomplete/classification-suggestion";
import { trackSuggestion, isDismissed } from "@/lib/autocomplete/suggestion-tracker";
import type { RelationshipCardinality } from "@/types/schemas/entity-metadata.schema";

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

interface EntityInfo {
  id: string;
  name: string;
}

interface FieldEditorProps {
  entityId: string;
  domainSlug: string;
  fields: FieldData[];
  domainFields?: DomainField[];
  domainPolicy: Record<string, unknown> | null;
  isReadOnly?: boolean;
  availableEntities?: EntityInfo[];
  onAddField: (
    name: string,
    type: string,
    opts?: {
      description?: string;
      classification?: string | null;
      nullable?: boolean;
      isKey?: boolean;
      precision?: number | null;
      scale?: number | null;
      fieldNumber?: number | null;
      aliases?: string[];
      decorators?: Record<string, unknown>;
    }
  ) => Promise<void>;
  onUpdateField: (id: string, data: Partial<FieldData>) => Promise<void>;
  onDeleteField: (id: string) => Promise<void>;
  onFieldSelect?: (fieldId: string) => void;
  selectedFieldId?: string | null;
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
  // TypeSpec decorator summary
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

const CARDINALITY_OPTIONS: { value: RelationshipCardinality; label: string }[] = [
  { value: "one-to-one", label: "One-to-One" },
  { value: "one-to-many", label: "One-to-Many" },
  { value: "many-to-one", label: "Many-to-One" },
  { value: "many-to-many", label: "Many-to-Many" },
];

export function FieldEditor({
  entityId,
  domainSlug,
  fields,
  domainFields = [],
  domainPolicy,
  isReadOnly = false,
  availableEntities = [],
  onAddField,
  onUpdateField,
  onDeleteField,
  onFieldSelect,
  selectedFieldId,
}: FieldEditorProps) {
  const router = useRouter();

  function navigateToFieldStudio(fieldId: string) {
    router.push(`/schemas/${domainSlug}/${entityId}/fields/${fieldId}`);
  }

  // Listen for "/" slash command from global keyboard shortcuts
  useEffect(() => {
    function handleSlashCommand() {
      if (!isReadOnly) {
        setShowAddForm(true);
      }
    }
    document.addEventListener("super-schema:slash-command", handleSlashCommand);
    return () =>
      document.removeEventListener("super-schema:slash-command", handleSlashCommand);
  }, [isReadOnly]);

  // Add-field form state
  const [showAddForm, setShowAddForm] = useState(false);
  const [newName, setNewName] = useState("");
  const [newType, setNewType] = useState("string");
  const [newDescription, setNewDescription] = useState("");
  const [newNullable, setNewNullable] = useState(true);
  const [newIsKey, setNewIsKey] = useState(false);
  const [newClassification, setNewClassification] = useState<string | null>(null);
  const [newPrecision, setNewPrecision] = useState<string>("");
  const [newScale, setNewScale] = useState<string>("");
  const [newAliases, setNewAliases] = useState("");
  const [newDecorators, setNewDecorators] = useState<Record<string, unknown>>({});
  const [isAdding, setIsAdding] = useState(false);

  // Complex type state for add form
  const [newArrayElementType, setNewArrayElementType] = useState("string");
  const [newMapKeyType, setNewMapKeyType] = useState("string");
  const [newMapValueType, setNewMapValueType] = useState("string");
  const [newReferenceEntityId, setNewReferenceEntityId] = useState("");
  const [newCardinality, setNewCardinality] = useState<RelationshipCardinality>("one-to-many");
  const [newFieldNumber, setNewFieldNumber] = useState<string>("");
  const [aliasInput, setAliasInput] = useState("");

  // Auto-suggestion state
  const [typeSuggestion, setTypeSuggestion] = useState<TypeSuggestion | null>(null);
  const [classificationSuggestion, setClassificationSuggestion] = useState<ClassificationSuggestion | null>(null);
  const [classificationDismissed, setClassificationDismissed] = useState(false);

  // Autocomplete callback
  const getNameSuggestions = useCallback(
    (query: string) =>
      getFieldNameSuggestions(query, {
        existingFieldNames: fields.map((f) => f.name),
        domainFields,
        maxResults: 8,
      }),
    [fields, domainFields]
  );

  function handleNameChange(name: string) {
    setNewName(name);

    // Auto-suggest type based on name
    const ts = suggestType(name);
    setTypeSuggestion(ts);

    // Auto-suggest classification based on name
    if (!isDismissed(name)) {
      const cs = suggestClassification(name);
      setClassificationSuggestion(cs);
      setClassificationDismissed(false);
    } else {
      setClassificationSuggestion(null);
    }

    // Apply domain defaults on first interaction
    if (name.trim() && !newClassification && defaultClassification) {
      applyPolicyDefaults();
    }
  }

  function handleNameSelect(suggestion: AutocompleteSuggestion) {
    setNewName(suggestion.value);

    // Apply suggestion's type if available
    if (suggestion.suggestedType) {
      setNewType(suggestion.suggestedType);
      setTypeSuggestion(null); // Clear ghost text since we set the type
    } else {
      const ts = suggestType(suggestion.value);
      setTypeSuggestion(ts);
    }

    // Apply suggestion's classification if available
    if (suggestion.suggestedClassification) {
      setNewClassification(suggestion.suggestedClassification);
      setClassificationSuggestion(null);
    } else if (!isDismissed(suggestion.value)) {
      const cs = suggestClassification(suggestion.value);
      setClassificationSuggestion(cs);
      setClassificationDismissed(false);
    }

    if (suggestion.value.trim() && !newClassification && defaultClassification) {
      applyPolicyDefaults();
    }
  }

  function acceptTypeSuggestion() {
    if (typeSuggestion) {
      setNewType(typeSuggestion.type);
      if (typeSuggestion.isKey) {
        setNewIsKey(true);
        setNewNullable(false);
      }
      setTypeSuggestion(null);
    }
  }

  function acceptClassificationSuggestion() {
    if (classificationSuggestion) {
      setNewClassification(classificationSuggestion.level);
      trackSuggestion(newName, "accepted");
      setClassificationSuggestion(null);
    }
  }

  function dismissClassificationSuggestion() {
    if (classificationSuggestion) {
      trackSuggestion(newName, "dismissed");
      setClassificationSuggestion(null);
      setClassificationDismissed(true);
    }
  }

  // Inline editing state
  const [editingField, setEditingField] = useState<string | null>(null);
  const [editingDescription, setEditingDescription] = useState<string | null>(null);
  const [expandedField, setExpandedField] = useState<string | null>(null);
  const [expandedAliasInput, setExpandedAliasInput] = useState("");

  // Smart defaults from domain policy
  const defaultClassification = (domainPolicy?.defaultClassification as string) ?? null;
  const defaultRetention = (domainPolicy?.defaultRetention as string) ?? "";

  function applyPolicyDefaults() {
    if (defaultClassification && !newClassification) {
      setNewClassification(defaultClassification);
    }
    if (defaultRetention) {
      setNewDecorators((prev) => ({
        ...prev,
        policy: { ...(prev.policy as Record<string, unknown> || {}), retention: defaultRetention },
      }));
    }
  }

  // Intelligence: when isKey toggled on, auto-set nullable=false
  function handleNewKeyChange(checked: boolean) {
    setNewIsKey(checked);
    if (checked) setNewNullable(false);
  }

  function handleKeyToggle(fieldId: string, checked: boolean) {
    if (checked) {
      onUpdateField(fieldId, { isKey: true, nullable: false });
    } else {
      onUpdateField(fieldId, { isKey: false });
    }
  }

  function resetAddForm() {
    setNewName("");
    setNewType("string");
    setNewDescription("");
    setNewNullable(true);
    setNewIsKey(false);
    setNewClassification(null);
    setNewPrecision("");
    setNewScale("");
    setNewAliases("");
    setNewDecorators({});
    setNewArrayElementType("string");
    setNewMapKeyType("string");
    setNewMapValueType("string");
    setNewReferenceEntityId("");
    setNewCardinality("one-to-many");
    setNewFieldNumber("");
    setAliasInput("");
    setTypeSuggestion(null);
    setClassificationSuggestion(null);
    setClassificationDismissed(false);
    setShowAddForm(false);
  }

  async function handleAddField() {
    if (!newName.trim()) return;
    setIsAdding(true);
    try {
      const aliases = newAliases
        .split(",")
        .map((a) => a.trim())
        .filter(Boolean);
      const parsedPrecision = newPrecision ? Number(newPrecision) : NaN;
      const parsedScale = newScale ? Number(newScale) : NaN;
      const parsedFieldNumber = newFieldNumber ? Number(newFieldNumber) : NaN;

      // Build complex type decorators
      const decorators = { ...newDecorators };
      if (newType === "array") {
        decorators.arrayElementType = newArrayElementType;
      } else if (newType === "map") {
        decorators.mapKeyType = newMapKeyType;
        decorators.mapValueType = newMapValueType;
      } else if (newType === "reference" && newReferenceEntityId) {
        decorators.referencedEntityId = newReferenceEntityId;
        const refEntity = availableEntities.find((e) => e.id === newReferenceEntityId);
        if (refEntity) decorators.referencedEntityName = refEntity.name;
        decorators.cardinality = newCardinality;
      }

      await onAddField(newName.trim(), newType, {
        description: newDescription.trim() || undefined,
        classification: newClassification,
        nullable: newNullable,
        isKey: newIsKey,
        precision: Number.isFinite(parsedPrecision) ? Math.floor(parsedPrecision) : null,
        scale: Number.isFinite(parsedScale) ? Math.floor(parsedScale) : null,
        fieldNumber: Number.isFinite(parsedFieldNumber) ? Math.floor(parsedFieldNumber) : null,
        aliases: aliases.length > 0 ? aliases : undefined,
        decorators: Object.keys(decorators).length > 0 ? decorators : undefined,
      });
      resetAddForm();
    } catch {
      // Allow UI to recover on error
    } finally {
      setIsAdding(false);
    }
  }

  const completeness = getEntityCompleteness(fields);

  return (
    <div>
      {/* Progress bar */}
      {fields.length > 0 && (
        <div className="mb-space-4">
          <div className="flex items-center justify-between mb-space-1">
            <span className="text-caption text-muted-foreground">
              {completeness.complete} of {completeness.total} fields complete
            </span>
            <span className="text-caption text-muted-foreground">
              {completeness.percentage}%
            </span>
          </div>
          <div className="h-1 bg-muted rounded-full overflow-hidden">
            <div
              className="h-full bg-success rounded-full transition-all duration-300"
              style={{ width: `${completeness.percentage}%` }}
            />
          </div>
        </div>
      )}

      {/* Field cards */}
      <div className="space-y-1">
        {fields.map((field, index) => {
          const fc = getFieldCompleteness(field);
          const tooltipContent =
            fc.status === "complete"
              ? "Field complete"
              : fc.status === "error"
                ? `Missing: ${fc.missing.join(", ")}`
                : `Suggestions: ${fc.suggestions.join(", ")}`;
          const typeInfo = getTypeInfo(field.type);
          const decoratorTags = getDecoratorSummary(field.decorators);
          const isExpanded = expandedField === field.id;
          const fieldEvolution = (field.decorators?.evolution || {}) as Record<string, unknown>;
          const isFieldDeprecated = !!fieldEvolution.deprecated;

          return (
            <div
              key={field.id}
              className={`surface-glass rounded-lg border transition-colors group cursor-pointer ${
                selectedFieldId === field.id
                  ? "border-primary ring-1 ring-primary/30"
                  : "border-border/50 hover:border-border"
              }`}
              onDoubleClick={() => navigateToFieldStudio(field.id)}
              onClick={(e) => {
                // Only select if click is not on an interactive element
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
                  {editingField === field.id && !isReadOnly ? (
                    <Input
                      defaultValue={field.name}
                      className="h-7 font-mono text-body-small"
                      autoFocus
                      onBlur={(e) => {
                        if (e.target.value !== field.name) {
                          onUpdateField(field.id, { name: e.target.value });
                        }
                        setEditingField(null);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                        if (e.key === "Escape") setEditingField(null);
                      }}
                    />
                  ) : (
                    <span
                      className={`font-mono text-body-small text-foreground truncate block ${isReadOnly ? "cursor-default" : "cursor-text"} ${isFieldDeprecated ? "line-through" : ""}`}
                      onClick={() => !isReadOnly && setEditingField(field.id)}
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
                  {/* Type badge -- show complex type display or regular TypePicker */}
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

                  {/* Precision/Scale inline — only for decimal types */}
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
                  {field.description && !isExpanded && (
                    <span className="text-caption text-muted-foreground/60 truncate max-w-[200px]">
                      {field.description}
                    </span>
                  )}
                </div>

                {/* Expand / actions */}
                <div className="flex items-center gap-1 shrink-0">
                  <button
                    onClick={() => navigateToFieldStudio(field.id)}
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

              {/* Expanded detail panel */}
              {isExpanded && (
                <div className="border-t border-border/50 px-space-4 py-space-3 space-y-space-3 bg-accent/5">
                  {/* Description */}
                  <div>
                    <label className="text-caption text-muted-foreground mb-1 block">Description</label>
                    {editingDescription === field.id ? (
                      <Input
                        defaultValue={field.description}
                        className="h-7 text-body-small"
                        autoFocus
                        placeholder="Describe this field..."
                        onBlur={(e) => {
                          if (e.target.value !== field.description) {
                            onUpdateField(field.id, { description: e.target.value });
                          }
                          setEditingDescription(null);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                          if (e.key === "Escape") setEditingDescription(null);
                        }}
                      />
                    ) : (
                      <span
                        className={`text-body-small cursor-text block ${
                          field.description ? "text-foreground" : "text-muted-foreground/40 italic"
                        }`}
                        onClick={() => setEditingDescription(field.id)}
                      >
                        {field.description || "Click to add description..."}
                      </span>
                    )}
                  </div>

                  {/* Row of inline controls */}
                  <div className="flex items-center gap-space-4 flex-wrap">
                    {/* Nullable */}
                    <label className="flex items-center gap-1.5 text-caption text-muted-foreground">
                      <input
                        type="checkbox"
                        checked={field.nullable}
                        onChange={(e) => onUpdateField(field.id, { nullable: e.target.checked })}
                        className="accent-primary"
                        disabled={field.isKey}
                      />
                      Nullable
                      {field.isKey && <span className="text-[10px] text-muted-foreground/50">(key fields are not nullable)</span>}
                    </label>

                    {/* Key */}
                    <label className="flex items-center gap-1.5 text-caption text-muted-foreground">
                      <input
                        type="checkbox"
                        checked={field.isKey}
                        onChange={(e) => handleKeyToggle(field.id, e.target.checked)}
                        className="accent-primary"
                      />
                      Primary Key
                    </label>

                    {/* Precision/Scale — only for decimal types */}
                    {needsPrecisionScale(field.type) && (
                      <>
                        <div className="flex items-center gap-1">
                          <label className="text-caption text-muted-foreground">Precision</label>
                          <Input
                            type="number"
                            value={field.precision ?? ""}
                            onChange={(e) =>
                              onUpdateField(field.id, {
                                precision: e.target.value ? parseInt(e.target.value, 10) : null,
                              })
                            }
                            className="h-6 w-16 text-caption"
                            placeholder="18"
                          />
                        </div>
                        <div className="flex items-center gap-1">
                          <label className="text-caption text-muted-foreground">Scale</label>
                          <Input
                            type="number"
                            value={field.scale ?? ""}
                            onChange={(e) =>
                              onUpdateField(field.id, {
                                scale: e.target.value ? parseInt(e.target.value, 10) : null,
                              })
                            }
                            className="h-6 w-16 text-caption"
                            placeholder="2"
                          />
                        </div>
                      </>
                    )}

                    {/* Field Number */}
                    <div className="flex items-center gap-1">
                      <label className="text-caption text-muted-foreground flex items-center gap-1">
                        Field #
                        <span
                          className="text-[10px] text-muted-foreground/50 cursor-help"
                          title="Permanent field number for Protobuf wire compatibility -- once assigned, should not change"
                        >
                          <Info className="w-3 h-3 inline" />
                        </span>
                      </label>
                      <Input
                        type="number"
                        value={field.fieldNumber ?? ""}
                        onChange={(e) =>
                          onUpdateField(field.id, {
                            fieldNumber: e.target.value ? parseInt(e.target.value, 10) : null,
                          })
                        }
                        className="h-6 w-16 text-caption"
                        placeholder="--"
                      />
                    </div>
                  </div>

                  {/* Aliases -- tag input */}
                  <div>
                    <label className="text-caption text-muted-foreground mb-1 block">Aliases</label>
                    <div className="flex items-center gap-1 flex-wrap mb-1">
                      {field.aliases.map((alias) => (
                        <Badge
                          key={alias}
                          variant="secondary"
                          className="text-[10px] px-1.5 py-0.5 font-mono bg-muted border border-border gap-1"
                        >
                          {alias}
                          <button
                            onClick={() => {
                              const updated = field.aliases.filter((a) => a !== alias);
                              onUpdateField(field.id, { aliases: updated });
                            }}
                            className="hover:text-destructive ml-0.5"
                          >
                            <X className="w-2.5 h-2.5" />
                          </button>
                        </Badge>
                      ))}
                      <Input
                        value={expandedAliasInput}
                        onChange={(e) => setExpandedAliasInput(e.target.value)}
                        placeholder="Add alias..."
                        className="h-6 w-32 text-caption font-mono"
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && expandedAliasInput.trim()) {
                            e.preventDefault();
                            const trimmed = expandedAliasInput.trim();
                            if (!field.aliases.includes(trimmed)) {
                              onUpdateField(field.id, { aliases: [...field.aliases, trimmed] });
                            }
                            setExpandedAliasInput("");
                          }
                        }}
                      />
                    </div>
                  </div>

                  {/* Decorator policy info */}
                  {getDecoratorSummary(field.decorators).length > 0 && (
                    <div>
                      <label className="text-caption text-muted-foreground mb-1 block">Policy / Decorators</label>
                      <div className="flex items-center gap-1 flex-wrap">
                        {getDecoratorSummary(field.decorators).map((tag) => (
                          <Badge key={tag} variant="outline" className="text-[10px]">
                            {tag}
                          </Badge>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Add field form — hidden in read-only mode */}
      {isReadOnly ? null : showAddForm ? (
        <div className="mt-space-3 surface-glass rounded-xl border border-primary/20 p-space-4 space-y-space-3">
          <div className="flex items-center justify-between">
            <h4 className="text-body-small text-foreground font-medium">Add New Field</h4>
            <button
              onClick={resetAddForm}
              className="p-1 text-muted-foreground hover:text-foreground transition-colors rounded"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* Row 1: Name + Type */}
          <div className="flex items-center gap-space-3">
            <div className="w-[200px] shrink-0">
              <label className="text-caption text-muted-foreground mb-1 block">Name</label>
              <AutocompleteInput
                value={newName}
                onChange={handleNameChange}
                onSelect={handleNameSelect}
                getSuggestions={getNameSuggestions}
                placeholder="field_name"
                className="h-8 font-mono text-body-small"
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === "Tab" && typeSuggestion) {
                    e.preventDefault();
                    acceptTypeSuggestion();
                  }
                  if (e.key === "Enter" && newName.trim()) handleAddField();
                  if (e.key === "Escape") resetAddForm();
                }}
              />
            </div>
            <div className="w-[140px]">
              <label className="text-caption text-muted-foreground mb-1 block">Type</label>
              <div className="relative">
                <TypePicker
                  value={newType}
                  onChange={(t) => {
                    setNewType(t);
                    setTypeSuggestion(null);
                    setNewArrayElementType("string");
                    setNewMapKeyType("string");
                    setNewMapValueType("string");
                    setNewReferenceEntityId("");
                  }}
                />
                {/* Type ghost text suggestion */}
                {typeSuggestion && newType === "string" && (
                  <div className="absolute -bottom-5 left-0 text-[10px] text-muted-foreground italic">
                    Tab → {typeSuggestion.type}{typeSuggestion.isKey ? " (key)" : ""}
                  </div>
                )}
              </div>
            </div>

            {/* Precision/Scale — conditional */}
            {needsPrecisionScale(newType) && (
              <>
                <div className="w-[72px]">
                  <label className="text-caption text-muted-foreground mb-1 block">Precision</label>
                  <Input
                    type="number"
                    value={newPrecision}
                    onChange={(e) => setNewPrecision(e.target.value)}
                    className="h-8 text-body-small"
                    placeholder="18"
                  />
                </div>
                <div className="w-[72px]">
                  <label className="text-caption text-muted-foreground mb-1 block">Scale</label>
                  <Input
                    type="number"
                    value={newScale}
                    onChange={(e) => setNewScale(e.target.value)}
                    className="h-8 text-body-small"
                    placeholder="2"
                  />
                </div>
              </>
            )}
          </div>

          {/* Complex type secondary prompts */}
          {newType === "array" && (
            <div className="flex items-center gap-space-3">
              <div className="w-[200px]">
                <label className="text-caption text-muted-foreground mb-1 block">Element Type</label>
                <TypePicker value={newArrayElementType} onChange={(t) => setNewArrayElementType(t)} />
              </div>
              <span className="text-caption text-muted-foreground font-mono pt-5">
                = array&lt;{newArrayElementType}&gt;
              </span>
            </div>
          )}

          {newType === "map" && (
            <div className="flex items-center gap-space-3">
              <div className="w-[140px]">
                <label className="text-caption text-muted-foreground mb-1 block">Key Type</label>
                <TypePicker value={newMapKeyType} onChange={(t) => setNewMapKeyType(t)} />
              </div>
              <div className="w-[140px]">
                <label className="text-caption text-muted-foreground mb-1 block">Value Type</label>
                <TypePicker value={newMapValueType} onChange={(t) => setNewMapValueType(t)} />
              </div>
              <span className="text-caption text-muted-foreground font-mono pt-5">
                = map&lt;{newMapKeyType}, {newMapValueType}&gt;
              </span>
            </div>
          )}

          {newType === "reference" && (
            <div className="flex items-center gap-space-3">
              <div className="w-[200px]">
                <label className="text-caption text-muted-foreground mb-1 block">Referenced Entity</label>
                <select
                  value={newReferenceEntityId}
                  onChange={(e) => setNewReferenceEntityId(e.target.value)}
                  className="h-8 w-full rounded border border-border bg-background px-2 text-body-small text-foreground"
                >
                  <option value="">Select entity...</option>
                  {availableEntities.map((ent) => (
                    <option key={ent.id} value={ent.id}>{ent.name}</option>
                  ))}
                </select>
              </div>
              <div className="w-[160px]">
                <label className="text-caption text-muted-foreground mb-1 block">Cardinality</label>
                <select
                  value={newCardinality}
                  onChange={(e) => setNewCardinality(e.target.value as RelationshipCardinality)}
                  className="h-8 w-full rounded border border-border bg-background px-2 text-body-small text-foreground"
                >
                  {CARDINALITY_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </select>
              </div>
              {newReferenceEntityId && (
                <span className="text-caption text-info font-mono pt-5 flex items-center gap-1">
                  <Link2 className="w-3 h-3" />
                  ref({availableEntities.find((e) => e.id === newReferenceEntityId)?.name ?? "?"})
                </span>
              )}
            </div>
          )}

          {/* Row 2: Description */}
          <div>
            <label className="text-caption text-muted-foreground mb-1 block">Description</label>
            <Input
              value={newDescription}
              onChange={(e) => setNewDescription(e.target.value)}
              placeholder="Brief description of this field"
              className="h-8 text-body-small"
              onKeyDown={(e) => {
                if (e.key === "Enter" && newName.trim()) handleAddField();
              }}
            />
          </div>

          {/* Row 3: Constraints + Classification */}
          <div className="flex items-center gap-space-4 flex-wrap">
            <label className="flex items-center gap-1.5 text-caption text-muted-foreground">
              <input
                type="checkbox"
                checked={newNullable}
                onChange={(e) => setNewNullable(e.target.checked)}
                className="accent-primary"
                disabled={newIsKey}
              />
              Nullable
              {newIsKey && <span className="text-[10px] text-muted-foreground/50">(auto: key)</span>}
            </label>
            <label className="flex items-center gap-1.5 text-caption text-muted-foreground">
              <input
                type="checkbox"
                checked={newIsKey}
                onChange={(e) => handleNewKeyChange(e.target.checked)}
                className="accent-primary"
              />
              Primary Key
            </label>
            <div className="flex items-center gap-1.5">
              <span className="text-caption text-muted-foreground">Classification</span>
              <ClassificationPicker
                value={newClassification}
                onChange={(cls) => {
                  setNewClassification(cls);
                  setClassificationSuggestion(null); // Clear suggestion when user picks
                }}
              />
              {/* Classification suggestion badge */}
              {classificationSuggestion && !newClassification && !classificationDismissed && (
                <button
                  type="button"
                  onClick={acceptClassificationSuggestion}
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-medium bg-[rgba(229,169,59,0.15)] text-[#e5a93b] hover:bg-[rgba(229,169,59,0.25)] transition-colors"
                >
                  Suggested: {classificationSuggestion.level}
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      dismissClassificationSuggestion();
                    }}
                    className="ml-0.5 hover:text-foreground"
                  >
                    <X className="w-2.5 h-2.5" />
                  </button>
                </button>
              )}
              {defaultClassification && !newClassification && !classificationSuggestion && (
                <span className="text-[10px] text-muted-foreground/50">
                  (domain default: {defaultClassification})
                </span>
              )}
            </div>
          </div>

          {/* Row 4: Field Number */}
          <div className="flex items-center gap-space-3">
            <div className="w-[120px]">
              <label className="text-caption text-muted-foreground mb-1 flex items-center gap-1">
                Field Number
                <span
                  className="text-muted-foreground/50 cursor-help"
                  title="Permanent field number for Protobuf wire compatibility -- once assigned, should not change"
                >
                  <Info className="w-3 h-3 inline" />
                </span>
              </label>
              <Input
                type="number"
                value={newFieldNumber}
                onChange={(e) => setNewFieldNumber(e.target.value)}
                className="h-8 text-body-small"
                placeholder="--"
              />
            </div>
          </div>

          {/* Row 5: Aliases -- tag input */}
          <div>
            <label className="text-caption text-muted-foreground mb-1 block">
              Aliases <span className="text-muted-foreground/50">(press Enter to add)</span>
            </label>
            <div className="flex items-center gap-1 flex-wrap">
              {newAliases.split(",").map((a) => a.trim()).filter(Boolean).map((tag) => (
                <Badge
                  key={tag}
                  variant="secondary"
                  className="text-[10px] px-1.5 py-0.5 font-mono bg-muted border border-border gap-1"
                >
                  {tag}
                  <button
                    onClick={() => {
                      const tags = newAliases.split(",").map((a) => a.trim()).filter(Boolean);
                      setNewAliases(tags.filter((t) => t !== tag).join(", "));
                    }}
                    className="hover:text-destructive ml-0.5"
                    type="button"
                  >
                    <X className="w-2.5 h-2.5" />
                  </button>
                </Badge>
              ))}
              <Input
                value={aliasInput}
                onChange={(e) => setAliasInput(e.target.value)}
                placeholder="email, e_mail..."
                className="h-7 w-40 text-body-small font-mono"
                onKeyDown={(e) => {
                  if (e.key === "Enter" && aliasInput.trim()) {
                    e.preventDefault();
                    const tags = newAliases.split(",").map((a) => a.trim()).filter(Boolean);
                    if (!tags.includes(aliasInput.trim())) {
                      setNewAliases([...tags, aliasInput.trim()].join(", "));
                    }
                    setAliasInput("");
                  }
                  if (e.key === "Backspace" && !aliasInput) {
                    const tags = newAliases.split(",").map((a) => a.trim()).filter(Boolean);
                    if (tags.length > 0) {
                      setNewAliases(tags.slice(0, -1).join(", "));
                    }
                  }
                }}
              />
            </div>
          </div>

          {/* Row 5: Policy decorators from domain */}
          {(defaultRetention || Object.keys(newDecorators).length > 0) && (
            <div className="flex items-center gap-2 flex-wrap">
              <Tag className="w-3.5 h-3.5 text-muted-foreground/50" />
              <span className="text-caption text-muted-foreground/50">Policy defaults applied from domain:</span>
              {defaultRetention && (
                <Badge variant="outline" className="text-[10px]">
                  retention: {defaultRetention}
                </Badge>
              )}
            </div>
          )}

          {/* Actions */}
          <div className="flex items-center gap-space-2 pt-space-1">
            <Button
              size="sm"
              onClick={handleAddField}
              disabled={!newName.trim() || isAdding}
              className="gap-1"
            >
              <Plus className="w-3.5 h-3.5" />
              {isAdding ? "Adding..." : "Add Field"}
            </Button>
            <Button size="sm" variant="outline" onClick={resetAddForm}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <button
          onClick={() => {
            setShowAddForm(true);
            applyPolicyDefaults();
          }}
          className="mt-space-3 w-full flex items-center justify-center gap-2 py-space-3 rounded-lg border border-dashed border-border hover:border-primary/40 hover:bg-accent/20 text-muted-foreground hover:text-foreground transition-colors text-body-small"
        >
          <Plus className="w-4 h-4" />
          Add Field
        </button>
      )}
    </div>
  );
}

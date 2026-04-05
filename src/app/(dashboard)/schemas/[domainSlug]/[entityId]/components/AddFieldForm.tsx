"use client";

import { useState, useCallback } from "react";
import { Plus, X, Tag, Link2, Info } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { TypePicker } from "@/components/custom/TypePicker";
import { ClassificationPicker } from "@/components/custom/ClassificationPicker";
import { AutocompleteInput } from "@/components/custom/AutocompleteInput";
import { getTypeInfo } from "@/lib/data-types";
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

function needsPrecisionScale(typeId: string): boolean {
  const info = getTypeInfo(typeId);
  return !!info?.requiresPrecision || !!info?.requiresScale;
}

const CARDINALITY_OPTIONS: { value: RelationshipCardinality; label: string }[] = [
  { value: "one-to-one", label: "One-to-One" },
  { value: "one-to-many", label: "One-to-Many" },
  { value: "many-to-one", label: "Many-to-One" },
  { value: "many-to-many", label: "Many-to-Many" },
];

interface AddFieldFormProps {
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
  domainPolicy: Record<string, unknown> | null;
  fields: FieldData[];
  domainFields: DomainField[];
  availableEntities: EntityInfo[];
  onClose: () => void;
}

export function AddFieldForm({
  onAddField,
  domainPolicy,
  fields,
  domainFields,
  availableEntities,
  onClose,
}: AddFieldFormProps) {
  // Form state
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

  // Complex type state
  const [newArrayElementType, setNewArrayElementType] = useState("string");
  const [newMapKeyType, setNewMapKeyType] = useState("string");
  const [newMapValueType, setNewMapValueType] = useState("string");
  const [newReferenceEntityId, setNewReferenceEntityId] = useState("");
  const [newCardinality, setNewCardinality] = useState<RelationshipCardinality>("one-to-many");
  const [newFieldNumber, setNewFieldNumber] = useState<string>("");
  const [fieldNumberEditing, setFieldNumberEditing] = useState(false);
  const [newFormat, setNewFormat] = useState<string>("");
  const [newSecret, setNewSecret] = useState(false);
  const [aliasInput, setAliasInput] = useState("");

  // Auto-suggestion state
  const [typeSuggestion, setTypeSuggestion] = useState<TypeSuggestion | null>(null);
  const [classificationSuggestion, setClassificationSuggestion] = useState<ClassificationSuggestion | null>(null);
  const [classificationDismissed, setClassificationDismissed] = useState(false);

  // Compute auto-assigned field number
  const autoFieldNumber = (() => {
    const existingNumbers = fields
      .map((f) => f.fieldNumber)
      .filter((n): n is number => n != null);
    if (existingNumbers.length > 0) {
      return Math.max(...existingNumbers) + 1;
    }
    // Fallback: sortOrder-based
    const maxSort = fields.length > 0 ? Math.max(...fields.map((f) => f.sortOrder)) : -1;
    return maxSort + 2; // +1 for next sortOrder, +1 for field number starting at 1
  })();

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

    const ts = suggestType(name);
    setTypeSuggestion(ts);

    if (!isDismissed(name)) {
      const cs = suggestClassification(name);
      setClassificationSuggestion(cs);
      setClassificationDismissed(false);
    } else {
      setClassificationSuggestion(null);
    }

    if (name.trim() && !newClassification && defaultClassification) {
      applyPolicyDefaults();
    }
  }

  function handleNameSelect(suggestion: AutocompleteSuggestion) {
    setNewName(suggestion.value);

    if (suggestion.suggestedType) {
      setNewType(suggestion.suggestedType);
      setTypeSuggestion(null);
    } else {
      const ts = suggestType(suggestion.value);
      setTypeSuggestion(ts);
    }

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

  function handleNewKeyChange(checked: boolean) {
    setNewIsKey(checked);
    if (checked) setNewNullable(false);
  }

  function resetAndClose() {
    onClose();
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

      // Add @format and @secret to typespec identity decorators if set
      if (newFormat || newSecret) {
        const identity: Record<string, unknown> = {};
        if (newFormat) identity.format = newFormat;
        if (newSecret) identity.secret = true;
        decorators.typespec = {
          ...((decorators.typespec as Record<string, unknown>) ?? {}),
          identity,
        };
      }

      // Use auto-assigned field number if not manually overridden
      const effectiveFieldNumber = Number.isFinite(parsedFieldNumber)
        ? Math.floor(parsedFieldNumber)
        : autoFieldNumber;

      await onAddField(newName.trim(), newType, {
        description: newDescription.trim() || undefined,
        classification: newClassification,
        nullable: newNullable,
        isKey: newIsKey,
        precision: Number.isFinite(parsedPrecision) ? Math.floor(parsedPrecision) : null,
        scale: Number.isFinite(parsedScale) ? Math.floor(parsedScale) : null,
        fieldNumber: effectiveFieldNumber,
        aliases: aliases.length > 0 ? aliases : undefined,
        decorators: Object.keys(decorators).length > 0 ? decorators : undefined,
      });
      resetAndClose();
    } catch {
      // Allow UI to recover on error
    } finally {
      setIsAdding(false);
    }
  }

  return (
    <div className="mt-space-3 surface-glass rounded-xl border border-primary/20 p-space-4 space-y-space-3">
      <div className="flex items-center justify-between">
        <h4 className="text-body-small text-foreground font-medium">Add New Field</h4>
        <button
          onClick={resetAndClose}
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
              if (e.key === "Escape") resetAndClose();
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
                Tab &rarr; {typeSuggestion.type}{typeSuggestion.isKey ? " (key)" : ""}
              </div>
            )}
          </div>
        </div>

        {/* Precision/Scale -- conditional */}
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
              setClassificationSuggestion(null);
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

      {/* Row 4: @format + @secret */}
      <div className="flex items-center gap-space-4 flex-wrap">
        <div className="w-[160px]">
          <label className="text-caption text-muted-foreground mb-1 block">@format</label>
          <select
            value={newFormat}
            onChange={(e) => setNewFormat(e.target.value)}
            className="h-8 w-full rounded border border-border bg-background px-2 text-body-small text-foreground"
          >
            <option value="">None</option>
            <option value="uuid">uuid</option>
            <option value="email">email</option>
            <option value="uri">uri</option>
            <option value="date-time">date-time</option>
            <option value="password">password</option>
            <option value="ip-address">ip-address</option>
            <option value="ip-v4-address">ip-v4-address</option>
            <option value="ip-v6-address">ip-v6-address</option>
          </select>
        </div>
        <label className="flex items-center gap-1.5 text-caption text-muted-foreground pt-5">
          <input
            type="checkbox"
            checked={newSecret}
            onChange={(e) => setNewSecret(e.target.checked)}
            className="accent-primary"
          />
          @secret
        </label>
      </div>

      {/* Row 5: Field Number (auto-assigned) */}
      <div className="flex items-center gap-space-3">
        <div className="w-[200px]">
          <label className="text-caption text-muted-foreground mb-1 flex items-center gap-1">
            Field Number
            <span
              className="text-muted-foreground/50 cursor-help"
              title="Permanent field number for Protobuf wire compatibility -- once assigned, should not change"
            >
              <Info className="w-3 h-3 inline" />
            </span>
          </label>
          {fieldNumberEditing ? (
            <Input
              type="number"
              value={newFieldNumber}
              onChange={(e) => setNewFieldNumber(e.target.value)}
              className="h-8 text-body-small"
              placeholder={String(autoFieldNumber)}
              autoFocus
              onBlur={() => {
                if (!newFieldNumber.trim()) setFieldNumberEditing(false);
              }}
            />
          ) : (
            <div className="flex items-center gap-2">
              <span className="text-body-small font-mono text-foreground bg-muted px-2 py-1 rounded border border-border">
                {newFieldNumber ? newFieldNumber : autoFieldNumber}
              </span>
              <span className="text-[10px] text-muted-foreground/50">auto</span>
              <button
                type="button"
                onClick={() => setFieldNumberEditing(true)}
                className="text-[10px] text-primary hover:underline"
              >
                edit
              </button>
            </div>
          )}
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

      {/* Field Studio note */}
      <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground/60 bg-muted/30 px-3 py-1.5 rounded-md">
        <Info className="w-3.5 h-3.5 shrink-0" />
        <span>
          After creating, open <strong>Field Studio</strong> for full editing: validation, wire format, visibility, documentation, versioning, extensions, and governance.
        </span>
      </div>

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
        <Button size="sm" variant="outline" onClick={resetAndClose}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

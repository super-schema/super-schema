"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Plus, Loader2, ExternalLink, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AutocompleteInput } from "@/components/custom/AutocompleteInput";
import { TypePicker } from "@/components/custom/TypePicker";
import {
  getEntityCompleteness,
} from "@/lib/validation/field-completeness";
import {
  getFieldNameSuggestions,
  type AutocompleteSuggestion,
  type DomainField,
} from "@/lib/autocomplete/field-name-autocomplete";
import { suggestType } from "@/lib/autocomplete/type-suggestion";
import { FieldCard } from "./components/FieldCard";

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

interface FieldEditorProps {
  entityId: string;
  entitySlug?: string;
  domainSlug: string;
  fields: FieldData[];
  domainFields?: DomainField[];
  domainPolicy: Record<string, unknown> | null;
  isReadOnly?: boolean;
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
  ) => Promise<{ field?: { id: string; slug?: string } } | void>;
  onUpdateField: (id: string, data: Partial<FieldData>) => Promise<void>;
  onDeleteField: (id: string) => Promise<void>;
  onFieldSelect?: (fieldId: string) => void;
  selectedFieldId?: string | null;
}

export function FieldEditor({
  entityId,
  entitySlug,
  domainSlug,
  fields,
  domainFields = [],
  domainPolicy,
  isReadOnly = false,
  onAddField,
  onUpdateField,
  onDeleteField,
  onFieldSelect,
  selectedFieldId,
}: FieldEditorProps) {
  const router = useRouter();
  const [isCreating, setIsCreating] = useState(false);
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [newFieldName, setNewFieldName] = useState("");
  const [newFieldType, setNewFieldType] = useState("string");

  function navigateToFieldStudio(fieldId: string) {
    router.push(`/schemas/${domainSlug}/${entitySlug || entityId}/fields/${fieldId}`);
  }

  // Listen for "/" slash command from global keyboard shortcuts
  useEffect(() => {
    function handleSlashCommand() {
      if (!isReadOnly) {
        setShowCreateDialog(true);
      }
    }
    document.addEventListener("super-schema:slash-command", handleSlashCommand);
    return () =>
      document.removeEventListener("super-schema:slash-command", handleSlashCommand);
  }, [isReadOnly]);

  // Close dialog on Escape
  useEffect(() => {
    if (!showCreateDialog) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setShowCreateDialog(false);
        setNewFieldName("");
        setNewFieldType("string");
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [showCreateDialog]);

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
    setNewFieldName(name);
    // Auto-suggest type based on field name
    const ts = suggestType(name);
    if (ts && newFieldType === "string") {
      setNewFieldType(ts.type);
    }
  }

  function handleNameSelect(suggestion: AutocompleteSuggestion) {
    setNewFieldName(suggestion.value);
    if (suggestion.suggestedType) {
      setNewFieldType(suggestion.suggestedType);
    }
  }

  function resetDialog() {
    setShowCreateDialog(false);
    setNewFieldName("");
    setNewFieldType("string");
  }

  async function handleCreateAndOpenStudio() {
    if (!newFieldName.trim() || isCreating) return;
    setIsCreating(true);
    try {
      const result = await onAddField(newFieldName.trim(), newFieldType);
      const createdField = (result as { field?: { id: string; slug?: string } } | undefined)?.field;
      resetDialog();
      if (createdField) {
        navigateToFieldStudio(createdField.slug || createdField.id);
      }
    } catch {
      // Allow UI to recover on error
    } finally {
      setIsCreating(false);
    }
  }

  async function handleQuickCreate() {
    if (!newFieldName.trim() || isCreating) return;
    setIsCreating(true);
    try {
      await onAddField(newFieldName.trim(), newFieldType);
      resetDialog();
    } catch {
      // Allow UI to recover on error
    } finally {
      setIsCreating(false);
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
        {fields.map((field, index) => (
          <FieldCard
            key={field.id}
            field={field}
            index={index}
            isSelected={selectedFieldId === field.id}
            isReadOnly={isReadOnly}
            onFieldSelect={onFieldSelect}
            onUpdateField={onUpdateField}
            onDeleteField={onDeleteField}
            onNavigateStudio={navigateToFieldStudio}
          />
        ))}
      </div>

      {/* Inline quick-create dialog */}
      {!isReadOnly && showCreateDialog && (
        <div className="mt-space-3 surface-glass rounded-xl border border-primary/20 p-space-4 space-y-space-3">
          <div className="flex items-center justify-between">
            <h4 className="text-body-small text-foreground font-medium">
              New Field
            </h4>
            <button
              onClick={resetDialog}
              className="p-1 text-muted-foreground hover:text-foreground transition-colors rounded"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* Name + Type row */}
          <div className="flex items-end gap-space-3">
            <div className="flex-1 min-w-0">
              <label className="text-caption text-muted-foreground mb-1 block">
                Name
              </label>
              <AutocompleteInput
                value={newFieldName}
                onChange={handleNameChange}
                onSelect={handleNameSelect}
                getSuggestions={getNameSuggestions}
                placeholder="field_name"
                className="h-8 font-mono text-body-small"
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === "Enter" && newFieldName.trim()) {
                    handleCreateAndOpenStudio();
                  }
                }}
              />
            </div>
            <div className="w-[140px] shrink-0">
              <label className="text-caption text-muted-foreground mb-1 block">
                Type
              </label>
              <TypePicker
                value={newFieldType}
                onChange={(t) => setNewFieldType(t)}
              />
            </div>
          </div>

          {/* Action buttons */}
          <div className="flex items-center gap-space-2">
            <Button
              size="sm"
              onClick={handleCreateAndOpenStudio}
              disabled={!newFieldName.trim() || isCreating}
              className="gap-1.5"
            >
              {isCreating ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <ExternalLink className="w-3.5 h-3.5" />
              )}
              Create &amp; Open Studio
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={handleQuickCreate}
              disabled={!newFieldName.trim() || isCreating}
              className="gap-1.5"
            >
              {isCreating ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Plus className="w-3.5 h-3.5" />
              )}
              Quick Create
            </Button>
          </div>
        </div>
      )}

      {/* Add field button -- opens the inline create dialog */}
      {!isReadOnly && !showCreateDialog && (
        <button
          onClick={() => setShowCreateDialog(true)}
          className="mt-space-3 w-full flex items-center justify-center gap-2 py-space-3 rounded-lg border border-dashed border-border hover:border-primary/40 hover:bg-accent/20 text-muted-foreground hover:text-foreground transition-colors text-body-small"
        >
          <Plus className="w-4 h-4" />
          Add Field
        </button>
      )}
    </div>
  );
}

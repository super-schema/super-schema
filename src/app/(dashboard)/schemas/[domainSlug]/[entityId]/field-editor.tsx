"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Plus, Loader2 } from "lucide-react";
import {
  getEntityCompleteness,
} from "@/lib/validation/field-completeness";
import type { DomainField } from "@/lib/autocomplete/field-name-autocomplete";
import { FieldCard } from "./components/FieldCard";

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
  ) => Promise<{ field?: { id: string } } | void>;
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

  function navigateToFieldStudio(fieldId: string) {
    router.push(`/schemas/${domainSlug}/${entitySlug || entityId}/fields/${fieldId}`);
  }

  // Listen for "/" slash command from global keyboard shortcuts
  useEffect(() => {
    function handleSlashCommand() {
      if (!isReadOnly) {
        handleAddField();
      }
    }
    document.addEventListener("super-schema:slash-command", handleSlashCommand);
    return () =>
      document.removeEventListener("super-schema:slash-command", handleSlashCommand);
  }, [isReadOnly]); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleAddField() {
    if (isCreating) return;
    setIsCreating(true);
    try {
      const result = await onAddField("new_field", "string");
      const fieldId = (result as { field?: { id: string } } | undefined)?.field?.id;
      if (fieldId) {
        navigateToFieldStudio(fieldId);
      }
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

      {/* Add field button -- creates field with defaults and navigates to Field Studio */}
      {!isReadOnly && (
        <button
          onClick={handleAddField}
          disabled={isCreating}
          className="mt-space-3 w-full flex items-center justify-center gap-2 py-space-3 rounded-lg border border-dashed border-border hover:border-primary/40 hover:bg-accent/20 text-muted-foreground hover:text-foreground transition-colors text-body-small disabled:opacity-50"
        >
          {isCreating ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" />
              Creating field...
            </>
          ) : (
            <>
              <Plus className="w-4 h-4" />
              Add Field
            </>
          )}
        </button>
      )}
    </div>
  );
}

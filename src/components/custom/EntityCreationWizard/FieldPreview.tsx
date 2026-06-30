"use client";

import { useState, useRef } from "react";
import { Plus, Trash2, ArrowLeft, CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { TypePicker } from "@/components/custom/TypePicker";
import { ClassificationPicker } from "@/components/custom/ClassificationPicker";

export interface PreviewField {
  tempId: string;
  name: string;
  type: string;
  classification: string | null;
  description: string;
  confidence?: number;
}

interface FieldPreviewProps {
  entityName: string;
  entityDescription: string;
  fields: PreviewField[];
  onFieldsChange: (fields: PreviewField[]) => void;
  onEntityNameChange: (name: string) => void;
  onEntityDescriptionChange: (description: string) => void;
  onBack: () => void;
  onConfirm: () => void;
  isCreating?: boolean;
  error?: string | null;
}

let nextTempId = 0;
function makeTempId() {
  return `preview-${++nextTempId}`;
}

function getConfidenceBadge(confidence?: number) {
  if (confidence === undefined || confidence === null) return null;
  const pct = Math.round(confidence * 100);
  if (pct >= 80) {
    return (
      <Badge variant="outline" className="text-[10px] h-4 px-1 text-emerald-400 border-emerald-400/30">
        {pct}%
      </Badge>
    );
  }
  if (pct >= 50) {
    return (
      <Badge variant="outline" className="text-[10px] h-4 px-1 text-amber-400 border-amber-400/30">
        {pct}%
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="text-[10px] h-4 px-1 text-rose-400 border-rose-400/30">
      {pct}%
    </Badge>
  );
}

export function FieldPreview({
  entityName,
  entityDescription,
  fields,
  onFieldsChange,
  onEntityNameChange,
  onEntityDescriptionChange,
  onBack,
  onConfirm,
  isCreating = false,
  error,
}: FieldPreviewProps) {
  const [showAddRow, setShowAddRow] = useState(false);
  const [newName, setNewName] = useState("");
  const [newType, setNewType] = useState("string");
  const [newClassification, setNewClassification] = useState<string | null>(null);
  const [newDescription, setNewDescription] = useState("");
  const nameInputRef = useRef<HTMLInputElement>(null);

  function updateField(tempId: string, updates: Partial<PreviewField>) {
    onFieldsChange(
      fields.map((f) => (f.tempId === tempId ? { ...f, ...updates } : f))
    );
  }

  function removeField(tempId: string) {
    onFieldsChange(fields.filter((f) => f.tempId !== tempId));
  }

  function addField() {
    if (!newName.trim()) return;
    onFieldsChange([
      ...fields,
      {
        tempId: makeTempId(),
        name: newName.trim(),
        type: newType,
        classification: newClassification,
        description: newDescription,
      },
    ]);
    setNewName("");
    setNewType("string");
    setNewClassification(null);
    setNewDescription("");
    // Keep the row open so the user can immediately add another field.
    // Refocus the name input after state settles.
    setTimeout(() => nameInputRef.current?.focus(), 0);
  }

  return (
    <div className="space-y-space-4">
      <button
        type="button"
        onClick={onBack}
        className="flex items-center gap-1 text-body-small text-muted-foreground hover:text-foreground transition-colors"
      >
        <ArrowLeft className="w-4 h-4" />
        Back
      </button>

      <div>
        <h3 className="text-heading-2 text-foreground mb-space-4">
          Review Entity
        </h3>
      </div>

      {/* Entity name + description */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-space-3">
        <div>
          <label className="text-caption text-muted-foreground mb-1 block">Entity Name</label>
          <Input
            value={entityName}
            onChange={(e) => onEntityNameChange(e.target.value)}
            className="h-9 font-mono"
            placeholder="EntityName"
          />
        </div>
        <div>
          <label className="text-caption text-muted-foreground mb-1 block">Description</label>
          <Input
            value={entityDescription}
            onChange={(e) => onEntityDescriptionChange(e.target.value)}
            className="h-9"
            placeholder="Brief description"
          />
        </div>
      </div>

      {/* Fields table */}
      <div className="surface-glass rounded-xl border border-border overflow-hidden">
        <table className="w-full">
          <thead>
            <tr className="border-b border-border text-caption text-muted-foreground">
              <th className="text-left px-space-3 py-space-2 font-medium">Name</th>
              <th className="text-left px-space-3 py-space-2 font-medium w-[140px]">Type</th>
              <th className="text-left px-space-3 py-space-2 font-medium w-[100px]">Classification</th>
              <th className="text-left px-space-3 py-space-2 font-medium">Description</th>
              <th className="text-left px-space-3 py-space-2 font-medium w-[60px]">Conf.</th>
              <th className="w-[40px]" />
            </tr>
          </thead>
          <tbody>
            {fields.map((field) => (
              <tr
                key={field.tempId}
                className="border-b border-border/50 hover:bg-accent/20 transition-colors group"
              >
                <td className="px-space-3 py-space-2">
                  <Input
                    value={field.name}
                    onChange={(e) => updateField(field.tempId, { name: e.target.value })}
                    className="h-7 font-mono text-body-small border-transparent hover:border-border focus:border-primary/40"
                  />
                </td>
                <td className="px-space-3 py-space-2">
                  <TypePicker
                    value={field.type}
                    onChange={(v) => updateField(field.tempId, { type: v })}
                    compact
                  />
                </td>
                <td className="px-space-3 py-space-2">
                  <ClassificationPicker
                    value={field.classification}
                    onChange={(v) => updateField(field.tempId, { classification: v })}
                  />
                </td>
                <td className="px-space-3 py-space-2">
                  <Input
                    value={field.description}
                    onChange={(e) => updateField(field.tempId, { description: e.target.value })}
                    className="h-7 text-body-small border-transparent hover:border-border focus:border-primary/40"
                    placeholder="Description..."
                  />
                </td>
                <td className="px-space-3 py-space-2 text-center">
                  {getConfidenceBadge(field.confidence)}
                </td>
                <td className="px-space-2 py-space-2">
                  <button
                    type="button"
                    onClick={() => removeField(field.tempId)}
                    className="p-1 text-muted-foreground hover:text-destructive transition-colors rounded opacity-0 group-hover:opacity-100"
                    title="Remove field"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </td>
              </tr>
            ))}

            {/* Add row */}
            {showAddRow ? (
              <tr className="border-b border-border/50 bg-accent/5">
                <td className="px-space-3 py-space-2">
                  <Input
                    ref={nameInputRef}
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    className="h-7 font-mono text-body-small"
                    placeholder="field_name"
                    autoFocus
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && newName.trim()) {
                        e.preventDefault();
                        addField();
                      }
                      if (e.key === "Escape") {
                        e.preventDefault();
                        setShowAddRow(false);
                      }
                    }}
                  />
                </td>
                <td className="px-space-3 py-space-2">
                  <TypePicker
                    value={newType}
                    onChange={setNewType}
                    compact
                  />
                </td>
                <td className="px-space-3 py-space-2">
                  <ClassificationPicker
                    value={newClassification}
                    onChange={setNewClassification}
                  />
                </td>
                <td className="px-space-3 py-space-2">
                  <Input
                    value={newDescription}
                    onChange={(e) => setNewDescription(e.target.value)}
                    className="h-7 text-body-small"
                    placeholder="Description..."
                  />
                </td>
                <td />
                <td className="px-space-2 py-space-2">
                  <div className="flex gap-1">
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={addField}
                      disabled={!newName.trim()}
                      aria-label="Save Field"
                      className="h-6 w-6 p-0"
                    >
                      <CheckCircle2 className="w-3.5 h-3.5 text-success" />
                    </Button>
                  </div>
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>

        {!showAddRow && (
          <button
            type="button"
            onClick={() => setShowAddRow(true)}
            className="w-full flex items-center justify-center gap-2 py-space-2 border-t border-dashed border-border hover:border-primary/40 hover:bg-accent/20 text-muted-foreground hover:text-foreground transition-colors text-caption"
          >
            <Plus className="w-3.5 h-3.5" />
            Add Field
          </button>
        )}
      </div>

      {error && <p className="text-body-small text-destructive">{error}</p>}

      {/* Actions */}
      <div className="flex items-center justify-between">
        <span className="text-caption text-muted-foreground">
          {fields.length} field{fields.length !== 1 ? "s" : ""}
        </span>
        <Button
          type="button"
          onClick={onConfirm}
          disabled={!entityName.trim() || isCreating}
          className="gap-2"
        >
          <CheckCircle2 className="w-4 h-4" />
          {isCreating ? "Creating..." : "Create Entity"}
        </Button>
      </div>
    </div>
  );
}

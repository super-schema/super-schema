"use client";

import { useState } from "react";
import { Plus, GripVertical, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ValidationIndicator } from "@/components/custom/ValidationIndicator";
import {
  getFieldCompleteness,
  getEntityCompleteness,
} from "@/lib/validation/field-completeness";

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
  sortOrder: number;
}

interface FieldEditorProps {
  entityId: string;
  domainSlug: string;
  fields: FieldData[];
  onAddField: (name: string, type: string) => Promise<void>;
  onUpdateField: (id: string, data: Partial<FieldData>) => Promise<void>;
  onDeleteField: (id: string) => Promise<void>;
}

const FIELD_TYPES = [
  "string", "integer", "decimal", "boolean", "timestamp", "date", "time",
  "uuid", "text", "binary", "json", "enum", "array", "map", "reference",
];

export function FieldEditor({
  fields,
  onAddField,
  onUpdateField,
  onDeleteField,
}: FieldEditorProps) {
  const [newFieldName, setNewFieldName] = useState("");
  const [newFieldType, setNewFieldType] = useState("string");
  const [isAdding, setIsAdding] = useState(false);
  const [editingField, setEditingField] = useState<string | null>(null);
  const [hoveredField, setHoveredField] = useState<string | null>(null);

  async function handleAddField() {
    if (!newFieldName.trim()) return;
    setIsAdding(true);
    await onAddField(newFieldName.trim(), newFieldType);
    setNewFieldName("");
    setNewFieldType("string");
    setIsAdding(false);
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

      {/* Field grid */}
      <div className="surface-glass rounded-xl border border-border overflow-hidden">
        {/* Header row */}
        <div className="grid grid-cols-[24px_32px_1fr_120px_80px_80px_100px_48px] gap-0 border-b border-border text-caption text-muted-foreground font-medium">
          <div className="px-1 py-space-3" />
          <div className="px-2 py-space-3" />
          <div className="px-space-3 py-space-3">Name</div>
          <div className="px-space-3 py-space-3">Type</div>
          <div className="px-space-3 py-space-3 text-center">Nullable</div>
          <div className="px-space-3 py-space-3 text-center">Key</div>
          <div className="px-space-3 py-space-3">Classification</div>
          <div className="px-2 py-space-3" />
        </div>

        {/* Field rows */}
        {fields.map((field) => {
          const fc = getFieldCompleteness(field);
          const tooltipContent =
            fc.status === "complete"
              ? "Field complete"
              : fc.status === "error"
                ? `Missing: ${fc.missing.join(", ")}`
                : `Suggestions: ${fc.suggestions.join(", ")}`;

          return (
          <div
            key={field.id}
            className="grid grid-cols-[24px_32px_1fr_120px_80px_80px_100px_48px] gap-0 border-b border-border/50 hover:bg-accent/20 transition-colors group"
            onMouseEnter={() => setHoveredField(field.id)}
            onMouseLeave={() => setHoveredField(null)}
          >
            {/* Validation indicator */}
            <div className="flex items-center justify-center">
              <ValidationIndicator status={fc.status} tooltipContent={tooltipContent} />
            </div>

            {/* Drag handle */}
            <div className="flex items-center justify-center text-muted-foreground/30 group-hover:text-muted-foreground cursor-grab">
              <GripVertical className="w-4 h-4" />
            </div>

            {/* Name */}
            <div className="px-space-3 py-space-2 flex items-center">
              {editingField === field.id ? (
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
                  className="font-mono text-body-small text-foreground cursor-text"
                  onClick={() => setEditingField(field.id)}
                >
                  {field.name}
                </span>
              )}
            </div>

            {/* Type */}
            <div className="px-space-3 py-space-2 flex items-center">
              <select
                value={field.type}
                onChange={(e) => onUpdateField(field.id, { type: e.target.value })}
                className="bg-transparent text-body-small text-muted-foreground outline-none cursor-pointer hover:text-foreground"
              >
                {FIELD_TYPES.map((t) => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </select>
            </div>

            {/* Nullable */}
            <div className="px-space-3 py-space-2 flex items-center justify-center">
              <input
                type="checkbox"
                checked={field.nullable}
                onChange={(e) => onUpdateField(field.id, { nullable: e.target.checked })}
                className="accent-primary"
              />
            </div>

            {/* Key */}
            <div className="px-space-3 py-space-2 flex items-center justify-center">
              <input
                type="checkbox"
                checked={field.isKey}
                onChange={(e) => onUpdateField(field.id, { isKey: e.target.checked })}
                className="accent-primary"
              />
            </div>

            {/* Classification */}
            <div className="px-space-3 py-space-2 flex items-center">
              {field.classification ? (
                <span className={`badge-${field.classification.toLowerCase()} text-caption px-1.5 py-0.5 rounded`}>
                  {field.classification}
                </span>
              ) : (
                <span className="text-caption text-muted-foreground/50">—</span>
              )}
            </div>

            {/* Actions */}
            <div className="px-1 py-space-2 flex items-center justify-center">
              {hoveredField === field.id && (
                <button
                  onClick={() => onDeleteField(field.id)}
                  className="p-1 text-muted-foreground hover:text-destructive transition-colors rounded"
                  title="Delete field"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          </div>
          );
        })}

        {/* Add field row */}
        <div className="grid grid-cols-[56px_1fr_120px_auto] gap-0 p-space-2">
          <div />
          <div className="px-space-1">
            <Input
              value={newFieldName}
              onChange={(e) => setNewFieldName(e.target.value)}
              placeholder="New field name..."
              className="h-7 font-mono text-body-small"
              onKeyDown={(e) => {
                if (e.key === "Enter") handleAddField();
              }}
            />
          </div>
          <div className="px-space-1">
            <select
              value={newFieldType}
              onChange={(e) => setNewFieldType(e.target.value)}
              className="h-7 bg-muted rounded px-2 text-body-small text-muted-foreground outline-none w-full"
            >
              {FIELD_TYPES.map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          </div>
          <div className="px-space-1">
            <Button
              size="sm"
              onClick={handleAddField}
              disabled={!newFieldName.trim() || isAdding}
              className="h-7 gap-1 text-caption"
            >
              <Plus className="w-3 h-3" />
              Add
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

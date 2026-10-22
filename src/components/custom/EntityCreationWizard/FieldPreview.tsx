"use client";

import { Fragment, useState, useRef, useMemo } from "react";
import { Plus, Trash2, ArrowLeft, CheckCircle2, ChevronDown, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { TypePicker } from "@/components/custom/TypePicker";
import { ClassificationPicker } from "@/components/custom/ClassificationPicker";
import {
  MOUNT_DETAILS_ONLY_WHEN_EXPANDED_ABOVE,
  ParsedEntityDetails,
  ParsedFieldDetails,
  ParsedFieldSummaryBadges,
} from "@/components/custom/ImportDialog/ParsedFieldDetails";
import type { ParsedEntity, ParsedField } from "@/lib/importers/types";

export interface PreviewField {
  tempId: string;
  name: string;
  type: string;
  classification: string | null;
  description: string;
  confidence?: number;
  /** Target entity for a `reference` field (preserved through to persistence). */
  referencedEntityName?: string;
  /** Array element logical type (preserved through to persistence). */
  arrayElementType?: string;
  /** Decorators built by a schema import (map key/value, enum, governance), kept on create. */
  importedDecorators?: Record<string, unknown>;
  /** Protobuf field number from a schema import. */
  fieldNumber?: number;
  /** Imported nullability (kept through to creation); absent = the field default (nullable). */
  nullable?: boolean;
  /** Imported key flag (kept through to creation). */
  isKey?: boolean;
  /** The importer's full view of this field (for the read-only "used / preserved / ignored" details). */
  parsed?: ParsedField;
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
  /** Every warning of the import: all shown, none truncated. */
  warnings?: string[];
  /** Entity-level import facts (extends, extensions, ignored keywords). Present only for a schema import. */
  importedEntity?: Pick<ParsedEntity, "name" | "description" | "extends" | "extensions" | "ignoredKeywords" | "sourceFormat">;
  /** The importer's fallback entity name: while the name field still holds it, it is highlighted as "needs a name". */
  fallbackName?: string;
}

function makeTempId() {
  return `preview-${crypto.randomUUID()}`;
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
  warnings = [],
  importedEntity,
  fallbackName,
}: FieldPreviewProps) {
  const [expandedFields, setExpandedFields] = useState<Set<string>>(new Set());
  const needsName = fallbackName !== undefined && entityName.trim() === fallbackName;
  const entityNames = useMemo(() => new Set([importedEntity?.name ?? entityName]), [importedEntity?.name, entityName]);

  function toggleExpand(tempId: string) {
    setExpandedFields((prev) => {
      const next = new Set(prev);
      if (next.has(tempId)) next.delete(tempId);
      else next.add(tempId);
      return next;
    });
  }

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
            className={`h-9 font-mono ${needsName ? "border-warning ring-1 ring-warning/50" : ""}`}
            placeholder="EntityName"
            aria-invalid={needsName || undefined}
            data-needs-name={needsName ? "true" : undefined}
          />
          {needsName && (
            <p className="text-caption text-warning mt-1" data-testid="needs-name-hint">
              Needs a name — the schema gave no title or $id, so this placeholder was used.
            </p>
          )}
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

      {importedEntity && (
        <div data-testid="import-entity-details">
          <ParsedEntityDetails entity={importedEntity} warnings={warnings} />
        </div>
      )}
      {!importedEntity && warnings.length > 0 && (
        <div className="rounded-lg border border-warning/30 bg-warning/5 p-3 space-y-1" data-testid="import-warnings">
          {warnings.map((warning, index) => (
            <p key={index} className="text-caption text-muted-foreground">
              {warning}
            </p>
          ))}
        </div>
      )}

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
              <Fragment key={field.tempId}>
              <tr className="border-b border-border/50 hover:bg-accent/20 transition-colors group">
                <td className="px-space-3 py-space-2">
                  <div className="flex items-center gap-1">
                    {field.parsed && (
                      <button
                        type="button"
                        onClick={() => toggleExpand(field.tempId)}
                        aria-expanded={expandedFields.has(field.tempId)}
                        aria-label={`${expandedFields.has(field.tempId) ? "Hide" : "Show"} import details of ${field.name}`}
                        className="p-0.5 rounded hover:bg-accent shrink-0"
                      >
                        {expandedFields.has(field.tempId) ? (
                          <ChevronDown className="w-3 h-3 text-muted-foreground" />
                        ) : (
                          <ChevronRight className="w-3 h-3 text-muted-foreground" />
                        )}
                      </button>
                    )}
                    <Input
                      value={field.name}
                      onChange={(e) => updateField(field.tempId, { name: e.target.value })}
                      className="h-7 font-mono text-body-small border-transparent hover:border-border focus:border-primary/40"
                    />
                  </div>
                  {field.parsed && (
                    <div className="flex flex-wrap gap-1 mt-1 pl-5">
                      <ParsedFieldSummaryBadges field={field.parsed} entityNames={entityNames} />
                    </div>
                  )}
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
              {field.parsed && (fields.length <= MOUNT_DETAILS_ONLY_WHEN_EXPANDED_ABOVE || expandedFields.has(field.tempId)) && (
                <tr hidden={!expandedFields.has(field.tempId)} className="border-b border-border/50">
                  <td colSpan={6} className="px-space-3 pb-space-2">
                    <p className="text-[10px] text-muted-foreground">
                      What the import found for this field (as imported; the edits above apply to the field that is created).
                    </p>
                    <ParsedFieldDetails
                      field={field.parsed}
                      entityNames={entityNames}
                      collapsed={!expandedFields.has(field.tempId)}
                    />
                  </td>
                </tr>
              )}
              </Fragment>
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

        {/* Always visible — opens row when closed, saves field when row is open with a name */}
        <button
          type="button"
          onClick={() => {
            if (showAddRow) {
              if (newName.trim()) addField();
            } else {
              setShowAddRow(true);
            }
          }}
          disabled={showAddRow && !newName.trim()}
          className="w-full flex items-center justify-center gap-2 py-space-2 border-t border-dashed border-border hover:border-primary/40 hover:bg-accent/20 text-muted-foreground hover:text-foreground transition-colors text-caption disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <Plus className="w-3.5 h-3.5" />
          Add Field
        </button>
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

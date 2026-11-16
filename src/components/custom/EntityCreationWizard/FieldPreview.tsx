"use client";

import { Fragment, useId, useState, useRef, useMemo } from "react";
import { Plus, Trash2, ArrowLeft, CheckCircle2, ChevronDown, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
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

/** An import with at most this many fields opens with all of the imported details expanded. */
const AUTO_EXPAND_DETAILS_UP_TO = 12;

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
  const nameInputId = useId();
  const descriptionInputId = useId();
  // A small import opens with every field's imported details showing: the review is where the user checks what came in.
  const [expandedFields, setExpandedFields] = useState<Set<string>>(
    () => new Set(fields.length <= AUTO_EXPAND_DETAILS_UP_TO ? fields.filter((f) => f.parsed).map((f) => f.tempId) : [])
  );
  const importedFields = fields.filter((f) => f.parsed);
  const allExpanded = importedFields.length > 0 && importedFields.every((f) => expandedFields.has(f.tempId));
  const needsName = fallbackName !== undefined && entityName.trim() === fallbackName;
  const entityNames = useMemo(() => new Set([importedEntity?.name ?? entityName]), [importedEntity?.name, entityName]);

  function toggleExpandAll() {
    setExpandedFields(allExpanded ? new Set() : new Set(importedFields.map((f) => f.tempId)));
  }

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
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={onBack}
        data-testid="wizard-back"
        className="text-muted-foreground"
      >
        <ArrowLeft className="size-4" />
        Back
      </Button>

      <div>
        <h3 className="text-heading-2 text-foreground mb-space-4">
          Review Entity
        </h3>
      </div>

      {/* Entity name + description */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-space-3">
        <div>
          <label htmlFor={nameInputId} className="text-caption text-muted-foreground mb-1 block">Entity Name</label>
          <Input
            id={nameInputId}
            data-testid="wizard-entity-name"
            value={entityName}
            onChange={(e) => onEntityNameChange(e.target.value)}
            className={`h-9 font-mono ${needsName ? "border-warning ring-1 ring-warning/50" : ""}`}
            placeholder="EntityName"
            aria-invalid={needsName || undefined}
            data-needs-name={needsName ? "true" : undefined}
          />
          {needsName && (
            <p className="text-caption text-warning mt-1" data-testid="needs-name-hint">
              Give this entity a name
              <span className="text-muted-foreground"> — the schema gave no title or $id, so a placeholder was used.</span>
            </p>
          )}
        </div>
        <div>
          <label htmlFor={descriptionInputId} className="text-caption text-muted-foreground mb-1 block">Description</label>
          <Input
            id={descriptionInputId}
            data-testid="wizard-entity-description"
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

      {importedFields.length > 0 && (
        <div className="flex justify-end">
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={toggleExpandAll}
            data-testid="wizard-toggle-details"
            className="text-muted-foreground"
          >
            {allExpanded ? "Collapse all imported details" : "Expand all imported details"}
          </Button>
        </div>
      )}

      {/* Fields table */}
      <div className="surface-glass rounded-xl border border-border overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow className="border-border text-caption text-muted-foreground hover:bg-transparent">
              <TableHead className="h-auto py-space-2">Name</TableHead>
              <TableHead className="h-auto w-[140px] py-space-2">Type</TableHead>
              <TableHead className="h-auto w-[100px] py-space-2">Classification</TableHead>
              <TableHead className="h-auto py-space-2">Description</TableHead>
              <TableHead className="h-auto w-[60px] py-space-2">Conf.</TableHead>
              <TableHead className="h-auto w-[40px] py-space-2" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {fields.map((field) => (
              <Fragment key={field.tempId}>
              <TableRow className="border-border/50 group" data-testid="wizard-field-row">
                <TableCell>
                  <div className="flex items-center gap-1">
                    {field.parsed && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        onClick={() => toggleExpand(field.tempId)}
                        aria-expanded={expandedFields.has(field.tempId)}
                        aria-label={`${expandedFields.has(field.tempId) ? "Hide" : "Show"} import details of ${field.name}`}
                      >
                        {expandedFields.has(field.tempId) ? (
                          <ChevronDown className="size-3 text-muted-foreground" />
                        ) : (
                          <ChevronRight className="size-3 text-muted-foreground" />
                        )}
                      </Button>
                    )}
                    <Input
                      value={field.name}
                      data-testid="wizard-field-name"
                      onChange={(e) => updateField(field.tempId, { name: e.target.value })}
                      className="h-7 font-mono text-body-small border-transparent hover:border-border focus:border-primary/40"
                    />
                  </div>
                  {field.parsed && (
                    <div className="flex flex-wrap gap-1 mt-1 pl-5">
                      <ParsedFieldSummaryBadges field={field.parsed} entityNames={entityNames} />
                    </div>
                  )}
                </TableCell>
                <TableCell>
                  <TypePicker
                    value={field.type}
                    onChange={(v) => updateField(field.tempId, { type: v })}
                    compact
                  />
                </TableCell>
                <TableCell>
                  <ClassificationPicker
                    value={field.classification}
                    onChange={(v) => updateField(field.tempId, { classification: v })}
                  />
                </TableCell>
                <TableCell>
                  <Input
                    value={field.description}
                    onChange={(e) => updateField(field.tempId, { description: e.target.value })}
                    className="h-7 text-body-small border-transparent hover:border-border focus:border-primary/40"
                    placeholder="Description..."
                  />
                </TableCell>
                <TableCell className="text-center">
                  {getConfidenceBadge(field.confidence)}
                </TableCell>
                <TableCell>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    onClick={() => removeField(field.tempId)}
                    className="text-muted-foreground opacity-0 hover:text-destructive group-hover:opacity-100 focus-visible:opacity-100"
                    title="Remove field"
                    aria-label="Remove field"
                    data-testid="wizard-remove-field"
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </TableCell>
              </TableRow>
              {field.parsed && (fields.length <= MOUNT_DETAILS_ONLY_WHEN_EXPANDED_ABOVE || expandedFields.has(field.tempId)) && (
                <TableRow hidden={!expandedFields.has(field.tempId)} className="border-border/50 hover:bg-transparent">
                  <TableCell colSpan={6} className="whitespace-normal pt-0">
                    <p className="text-[10px] text-muted-foreground">
                      What the import found for this field (as imported; the edits above apply to the field that is created).
                    </p>
                    <ParsedFieldDetails
                      field={field.parsed}
                      entityNames={entityNames}
                      collapsed={!expandedFields.has(field.tempId)}
                    />
                  </TableCell>
                </TableRow>
              )}
              </Fragment>
            ))}

            {/* Add row */}
            {showAddRow ? (
              <TableRow className="border-border/50 bg-accent/5">
                <TableCell>
                  <Input
                    ref={nameInputRef}
                    data-testid="wizard-new-field-name"
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
                </TableCell>
                <TableCell>
                  <TypePicker
                    value={newType}
                    onChange={setNewType}
                    compact
                  />
                </TableCell>
                <TableCell>
                  <ClassificationPicker
                    value={newClassification}
                    onChange={setNewClassification}
                  />
                </TableCell>
                <TableCell>
                  <Input
                    value={newDescription}
                    onChange={(e) => setNewDescription(e.target.value)}
                    className="h-7 text-body-small"
                    placeholder="Description..."
                  />
                </TableCell>
                <TableCell />
                <TableCell>
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
                </TableCell>
              </TableRow>
            ) : null}
          </TableBody>
        </Table>

        {/* Always visible — opens row when closed, saves field when row is open with a name */}
        <Button
          type="button"
          variant="ghost"
          size="xs"
          onClick={() => {
            if (showAddRow) {
              if (newName.trim()) addField();
            } else {
              setShowAddRow(true);
            }
          }}
          disabled={showAddRow && !newName.trim()}
          data-testid="wizard-add-field"
          className="h-auto w-full rounded-none border-0 border-t border-dashed border-border py-space-2 text-muted-foreground hover:border-primary/40"
        >
          <Plus className="size-3.5" />
          Add Field
        </Button>
      </div>

      {error && <p className="text-body-small text-destructive" data-testid="wizard-error">{error}</p>}

      {/* Actions */}
      <div className="flex items-center justify-between">
        <span className="text-caption text-muted-foreground">
          {fields.length} field{fields.length !== 1 ? "s" : ""}
        </span>
        <Button
          type="button"
          onClick={onConfirm}
          disabled={!entityName.trim() || needsName || isCreating}
          className="gap-2"
          data-testid="wizard-create-entity"
        >
          <CheckCircle2 className="w-4 h-4" />
          {isCreating ? "Creating..." : "Create Entity"}
        </Button>
      </div>
    </div>
  );
}

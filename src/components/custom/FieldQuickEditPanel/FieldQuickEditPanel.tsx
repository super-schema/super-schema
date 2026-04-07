"use client";

import { useState, useEffect, useRef, useCallback, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { ChevronDown, Loader2, Check, AlertCircle } from "lucide-react";
import { Input } from "@/components/ui/input";
import { TypePicker } from "@/components/custom/TypePicker";
import { getTypeInfo } from "@/lib/data-types";

// Studio-level panels
import { ValidationPanel } from "@/app/(dashboard)/schemas/[domainSlug]/[entityId]/fields/[fieldId]/panels/ValidationPanel";
import { WireFormatPanel } from "@/app/(dashboard)/schemas/[domainSlug]/[entityId]/fields/[fieldId]/panels/WireFormatPanel";
import { VisibilityPanel } from "@/app/(dashboard)/schemas/[domainSlug]/[entityId]/fields/[fieldId]/panels/VisibilityPanel";
import { ExtensionsPanel } from "@/app/(dashboard)/schemas/[domainSlug]/[entityId]/fields/[fieldId]/panels/ExtensionsPanel";
import { VersioningPanel } from "@/app/(dashboard)/schemas/[domainSlug]/[entityId]/fields/[fieldId]/panels/VersioningPanel";
import { GovernancePanel } from "@/app/(dashboard)/schemas/[domainSlug]/[entityId]/fields/[fieldId]/panels/GovernancePanel";

import type { TypeSpecDecorators } from "@/types/schemas/typespec-decorator.schema";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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

type SaveStatus = "idle" | "saving" | "saved" | "error";

interface FieldQuickEditPanelProps {
  field: FieldData;
  entityId: string;
  entitySlug?: string;
  domainSlug: string;
  isReadOnly?: boolean;
  onUpdateField: (id: string, data: Partial<FieldData>) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Section config
// ---------------------------------------------------------------------------

const SECTION_LABELS = [
  "Validations & Constraints",
  "Serialization",
  "Access Control",
  "Extensions",
  "Data Governance",
  "Version History",
] as const;

const STRING_TYPES = new Set(["string", "url"]);

const FORMAT_OPTIONS = [
  { value: "", label: "None" },
  { value: "uuid", label: "uuid" },
  { value: "email", label: "email" },
  { value: "uri", label: "uri" },
  { value: "date-time", label: "date-time" },
  { value: "ipv4", label: "ipv4" },
  { value: "ipv6", label: "ipv6" },
];

function getTypeCategory(type: string): string {
  const info = getTypeInfo(type);
  return info?.category ?? "String";
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function FieldQuickEditPanel({
  field,
  isReadOnly = false,
  onUpdateField,
}: FieldQuickEditPanelProps) {
  const [expandedSections, setExpandedSections] = useState<Set<number>>(new Set([0]));

  // Core field state (shown in header)
  const [localName, setLocalName] = useState(field.name);
  const [localType, setLocalType] = useState(field.type);
  const [localNullable, setLocalNullable] = useState(field.nullable);
  const [localIsKey, setLocalIsKey] = useState(field.isKey);
  const [localDescription, setLocalDescription] = useState(field.description);
  const [localClassification, setLocalClassification] = useState<string | null>(field.classification);
  const [localFieldNumber, setLocalFieldNumber] = useState<number | null>(field.fieldNumber);

  // TypeSpec decorators — single state object like Field Studio
  const existingTypespec = (field.decorators?.typespec ?? {}) as TypeSpecDecorators;
  const [typespec, setTypespec] = useState<TypeSpecDecorators>(existingTypespec);

  // Header identity state derived from typespec
  const [localSecret, setLocalSecret] = useState(!!typespec.identity?.secret);
  const [localFormat, setLocalFormat] = useState(typespec.identity?.format ?? "");
  const [localDefaultValue, setLocalDefaultValue] = useState(
    typespec.identity?.defaultValue != null ? String(typespec.identity.defaultValue) : ""
  );
  const [localSummary, setLocalSummary] = useState(typespec.documentation?.summary ?? "");

  // Save machinery
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRef = useRef(false);
  const savingRef = useRef(false);

  // Current values ref to avoid stale closures
  const currentRef = useRef({
    localName, localType, localNullable, localIsKey, localDescription,
    localClassification, localFieldNumber, localSecret, localFormat,
    localDefaultValue, localSummary, typespec,
  });

  useEffect(() => {
    currentRef.current = {
      localName, localType, localNullable, localIsKey, localDescription,
      localClassification, localFieldNumber, localSecret, localFormat,
      localDefaultValue, localSummary, typespec,
    };
  });

  // Reset on field switch
  useEffect(() => {
    setLocalName(field.name);
    setLocalType(field.type);
    setLocalNullable(field.nullable);
    setLocalIsKey(field.isKey);
    setLocalDescription(field.description);
    setLocalClassification(field.classification);
    setLocalFieldNumber(field.fieldNumber);

    const ts = (field.decorators?.typespec ?? {}) as TypeSpecDecorators;
    setTypespec(ts);
    setLocalSecret(!!ts.identity?.secret);
    setLocalFormat(ts.identity?.format ?? "");
    setLocalDefaultValue(ts.identity?.defaultValue != null ? String(ts.identity.defaultValue) : "");
    setLocalSummary(ts.documentation?.summary ?? "");

    setSaveStatus("idle");
  }, [field.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Save function
  const doSave = useCallback(async () => {
    if (savingRef.current) return;
    savingRef.current = true;
    setSaveStatus("saving");
    pendingRef.current = false;

    const c = currentRef.current;

    // Merge header identity fields back into typespec
    const mergedTypespec = { ...c.typespec };
    const identity = { ...(mergedTypespec.identity ?? {}) };
    if (c.localSecret) identity.secret = true; else delete identity.secret;
    if (c.localFormat) identity.format = c.localFormat; else identity.format = null;
    if (c.localDefaultValue) identity.defaultValue = c.localDefaultValue; else delete identity.defaultValue;
    mergedTypespec.identity = identity;

    const documentation = { ...(mergedTypespec.documentation ?? {}) };
    if (c.localSummary) documentation.summary = c.localSummary; else delete documentation.summary;
    mergedTypespec.documentation = documentation;

    const decorators = { ...field.decorators, typespec: mergedTypespec };

    try {
      await onUpdateField(field.id, {
        name: c.localName,
        type: c.localType,
        nullable: c.localNullable,
        isKey: c.localIsKey,
        description: c.localDescription,
        classification: c.localClassification,
        fieldNumber: c.localFieldNumber,
        decorators,
      });
      setSaveStatus("saved");
      setTimeout(() => setSaveStatus("idle"), 2000);
    } catch {
      setSaveStatus("error");
    } finally {
      savingRef.current = false;
    }
  }, [field.id, field.decorators, onUpdateField]);

  const scheduleSave = useCallback(() => {
    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    pendingRef.current = true;
    saveTimeoutRef.current = setTimeout(doSave, 500);
  }, [doSave]);

  // Flush on unmount
  useEffect(() => {
    return () => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
        saveTimeoutRef.current = null;
      }
      if (pendingRef.current && !savingRef.current) {
        pendingRef.current = false;
        doSave();
      }
    };
  }, [field.id, doSave]);

  // Typespec sub-object change handler (from studio panels)
  function handleTypespecChange(key: keyof TypeSpecDecorators, value: unknown) {
    setTypespec((prev) => ({ ...prev, [key]: value }));
    scheduleSave();
  }

  // Header field change handler
  function handleHeaderChange(sectionField: string, value: unknown) {
    switch (sectionField) {
      case "name": setLocalName(value as string); break;
      case "type": setLocalType(value as string); break;
      case "nullable": setLocalNullable(value as boolean); break;
      case "isKey": setLocalIsKey(value as boolean); break;
      case "secret": setLocalSecret(value as boolean); break;
      case "format": setLocalFormat(value as string); break;
      case "defaultValue": setLocalDefaultValue(value as string); break;
      case "description": setLocalDescription(value as string); break;
      case "summary": setLocalSummary(value as string); break;
    }
    scheduleSave();
  }

  function toggleSection(idx: number) {
    setExpandedSections((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx); else next.add(idx);
      return next;
    });
  }

  const [editingDescription, setEditingDescription] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const typeCategory = getTypeCategory(localType);

  return (
    <div className="flex flex-col h-full" data-testid="field-edit-panel">
      {/* Header: core identity fields */}
      <div className="px-space-4 py-space-3 border-b border-border/50 space-y-2">
        {/* Field name */}
        {editingName && !isReadOnly ? (
          <Input
            autoFocus
            value={localName}
            onChange={(e) => handleHeaderChange("name", e.target.value)}
            onBlur={() => setEditingName(false)}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === "Escape") setEditingName(false); }}
            className="h-7 font-mono text-body-small font-medium"
          />
        ) : (
          <span
            className={`font-mono text-body-small text-foreground font-medium block ${!isReadOnly ? "cursor-text hover:text-primary" : ""}`}
            onClick={() => !isReadOnly && setEditingName(true)}
          >
            {localName}
          </span>
        )}

        {/* Description */}
        {editingDescription && !isReadOnly ? (
          <textarea
            autoFocus
            value={localDescription}
            onChange={(e) => handleHeaderChange("description", e.target.value)}
            onBlur={() => setEditingDescription(false)}
            onKeyDown={(e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
              if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); setEditingDescription(false); }
              if (e.key === "Escape") setEditingDescription(false);
            }}
            rows={2}
            className="w-full rounded border border-border bg-popover px-2 py-1 text-caption text-muted-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:border-ring resize-none"
            placeholder="Add description..."
          />
        ) : (
          <p
            onClick={() => !isReadOnly && setEditingDescription(true)}
            className={`text-caption line-clamp-1 ${localDescription ? "text-muted-foreground" : "text-muted-foreground/40 italic"} ${!isReadOnly ? "cursor-pointer hover:text-foreground transition-colors" : ""}`}
          >
            {localDescription || "Add description..."}
          </p>
        )}

        {/* Summary */}
        <Input
          value={localSummary}
          onChange={(e) => handleHeaderChange("summary", e.target.value)}
          placeholder="Brief one-line summary"
          className="h-7 text-caption"
          disabled={isReadOnly}
        />

        {/* Type picker */}
        <div className="flex items-center gap-2">
          <div className="flex-1">
            <TypePicker
              value={localType}
              onChange={(t) => handleHeaderChange("type", t)}
              compact
              disabled={isReadOnly}
            />
          </div>
        </div>

        {/* Checkboxes + Format (string only) + Default */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-caption text-muted-foreground">
          <label className="flex items-center gap-1">
            <input type="checkbox" checked={localNullable} onChange={(e) => handleHeaderChange("nullable", e.target.checked)} disabled={isReadOnly || localIsKey} className="accent-primary" />
            Optional
          </label>
          <label className="flex items-center gap-1">
            <input type="checkbox" checked={localSecret} onChange={(e) => handleHeaderChange("secret", e.target.checked)} disabled={isReadOnly} className="accent-primary" />
            Secret
          </label>
          <label className="flex items-center gap-1">
            <input type="checkbox" checked={localIsKey} onChange={(e) => { handleHeaderChange("isKey", e.target.checked); if (e.target.checked) handleHeaderChange("nullable", false); }} disabled={isReadOnly} className="accent-primary" />
            Key
          </label>
        </div>

        <div className={`grid gap-space-2 ${STRING_TYPES.has(localType) ? "grid-cols-2" : "grid-cols-1"}`}>
          {STRING_TYPES.has(localType) && (
            <select
              value={localFormat}
              onChange={(e) => handleHeaderChange("format", e.target.value)}
              disabled={isReadOnly}
              className="h-7 w-full rounded-lg border border-border bg-popover px-2 text-caption text-foreground disabled:opacity-50"
            >
              {FORMAT_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          )}
          <Input
            value={localDefaultValue}
            onChange={(e) => handleHeaderChange("defaultValue", e.target.value)}
            placeholder={typeCategory === "Number" ? "0" : typeCategory === "Boolean" ? "true / false" : '""'}
            className="h-7 font-mono text-caption"
            disabled={isReadOnly}
          />
        </div>
      </div>

      {/* Scrollable studio-level sections */}
      <div className="flex-1 overflow-y-auto">
        {SECTION_LABELS.map((label, idx) => (
          <div key={label} className="border-b border-border/30">
            <button
              onClick={() => toggleSection(idx)}
              className="flex items-center justify-between w-full px-space-4 py-space-2 text-body-small font-semibold text-foreground/80 hover:text-foreground transition-colors uppercase tracking-wider"
            >
              {label}
              <ChevronDown className={`w-3.5 h-3.5 transition-transform ${expandedSections.has(idx) ? "" : "-rotate-90"}`} />
            </button>
            {expandedSections.has(idx) && (
              <div className="px-space-4 pb-space-3">
                {idx === 0 && (
                  <ValidationPanel
                    validation={typespec.validation ?? {}}
                    typeCategory={typeCategory}
                    fieldType={localType}
                    onChange={(v) => handleTypespecChange("validation", v)}
                  />
                )}
                {idx === 1 && (
                  <WireFormatPanel
                    wireFormat={typespec.wireFormat ?? {}}
                    fieldType={localType}
                    typeCategory={typeCategory}
                    fieldNumber={localFieldNumber}
                    onFieldNumberChange={(fn) => { setLocalFieldNumber(fn); scheduleSave(); }}
                    onChange={(w) => handleTypespecChange("wireFormat", w)}
                  />
                )}
                {idx === 2 && (
                  <VisibilityPanel
                    visibility={typespec.visibility ?? {}}
                    onChange={(v) => handleTypespecChange("visibility", v)}
                  />
                )}
                {idx === 3 && (
                  <ExtensionsPanel
                    extensions={typespec.extensions ?? {}}
                    onChange={(e) => handleTypespecChange("extensions", e)}
                  />
                )}
                {idx === 4 && (
                  <GovernancePanel
                    governance={(field.decorators as Record<string, unknown>) ?? {}}
                    fieldClassification={localClassification}
                    onClassificationChange={(c) => { setLocalClassification(c); scheduleSave(); }}
                    onChange={(g) => {
                      // Governance updates go to top-level decorators, not typespec
                      // This is handled via the save function
                      scheduleSave();
                    }}
                  />
                )}
                {idx === 5 && (
                  <VersioningPanel
                    versioning={typespec.versioning ?? {}}
                    onChange={(v) => handleTypespecChange("versioning", v)}
                  />
                )}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Footer — save indicator only */}
      <div className="border-t border-border/50 px-space-4 py-space-2">
        <SaveIndicator status={saveStatus} />
      </div>
    </div>
  );
}

function SaveIndicator({ status }: { status: SaveStatus }) {
  switch (status) {
    case "saving":
      return (
        <span className="flex items-center gap-1 text-caption text-muted-foreground animate-pulse">
          <Loader2 className="w-3 h-3 animate-spin" />
          Saving&hellip;
        </span>
      );
    case "saved":
      return (
        <span className="flex items-center gap-1 text-caption text-success">
          <Check className="w-3 h-3" />
          All changes saved
        </span>
      );
    case "error":
      return (
        <span className="flex items-center gap-1 text-caption text-destructive">
          <AlertCircle className="w-3 h-3" />
          Save failed &mdash; retrying&hellip;
        </span>
      );
    default:
      return (
        <span className="flex items-center gap-1 text-caption text-muted-foreground/50">
          <Check className="w-3 h-3" />
          Auto-save enabled
        </span>
      );
  }
}

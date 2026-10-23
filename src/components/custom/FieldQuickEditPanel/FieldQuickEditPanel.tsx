"use client";

import {
  useState,
  useEffect,
  useRef,
  useCallback,
  useMemo,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { ChevronDown, Loader2, AlertCircle } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { TypePicker } from "@/components/custom/TypePicker";
import { getTypeInfo } from "@/lib/data-types";
import { cn } from "@/lib/utils";

// Studio-level panels
import { ValidationPanel } from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/fields/[fieldId]/panels/ValidationPanel";
import { WireFormatPanel } from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/fields/[fieldId]/panels/WireFormatPanel";
import { VisibilityPanel } from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/fields/[fieldId]/panels/VisibilityPanel";
import { ExtensionsPanel } from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/fields/[fieldId]/panels/ExtensionsPanel";
import { VersioningPanel } from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/fields/[fieldId]/panels/VersioningPanel";
import { GovernancePanel } from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/fields/[fieldId]/panels/GovernancePanel";

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

type SaveStatus = "idle" | "saving" | "error";

interface FieldQuickEditPanelProps {
  field: FieldData;
  entityId: string;
  entitySlug?: string;
  domainSlug: string | null;
  isReadOnly?: boolean;
  onUpdateField: (id: string, data: Partial<FieldData>) => Promise<void>;
  onDirtyChange?: (dirty: boolean) => void;
}

// ---------------------------------------------------------------------------
// Section config
// ---------------------------------------------------------------------------

const SECTION_LABELS = [
  "Properties",
  "Validation",
  "Constraints",
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

function InspectorRow({
  label,
  children,
  align = "start",
}: {
  label: string;
  children: ReactNode;
  align?: "start" | "center";
}) {
  return (
    <div
      className={cn(
        "grid grid-cols-[110px_minmax(0,1fr)] gap-x-4",
        align === "center" ? "items-center" : "items-start"
      )}
    >
      <div className="pt-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground/70">
        {label}
      </div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

function CompactToggleRow({
  label,
  description,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  description: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label
      className={cn(
        "grid grid-cols-[auto_86px_minmax(0,1fr)] items-start gap-3 px-3 py-2.5",
        disabled ? "cursor-default" : "cursor-pointer hover:bg-muted/35"
      )}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        disabled={disabled}
        className="mt-1 accent-primary"
      />
      <span className="pt-0.5 text-sm font-medium text-foreground">{label}</span>
      <span className="text-[13px] leading-5 text-muted-foreground">{description}</span>
    </label>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function FieldQuickEditPanel({
  field,
  isReadOnly = false,
  onUpdateField,
  onDirtyChange,
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

  // Save status
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");
  const [justSaved, setJustSaved] = useState(false);

  // Current values ref to avoid stale closures in doSave
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

  // Dirty detection — compare local state to original field prop
  const isDirty = useMemo(() => {
    const origTs = (field.decorators?.typespec ?? {}) as TypeSpecDecorators;
    if (localName !== field.name) return true;
    if (localType !== field.type) return true;
    if (localNullable !== field.nullable) return true;
    if (localIsKey !== field.isKey) return true;
    if (localDescription !== field.description) return true;
    if (localClassification !== field.classification) return true;
    if (localFieldNumber !== field.fieldNumber) return true;
    if (localSecret !== !!origTs.identity?.secret) return true;
    if (localFormat !== (origTs.identity?.format ?? "")) return true;
    const origDefault = origTs.identity?.defaultValue != null ? String(origTs.identity.defaultValue) : "";
    if (localDefaultValue !== origDefault) return true;
    if (localSummary !== (origTs.documentation?.summary ?? "")) return true;
    if (JSON.stringify(typespec) !== JSON.stringify(origTs)) return true;
    return false;
  }, [
    localName, localType, localNullable, localIsKey, localDescription,
    localClassification, localFieldNumber, localSecret, localFormat,
    localDefaultValue, localSummary, typespec, field,
  ]);

  // Notify parent of dirty state changes
  const prevDirtyRef = useRef(isDirty);
  useEffect(() => {
    if (prevDirtyRef.current !== isDirty) {
      prevDirtyRef.current = isDirty;
      onDirtyChange?.(isDirty);
    }
  }, [isDirty, onDirtyChange]);

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
    setJustSaved(false);
  }, [field.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // The same field changed underneath the panel (an inline rename in the field list, a TypeSpec sync): the panel must follow it, or
  // it would show the old values as "Unsaved changes" and a Save would write them back over the change. Local state only: the
  // save flash and status belong to the panel's own save, whose result arrives through these same props.
  const persistedSignature = JSON.stringify([
    field.name, field.type, field.nullable, field.isKey, field.description, field.classification, field.fieldNumber, field.decorators,
  ]);
  const seenSignature = useRef(persistedSignature);
  useEffect(() => {
    if (seenSignature.current === persistedSignature) return;
    seenSignature.current = persistedSignature;
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
  }, [persistedSignature]); // eslint-disable-line react-hooks/exhaustive-deps

  // Discard: reset all local state to field prop values
  const handleDiscard = useCallback(() => {
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
  }, [field]);

  // Save function — called directly (no debounce)
  const doSave = useCallback(async () => {
    setSaveStatus("saving");

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
      setSaveStatus("idle");
      setJustSaved(true);
    } catch {
      setSaveStatus("error");
    }
  }, [field.id, field.decorators, onUpdateField]);

  // Expose save/discard for keyboard shortcuts via ref-stable callbacks
  const saveRef = useRef(doSave);
  saveRef.current = doSave;
  const discardRef = useRef(handleDiscard);
  discardRef.current = handleDiscard;
  const isDirtyRef = useRef(isDirty);
  isDirtyRef.current = isDirty;

  // Typespec sub-object change handler (from studio panels)
  function handleTypespecChange(key: keyof TypeSpecDecorators, value: unknown) {
    setTypespec((prev) => ({ ...prev, [key]: value }));
    setJustSaved(false);
  }

  // Header field change handler — only updates local state (no scheduleSave)
  function handleHeaderChange(sectionField: string, value: unknown) {
    setJustSaved(false); // new change invalidates saved state
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
      <div className="px-space-4 py-space-4 border-b border-border/60">
        <div className="rounded-xl border border-border/50 bg-muted/15 px-space-3 py-space-3.5">
          <div className="space-y-3.5">
            <InspectorRow label="Field Name" align="center">
              {editingName && !isReadOnly ? (
                <Input
                  autoFocus
                  value={localName}
                  onChange={(e) => handleHeaderChange("name", e.target.value)}
                  onBlur={() => setEditingName(false)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === "Escape") setEditingName(false);
                  }}
                  className="h-9 font-mono text-sm font-semibold"
                />
              ) : (
                <button
                  type="button"
                  onClick={() => !isReadOnly && setEditingName(true)}
                  className={cn(
                    "flex w-full items-center justify-between gap-3 rounded-lg px-0 py-1 text-left",
                    !isReadOnly && "cursor-text hover:text-primary"
                  )}
                >
                  <span className="min-w-0 truncate font-mono text-[15px] font-semibold text-foreground">
                    {localName}
                  </span>
                  <span
                    className="shrink-0 rounded-full border border-border/60 bg-background px-2 py-0.5 font-mono text-[11px] text-muted-foreground"
                    title="Position in field list (drag to reorder)"
                  >
                    #{field.sortOrder + 1}
                  </span>
                </button>
              )}
            </InspectorRow>

            <InspectorRow label="Description">
              {editingDescription && !isReadOnly ? (
                <textarea
                  autoFocus
                  value={localDescription}
                  onChange={(e) => handleHeaderChange("description", e.target.value)}
                  onBlur={() => setEditingDescription(false)}
                  onKeyDown={(e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      setEditingDescription(false);
                    }
                    if (e.key === "Escape") setEditingDescription(false);
                  }}
                  rows={3}
                  className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm leading-5 text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:border-ring resize-none"
                  placeholder="Add description..."
                />
              ) : (
                <button
                  type="button"
                  onClick={() => !isReadOnly && setEditingDescription(true)}
                  className={cn(
                    "w-full rounded-lg px-0 py-1 text-left text-sm leading-5",
                    localDescription ? "text-muted-foreground" : "text-muted-foreground/45 italic",
                    !isReadOnly && "cursor-pointer hover:text-foreground transition-colors"
                  )}
                >
                  {localDescription || "Add description..."}
                </button>
              )}
            </InspectorRow>

            <InspectorRow label="Summary" align="center">
              <Input
                value={localSummary}
                onChange={(e) => handleHeaderChange("summary", e.target.value)}
                placeholder="Brief one-line summary"
                className="h-9 text-sm"
                disabled={isReadOnly}
              />
            </InspectorRow>

            <InspectorRow label="Data Type" align="center">
              <div
                className={cn(
                  "grid gap-2",
                  STRING_TYPES.has(localType)
                    ? "grid-cols-[minmax(0,1fr)_132px]"
                    : "grid-cols-1"
                )}
              >
                <TypePicker
                  value={localType}
                  onChange={(t) => handleHeaderChange("type", t)}
                  disabled={isReadOnly}
                  className="h-9 rounded-lg border border-border/60 bg-background px-3 text-sm text-foreground"
                />
                {STRING_TYPES.has(localType) && (
                  <select
                    value={localFormat}
                    onChange={(e) => handleHeaderChange("format", e.target.value)}
                    disabled={isReadOnly}
                    className="h-9 w-full rounded-lg border border-border/60 bg-background px-3 text-sm text-foreground disabled:opacity-50"
                    aria-label="Format"
                  >
                    {FORMAT_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                )}
              </div>
            </InspectorRow>

            <InspectorRow label="Default" align="center">
              <Input
                value={localDefaultValue}
                onChange={(e) => handleHeaderChange("defaultValue", e.target.value)}
                placeholder={
                  typeCategory === "Number"
                    ? "0"
                    : typeCategory === "Boolean"
                      ? "true / false"
                      : '""'
                }
                className="h-9 font-mono text-sm"
                disabled={isReadOnly}
              />
            </InspectorRow>
          </div>
        </div>
      </div>

      {/* Scrollable studio-level sections */}
      <div className="flex-1 overflow-y-auto">
        {SECTION_LABELS.map((label, idx) => (
          <div key={label} className="border-b border-border/30">
            <button
              onClick={() => toggleSection(idx)}
              className="flex items-center justify-between w-full px-space-4 py-space-3 text-[13px] font-semibold tracking-[0.08em] text-foreground/80 hover:text-foreground transition-colors"
            >
              {label}
              <ChevronDown className={`w-3.5 h-3.5 transition-transform ${expandedSections.has(idx) ? "" : "-rotate-90"}`} />
            </button>
            {expandedSections.has(idx) && (
              <div className="px-space-4 pb-space-4">
                {/* 0: Properties — Optional, Secret, Key with descriptions */}
                {idx === 0 && (
                  <div className="overflow-hidden rounded-xl border border-border/40 bg-muted/15 divide-y divide-border/35">
                    <CompactToggleRow
                      label="Optional"
                      description="Field can be null or undefined. Omitted in required lists."
                      checked={localNullable}
                      onChange={(checked) => handleHeaderChange("nullable", checked)}
                      disabled={isReadOnly || localIsKey}
                    />
                    <CompactToggleRow
                      label="Secret"
                      description="Sensitive value. Masked in logs and redacted in responses."
                      checked={localSecret}
                      onChange={(checked) => handleHeaderChange("secret", checked)}
                      disabled={isReadOnly}
                    />
                    <CompactToggleRow
                      label="Key"
                      description="Primary identifier for this entity. Automatically forces non-nullable."
                      checked={localIsKey}
                      onChange={(checked) => {
                        handleHeaderChange("isKey", checked);
                        if (checked) handleHeaderChange("nullable", false);
                      }}
                      disabled={isReadOnly}
                    />
                  </div>
                )}
                {/* 1: Validation — includes quality rules from governance */}
                {idx === 1 && (
                  <ValidationPanel
                    validation={typespec.validation ?? {}}
                    typeCategory={typeCategory}
                    fieldType={localType}
                    onChange={(v) => handleTypespecChange("validation", v)}
                  />
                )}
                {/* 2: Constraints — operational hints (partition, index, cluster) */}
                {idx === 2 && (
                  <div className="overflow-hidden rounded-xl border border-border/40 bg-muted/15 divide-y divide-border/35">
                    <CompactToggleRow
                      label="Partition"
                      description="Use this field for table partitioning to improve performance on large datasets."
                      checked={!!(typespec.governance as Record<string, unknown>)?.operationalHints && ((typespec.governance as Record<string, unknown>).operationalHints as Record<string, boolean>)?.partition}
                      onChange={(checked) => {
                        const gov = (typespec.governance ?? {}) as Record<string, unknown>;
                        const hints = (gov.operationalHints ?? {}) as Record<string, boolean>;
                        handleTypespecChange("governance", {
                          ...gov,
                          operationalHints: { ...hints, partition: checked },
                        });
                      }}
                      disabled={isReadOnly}
                    />
                    <CompactToggleRow
                      label="Index"
                      description="Create an index for faster lookups and filtering on this field."
                      checked={!!(typespec.governance as Record<string, unknown>)?.operationalHints && ((typespec.governance as Record<string, unknown>).operationalHints as Record<string, boolean>)?.index}
                      onChange={(checked) => {
                        const gov = (typespec.governance ?? {}) as Record<string, unknown>;
                        const hints = (gov.operationalHints ?? {}) as Record<string, boolean>;
                        handleTypespecChange("governance", {
                          ...gov,
                          operationalHints: { ...hints, index: checked },
                        });
                      }}
                      disabled={isReadOnly}
                    />
                    <CompactToggleRow
                      label="Cluster"
                      description="Co-locate similar values to optimize range queries and scans."
                      checked={!!(typespec.governance as Record<string, unknown>)?.operationalHints && ((typespec.governance as Record<string, unknown>).operationalHints as Record<string, boolean>)?.cluster}
                      onChange={(checked) => {
                        const gov = (typespec.governance ?? {}) as Record<string, unknown>;
                        const hints = (gov.operationalHints ?? {}) as Record<string, boolean>;
                        handleTypespecChange("governance", {
                          ...gov,
                          operationalHints: { ...hints, cluster: checked },
                        });
                      }}
                      disabled={isReadOnly}
                    />
                  </div>
                )}
                {/* 3: Serialization */}
                {idx === 3 && (
                  <WireFormatPanel
                    wireFormat={typespec.wireFormat ?? {}}
                    fieldType={localType}
                    typeCategory={typeCategory}
                    onChange={(w) => handleTypespecChange("wireFormat", w)}
                  />
                )}
                {/* 4: Access Control */}
                {idx === 4 && (
                  <VisibilityPanel
                    visibility={typespec.visibility ?? {}}
                    onChange={(v) => handleTypespecChange("visibility", v)}
                  />
                )}
                {/* 5: Extensions */}
                {idx === 5 && (
                  <ExtensionsPanel
                    extensions={typespec.extensions ?? {}}
                    onChange={(e) => handleTypespecChange("extensions", e)}
                  />
                )}
                {/* 6: Data Governance — classification, anonymization, encryption */}
                {idx === 6 && (
                  <GovernancePanel
                    governance={typespec.governance ?? {}}
                    fieldClassification={localClassification}
                    onClassificationChange={(c) => { setLocalClassification(c); }}
                    onChange={(g) => handleTypespecChange("governance", g)}
                  />
                )}
                {/* 7: Version History */}
                {idx === 7 && (
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

      {/* Footer — Save/Discard when dirty, error indicator */}
      <div className="border-t border-border/50 px-space-4 py-space-2">
        {saveStatus === "error" && (
          <span className="flex items-center gap-1 text-body-small text-destructive mb-1">
            <AlertCircle className="w-3 h-3" />
            Save failed — try again
          </span>
        )}
        {saveStatus === "saving" && (
          <span className="flex items-center gap-1 text-body-small text-muted-foreground animate-pulse">
            <Loader2 className="w-3 h-3 animate-spin" />
            Saving&hellip;
          </span>
        )}
        {isDirty && !justSaved && saveStatus === "idle" && !isReadOnly && (
          <div className="flex items-center gap-2">
            <span className="text-body-small text-warning flex-1">Unsaved changes</span>
            <Button
              variant="ghost"
              size="sm"
              onClick={handleDiscard}
              className="h-8 text-body-small"
              data-testid="field-discard-btn"
            >
              Discard
            </Button>
            <Button
              size="sm"
              onClick={doSave}
              className="h-8 text-body-small"
              data-testid="field-save-btn"
            >
              Save
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

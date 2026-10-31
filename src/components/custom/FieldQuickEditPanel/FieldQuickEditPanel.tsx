"use client";

import {
  useState,
  useEffect,
  useLayoutEffect,
  useRef,
  useCallback,
  type MutableRefObject,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { ChevronDown, Loader2, AlertCircle } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { TypePicker } from "@/components/custom/TypePicker";
import { getTypeInfo } from "@/lib/data-types";
import {
  applyReferencePick,
  describeEntityRef,
  describeQualifiedName,
  holdsEntityReference,
  readFieldReference,
  referencePickChangesNothing,
  withoutReferenceKeys,
  type PickableEntity,
  type ReferencePick,
} from "@/lib/references/entity-reference";
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
  onSavingChange?: (saving: boolean) => void;
  fieldSaveRef?: MutableRefObject<(() => Promise<boolean>) | null>;
  /** Direct reset for a discard the workspace has already confirmed. */
  fieldDiscardRef?: MutableRefObject<(() => void) | null>;
  /**
   * The entities of the tenant a reference can point at (with their domain and product). When given, choosing the `reference` type asks
   * for the target; the pick is saved with the panel's Save as a fully qualified reference. Without it `reference` is a plain type change.
   */
  referenceTargets?: PickableEntity[];
}

function fieldForm(field: FieldData) {
  const ts = (field.decorators?.typespec ?? {}) as TypeSpecDecorators;
  return {
    localName: field.name, localType: field.type, localNullable: field.nullable,
    localIsKey: field.isKey, localDescription: field.description,
    localClassification: field.classification, localFieldNumber: field.fieldNumber,
    localSecret: !!ts.identity?.secret, localFormat: ts.identity?.format ?? "",
    localDefaultValue: ts.identity?.defaultValue != null ? String(ts.identity.defaultValue) : "",
    localSummary: ts.documentation?.summary ?? "", typespec: ts, localReference: null as ReferencePick | null,
  };
}

/** Adopt refreshed values for untouched controls, including independent nested decorator controls. */
function mergeUntouchedControls(previous: unknown, current: unknown, incoming: unknown): unknown {
  if (JSON.stringify(current) === JSON.stringify(previous)) return incoming;
  const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
  if (!record(current) || !record(incoming) || (previous !== undefined && !record(previous))) return current;
  const before = (previous ?? {}) as Record<string, unknown>;
  const keys = new Set([...Object.keys(before), ...Object.keys(current), ...Object.keys(incoming)]);
  return Object.fromEntries([...keys].map((key) => [key, mergeUntouchedControls(before[key], current[key], incoming[key])]).filter(([, value]) => value !== undefined));
}

/** How a person reads what a reference field points at: `domain / product / entity`, or the name of a name-only reference. */
function referenceLabel(pick: ReferencePick | null, decorators: Record<string, unknown>): string | undefined {
  if (pick) return pick.referencedQualifiedName ? describeQualifiedName(pick.referencedQualifiedName) : pick.referencedEntityName;
  const stored = readFieldReference(decorators);
  if (!stored) return undefined;
  return "legacyName" in stored ? stored.legacyName : describeEntityRef(stored);
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
  onSavingChange,
  fieldSaveRef,
  fieldDiscardRef,
  referenceTargets,
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
  // The target picked for the `reference` type and not saved yet (applied on Save while the type is still `reference`).
  const [localReference, setLocalReference] = useState<ReferencePick | null>(null);

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

  const [saveError, setSaveError] = useState<string | null>(null);
  const [discardOpen, setDiscardOpen] = useState(false);
  const discardCancelRef = useRef<HTMLButtonElement>(null);
  const inFlightSave = useRef<Promise<boolean> | null>(null);
  const editRevision = useRef(0);
  const mountGeneration = useRef<object | null>(null);
  const notificationsRef = useRef({ onDirtyChange, onSavingChange });
  useLayoutEffect(() => {
    notificationsRef.current = { onDirtyChange, onSavingChange };
  }, [onDirtyChange, onSavingChange]);
  useLayoutEffect(() => {
    const generation = {};
    mountGeneration.current = generation;
    return () => {
      if (mountGeneration.current !== generation) return;
      mountGeneration.current = null;
      if (inFlightSave.current) {
        inFlightSave.current = null;
        notificationsRef.current.onSavingChange?.(false);
      }
    };
  }, []);
  useLayoutEffect(() => {
    onSavingChange?.(inFlightSave.current !== null);
  }, [onSavingChange]);

  // A successful save establishes a local baseline immediately; fresh server props may arrive later.
  const form = {
    localName, localType, localNullable, localIsKey, localDescription,
    localClassification, localFieldNumber, localSecret, localFormat,
    localDefaultValue, localSummary, typespec, localReference,
  };
  const [savedForm, setSavedForm] = useState(form);
  const currentRef = useRef(form);
  const savedFormRef = useRef(savedForm);
  const latestPersistedRef = useRef(fieldForm(field));
  const isDirty = JSON.stringify(form) !== JSON.stringify(savedForm);
  const isDirtyRef = useRef(isDirty);
  useLayoutEffect(() => {
    currentRef.current = form;
    savedFormRef.current = savedForm;
    latestPersistedRef.current = fieldForm(field);
    isDirtyRef.current = isDirty;
  });

  const needsProtection = isDirty || saveStatus === "saving";
  const prevDirtyRef = useRef(needsProtection);
  useLayoutEffect(() => {
    if (prevDirtyRef.current !== needsProtection) {
      prevDirtyRef.current = needsProtection;
      onDirtyChange?.(needsProtection);
    }
  }, [needsProtection, onDirtyChange]);

  const applyForm = useCallback((next: typeof form) => {
    setLocalName(next.localName);
    setLocalType(next.localType);
    setLocalNullable(next.localNullable);
    setLocalIsKey(next.localIsKey);
    setLocalDescription(next.localDescription);
    setLocalClassification(next.localClassification);
    setLocalFieldNumber(next.localFieldNumber);
    setLocalSecret(next.localSecret);
    setLocalFormat(next.localFormat);
    setLocalDefaultValue(next.localDefaultValue);
    setLocalSummary(next.localSummary);
    setTypespec(next.typespec);
    setLocalReference(next.localReference);
  }, []);

  const resetForm = useCallback((next: typeof form) => {
    applyForm(next);
    setSavedForm(next);
    setSaveStatus("idle");
    setSaveError(null);
    setJustSaved(false);
  }, [applyForm]);

  const persistedSignature = JSON.stringify([
    field.id, field.name, field.type, field.nullable, field.isKey, field.description,
    field.classification, field.fieldNumber, field.decorators,
  ]);
  const [seenPersisted, setSeenPersisted] = useState({ signature: persistedSignature, fieldId: field.id });
  // Adjust local state once when server props change, before committing the next render.
  if (seenPersisted.signature !== persistedSignature) {
    const changedField = seenPersisted.fieldId !== field.id;
    setSeenPersisted({ signature: persistedSignature, fieldId: field.id });
    const next = fieldForm(field);
    // Observe a response once, but never overwrite newer local edits with its older values.
    if (!changedField && (isDirty || saveStatus === "saving")) {
      applyForm(mergeUntouchedControls(savedForm, form, next) as typeof form);
      if (saveStatus !== "saving") setSavedForm(next);
    } else {
      resetForm(next);
    }
  }

  // The workspace calls this directly only after its own discard confirmation.
  const handleDiscard = useCallback(() => {
    if (inFlightSave.current || !mountGeneration.current) return;
    resetForm(savedFormRef.current);
    prevDirtyRef.current = false;
    onDirtyChange?.(false);
  }, [resetForm, onDirtyChange]);

  // Save requests from the footer, shortcuts and navigation guard share one in-flight write.
  const doSave = useCallback((): Promise<boolean> => {
    if (!mountGeneration.current) return Promise.resolve(false);
    if (inFlightSave.current) return inFlightSave.current;
    if (isReadOnly) return Promise.resolve(false);
    if (!isDirtyRef.current) return Promise.resolve(true);
    const generation = mountGeneration.current;
    const submittedRevision = editRevision.current;
    const previousBaseline = savedFormRef.current;
    const c = currentRef.current;
    setSaveStatus("saving");
    setSaveError(null);
    setDiscardOpen(false);
    prevDirtyRef.current = true;
    notificationsRef.current.onDirtyChange?.(true);
    notificationsRef.current.onSavingChange?.(true);

    const pending = (async () => {
      try {
        const mergedTypespec = { ...c.typespec };
        const identity = { ...(mergedTypespec.identity ?? {}) };
        if (c.localSecret) identity.secret = true; else delete identity.secret;
        if (c.localFormat) identity.format = c.localFormat; else identity.format = null;
        if (c.localDefaultValue) identity.defaultValue = c.localDefaultValue; else delete identity.defaultValue;
        mergedTypespec.identity = identity;

        const documentation = { ...(mergedTypespec.documentation ?? {}) };
        if (c.localSummary) documentation.summary = c.localSummary; else delete documentation.summary;
        mergedTypespec.documentation = documentation;

        let decorators: Record<string, unknown> = { ...field.decorators, typespec: mergedTypespec };
        if (c.localType === "reference" && c.localReference) decorators = applyReferencePick(decorators, c.localReference);
        if (!holdsEntityReference(c.localType, decorators)) decorators = withoutReferenceKeys(decorators);

        await onUpdateField(field.id, {
          name: c.localName, type: c.localType, nullable: c.localNullable,
          isKey: c.localIsKey, description: c.localDescription,
          classification: c.localClassification, fieldNumber: c.localFieldNumber, decorators,
        });
        if (mountGeneration.current !== generation) return false;
        const allEditsSaved = editRevision.current === submittedRevision;
        const persistedBaseline = mergeUntouchedControls(previousBaseline, c, latestPersistedRef.current) as typeof form;
        setSavedForm(allEditsSaved ? currentRef.current : persistedBaseline);
        setSaveStatus("idle");
        setJustSaved(allEditsSaved);
        if (allEditsSaved) {
          prevDirtyRef.current = false;
          notificationsRef.current.onDirtyChange?.(false);
        }
        // A newer edit still needs saving: the navigation guard must keep this panel open.
        return allEditsSaved;
      } catch (error) {
        if (mountGeneration.current !== generation) return false;
        setSaveStatus("error");
        setSaveError(error instanceof Error ? error.message : "Save failed. Please try again.");
        return false;
      }
    })();
    inFlightSave.current = pending;
    void pending.then(() => {
      if (mountGeneration.current !== generation || inFlightSave.current !== pending) return;
      inFlightSave.current = null;
      notificationsRef.current.onSavingChange?.(false);
    });
    return pending;
  }, [field.id, field.decorators, isReadOnly, onUpdateField]);

  const saveRef = useRef(doSave);
  const discardRef = useRef(handleDiscard);
  useLayoutEffect(() => {
    saveRef.current = doSave;
    discardRef.current = handleDiscard;
  }, [doSave, handleDiscard]);
  useEffect(() => {
    const save = () => saveRef.current();
    const discard = () => discardRef.current();
    if (fieldSaveRef) fieldSaveRef.current = save;
    if (fieldDiscardRef) fieldDiscardRef.current = discard;
    return () => {
      if (fieldSaveRef?.current === save) fieldSaveRef.current = null;
      if (fieldDiscardRef?.current === discard) fieldDiscardRef.current = null;
    };
  }, [fieldSaveRef, fieldDiscardRef]);

  // Typespec sub-object change handler (from studio panels)
  function handleTypespecChange(key: keyof TypeSpecDecorators, value: unknown) {
    editRevision.current += 1;
    setTypespec((prev) => ({ ...prev, [key]: value }));
    setJustSaved(false);
  }

  // Header field change handler — only updates local state (no scheduleSave)
  function handleHeaderChange(sectionField: string, value: unknown) {
    editRevision.current += 1;
    setJustSaved(false); // new change invalidates saved state
    switch (sectionField) {
      case "name": setLocalName(value as string); break;
      case "type":
        setLocalType(value as string);
        setLocalReference(null); // a target picked for an earlier `reference` is not this type's (the prompt sets it again right after)
        break;
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
                  aria-label="Field name"
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
                  aria-label="Field description"
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
                aria-label="Summary"
                onChange={(e) => handleHeaderChange("summary", e.target.value)}
                placeholder="Brief one-line summary"
                className="h-9 text-sm"
                disabled={isReadOnly}
              />
            </InspectorRow>

            <InspectorRow label="Data Type" align="center">
              <div
                className="grid grid-cols-1 gap-2"
              >
                <TypePicker
                  value={localType}
                  onChange={(t) => handleHeaderChange("type", t)}
                  entities={referenceTargets}
                  promptTypes={["reference"]}
                  onComplexTypeConfig={
                    referenceTargets
                      ? (_type, config) => {
                          editRevision.current += 1;
                          setJustSaved(false);
                          // The same target picked again writes the decorators the field already has (and the saved field would not change
                          // either, so nothing would ever clear a pending pick): that is no change at all.
                          setLocalReference(referencePickChangesNothing(field.decorators, config) ? null : config);
                        }
                      : undefined
                  }
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

            {localType === "reference" && referenceLabel(localReference, field.decorators) && (
              <InspectorRow label="References" align="center">
                <p data-testid="field-reference-target" className="truncate font-mono text-sm text-foreground">
                  → {referenceLabel(localReference, field.decorators)}
                </p>
              </InspectorRow>
            )}

            <InspectorRow label="Default" align="center">
              <Input
                value={localDefaultValue}
                aria-label="Default value"
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
              aria-expanded={expandedSections.has(idx)}
              aria-controls={`field-section-${field.id}-${idx}`}
              className="flex items-center justify-between w-full px-space-4 py-space-3 text-[13px] font-semibold tracking-[0.08em] text-foreground/80 hover:text-foreground transition-colors"
            >
              {label}
              <ChevronDown className={`w-3.5 h-3.5 transition-transform ${expandedSections.has(idx) ? "" : "-rotate-90"}`} />
            </button>
            {expandedSections.has(idx) && (
              <div id={`field-section-${field.id}-${idx}`} className="px-space-4 pb-space-4">
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
                    onClassificationChange={(c) => { editRevision.current += 1; setLocalClassification(c); setJustSaved(false); }}
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
          <span role="alert" className="flex items-center gap-1 text-body-small text-destructive mb-1">
            <AlertCircle aria-hidden="true" className="w-3 h-3" />
            {saveError ?? "Save failed. Please try again."}
          </span>
        )}
        {saveStatus === "saving" && (
          <span role="status" className="flex items-center gap-1 text-body-small text-muted-foreground animate-pulse">
            <Loader2 className="w-3 h-3 animate-spin" />
            Saving&hellip;
          </span>
        )}
        {isDirty && !justSaved && saveStatus !== "saving" && !isReadOnly && (
          <div className="flex items-center gap-2">
            <span className="text-body-small text-warning flex-1">Unsaved changes</span>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setDiscardOpen(true)}
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
              {saveStatus === "error" ? "Retry save" : "Save"}
            </Button>
          </div>
        )}
      </div>
      <Dialog open={discardOpen} onOpenChange={setDiscardOpen}>
        <DialogContent initialFocus={discardCancelRef}>
          <DialogHeader>
            <DialogTitle>Discard field edits?</DialogTitle>
            <DialogDescription>
              Your unsaved changes to this field will be lost. The saved draft will remain unchanged.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button ref={discardCancelRef} variant="outline" onClick={() => setDiscardOpen(false)}>
              Keep editing
            </Button>
            <Button variant="destructive" disabled={saveStatus === "saving"} data-testid="field-confirm-discard" onClick={() => {
              handleDiscard();
              setDiscardOpen(false);
            }}>
              Discard changes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { ChevronDown, Loader2, Check, AlertCircle } from "lucide-react";
import Link from "next/link";
import { IdentitySection } from "./IdentitySection";
import { ValidationSection } from "./ValidationSection";
import { DocumentationSection } from "./DocumentationSection";
import { GovernanceSection } from "./GovernanceSection";

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

type SaveStatus = "idle" | "saving" | "saved" | "error";

interface FieldQuickEditPanelProps {
  field: FieldData;
  entityId: string;
  entitySlug?: string;
  domainSlug: string;
  isReadOnly?: boolean;
  onUpdateField: (id: string, data: Partial<FieldData>) => Promise<void>;
}

const SECTION_LABELS = ["Semantics", "Validation", "Documentation", "Governance"] as const;

export function FieldQuickEditPanel({
  field,
  entityId,
  entitySlug,
  domainSlug,
  isReadOnly = false,
  onUpdateField,
}: FieldQuickEditPanelProps) {
  const [expandedSections, setExpandedSections] = useState<Set<number>>(new Set([0, 2]));

  // Local state mirrors the field data for fast editing
  const [localName, setLocalName] = useState(field.name);
  const [localType, setLocalType] = useState(field.type);
  const [localNullable, setLocalNullable] = useState(field.nullable);
  const [localIsKey, setLocalIsKey] = useState(field.isKey);
  const [localDescription, setLocalDescription] = useState(field.description);
  const [localClassification, setLocalClassification] = useState(field.classification);

  // TypeSpec decorator local state
  const tsDecorators = (field.decorators?.typespec ?? {}) as Record<string, Record<string, unknown>>;
  const identity = (tsDecorators.identity ?? {}) as Record<string, unknown>;
  const validation = (tsDecorators.validation ?? {}) as Record<string, unknown>;
  const documentation = (tsDecorators.documentation ?? {}) as Record<string, unknown>;
  const policy = (field.decorators?.policy ?? {}) as Record<string, string>;

  const [localSecret, setLocalSecret] = useState(!!identity.secret);
  const [localFormat, setLocalFormat] = useState((identity.format as string) ?? "");
  const [localDefaultValue, setLocalDefaultValue] = useState((identity.defaultValue as string) ?? "");
  const [localSummary, setLocalSummary] = useState((documentation.summary as string) ?? "");

  // Validation local state
  const [localMinValue, setLocalMinValue] = useState<number | null>((validation.minValue as number) ?? null);
  const [localMaxValue, setLocalMaxValue] = useState<number | null>((validation.maxValue as number) ?? null);
  const [localMinLength, setLocalMinLength] = useState<number | null>((validation.minLength as number) ?? null);
  const [localMaxLength, setLocalMaxLength] = useState<number | null>((validation.maxLength as number) ?? null);
  const [localPattern, setLocalPattern] = useState<string | null>((validation.pattern as string) ?? null);
  const [localMinItems, setLocalMinItems] = useState<number | null>((validation.minItems as number) ?? null);
  const [localMaxItems, setLocalMaxItems] = useState<number | null>((validation.maxItems as number) ?? null);

  // Governance local state
  const [localRetention, setLocalRetention] = useState(policy.retention ?? "");
  const [localAnonymization, setLocalAnonymization] = useState(policy.anonymization ?? "");
  const [localEncryption, setLocalEncryption] = useState(policy.encryption ?? "");

  // Save machinery
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRef = useRef(false);
  const savingRef = useRef(false);

  // Current values ref to avoid stale closures
  const currentRef = useRef({
    localName,
    localType,
    localNullable,
    localIsKey,
    localDescription,
    localClassification,
    localSecret,
    localFormat,
    localDefaultValue,
    localSummary,
    localMinValue,
    localMaxValue,
    localMinLength,
    localMaxLength,
    localPattern,
    localMinItems,
    localMaxItems,
    localRetention,
    localAnonymization,
    localEncryption,
  });

  // Keep ref in sync
  useEffect(() => {
    currentRef.current = {
      localName,
      localType,
      localNullable,
      localIsKey,
      localDescription,
      localClassification,
      localSecret,
      localFormat,
      localDefaultValue,
      localSummary,
      localMinValue,
      localMaxValue,
      localMinLength,
      localMaxLength,
      localPattern,
      localMinItems,
      localMaxItems,
      localRetention,
      localAnonymization,
      localEncryption,
    };
  });

  // Reset local state on field switch
  useEffect(() => {
    setLocalName(field.name);
    setLocalType(field.type);
    setLocalNullable(field.nullable);
    setLocalIsKey(field.isKey);
    setLocalDescription(field.description);
    setLocalClassification(field.classification);

    const ts = (field.decorators?.typespec ?? {}) as Record<string, Record<string, unknown>>;
    const id = (ts.identity ?? {}) as Record<string, unknown>;
    const val = (ts.validation ?? {}) as Record<string, unknown>;
    const doc = (ts.documentation ?? {}) as Record<string, unknown>;
    const pol = (field.decorators?.policy ?? {}) as Record<string, string>;

    setLocalSecret(!!id.secret);
    setLocalFormat((id.format as string) ?? "");
    setLocalDefaultValue((id.defaultValue as string) ?? "");
    setLocalSummary((doc.summary as string) ?? "");
    setLocalMinValue((val.minValue as number) ?? null);
    setLocalMaxValue((val.maxValue as number) ?? null);
    setLocalMinLength((val.minLength as number) ?? null);
    setLocalMaxLength((val.maxLength as number) ?? null);
    setLocalPattern((val.pattern as string) ?? null);
    setLocalMinItems((val.minItems as number) ?? null);
    setLocalMaxItems((val.maxItems as number) ?? null);
    setLocalRetention(pol.retention ?? "");
    setLocalAnonymization(pol.anonymization ?? "");
    setLocalEncryption(pol.encryption ?? "");

    setSaveStatus("idle");
  }, [field.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const doSave = useCallback(async () => {
    if (savingRef.current) return;
    savingRef.current = true;
    setSaveStatus("saving");
    pendingRef.current = false;

    const c = currentRef.current;

    // Build updated decorators
    const existingDecorators = { ...field.decorators };
    const existingTs = (existingDecorators.typespec ?? {}) as Record<string, unknown>;

    // Clean up null/empty values from validation
    const cleanValidation: Record<string, unknown> = {};
    if (c.localMinValue != null) cleanValidation.minValue = c.localMinValue;
    if (c.localMaxValue != null) cleanValidation.maxValue = c.localMaxValue;
    if (c.localMinLength != null) cleanValidation.minLength = c.localMinLength;
    if (c.localMaxLength != null) cleanValidation.maxLength = c.localMaxLength;
    if (c.localPattern) cleanValidation.pattern = c.localPattern;
    if (c.localMinItems != null) cleanValidation.minItems = c.localMinItems;
    if (c.localMaxItems != null) cleanValidation.maxItems = c.localMaxItems;

    const cleanIdentity: Record<string, unknown> = {};
    if (c.localSecret) cleanIdentity.secret = true;
    if (c.localFormat) cleanIdentity.format = c.localFormat;
    if (c.localDefaultValue) cleanIdentity.defaultValue = c.localDefaultValue;

    const cleanDocumentation: Record<string, unknown> = {};
    if (c.localSummary) cleanDocumentation.summary = c.localSummary;

    const updatedTypespec = {
      ...existingTs,
      identity: Object.keys(cleanIdentity).length > 0 ? cleanIdentity : undefined,
      validation: Object.keys(cleanValidation).length > 0 ? cleanValidation : undefined,
      documentation: Object.keys(cleanDocumentation).length > 0 ? cleanDocumentation : undefined,
    };

    const cleanPolicy: Record<string, string> = {};
    if (c.localRetention) cleanPolicy.retention = c.localRetention;
    if (c.localAnonymization) cleanPolicy.anonymization = c.localAnonymization;
    if (c.localEncryption) cleanPolicy.encryption = c.localEncryption;

    const updatedDecorators = {
      ...existingDecorators,
      typespec: updatedTypespec,
      policy: Object.keys(cleanPolicy).length > 0 ? cleanPolicy : undefined,
    };

    try {
      await onUpdateField(field.id, {
        name: c.localName,
        type: c.localType,
        nullable: c.localNullable,
        isKey: c.localIsKey,
        description: c.localDescription,
        classification: c.localClassification,
        decorators: updatedDecorators,
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
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
    }
    pendingRef.current = true;
    saveTimeoutRef.current = setTimeout(doSave, 500);
  }, [doSave]);

  // Flush on field switch or unmount
  useEffect(() => {
    return () => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
        saveTimeoutRef.current = null;
      }
      if (pendingRef.current && !savingRef.current) {
        pendingRef.current = false;
        // Fire-and-forget flush
        doSave();
      }
    };
  }, [field.id, doSave]);

  function handleChange(sectionField: string, value: unknown) {
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
      case "classification": setLocalClassification(value as string | null); break;
      case "minValue": setLocalMinValue(value as number | null); break;
      case "maxValue": setLocalMaxValue(value as number | null); break;
      case "minLength": setLocalMinLength(value as number | null); break;
      case "maxLength": setLocalMaxLength(value as number | null); break;
      case "pattern": setLocalPattern(value as string | null); break;
      case "minItems": setLocalMinItems(value as number | null); break;
      case "maxItems": setLocalMaxItems(value as number | null); break;
      case "retention": setLocalRetention(value as string); break;
      case "anonymization": setLocalAnonymization(value as string); break;
      case "encryption": setLocalEncryption(value as string); break;
    }
    scheduleSave();
  }

  function toggleSection(idx: number) {
    setExpandedSections((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  }

  return (
    <div className="flex flex-col h-full" data-testid="field-quick-edit-panel">
      {/* Field name header */}
      <div className="px-space-4 py-space-2 border-b border-border/50">
        <span className="font-mono text-body-small text-foreground font-medium">{localName}</span>
      </div>

      {/* Scrollable sections */}
      <div className="flex-1 overflow-y-auto">
        {SECTION_LABELS.map((label, idx) => (
          <div key={label} className="border-b border-border/30">
            <button
              onClick={() => toggleSection(idx)}
              className="flex items-center justify-between w-full px-space-4 py-space-2 text-caption font-medium text-muted-foreground hover:text-foreground transition-colors"
            >
              {label}
              <ChevronDown
                className={`w-3.5 h-3.5 transition-transform ${expandedSections.has(idx) ? "" : "-rotate-90"}`}
              />
            </button>
            {expandedSections.has(idx) && (
              <div className="px-space-4 pb-space-3">
                {idx === 0 && (
                  <IdentitySection
                    name={localName}
                    type={localType}
                    nullable={localNullable}
                    isKey={localIsKey}
                    secret={localSecret}
                    format={localFormat}
                    defaultValue={localDefaultValue}
                    isReadOnly={isReadOnly}
                    onChange={handleChange}
                  />
                )}
                {idx === 1 && (
                  <ValidationSection
                    type={localType}
                    values={{
                      minValue: localMinValue,
                      maxValue: localMaxValue,
                      minLength: localMinLength,
                      maxLength: localMaxLength,
                      pattern: localPattern,
                      minItems: localMinItems,
                      maxItems: localMaxItems,
                    }}
                    isReadOnly={isReadOnly}
                    onChange={handleChange}
                  />
                )}
                {idx === 2 && (
                  <DocumentationSection
                    description={localDescription}
                    summary={localSummary}
                    isReadOnly={isReadOnly}
                    onChange={handleChange}
                  />
                )}
                {idx === 3 && (
                  <GovernanceSection
                    classification={localClassification}
                    retention={localRetention}
                    anonymization={localAnonymization}
                    encryption={localEncryption}
                    isReadOnly={isReadOnly}
                    onChange={handleChange}
                  />
                )}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Footer */}
      <div className="border-t border-border/50 px-space-4 py-space-2 space-y-space-2">
        {/* Save indicator */}
        <div className="flex items-center justify-between">
          <SaveIndicator status={saveStatus} />
        </div>
        <div>
          <Link
            href={`/schemas/${domainSlug}/${entitySlug || entityId}/fields/${field.id}`}
            className="text-caption text-primary hover:underline"
          >
            Open Full Field Studio &rarr;
          </Link>
          <p className="text-[10px] text-muted-foreground/60 mt-0.5">
            Wire Format, Visibility, Versioning, Extensions
          </p>
        </div>
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

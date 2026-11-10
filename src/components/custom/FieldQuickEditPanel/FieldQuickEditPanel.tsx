"use client";

import {
  fieldDescription,
  fieldPresence,
  normalizeFieldDocumentation,
  storeFieldPresence,
  fieldAttributeErrors,
} from "@/lib/field-attributes";
import {
  FieldAttributeSections,
  type FieldAttributeExtras,
} from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/fields/[fieldId]/panels/FieldAttributeSections";
import { DescriptionEditor } from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/fields/[fieldId]/panels/DocumentationPanel";
import type { PolicyContext } from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/fields/[fieldId]/panels/GovernancePanel";

import {
  useState,
  useEffect,
  useLayoutEffect,
  useRef,
  useCallback,
  type MutableRefObject,
  type ReactNode,
} from "react";
import { Loader2, AlertCircle } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { TypePicker } from "@/components/custom/TypePicker";
import {
  defaultInput,
  storedDefaultText,
} from "@/lib/compiler/typed-value-literal";
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
  policyContext?: PolicyContext;
  knownVersions?: string[];
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
  const normalized = normalizeFieldDocumentation(field);
  const ts = (normalized.decorators.typespec ?? {}) as TypeSpecDecorators;
  const presence = fieldPresence(field);
  return {
    localName: field.name,
    localType: field.type,
    localNullable: presence.optional,
    localAllowNull: presence.allowNull,
    localPrecision: field.precision,
    localScale: field.scale,
    localAliases: field.aliases,
    localDecorators: normalized.decorators,
    localIsKey: field.isKey,
    localDescription: fieldDescription(field),
    localClassification: field.classification,
    localFieldNumber: field.fieldNumber,
    localSecret: !!ts.identity?.secret,
    localFormat: ts.identity?.format ?? "",
    localDefaultValue: storedDefaultText(ts.identity?.defaultValue, field.type),
    typespec: ts,
    localReference: null as ReferencePick | null,
  };
}

/** Adopt refreshed values for untouched controls, including independent nested decorator controls. */
function mergeUntouchedControls(
  previous: unknown,
  current: unknown,
  incoming: unknown,
): unknown {
  if (JSON.stringify(current) === JSON.stringify(previous)) return incoming;
  const record = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === "object" && !Array.isArray(value);
  if (
    !record(current) ||
    !record(incoming) ||
    (previous !== undefined && !record(previous))
  )
    return current;
  const before = (previous ?? {}) as Record<string, unknown>;
  const keys = new Set([
    ...Object.keys(before),
    ...Object.keys(current),
    ...Object.keys(incoming),
  ]);
  return Object.fromEntries(
    [...keys]
      .map((key) => [
        key,
        mergeUntouchedControls(before[key], current[key], incoming[key]),
      ])
      .filter(([, value]) => value !== undefined),
  );
}

/** How a person reads what a reference field points at: `domain / product / entity`, or the name of a name-only reference. */
function referenceLabel(
  pick: ReferencePick | null,
  decorators: Record<string, unknown>,
): string | undefined {
  if (pick)
    return pick.referencedQualifiedName
      ? describeQualifiedName(pick.referencedQualifiedName)
      : pick.referencedEntityName;
  const stored = readFieldReference(decorators);
  if (!stored) return undefined;
  return "legacyName" in stored ? stored.legacyName : describeEntityRef(stored);
}

// ---------------------------------------------------------------------------
// Section config
// ---------------------------------------------------------------------------

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
        align === "center" ? "items-center" : "items-start",
      )}
    >
      <div className="pt-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
        {label}
      </div>
      <div className="min-w-0">{children}</div>
    </div>
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
  policyContext,
  knownVersions,
}: FieldQuickEditPanelProps) {
  const [expandedSections, setExpandedSections] = useState<Set<number>>(
    new Set([0]),
  );

  // Core field state (shown in header)
  const [localName, setLocalName] = useState(field.name);
  const [localType, setLocalType] = useState(field.type);
  const [localNullable, setLocalNullable] = useState(
    fieldPresence(field).optional,
  );
  const [localIsKey, setLocalIsKey] = useState(field.isKey);
  const [localDescription, setLocalDescription] = useState(
    fieldDescription(field),
  );
  const [localClassification, setLocalClassification] = useState<string | null>(
    field.classification,
  );
  const [localFieldNumber, setLocalFieldNumber] = useState<number | null>(
    field.fieldNumber,
  );
  const [localAllowNull, setLocalAllowNull] = useState(
    fieldPresence(field).allowNull,
  );
  const [localPrecision, setLocalPrecision] = useState(field.precision);
  const [localScale, setLocalScale] = useState(field.scale);
  const [localAliases, setLocalAliases] = useState(field.aliases);
  const [localDecorators, setLocalDecorators] = useState(
    normalizeFieldDocumentation(field).decorators,
  );
  // The target picked for the `reference` type and not saved yet (applied on Save while the type is still `reference`).
  const [localReference, setLocalReference] = useState<ReferencePick | null>(
    null,
  );

  // TypeSpec decorators — single state object like Field Studio
  const existingTypespec = (normalizeFieldDocumentation(field).decorators
    .typespec ?? {}) as TypeSpecDecorators;
  const [typespec, setTypespec] =
    useState<TypeSpecDecorators>(existingTypespec);

  // Header identity state derived from typespec
  const [localSecret, setLocalSecret] = useState(!!typespec.identity?.secret);
  const [localFormat, setLocalFormat] = useState(
    typespec.identity?.format ?? "",
  );
  const [localDefaultValue, setLocalDefaultValue] = useState(
    storedDefaultText(typespec.identity?.defaultValue, field.type),
  );

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
    localName,
    localType,
    localNullable,
    localIsKey,
    localDescription,
    localClassification,
    localFieldNumber,
    localSecret,
    localFormat,
    localDefaultValue,
    typespec,
    localReference,
    localAllowNull,
    localPrecision,
    localScale,
    localAliases,
    localDecorators,
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
    setLocalAllowNull(next.localAllowNull);
    setLocalPrecision(next.localPrecision);
    setLocalScale(next.localScale);
    setLocalAliases(next.localAliases);
    setLocalDecorators(next.localDecorators);
    setTypespec(next.typespec);
    setLocalReference(next.localReference);
  }, []);

  const resetForm = useCallback(
    (next: typeof form) => {
      applyForm(next);
      setSavedForm(next);
      setSaveStatus("idle");
      setSaveError(null);
      setJustSaved(false);
    },
    [applyForm],
  );

  const persistedSignature = JSON.stringify([
    field.id,
    field.name,
    field.type,
    field.nullable,
    field.isKey,
    field.description,
    field.classification,
    field.fieldNumber,
    field.decorators,
    field.precision,
    field.scale,
    field.aliases,
  ]);
  const [seenPersisted, setSeenPersisted] = useState({
    signature: persistedSignature,
    fieldId: field.id,
  });
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
        const identity = {
          ...(mergedTypespec.identity ?? {}),
          key: c.localIsKey,
        };
        if (c.localSecret) identity.secret = true;
        else delete identity.secret;
        if (c.localFormat) identity.format = c.localFormat;
        else identity.format = null;
        // The default is saved as the value the field's type takes (a number for a numeric field, a boolean for a boolean). It is derived again only
        // when its text or the field's type was changed here: a stored default that no longer fits (saved before the rule, or kept by another
        // editor) stays as it is, so an unrelated edit is not refused. Text changed to something that does not fit is refused, so nothing is
        // saved until it is corrected or cleared.
        const persisted = latestPersistedRef.current;
        if (
          c.localDefaultValue === persisted.localDefaultValue &&
          c.localType === persisted.localType
        ) {
          const stored = (
            field.decorators?.typespec as TypeSpecDecorators | undefined
          )?.identity?.defaultValue;
          if (stored === undefined) delete identity.defaultValue;
          else identity.defaultValue = stored;
        } else {
          const defaultValue = defaultInput(c.localDefaultValue, c.localType);
          if (defaultValue.status === "rejected")
            throw new Error(`Default value ${defaultValue.reason}.`);
          if (defaultValue.status === "value")
            identity.defaultValue = defaultValue.value;
          else delete identity.defaultValue;
        }
        mergedTypespec.identity = identity;

        let decorators: Record<string, unknown> = {
          ...c.localDecorators,
          typespec: mergedTypespec,
        };
        if (c.localType === "reference" && c.localReference)
          decorators = applyReferencePick(decorators, c.localReference);
        if (!holdsEntityReference(c.localType, decorators))
          decorators = withoutReferenceKeys(decorators);

        const presence = storeFieldPresence(
          c.localIsKey ? false : c.localNullable,
          c.localIsKey ? false : c.localAllowNull,
          decorators,
        );
        const normalized = normalizeFieldDocumentation(
          { decorators: presence.decorators },
          c.localDescription,
        );
        const errors = fieldAttributeErrors({
          type: c.localType,
          precision: c.localPrecision,
          scale: c.localScale,
          fieldNumber: c.localFieldNumber,
          decorators: normalized.decorators,
        });
        if (errors.length) throw new Error(errors.join(" "));
        await onUpdateField(field.id, {
          name: c.localName,
          type: c.localType,
          nullable: presence.nullable,
          precision: c.localPrecision,
          scale: c.localScale,
          aliases: c.localAliases,
          isKey: c.localIsKey,
          description: c.localDescription,
          classification: c.localClassification,
          fieldNumber: c.localFieldNumber,
          decorators: normalized.decorators,
        });
        if (mountGeneration.current !== generation) return false;
        const allEditsSaved = editRevision.current === submittedRevision;
        const persistedBaseline = mergeUntouchedControls(
          previousBaseline,
          c,
          latestPersistedRef.current,
        ) as typeof form;
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
        setSaveError(
          error instanceof Error
            ? error.message
            : "Save failed. Please try again.",
        );
        return false;
      }
    })();
    inFlightSave.current = pending;
    void pending.then(() => {
      if (
        mountGeneration.current !== generation ||
        inFlightSave.current !== pending
      )
        return;
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
      case "name":
        setLocalName(value as string);
        break;
      case "type":
        setLocalType(value as string);
        setLocalReference(null); // a target picked for an earlier `reference` is not this type's (the prompt sets it again right after)
        break;
      case "nullable":
        setLocalNullable(value as boolean);
        break;
      case "isKey":
        setLocalIsKey(value as boolean);
        break;
      case "secret":
        setLocalSecret(value as boolean);
        break;
      case "format":
        setLocalFormat(value as string);
        break;
      case "defaultValue":
        setLocalDefaultValue(value as string);
        break;
      case "description":
        setLocalDescription(value as string);
        break;
    }
  }

  const [editingName, setEditingName] = useState(false);

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
                    if (e.key === "Enter" || e.key === "Escape")
                      setEditingName(false);
                  }}
                  className="h-9 font-mono text-sm font-semibold"
                />
              ) : (
                <button
                  type="button"
                  onClick={() => !isReadOnly && setEditingName(true)}
                  className={cn(
                    "flex w-full items-center justify-between gap-3 rounded-lg px-0 py-1 text-left",
                    !isReadOnly && "cursor-text hover:text-primary",
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

            <fieldset disabled={isReadOnly} className="min-w-0">
              <legend className="sr-only">Field documentation</legend>
              <DescriptionEditor
                value={localDescription}
                onChange={(value) => handleHeaderChange("description", value)}
              />
            </fieldset>

            <InspectorRow label="Data Type" align="center">
              <div className="grid grid-cols-1 gap-2">
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
                          setLocalReference(
                            referencePickChangesNothing(
                              field.decorators,
                              config,
                            )
                              ? null
                              : config,
                          );
                        }
                      : undefined
                  }
                  disabled={isReadOnly}
                  className="h-9 rounded-lg border border-border/60 bg-background px-3 text-sm text-foreground"
                />
              </div>
            </InspectorRow>

            {localType === "reference" &&
              referenceLabel(localReference, field.decorators) && (
                <InspectorRow label="References" align="center">
                  <p
                    data-testid="field-reference-target"
                    className="truncate font-mono text-sm text-foreground"
                  >
                    → {referenceLabel(localReference, field.decorators)}
                  </p>
                </InspectorRow>
              )}
          </div>
        </div>
      </div>

      {/* Scrollable studio-level sections */}
      <div className="flex-1 overflow-y-auto">
        <FieldAttributeSections
          referenceTargets={referenceTargets}
          fieldType={localType}
          typespec={typespec}
          identity={{
            ...typespec.identity,
            key: localIsKey,
            secret: localSecret,
            format: localFormat,
            defaultValue:
              defaultInput(localDefaultValue, localType).status === "value"
                ? (
                    defaultInput(localDefaultValue, localType) as {
                      value: unknown;
                    }
                  ).value
                : localDefaultValue || null,
          }}
          optional={localNullable}
          allowNull={localAllowNull}
          classification={localClassification}
          fieldNumber={localFieldNumber}
          extras={{
            precision: localPrecision,
            scale: localScale,
            aliases: localAliases,
            decorators: localDecorators,
          }}
          expanded={[...expandedSections]}
          onExpandedChange={(values) => setExpandedSections(new Set(values))}
          readOnly={isReadOnly}
          policyContext={policyContext}
          knownVersions={knownVersions}
          onTypespecChange={handleTypespecChange}
          onIdentityChange={(value) => {
            handleTypespecChange("identity", value);
            setLocalIsKey(value.key ?? false);
            setLocalSecret(value.secret ?? false);
            setLocalFormat(value.format ?? "");
            setLocalDefaultValue(
              storedDefaultText(value.defaultValue, localType),
            );
          }}
          onOptionalChange={(value) => handleHeaderChange("nullable", value)}
          onAllowNullChange={(value) => {
            editRevision.current += 1;
            setLocalAllowNull(value);
            setJustSaved(false);
          }}
          onClassificationChange={(value) => {
            editRevision.current += 1;
            setLocalClassification(value);
            setJustSaved(false);
          }}
          onFieldNumberChange={(value) => {
            editRevision.current += 1;
            setLocalFieldNumber(value);
            setJustSaved(false);
          }}
          onExtrasChange={(value: Partial<FieldAttributeExtras>) => {
            editRevision.current += 1;
            setJustSaved(false);
            if (value.precision !== undefined)
              setLocalPrecision(value.precision);
            if (value.scale !== undefined) setLocalScale(value.scale);
            if (value.aliases) setLocalAliases(value.aliases);
            if (value.decorators) setLocalDecorators(value.decorators);
          }}
        />
      </div>

      {/* Footer — Save/Discard when dirty, error indicator */}
      <div className="border-t border-border/50 px-space-4 py-space-2">
        {saveStatus === "error" && (
          <span
            role="alert"
            className="flex items-center gap-1 text-body-small text-destructive mb-1"
          >
            <AlertCircle aria-hidden="true" className="w-3 h-3" />
            {saveError ?? "Save failed. Please try again."}
          </span>
        )}
        {saveStatus === "saving" && (
          <span
            role="status"
            className="flex items-center gap-1 text-body-small text-muted-foreground animate-pulse"
          >
            <Loader2 className="w-3 h-3 animate-spin" />
            Saving&hellip;
          </span>
        )}
        {isDirty && !justSaved && saveStatus !== "saving" && !isReadOnly && (
          <div className="flex items-center gap-2">
            <span className="text-body-small text-warning flex-1">
              Unsaved changes
            </span>
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
              Your unsaved changes to this field will be lost. The saved draft
              will remain unchanged.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              ref={discardCancelRef}
              variant="outline"
              onClick={() => setDiscardOpen(false)}
            >
              Keep editing
            </Button>
            <Button
              variant="destructive"
              disabled={saveStatus === "saving"}
              data-testid="field-confirm-discard"
              onClick={() => {
                handleDiscard();
                setDiscardOpen(false);
              }}
            >
              Discard changes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

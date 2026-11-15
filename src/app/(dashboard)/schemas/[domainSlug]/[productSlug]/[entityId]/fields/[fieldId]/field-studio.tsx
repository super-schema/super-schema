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
} from "./panels/FieldAttributeSections";
import { DescriptionEditor } from "./panels/DocumentationPanel";
import type { PolicyContext } from "./panels/GovernancePanel";

import { useState, useCallback, useEffect, useRef, useMemo } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ChevronRight,
  Loader2,
  Check,
  AlertCircle,
  CheckCircle2,
  MoreHorizontal,
  BookMarked,
} from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { TypePicker } from "@/components/custom/TypePicker";
import { ValidationIndicator } from "@/components/custom/ValidationIndicator";
import { FieldCompletenessDetails } from "@/components/custom/ValidationIndicator/FieldCompletenessDetails";
import { getFieldCompleteness } from "@/lib/validation/field-completeness";
import { readFieldCompletenessPolicy } from "@/types/schemas/field-completeness-policy";

import { getTypeInfo } from "@/lib/data-types";
import { assetHref } from "@/lib/navigation/asset-href";
import { saveFieldToDictionaryAction, updateFieldAction } from "../../actions";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  applyReferencePick,
  describeEntityRef,
  describeQualifiedName,
  holdsEntityReference,
  readFieldReference,
  withoutReferenceKeys,
  type PickableEntity,
  type ReferencePick,
} from "@/lib/references/entity-reference";
import type { TypeSpecDecorators } from "@/types/schemas/typespec-decorator.schema";
import type { MetadataAttributeDefinition } from "@/types/schemas/metadata-attribute";

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
}

interface FieldStudioProps {
  initialExpandedPanel?: number;
  isReadOnly?: boolean;
  policyContext?: PolicyContext;
  knownVersions?: string[];
  field: FieldData;
  entity: {
    id: string;
    name: string;
    slug: string;
    /** null for a tenant-level (Enterprise) entity. */
    domainSlug: string | null;
    productSlug: string | null;
  };
  domain: {
    name: string;
    policy: Record<string, unknown> | null;
  };
  /**
   * The entities of the tenant a reference can point at (with their domain and product). When given, choosing the `reference` type asks
   * for the target and the autosave writes it as a fully qualified reference. Without it `reference` is a plain type change.
   */
  referenceTargets?: PickableEntity[];
  /** The tenant's attribute dictionary for the `field` target (typed editors in the Extensions panel). */
  metadataAttributes?: MetadataAttributeDefinition[];
}

/**
 * The decorators a save writes: the field's own plus the studio's typespec, the target picked for a `reference` written qualified (and
 * the pin of a previous target dropped), and, for a field that is no longer a reference (or an array / map of them), without the
 * reference it had (the server drops it as well).
 */
function decoratorsToSave(
  stored: Record<string, unknown>,
  typespec: TypeSpecDecorators,
  type: string,
  reference: ReferencePick | null,
): Record<string, unknown> {
  let decorators: Record<string, unknown> = { ...stored, typespec };
  if (type === "reference" && reference)
    decorators = applyReferencePick(decorators, reference);
  if (!holdsEntityReference(type, decorators))
    decorators = withoutReferenceKeys(decorators);
  return decorators;
}

/**
 * The typespec with its @key mirror (`identity.key`) set from the column: `Field.isKey` is what the generator and the source sync read,
 * and the quick editor and the primary-key dialog set only the column, so the mirror can be missing or stale.
 */
function withKeyFromColumn(
  typespec: TypeSpecDecorators,
  isKey: boolean,
): TypeSpecDecorators {
  if (Boolean(typespec.identity?.key) === isKey) return typespec;
  return { ...typespec, identity: { ...typespec.identity, key: isKey } };
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

type SaveStatus = "idle" | "saving" | "saved" | "error";

const PANEL_STORAGE_KEY = (fieldId: string) => `field-studio-panels-${fieldId}`;

/** The failure shown when the server did not answer at all (a dropped connection, a deployment that replaced the action). */
const UNREACHABLE_MESSAGE =
  "Could not reach the server, so the change is not saved yet.";

export function FieldStudio({
  initialExpandedPanel,
  field,
  entity,
  domain,
  referenceTargets,
  metadataAttributes,
  isReadOnly = false,
  policyContext,
  knownVersions,
}: FieldStudioProps) {
  const router = useRouter();
  const entityHref = assetHref({
    kind: "entity",
    slug: entity.slug,
    domainSlug: entity.domainSlug,
    productSlug: entity.productSlug,
  });
  const domainHref = entity.domainSlug
    ? assetHref({ kind: "domain", domainSlug: entity.domainSlug })
    : assetHref({ kind: "enterprise" });
  const [fieldName, setFieldName] = useState(field.name);
  const [fieldType, setFieldType] = useState(field.type);
  // A key is never optional (the checkbox is disabled for one, and the save writes it required).
  const [isOptional, setIsOptional] = useState(fieldPresence(field).optional);
  const [allowNull, setAllowNull] = useState(fieldPresence(field).allowNull);
  const [description, setDescription] = useState(fieldDescription(field));
  const [extras, setExtras] = useState<FieldAttributeExtras>({
    precision: field.precision,
    scale: field.scale,
    aliases: field.aliases,
    decorators: normalizeFieldDocumentation(field).decorators,
  });
  const [fieldNumber, setFieldNumber] = useState<number | null>(
    field.fieldNumber,
  );
  const [fieldClassification, setFieldClassification] = useState<string | null>(
    field.classification,
  );

  // TypeSpec decorators state; the @key checkbox shows the column (the mirror in the decorators follows it)
  const existingTypespec =
    (normalizeFieldDocumentation(field).decorators
      .typespec as TypeSpecDecorators) ?? {};
  const [typespec, setTypespec] = useState<TypeSpecDecorators>(() =>
    withKeyFromColumn(existingTypespec, field.isKey),
  );

  // Save status
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");
  // What the server said when the save failed (a refused name, for one), shown under the header row; the status span keeps "Error saving".
  const [saveError, setSaveError] = useState<string | null>(null);
  const saveTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const idleTimerRef = useRef<NodeJS.Timeout | null>(null);
  useEffect(
    () => () => {
      if (idleTimerRef.current !== null) clearTimeout(idleTimerRef.current);
    },
    [],
  );
  // Autosave bookkeeping (see `save`): how many edits there have been, the last edit a successful save carried, and the save in flight.
  const editRevisionRef = useRef(0);
  const savedRevisionRef = useRef(0);
  const inFlightRef = useRef<Promise<string | null> | null>(null);

  // Refs to track current values for save (fixes stale closure P1 + P2)
  // The target picked for the `reference` type (written by the next save while the type is still `reference`).
  const [reference, setReference] = useState<ReferencePick | null>(null);
  const currentRef = useRef({
    fieldName,
    fieldType,
    isOptional,
    typespec,
    fieldNumber,
    fieldClassification,
    reference,
    allowNull,
    description,
    extras,
    decorators: field.decorators,
  });
  currentRef.current = {
    fieldName,
    fieldType,
    isOptional,
    typespec,
    fieldNumber,
    fieldClassification,
    reference,
    allowNull,
    description,
    extras,
    decorators: field.decorators,
  };

  // Panel state from localStorage — loaded after mount to keep SSR and hydration identical.
  const [expandedPanels, setExpandedPanels] = useState<number[]>([0]);
  const [panelsHydrated, setPanelsHydrated] = useState(false);

  useEffect(() => {
    setPanelsHydrated(false);
    try {
      const stored = localStorage.getItem(PANEL_STORAGE_KEY(field.id));
      const parsed = stored ? JSON.parse(stored) : [0];
      const panels = Array.isArray(parsed) ? parsed : [0];
      setExpandedPanels(initialExpandedPanel === undefined ? panels : [...new Set([...panels, initialExpandedPanel])]);
    } catch {
      setExpandedPanels(initialExpandedPanel === undefined ? [0] : [0, initialExpandedPanel]);
    } finally {
      setPanelsHydrated(true);
    }
  }, [field.id, initialExpandedPanel]);

  // Persist panel state after the browser has loaded the stored value.
  useEffect(() => {
    if (!panelsHydrated) return;
    try {
      localStorage.setItem(
        PANEL_STORAGE_KEY(field.id),
        JSON.stringify(expandedPanels),
      );
    } catch {
      // Ignore storage errors
    }
  }, [expandedPanels, field.id, panelsHydrated]);

  // Autosave. A save sends the whole field as it is when it goes out: the controls and the typespec from the latest render, the decorators
  // from the latest props. One send is in flight at a time. An edit made meanwhile bumps `editRevisionRef`, and the loop sends again once
  // the send settles, so "Saved" shows only when every edit so far is persisted. A refused or failed send is shown with Retry; if an edit
  // is queued behind it, that edit goes out next instead. An unsent edit waits for the next edit, Retry, Cmd+S or Done.
  const cancelScheduledSave = useCallback(() => {
    if (saveTimeoutRef.current !== null) {
      clearTimeout(saveTimeoutRef.current);
      saveTimeoutRef.current = null;
    }
  }, []);

  /** "Saved" for two seconds, then idle. The timer is cleared on unmount and by the next save: it must not fire after either. */
  const showSaved = useCallback(() => {
    setSaveStatus("saved");
    if (idleTimerRef.current !== null) clearTimeout(idleTimerRef.current);
    idleTimerRef.current = setTimeout(() => {
      idleTimerRef.current = null;
      setSaveStatus("idle");
    }, 2000);
  }, []);

  /** Sends what is unsaved. Resolves to the failure to show, or to null once every edit so far is persisted. */
  const save = useCallback((): Promise<string | null> => {
    if (inFlightRef.current) return inFlightRef.current;
    if (editRevisionRef.current === savedRevisionRef.current)
      return Promise.resolve(null);
    if (idleTimerRef.current !== null) {
      clearTimeout(idleTimerRef.current);
      idleTimerRef.current = null;
    }
    setSaveError(null);
    setSaveStatus("saving");
    // Starts on a later tick, so `inFlightRef` holds this run before the loop can clear it.
    const run = Promise.resolve().then(async (): Promise<string | null> => {
      for (;;) {
        if (editRevisionRef.current === savedRevisionRef.current) {
          inFlightRef.current = null;
          showSaved();
          return null;
        }
        const sent = editRevisionRef.current;
        const {
          fieldName: name,
          fieldType: type,
          isOptional: optional,
          typespec: ts,
          fieldNumber: fn,
          fieldClassification: cls,
          reference: picked,
          decorators: stored,
          allowNull: nullAllowed,
          description: doc,
          extras: extra,
        } = currentRef.current;
        // This send carries every edit so far, so the timer armed for one of them is done: it is cancelled as the send starts. A timer armed by
        // a later edit is not touched (it is armed after this point), so no scheduled save is dropped without being sent.
        cancelScheduledSave();
        let failure: string | null = null;
        let invalidAttributes = false;
        try {
          const presence = storeFieldPresence(
            ts.identity?.key ? false : optional,
            ts.identity?.key ? false : nullAllowed,
            decoratorsToSave(
              { ...stored, ...extra.decorators },
              ts,
              type,
              picked,
            ),
          );
          const normalized = normalizeFieldDocumentation(
            { decorators: presence.decorators },
            doc,
          );
          const errors = fieldAttributeErrors({
            type,
            ...extra,
            fieldNumber: fn,
            decorators: normalized.decorators,
          });
          if (errors.length) {
            invalidAttributes = true;
            throw new Error(errors.join(" "));
          }
          const result = await updateFieldAction(field.id, {
            name,
            type,
            description: doc,
            precision: extra.precision,
            scale: extra.scale,
            aliases: extra.aliases,
            nullable: presence.nullable,
            // The @key checkbox is Field.isKey, and the decorator mirror (identity.key) goes with it. The whole field is sent, as for every
            // control: a key set elsewhere after the studio opened is written back as the checkbox shows it.
            isKey: ts.identity?.key === true,
            fieldNumber: fn,
            classification: cls,
            decorators: normalized.decorators,
          });
          if (!result.success) failure = result.error || UNREACHABLE_MESSAGE;
        } catch (error) {
          console.error("[field-studio] save failed", error);
          failure =
            invalidAttributes && error instanceof Error
              ? error.message
              : UNREACHABLE_MESSAGE;
        }
        if (failure === null) {
          savedRevisionRef.current = sent;
        } else if (editRevisionRef.current === sent) {
          // No edit came in while this send was in flight: the refusal is the state to show, and the edit waits for Retry, Cmd+S, Done or
          // the next edit.
          inFlightRef.current = null;
          setSaveError(failure);
          setSaveStatus("error");
          return failure;
        }
        // Otherwise an edit came in meanwhile: it goes out next, and the failure is shown only if that send fails too.
      }
    });
    inFlightRef.current = run;
    return run;
  }, [field.id, showSaved, cancelScheduledSave]);

  const scheduleSave = useCallback(() => {
    if (isReadOnly) return;
    editRevisionRef.current += 1;
    cancelScheduledSave();
    saveTimeoutRef.current = setTimeout(() => {
      saveTimeoutRef.current = null;
      void save();
    }, 500);
  }, [cancelScheduledSave, save, isReadOnly]);

  // Cmd+S and Retry: sends what is unsaved now (a send in flight is joined, and it sends the newest edit once it settles). With nothing
  // unsaved there is no request, and "Saved" confirms the state the page shows.
  const saveImmediate = useCallback(() => {
    if (
      inFlightRef.current === null &&
      editRevisionRef.current === savedRevisionRef.current
    ) {
      showSaved();
      return;
    }
    void save();
  }, [save, showSaved]);

  // "Done — Back to Entity" handler: flush pending save, then navigate back. A save that is refused or fails keeps the studio open, with its message.
  const handleDone = useCallback(async () => {
    if ((await save()) === null) router.push(entityHref);
  }, [save, router, entityHref]);

  // "Save to field dictionary": flush pending edits first (the server saves the stored field), then create the entry. An existing name
  // or alias asks for confirmation before the entry is overwritten.
  // `canOverwrite` false (no tenant.admin): the prompt says to ask a tenant admin and offers no overwrite (R11).
  const [dictionaryPrompt, setDictionaryPrompt] = useState<{ message: string; canOverwrite: boolean } | null>(null);
  const [dictionaryBusy, setDictionaryBusy] = useState(false);
  const saveToDictionary = useCallback(
    async (overwrite: boolean) => {
      setDictionaryBusy(true);
      try {
        if ((await save()) !== null) return;
        const res = await saveFieldToDictionaryAction(field.id, overwrite ? { overwrite: true } : undefined);
        if ("needsConfirmation" in res) {
          setDictionaryPrompt({ message: res.error ?? "This name already exists in the dictionary.", canOverwrite: res.canOverwrite === true });
          return;
        }
        setDictionaryPrompt(null);
        if ("success" in res) {
          toast.success(res.updated ? "Dictionary entry updated" : "Saved to field dictionary");
          router.refresh();
        } else {
          toast.error(res.error);
        }
      } finally {
        setDictionaryBusy(false);
      }
    },
    [save, field.id, router],
  );

  // Cmd+S / Ctrl+S immediate save
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        saveImmediate();
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [saveImmediate]);

  // A server refresh after a save hands the page new decorators: an edit not yet sent goes out now, through the same queue (a save in
  // flight is joined, so nothing is sent twice at once). Nothing is cancelled without being sent.
  useEffect(() => {
    if (editRevisionRef.current === savedRevisionRef.current) return;
    void save();
  }, [field.decorators, save]);

  // Leaving the page sends an edit not yet persisted at once, rather than dropping it with the timer. Nothing is shown on this page any
  // more, so a save that is refused is reported as a toast.
  useEffect(() => {
    return () => {
      const unsent = editRevisionRef.current !== savedRevisionRef.current;
      cancelScheduledSave();
      if (!unsent) return;
      void save().then((failure) => {
        if (failure !== null)
          toast.error(
            `Changes to "${currentRef.current.fieldName}" were not saved`,
            { description: failure },
          );
      });
    };
  }, [cancelScheduledSave, save]);

  // A tab closed or reloaded with an edit not yet persisted would lose it: the browser asks first.
  useEffect(() => {
    function handleBeforeUnload(e: BeforeUnloadEvent) {
      if (editRevisionRef.current !== savedRevisionRef.current)
        e.preventDefault();
    }
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, []);

  // Update a typespec panel and trigger save
  function updateTypespec(
    panel: keyof TypeSpecDecorators,
    value: TypeSpecDecorators[keyof TypeSpecDecorators],
  ) {
    setTypespec((prev) => ({ ...prev, [panel]: value }));
    scheduleSave();
  }

  function handleNameChange(newName: string) {
    setFieldName(newName);
    scheduleSave();
  }

  // P10: Warn when type switch orphans existing constraints
  function handleTypeChange(newType: string) {
    const oldCategory = getTypeInfo(fieldType)?.category;
    const newCategory = getTypeInfo(newType)?.category;

    if (oldCategory !== newCategory && typespec.validation) {
      const hasConstraints = Object.values(typespec.validation).some(
        (v) => v != null,
      );
      if (hasConstraints) {
        toast.warning("Type change may hide existing constraints", {
          description: `Switching from ${oldCategory} to ${newCategory} will hide constraints set for the previous type. They are preserved but not visible.`,
        });
      }
    }

    setFieldType(newType);
    // A target picked for an earlier `reference` is not this type's (the prompt sets it again right after, before the save fires).
    setReference(null);
    scheduleSave();
  }

  function handleOptionalChange(val: boolean) {
    setIsOptional(val);
    scheduleSave();
  }

  const completenessPolicy = useMemo(
    () => readFieldCompletenessPolicy(domain.policy?.fieldCompleteness),
    [domain.policy?.fieldCompleteness],
  );
  const completeness = getFieldCompleteness(
    {
      ...field,
      name: fieldName,
      type: fieldType,
      classification: fieldClassification,
      description,
      decorators: { ...field.decorators, typespec },
    },
    completenessPolicy,
  );

  const SaveIndicator = () => {
    switch (saveStatus) {
      case "saving":
        return (
          <span
            data-testid="field-studio-save-status"
            data-status="saving"
            className="flex items-center gap-1 text-caption text-muted-foreground"
          >
            <Loader2 className="w-3 h-3 animate-spin" /> Saving…
          </span>
        );
      case "saved":
        return (
          <span
            data-testid="field-studio-save-status"
            data-status="saved"
            className="flex items-center gap-1 text-caption text-success"
          >
            <Check className="w-3 h-3" /> Saved
          </span>
        );
      case "error":
        return (
          <span
            data-testid="field-studio-save-status"
            data-status="error"
            className="flex items-center gap-1 text-caption text-destructive"
          >
            <AlertCircle className="w-3 h-3" /> Error saving
          </span>
        );
      default:
        return null;
    }
  };

  return (
    <div className="animate-auth-fade-up">
      {/* Breadcrumb + Done button */}
      <div className="flex items-center justify-between mb-space-4">
        <nav className="flex items-center gap-space-1 text-body-small text-muted-foreground">
          <Link
            href="/schemas"
            className="hover:text-foreground transition-colors"
          >
            Domains
          </Link>
          <ChevronRight className="w-3 h-3" />
          <Link
            href={domainHref}
            className="hover:text-foreground transition-colors"
          >
            {domain.name}
          </Link>
          <ChevronRight className="w-3 h-3" />
          <Link
            href={entityHref}
            className="hover:text-foreground transition-colors"
          >
            {entity.name}
          </Link>
          <ChevronRight className="w-3 h-3" />
          <span className="text-foreground font-medium font-mono">
            {fieldName}
          </span>
        </nav>
        <Button
          onClick={handleDone}
          className="gap-1.5"
          data-testid="field-studio-done"
        >
          <CheckCircle2 className="w-4 h-4" />
          Done &mdash; Back to Entity
        </Button>
      </div>

      {/* Field header */}
      <div className="flex items-center justify-between mb-space-6">
        <div className="flex items-center gap-space-3">
          <ValidationIndicator
            status={
              completeness.status === "complete" ? "complete" : "suggestion"
            }
            tooltipContent={
              <FieldCompletenessDetails completeness={completeness} />
            }
          />
          <Input
            disabled={isReadOnly}
            aria-label="Field name"
            data-testid="field-studio-name"
            value={fieldName}
            onChange={(e) => handleNameChange(e.target.value)}
            className="h-9 w-64 font-mono text-display text-foreground bg-transparent border-transparent hover:border-border focus:border-border transition-colors"
          />
          <TypePicker
            disabled={isReadOnly}
            value={fieldType}
            onChange={handleTypeChange}
            entities={referenceTargets}
            promptTypes={["reference"]}
            onComplexTypeConfig={
              referenceTargets
                ? (_type, config) => {
                    setReference(config);
                    scheduleSave();
                  }
                : undefined
            }
          />
          {fieldType === "reference" &&
            referenceLabel(reference, field.decorators) && (
              <span
                data-testid="field-reference-target"
                className="font-mono text-body-small text-muted-foreground"
              >
                → {referenceLabel(reference, field.decorators)}
              </span>
            )}
          <Badge variant={isOptional ? "secondary" : "warning"}>
            {isOptional ? "optional" : "required"}
          </Badge>
          <SaveIndicator />
        </div>
        {!isReadOnly && (
          <DropdownMenu>
            <DropdownMenuTrigger
              type="button"
              data-testid="field-studio-actions"
              aria-label="Field actions"
              title="Field actions"
              disabled={dictionaryBusy}
              className={buttonVariants({ variant: "outline", size: "icon", className: "text-muted-foreground" })}
            >
              <MoreHorizontal aria-hidden="true" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-auto min-w-40">
              <DropdownMenuItem data-testid="field-studio-save-to-dictionary" onClick={() => { void saveToDictionary(false); }}>
                <BookMarked aria-hidden="true" /> Save to field dictionary
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
      <Dialog open={dictionaryPrompt !== null} onOpenChange={(open) => { if (!open) setDictionaryPrompt(null); }}>
        <DialogContent data-testid="field-studio-dictionary-confirm">
          <DialogHeader>
            <DialogTitle>Already in the field dictionary</DialogTitle>
            <DialogDescription>
              {dictionaryPrompt?.message}
              {dictionaryPrompt?.canOverwrite ? " Its type, description, classification and attributes are replaced with this field's; its name stays." : null}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDictionaryPrompt(null)}>{dictionaryPrompt?.canOverwrite ? "Cancel" : "Close"}</Button>
            {dictionaryPrompt?.canOverwrite ? (
              <Button disabled={dictionaryBusy} data-testid="field-studio-update-dictionary" onClick={() => { void saveToDictionary(true); }}>
                Update dictionary entry
              </Button>
            ) : null}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* What the server said when the save failed (a refused name, for one): a sentence of its own, under the header row, that wraps. */}
      {saveStatus === "error" && saveError && (
        <p
          role="alert"
          className="mb-space-6 max-w-prose whitespace-normal break-words text-body-small text-destructive"
        >
          {saveError}{" "}
          <button
            type="button"
            onClick={saveImmediate}
            className="underline underline-offset-2"
          >
            Retry
          </button>
        </p>
      )}

      <fieldset disabled={isReadOnly} className="mb-6 min-w-0">
        <legend className="sr-only">Field documentation</legend>
        <DescriptionEditor
          value={description}
          onChange={(value) => {
            setDescription(value);
            scheduleSave();
          }}
        />
      </fieldset>
      <FieldAttributeSections
        referenceTargets={referenceTargets}
        metadataAttributes={metadataAttributes}
        fieldType={fieldType}
        typespec={typespec}
        identity={typespec.identity ?? {}}
        optional={isOptional}
        allowNull={allowNull}
        classification={fieldClassification}
        fieldNumber={fieldNumber}
        extras={extras}
        expanded={expandedPanels}
        onExpandedChange={setExpandedPanels}
        readOnly={isReadOnly}
        policyContext={policyContext}
        knownVersions={knownVersions}
        onTypespecChange={updateTypespec}
        onIdentityChange={(value) => updateTypespec("identity", value)}
        onOptionalChange={handleOptionalChange}
        onAllowNullChange={(value) => {
          setAllowNull(value);
          scheduleSave();
        }}
        onClassificationChange={(value) => {
          setFieldClassification(value);
          scheduleSave();
        }}
        onFieldNumberChange={(value) => {
          setFieldNumber(value);
          scheduleSave();
        }}
        onExtrasChange={(value) => {
          setExtras((previous) => ({ ...previous, ...value }));
          scheduleSave();
        }}
      />
    </div>
  );
}

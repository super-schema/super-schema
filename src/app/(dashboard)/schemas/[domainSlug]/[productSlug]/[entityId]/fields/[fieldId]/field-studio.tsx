"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronRight, Loader2, Check, AlertCircle, CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { TypePicker } from "@/components/custom/TypePicker";
import { ValidationIndicator } from "@/components/custom/ValidationIndicator";
import {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionContent,
} from "@/components/ui/accordion";
import { getTypeInfo } from "@/lib/data-types";
import { assetHref } from "@/lib/navigation/asset-href";
import { updateFieldAction } from "../../actions";
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
import { IdentityPanel } from "./panels/IdentityPanel";
import { ValidationPanel } from "./panels/ValidationPanel";
import { WireFormatPanel } from "./panels/WireFormatPanel";
import { VisibilityPanel } from "./panels/VisibilityPanel";
import { DocumentationPanel } from "./panels/DocumentationPanel";
import { VersioningPanel } from "./panels/VersioningPanel";
import { ExtensionsPanel } from "./panels/ExtensionsPanel";
import { GovernancePanel } from "./panels/GovernancePanel";

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
  if (type === "reference" && reference) decorators = applyReferencePick(decorators, reference);
  if (!holdsEntityReference(type, decorators)) decorators = withoutReferenceKeys(decorators);
  return decorators;
}

/**
 * The typespec with its @key mirror (`identity.key`) set from the column: `Field.isKey` is what the generator and the source sync read,
 * and the quick editor and the primary-key dialog set only the column, so the mirror can be missing or stale.
 */
function withKeyFromColumn(typespec: TypeSpecDecorators, isKey: boolean): TypeSpecDecorators {
  if (Boolean(typespec.identity?.key) === isKey) return typespec;
  return { ...typespec, identity: { ...typespec.identity, key: isKey } };
}

/** How a person reads what a reference field points at: `domain / product / entity`, or the name of a name-only reference. */
function referenceLabel(pick: ReferencePick | null, decorators: Record<string, unknown>): string | undefined {
  if (pick) return pick.referencedQualifiedName ? describeQualifiedName(pick.referencedQualifiedName) : pick.referencedEntityName;
  const stored = readFieldReference(decorators);
  if (!stored) return undefined;
  return "legacyName" in stored ? stored.legacyName : describeEntityRef(stored);
}

type SaveStatus = "idle" | "saving" | "saved" | "error";

const PANEL_STORAGE_KEY = (fieldId: string) =>
  `field-studio-panels-${fieldId}`;

/** The failure shown when the server did not answer at all (a dropped connection, a deployment that replaced the action). */
const UNREACHABLE_MESSAGE = "Could not reach the server, so the change is not saved yet.";

export function FieldStudio({ field, entity, domain, referenceTargets }: FieldStudioProps) {
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
  const [isOptional, setIsOptional] = useState(field.nullable && !field.isKey);
  const [fieldNumber, setFieldNumber] = useState<number | null>(field.fieldNumber);
  const [fieldClassification, setFieldClassification] = useState<string | null>(field.classification);

  // TypeSpec decorators state; the @key checkbox shows the column (the mirror in the decorators follows it)
  const existingTypespec = (field.decorators?.typespec as TypeSpecDecorators) ?? {};
  const [typespec, setTypespec] = useState<TypeSpecDecorators>(() => withKeyFromColumn(existingTypespec, field.isKey));

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
    []
  );
  // Autosave bookkeeping (see `save`): how many edits there have been, the last edit a successful save carried, and the save in flight.
  const editRevisionRef = useRef(0);
  const savedRevisionRef = useRef(0);
  const inFlightRef = useRef<Promise<string | null> | null>(null);

  // Refs to track current values for save (fixes stale closure P1 + P2)
  // The target picked for the `reference` type (written by the next save while the type is still `reference`).
  const [reference, setReference] = useState<ReferencePick | null>(null);
  const currentRef = useRef({ fieldName, fieldType, isOptional, typespec, fieldNumber, fieldClassification, reference, decorators: field.decorators });
  currentRef.current = { fieldName, fieldType, isOptional, typespec, fieldNumber, fieldClassification, reference, decorators: field.decorators };

  // Panel state from localStorage — loaded after mount to keep SSR and hydration identical.
  const [expandedPanels, setExpandedPanels] = useState<number[]>([0]);
  const [panelsHydrated, setPanelsHydrated] = useState(false);

  useEffect(() => {
    setPanelsHydrated(false);
    try {
      const stored = localStorage.getItem(PANEL_STORAGE_KEY(field.id));
      const parsed = stored ? JSON.parse(stored) : [0];
      setExpandedPanels(Array.isArray(parsed) ? parsed : [0]);
    } catch {
      setExpandedPanels([0]);
    } finally {
      setPanelsHydrated(true);
    }
  }, [field.id]);

  // Persist panel state after the browser has loaded the stored value.
  useEffect(() => {
    if (!panelsHydrated) return;
    try {
      localStorage.setItem(
        PANEL_STORAGE_KEY(field.id),
        JSON.stringify(expandedPanels)
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
    if (editRevisionRef.current === savedRevisionRef.current) return Promise.resolve(null);
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
        const { fieldName: name, fieldType: type, isOptional: nullable, typespec: ts, fieldNumber: fn, fieldClassification: cls, reference: picked, decorators: stored } = currentRef.current;
        // This send carries every edit so far, so the timer armed for one of them is done: it is cancelled as the send starts. A timer armed by
        // a later edit is not touched (it is armed after this point), so no scheduled save is dropped without being sent.
        cancelScheduledSave();
        let failure: string | null = null;
        try {
          const result = await updateFieldAction(field.id, {
            name,
            type,
            nullable,
            // The @key checkbox is Field.isKey, and the decorator mirror (identity.key) goes with it. The whole field is sent, as for every
            // control: a key set elsewhere after the studio opened is written back as the checkbox shows it.
            isKey: ts.identity?.key === true,
            fieldNumber: fn,
            classification: cls,
            decorators: decoratorsToSave(stored, ts, type, picked),
          });
          if (!result.success) failure = result.error || UNREACHABLE_MESSAGE;
        } catch (error) {
          console.error("[field-studio] save failed", error);
          failure = UNREACHABLE_MESSAGE;
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
    editRevisionRef.current += 1;
    cancelScheduledSave();
    saveTimeoutRef.current = setTimeout(() => {
      saveTimeoutRef.current = null;
      void save();
    }, 500);
  }, [cancelScheduledSave, save]);

  // Cmd+S and Retry: sends what is unsaved now (a send in flight is joined, and it sends the newest edit once it settles). With nothing
  // unsaved there is no request, and "Saved" confirms the state the page shows.
  const saveImmediate = useCallback(() => {
    if (inFlightRef.current === null && editRevisionRef.current === savedRevisionRef.current) {
      showSaved();
      return;
    }
    void save();
  }, [save, showSaved]);

  // "Done — Back to Entity" handler: flush pending save, then navigate back. A save that is refused or fails keeps the studio open, with its message.
  const handleDone = useCallback(async () => {
    if ((await save()) === null) router.push(entityHref);
  }, [save, router, entityHref]);

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
        if (failure !== null) toast.error(`Changes to "${currentRef.current.fieldName}" were not saved`, { description: failure });
      });
    };
  }, [cancelScheduledSave, save]);

  // A tab closed or reloaded with an edit not yet persisted would lose it: the browser asks first.
  useEffect(() => {
    function handleBeforeUnload(e: BeforeUnloadEvent) {
      if (editRevisionRef.current !== savedRevisionRef.current) e.preventDefault();
    }
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, []);

  // Update a typespec panel and trigger save
  function updateTypespec(
    panel: keyof TypeSpecDecorators,
    value: TypeSpecDecorators[keyof TypeSpecDecorators]
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
      const hasConstraints = Object.values(typespec.validation).some((v) => v != null);
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

  const typeInfo = getTypeInfo(fieldType);
  const typeCategory = typeInfo?.category ?? "String";

  // Determine validation status
  const validationStatus = fieldName.trim()
    ? ("complete" as const)
    : ("error" as const);
  const validationTooltip = fieldName.trim()
    ? "Field configured"
    : "Field name is required";

  const SaveIndicator = () => {
    switch (saveStatus) {
      case "saving":
        return (
          <span data-testid="field-studio-save-status" data-status="saving" className="flex items-center gap-1 text-caption text-muted-foreground">
            <Loader2 className="w-3 h-3 animate-spin" /> Saving…
          </span>
        );
      case "saved":
        return (
          <span data-testid="field-studio-save-status" data-status="saved" className="flex items-center gap-1 text-caption text-success">
            <Check className="w-3 h-3" /> Saved
          </span>
        );
      case "error":
        return (
          <span data-testid="field-studio-save-status" data-status="error" className="flex items-center gap-1 text-caption text-destructive">
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
          <Link href="/schemas" className="hover:text-foreground transition-colors">
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
        <Button onClick={handleDone} className="gap-1.5" data-testid="field-studio-done">
          <CheckCircle2 className="w-4 h-4" />
          Done &mdash; Back to Entity
        </Button>
      </div>

      {/* Field header */}
      <div className="flex items-center justify-between mb-space-6">
        <div className="flex items-center gap-space-3">
          <ValidationIndicator
            status={validationStatus}
            tooltipContent={validationTooltip}
          />
          <Input
            data-testid="field-studio-name"
            value={fieldName}
            onChange={(e) => handleNameChange(e.target.value)}
            className="h-9 w-64 font-mono text-display text-foreground bg-transparent border-transparent hover:border-border focus:border-border transition-colors"
          />
          <TypePicker
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
          {fieldType === "reference" && referenceLabel(reference, field.decorators) && (
            <span data-testid="field-reference-target" className="font-mono text-body-small text-muted-foreground">
              → {referenceLabel(reference, field.decorators)}
            </span>
          )}
          <Badge variant={isOptional ? "secondary" : "warning"}>
            {isOptional ? "optional" : "required"}
          </Badge>
          <SaveIndicator />
        </div>
      </div>

      {/* What the server said when the save failed (a refused name, for one): a sentence of its own, under the header row, that wraps. */}
      {saveStatus === "error" && saveError && (
        <p role="alert" className="mb-space-6 max-w-prose whitespace-normal break-words text-body-small text-destructive">
          {saveError}{" "}
          <button type="button" onClick={saveImmediate} className="underline underline-offset-2">
            Retry
          </button>
        </p>
      )}

      {/* 8 Collapsible Panels */}
      <Accordion
        value={expandedPanels}
        onValueChange={(val: number[]) => setExpandedPanels(val)}
      >
        {/* Panel 1: Properties */}
        <AccordionItem value={0}>
          <AccordionTrigger className="px-space-3">
            <span className="flex items-center gap-2">
              <span className="text-body font-medium">
                Properties
              </span>
              {typespec.identity?.key && (
                <Badge variant="warning" className="text-[10px] h-4 px-1">
                  @key
                </Badge>
              )}
              {typespec.identity?.secret && (
                <Badge variant="destructive" className="text-[10px] h-4 px-1">
                  @secret
                </Badge>
              )}
              {typespec.identity?.format && (
                <Badge variant="outline" className="text-[10px] h-4 px-1">
                  @format({typespec.identity.format})
                </Badge>
              )}
            </span>
          </AccordionTrigger>
          <AccordionContent className="px-space-3">
            <IdentityPanel
              identity={typespec.identity ?? {}}
              fieldType={fieldType}
              isOptional={isOptional}
              onIdentityChange={(val) => updateTypespec("identity", val)}
              onOptionalChange={handleOptionalChange}
            />
          </AccordionContent>
        </AccordionItem>

        {/* Panel 2: Constraints */}
        <AccordionItem value={1}>
          <AccordionTrigger className="px-space-3">
            <span className="text-body font-medium">
              Constraints
            </span>
          </AccordionTrigger>
          <AccordionContent className="px-space-3">
            <ValidationPanel
              validation={typespec.validation ?? {}}
              typeCategory={typeCategory}
              fieldType={fieldType}
              onChange={(val) => updateTypespec("validation", val)}
            />
          </AccordionContent>
        </AccordionItem>

        {/* Panel 3: Serialization */}
        <AccordionItem value={2}>
          <AccordionTrigger className="px-space-3">
            <span className="text-body font-medium">
              Serialization
            </span>
          </AccordionTrigger>
          <AccordionContent className="px-space-3">
            <WireFormatPanel
              wireFormat={typespec.wireFormat ?? {}}
              fieldType={fieldType}
              typeCategory={typeCategory}
              fieldNumber={fieldNumber}
              onFieldNumberChange={(val) => {
                setFieldNumber(val);
                scheduleSave();
              }}
              onChange={(val) => updateTypespec("wireFormat", val)}
            />
          </AccordionContent>
        </AccordionItem>

        {/* Panel 4: Access Control */}
        <AccordionItem value={3}>
          <AccordionTrigger className="px-space-3">
            <span className="flex items-center gap-2">
              <span className="text-body font-medium">
                Access Control
              </span>
              {typespec.visibility?.invisible && (
                <Badge variant="secondary" className="text-[10px] h-4 px-1">
                  @invisible
                </Badge>
              )}
            </span>
          </AccordionTrigger>
          <AccordionContent className="px-space-3">
            <VisibilityPanel
              visibility={typespec.visibility ?? {}}
              onChange={(val) => updateTypespec("visibility", val)}
            />
          </AccordionContent>
        </AccordionItem>

        {/* Panel 5: Documentation */}
        <AccordionItem value={4}>
          <AccordionTrigger className="px-space-3">
            <span className="flex items-center gap-2">
              <span className="text-body font-medium">Documentation</span>
              {typespec.documentation?.deprecated && (
                <Badge variant="destructive" className="text-[10px] h-4 px-1">
                  @deprecated
                </Badge>
              )}
            </span>
          </AccordionTrigger>
          <AccordionContent className="px-space-3">
            <DocumentationPanel
              documentation={typespec.documentation ?? {}}
              fieldType={fieldType}
              onChange={(val) => updateTypespec("documentation", val)}
            />
          </AccordionContent>
        </AccordionItem>

        {/* Panel 6: Version History */}
        <AccordionItem value={5}>
          <AccordionTrigger className="px-space-3">
            <span className="text-body font-medium">Version History</span>
          </AccordionTrigger>
          <AccordionContent className="px-space-3">
            <VersioningPanel
              versioning={typespec.versioning ?? {}}
              onChange={(val) => updateTypespec("versioning", val)}
            />
          </AccordionContent>
        </AccordionItem>

        {/* Panel 7: Extensions */}
        <AccordionItem value={6}>
          <AccordionTrigger className="px-space-3">
            <span className="flex items-center gap-2">
              <span className="text-body font-medium">
                Extensions
              </span>
              {(() => {
                const extCount =
                  Object.keys(typespec.extensions?.openapi ?? {}).length +
                  Object.values(typespec.extensions?.xml ?? {}).filter(Boolean)
                    .length;
                return extCount > 0 ? (
                  <Badge variant="secondary" className="text-[10px] h-4 px-1">
                    {extCount} extension{extCount !== 1 ? "s" : ""}
                  </Badge>
                ) : null;
              })()}
            </span>
          </AccordionTrigger>
          <AccordionContent className="px-space-3">
            <ExtensionsPanel
              extensions={typespec.extensions ?? {}}
              onChange={(val) => updateTypespec("extensions", val)}
            />
          </AccordionContent>
        </AccordionItem>

        {/* Panel 8: Data Governance */}
        <AccordionItem value={7}>
          <AccordionTrigger className="px-space-3">
            <span className="flex items-center gap-2">
              <span className="text-body font-medium">Data Governance</span>
              {(() => {
                const gov = typespec.governance ?? {};
                const govCount =
                  (fieldClassification ? 1 : 0) +
                  (gov.anonymization ? 1 : 0) +
                  (gov.encryption ? 1 : 0) +
                  (gov.qualityRules?.length ?? 0) +
                  Object.values(gov.operationalHints ?? {}).filter(Boolean).length +
                  Object.keys(gov.customAttributes ?? {}).length;
                return govCount > 0 ? (
                  <Badge variant="secondary" className="text-[10px] h-4 px-1">
                    {govCount} setting{govCount !== 1 ? "s" : ""}
                  </Badge>
                ) : null;
              })()}
            </span>
          </AccordionTrigger>
          <AccordionContent className="px-space-3">
            <GovernancePanel
              governance={typespec.governance ?? {}}
              onChange={(val) => updateTypespec("governance", val)}
              fieldClassification={fieldClassification}
              onClassificationChange={(cls) => {
                setFieldClassification(cls);
                scheduleSave();
              }}
            />
          </AccordionContent>
        </AccordionItem>
      </Accordion>
    </div>
  );
}

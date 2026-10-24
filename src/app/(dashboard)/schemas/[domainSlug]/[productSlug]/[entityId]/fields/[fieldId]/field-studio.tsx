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

/** How a person reads what a reference field points at: `domain / product / entity`, or the name of a name-only reference. */
function referenceLabel(pick: ReferencePick | null, decorators: Record<string, unknown>): string | undefined {
  if (pick) return pick.referencedQualifiedName?.split("/").join(" / ") ?? pick.referencedEntityName;
  const stored = readFieldReference(decorators);
  if (!stored) return undefined;
  return "legacyName" in stored ? stored.legacyName : `${stored.domain} / ${stored.product} / ${stored.entity}`;
}

type SaveStatus = "idle" | "saving" | "saved" | "error";

const PANEL_STORAGE_KEY = (fieldId: string) =>
  `field-studio-panels-${fieldId}`;

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
  const [isOptional, setIsOptional] = useState(field.nullable);
  const [fieldNumber, setFieldNumber] = useState<number | null>(field.fieldNumber);
  const [fieldClassification, setFieldClassification] = useState<string | null>(field.classification);

  // TypeSpec decorators state
  const existingTypespec = (field.decorators?.typespec as TypeSpecDecorators) ?? {};
  const [typespec, setTypespec] = useState<TypeSpecDecorators>(existingTypespec);

  // Save status
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");
  // What the server said when the save failed (a refused name, for one), shown under the header row; the status span keeps "Error saving".
  const [saveError, setSaveError] = useState<string | null>(null);
  const saveTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const pendingRef = useRef(false);
  const savingRef = useRef(false);

  // Refs to track current values for save (fixes stale closure P1 + P2)
  // The target picked for the `reference` type (written by the next save while the type is still `reference`).
  const [reference, setReference] = useState<ReferencePick | null>(null);
  const currentRef = useRef({ fieldName, fieldType, isOptional, typespec, fieldNumber, fieldClassification, reference });
  currentRef.current = { fieldName, fieldType, isOptional, typespec, fieldNumber, fieldClassification, reference };

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

  // Save function — reads from refs to avoid stale closures
  const doSave = useCallback(async () => {
    if (savingRef.current) return; // Prevent concurrent saves
    savingRef.current = true;
    setSaveStatus("saving");
    pendingRef.current = false;

    const { fieldName: name, fieldType: type, isOptional: nullable, typespec: ts, fieldNumber: fn, fieldClassification: cls, reference: picked } = currentRef.current;
    const decorators = decoratorsToSave(field.decorators, ts, type, picked);

    const result = await updateFieldAction(field.id, {
      name,
      type,
      nullable,
      fieldNumber: fn,
      classification: cls,
      decorators,
    });

    savingRef.current = false;

    if (result.error) {
      setSaveError(result.error);
      setSaveStatus("error");
    } else {
      setSaveError(null);
      setSaveStatus("saved");
      setTimeout(() => setSaveStatus("idle"), 2000);
    }
  }, [field.id, field.decorators]);

  const scheduleSave = useCallback(() => {
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
    }
    pendingRef.current = true;
    saveTimeoutRef.current = setTimeout(doSave, 500);
  }, [doSave]);

  const saveImmediate = useCallback(() => {
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
      saveTimeoutRef.current = null;
    }
    doSave();
  }, [doSave]);

  // "Done — Back to Entity" handler: flush pending save, then navigate back
  const handleDone = useCallback(async () => {
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
      saveTimeoutRef.current = null;
    }
    if (pendingRef.current || savingRef.current) {
      await doSave();
    }
    router.push(entityHref);
  }, [doSave, router, entityHref]);

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

  // Flush on unmount / navigation — reads from ref for current values
  useEffect(() => {
    return () => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
      }
      if (pendingRef.current) {
        const { fieldName: name, fieldType: type, isOptional: nullable, typespec: ts, fieldNumber: fn, fieldClassification: cls, reference: picked } = currentRef.current;
        const decorators = decoratorsToSave(field.decorators, ts, type, picked);
        updateFieldAction(field.id, { name, type, nullable, fieldNumber: fn, classification: cls, decorators });
      }
    };
  }, [field.id, field.decorators]);

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
          <span className="flex items-center gap-1 text-caption text-muted-foreground">
            <Loader2 className="w-3 h-3 animate-spin" /> Saving…
          </span>
        );
      case "saved":
        return (
          <span className="flex items-center gap-1 text-caption text-success">
            <Check className="w-3 h-3" /> Saved
          </span>
        );
      case "error":
        return (
          <span className="flex items-center gap-1 text-caption text-destructive">
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
        <Button onClick={handleDone} className="gap-1.5">
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
          {saveError}
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

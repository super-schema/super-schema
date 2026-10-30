"use client";

import { useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { TemplateSelector, type CreationMethod } from "./TemplateSelector";
import { StandardsBrowser } from "./StandardsBrowser";
import { NaturalLanguageInput } from "./NaturalLanguageInput";
import { SchemaWorkbench } from "@/components/custom/SchemaWorkbench";
import { FieldPreview, type PreviewField } from "./FieldPreview";
import { createEntityWithFieldsAction, type CreateFieldInput } from "@/app/(dashboard)/schemas/[domainSlug]/actions";
import { createTenantEntityAction } from "@/app/(dashboard)/schemas/enterprise/actions";
import type { StandardTemplate } from "@/lib/schema-standards";
import { importTypeSpecDocumentAction } from "@/app/(dashboard)/schemas/[domainSlug]/typespec-import-actions";
import { importOpenApiDocumentAction } from "@/app/(dashboard)/schemas/[domainSlug]/openapi-import-actions";
import { buildImportAssetsPayload, decimalFacts } from "@/lib/importers/import-payload";
import { sanitizeImportedText } from "@/lib/importers/text-safety";
import { buildDecoratorsFromParsedField } from "@/lib/importers/decorator-builder";
import { IMPORTED_ENTITY_FALLBACK_NAME } from "@/lib/importers/types";
import { NEEDS_DOMAIN_MESSAGE, multiAssetNeedsProductMessage } from "@/lib/schema-workbench/check-schema-text";
import type { ImportFormat, ParsedEntity } from "@/lib/importers/types";
import type { TypeSpecImportResult } from "@/lib/importers/typespec.importer";
import {
  TypeSpecImportReviewScreen,
  type TypeSpecImportSelection,
} from "@/components/custom/ImportDialog/TypeSpecImportReviewScreen";
import { toast } from "sonner";
import { useInvalidateDomainsTree } from "@/hooks/useDomainsTree";
import { isReservedRenameNote } from "@/lib/reserved-field-names";
import { assetHref } from "@/lib/navigation/asset-href";
import { levelLabel } from "@/lib/levels";

// ── State Machine ────────────────────────────────────────────────────

type WizardStep = "select-method" | "configure" | "preview-fields" | "typespec-review";

interface WizardState {
  step: WizardStep;
  method: CreationMethod | null;
  entityName: string;
  entityDescription: string;
  fields: PreviewField[];
  /** Warnings of the schema import that produced the preview (none for other creation methods). */
  importWarnings?: string[];
  /** Entity-level import facts shown next to the preview. */
  importedEntity?: ParsedEntity;
}

const INITIAL_STATE: WizardState = {
  step: "select-method",
  method: null,
  entityName: "",
  entityDescription: "",
  fields: [],
};

// ── Props ────────────────────────────────────────────────────────────

/**
 * Where the wizard creates the entity. A PRODUCT target is a superset of the
 * `ScopeTarget` shape (it also carries the domain/product names and slugs the
 * wizard shows and links to); a TENANT target creates an Enterprise entity.
 */
export type EntityWizardTarget =
  | { level: "TENANT"; tenantId: string }
  | {
      level: "PRODUCT";
      productId: string;
      domainId: string;
      domainName: string;
      domainSlug: string;
      productSlug: string;
    };

/** Methods that need a domain: AI generation reads the domain's entities for context. */
const TENANT_HIDDEN_METHODS: readonly CreationMethod[] = ["natural-language"];

interface EntityCreationWizardProps {
  target: EntityWizardTarget;
  isAiConfigured?: boolean;
  /** The person may set the AI provider (Admin > AI): the "AI not configured" notice then says where. */
  canManageAi?: boolean;
  /** Existing entities in the domain, offered as $ref targets in the visual builder. */
  referenceTargets?: { id?: string; name: string }[];
}

let tempIdCounter = 0;
function makeTempId() {
  return `wiz-${++tempIdCounter}`;
}

export function EntityCreationWizard({
  target,
  isAiConfigured = false,
  canManageAi = false,
  referenceTargets = [],
}: EntityCreationWizardProps) {
  const router = useRouter();
  const product = target.level === "PRODUCT" ? target : null;
  const scopeName = product ? product.domainName : levelLabel("TENANT");
  // What an import is for, so the server judges it there (`import.run`): the domain of the product, or the tenant itself (null).
  const importDomainId = product ? product.domainId : null;
  const invalidateDomainsTree = useInvalidateDomainsTree();
  const [state, setState] = useState<WizardState>(INITIAL_STATE);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detectedFormat, setDetectedFormat] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [typeSpecResult, setTypeSpecResult] = useState<TypeSpecImportResult | null>(null);

  // ── Step transitions ──────────────────────────────────────────────

  function goToSelectMethod() {
    setState(INITIAL_STATE);
    setError(null);
    setDetectedFormat(null);
  }

  function goToConfigure(method: CreationMethod) {
    if (method === "blank") {
      // Skip configure, go straight to preview
      setState({
        step: "preview-fields",
        method: "blank",
        entityName: "",
        entityDescription: "",
        fields: [],
      });
      return;
    }
    setState((s) => ({ ...s, step: "configure", method }));
    setError(null);
  }

  function goToPreview(
    entityName: string,
    description: string,
    fields: PreviewField[],
    imported?: { warnings: string[]; entity: ParsedEntity }
  ) {
    setState({
      step: "preview-fields",
      method: state.method,
      entityName,
      entityDescription: description,
      fields,
      ...(imported ? { importWarnings: imported.warnings, importedEntity: imported.entity } : {}),
    });
    setError(null);
  }

  // ── Standards handler ─────────────────────────────────────────────

  const handleStandardSelect = useCallback((template: StandardTemplate) => {
    const fields: PreviewField[] = template.fields.map((f) => ({
      tempId: makeTempId(),
      name: f.name,
      type: f.type,
      classification: f.classification ?? null,
      description: f.description ?? "",
      confidence: 0.95,
    }));

    goToPreview(template.entityName, template.description, fields);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── NL handler ────────────────────────────────────────────────────

  async function handleNaturalLanguageSubmit(description: string) {
    if (!product) return;
    setIsLoading(true);
    setError(null);

    try {
      const res = await fetch("/api/ai/generate-entity", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          description,
          domainId: product.domainId,
        }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error ?? `Request failed with status ${res.status}`);
        setIsLoading(false);
        return;
      }

      const data = await res.json();

      if (data.error) {
        setError(data.error);
        setIsLoading(false);
        return;
      }

      const suggestion = data.suggestion ?? data;
      const fields: PreviewField[] = (suggestion.fields ?? []).map(
        (f: { name: string; type: string; classification?: string; description?: string; confidence?: number }) => ({
          tempId: makeTempId(),
          name: f.name,
          type: f.type,
          classification: f.classification ?? null,
          description: f.description ?? "",
          confidence: f.confidence,
        })
      );

      goToPreview(suggestion.entityName ?? "", suggestion.description ?? description, fields);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to generate entity");
    } finally {
      setIsLoading(false);
    }
  }

  // ── Import handler ────────────────────────────────────────────────

  /** `format` is known when the content comes from the visual builder; otherwise it is detected. */
  function handleImportSubmit(content: string, filename?: string, format?: ImportFormat) {
    setIsLoading(true);
    setError(null);

    void (async () => {
      try {
        // Loaded on demand: the importers (protobufjs, yaml) stay out of the
        // wizard's initial client chunk until someone actually imports.
        const [{ detectFormatDetailed }, { importSchemaAssets }] = await Promise.all([
          import("@/lib/importers/format-detector"),
          import("@/services/import.service"),
        ]);
        const detected: { format: ImportFormat | null; reason?: string } = format ? { format } : detectFormatDetailed(content, filename);
        const resolvedFormat = detected.format;
        setDetectedFormat(resolvedFormat);

        if (!resolvedFormat) {
          // A YAML document refused for its size or its aliases is not "unrecognised": its own message says what was wrong.
          setError(detected.reason ?? "Could not detect schema format. Ensure the content matches Avro, BigQuery DDL, Protobuf, JSON Schema, or TypeSpec.");
          return;
        }

        // TypeSpec / OpenAPI: compiled with the real @typespec/compiler (server actions).
        if (resolvedFormat === "typespec" || resolvedFormat === "openapi") {
          if (!product) {
            setError(NEEDS_DOMAIN_MESSAGE);
            return;
          }
          const tsResult =
            resolvedFormat === "openapi"
              ? await importOpenApiDocumentAction(content, importDomainId)
              : await importTypeSpecDocumentAction(content, importDomainId);
          if (!tsResult.success) {
            setError(tsResult.error.message);
            return;
          }
          setTypeSpecResult(tsResult.data);
          setState((prev) => ({ ...prev, step: "typespec-review" }));
          return;
        }

        // Other formats: every asset of the document (Protobuf / Avro / JSON Schema
        // can define several); more than one goes to the multi-asset review.
        const result = importSchemaAssets(content, resolvedFormat);
        if (!result.success) {
          setError(result.error.message);
          return;
        }

        if (result.data.kind === "multi") {
          const assets = result.data.result;
          if (!product) {
            setError(multiAssetNeedsProductMessage(assets));
            return;
          }
          setTypeSpecResult(assets);
          setState((prev) => ({ ...prev, step: "typespec-review" }));
          return;
        }

        const { parsedEntity, warnings } = result.data.result;
        const fields: PreviewField[] = parsedEntity.fields.map((f) => ({
          tempId: makeTempId(),
          name: f.name,
          type: f.type,
          nullable: f.nullable,
          isKey: f.isKey === true,
          classification: f.classification ?? null,
          parsed: f,
          description: f.description ?? "",
          confidence: f.confidence === "high" ? 0.95 : f.confidence === "medium" ? 0.7 : 0.4,
          referencedEntityName: f.referencedEntityName,
          arrayElementType: f.arrayElementType,
          importedDecorators: buildDecoratorsFromParsedField(f),
          fieldNumber: f.fieldNumber,
        }));

        goToPreview(parsedEntity.name, parsedEntity.description ?? "", fields, {
          warnings: warnings ?? [],
          entity: parsedEntity,
        });
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to parse schema");
      } finally {
        setIsLoading(false);
      }
    })();
  }

  /** A URL import from the workbench: always the multi-asset review (it shows warnings and dangling markers). */
  function handleUrlImportResult(result: TypeSpecImportResult) {
    if (!product) {
      setError("Importing from a URL creates assets in a product. Start from a domain or product page.");
      return;
    }
    setError(null);
    setTypeSpecResult(result);
    setState((prev) => ({ ...prev, step: "typespec-review" }));
  }

  // Multi-asset confirm handler (TypeSpec, Protobuf, Avro, JSON Schema)
  async function handleTypeSpecConfirm(selection: TypeSpecImportSelection) {
    if (!typeSpecResult || !product) return;
    setIsCreating(true);
    setError(null);

    const assets = buildImportAssetsPayload(typeSpecResult, selection);

    try {
      const { createDomainAssetsFromImportAction } = await import(
        "@/app/(dashboard)/schemas/[domainSlug]/actions"
      );

      const result = await createDomainAssetsFromImportAction({
        domainId: product.domainId,
        productId: product.productId,
        ...assets,
      });

      const parts: string[] = [];
      if (result.modelsCreated > 0) parts.push(`${result.modelsCreated} model(s)`);
      if (result.entitiesCreated > 0) parts.push(`${result.entitiesCreated} entity(ies)`);
      if (result.enumsCreated > 0) parts.push(`${result.enumsCreated} enum(s)`);
      if (result.scalarsCreated > 0) parts.push(`${result.scalarsCreated} scalar(s)`);
      if (result.unionsCreated > 0) parts.push(`${result.unionsCreated} union(s)`);

      const createdCount =
        result.modelsCreated +
        result.entitiesCreated +
        result.enumsCreated +
        result.scalarsCreated +
        result.unionsCreated +
        result.servicesCreated +
        result.decoratorsCreated;
      const blockingErrors = result.errors.filter(
        (err) => !err.includes("already exists") && !isReservedRenameNote(err)
      );

      if (createdCount === 0 && blockingErrors.length > 0) {
        toast.error(blockingErrors[0]);
        return;
      }

      if (parts.length > 0) {
        toast.success(`Created ${parts.join(", ")}`);
      }

      if (result.errors.length > 0) {
        for (const err of result.errors) {
          toast.warning(err);
        }
      }

      invalidateDomainsTree();
      router.push(
        assetHref({ kind: "product", domainSlug: product.domainSlug, productSlug: product.productSlug })
      );
      router.refresh();
    } catch {
      toast.error("Failed to import schema assets");
    } finally {
      setIsCreating(false);
    }
  }

  // ── Create entity ─────────────────────────────────────────────────

  async function handleCreateEntity() {
    if (!state.entityName.trim()) {
      setError("Entity name is required");
      return;
    }

    setIsCreating(true);
    setError(null);

    const fields: CreateFieldInput[] = state.fields.map((f) => {
      // Preserve complex-type metadata (reference target, array element type,
      // imported map/enum/governance decorators) so references/arrays resolve in
      // the IR. The description column stays the source of truth (it is editable
      // here), so imported `semantics` are not carried over.
      const decorators: Record<string, unknown> = { ...f.importedDecorators };
      delete decorators.semantics;
      if (f.referencedEntityName) decorators.referencedEntityName = f.referencedEntityName;
      if (f.arrayElementType) decorators.arrayElementType = f.arrayElementType;

      return {
        name: f.name,
        type: f.type,
        nullable: f.nullable ?? true,
        isKey: f.isKey ?? false,
        description: sanitizeImportedText(f.description),
        classification: f.classification,
        // A decimal the importer read with its precision and scale keeps them, until the reviewer changes the type of the row.
        ...decimalFacts(f.parsed, f.type),
        ...(Object.keys(decorators).length > 0 ? { decorators } : {}),
        ...(f.fieldNumber != null ? { fieldNumber: f.fieldNumber } : {}),
      };
    });

    const entityInput = {
      name: state.entityName.trim(),
      description: sanitizeImportedText(state.entityDescription),
      fields,
      // The model's own vendor keys (`x-*` of the schema root) belong to the entity, not to a field.
      ...(state.importedEntity?.extensions && Object.keys(state.importedEntity.extensions).length > 0
        ? { extensions: state.importedEntity.extensions }
        : {}),
    };

    // Enterprise entities go straight to their own page; product entities return
    // to the product they were created in.
    if (!product) {
      const result = await createTenantEntityAction(entityInput);
      setIsCreating(false);
      if ("error" in result) {
        setError(result.error);
        return;
      }
      invalidateDomainsTree();
      router.push(
        assetHref({ kind: "entity", slug: result.entity.slug, domainSlug: null, productSlug: null })
      );
      router.refresh();
      return;
    }

    const result = await createEntityWithFieldsAction(product.domainId, entityInput, product.productId);

    setIsCreating(false);

    if (result?.error) {
      setError(result.error);
    } else {
      invalidateDomainsTree();
      // An imported entity opens on its own page (the user reviews what was kept and what is pending there, and generates from
      // it); a blank or generated one returns to the product page. The entity route takes the id as well as the slug.
      router.push(
        state.importedEntity && result?.entityId
          ? assetHref({ kind: "entity", slug: result.entityId, domainSlug: product.domainSlug, productSlug: product.productSlug })
          : assetHref({ kind: "product", domainSlug: product.domainSlug, productSlug: product.productSlug })
      );
      router.refresh();
    }
  }

  // ── Render ────────────────────────────────────────────────────────

  return (
    <div className="animate-auth-fade-up">
      {/* Progress indicator */}
      <div className="flex items-center gap-space-2 mb-space-6">
        {["Choose Method", "Configure", "Review & Create"].map((label, i) => {
          const stepIndex =
            state.step === "select-method" ? 0 :
            state.step === "configure" ? 1 : 2;
          const isActive = i === stepIndex;
          const isCompleted = i < stepIndex;

          return (
            <div key={label} className="flex items-center gap-space-2">
              {i > 0 && (
                <div className={`w-8 h-px ${isCompleted ? "bg-primary" : "bg-border"}`} />
              )}
              <div className="flex items-center gap-space-2">
                <div
                  className={`w-6 h-6 rounded-full flex items-center justify-center text-caption font-medium ${
                    isActive
                      ? "bg-primary text-primary-foreground"
                      : isCompleted
                      ? "bg-primary/20 text-primary"
                      : "bg-muted text-muted-foreground"
                  }`}
                >
                  {i + 1}
                </div>
                <span
                  className={`text-body-small ${
                    isActive ? "text-foreground font-medium" : "text-muted-foreground"
                  }`}
                >
                  {label}
                </span>
              </div>
            </div>
          );
        })}
      </div>

      {/* Step content */}
      <div className="surface-glass rounded-xl border border-border/50 p-space-6">
        {state.step === "select-method" && (
          <div>
            <h2 className="text-heading-1 text-foreground mb-space-2">
              Create New Entity
            </h2>
            <p className="text-body text-muted-foreground mb-space-6">
              Choose how you want to create your entity in <strong>{scopeName}</strong>.
            </p>
            <TemplateSelector
              onSelect={goToConfigure}
              hiddenMethods={product ? [] : TENANT_HIDDEN_METHODS}
            />
          </div>
        )}

        {state.step === "configure" && state.method === "standards" && (
          <StandardsBrowser
            onSelect={handleStandardSelect}
            onBack={goToSelectMethod}
          />
        )}

        {state.step === "configure" && state.method === "natural-language" && (
          <NaturalLanguageInput
            onSubmit={handleNaturalLanguageSubmit}
            onBack={goToSelectMethod}
            isLoading={isLoading}
            isAiConfigured={isAiConfigured}
            canManageAi={canManageAi}
            error={error}
          />
        )}

        {state.step === "configure" && state.method === "schema" && (
          <SchemaWorkbench
            onCommit={(content, format, filename) => handleImportSubmit(content, filename, format)}
            onBack={goToSelectMethod}
            onImportResult={handleUrlImportResult}
            importDomainId={importDomainId}
            allowMultiAsset={!!product}
            referenceTargets={referenceTargets}
            error={error}
            isLoading={isLoading}
            detectedFormat={detectedFormat}
          />
        )}

        {state.step === "preview-fields" && (
          <FieldPreview
            entityName={state.entityName}
            entityDescription={state.entityDescription}
            fields={state.fields}
            onFieldsChange={(fields) => setState((s) => ({ ...s, fields }))}
            onEntityNameChange={(entityName) => setState((s) => ({ ...s, entityName }))}
            onEntityDescriptionChange={(entityDescription) => setState((s) => ({ ...s, entityDescription }))}
            onBack={() => {
              if (state.method === "blank") {
                goToSelectMethod();
              } else {
                setState((s) => ({ ...s, step: "configure" }));
              }
            }}
            onConfirm={handleCreateEntity}
            isCreating={isCreating}
            error={error}
            warnings={state.importWarnings}
            importedEntity={state.importedEntity}
            fallbackName={state.importedEntity ? IMPORTED_ENTITY_FALLBACK_NAME : undefined}
          />
        )}

        {state.step === "typespec-review" && typeSpecResult && product && (
          <TypeSpecImportReviewScreen
            importResult={typeSpecResult}
            domains={[{ id: product.domainId, name: product.domainName }]}
            suggestedDomainName={typeSpecResult.namespace}
            onConfirm={handleTypeSpecConfirm}
            onCancel={goToSelectMethod}
          />
        )}
      </div>
    </div>
  );
}

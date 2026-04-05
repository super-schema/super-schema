"use client";

import { useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { TemplateSelector, type CreationMethod } from "./TemplateSelector";
import { StandardsBrowser } from "./StandardsBrowser";
import { NaturalLanguageInput } from "./NaturalLanguageInput";
import { ImportUploader } from "./ImportUploader";
import { FieldPreview, type PreviewField } from "./FieldPreview";
import { createEntityWithFieldsAction, type CreateFieldInput } from "@/app/(dashboard)/schemas/[domainSlug]/actions";
import type { StandardTemplate } from "@/lib/schema-standards";
import { importSchema } from "@/services/import.service";
import { detectFormat } from "@/lib/importers/format-detector";

// ── State Machine ────────────────────────────────────────────────────

type WizardStep = "select-method" | "configure" | "preview-fields";

interface WizardState {
  step: WizardStep;
  method: CreationMethod | null;
  entityName: string;
  entityDescription: string;
  fields: PreviewField[];
}

const INITIAL_STATE: WizardState = {
  step: "select-method",
  method: null,
  entityName: "",
  entityDescription: "",
  fields: [],
};

// ── Props ────────────────────────────────────────────────────────────

interface EntityCreationWizardProps {
  domainId: string;
  domainName: string;
  domainSlug: string;
  isAiConfigured?: boolean;
}

let tempIdCounter = 0;
function makeTempId() {
  return `wiz-${++tempIdCounter}`;
}

export function EntityCreationWizard({
  domainId,
  domainName,
  domainSlug,
  isAiConfigured = false,
}: EntityCreationWizardProps) {
  const router = useRouter();
  const [state, setState] = useState<WizardState>(INITIAL_STATE);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detectedFormat, setDetectedFormat] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);

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

  function goToPreview(entityName: string, description: string, fields: PreviewField[]) {
    setState({
      step: "preview-fields",
      method: state.method,
      entityName,
      entityDescription: description,
      fields,
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
    setIsLoading(true);
    setError(null);

    try {
      const res = await fetch("/api/ai/generate-entity", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          description,
          domainId,
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

  function handleImportSubmit(content: string, filename?: string) {
    setIsLoading(true);
    setError(null);

    try {
      const format = detectFormat(content, filename);
      setDetectedFormat(format);

      if (!format) {
        setError("Could not detect schema format. Ensure the content matches Avro, BigQuery DDL, or Protobuf.");
        setIsLoading(false);
        return;
      }

      const result = importSchema(content, format);

      if (!result.success) {
        setError(result.error.message);
        setIsLoading(false);
        return;
      }

      const { parsedEntity } = result.data;
      const fields: PreviewField[] = parsedEntity.fields.map((f) => ({
        tempId: makeTempId(),
        name: f.name,
        type: f.type,
        classification: null,
        description: f.description ?? "",
        confidence: f.confidence === "high" ? 0.95 : f.confidence === "medium" ? 0.7 : 0.4,
      }));

      goToPreview(parsedEntity.name, "", fields);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to parse schema");
    } finally {
      setIsLoading(false);
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

    const fields: CreateFieldInput[] = state.fields.map((f, i) => ({
      name: f.name,
      type: f.type,
      nullable: true,
      isKey: false,
      description: f.description,
      classification: f.classification,
      precision: null,
      scale: null,
    }));

    const result = await createEntityWithFieldsAction(domainId, {
      name: state.entityName.trim(),
      description: state.entityDescription,
      fields,
    });

    setIsCreating(false);

    if (result?.error) {
      setError(result.error);
    } else {
      // Navigate back to domain page
      router.push(`/schemas/${domainSlug}`);
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
              Choose how you want to create your entity in <strong>{domainName}</strong>.
            </p>
            <TemplateSelector onSelect={goToConfigure} />
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
            error={error}
          />
        )}

        {state.step === "configure" && state.method === "import" && (
          <ImportUploader
            onSubmit={handleImportSubmit}
            onBack={goToSelectMethod}
            isLoading={isLoading}
            error={error}
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
          />
        )}
      </div>
    </div>
  );
}

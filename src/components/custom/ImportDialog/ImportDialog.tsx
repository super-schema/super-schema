"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import {
  Upload,
  FileText,
  ClipboardPaste,
  X,
  AlertTriangle,
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Lightbulb,
  Maximize2,
  Minimize2,
  Sparkles,
} from "lucide-react";
import {
  importSchema,
  importSchemaAssets,
  bulkImport,
  type SchemaImportRoute,
} from "@/services/import.service";
import type { ParsedEntity, ImportFormat } from "@/lib/importers/types";
import type { TypeSpecImportResult } from "@/lib/importers/typespec.importer";
import { parseTypeSpecDocument } from "@/lib/compiler/typespec-parser";
import { importTypeSpecDocumentAction } from "@/app/(dashboard)/schemas/[domainSlug]/typespec-import-actions";
import { importOpenApiDocumentAction } from "@/app/(dashboard)/schemas/[domainSlug]/openapi-import-actions";
import { detectFormat } from "@/lib/importers/format-detector";
import { inferJsonSchema } from "@/lib/importers/jsonschema-infer";
import {
  buildImportAssetsPayload,
  parsedFieldToCreateFieldInput,
} from "@/lib/importers/import-payload";
import { ImportReviewScreen } from "./ImportReviewScreen";
import { BulkImportReviewScreen } from "./BulkImportReviewScreen";
import { VisualSchemaBuilder } from "@/components/custom/VisualSchemaBuilder/VisualSchemaBuilder";
import {
  TypeSpecImportReviewScreen,
  type TypeSpecImportSelection,
} from "./TypeSpecImportReviewScreen";
import { toast } from "sonner";
import { useInvalidateDomainsTree } from "@/hooks/useDomainsTree";

type ImportTab = "single" | "bulk" | "paste" | "build";
type ImportPhase = "input" | "review" | "bulk-review" | "typespec-review";

interface DiagnosticItem {
  type: "error" | "warning" | "info";
  message: string;
  line?: number;
}

/**
 * Attempt to treat raw content as a sample JSON document (an event payload,
 * not a schema) and infer a JSON Schema from it. Returns a JSON Schema string,
 * or null when the content isn't plain JSON data or already looks like a schema.
 */
function tryInferSampleToJsonSchema(content: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;

  // Already schema-shaped — let the normal JSON Schema path handle it.
  const obj = parsed as Record<string, unknown>;
  if (obj.$schema || obj.properties || obj.$defs || obj.type === "record") {
    return null;
  }

  return JSON.stringify(inferJsonSchema(parsed));
}

interface ImportDialogProps {
  isOpen: boolean;
  onClose: () => void;
  domains: { id: string; name: string }[];
  onImported?: (entityName: string) => void;
}

export function ImportDialog({
  isOpen,
  onClose,
  domains,
  onImported,
}: ImportDialogProps) {
  const invalidateDomainsTree = useInvalidateDomainsTree();
  const [activeTab, setActiveTab] = useState<ImportTab>("paste");
  const [phase, setPhase] = useState<ImportPhase>("input");
  const [pasteContent, setPasteContent] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [isDropZoneCollapsed, setIsDropZoneCollapsed] = useState(false);
  const [isTextareaExpanded, setIsTextareaExpanded] = useState(false);
  const [diagnostics, setDiagnostics] = useState<DiagnosticItem[]>([]);
  const [parseSummary, setParseSummary] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Review state
  const [parsedEntity, setParsedEntity] = useState<ParsedEntity | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [typeSpecResult, setTypeSpecResult] = useState<TypeSpecImportResult | null>(null);
  const [bulkParsed, setBulkParsed] = useState<ParsedEntity[]>([]);
  const [bulkErrors, setBulkErrors] = useState<
    { filename: string; error: string }[]
  >([]);
  const [bulkWarnings, setBulkWarnings] = useState<string[]>([]);

  const reset = useCallback(() => {
    setPhase("input");
    setPasteContent("");
    setError(null);
    setParsedEntity(null);
    setWarnings([]);
    setTypeSpecResult(null);
    setBulkParsed([]);
    setBulkErrors([]);
    setBulkWarnings([]);
    setIsDragging(false);
    setIsDropZoneCollapsed(false);
    setIsTextareaExpanded(false);
    setDiagnostics([]);
    setParseSummary(null);
  }, []);

  function handleClose() {
    reset();
    onClose();
  }

  // Live parse diagnostics as user types
  useEffect(() => {
    if (activeTab !== "paste" || !pasteContent.trim()) {
      setDiagnostics([]);
      setParseSummary(null);
      return;
    }

    // Debounced live parsing
    const timer = setTimeout(() => {
      runLiveParse(pasteContent.trim());
    }, 300);

    return () => clearTimeout(timer);
  }, [pasteContent, activeTab]);

  function runLiveParse(content: string) {
    const items: DiagnosticItem[] = [];

    try {
      const doc = parseTypeSpecDocument(content);

      // Check for TypeSpec-specific feedback
      if (
        doc.models.length === 0 &&
        doc.enums.length === 0 &&
        doc.scalars.length === 0 &&
        doc.interfaces.length === 0 &&
        doc.operations.length === 0 &&
        doc.decorators.length === 0 &&
        !content.includes("model ")
      ) {
        // Try other formats
        const result = importSchemaAssets(content);
        if (!result.success) {
          const inferred = tryInferSampleToJsonSchema(content);
          const inferredResult = inferred ? importSchema(inferred, "json-schema") : null;
          if (inferredResult?.success) {
            items.push({
              type: "info",
              message: `Sample JSON detected — a schema with ${inferredResult.data.parsedEntity.fields.length} field(s) will be inferred.`,
            });
          } else {
            items.push({
              type: "error",
              message: result.error.message,
            });
            if (result.error.suggestedFix) {
              items.push({
                type: "info",
                message: result.error.suggestedFix,
              });
            }
          }
        } else if (result.data.kind === "multi") {
          const assets = result.data.result;
          items.push({
            type: "info",
            message: `Detected ${assets.sourceFormat} format — ${assets.models.length} entit${assets.models.length === 1 ? "y" : "ies"}, ${assets.sharedEnums.length} enum(s), ${assets.customScalars.length} scalar(s) found.`,
          });
        } else {
          items.push({
            type: "info",
            message: `Detected ${result.data.result.parsedEntity.sourceFormat} format — ${result.data.result.parsedEntity.fields.length} fields found.`,
          });
        }
      } else {
        // TypeSpec document parsed
        const parts: string[] = [];
        if (doc.namespace) parts.push(`namespace: ${doc.namespace}`);
        if (doc.models.length > 0) parts.push(`${doc.models.length} model(s)`);
        if (doc.enums.length > 0) parts.push(`${doc.enums.length} enum(s)`);
        if (doc.scalars.length > 0) parts.push(`${doc.scalars.length} scalar(s)`);
        if (doc.unions.length > 0) parts.push(`${doc.unions.length} union(s)`);
        if (doc.aliases.length > 0) parts.push(`${doc.aliases.length} alias(es)`);
        if (doc.interfaces.length > 0) parts.push(`${doc.interfaces.length} interface(s)`);
        if (doc.operations.length > 0) parts.push(`${doc.operations.length} operation(s)`);
        if (doc.decorators.length > 0) parts.push(`${doc.decorators.length} decorator definition(s)`);

        if (parts.length > 0) {
          setParseSummary(parts.join(", "));
        }

        // Report field counts per model
        for (const model of doc.models) {
          const fieldCount = model.fields.length;
          const extras: string[] = [];
          if (model.extends) extras.push(`extends ${model.extends}`);
          if (model.spreadFrom?.length) extras.push(`spreads ${model.spreadFrom.join(", ")}`);

          items.push({
            type: "info",
            message: `Model "${model.name}": ${fieldCount} field(s)${extras.length ? ` (${extras.join(", ")})` : ""}`,
          });
        }

        // Warnings for unsupported features
        for (const imp of doc.imports) {
          items.push({
            type: "warning",
            message: `Import "${imp}" — external imports are not resolved.`,
          });
        }
        for (const using of doc.usings) {
          items.push({
            type: "warning",
            message: `Using "${using}" — library references are informational only.`,
          });
        }

        if (
          doc.models.length === 0 &&
          doc.enums.length === 0 &&
          doc.scalars.length === 0 &&
          doc.interfaces.length === 0 &&
          doc.operations.length === 0 &&
          doc.decorators.length === 0
        ) {
          items.push({
            type: "warning",
            message: "No importable TypeSpec assets found. Paste models, types, APIs, or decorator declarations to import.",
          });
        }
      }
    } catch {
      items.push({
        type: "error",
        message: "Syntax error — could not parse content.",
      });
    }

    setDiagnostics(items);
  }

  // Auto-collapse drop zone when user starts typing
  useEffect(() => {
    if (pasteContent.length > 0) {
      setIsDropZoneCollapsed(true);
    }
  }, [pasteContent]);

  // Read file content
  async function readFile(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => reject(new Error("Failed to read file"));
      reader.readAsText(file);
    });
  }

  async function reviewImportedContent(content: string, filename?: string) {
    const format = detectFormat(content, filename);

    if (format === "typespec" || format === "openapi") {
      const tsResult =
        format === "openapi"
          ? await importOpenApiDocumentAction(content)
          : await importTypeSpecDocumentAction(content);
      if (!tsResult.success) {
        setError(tsResult.error.message);
        return;
      }

      setParsedEntity(null);
      setWarnings([]);
      setTypeSpecResult(tsResult.data);
      setPhase("typespec-review");
      return;
    }

    // Protobuf / Avro / JSON Schema: every asset of the document; >1 asset →
    // multi-asset review, otherwise the single-entity review.
    const result = importSchemaAssets(content, format);
    if (!result.success) {
      // Fallback: when the content isn't a recognized schema, treat it as a
      // sample JSON *event* and infer a JSON Schema from it, then re-import.
      if (!format) {
        const inferred = tryInferSampleToJsonSchema(content);
        if (inferred) {
          const inferredResult = importSchemaAssets(inferred, "json-schema");
          if (inferredResult.success) {
            showImportRoute(inferredResult.data, [
              "Schema was inferred from a sample JSON document — review types and nullability before importing.",
            ]);
            return;
          }
        }
      }
      setError(result.error.message);
      return;
    }

    showImportRoute(result.data);
  }

  function showImportRoute(route: SchemaImportRoute, extraWarnings: string[] = []) {
    if (route.kind === "multi") {
      setParsedEntity(null);
      setWarnings([]);
      setTypeSpecResult(route.result);
      setPhase("typespec-review");
      return;
    }
    setTypeSpecResult(null);
    setParsedEntity(route.result.parsedEntity);
    setWarnings([...extraWarnings, ...route.result.warnings]);
    setPhase("review");
  }

  // Handle single file
  async function handleSingleFile(file: File) {
    setError(null);
    try {
      const content = await readFile(file);
      await reviewImportedContent(content, file.name);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to read file");
    }
  }

  // Handle paste import
  function handlePasteImport() {
    if (!pasteContent.trim()) {
      setError("Please paste schema content");
      return;
    }
    setError(null);
    const content = pasteContent.trim();
    void reviewImportedContent(content);
  }

  // Handle visual builder → review
  function handleVisualImport(content: string, format: ImportFormat) {
    setError(null);
    const result = importSchemaAssets(content, format);
    if (!result.success) {
      setError(result.error.message);
      return;
    }
    showImportRoute(result.data);
  }

  // Handle paste into textarea from file drop
  function handlePasteFromFile(file: File) {
    readFile(file).then((content) => {
      setPasteContent(content);
      setActiveTab("paste");
    });
  }

  // Handle bulk files
  async function handleBulkFiles(files: FileList | File[]) {
    setError(null);
    const fileArray = Array.from(files);
    const fileContents: { content: string; filename: string }[] = [];

    for (const file of fileArray) {
      try {
        const content = await readFile(file);
        fileContents.push({ content, filename: file.name });
      } catch {
        setBulkErrors((prev) => [
          ...prev,
          { filename: file.name, error: "Failed to read file" },
        ]);
      }
    }

    const result = bulkImport(fileContents);
    if (!result.success) {
      setError(result.error.message);
      return;
    }

    setBulkParsed(result.data.parsed);
    setBulkErrors(result.data.errors);
    setBulkWarnings(result.data.warnings);
    setPhase("bulk-review");
  }

  // Drag handlers
  function handleDragOver(e: React.DragEvent) {
    e.preventDefault();
    setIsDragging(true);
  }

  function handleDragLeave() {
    setIsDragging(false);
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setIsDragging(false);
    const files = e.dataTransfer.files;
    if (files.length === 0) return;

    if (activeTab === "paste") {
      // In paste mode, load file content into textarea
      handlePasteFromFile(files[0]);
    } else if (activeTab === "single") {
      handleSingleFile(files[0]);
    } else if (activeTab === "bulk") {
      handleBulkFiles(files);
    }
  }

  // Confirm handlers
  async function handleConfirmSingle(entity: ParsedEntity, domainId: string) {
    if (!domainId) {
      toast.error("Select a domain for the imported entity");
      return;
    }

    try {
      const { createDomainAssetsFromImportAction } = await import(
        "@/app/(dashboard)/schemas/[domainSlug]/actions"
      );

      const result = await createDomainAssetsFromImportAction({
        domainId,
        models: [],
        entities: [
          {
            name: entity.name,
            description: entity.description,
            fields: entity.fields.map(parsedFieldToCreateFieldInput),
          },
        ],
        sharedEnums: [],
        customScalars: [],
        unionTypes: [],
        services: [],
        decoratorDefinitions: [],
      });

      const blockingErrors = result.errors.filter(
        (e) => !e.includes("already exists")
      );
      if (result.entitiesCreated === 0 && blockingErrors.length > 0) {
        toast.error(blockingErrors[0]);
        return;
      }

      if (result.entitiesCreated > 0) {
        toast.success(`Created ${result.entitiesCreated} entity(ies)`);
      }
      for (const e of result.errors) {
        toast.warning(e);
      }

      invalidateDomainsTree();
      onImported?.(entity.name);
      handleClose();
    } catch {
      toast.error("Failed to import schema");
      // Don't close — let user retry
    }
  }

  function handleConfirmBulk(entities: ParsedEntity[]) {
    for (const entity of entities) {
      onImported?.(entity.name);
    }
    handleClose();
  }

  async function handleConfirmTypeSpec(selection: TypeSpecImportSelection) {
    if (!typeSpecResult) return;

    const assets = buildImportAssetsPayload(typeSpecResult, selection);
    const { entities } = assets;

    try {
      const { createDomainAssetsFromImportAction } = await import(
        "@/app/(dashboard)/schemas/[domainSlug]/actions"
      );

      const result = await createDomainAssetsFromImportAction({
        domainId: selection.domainId,
        ...assets,
      });

      const parts: string[] = [];
      if (result.modelsCreated > 0) parts.push(`${result.modelsCreated} model(s)`);
      if (result.entitiesCreated > 0) parts.push(`${result.entitiesCreated} entity(ies)`);
      if (result.enumsCreated > 0) parts.push(`${result.enumsCreated} enum(s)`);
      if (result.scalarsCreated > 0) parts.push(`${result.scalarsCreated} scalar(s)`);
      if (result.unionsCreated > 0) parts.push(`${result.unionsCreated} union(s)`);
      if (result.servicesCreated > 0) parts.push(`${result.servicesCreated} API(s)`);
      if (result.decoratorsCreated > 0) parts.push(`${result.decoratorsCreated} decorator(s)`);

      const createdCount =
        result.modelsCreated +
        result.entitiesCreated +
        result.enumsCreated +
        result.scalarsCreated +
        result.unionsCreated +
        result.servicesCreated +
        result.decoratorsCreated;
      const blockingErrors = result.errors.filter(
        (err) => !err.includes("already exists")
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

      for (const entity of entities) {
        onImported?.(entity.name);
      }

      handleClose();
    } catch {
      toast.error("Failed to import schema assets");
      // Don't close — let user retry
    }
  }

  if (!isOpen) return null;

  const hasErrors = diagnostics.some((d) => d.type === "error");
  const hasWarnings = diagnostics.some((d) => d.type === "warning");
  const hasDiagnostics = diagnostics.length > 0;

  // Determine dialog width based on whether side panel is shown
  const showSidePanel = activeTab === "paste" && hasDiagnostics;
  const dialogWidth = showSidePanel ? "w-[1000px]" : "w-[700px]";

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div
        data-testid="import-dialog"
        className={`bg-background border border-border rounded-xl shadow-xl ${dialogWidth} max-h-[85vh] flex flex-col transition-all duration-200`}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-space-4 py-space-3 border-b border-border">
          <h2 className="text-heading-3 text-foreground">Import Schema</h2>
          <button
            onClick={handleClose}
            className="p-1 rounded-lg hover:bg-accent"
          >
            <X className="w-4 h-4 text-muted-foreground" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto flex">
          {/* Main content area */}
          <div className={`flex-1 p-space-4 ${showSidePanel ? "border-r border-border" : ""}`}>
            {phase === "review" && parsedEntity && (
              <ImportReviewScreen
                parsedEntity={parsedEntity}
                warnings={warnings}
                onConfirm={handleConfirmSingle}
                onCancel={reset}
                domains={domains}
              />
            )}

            {phase === "bulk-review" && (
              <BulkImportReviewScreen
                parsedEntities={bulkParsed}
                errors={bulkErrors}
                warnings={bulkWarnings}
                onConfirm={handleConfirmBulk}
                onCancel={reset}
                domains={domains}
              />
            )}

            {phase === "typespec-review" && typeSpecResult && (
              <TypeSpecImportReviewScreen
                importResult={typeSpecResult}
                domains={domains}
                suggestedDomainName={typeSpecResult.namespace}
                onConfirm={handleConfirmTypeSpec}
                onCancel={reset}
              />
            )}

            {phase === "input" && (
              <>
                {/* Tabs */}
                <div className="flex gap-1 mb-space-4 border-b border-border">
                  {([
                    { id: "paste" as const, label: "Paste Schema", icon: ClipboardPaste },
                    { id: "build" as const, label: "Build Visually", icon: Sparkles },
                    { id: "single" as const, label: "Upload File", icon: FileText },
                    { id: "bulk" as const, label: "Bulk Import", icon: Upload },
                  ]).map((tab) => (
                    <button
                      key={tab.id}
                      onClick={() => setActiveTab(tab.id)}
                      className={`flex items-center gap-space-1 px-space-3 py-2 text-body-small border-b-2 transition-colors ${
                        activeTab === tab.id
                          ? "border-primary text-foreground"
                          : "border-transparent text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      <tab.icon className="w-4 h-4" />
                      {tab.label}
                    </button>
                  ))}
                </div>

                {/* Error display */}
                {error && (
                  <div className="bg-destructive/10 border border-destructive/30 rounded-lg p-space-3 mb-space-4">
                    <p className="text-caption text-destructive">{error}</p>
                  </div>
                )}

                {/* Paste tab — featured layout */}
                {activeTab === "paste" && (
                  <div className="flex flex-col gap-space-3">
                    {/* Collapsible drag-and-drop zone */}
                    <div
                      data-testid="drop-zone-paste"
                      onDragOver={handleDragOver}
                      onDragLeave={handleDragLeave}
                      onDrop={handleDrop}
                      className={`border-2 border-dashed rounded-xl transition-all ${
                        isDragging
                          ? "border-primary bg-primary/5 p-space-4"
                          : isDropZoneCollapsed
                            ? "border-border p-space-2 cursor-pointer"
                            : "border-border hover:border-muted-foreground p-space-4"
                      }`}
                      onClick={() => {
                        if (isDropZoneCollapsed) setIsDropZoneCollapsed(false);
                      }}
                    >
                      {isDropZoneCollapsed ? (
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2 text-caption text-muted-foreground">
                            <Upload className="w-3 h-3" />
                            <span>Drop a .tsp, .avsc, .json, .yaml, .sql, .proto file here</span>
                          </div>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setIsDropZoneCollapsed(false);
                            }}
                            className="p-0.5 rounded hover:bg-accent"
                          >
                            <ChevronDown className="w-3 h-3 text-muted-foreground" />
                          </button>
                        </div>
                      ) : (
                        <div className="flex flex-col items-center justify-center gap-space-2">
                          <Upload className="w-6 h-6 text-muted-foreground" />
                          <p className="text-body-small text-muted-foreground">
                            Drag and drop a schema file, or paste content below
                          </p>
                          <p className="text-caption text-muted-foreground">
                            .tsp, .avsc, .avro, .json, .yaml, .yml, .sql, .ddl, .proto
                          </p>
                          <div className="flex items-center gap-2">
                            <label className="px-3 py-1 rounded-lg text-caption bg-muted hover:bg-accent cursor-pointer">
                              Browse
                              <input
                                type="file"
                                accept=".tsp,.avsc,.avro,.json,.yaml,.yml,.sql,.ddl,.proto"
                                className="hidden"
                                onChange={(e) => {
                                  if (e.target.files?.[0]) {
                                    handlePasteFromFile(e.target.files[0]);
                                  }
                                }}
                              />
                            </label>
                            {!isDropZoneCollapsed && pasteContent && (
                              <button
                                onClick={() => setIsDropZoneCollapsed(true)}
                                className="p-1 rounded hover:bg-accent"
                              >
                                <ChevronUp className="w-3 h-3 text-muted-foreground" />
                              </button>
                            )}
                          </div>
                        </div>
                      )}
                    </div>

                    {/* Schema textarea with expand/collapse */}
                    <div className="relative">
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-caption text-muted-foreground">
                          Schema content
                          {parseSummary && (
                            <span className="ml-2 text-primary">
                              — {parseSummary}
                            </span>
                          )}
                        </span>
                        <button
                          onClick={() => setIsTextareaExpanded(!isTextareaExpanded)}
                          className="p-1 rounded hover:bg-accent"
                          title={isTextareaExpanded ? "Collapse editor" : "Expand editor"}
                        >
                          {isTextareaExpanded ? (
                            <Minimize2 className="w-3 h-3 text-muted-foreground" />
                          ) : (
                            <Maximize2 className="w-3 h-3 text-muted-foreground" />
                          )}
                        </button>
                      </div>
                      <textarea
                        ref={textareaRef}
                        data-testid="paste-textarea"
                        value={pasteContent}
                        onChange={(e) => setPasteContent(e.target.value)}
                        placeholder={`Paste TypeSpec, JSON Schema, Avro, BigQuery DDL, Protobuf — or a sample JSON event to infer a schema...

Example JSON Schema:
{
  "title": "User",
  "type": "object",
  "required": ["id"],
  "properties": {
    "id": { "type": "string", "format": "uuid" },
    "email": { "type": "string", "format": "email" },
    "createdAt": { "type": "string", "format": "date-time" }
  }
}`}
                        className={`w-full bg-muted rounded-lg p-space-3 text-mono-small text-foreground placeholder:text-muted-foreground outline-none border border-border focus:border-primary resize-y transition-all ${
                          isTextareaExpanded ? "h-[50vh]" : "h-64"
                        } ${hasErrors ? "border-destructive/50" : ""}`}
                        spellCheck={false}
                      />
                    </div>

                    {/* Action bar */}
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        {hasErrors && (
                          <span className="flex items-center gap-1 text-caption text-destructive">
                            <AlertCircle className="w-3 h-3" />
                            {diagnostics.filter((d) => d.type === "error").length} error(s)
                          </span>
                        )}
                        {hasWarnings && (
                          <span className="flex items-center gap-1 text-caption text-yellow-600 dark:text-yellow-400">
                            <AlertTriangle className="w-3 h-3" />
                            {diagnostics.filter((d) => d.type === "warning").length} warning(s)
                          </span>
                        )}
                      </div>
                      <button
                        data-testid="paste-import-button"
                        onClick={handlePasteImport}
                        disabled={!pasteContent.trim()}
                        className="px-4 py-1.5 rounded-lg text-body-small bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        Parse & Review
                      </button>
                    </div>
                  </div>
                )}

                {/* Build visually tab */}
                {activeTab === "build" && (
                  <VisualSchemaBuilder onImport={handleVisualImport} />
                )}

                {/* Single file tab */}
                {activeTab === "single" && (
                  <div
                    data-testid="drop-zone-single"
                    onDragOver={handleDragOver}
                    onDragLeave={handleDragLeave}
                    onDrop={handleDrop}
                    className={`border-2 border-dashed rounded-xl p-space-6 flex flex-col items-center justify-center gap-space-3 transition-colors ${
                      isDragging
                        ? "border-primary bg-primary/5"
                        : "border-border hover:border-muted-foreground"
                    }`}
                  >
                    <Upload className="w-8 h-8 text-muted-foreground" />
                    <p className="text-body-small text-muted-foreground">
                      Drag and drop a schema file here
                    </p>
                    <p className="text-caption text-muted-foreground">
                      .tsp, .avsc, .avro, .json, .yaml, .yml, .sql, .ddl, .proto
                    </p>
                    <label className="px-4 py-1.5 rounded-lg text-body-small bg-muted hover:bg-accent cursor-pointer">
                      Browse Files
                      <input
                        type="file"
                        accept=".tsp,.avsc,.avro,.json,.yaml,.yml,.sql,.ddl,.proto"
                        className="hidden"
                        onChange={(e) => {
                          if (e.target.files?.[0]) {
                            handleSingleFile(e.target.files[0]);
                          }
                        }}
                      />
                    </label>
                  </div>
                )}

                {/* Bulk import tab */}
                {activeTab === "bulk" && (
                  <div
                    data-testid="drop-zone-bulk"
                    onDragOver={handleDragOver}
                    onDragLeave={handleDragLeave}
                    onDrop={handleDrop}
                    className={`border-2 border-dashed rounded-xl p-space-6 flex flex-col items-center justify-center gap-space-3 transition-colors ${
                      isDragging
                        ? "border-primary bg-primary/5"
                        : "border-border hover:border-muted-foreground"
                    }`}
                  >
                    <Upload className="w-8 h-8 text-muted-foreground" />
                    <p className="text-body-small text-muted-foreground">
                      Drag and drop multiple schema files here
                    </p>
                    <p className="text-caption text-muted-foreground">
                      Supports mixed formats (TypeSpec, Avro, BigQuery DDL, Protobuf)
                    </p>
                    <label className="px-4 py-1.5 rounded-lg text-body-small bg-muted hover:bg-accent cursor-pointer">
                      Browse Files
                      <input
                        type="file"
                        accept=".tsp,.avsc,.avro,.json,.yaml,.yml,.sql,.ddl,.proto"
                        multiple
                        className="hidden"
                        onChange={(e) => {
                          if (e.target.files && e.target.files.length > 0) {
                            handleBulkFiles(e.target.files);
                          }
                        }}
                      />
                    </label>
                  </div>
                )}
              </>
            )}
          </div>

          {/* Side panel — diagnostics & suggestions */}
          {showSidePanel && phase === "input" && (
            <div className="w-[300px] p-space-3 overflow-y-auto flex flex-col gap-space-2">
              <h3 className="text-caption font-medium text-muted-foreground uppercase tracking-wider mb-1">
                Diagnostics
              </h3>

              {diagnostics.map((item, idx) => (
                <div
                  key={idx}
                  className={`flex items-start gap-2 p-2 rounded-lg text-caption ${
                    item.type === "error"
                      ? "bg-destructive/10 text-destructive"
                      : item.type === "warning"
                        ? "bg-yellow-500/10 text-yellow-700 dark:text-yellow-400"
                        : "bg-primary/5 text-muted-foreground"
                  }`}
                >
                  {item.type === "error" && (
                    <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                  )}
                  {item.type === "warning" && (
                    <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                  )}
                  {item.type === "info" && (
                    <CheckCircle2 className="w-3.5 h-3.5 mt-0.5 shrink-0 text-green-600 dark:text-green-400" />
                  )}
                  <span className="leading-tight">{item.message}</span>
                </div>
              ))}

              {/* TypeSpec syntax help */}
              <div className="mt-3 border-t border-border pt-3">
                <h3 className="text-caption font-medium text-muted-foreground uppercase tracking-wider mb-2 flex items-center gap-1">
                  <Lightbulb className="w-3 h-3" />
                  Supported Syntax
                </h3>
                <div className="space-y-1 text-caption text-muted-foreground">
                  <p><code className="text-mono-small bg-muted px-1 rounded">model Name &#123;&#125;</code> — Entity</p>
                  <p><code className="text-mono-small bg-muted px-1 rounded">extends Parent</code> — Inheritance</p>
                  <p><code className="text-mono-small bg-muted px-1 rounded">...Model</code> — Spread fields</p>
                  <p><code className="text-mono-small bg-muted px-1 rounded">enum Name &#123;&#125;</code> — Shared enum</p>
                  <p><code className="text-mono-small bg-muted px-1 rounded">scalar Name extends T</code> — Custom type</p>
                  <p><code className="text-mono-small bg-muted px-1 rounded">union A = B | C</code> — Union type</p>
                  <p><code className="text-mono-small bg-muted px-1 rounded">alias N = Type</code> — Type alias</p>
                  <p><code className="text-mono-small bg-muted px-1 rounded">namespace N</code> — Namespace</p>
                  <p><code className="text-mono-small bg-muted px-1 rounded">interface N &#123;&#125;</code> — API operations</p>
                  <p><code className="text-mono-small bg-muted px-1 rounded">@key @doc @format</code> — Decorators</p>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

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
} from "lucide-react";
import { importSchema, bulkImport } from "@/services/import.service";
import type { ParsedEntity } from "@/lib/importers/types";
import { parseTypeSpecDocument } from "@/lib/compiler/typespec-parser";
import { ImportReviewScreen } from "./ImportReviewScreen";
import { BulkImportReviewScreen } from "./BulkImportReviewScreen";

type ImportTab = "single" | "bulk" | "paste";
type ImportPhase = "input" | "review" | "bulk-review";

interface DiagnosticItem {
  type: "error" | "warning" | "info";
  message: string;
  line?: number;
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
      if (doc.models.length === 0 && !content.includes("model ")) {
        // Try other formats
        const result = importSchema(content);
        if (!result.success) {
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
        } else {
          items.push({
            type: "info",
            message: `Detected ${result.data.parsedEntity.sourceFormat} format — ${result.data.parsedEntity.fields.length} fields found.`,
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

        if (doc.models.length === 0 && doc.enums.length === 0) {
          items.push({
            type: "warning",
            message: "No models or enums found. Paste a TypeSpec model definition to import.",
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

  // Handle single file
  async function handleSingleFile(file: File) {
    setError(null);
    try {
      const content = await readFile(file);
      const result = importSchema(content);
      if (!result.success) {
        setError(result.error.message);
        return;
      }
      setParsedEntity(result.data.parsedEntity);
      setWarnings(result.data.warnings);
      setPhase("review");
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
    const result = importSchema(pasteContent.trim());
    if (!result.success) {
      setError(result.error.message);
      return;
    }
    setParsedEntity(result.data.parsedEntity);
    setWarnings(result.data.warnings);
    setPhase("review");
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
  function handleConfirmSingle(entity: ParsedEntity, _domainId: string) {
    onImported?.(entity.name);
    handleClose();
  }

  function handleConfirmBulk(entities: ParsedEntity[], _domainId: string) {
    for (const entity of entities) {
      onImported?.(entity.name);
    }
    handleClose();
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

            {phase === "input" && (
              <>
                {/* Tabs */}
                <div className="flex gap-1 mb-space-4 border-b border-border">
                  {([
                    { id: "paste" as const, label: "Paste Schema", icon: ClipboardPaste },
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
                            <span>Drop a .tsp, .avsc, .json, .sql, .proto file here</span>
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
                            .tsp, .avsc, .avro, .json, .sql, .ddl, .proto
                          </p>
                          <div className="flex items-center gap-2">
                            <label className="px-3 py-1 rounded-lg text-caption bg-muted hover:bg-accent cursor-pointer">
                              Browse
                              <input
                                type="file"
                                accept=".tsp,.avsc,.avro,.json,.sql,.ddl,.proto"
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
                        placeholder={`Paste your TypeSpec, Avro JSON, BigQuery DDL, or Protobuf schema here...

Example TypeSpec:
model User {
  @key
  id: string;
  name: string;
  email?: string;
}

enum Status {
  Active,
  Inactive,
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
                      .tsp, .avsc, .avro, .json, .sql, .ddl, .proto
                    </p>
                    <label className="px-4 py-1.5 rounded-lg text-body-small bg-muted hover:bg-accent cursor-pointer">
                      Browse Files
                      <input
                        type="file"
                        accept=".tsp,.avsc,.avro,.json,.sql,.ddl,.proto"
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
                        accept=".tsp,.avsc,.avro,.json,.sql,.ddl,.proto"
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

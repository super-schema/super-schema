"use client";

import { useState, useCallback } from "react";
import { Upload, FileText, ClipboardPaste, X } from "lucide-react";
import { importSchema, bulkImport } from "@/services/import.service";
import type { ParsedEntity } from "@/lib/importers/types";
import { ImportReviewScreen } from "./ImportReviewScreen";
import { BulkImportReviewScreen } from "./BulkImportReviewScreen";

type ImportTab = "single" | "bulk" | "paste";
type ImportPhase = "input" | "review" | "bulk-review";

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
  const [activeTab, setActiveTab] = useState<ImportTab>("single");
  const [phase, setPhase] = useState<ImportPhase>("input");
  const [pasteContent, setPasteContent] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);

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
  }, []);

  function handleClose() {
    reset();
    onClose();
  }

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

  // Handle paste
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

    if (activeTab === "single") {
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

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div
        data-testid="import-dialog"
        className="bg-background border border-border rounded-xl shadow-xl w-[700px] max-h-[80vh] flex flex-col"
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
        <div className="flex-1 overflow-y-auto p-space-4">
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
                  { id: "single" as const, label: "Single File", icon: FileText },
                  { id: "bulk" as const, label: "Bulk Import", icon: Upload },
                  { id: "paste" as const, label: "Paste", icon: ClipboardPaste },
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
                    .avsc, .avro, .json, .sql, .ddl, .proto
                  </p>
                  <label className="px-4 py-1.5 rounded-lg text-body-small bg-muted hover:bg-accent cursor-pointer">
                    Browse Files
                    <input
                      type="file"
                      accept=".avsc,.avro,.json,.sql,.ddl,.proto"
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
                    Supports mixed formats (Avro, BigQuery DDL, Protobuf)
                  </p>
                  <label className="px-4 py-1.5 rounded-lg text-body-small bg-muted hover:bg-accent cursor-pointer">
                    Browse Files
                    <input
                      type="file"
                      accept=".avsc,.avro,.json,.sql,.ddl,.proto"
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

              {/* Paste tab */}
              {activeTab === "paste" && (
                <div className="flex flex-col gap-space-3">
                  <textarea
                    data-testid="paste-textarea"
                    value={pasteContent}
                    onChange={(e) => setPasteContent(e.target.value)}
                    placeholder="Paste your Avro JSON, BigQuery DDL, or Protobuf schema here..."
                    className="w-full h-64 bg-muted rounded-lg p-space-3 text-mono-small text-foreground placeholder:text-muted-foreground outline-none border border-border focus:border-primary resize-none"
                  />
                  <div className="flex justify-end">
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
            </>
          )}
        </div>
      </div>
    </div>
  );
}

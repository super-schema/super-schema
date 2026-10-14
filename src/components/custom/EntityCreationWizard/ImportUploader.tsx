"use client";

import { useState, useRef, useCallback } from "react";
import { ArrowLeft, Upload, FileCode, AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

interface ImportUploaderProps {
  onSubmit: (content: string, filename?: string) => void;
  onBack: () => void;
  isLoading?: boolean;
  error?: string | null;
  detectedFormat?: string | null;
}

export function ImportUploader({
  onSubmit,
  onBack,
  isLoading = false,
  error,
  detectedFormat,
}: ImportUploaderProps) {
  const [content, setContent] = useState("");
  const [filename, setFilename] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFile = useCallback((file: File) => {
    setFilename(file.name);
    const reader = new FileReader();
    reader.onload = (e) => {
      const text = e.target?.result as string;
      setContent(text);
    };
    reader.readAsText(file);
  }, []);

  function handleDragOver(e: React.DragEvent) {
    e.preventDefault();
    setIsDragging(true);
  }

  function handleDragLeave(e: React.DragEvent) {
    e.preventDefault();
    setIsDragging(false);
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) handleFile(file);
  }

  return (
    <div className="space-y-space-4">
      <button
        onClick={onBack}
        className="flex items-center gap-1 text-body-small text-muted-foreground hover:text-foreground transition-colors"
      >
        <ArrowLeft className="w-4 h-4" />
        Back
      </button>

      <div>
        <h3 className="text-heading-2 text-foreground mb-space-2">
          Import Schema
        </h3>
        <p className="text-body-small text-muted-foreground mb-space-4">
          Upload a schema file or paste schema content. Supported formats: Avro (.avsc), BigQuery DDL (.sql), Protobuf (.proto), TypeSpec (.tsp), JSON Schema and OpenAPI (.json, .yaml, .yml).
        </p>
      </div>

      {/* Drop zone */}
      <div
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        onClick={() => fileInputRef.current?.click()}
        className={`flex flex-col items-center justify-center gap-space-3 p-space-6 rounded-lg border-2 border-dashed cursor-pointer transition-all ${
          isDragging
            ? "border-primary bg-primary/5"
            : "border-border/50 hover:border-primary/40 hover:bg-accent/10"
        }`}
      >
        <Upload className={`w-8 h-8 ${isDragging ? "text-primary" : "text-muted-foreground"}`} />
        <div className="text-center">
          <p className="text-body-small text-foreground">
            {isDragging ? "Drop file here" : "Click to browse or drag a file"}
          </p>
          <p className="text-caption text-muted-foreground mt-1">
            .avsc, .sql, .ddl, .proto, .tsp, .json, .yaml, .yml
          </p>
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept=".avsc,.avro,.sql,.ddl,.proto,.tsp,.json,.yaml,.yml"
          onChange={handleFileChange}
          className="hidden"
        />
      </div>

      {/* Or paste */}
      <div className="flex items-center gap-space-3">
        <div className="flex-1 border-t border-border" />
        <span className="text-caption text-muted-foreground">or paste schema</span>
        <div className="flex-1 border-t border-border" />
      </div>

      <textarea
        value={content}
        onChange={(e) => {
          setContent(e.target.value);
          setFilename(null);
        }}
        placeholder={`Paste your schema content here...

Example (Avro):
{
  "type": "record",
  "name": "Customer",
  "fields": [
    {"name": "id", "type": "long"},
    {"name": "name", "type": "string"}
  ]
}`}
        className="w-full h-40 bg-muted rounded-lg p-space-4 text-body-small text-foreground font-mono placeholder:text-muted-foreground/50 outline-none resize-none border border-border/50 focus:border-primary/40 transition-colors"
        disabled={isLoading}
      />

      {/* Status badges */}
      <div className="flex items-center gap-space-2">
        {filename && (
          <Badge variant="secondary" className="gap-1">
            <FileCode className="w-3 h-3" />
            {filename}
          </Badge>
        )}
        {detectedFormat && (
          <Badge variant="outline" className="text-[11px]">
            Format: {detectedFormat}
          </Badge>
        )}
      </div>

      {error && (
        <div className="flex items-start gap-space-2 p-space-3 rounded-lg border border-destructive/30 bg-destructive/5">
          <AlertCircle className="w-4 h-4 text-destructive shrink-0 mt-0.5" />
          <p className="text-body-small text-destructive">{error}</p>
        </div>
      )}

      <Button
        onClick={() => onSubmit(content, filename ?? undefined)}
        disabled={!content.trim() || isLoading}
        className="gap-2"
      >
        <Upload className="w-4 h-4" />
        {isLoading ? "Parsing..." : "Parse Schema"}
      </Button>
    </div>
  );
}

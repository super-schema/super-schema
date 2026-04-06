"use client";

import { useState, useCallback } from "react";
import { toast } from "sonner";
import {
  CheckCircle2,
  AlertTriangle,
  XCircle,
  Copy,
  Check,
  X,
  Shield,
  ClipboardCopy,
} from "lucide-react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
  TooltipProvider,
} from "@/components/ui/tooltip";
import type {
  EmissionPreviewPanelProps,
  OverrideMappingInfo,
} from "./EmissionPreviewPanel.types";
import type { TargetOutput, ValidationStatus } from "@/lib/emission/emission.types";
import { highlightLine } from "@/lib/syntax-highlight";

// ---------------------------------------------------------------------------
// Display name mapping
// ---------------------------------------------------------------------------

const TARGET_DISPLAY_NAMES: Record<string, string> = {
  bigquery: "BigQuery",
  avro: "Avro",
  openapi: "OpenAPI",
  spanner: "Spanner",
};

function getDisplayName(name: string): string {
  return TARGET_DISPLAY_NAMES[name] ?? name;
}

// ---------------------------------------------------------------------------
// Validation status indicator
// ---------------------------------------------------------------------------

function ValidationIndicator({ status }: { status: ValidationStatus }) {
  switch (status) {
    case "VALID":
      return <CheckCircle2 className="w-3.5 h-3.5 text-success shrink-0" />;
    case "WARNING":
      return <AlertTriangle className="w-3.5 h-3.5 text-warning shrink-0" />;
    case "INVALID":
      return <XCircle className="w-3.5 h-3.5 text-destructive shrink-0" />;
  }
}

// ---------------------------------------------------------------------------
// Copy button
// ---------------------------------------------------------------------------

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      toast.success("Copied to clipboard");
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("Failed to copy");
    }
  }, [text]);

  return (
    <Button
      variant="ghost"
      size="icon-sm"
      onClick={handleCopy}
      className="absolute top-2 right-2 opacity-0 group-hover/code:opacity-100 transition-opacity"
      aria-label="Copy to clipboard"
    >
      {copied ? (
        <Check className="w-3.5 h-3.5 text-success" />
      ) : (
        <Copy className="w-3.5 h-3.5" />
      )}
    </Button>
  );
}

// ---------------------------------------------------------------------------
// Override badge component
// ---------------------------------------------------------------------------

function OverrideBadge({ override }: { override: OverrideMappingInfo }) {
  const tooltipText = override.overrideSource === "global"
    ? `Global override${override.approvedBy ? ` by ${override.approvedBy}` : ""}`
    : `Per-entity override${override.approvedBy ? ` by ${override.approvedBy}` : ""}`;

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger>
          <Badge variant="info" className="ml-1.5 text-[10px] gap-0.5">
            <Shield className="w-2.5 h-2.5" />
            Override
          </Badge>
        </TooltipTrigger>
        <TooltipContent>{tooltipText}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

// ---------------------------------------------------------------------------
// Code viewer with line numbers and override highlights
// ---------------------------------------------------------------------------

function CodeViewer({
  code,
  language,
  overrides,
}: {
  code: string;
  language: string;
  overrides?: OverrideMappingInfo[];
}) {
  const lines = code.split("\n");
  // Remove trailing empty line if present
  if (lines[lines.length - 1] === "") {
    lines.pop();
  }

  // Find lines that match overrides (simple heuristic: check if the line
  // contains the override's mappedType or sourceType)
  const overriddenLineIndices = new Set<number>();
  const overrideByLine = new Map<number, OverrideMappingInfo>();

  if (overrides) {
    for (const override of overrides) {
      if (!override.isOverride) continue;
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        // Check if this line contains the source type name (field-level match)
        if (
          override.fieldName &&
          line.includes(override.fieldName) &&
          override.currentMappedType &&
          line.includes(override.currentMappedType)
        ) {
          overriddenLineIndices.add(i);
          overrideByLine.set(i, override);
        }
      }
    }
  }

  return (
    <div className="group/code relative rounded-lg border border-border bg-muted/30 overflow-auto max-h-[60vh]">
      <CopyButton text={code} />
      <pre className="p-3 text-[13px] leading-5 font-mono" data-language={language}>
        <code>
          {lines.map((line, i) => {
            const isOverridden = overriddenLineIndices.has(i);
            const lineOverride = overrideByLine.get(i);
            return (
              <div
                key={i}
                className={`flex ${isOverridden ? "border-l-2 border-blue-500 bg-blue-500/5 pl-0" : ""}`}
              >
                <span className="select-none text-muted-foreground/50 w-8 text-right pr-3 shrink-0">
                  {i + 1}
                </span>
                <span className="flex-1 whitespace-pre-wrap break-all">
                  {highlightLine(line, language)}
                  {isOverridden && lineOverride && (
                    <OverrideBadge override={lineOverride} />
                  )}
                </span>
              </div>
            );
          })}
        </code>
      </pre>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Target tab content
// ---------------------------------------------------------------------------

function TargetTabContent({
  target,
  overrides,
  onWarningClick,
}: {
  target: TargetOutput;
  overrides?: OverrideMappingInfo[];
  onWarningClick?: (info: OverrideMappingInfo) => void;
}) {
  const language = getLanguageForTarget(target.name);

  // Filter overrides relevant to this target
  const targetOverrides = overrides?.filter(
    (o) => o.targetFormat === target.targetFormat || o.targetFormat === target.name
  );

  return (
    <div className="space-y-3">
      <CodeViewer code={target.output} language={language} overrides={targetOverrides} />

      {/* Warnings */}
      {target.warnings.length > 0 && (
        <div className="rounded-lg border border-warning/30 bg-warning/5 p-3 space-y-1.5">
          <div className="flex items-center gap-1.5 text-body-small font-medium text-warning">
            <AlertTriangle className="w-3.5 h-3.5" />
            {target.warnings.length} warning{target.warnings.length !== 1 ? "s" : ""}
          </div>
          {target.warnings.map((w, i) => (
            <button
              key={i}
              className="w-full text-left text-caption text-muted-foreground pl-5 hover:text-foreground transition-colors cursor-pointer rounded px-1 py-0.5 hover:bg-warning/10"
              onClick={() =>
                onWarningClick?.({
                  sourceType: w.fieldName ?? "",
                  targetFormat: target.name,
                  currentMappedType: "",
                  lossDescription: w.message,
                  fieldName: w.fieldName,
                })
              }
              title="Click to create override"
            >
              {w.fieldName ? `${w.fieldName}: ` : ""}
              {w.message}
            </button>
          ))}
        </div>
      )}

      {/* Override summary */}
      {targetOverrides && targetOverrides.filter((o) => o.isOverride).length > 0 && (
        <div className="rounded-lg border border-blue-500/30 bg-blue-500/5 p-3 space-y-1.5">
          <div className="flex items-center gap-1.5 text-body-small font-medium text-blue-400">
            <Shield className="w-3.5 h-3.5" />
            {targetOverrides.filter((o) => o.isOverride).length} override{targetOverrides.filter((o) => o.isOverride).length !== 1 ? "s" : ""} applied
          </div>
          {targetOverrides
            .filter((o) => o.isOverride)
            .map((o, i) => (
              <p key={i} className="text-caption text-muted-foreground pl-5">
                {o.sourceType} &rarr; {o.currentMappedType}
                <span className="text-blue-400 ml-1">
                  ({o.overrideSource === "global" ? "global" : "per-entity"})
                </span>
              </p>
            ))}
        </div>
      )}

      {/* Errors */}
      {target.errors.length > 0 && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 space-y-1.5">
          <div className="flex items-center gap-1.5 text-body-small font-medium text-destructive">
            <XCircle className="w-3.5 h-3.5" />
            {target.errors.length} error{target.errors.length !== 1 ? "s" : ""}
          </div>
          {target.errors.map((e, i) => (
            <p key={i} className="text-caption text-muted-foreground pl-5">
              {e.path ? `${e.path}: ` : ""}
              {e.message}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}

function getLanguageForTarget(name: string): string {
  switch (name) {
    case "bigquery":
    case "spanner":
      return "sql";
    case "avro":
      return "json";
    case "openapi":
      return "yaml";
    default:
      return "text";
  }
}

// ---------------------------------------------------------------------------
// Main panel component
// ---------------------------------------------------------------------------

export function EmissionPreviewPanel({
  result,
  open,
  onClose,
  onWarningClick,
  overrides,
}: EmissionPreviewPanelProps) {
  const [copiedAll, setCopiedAll] = useState(false);

  const handleCopyAll = useCallback(async () => {
    const targetEntries = Object.entries(result.targets);
    const sections: string[] = [];

    // TypeSpec section
    sections.push(`${"=".repeat(60)}\n TypeSpec\n${"=".repeat(60)}\n\n${result.typespec}`);

    // Target sections
    for (const [key, target] of targetEntries) {
      const displayName = getDisplayName(key);
      sections.push(`${"=".repeat(60)}\n ${displayName} (${target.targetFormat})\n${"=".repeat(60)}\n\n${target.output}`);
    }

    const allText = sections.join("\n\n");

    try {
      await navigator.clipboard.writeText(allText);
      setCopiedAll(true);
      toast.success("All outputs copied to clipboard");
      setTimeout(() => setCopiedAll(false), 2000);
    } catch {
      toast.error("Failed to copy");
    }
  }, [result]);

  if (!open) return null;

  const targetEntries = Object.entries(result.targets);
  const defaultTab = targetEntries.length > 0 ? targetEntries[0][0] : "typespec";

  return (
    <div className="fixed inset-y-0 right-0 z-40 w-[480px] max-w-full border-l border-border bg-popover/95 backdrop-blur-md shadow-lg flex flex-col animate-auth-fade-up">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <div className="flex items-center gap-2">
          <h3 className="text-body font-medium text-foreground">Emission Preview</h3>
          <span className="text-caption text-muted-foreground">
            {result.summary.totalTargets} target{result.summary.totalTargets !== 1 ? "s" : ""}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            size="sm"
            onClick={handleCopyAll}
            className="gap-1.5 text-caption"
            aria-label="Copy all outputs"
          >
            {copiedAll ? (
              <>
                <Check className="w-3.5 h-3.5 text-success" />
                Copied
              </>
            ) : (
              <>
                <ClipboardCopy className="w-3.5 h-3.5" />
                Copy All
              </>
            )}
          </Button>
          <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close emission preview">
            <X className="w-4 h-4" />
          </Button>
        </div>
      </div>

      {/* Summary bar */}
      <div className="flex items-center gap-3 border-b border-border px-4 py-2 text-caption">
        {result.summary.validCount > 0 && (
          <span className="flex items-center gap-1 text-success">
            <CheckCircle2 className="w-3 h-3" />
            {result.summary.validCount} valid
          </span>
        )}
        {result.summary.warningCount > 0 && (
          <span className="flex items-center gap-1 text-warning">
            <AlertTriangle className="w-3 h-3" />
            {result.summary.warningCount} warning{result.summary.warningCount !== 1 ? "s" : ""}
          </span>
        )}
        {result.summary.invalidCount > 0 && (
          <span className="flex items-center gap-1 text-destructive">
            <XCircle className="w-3 h-3" />
            {result.summary.invalidCount} invalid
          </span>
        )}
        {overrides && overrides.filter((o) => o.isOverride).length > 0 && (
          <span className="flex items-center gap-1 text-blue-400">
            <Shield className="w-3 h-3" />
            {overrides.filter((o) => o.isOverride).length} override{overrides.filter((o) => o.isOverride).length !== 1 ? "s" : ""}
          </span>
        )}
      </div>

      {/* Tabs */}
      <div className="flex-1 overflow-auto px-4 py-3">
        <Tabs defaultValue={defaultTab}>
          <TabsList className="mb-3">
            {targetEntries.map(([key, target]) => (
              <TabsTrigger key={key} value={key}>
                <span className="flex items-center gap-1.5">
                  <ValidationIndicator status={target.validationStatus} />
                  {getDisplayName(key)}
                </span>
              </TabsTrigger>
            ))}
            <TabsTrigger value="typespec">
              <span className="flex items-center gap-1.5">
                <CheckCircle2 className="w-3.5 h-3.5 text-success shrink-0" />
                TypeSpec
              </span>
            </TabsTrigger>
          </TabsList>

          {targetEntries.map(([key, target]) => (
            <TabsContent key={key} value={key}>
              <TargetTabContent
                target={target}
                overrides={overrides}
                onWarningClick={onWarningClick}
              />
            </TabsContent>
          ))}

          <TabsContent value="typespec">
            <CodeViewer code={result.typespec} language="typespec" />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}

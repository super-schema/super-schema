"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";
import type { ImportFormat } from "@/lib/importers/types";
import { VISUAL_FORMATS } from "./registry";
import { JSON_SCHEMA_DIALECT, JSON_SCHEMA_VERSION } from "./serialize";

interface VisualSchemaBuilderProps {
  /** Called with the serialized native text + its format when the user commits. */
  onImport: (content: string, format: ImportFormat) => void;
  defaultEntityName?: string;
  /** Existing entities a field can reference (→ $ref). */
  referenceTargets?: { id?: string; name: string }[];
}

export function VisualSchemaBuilder({
  onImport,
  defaultEntityName = "NewEntity",
  referenceTargets = [],
}: VisualSchemaBuilderProps) {
  const [activeFormatId, setActiveFormatId] = useState<ImportFormat>("json-schema");
  const [content, setContent] = useState<string | null>(null);

  const activeFormat =
    VISUAL_FORMATS.find((f) => f.id === activeFormatId) ?? VISUAL_FORMATS[0];
  const Editor = activeFormat.Editor;

  return (
    <div className="flex flex-col gap-space-4" data-testid="visual-schema-builder">
      {/* Format selector + dialect badge */}
      <div className="flex items-center justify-between gap-space-2 flex-wrap">
        <div className="flex items-center gap-space-2">
          <span className="text-caption text-muted-foreground">Format:</span>
          <div className="flex items-center border border-border rounded-lg overflow-hidden">
            {VISUAL_FORMATS.map((format) => (
              <button
                key={format.id}
                disabled={!format.enabled}
                onClick={() => setActiveFormatId(format.id)}
                title={format.enabled ? undefined : format.comingSoonNote}
                className={cn(
                  "px-space-3 py-1.5 text-body-small transition-colors",
                  format.id === activeFormatId
                    ? "bg-accent text-foreground"
                    : "text-muted-foreground hover:text-foreground",
                  !format.enabled && "opacity-40 cursor-not-allowed"
                )}
              >
                {format.label}
                {!format.enabled && " (soon)"}
              </button>
            ))}
          </div>
        </div>
        {activeFormatId === "json-schema" && (
          <a
            href={JSON_SCHEMA_DIALECT}
            target="_blank"
            rel="noopener noreferrer"
            title="View the JSON Schema specification"
            className="text-caption font-medium bg-primary/10 text-primary px-2 py-0.5 rounded hover:underline"
          >
            JSON Schema {JSON_SCHEMA_VERSION}
          </a>
        )}
      </div>

      {/* Editor + live detail panel */}
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_360px] gap-space-4">
        <div className="min-w-0">
          {Editor ? (
            <Editor
              defaultName={defaultEntityName}
              referenceTargets={referenceTargets}
              onContentChange={setContent}
            />
          ) : (
            <div className="rounded-lg border border-dashed border-border p-space-4 text-body-small text-muted-foreground">
              {activeFormat.comingSoonNote ?? "Not available yet."}
            </div>
          )}
        </div>

        {/* Detail panel — live schema */}
        <aside className="lg:sticky lg:top-space-2 self-start flex flex-col gap-space-2">
          <div className="flex items-center justify-between">
            <span className="text-caption text-muted-foreground uppercase tracking-wider">
              Detail Panel
            </span>
            <span className="text-caption text-muted-foreground">Live preview</span>
          </div>
          <pre
            data-testid="detail-panel-json"
            className="flex-1 overflow-auto rounded-lg border border-border bg-muted/50 p-space-3 text-mono-small text-foreground max-h-[420px] whitespace-pre-wrap break-words"
          >
            {content ?? "// Add a title and at least one property\n// to see the generated schema."}
          </pre>
        </aside>
      </div>

      {/* Commit */}
      <div className="flex justify-end">
        <button
          data-testid="visual-review-button"
          disabled={!content}
          onClick={() => content && onImport(content, activeFormatId)}
          className="px-4 py-1.5 rounded-lg text-body-small bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Review &amp; Import
        </button>
      </div>
    </div>
  );
}

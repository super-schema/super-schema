"use client";

import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { Documentation } from "@/types/schemas/typespec-decorator.schema";
import { previewLiteral } from "@/lib/compiler/typed-value-literal";

/** The logical types whose values are text. */
const TEXT_FIELD_TYPES = new Set(["string", "url"]);

interface DocumentationPanelProps {
  documentation: Documentation;
  fieldType: string;
  onChange: (documentation: Documentation) => void;
}

export function DocumentationPanel({
  documentation,
  fieldType,
  onChange,
}: DocumentationPanelProps) {
  const [docMode, setDocMode] = useState<"edit" | "preview">("edit");

  function update(partial: Partial<Documentation>) {
    onChange({ ...documentation, ...partial });
  }

  const isDeprecated = documentation.deprecated != null;
  // The example as the generator writes it for this field's type (see previewLiteral); undefined when the panel cannot tell.
  const examplePreview = documentation.example != null ? previewLiteral(documentation.example, fieldType) : undefined;

  return (
    <div className="space-y-space-4 pb-space-2">
      {/* @doc — markdown textarea */}
      <div>
        <div className="flex items-center justify-between mb-1">
          <label className="text-caption text-muted-foreground">
            @doc (description)
          </label>
          <div className="flex items-center gap-1">
            <button
              onClick={() => setDocMode("edit")}
              className={`text-[10px] px-2 py-0.5 rounded ${
                docMode === "edit"
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              Edit
            </button>
            <button
              onClick={() => setDocMode("preview")}
              className={`text-[10px] px-2 py-0.5 rounded ${
                docMode === "preview"
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              Preview
            </button>
          </div>
        </div>
        {docMode === "edit" ? (
          <Textarea
            value={documentation.doc ?? ""}
            onChange={(e) => update({ doc: e.target.value || undefined })}
            placeholder="Describe this field using markdown…"
            className="min-h-[80px] text-body-small font-mono"
            rows={4}
          />
        ) : (
          <div className="min-h-[80px] rounded border border-border p-space-2 text-body-small prose prose-sm dark:prose-invert max-w-none">
            {documentation.doc ? (
              <pre className="whitespace-pre-wrap font-sans text-foreground">
                {documentation.doc}
              </pre>
            ) : (
              <span className="text-muted-foreground/50 italic">
                No description
              </span>
            )}
          </div>
        )}
      </div>

      {/* @summary */}
      <div>
        <label className="text-caption text-muted-foreground mb-1 block">
          @summary
        </label>
        <Input
          value={documentation.summary ?? ""}
          onChange={(e) => update({ summary: e.target.value || undefined })}
          placeholder="Short summary for API docs"
          className="h-7 text-body-small"
        />
      </div>

      {/* @example */}
      <div>
        <label className="text-caption text-muted-foreground mb-1 block">
          @example
        </label>
        <Input
          value={
            documentation.example != null
              ? String(documentation.example)
              : ""
          }
          onChange={(e) => {
            const val = e.target.value;
            if (val === "") {
              update({ example: null });
            } else if (TEXT_FIELD_TYPES.has(fieldType)) {
              // A text field keeps the text as typed: JSON would turn `1.50` into 1.5 and `1e3` into 1000.
              update({ example: val });
            } else {
              // Try to parse as JSON for complex types, otherwise use string
              try {
                const parsed = JSON.parse(val);
                update({ example: parsed });
              } catch {
                update({ example: val });
              }
            }
          }}
          placeholder={`Example ${fieldType} value`}
          className="h-7 text-body-small font-mono"
        />
        {documentation.example != null && (
          <div className="mt-1 text-[10px] text-muted-foreground/60 font-mono">
            {examplePreview === undefined
              ? "Checked against the field's type when the source is generated; not previewed for this type."
              : examplePreview.ok
                ? `@example(${examplePreview.text})`
                : <span className="text-destructive">Not written: {examplePreview.reason}.</span>}
          </div>
        )}
      </div>

      {/* @deprecated */}
      <div>
        <label className="flex items-center gap-2 text-body-small text-muted-foreground cursor-pointer mb-1">
          <input
            type="checkbox"
            checked={isDeprecated}
            onChange={(e) =>
              update({
                deprecated: e.target.checked ? "" : null,
              })
            }
            className="accent-primary"
          />
          @deprecated
        </label>
        {isDeprecated && (
          <Input
            value={documentation.deprecated ?? ""}
            onChange={(e) => update({ deprecated: e.target.value })}
            placeholder="Reason and what to use instead"
            className="h-7 text-body-small"
            autoFocus
          />
        )}
      </div>

      {/* @externalDocs */}
      <div>
        <label className="text-caption text-muted-foreground mb-1 block">
          @externalDocs
        </label>
        <div className="flex items-center gap-2">
          <Input
            value={documentation.externalDocsUrl ?? ""}
            onChange={(e) =>
              update({ externalDocsUrl: e.target.value || null })
            }
            placeholder="https://docs.example.com/..."
            className="h-7 text-body-small flex-1"
          />
          <Input
            value={documentation.externalDocsDescription ?? ""}
            onChange={(e) =>
              update({
                externalDocsDescription: e.target.value || null,
              })
            }
            placeholder="Description"
            className="h-7 text-body-small w-48"
          />
        </div>
      </div>
    </div>
  );
}

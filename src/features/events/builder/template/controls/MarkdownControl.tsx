"use client";

// src/features/events/builder/template/controls/MarkdownControl.tsx
// kind "markdown": a textarea with a Write / Preview toggle. The preview is the small safe renderer in ../markdown.tsx.
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Markdown } from "../markdown";
import type { ControlProps } from "./types";

export function MarkdownControl({ field, id, value, onChange, disabled, required, invalid, describedBy, placeholder }: ControlProps) {
  const text = typeof value === "string" ? value : value === undefined || value === null ? "" : String(value);
  const [preview, setPreview] = useState(false);
  return (
    <div className="space-y-space-1">
      <div role="group" aria-label={`${field.label} view`} className="flex justify-end gap-space-1">
        <Button
          type="button" size="xs" variant={preview ? "ghost" : "secondary"} aria-pressed={!preview} data-testid={`${id}-write`}
          onClick={() => setPreview(false)}
        >
          Write
        </Button>
        <Button
          type="button" size="xs" variant={preview ? "secondary" : "ghost"} aria-pressed={preview} data-testid={`${id}-preview-toggle`}
          onClick={() => setPreview(true)}
        >
          Preview
        </Button>
      </div>
      <Textarea
        id={id} data-testid={id} value={text} disabled={disabled} placeholder={placeholder} hidden={preview} className={preview ? "hidden" : undefined}
        aria-required={required || undefined} aria-invalid={invalid ? true : undefined} aria-describedby={describedBy}
        onChange={(e) => onChange(e.target.value)}
      />
      {preview && (
        <div data-testid={`${id}-preview`} className="rounded-md border border-border bg-muted/30 p-space-3">
          {text.trim() === "" ? <p className="text-body-small text-muted-foreground">Nothing to preview yet.</p> : <Markdown source={text} />}
        </div>
      )}
    </div>
  );
}

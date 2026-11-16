"use client";

import { useId, useState, type KeyboardEvent, type ReactNode } from "react";
import { AlertCircle, Check, Loader2, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { SaveStatus } from "./useOperationAutosave";
import type { TypeOptionGroups } from "./api-tab-model";

import { NativeSelect } from "@/components/ui/native-select";
import { Checkbox } from "@/components/ui/checkbox";
/**
 * Small controls of the entity API tab: labels, inline field errors, the type picker, the tag chip input and the save
 * indicator. Native <NativeSelect>s on purpose: compact, keyboard-friendly, and what the e2e specs drive with selectOption.
 */

export const LABEL = "text-[10px] text-muted-foreground/60 uppercase tracking-wider block mb-0.5";

export function FieldLabel({ htmlFor, children }: { htmlFor?: string; children: ReactNode }) {
  return <label htmlFor={htmlFor} className={LABEL}>{children}</label>;
}

export function FieldError({ message, id }: { message?: string; id?: string }) {
  if (!message) return null;
  return (
    <p id={id} role="alert" data-testid="api-field-error" className="mt-0.5 text-[10px] text-destructive">
      {message}
    </p>
  );
}

interface TypePickerProps {
  value: string | null;
  isArray: boolean;
  groups: TypeOptionGroups;
  onChange: (next: { type: string | null; isArray: boolean }) => void;
  /** Offer "no body" (responses). */
  allowNone?: boolean;
  disabled?: boolean;
  invalid?: boolean;
  label: string;
  testId?: string;
}

/** A type (primitive, this entity, another entity / data type) plus "array of". */
export function TypePicker({ value, isArray, groups, onChange, allowNone, disabled, invalid, label, testId }: TypePickerProps) {
  const arrayId = useId();
  const known = value === null || value === "" || groups.primitives.includes(value) || value === groups.entity || groups.others.includes(value);
  return (
    <div className="flex items-center gap-1 min-w-0">
      <NativeSelect
        aria-label={label}
        data-testid={testId}
        value={value ?? ""}
        disabled={disabled}
        aria-invalid={invalid || undefined}
        onChange={(e) => onChange({ type: e.target.value === "" ? null : e.target.value, isArray: e.target.value === "" ? false : isArray })}
        className="h-7 text-caption font-mono min-w-0 flex-1"
      >
        {allowNone && <option value="">(no body)</option>}
        {!known && value && <option value={value}>{value}</option>}
        <optgroup label="This entity">
          <option value={groups.entity}>{groups.entity}</option>
        </optgroup>
        <optgroup label="Primitives">
          {groups.primitives.map((t) => <option key={t} value={t}>{t}</option>)}
        </optgroup>
        {groups.others.length > 0 && (
          <optgroup label="Entities & data types">
            {groups.others.map((t) => <option key={t} value={t}>{t}</option>)}
          </optgroup>
        )}
      </NativeSelect>
      <label htmlFor={arrayId} className="flex items-center gap-0.5 text-[10px] text-muted-foreground whitespace-nowrap" title="Array of this type">
        <Checkbox
          id={arrayId}
          aria-label={`${label}: array`}
          checked={isArray}
          disabled={disabled || (allowNone && !value)}
          onChange={(e) => onChange({ type: value, isArray: e.target.checked })}
        />
        []
      </label>
    </div>
  );
}

interface TagInputProps {
  tags: string[];
  onChange: (tags: string[]) => void;
  disabled?: boolean;
  invalid?: boolean;
  id?: string;
}

/** Tags as chips: Enter or comma adds, Backspace on an empty input removes the last, x removes one. */
export function TagInput({ tags, onChange, disabled, invalid, id }: TagInputProps) {
  const [text, setText] = useState("");
  const add = (raw: string) => {
    const tag = raw.trim().replace(/,$/, "").trim();
    setText("");
    if (!tag || tags.includes(tag)) return;
    onChange([...tags, tag]);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      add(text);
    } else if (e.key === "Backspace" && text === "" && tags.length > 0) {
      onChange(tags.slice(0, -1));
    }
  };
  return (
    <div
      data-testid="api-op-tags"
      aria-invalid={invalid || undefined}
      className="flex flex-wrap items-center gap-1 min-h-7 rounded-lg border border-border bg-background px-1.5 py-0.5 aria-invalid:border-destructive"
    >
      {tags.map((tag) => (
        <span key={tag} className="inline-flex items-center gap-0.5 rounded-md bg-muted px-1.5 text-[11px] text-foreground">
          {tag}
          {!disabled && (
            <button type="button" aria-label={`Remove tag ${tag}`} onClick={() => onChange(tags.filter((t) => t !== tag))} className="text-muted-foreground hover:text-destructive">
              <X className="w-2.5 h-2.5" />
            </button>
          )}
        </span>
      ))}
      {!disabled && (
        <Input
          id={id}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          onBlur={() => text.trim() && add(text)}
          placeholder={tags.length ? "" : "Add a tag, press Enter"}
          aria-label="Add tag"
          className="h-5 flex-1 min-w-[6rem] border-0 bg-transparent px-0.5 text-[11px] shadow-none focus-visible:ring-0"
        />
      )}
    </div>
  );
}

/** "Saving..." / "All changes saved" / "Save failed" for the tab's writes. */
export function SaveIndicator({ status }: { status: SaveStatus }) {
  const base = "inline-flex items-center gap-1 text-caption";
  let body: ReactNode = null;
  switch (status.state) {
    case "idle":
      return <span data-testid="api-save-status" data-state="idle" className="sr-only">No unsaved changes</span>;
    case "pending":
    case "saving":
      body = <><Loader2 className="w-3 h-3 animate-spin" />Saving…</>;
      break;
    case "saved":
      body = <><Check className="w-3 h-3 text-success" />All changes saved</>;
      break;
    case "invalid":
      body = <><AlertCircle className="w-3 h-3 text-warning" />Fix {status.count} issue{status.count === 1 ? "" : "s"} to save</>;
      break;
    case "error":
      body = <><AlertCircle className="w-3 h-3 text-destructive" /><span className="truncate max-w-[18rem]" title={status.message}>Save failed: {status.message}</span></>;
      break;
  }
  return (
    <span data-testid="api-save-status" data-state={status.state} role="status" aria-live="polite" className={cn(base, status.state === "error" ? "text-destructive" : "text-muted-foreground")}>
      {body}
    </span>
  );
}

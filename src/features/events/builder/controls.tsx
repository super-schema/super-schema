"use client";

// src/features/events/builder/controls.tsx
// Thin wrappers every builder section uses for its inputs. Sections never style or wire a bare input themselves, so slice 2 can swap
// a control (combobox, tokenized input, …) in one place.
import { cloneElement, Fragment, isValidElement, useState, type ComponentProps, type KeyboardEvent, type ReactElement, type ReactNode } from "react";
import { Input } from "@/components/ui/input";
import { isReservedKey } from "@/lib/event-specs/own-property";
import { reservedKeyMessage } from "@/lib/reserved-field-names";
import { KEY_MAX_LENGTH, KEY_PATTERN } from "@/lib/events/document/types";
import { KNOWN_PROTOCOLS } from "@/lib/events/inputs";

/** Native `<select>` styling (slice 1 uses native selects wherever a finite list is picked). */
export const selectClass = "w-full rounded-md border border-border bg-background px-space-2 py-1.5 text-body-small";

/**
 * Label + control + hint + error. The control is a single child element: Field links it to the hint and error with
 * `aria-describedby` and flags it with `aria-invalid` (the child must pass those props on to its `<input>`; `Input`,
 * `Textarea`, native controls, `KeyInput` and `ProtocolInput` do). Error and hint get ids `${htmlFor}-error` / `${htmlFor}-hint`
 * and test ids of the same name. Errors are linked, not announced: the builder's top-level alert announces save failures.
 */
export function Field({ label, htmlFor, error, hint, children }: {
  label: string; htmlFor: string; error?: string; hint?: string; children: ReactNode;
}) {
  const errorId = `${htmlFor}-error`;
  const hintId = `${htmlFor}-hint`;
  const describedBy = [error ? errorId : null, hint ? hintId : null].filter(Boolean).join(" ") || undefined;
  const control = isValidElement(children) && children.type !== Fragment && (describedBy || error)
    ? cloneElement(children as ReactElement<Record<string, unknown>>, { "aria-describedby": describedBy, "aria-invalid": error ? true : undefined })
    : children;
  return (
    <div className="space-y-space-1">
      <label htmlFor={htmlFor} className="block text-caption text-muted-foreground">{label}</label>
      {control}
      {hint && <p id={hintId} data-testid={hintId} className="text-caption text-muted-foreground">{hint}</p>}
      {error && <p id={errorId} data-testid={errorId} className="text-body-small text-destructive">{error}</p>}
    </div>
  );
}

/** Why `text` cannot be a key, or null when it can. `committed` is the key as it is in the document now. */
function keyProblem(text: string, committed: string, taken: string[]): string | null {
  if (text === "") return "A key is required.";
  if (text.length > KEY_MAX_LENGTH) return `A key can be at most ${KEY_MAX_LENGTH} characters.`;
  if (!KEY_PATTERN.test(text)) return 'Use only letters, digits, ".", "_" and "-" (no spaces).';
  const unsafe = reservedKeyMessage(text);
  if (unsafe !== null) return unsafe;
  if (isReservedKey(text)) return `"${text}" is reserved. Choose another key.`;
  if (text !== committed && taken.includes(text)) return `The key "${text}" is already used.`;
  return null;
}

/**
 * A local key. The text is local state: it commits (blur / Enter) only when it is valid and not taken, so the document never holds
 * an invalid key; otherwise the rule is shown and the document keeps the old key. Escape puts the committed key back.
 * `taken` = the other keys of the namespace; `onCommit` should go through `renameKey` so references follow.
 */
export function KeyInput({ id, label, value, taken, onCommit, error }: {
  id: string; label: string; value: string; taken: string[]; onCommit: (next: string) => void; error?: string;
}) {
  const [text, setText] = useState(value);
  const [seen, setSeen] = useState(value);
  // The committed key changed from outside (a rename elsewhere, another item): show it.
  if (value !== seen) {
    setSeen(value);
    setText(value);
  }
  const edited = text !== value;
  const problem = edited ? keyProblem(text, value, taken) : null;

  function commit() {
    if (!edited || problem) return;
    onCommit(text);
  }
  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.nativeEvent.isComposing) return;
    if (e.key === "Enter") {
      e.preventDefault();
      commit();
    } else if (e.key === "Escape") {
      setText(value);
    }
  }
  return (
    <Field label={label} htmlFor={id} error={problem ?? error}>
      <Input
        id={id} data-testid={id} value={text} autoComplete="off" spellCheck={false} aria-required
        onChange={(e) => setText(e.target.value)} onBlur={commit} onKeyDown={onKeyDown}
      />
    </Field>
  );
}

/** Protocol: free text with the AsyncAPI protocols as suggestions. */
export function ProtocolInput({ id, value, onChange, ...rest }: Omit<ComponentProps<"input">, "value" | "onChange" | "list"> & {
  id: string; value: string; onChange: (next: string) => void;
}) {
  const listId = `${id}-options`;
  return (
    <>
      <Input {...rest} id={id} data-testid={id} list={listId} value={value} autoComplete="off" spellCheck={false} onChange={(e) => onChange(e.target.value)} />
      <datalist id={listId}>{KNOWN_PROTOCOLS.map((p) => <option key={p} value={p} />)}</datalist>
    </>
  );
}

/** `obj` with `key` set to `value`, or without the key when the text is empty (the document never stores `""` for an optional field). */
export function setOptionalString<T extends object>(obj: T, key: keyof T & string, value: string): T {
  const next = { ...obj } as Record<string, unknown>;
  if (value === "") delete next[key];
  else next[key] = value;
  return next as T;
}

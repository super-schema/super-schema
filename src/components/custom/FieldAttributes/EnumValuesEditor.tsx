"use client";
import {
  useEffect,
  useId,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type Message = { tone: "error" | "status"; text: string };
type FocusTarget = number | "input";

/**
 * An ordered list of values edited as chips. Order is meaningful (it is the generated symbol order), so chips keep their
 * position and can be moved with Alt+ArrowLeft / Alt+ArrowRight. Enter or a comma adds the typed value; pasting a list
 * adds every entry. Values are trimmed; empty and duplicate values are refused with an inline message.
 */
export function EnumValuesEditor({
  label,
  itemLabel = "value",
  inputLabel,
  values,
  onChange,
  help,
  error,
  emptyText = "No values yet. Type a value and press Enter.",
}: {
  label: string;
  /** Singular noun used in messages and accessible names, for example "value" or "symbol". */
  itemLabel?: string;
  /** Accessible name of the add input. Defaults to "New <itemLabel>"; set it when several editors share a page. */
  inputLabel?: string;
  values: string[];
  onChange: (values: string[]) => void;
  help?: ReactNode;
  error?: string;
  emptyText?: string;
}) {
  const id = useId();
  const [draft, setDraft] = useState("");
  const [message, setMessage] = useState<Message | null>(null);
  const [editing, setEditing] = useState<{ index: number; text: string } | null>(
    null,
  );
  const chipRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const pendingFocus = useRef<FocusTarget | null>(null);

  useEffect(() => {
    const target = pendingFocus.current;
    if (target === null) return;
    pendingFocus.current = null;
    if (target === "input") inputRef.current?.focus();
    else chipRefs.current[target]?.focus();
  });

  /** Appends the candidates that are new and non-empty. Returns the duplicates it refused. */
  function addValues(candidates: string[]): string[] {
    const next = [...values];
    const duplicates: string[] = [];
    for (const candidate of candidates) {
      const value = candidate.trim();
      if (!value) continue;
      if (next.includes(value)) duplicates.push(value);
      else next.push(value);
    }
    if (next.length !== values.length) onChange(next);
    return duplicates;
  }

  function duplicateMessage(duplicates: string[]): Message {
    const quoted = duplicates.map((d) => `“${d}”`).join(", ");
    return {
      tone: "error",
      text: `${quoted} ${duplicates.length === 1 ? "is" : "are"} already in the list.`,
    };
  }

  function handleDraftChange(text: string) {
    setMessage(null);
    if (!/[,\n\r]/.test(text)) {
      setDraft(text);
      return;
    }
    // A comma or line break commits everything before it. The text after the last separator stays in the draft.
    const parts = text.split(/[,\n\r]/);
    const remainder = parts.pop() ?? "";
    const duplicates = addValues(parts);
    setDraft(remainder);
    if (duplicates.length) setMessage(duplicateMessage(duplicates));
  }

  /** Single-line inputs drop line breaks from pasted text, so a pasted list is split here before it reaches the draft. */
  function handleDraftPaste(event: ClipboardEvent<HTMLInputElement>) {
    const pasted = event.clipboardData.getData("text");
    if (!/[,\n\r]/.test(pasted)) return;
    event.preventDefault();
    const { selectionStart, selectionEnd } = event.currentTarget;
    const start = selectionStart ?? draft.length;
    const end = selectionEnd ?? draft.length;
    handleDraftChange(draft.slice(0, start) + pasted + draft.slice(end));
  }

  function submitDraft() {
    const text = draft.trim();
    if (!text) {
      setMessage({ tone: "error", text: `Type a ${itemLabel} before adding it.` });
      return;
    }
    const duplicates = addValues([text]);
    if (duplicates.length) {
      setMessage(duplicateMessage(duplicates));
      return;
    }
    setDraft("");
    setMessage({ tone: "status", text: `Added “${text}”.` });
  }

  function handleDraftKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter" && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submitDraft();
    }
  }

  function remove(index: number) {
    const removed = values[index];
    const next = values.filter((_, i) => i !== index);
    onChange(next);
    setEditing(null);
    setMessage({ tone: "status", text: `Removed “${removed}”.` });
    pendingFocus.current = next.length === 0 ? "input" : Math.min(index, next.length - 1);
  }

  function move(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= values.length) return;
    const next = [...values];
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
    setMessage({
      tone: "status",
      text: `Moved “${values[index]}” to position ${target + 1} of ${values.length}.`,
    });
    pendingFocus.current = target;
  }

  /** Commits the inline edit. Returns false (and keeps the edit open) when the new text is refused. */
  function commitEdit(): boolean {
    if (!editing) return true;
    const value = editing.text.trim();
    if (!value) {
      setMessage({ tone: "error", text: `A ${itemLabel} cannot be empty. Remove it instead.` });
      return false;
    }
    const duplicate = values.some((v, i) => i !== editing.index && v === value);
    if (duplicate) {
      setMessage(duplicateMessage([value]));
      return false;
    }
    if (value !== values[editing.index]) {
      onChange(values.map((v, i) => (i === editing.index ? value : v)));
    }
    setEditing(null);
    return true;
  }

  function cancelEdit() {
    if (editing) pendingFocus.current = editing.index;
    setEditing(null);
    setMessage(null);
  }

  function handleEditKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter" && !event.nativeEvent.isComposing) {
      event.preventDefault();
      if (editing && commitEdit()) pendingFocus.current = editing.index;
    } else if (event.key === "Escape") {
      event.preventDefault();
      cancelEdit();
    }
  }

  function handleEditBlur() {
    if (!editing) return;
    // Blur keeps a valid edit and reverts an invalid one, so focus never gets stuck on a refused value.
    if (!commitEdit()) {
      setEditing(null);
    }
  }

  function handleChipKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    if (event.altKey && event.key === "ArrowLeft") {
      event.preventDefault();
      move(index, -1);
    } else if (event.altKey && event.key === "ArrowRight") {
      event.preventDefault();
      move(index, 1);
    }
  }

  const labelId = `${id}-label`;
  const helpId = `${id}-help`;
  const errorId = `${id}-error`;
  const count = `${values.length} ${values.length === 1 ? itemLabel : `${itemLabel}s`}`;
  // Chips are keyed by value and occurrence, not position, so a moved chip keeps its DOM node and focus.
  const keys = values.map((value, index) => {
    const occurrence = values.slice(0, index).filter((v) => v === value).length;
    return `${value}\u0000${occurrence}`;
  });

  return (
    <div
      role="group"
      aria-labelledby={labelId}
      aria-describedby={[help ? helpId : null, error ? errorId : null].filter(Boolean).join(" ") || undefined}
      className="flex min-w-0 flex-col gap-2"
    >
      <div className="flex min-w-0 items-baseline justify-between gap-2">
        <span id={labelId} className="text-sm font-medium">
          {label}
        </span>
        <span className="text-xs tabular-nums text-muted-foreground">{count}</span>
      </div>
      {help && (
        <p id={helpId} className="text-xs text-muted-foreground">
          {help}
        </p>
      )}
      {values.length === 0 ? (
        <p className="text-xs text-muted-foreground">{emptyText}</p>
      ) : (
        <ol className="flex min-w-0 flex-wrap gap-1.5" aria-label={`${label}, in order`}>
          {values.map((value, index) => {
            const isEditing = editing?.index === index;
            return (
              <li
                key={keys[index]}
                className="flex min-w-0 max-w-full items-center gap-0.5 rounded-md border border-border bg-muted/40 text-sm"
              >
                {isEditing ? (
                  <Input
                    autoFocus
                    aria-label={`Edit ${itemLabel} ${value}`}
                    value={editing.text}
                    spellCheck={false}
                    onFocus={(e) => e.currentTarget.select()}
                    onChange={(e) => setEditing({ index, text: e.target.value })}
                    onKeyDown={handleEditKeyDown}
                    onBlur={handleEditBlur}
                    className="h-7 w-auto min-w-24 border-0 bg-transparent px-2 py-0 text-sm shadow-none focus-visible:ring-1"
                  />
                ) : (
                  <button
                    ref={(el) => {
                      chipRefs.current[index] = el;
                    }}
                    type="button"
                    aria-label={`Edit ${itemLabel} ${value}`}
                    aria-keyshortcuts="Alt+ArrowLeft Alt+ArrowRight"
                    title="Click to edit. Alt+Left or Alt+Right moves it."
                    onClick={() => setEditing({ index, text: value })}
                    onKeyDown={(e) => handleChipKeyDown(e, index)}
                    className="flex min-w-0 items-center gap-1.5 rounded-l-md py-1 pl-2 text-left hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <span aria-hidden="true" className="text-xs tabular-nums text-muted-foreground">
                      {index + 1}
                    </span>
                    <span className="min-w-0 break-all font-mono text-xs">{value}</span>
                  </button>
                )}
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label={`Remove ${value}`}
                  onClick={() => remove(index)}
                  className="mr-0.5"
                >
                  <X aria-hidden="true" />
                </Button>
              </li>
            );
          })}
        </ol>
      )}
      <div className="flex min-w-0 items-center gap-2">
        <Input
          ref={inputRef}
          aria-label={inputLabel ?? `New ${itemLabel}`}
          aria-invalid={message?.tone === "error" || undefined}
          placeholder={values.length ? `Add another ${itemLabel}` : `Add a ${itemLabel}`}
          value={draft}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => handleDraftChange(e.target.value)}
          onKeyDown={handleDraftKeyDown}
          onPaste={handleDraftPaste}
          className="min-w-0 flex-1"
        />
        <Button type="button" size="sm" variant="outline" disabled={!draft.trim()} onClick={submitDraft}>
          Add
        </Button>
      </div>
      {error && (
        <p id={errorId} role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      {message && (
        <p
          role={message.tone === "error" ? "alert" : "status"}
          className={message.tone === "error" ? "text-xs text-destructive" : "text-xs text-muted-foreground"}
        >
          {message.text}
        </p>
      )}
    </div>
  );
}

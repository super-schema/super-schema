"use client";

import { useId, useRef, type ClipboardEvent, type KeyboardEvent } from "react";
import { X } from "lucide-react";
import {
  dedupeMailboxes,
  formatMailbox,
  hasOpenQuote,
  parseMailbox,
  splitMailboxEntries,
  type Mailbox,
} from "@/lib/mailbox";

export interface MailboxChipInputState {
  /** Canonical mailbox text of every added address. */
  chips: string[];
  /** The text typed but not yet added. */
  draft: string;
}

interface MailboxChipInputProps extends MailboxChipInputState {
  label: string;
  /** Base for the `data-testid`s: `<testId>-input`, `-error`, `-chips`, `-chip`, `-remove`. */
  testId: string;
  placeholder?: string;
  hint?: string;
  /** An inline message (a failed commit, a failed submit, a server answer); null / undefined = none. */
  error?: string | null;
  disabled?: boolean;
  onChange: (next: MailboxChipInputState) => void;
  /** Called with the message of a failed commit, or null when the person edits and the old message no longer applies. */
  onError: (message: string | null) => void;
}

/** What a chip shows: the parsed name and address, or the raw text when it cannot be parsed (legacy / hand-edited data). */
function chipParts(chip: string): { name: string | null; email: string } {
  const parsed = parseMailbox(chip);
  return parsed.success ? parsed.data : { name: null, email: chip };
}

/**
 * Chip input for a list of mailboxes (`jane@acme.com`, `Jane Doe <jane@acme.com>`, `"Doe, Jane" <jane@acme.com>`). Type and
 * press Enter, comma or semicolon (or leave the field) to add; paste any number of addresses and each becomes a chip. A comma
 * typed inside a quoted display name is just text. Addresses that do not parse stay in the input with an inline message, so
 * they can be fixed; duplicates (case-insensitive) collapse. Controlled: the parent owns the chips, the pending text and the
 * error.
 */
export function MailboxChipInput({
  label,
  testId,
  placeholder,
  hint,
  chips,
  draft,
  error,
  disabled,
  onChange,
  onError,
}: MailboxChipInputProps) {
  const reactId = useId();
  const inputId = `${reactId}-input`;
  const errorId = `${reactId}-error`;
  const hintId = `${reactId}-hint`;
  const inputRef = useRef<HTMLInputElement>(null);

  /** Adds every parsable entry of `text` as a chip; entries that fail (or repeat an existing address) stay in the input. */
  function commit(text: string) {
    const entries = splitMailboxEntries(text);
    if (entries.length === 0) {
      onChange({ chips, draft: "" });
      onError(null);
      return;
    }
    const added: Mailbox[] = chips.map(chipParts);
    const rejected: string[] = [];
    let message: string | null = null;
    for (const entry of entries) {
      const parsed = parseMailbox(entry);
      if (!parsed.success) {
        rejected.push(entry);
        message ??= parsed.error.message;
        continue;
      }
      added.push(parsed.data);
    }
    const unique = dedupeMailboxes(added);
    onChange({ chips: unique.map(formatMailbox), draft: rejected.join(", ") });
    onError(message);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      event.preventDefault();
      if (draft.trim() !== "") commit(draft);
    } else if ((event.key === "," || event.key === ";") && !hasOpenQuote(draft)) {
      event.preventDefault();
      if (draft.trim() !== "") commit(draft);
    } else if (event.key === "Backspace" && draft === "" && chips.length > 0) {
      onChange({ chips: chips.slice(0, -1), draft });
      onError(null);
    }
  }

  function handlePaste(event: ClipboardEvent<HTMLInputElement>) {
    const pasted = event.clipboardData.getData("text");
    if (!/[,;\n\r]/.test(pasted)) return;
    event.preventDefault();
    const field = event.currentTarget;
    const start = field.selectionStart ?? draft.length;
    const end = field.selectionEnd ?? draft.length;
    commit(`${draft.slice(0, start)}${pasted}${draft.slice(end)}`);
  }

  function removeChip(index: number) {
    onChange({ chips: chips.filter((_, i) => i !== index), draft });
    onError(null);
  }

  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(" ") || undefined;

  return (
    <div>
      <label htmlFor={inputId} className="text-body-small text-foreground mb-space-1 block font-medium">
        {label}
      </label>
      <div
        onClick={() => inputRef.current?.focus()}
        className={`flex min-h-9 flex-wrap items-center gap-space-1 rounded-lg border bg-transparent px-2 py-1 transition-colors focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50 dark:bg-input/30 ${
          error ? "border-destructive ring-3 ring-destructive/20" : "border-input"
        } ${disabled ? "pointer-events-none opacity-50" : ""}`}
      >
        {chips.length > 0 && (
          <ul role="list" aria-label={`Added ${label.toLowerCase()}`} data-testid={`${testId}-chips`} className="contents">
            {chips.map((chip, index) => {
              const { name, email } = chipParts(chip);
              return (
                <li
                  key={`${index}:${chip}`}
                  data-testid={`${testId}-chip`}
                  className="flex max-w-full items-center gap-1 rounded-full border border-border bg-muted py-0.5 pl-2 pr-1 text-body-small text-foreground"
                >
                  <span className="truncate">
                    {name ? (
                      <>
                        <span className="font-medium">{name}</span> <span className="text-muted-foreground">{email}</span>
                      </>
                    ) : (
                      email
                    )}
                  </span>
                  <button
                    type="button"
                    onClick={() => removeChip(index)}
                    disabled={disabled}
                    aria-label={`Remove ${email}`}
                    data-testid={`${testId}-remove`}
                    className="rounded-full p-0.5 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                  >
                    <X className="h-3 w-3" aria-hidden="true" />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        <input
          ref={inputRef}
          id={inputId}
          data-testid={`${testId}-input`}
          type="text"
          value={draft}
          placeholder={chips.length === 0 ? placeholder : undefined}
          disabled={disabled}
          autoComplete="off"
          spellCheck={false}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          onChange={(event) => {
            onChange({ chips, draft: event.target.value });
            if (error) onError(null);
          }}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          onBlur={() => {
            if (draft.trim() !== "") commit(draft);
          }}
          className="min-w-[10rem] flex-1 bg-transparent py-0.5 text-body-small text-foreground outline-none placeholder:text-muted-foreground/40"
        />
      </div>
      {hint && (
        <p id={hintId} className="text-caption text-muted-foreground mt-space-1">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} role="alert" data-testid={`${testId}-error`} className="text-body-small text-destructive mt-space-1">
          {error}
        </p>
      )}
    </div>
  );
}

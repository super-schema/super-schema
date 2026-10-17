// src/lib/events/import/bound.ts
// Bounds for text the importer shows to the user. Pure — client-safe.
//
// A message or an error built from a document can echo document-controlled text: a key, a pointer, a `$ref`, a schema format. A document may
// make each of those as long as the whole file (1 MiB), and repeat it once per message, so nothing document-controlled goes into a warning or
// an error unbounded: `boundText` / `boundChain` shorten what is echoed, `boundPointer` caps the `pointer` field, and a warning sink keeps the
// number of warnings bounded too (the rest is counted, not kept).
import type { ImportWarning } from "./types";

/** Longest piece of document text echoed in a message. */
export const MAX_TEXT_LENGTH = 80;
/** Most entries of a chain (or list) echoed in a message. */
export const MAX_CHAIN_ENTRIES = 5;
/** Longest entry of a reference chain echoed in a message (an entry is a pointer, and `#/components/schemas/` alone takes 21 characters). */
export const CHAIN_ENTRY_LENGTH = 60;
/** Longest `pointer` field of a warning or an error's details. */
export const MAX_POINTER_LENGTH = 500;
/** Longest warning message, whatever it was built from (a safety net behind `boundText`). */
export const MAX_MESSAGE_LENGTH = 600;
/** Most warnings an import reports; the rest is counted in one final summary warning. */
export const MAX_WARNINGS = 100;

/** The text of `value`: a string as it is, anything else as `String(value)` / JSON; never throws. */
function textOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "object" && value !== null) {
    try {
      return JSON.stringify(value) ?? String(value);
    } catch {
      return Object.prototype.toString.call(value);
    }
  }
  return String(value);
}

/**
 * `value` as text of at most `max` characters: longer text is cut and ends with `…` (the result is at most `max` long). A character that
 * would be cut in half (a surrogate pair) is dropped whole. Anything that is not a string is shown as `String(value)` / JSON first.
 */
export function boundText(value: unknown, max: number = MAX_TEXT_LENGTH): string {
  const text = textOf(value);
  if (text.length <= max) return text;
  if (max < 1) return "";
  let kept = text.slice(0, max - 1);
  const last = kept.charCodeAt(kept.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) kept = kept.slice(0, -1); // the first half of a surrogate pair
  return `${kept}…`;
}

/**
 * The first `maxEntries` entries of `chain`, each cut to `maxEach` characters, joined by `separator`, then `(N more)` for the rest:
 * `#/a → #/b → #/c (7 more)`. An empty chain is an empty string.
 */
export function boundChain(chain: readonly unknown[], maxEntries: number = MAX_CHAIN_ENTRIES, maxEach: number = MAX_TEXT_LENGTH, separator = " → "): string {
  const shown = Math.max(0, maxEntries);
  const text = chain.slice(0, shown).map((entry) => boundText(entry, maxEach)).join(separator);
  const more = chain.length - shown;
  return more > 0 ? (text === "" ? `(${more} more)` : `${text} (${more} more)`) : text;
}

/** A pointer for the `pointer` field of a warning or an error: at most `MAX_POINTER_LENGTH` characters. */
export const boundPointer = (pointer: string): string => boundText(pointer, MAX_POINTER_LENGTH);

export interface WarningSink {
  /** Keeps the warning (its pointer and message bounded) while there is room; counts it otherwise. */
  add(warning: ImportWarning): void;
  /** The kept warnings, plus ONE final `DROPPED_CONSTRUCT` warning saying how many more were omitted (when any). */
  finish(): ImportWarning[];
}

export function createWarningSink(max: number = MAX_WARNINGS): WarningSink {
  const kept: ImportWarning[] = [];
  let omitted = 0;
  return {
    add(warning) {
      if (kept.length >= max) {
        omitted += 1;
        return;
      }
      kept.push({ pointer: boundPointer(warning.pointer), code: warning.code, message: boundText(warning.message, MAX_MESSAGE_LENGTH) });
    },
    finish() {
      if (omitted === 0) return [...kept];
      return [...kept, { pointer: "", code: "DROPPED_CONSTRUCT", message: `${omitted} more warning${omitted === 1 ? " was" : "s were"} omitted` }];
    },
  };
}

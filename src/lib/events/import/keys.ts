// src/lib/events/import/keys.ts
// Document keys for imported items: a key that is already valid is kept as written, anything else gets a generated one. Pure — client-safe.
import { isReservedKey } from "@/lib/event-specs/own-property";
import { KEY_MAX_LENGTH, KEY_PATTERN } from "@/lib/events/document/types";
import { slugKey } from "@/lib/events/document/keys";
import { boundText } from "./bound";
import type { ImportWarning } from "./types";

/** True when `key` can be a document key as it is: `KEY_PATTERN`, at most `KEY_MAX_LENGTH`, never an `Object.prototype` name. */
export const isUsableKey = (key: string): boolean => key.length > 0 && key.length <= KEY_MAX_LENGTH && KEY_PATTERN.test(key) && !isReservedKey(key);

/** Per `taken` set: for each (digits of the suffix, stem) the next suffix number to try. `taken` only grows, so a candidate found taken is never free again. */
const nextSuffix = new WeakMap<ReadonlySet<string>, Map<string, number>>();

/**
 * `base`, or `base-2`, `base-3`, … — the same result as `uniqueKey`, but it reads `taken` instead of copying it, and it remembers where the search
 * stopped, so N keys that all slug to the same base cost N steps in all, not N²/2 (20,000 such keys took 40 s).
 *
 * What is probed is `stem` + `-n`, where the stem is the base cut to `KEY_MAX_LENGTH` minus the suffix length: bases that differ only after
 * their first 60 characters share candidates, so the hint is kept per STEM and per number of digits (the stem shortens by one character each
 * time the suffix gains a digit), not per base. The CALLER adds the result to `taken` (`assignKeys` and the mapper do).
 */
export function uniqueIn(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  let hints = nextSuffix.get(taken);
  if (!hints) {
    hints = new Map();
    nextSuffix.set(taken, hints);
  }
  for (let digits = 1; ; digits += 1) {
    const stem = base.slice(0, KEY_MAX_LENGTH - (digits + 1));
    const band = `${digits}:${stem}`;
    const last = 10 ** digits - 1;
    for (let n = Math.max(digits === 1 ? 2 : 10 ** (digits - 1), hints.get(band) ?? 0); n <= last; n += 1) {
      const candidate = `${stem}-${n}`;
      if (!taken.has(candidate)) {
        hints.set(band, n + 1);
        return candidate;
      }
    }
    hints.set(band, last + 1); // every candidate of this length is taken: later calls skip the whole band
  }
}

/** A text worth slugging: a string with at least one ASCII letter or digit. */
const usable = (value: unknown): string | null => (typeof value === "string" && /[a-zA-Z0-9]/.test(value) ? value.trim() : null);

/**
 * A key for properties written in place: from their `name`, else their `title`, else "trait". The rule of `suggestKey("trait", …)`, without the
 * copy of `taken` it makes for every key (a copy per key made thousands of such properties quadratic).
 */
export function suggestTraitKey(node: Record<string, unknown>, taken: ReadonlySet<string>): string {
  const text = usable(node.name) ?? usable(node.title);
  return uniqueIn(text ? slugKey(text) : "trait", taken);
}

export interface KeyRequest {
  /** Identifies the request in the result (unique per call). */
  id: string;
  /** The key as written in the source. */
  key: string;
  /** Where it is written, for the warning. */
  pointer: string;
}

/**
 * Document keys for `requests`, never one that is in `taken` (every assigned key is added to it). Keys that are usable and free keep
 * their name, whatever order the requests come in; the rest get `slugKey` + `-2`, `-3`, … and a `KEY_ADJUSTED` warning.
 */
export function assignKeys(requests: readonly KeyRequest[], taken: Set<string>, noun: string, warn: (warning: ImportWarning) => void): Map<string, string> {
  const assigned = new Map<string, string>();
  const deferred: KeyRequest[] = [];
  for (const request of requests) {
    if (isUsableKey(request.key) && !taken.has(request.key)) {
      assigned.set(request.id, request.key);
      taken.add(request.key);
    } else deferred.push(request);
  }
  for (const request of deferred) {
    const key = uniqueIn(slugKey(request.key), taken);
    assigned.set(request.id, key);
    taken.add(key);
    const reason = isUsableKey(request.key) ? "is already used by another one" : 'is not a valid key (keys may only contain letters, digits, ".", "_" and "-")';
    warn({ pointer: request.pointer, code: "KEY_ADJUSTED", message: `The ${noun} key "${boundText(request.key)}" ${reason}; it is imported as "${key}"` });
  }
  return assigned;
}

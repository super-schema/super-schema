// src/lib/events/import/keys.ts
// Document keys for imported items: a key that is already valid is kept as written, anything else gets a generated one. Pure — client-safe.
import { isReservedKey } from "@/lib/event-specs/own-property";
import { KEY_MAX_LENGTH, KEY_PATTERN } from "@/lib/events/document/types";
import { slugKey } from "@/lib/events/document/keys";
import type { ImportWarning } from "./types";

/** True when `key` can be a document key as it is: `KEY_PATTERN`, at most `KEY_MAX_LENGTH`, never an `Object.prototype` name. */
export const isUsableKey = (key: string): boolean => key.length > 0 && key.length <= KEY_MAX_LENGTH && KEY_PATTERN.test(key) && !isReservedKey(key);

/**
 * `base`, or `base-2`, `base-3`, … — the same result as `uniqueKey`, but it reads `taken` instead of copying it: an import may hold
 * thousands of keys, and a copy per key would make the whole mapping quadratic.
 */
export function uniqueIn(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const suffix = `-${n}`;
    const candidate = `${base.slice(0, KEY_MAX_LENGTH - suffix.length)}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
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
export function assignKeys(requests: readonly KeyRequest[], taken: Set<string>, noun: string, warnings: ImportWarning[]): Map<string, string> {
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
    warnings.push({ pointer: request.pointer, code: "KEY_ADJUSTED", message: `The ${noun} key "${request.key}" ${reason}; it is imported as "${key}"` });
  }
  return assigned;
}

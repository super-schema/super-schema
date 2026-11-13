// src/lib/events/document/extensions.ts
// Metadata attributes on event channels, messages and operations (`extensions`: an `x-…` key → JSON value). Pure — client-safe.
import { METADATA_ATTRIBUTE_KEY_REGEX } from "@/types/schemas/metadata-attribute";
import type { JsonValue } from "@/lib/event-specs/types";

/** The attribute key rule (`^x-[A-Za-z0-9][A-Za-z0-9_.-]*$`, at most 64 characters): the only keys an extension map may hold. */
export const isAttributeKey = (key: string): boolean => key.length <= 64 && METADATA_ATTRIBUTE_KEY_REGEX.test(key);

const MAX_DEPTH = 64;

/** True for a value `JSON.stringify` keeps as written: null, boolean, finite number, string, an array or plain object of them (≤ 64 levels). */
export function isJsonValue(value: unknown, depth = 1): value is JsonValue {
  if (depth > MAX_DEPTH) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((v) => isJsonValue(v, depth + 1));
  if (typeof value === "object") {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return false;
    return Object.values(value as Record<string, unknown>).every((v) => isJsonValue(v, depth + 1));
  }
  return false;
}

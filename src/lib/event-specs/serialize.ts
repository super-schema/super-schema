import { stringify } from "yaml";
import type { JsonObject } from "./types";

/**
 * Spec §7.2 step 7. Key order is whatever the assembler built (canonical
 * AsyncAPI order, maps sorted) — the serializers never reorder, so output is
 * byte-stable for equal input.
 */

/** Top-level / `info` key order of an assembled document (assemble.ts §8) — keep in sync; a test pins it. */
export const TOP_LEVEL_KEY_ORDER = ["asyncapi", "info", "servers", "defaultContentType", "channels", "operations", "components"] as const;
export const INFO_KEY_ORDER = ["title", "version", "description", "contact", "license", "tags", "externalDocs"] as const;

function withKeyOrder(object: JsonObject, order: readonly string[]): JsonObject {
  const out: JsonObject = {};
  for (const key of order) if (key in object) out[key] = object[key];
  for (const key of Object.keys(object)) if (!(key in out)) out[key] = object[key];
  return out;
}

/**
 * A published document read back from a `jsonb` column comes back with its keys in jsonb order (shortest first), not the
 * assembler's canonical AsyncAPI order. Restore the canonical order of the top level and of `info`, so a stored version
 * serializes like the draft emission it came from; unknown keys follow in their stored order. Nested maps keep stored order.
 */
export function canonicalizeDocumentOrder(document: JsonObject): JsonObject {
  const info = document.info;
  const ordered = withKeyOrder(document, TOP_LEVEL_KEY_ORDER);
  if (typeof info === "object" && info !== null && !Array.isArray(info)) ordered.info = withKeyOrder(info, INFO_KEY_ORDER);
  return ordered;
}

export function toJson(document: JsonObject): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}

export function toYaml(document: JsonObject): string {
  return stringify(document, {
    aliasDuplicateObjects: false, // never emit &anchors / *aliases for repeated schemas
    lineWidth: 0, // never fold long descriptions
    singleQuote: true, // '2.0', '#/components/...' — matches spec §6.2
  });
}

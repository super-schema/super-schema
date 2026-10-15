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
    // Quote what a YAML 1.1 reader (PyYAML, Ruby/Psych, many Java parsers) misreads. The default (1.2 core) writes
    // `title: yes`, `no:`, `address: on`, `12:30:` and `2001-01-01` bare — 1.1 parses those as true/false/true/750/a date,
    // and the keys `no` / `n` collapse into one. `version: "1.1"` quotes them all; the output is a plain subset of YAML
    // 1.2 as well (no `%YAML` directive is emitted), so 1.2 readers see the same document.
    version: "1.1",
    aliasDuplicateObjects: false, // never emit &anchors / *aliases for repeated schemas
    lineWidth: 0, // never fold long descriptions
    singleQuote: true, // '2.0', '#/components/...' — matches spec §6.2
  });
}

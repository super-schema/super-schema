import { stringify } from "yaml";
import type { JsonObject } from "./types";

/**
 * Spec §7.2 step 7. Key order is whatever the assembler built (canonical
 * AsyncAPI order, maps sorted) — the serializers never reorder, so output is
 * byte-stable for equal input.
 */

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

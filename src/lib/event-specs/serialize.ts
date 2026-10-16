import { stringify, type ScalarTag } from "yaml";
import type { JsonObject } from "./types";

/**
 * Spec §7.2 step 7. Key order is whatever the assembler built (canonical
 * AsyncAPI order, maps sorted) — the serializers never reorder, so output is
 * byte-stable for equal input.
 */

/** Top-level / `info` key order of an assembled document (assemble.ts §8) — keep in sync; a test pins it. */
export const TOP_LEVEL_KEY_ORDER = ["asyncapi", "info", "servers", "defaultContentType", "channels", "operations", "components"] as const;
export const INFO_KEY_ORDER = ["title", "version", "description", "termsOfService", "contact", "license", "tags", "externalDocs"] as const;

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

/**
 * Strings the `yaml` library's 1.1 mode still leaves bare although a reader gets a different value:
 * - `=` is the YAML 1.1 "value" type — PyYAML raises a `ConstructorError` for the whole document;
 * - `<<` is the 1.1 merge key — as a value (or a key) PyYAML treats it as a merge (error / dropped entry); the library's own
 *   merge tag stringifies it bare whatever scalar style is requested, so it needs a tag in front of the merge tag;
 * - `0o17` is a plain string in 1.1 but the integer 15 under the YAML 1.2 core schema.
 * Single quotes make each of them a string for every reader.
 */
const AMBIGUOUS_STRING = /^(=|<<|0o[0-7]+)$/;

const quoteAmbiguousStrings: ScalarTag = {
  identify: (value) => typeof value === "string" && AMBIGUOUS_STRING.test(value),
  // When several tags identify a value the library keeps only those that have a `test`; the merge tag has one, so without
  // this the merge tag would win for `<<` and write it bare.
  test: AMBIGUOUS_STRING,
  default: true, // an ordinary string: no `!!str` prefix
  tag: "tag:yaml.org,2002:str",
  resolve: (str) => str,
  stringify: (item) => `'${String(item.value)}'`,
};

export function toYaml(document: JsonObject): string {
  return stringify(document, {
    // Quote what a YAML 1.1 reader (PyYAML, Ruby/Psych, many Java parsers) misreads. The default (1.2 core) writes
    // `title: yes`, `no:`, `address: on`, `12:30:` and `2001-01-01` bare — 1.1 parses those as true/false/true/750/a date,
    // and the keys `no` / `n` collapse into one. `version: "1.1"` quotes them all; the output is a plain subset of YAML
    // 1.2 as well (no `%YAML` directive is emitted), so 1.2 readers see the same document.
    version: "1.1",
    customTags: (tags) => [quoteAmbiguousStrings, ...tags], // `=`, `<<`, `0o17` — see AMBIGUOUS_STRING
    aliasDuplicateObjects: false, // never emit &anchors / *aliases for repeated schemas
    lineWidth: 0, // never fold long descriptions
    singleQuote: true, // '2.0', '#/components/...' — matches spec §6.2
  });
}

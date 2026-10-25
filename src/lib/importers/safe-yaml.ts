/**
 * The one way the importers parse YAML from a caller (a pasted schema, a fetched `$ref` target, an OpenAPI file, a sniffed upload).
 *
 * Why not `yaml.parse` alone: an alias (`*b`) names the node an anchor (`&b`) already holds, so the parsed value SHARES it, and the
 * parser's own guard (`maxAliasCount`, a count scaled by what the aliases name) lets a 1.8 MB file name a 900,000-value list forty
 * times. Nothing complains until the value is serialised or walked: every `JSON.stringify(clean)`, copy and merge then sees 36 million
 * values, and the process aborts with a heap error that no `try` can catch. Two bounds close it:
 *
 *  1. few aliases (`YAML_MAX_ALIAS_COUNT`): real schemas hardly use them, and a document that does can write the part out;
 *  2. the EXPANDED size: after the parse, the value is walked as a tree (a shared node is counted once per use, nothing is memoised
 *     across aliases) and refused past `expandedBudgetFor(text.length)` values: 5x the text, at most 5 million, at least 10,000.
 *
 * Pure and synchronous; never throws. The walk is iterative and stops at the limit, so its cost is bounded by the limit, not by what
 * the document claims to expand to.
 */
import { parse } from "yaml";

/**
 * Aliases of one anchor the parser resolves before it gives up (the parser starts the count at 1 for the anchor itself and scales it by what
 * the aliases name). The parser's default is 100. It is NOT the safeguard by itself: an anchor that holds only EMPTY collections
 * (`&b [[], [], ...]`) scales to 0, so any number of aliases of it passes; the expansion walk below is what bounds the memory.
 */
export const YAML_MAX_ALIAS_COUNT = 25;
/** The expanded document may hold this many values per character of text ... */
export const YAML_EXPANSION_FACTOR = 5;
/** ... but never more than this ... */
export const YAML_MAX_EXPANDED_NODES = 5_000_000;
/** ... and a tiny document is always allowed this much. */
export const YAML_MIN_EXPANDED_NODES = 10_000;
/** A string is charged as one value plus one more for every this many characters: a long string is not free to copy. */
const CHARS_PER_NODE = 64;

export type BoundedYaml =
  | { ok: true; value: unknown }
  /** The document breaks a bound; `message` is fixed text (it never quotes the document) that can be shown to the user. */
  | { ok: false; kind: "aliases" | "expansion"; message: string }
  /** The text is not YAML; `error` is the parser's own error (it can quote the document: show its position only). */
  | { ok: false; kind: "syntax"; error: unknown };

/** How many values the expanded form of `textLength` characters of YAML may hold. */
export function expandedBudgetFor(textLength: number): number {
  return Math.min(YAML_MAX_EXPANDED_NODES, Math.max(YAML_MIN_EXPANDED_NODES, textLength * YAML_EXPANSION_FACTOR));
}

/**
 * Whether `root`, walked as a tree, holds more than `limit` values. A node reached through several aliases is counted every time;
 * a cyclic structure runs into the limit. Iterative (a hostile nesting cannot overflow the stack).
 */
export function expandedSizeExceeds(root: unknown, limit: number): boolean {
  const stack: unknown[] = [root];
  let used = 0;
  while (stack.length > 0) {
    const value = stack.pop();
    used += 1;
    if (typeof value === "string") used += Math.floor(value.length / CHARS_PER_NODE);
    if (used > limit) return true;
    if (typeof value !== "object" || value === null) continue;
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) stack.push(value[i]);
      continue;
    }
    for (const key of Object.keys(value)) {
      used += Math.floor(key.length / CHARS_PER_NODE);
      stack.push((value as Record<string, unknown>)[key]);
    }
  }
  return used > limit;
}

const ALIASES_MESSAGE = `The YAML document uses aliases (&anchor / *alias) so heavily that it would expand without bound (more than ${YAML_MAX_ALIAS_COUNT} aliases of one anchor); it was rejected`;

/** `text` parsed as YAML under the alias and expansion bounds above. Never throws. */
export function parseYamlBounded(text: string): BoundedYaml {
  let value: unknown;
  try {
    value = parse(text, { maxAliasCount: YAML_MAX_ALIAS_COUNT });
  } catch (error) {
    // The parser's own resource guard: "Excessive alias count indicates a resource exhaustion attack".
    if (error instanceof ReferenceError) return { ok: false, kind: "aliases", message: ALIASES_MESSAGE };
    return { ok: false, kind: "syntax", error };
  }
  const limit = expandedBudgetFor(text.length);
  if (expandedSizeExceeds(value, limit)) {
    return {
      ok: false,
      kind: "expansion",
      message: `The YAML document expands to more than ${limit.toLocaleString("en-US")} values once its aliases (&anchor / *alias) are resolved; it was rejected as too large`,
    };
  }
  return { ok: true, value };
}

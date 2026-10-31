// The keywords of an array's ITEM schema (description, length bounds, a pattern, a format ...) that the IR keeps on the array field as
// `x-items-<keyword>` (the field has no element-level slot; see `ELEMENT_KEYS` in the JSON Schema importer). TypeSpec cannot put a
// decorator on `T[]`'s element, so the generated schema carries them on the property; this puts each back where it came from: on `items`.
// JSON Schema 2020-12 lets a `$ref` have siblings, so `items: { $ref: "X.json", description: "..." }` is valid and loses nothing.

/** The item keywords that move back, by the name they have on `items`. */
const ITEM_KEYWORDS: ReadonlySet<string> = new Set([
  "minLength", "maxLength", "pattern", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "minItems", "maxItems",
  "description", "deprecated", "title", "format",
]);

const PREFIX = "x-items-";

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** `node` with every `x-items-<keyword>` of a schema that has an object `items` moved onto it (an `items` keyword of its own wins). Pure; returns `node` itself when nothing moves. */
function lift(node: unknown): unknown {
  if (Array.isArray(node)) {
    let changed = false;
    const next = node.map((child) => {
      const lifted = lift(child);
      if (lifted !== child) changed = true;
      return lifted;
    });
    return changed ? next : node;
  }
  if (!isObject(node)) return node;
  let changed = false;
  const entries: Array<[string, unknown]> = [];
  const moved: Array<[string, unknown]> = [];
  const items = isObject(node.items) ? node.items : undefined;
  for (const [key, value] of Object.entries(node)) {
    const keyword = key.startsWith(PREFIX) ? key.slice(PREFIX.length) : undefined;
    if (items && keyword !== undefined && ITEM_KEYWORDS.has(keyword)) {
      moved.push([keyword, value]);
      changed = true;
      continue;
    }
    const lifted = lift(value);
    if (lifted !== value) changed = true;
    entries.push([key, lifted]);
  }
  if (!changed) return node;
  const out = Object.fromEntries(entries);
  if (items) {
    const lifted = lift(items) as Record<string, unknown>;
    out.items = { ...lifted, ...Object.fromEntries(moved.filter(([keyword]) => !(keyword in lifted))) };
  }
  return out;
}

/**
 * The text of a generated JSON Schema file with the item keywords back on `items`. Text that is not JSON, or has none to move, comes back
 * unchanged (byte for byte).
 */
export function liftItemKeywords(content: string): string {
  if (!content.includes(`"${PREFIX}`)) return content;
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return content;
  }
  const lifted = lift(parsed);
  if (lifted === parsed) return content;
  return JSON.stringify(lifted, null, 4) + (content.endsWith("\n") ? "\n" : "");
}

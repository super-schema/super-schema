/**
 * Sizes and comparisons of the values an import preserves verbatim (extensions, `default` / `examples`, descriptions), measured by UNIQUE
 * content. A `$ref` copies a definition's values onto every field that names it BY REFERENCE, so the same string or object is reached once per
 * reference; serialising it (or concatenating it into a lookup key) once per reference made the cost, and the memory, N times the value.
 *
 * - a string is sized by its length and never serialised;
 * - an object is serialised ONCE per object identity (a WeakMap), however many fields hold it;
 * - two values are compared by identity first, and only two different objects are compared by their (cached) text.
 */

const objectText = new WeakMap<object, string>();

/** The JSON text of an object value, computed once per object identity. */
export function objectJsonText(value: object): string {
  let text = objectText.get(value);
  if (text === undefined) {
    text = JSON.stringify(value) ?? "";
    objectText.set(value, text);
  }
  return text;
}

/** The serialised size of a value in characters, without serialising a string and serialising an object once. */
export function preservedValueSize(value: unknown): number {
  if (typeof value === "string") return value.length + 2;
  if (typeof value === "object" && value !== null) return objectJsonText(value).length;
  return (JSON.stringify(value) ?? "").length;
}

/** Whether two JSON values are the same value: identity first; two different objects by their cached text; anything else differs. */
export function sameJsonValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  return objectJsonText(a) === objectJsonText(b);
}

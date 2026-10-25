/**
 * An upper bound on how big an import's response may serialise, for the amplification that no single keyword budget catches: a `$ref` to a
 * shared definition copies the definition's content (an enum's values, a `pattern`, an `originalType` label, a `const`) onto every field that
 * names it, and the response serialises every copy (a 350 KB schema with a 40,000-value enum and 100 references came back as 35 MB).
 *
 * The limit is 8 MB, or eight times the source text when that is more, so a genuinely large source is never refused for being large; only
 * a response many times bigger than what it was made from is. The walk counts a shared node once per use, never memoises, and stops at the
 * limit, so its cost is bounded by the limit and not by what the response claims to hold.
 */
export const MIN_IMPORT_RESPONSE_BYTES = 8_000_000;
export const IMPORT_RESPONSE_FACTOR = 8;

export function importResponseLimit(sourceChars: number): number {
  return Math.max(MIN_IMPORT_RESPONSE_BYTES, IMPORT_RESPONSE_FACTOR * sourceChars);
}

/** Whether `value`, serialised as JSON, would be longer than about `limit` bytes (strings by length; structure and numbers by a small constant). */
export function responseSizeExceeds(value: unknown, limit: number): boolean {
  const stack: unknown[] = [value];
  let used = 0;
  while (stack.length > 0) {
    const v = stack.pop();
    if (typeof v === "string") used += v.length + 2;
    else if (typeof v === "number" || typeof v === "boolean" || v === null || v === undefined) used += 5;
    else if (Array.isArray(v)) {
      used += 2 + v.length;
      for (let i = 0; i < v.length; i++) stack.push(v[i]);
    } else if (typeof v === "object") {
      used += 2;
      for (const key of Object.keys(v as object)) {
        used += key.length + 4;
        stack.push((v as Record<string, unknown>)[key]);
      }
    }
    if (used > limit) return true;
  }
  return false;
}

/** The refusal message when `result` is far larger than the `sourceChars` characters it came from, or undefined when it is within the limit. */
export function importResponseTooLargeMessage(result: unknown, sourceChars: number): string | undefined {
  const limit = importResponseLimit(sourceChars);
  if (!responseSizeExceeds(result, limit)) return undefined;
  return `The import expands to more than ${(limit / 1_000_000).toFixed(0)} MB: references to shared definitions repeat large values (enum values, patterns, constants) on too many fields.`;
}

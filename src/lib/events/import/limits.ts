// src/lib/events/import/limits.ts
// The bounds that keep a hostile AsyncAPI file from exhausting memory, time or the stack. Pure — client-safe.

/** YAML aliases the parser resolves before it gives up (the `yaml` package counts them against the size of what they expand to). */
export const MAX_ALIAS_COUNT = 100;
/** Deepest object/array nesting accepted, and the deepest a `$ref` expansion may nest. Real schemas stay far below it; later steps recurse once per level. */
export const MAX_NESTING_DEPTH = 256;
/** Most values (objects, arrays, scalars) the document may contain once YAML aliases are expanded: 1 MiB of text holds about half a million. */
export const MAX_DOCUMENT_NODES = 2_000_000;
/** Most values all `$ref` expansions of one import may add up to (shared targets count once per use): 1 MiB of text expands to far less. */
export const MAX_EXPANDED_NODES = 5_000_000;

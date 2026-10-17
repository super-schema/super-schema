// src/lib/events/import/limits.ts
// The bounds on what the AsyncAPI importer's pure layer PARSES and RESOLVES: memory and the stack (YAML aliases, nesting, key length, the
// number of values, the expansion of references). They do NOT bound: (a) the cost of MAPPING a document with very wide objects or lists
// (some steps are quadratic in them): that bound is `checkEntryCounts` / `checkExpandedSize` in the SERVICE layer
// (`src/services/events/import-limits.ts`), which the service runs before the mapper and a caller of the pure layer alone does not get;
// (b) the time of the AsyncAPI parser, which the service runs afterwards; (c) a flood of YAML syntax errors. (b) and (c) are documented
// in `src/services/events/import-limits.ts` (KNOWN LIMITATION). Pure — client-safe.

/** YAML aliases the parser resolves before it gives up (the `yaml` package counts them against the size of what they expand to). */
export const MAX_ALIAS_COUNT = 100;
/** Deepest object/array nesting accepted, and the deepest a `$ref` expansion may nest. Real schemas stay far below it; later steps recurse once per level. */
export const MAX_NESTING_DEPTH = 256;
/**
 * Longest object key accepted anywhere in the document. Real names are far shorter; every later step handles a key (and every pointer and `$ref`
 * that contains it) again for each use, so a key as long as the file makes the import cost time and memory out of all proportion to its size.
 */
export const MAX_KEY_LENGTH = 1024;
/** Longest `$ref` accepted: a reference to something in the document is a short path; a long one is a crafted path of long keys or of many keys. */
export const MAX_REF_LENGTH = 1024;
/**
 * Most channel x message PAIRS an import may hold: a channel lists its messages, and several channels may refer to one shared channel definition,
 * so the pairs (what the event document stores) can far exceed the number of messages in the file.
 */
export const MAX_CHANNEL_MESSAGE_PAIRS = 500_000;
/** A string is charged to the expansion budget as one value plus one more for every this many characters: a long string is not free to copy. */
export const CHARS_PER_NODE = 64;
/** Most values (objects, arrays, scalars) the document may contain once YAML aliases are expanded: 1 MiB of text holds about half a million. */
export const MAX_DOCUMENT_NODES = 2_000_000;
/** Most values all `$ref` expansions of one import may add up to (shared targets count once per use): 1 MiB of text expands to far less. */
export const MAX_EXPANDED_NODES = 5_000_000;

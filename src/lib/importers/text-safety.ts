/**
 * Text read from a schema file, made storable: the importers hand descriptions to PostgreSQL `text` and `jsonb` columns, which cannot hold
 * a NUL character (a create with one fails for a schema that is otherwise fine), and a lone surrogate (half of a pair, as an escape such
 * as `\ud800` writes it) is not text at all (it cannot be encoded as UTF-8).
 *
 * - every NUL is DROPPED (it has no visible form, and nothing is lost that a reader could see);
 * - every lone surrogate is REPLACED by U+FFFD, the replacement character, so the reader sees that something was there;
 * - a well-formed pair (an emoji) and every other character stay as they are.
 *
 * Pure, linear, idempotent. Applied where an importer's text becomes a field or entity description (the shared mapping step of a create,
 * `import-payload.ts` and the wizard) and where an escape can write one (the BigQuery string literal).
 */
export function sanitizeImportedText(text: string): string {
  return text
    .replace(/\u0000/g, "")
    .replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, "�");
}

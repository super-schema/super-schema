/**
 * `generateTypeSpec()` emits `@tag(...)` decorators that real TypeSpec rejects.
 *
 * - On the model, one per entity tag: `@tag("sales")`.
 * - On a field, for its classification: `@tag("classification:PII")`. The regex-based
 *   Paste-Import round trip (`typespec.importer.ts#extractClassification`) reads that
 *   prefix back, so the generator keeps emitting it.
 *
 * Real TypeSpec's `@tag` only accepts Namespace | Interface | Operation targets, so a
 * real compile fails with `decorator-wrong-target` on both. Every place that hands
 * generated text to the real compiler (the typespec-cli emitters and the publish
 * compile gate) strips them here, at the compile boundary. The stored `typespecSource`
 * and the frozen `resolvedSource` keep the generator's text.
 *
 * The proper fix (enterprise decorators instead of `@tag`) is Story 16.6, scheduled
 * separately.
 *
 * Only a line that is nothing but a `@tag("...")` decorator is removed. The generator
 * emits every decorator on its own line, and `escapeString` turns quotes, backslashes
 * and newlines inside a string into escapes, so a string literal never spans lines and
 * `@tag(` text inside e.g. a `@doc("...")` is never at the start of a line.
 */
const TAG_DECORATOR_LINE = /^[ \t]*@tag\("(?:[^"\\\n]|\\.)*"\)[ \t]*(?:\r?\n|$)/gm;

export function toCompilableTypeSpec(source: string): string {
  return source.replace(TAG_DECORATOR_LINE, "");
}

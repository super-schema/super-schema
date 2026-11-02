/**
 * Field projection of an entity's TypeSpec source vs its field rows — the check behind
 * `scripts/flag-stale-typespec-sources.ts` (pre-R42 entities whose stored source was never
 * marked stale when their fields changed outside the TypeSpec source tab).
 *
 * Parser: the regex `parseTypeSpecDocument`, not the real-compiler `compileTypeSpecDocument`.
 * It is pure and synchronous (no temp-dir compile per entity, runs under tsx), it keeps bare
 * reference names (`address: Address`) where the real compiler's AST path collapses an
 * unresolved reference to `string`, and both sides of the comparison (stored source and the
 * source regenerated from the rows) go through the same parser, so its quirks cancel out.
 */
import { parseTypeSpecDocument, mapTypeSpecType } from "@/lib/compiler/typespec-parser";
import { sanitizeIdentifier } from "@/lib/compiler/typespec-generator";

export interface ProjectedField {
  name: string;
  /** Logical type; arrays carry their element: `array<string>`. */
  type: string;
  /** The default as the source writes it (the text after `=`), when it has one. Only the source projection carries it. */
  defaultText?: string;
  /** The `@example` argument as the source writes it, when it has one. Only the source projection carries it. */
  exampleText?: string;
}

/** Map a type expression to its logical id until it stops changing (the scalar map is not idempotent for every id). */
function normalizeType(type: string): string {
  let current = type.trim();
  for (let i = 0; i < 3; i++) {
    const next = mapTypeSpecType(current).type;
    if (next === current) break;
    current = next;
  }
  return current;
}

function withElement(type: string, element: string | undefined): string {
  return type === "array" && element ? `array<${normalizeType(element)}>` : type;
}

/**
 * Put `{`, `;` and `}` on line boundaries (outside strings, comments and decorator arguments). The regex
 * parser only recognises a model whose header line ends at `{`, so a one-line `model X { id: string; }`
 * would otherwise project to nothing. TypeSpec is whitespace-insensitive there, so this changes no meaning. The one change of text is a line
 * break inside a string or a decorator's argument, which becomes NUL (see copyString): a stored literal that holds one is then never the text the
 * generator writes.
 */
export function expandBlocks(source: string): string {
  let out = "";
  let parens = 0;
  let i = 0;
  const copyUntil = (end: number) => {
    const j = Math.min(end, source.length);
    out += source.slice(i, j);
    i = j;
  };
  // A string's text is copied with each line break in it marked as NUL. TypeSpec reads no line break inside a string, so a stored string that
  // holds one is not a literal the generator writes (it escapes every line break); the mark keeps such a literal from reading as the text the
  // generator writes, and keeps its line from splitting the field or decorator it sits in.
  const copyString = (end: number) => {
    const j = Math.min(end, source.length);
    out += source.slice(i, j).replace(/\n/g, "\u0000");
    i = j;
  };
  while (i < source.length) {
    const c = source[i];
    if (source.startsWith('"""', i)) {
      const end = source.indexOf('"""', i + 3);
      copyString(end < 0 ? source.length : end + 3);
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < source.length && source[j] !== '"') j += source[j] === "\\" ? 2 : 1;
      copyString(j + 1);
      continue;
    }
    if (source.startsWith("//", i)) {
      const end = source.indexOf("\n", i);
      copyUntil(end < 0 ? source.length : end);
      continue;
    }
    if (source.startsWith("/*", i)) {
      const end = source.indexOf("*/", i + 2);
      copyUntil(end < 0 ? source.length : end + 2);
      continue;
    }
    if (c === "(") parens++;
    else if (c === ")") parens = Math.max(0, parens - 1);
    if (parens === 0 && (c === "{" || c === ";")) out += `${c}\n`;
    else if (parens === 0 && c === "}") out += "\n}";
    // A line break inside a decorator's argument is marked too (see copyString): the generator writes each argument on one line, so a legacy
    // raw text that spans lines is not its text.
    else out += c === "\n" && parens > 0 ? "\u0000" : c;
    i++;
  }
  return out;
}

/** The entity's model fields in `source`: the model named like the entity, else the first model; [] when none. */
export function projectSourceFields(source: string, modelName: string): ProjectedField[] {
  const { models } = parseTypeSpecDocument(expandBlocks(source));
  const model =
    models.find((m) => m.name === modelName) ??
    models.find((m) => m.name === sanitizeIdentifier(modelName)) ??
    models[0];
  if (!model) return [];
  return model.fields.map((f) => ({
    name: f.name,
    type: withElement(normalizeType(f.type), f.arrayElementType),
    ...(f.defaultValue !== undefined ? { defaultText: f.defaultValue } : {}),
    ...(f.decorators.example !== undefined ? { exampleText: f.decorators.example } : {}),
  }));
}

/** The field rows in the same space: normalized logical type, array element from `decorators.arrayElementType`. */
export function projectRowFields(rows: Array<{ name: string; type: string; decorators: unknown }>): ProjectedField[] {
  return rows.map((row) => {
    const decorators =
      row.decorators !== null && typeof row.decorators === "object" ? (row.decorators as Record<string, unknown>) : {};
    const element = typeof decorators.arrayElementType === "string" ? decorators.arrayElementType : undefined;
    return { name: row.name, type: withElement(normalizeType(row.type), element) };
  });
}

/**
 * Whether the stored source disagrees with the field rows on field names or types. A field agrees when its
 * stored type equals what either writer of `typespecSource` would have produced for the row: the TypeSpec
 * source save (row type = projected type) or the generator (stored = `regenerated`, the source generated
 * from the current rows — the generator is lossy, e.g. an enum-name row type renders as `string`).
 */
export function compareSourceProjection(
  stored: ProjectedField[],
  rows: ProjectedField[],
  regenerated: ProjectedField[]
): { differs: boolean; reasons: string[] } {
  const storedByName = new Map(stored.map((f) => [f.name, f.type]));
  const rowByName = new Map(rows.map((f) => [f.name, f.type]));
  const regenByName = new Map(regenerated.map((f) => [f.name, f.type]));
  const reasons: string[] = [];

  for (const name of [...rowByName.keys()].sort()) {
    if (!storedByName.has(name)) reasons.push(`field "${name}" missing from source`);
  }
  for (const name of [...storedByName.keys()].sort()) {
    if (!rowByName.has(name)) reasons.push(`field "${name}" only in source`);
  }
  for (const [name, rowType] of [...rowByName.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const storedType = storedByName.get(name);
    if (storedType === undefined) continue;
    if (storedType === rowType || storedType === regenByName.get(name)) continue;
    reasons.push(`field "${name}" type: source ${storedType}, fields ${rowType}`);
  }

  return { differs: reasons.length > 0, reasons };
}

/**
 * The defaults and examples the stored source holds that the generator would not write for the same field, as reasons. A stored default or
 * example is kept only as the generator writes it for the field's row value, whatever its kind: a plain literal of another type (`count: int32 =
 * "5"`, `@example("42")` on an int32), a legacy raw text (`@example(Alice)`, `Dr.Smith`), a member of an enum the field does not take
 * (`Ticket_status.ACTIVE` on a string field), and a constructor TypeSpec cannot read all differ from it, so each is flagged. A text the generator
 * writes the same way is kept; the generator's output is what the compile tests prove.
 */
export function compareSourceLiterals(stored: ProjectedField[], regenerated: ProjectedField[]): string[] {
  const regenByName = new Map(regenerated.map((f) => [f.name, f]));
  // A line break marked by the projection (see expandBlocks) is shown as the `\n` it stands for.
  const shown = (text: string | undefined): string => (text ?? "none").replace(/\u0000/g, "\\n");
  const reasons: string[] = [];
  for (const field of stored) {
    const generated = regenByName.get(field.name);
    if (field.defaultText !== undefined && field.defaultText !== generated?.defaultText) {
      reasons.push(`field "${field.name}" default: source ${shown(field.defaultText)}, generated ${shown(generated?.defaultText)}`);
    }
    if (field.exampleText !== undefined && field.exampleText !== generated?.exampleText) {
      reasons.push(`field "${field.name}" example: source ${shown(field.exampleText)}, generated ${shown(generated?.exampleText)}`);
    }
  }
  return reasons;
}

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
 * would otherwise project to nothing. TypeSpec is whitespace-insensitive there, so this changes no meaning.
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
  while (i < source.length) {
    const c = source[i];
    if (source.startsWith('"""', i)) {
      const end = source.indexOf('"""', i + 3);
      copyUntil(end < 0 ? source.length : end + 3);
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < source.length && source[j] !== '"') j += source[j] === "\\" ? 2 : 1;
      copyUntil(j + 1);
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
    else out += c;
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
  return model.fields.map((f) => ({ name: f.name, type: withElement(normalizeType(f.type), f.arrayElementType) }));
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

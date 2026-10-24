/**
 * TypeSpec identifier rules, in ONE place. The generator, the protobuf projection, the Avro projection and the
 * emitter service all have to agree on how a name is spelled in generated source — when they used their own copies
 * of these rules (final review F5, C1) a protobuf field the generator wrote one way was looked up another way and the
 * whole message silently disappeared.
 *
 * Three different questions, three different rules (measured against the installed @typespec/compiler):
 *
 * - a model / enum / scalar / namespace NAME: every keyword fails bare (the 27 hard ones AND the reserved-for-future
 *   ones, `record`, `metadata`, `internal` …) → {@link sanitizeIdentifier} prefixes them with `_`;
 * - a model PROPERTY or enum MEMBER: only the 27 hard keywords fail bare; the reserved-for-future words and `extern` /
 *   `internal` compile as they are → {@link propertyName} / {@link enumMemberName} quote only the hard ones, so an
 *   ordinary name is emitted exactly as it always was;
 * - the field segment of the composite `<Entity>_<field>` inline enum type name: the historical 15-word list
 *   ({@link sanitizeIdentifierSegment}) so published type names (`Ticket_context`, `$id: Ticket_context.json`) never change.
 *
 * Pure functions, no I/O.
 */

/**
 * The 27 keywords that cannot be a bare property name or enum member (`model A { op: string }` fails to parse). A test
 * checks this list against the real compiler in both directions.
 */
export const TYPESPEC_HARD_KEYWORDS: ReadonlySet<string> = new Set([
  "import", "model", "scalar", "namespace", "interface", "union", "if", "else", "projection", "using", "op",
  "extends", "is", "enum", "alias", "dec", "fn", "valueof", "typeof", "const", "init", "true", "false", "return",
  "void", "never", "unknown",
]);

/**
 * Words the scanner reserves for future use, plus the `extern` / `internal` modifiers. They are fine as property names
 * and enum members but not as the name of a model, enum, scalar or namespace.
 */
export const TYPESPEC_RESERVED_FUTURE_WORDS: ReadonlySet<string> = new Set([
  "extern", "internal", "statemachine", "macro", "package", "metadata", "env", "arg", "declare", "array", "struct",
  "record", "module", "mod", "sym", "context", "prop", "property", "scenario", "pub", "sub", "typeref", "trait",
  "this", "self", "super", "keyof", "with", "implements", "impl", "satisfies", "flag", "auto", "partial", "private",
  "public", "protected", "sealed", "local", "async",
]);

/** Every word of the scanner's `Keywords` table (a test enumerates the installed compiler's own table). */
export const TYPESPEC_KEYWORDS: ReadonlySet<string> = new Set([...TYPESPEC_HARD_KEYWORDS, ...TYPESPEC_RESERVED_FUTURE_WORDS]);

/** The keywords the generator escaped before wire names were preserved — kept for the composite enum type name only. */
const LEGACY_SEGMENT_WORDS: ReadonlySet<string> = new Set([
  "model", "enum", "interface", "namespace", "op", "union", "alias", "scalar", "dec", "fn", "extern", "is", "extends",
  "using", "import",
]);

/**
 * The built-in types a TypeSpec source names without declaring them: the std scalars, and the `Record` / `Array` models. A model, enum,
 * scalar or union DECLARED with one of these names takes the name over inside its scope (a global `model string {}` makes every `string`
 * of the document that model), so a field typed with the built-in is silently read as that model, or the other way round. A test checks
 * this list against the installed compiler's own `TypeSpec` namespace.
 */
export const TYPESPEC_STD_TYPE_NAMES: ReadonlySet<string> = new Set([
  "string", "boolean", "bytes", "numeric", "integer", "float", "decimal", "decimal128",
  "int8", "int16", "int32", "int64", "safeint", "uint8", "uint16", "uint32", "uint64", "float32", "float64",
  "plainDate", "plainTime", "utcDateTime", "offsetDateTime", "duration", "url", "unixTimestamp32",
  "Record", "Array",
]);

/** An ASCII identifier that is valid as-is in TypeSpec (and in a `.proto` field name). */
export const BARE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** A bare property name / enum member: word characters, not starting with a digit, not one of the 27 hard keywords. */
export function isPlainIdentifier(name: string): boolean {
  return BARE_IDENTIFIER.test(name) && !TYPESPEC_HARD_KEYWORDS.has(name);
}

function replaceInvalidCharacters(name: string): string {
  const safe = name.replace(/[^a-zA-Z0-9_]/g, "_");
  return /^[0-9]/.test(safe) ? `_${safe}` : safe;
}

/** A model / enum / scalar / union / interface / namespace NAME: invalid characters become `_`, any keyword gets a `_` prefix. */
export function sanitizeIdentifier(name: string): string {
  const safe = replaceInvalidCharacters(name);
  return TYPESPEC_KEYWORDS.has(safe) ? `_${safe}` : safe;
}

/** The field half of `<Entity>_<field>` (see the module note): the historical 15-word list, nothing more. */
export function sanitizeIdentifierSegment(name: string): string {
  const safe = replaceInvalidCharacters(name);
  return LEGACY_SEGMENT_WORDS.has(safe) ? `_${safe}` : safe;
}

/**
 * A model property name that keeps the WIRE name: bare when it can be (every reserved-for-future word is), otherwise a
 * backticked identifier (`` `in-progress` ``, `` `op` ``, `` `日本語` ``). Never mangled — the generated contract must
 * describe the property the producer actually sends, and two distinct names can never collapse into one.
 */
export function propertyName(name: string): string {
  return isPlainIdentifier(name) ? name : quoteIdentifier(name);
}

/** An enum member name that keeps the wire symbol: bare when it can be, else the quoted `"…"` form. */
export function enumMemberName(name: string): string {
  return isPlainIdentifier(name) ? name : `"${escapeString(name)}"`;
}

/** A backticked TypeSpec identifier. Backslash, backtick and line breaks are escaped; any other character is literal. */
export function quoteIdentifier(name: string): string {
  const escaped = name
    .replace(/\\/g, "\\\\")
    .replace(/`/g, "\\`")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
  return `\`${escaped}\``;
}

/**
 * Escape text for a TypeSpec `"…"` string. `${` opens a string template (`"Price in ${currency}"` is an
 * unresolved reference), so its `$` is escaped; a lone `$` is left alone.
 */
export function escapeString(str: string): string {
  return str
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t")
    .replace(/\$\{/g, "\\${");
}

/** The inverse of {@link escapeString} / {@link quoteIdentifier} for the escapes TypeSpec defines; unknown escapes stay as written. */
export function unescapeTypeSpecText(text: string): string {
  return text.replace(/\\(.)/g, (whole, ch: string) => {
    switch (ch) {
      case "n":
        return "\n";
      case "r":
        return "\r";
      case "t":
        return "\t";
      case '"':
      case "\\":
      case "$":
      case "@":
      case "`":
        return ch;
      default:
        return whole;
    }
  });
}

/**
 * The name a `.proto` field gets for a model property named `name`: the name itself when it is already a valid
 * identifier (keywords included — protobuf has no problem with a field called `op`, and the wire carries the number),
 * otherwise `_`-replaced. The protobuf projection rewrites the source with it and the `@field(n)` injection finds the
 * property by it, so both MUST use this function.
 */
export function protobufFieldName(name: string): string {
  return BARE_IDENTIFIER.test(name) ? name : replaceInvalidCharacters(name);
}

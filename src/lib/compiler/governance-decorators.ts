/**
 * Governance overlay of the canonical TypeSpec source (Story 16.6): field classification and entity tags.
 *
 * Real TypeSpec allows `@tag` only on Namespace | Interface | Operation, so the generator no longer emits
 * `@tag("<tag>")` on the model or `@tag("classification:<LEVEL>")` on properties. Instead:
 *
 * - Classification → `@Enterprise.dataClassification(Enterprise.DataClassification.<Member>)` from the
 *   governance package `@superschema/typespec-enterprise` (vendor/typespec-enterprise/lib/main.tsp). Its
 *   argument is an enum, while the app's levels are free strings (system PII / SENSITIVE / INTERNAL / PUBLIC,
 *   the picker's NEVER_STORED, plus admin-defined ClassificationLevel rows). So one explicit, bijective map
 *   pairs each app level with a member; a level outside it (admin-defined, or a name such as CONFIDENTIAL
 *   whose member SENSITIVE already owns) is carried losslessly as `x-classification`.
 * - Entity tags → one `@TypeSpec.OpenAPI.extension("x-tags", #["a", "b"])` on the model. The governance
 *   package has no tags decorator; `TypeSpec.OpenAPI.extension` targets `unknown` (so a model is valid), and
 *   `@typespec/openapi` is the required peer of the declared `@typespec/openapi3`, so it resolves at every
 *   compile site (the project's node_modules).
 *
 * Every decorator is fully qualified, so the source needs only the `import` lines (no `using`) and cannot
 * become ambiguous with another library's `@extension` (e.g. TypeSpec.JsonSchema.extension).
 *
 * Pure — no I/O; safe in client bundles (the regex parser runs in the browser).
 */

export const ENTERPRISE_LIBRARY_IMPORT = 'import "@superschema/typespec-enterprise";';
export const OPENAPI_LIBRARY_IMPORT = 'import "@typespec/openapi";';

export type GovernanceLibrary = "enterprise" | "openapi";

export const LIBRARY_IMPORTS: Record<GovernanceLibrary, string> = {
  enterprise: ENTERPRISE_LIBRARY_IMPORT,
  openapi: OPENAPI_LIBRARY_IMPORT,
};

/**
 * The library's top-level namespace. A document that declares, references or namespaces a name `Enterprise`
 * shadows it: at global scope the declaration is a duplicate-symbol with the imported `namespace Enterprise`;
 * inside a namespace, `Enterprise.dataClassification` resolves to the document's own symbol. Such a document
 * carries every classification as `x-classification` instead (lossless) and does not import the library.
 */
export const ENTERPRISE_NAMESPACE = "Enterprise";

export const CLASSIFICATION_EXTENSION_KEY = "x-classification";
export const TAGS_EXTENSION_KEY = "x-tags";
/**
 * The reference version pin (multi-entity emission). A pin is SuperSchema-level metadata - which published version of a
 * referenced entity a field resolves to - so it belongs to this family and is NEVER emitted into a target schema: it is
 * written only with the governance overlay (the canonical stored source) and absent from every emission projection
 * (`governance: false`), exactly like `x-classification` / `x-tags`.
 *
 * Why an `extension` key and not a bare `@superSchemaPin("1.2")` decorator: an undeclared decorator is a compile error
 * ("Unknown decorator") in the canonical source, which is compiled as is (Source tab, publish gate), and declaring one
 * would need a JS implementation in the enterprise package. `@TypeSpec.OpenAPI.extension` targets `unknown`, is already
 * imported wherever the overlay is, and the parsers already consume this family. Written:
 * `@TypeSpec.OpenAPI.extension("x-super-schema-pin", "1.2")` on the reference property (scalar, array or map of references).
 *
 * The key is reserved ONLY on a reference-typed field: the parsers hand a string value back as `referencedEntityVersion`,
 * and the sync (`merge-fields.ts`) keeps it as the pin when the field is a reference, otherwise returns it to the ordinary
 * extensions. So a vendor extension that happens to use this key on any other field (or on a model) survives untouched.
 */
export const PIN_EXTENSION_KEY = "x-super-schema-pin";

/** Members of `enum Enterprise.DataClassification`. */
type EnterpriseDataClassification = "Public" | "Internal" | "PII" | "FINANCIAL" | "Confidential" | "Restricted";

/** App level → Enterprise member. Bijective: every member appears once, so the reverse map is exact. */
const APP_TO_ENTERPRISE: Readonly<Record<string, EnterpriseDataClassification>> = {
  PUBLIC: "Public",
  INTERNAL: "Internal",
  PII: "PII",
  SENSITIVE: "Confidential", // "Class 3 — Sensitive"
  NEVER_STORED: "Restricted", // "Class 1 — Never Stored", the most restrictive class
  FINANCIAL: "FINANCIAL",
};

const ENTERPRISE_TO_APP: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(APP_TO_ENTERPRISE).map(([level, member]) => [member, level])
);

const LEGACY_CLASSIFICATION_TAG = /^classification:(.+)$/;

/** Escape a value for a TypeSpec double-quoted string literal (matches the generator's escaping). */
export function escapeTypeSpecString(str: string): string {
  return str
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t")
    .replace(/\$\{/g, "\\${"); // `${` opens a string template
}

/** Reverse of {@link escapeTypeSpecString}. */
export function unescapeTypeSpecString(str: string): string {
  return str.replace(/\\(.)/g, (_, ch: string) => (ch === "n" ? "\n" : ch === "r" ? "\r" : ch === "t" ? "\t" : ch));
}

/**
 * The decorator line for a field's classification, and the library it needs. `enterpriseShadowed`: the
 * document uses the name `Enterprise` itself ({@link ENTERPRISE_NAMESPACE}), so the extension carries it.
 */
export function classificationDecorator(
  level: string,
  enterpriseShadowed = false
): { line: string; library: GovernanceLibrary } {
  const member =
    !enterpriseShadowed && Object.prototype.hasOwnProperty.call(APP_TO_ENTERPRISE, level)
      ? APP_TO_ENTERPRISE[level]
      : undefined;
  if (member) {
    return { line: `@Enterprise.dataClassification(Enterprise.DataClassification.${member})`, library: "enterprise" };
  }
  return {
    line: `@TypeSpec.OpenAPI.extension("${CLASSIFICATION_EXTENSION_KEY}", "${escapeTypeSpecString(level)}")`,
    library: "openapi",
  };
}

const DECLARATION = /\b(?:model|enum|scalar|union|interface|alias|namespace)\s+([\w.]+)/g;
const BARE_ENTERPRISE = /(?<![\w.@])Enterprise(?![\w.])/;

/**
 * Text counterpart of the generator's rule (see {@link ENTERPRISE_NAMESPACE}), for a stored source: it
 * declares a type or namespace segment named `Enterprise`, or uses the bare name `Enterprise` (a reference
 * the publish gate would stub). Qualified uses of the library (`Enterprise.DataClassification.PII`) do not
 * count. String literals and comments are ignored.
 */
export function sourceShadowsEnterprise(source: string): boolean {
  const code = source
    .replace(/"""[\s\S]*?"""/g, '""')
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/.*$/gm, "");
  for (const [, name] of code.matchAll(DECLARATION)) {
    if (name.split(".").includes(ENTERPRISE_NAMESPACE)) return true;
  }
  return BARE_ENTERPRISE.test(code);
}

/** The model decorator line carrying the entity's tags. */
export function tagsDecorator(tags: string[]): string {
  const values = tags.map((t) => `"${escapeTypeSpecString(t)}"`).join(", ");
  return `@TypeSpec.OpenAPI.extension("${TAGS_EXTENSION_KEY}", #[${values}])`;
}

/** The property decorator line carrying a reference's version pin (see {@link PIN_EXTENSION_KEY}). */
export function pinDecorator(version: string): string {
  return `@TypeSpec.OpenAPI.extension("${PIN_EXTENSION_KEY}", "${escapeTypeSpecString(version)}")`;
}

const TYPESPEC_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Every keyword and reserved / future keyword of the TypeSpec scanner (`Keywords` + `ReservedKeywords`), plus `null`.
 * The compiler does not export its list publicly (and importing it would pull the whole compiler into client code),
 * so it is mirrored here; a contract test reads the installed scanner and fails if this set misses a word.
 * A bare object key spelled like one of these does not parse, so it is backtick-quoted.
 */
export const TYPESPEC_RESERVED_WORDS: ReadonlySet<string> = new Set([
  "import", "model", "scalar", "namespace", "interface", "union", "if", "else", "projection", "using", "op",
  "extends", "is", "enum", "alias", "dec", "fn", "valueof", "typeof", "const", "init", "true", "false", "return",
  "void", "never", "unknown", "extern", "internal", "statemachine", "macro", "package", "metadata", "env", "arg",
  "declare", "array", "struct", "record", "module", "mod", "sym", "context", "prop", "property", "scenario", "pub",
  "sub", "typeref", "trait", "this", "self", "super", "keyof", "with", "implements", "impl", "satisfies", "flag",
  "auto", "partial", "private", "public", "protected", "sealed", "local", "async", "null",
]);

/** Control characters a backtick identifier cannot carry safely (CR / LF / tab are escaped instead). */
const UNSAFE_KEY_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u2028\u2029]/;

/** Object key as it is written in a literal: bare identifier, else backtick-quoted with `\`, backtick, LF, CR, tab escaped. */
function renderKey(key: string): string {
  if (TYPESPEC_IDENTIFIER.test(key) && !TYPESPEC_RESERVED_WORDS.has(key)) return key;
  const escaped = key
    .replace(/\\/g, "\\\\")
    .replace(/`/g, "\\`")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
  return `\`${escaped}\``;
}

/**
 * A JSON value as a TypeSpec value literal: string `"..."`, array `#[a, b]` (same convention as
 * {@link tagsDecorator}), plain object `#{key: value}` (keys that are not identifiers are backtick-quoted),
 * number / boolean bare, `null` as `null`. Nested values recurse. Anything else (undefined, functions)
 * renders as `null`; an `undefined` object member is omitted.
 */
export function typeSpecValueLiteral(value: unknown): string {
  return tryTypeSpecValueLiteral(value) ?? "null";
}

/**
 * {@link typeSpecValueLiteral} that returns `undefined` when the value nests deeper than
 * {@link MAX_LITERAL_DEPTH} (counted like the reader: a scalar leaf is one level), so callers can omit it.
 */
export function tryTypeSpecValueLiteral(value: unknown): string | undefined {
  try {
    return renderLiteral(value, 1);
  } catch (e) {
    if (e instanceof LiteralSyntaxError) return undefined;
    throw e;
  }
}

function renderLiteral(value: unknown, depth: number): string {
  if (depth > MAX_LITERAL_DEPTH) throw new LiteralSyntaxError("literal nested too deeply");
  if (value === null) return "null";
  if (typeof value === "string") return `"${escapeTypeSpecString(value)}"`;
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "null";
  if (typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `#[${value.map((v) => renderLiteral(v, depth + 1)).join(", ")}]`;
  if (typeof value === "object") {
    const members = Object.entries(value as Record<string, unknown>)
      // A key with other control characters cannot be written safely: that one member is omitted (never invalid TypeSpec).
      .filter(([k, v]) => v !== undefined && !UNSAFE_KEY_CHARS.test(k))
      .map(([k, v]) => `${renderKey(k)}: ${renderLiteral(v, depth + 1)}`);
    return `#{${members.join(", ")}}`;
  }
  return "null";
}

export class LiteralSyntaxError extends Error {}

/** Maximum `#[` / `#{` nesting the reader accepts; deeper input is unparseable, not a stack overflow. */
export const MAX_LITERAL_DEPTH = 64;

/** Set an own data property (a plain `obj[key] = v` on `__proto__` would invoke the prototype setter). */
export function setOwn(obj: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true });
}

/** Recursive-descent reader for the grammar {@link typeSpecValueLiteral} writes. Throws LiteralSyntaxError. */
class LiteralReader {
  pos = 0;
  private depth = 0;
  constructor(private readonly s: string) {}

  ws(): void {
    while (this.pos < this.s.length && /\s/.test(this.s[this.pos])) this.pos++;
  }

  atEnd(): boolean {
    this.ws();
    return this.pos >= this.s.length;
  }

  eat(ch: string): boolean {
    this.ws();
    if (this.s[this.pos] === ch) {
      this.pos++;
      return true;
    }
    return false;
  }

  expect(ch: string): void {
    if (!this.eat(ch)) throw new LiteralSyntaxError(`expected ${ch} at ${this.pos}`);
  }

  string(): string {
    this.ws();
    if (this.s[this.pos] !== '"') throw new LiteralSyntaxError(`expected string at ${this.pos}`);
    let i = this.pos + 1;
    while (i < this.s.length && this.s[i] !== '"') i += this.s[i] === "\\" ? 2 : 1;
    if (i >= this.s.length) throw new LiteralSyntaxError("unterminated string");
    const raw = this.s.slice(this.pos + 1, i);
    this.pos = i + 1;
    return unescapeTypeSpecString(raw);
  }

  private key(): string {
    this.ws();
    const c = this.s[this.pos];
    if (c === '"') return this.string();
    if (c === "`") {
      let end = this.pos + 1;
      while (end < this.s.length && this.s[end] !== "`") end += this.s[end] === "\\" ? 2 : 1;
      if (end >= this.s.length) throw new LiteralSyntaxError("unterminated key");
      const k = unescapeTypeSpecString(this.s.slice(this.pos + 1, end));
      this.pos = end + 1;
      return k;
    }
    const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(this.s.slice(this.pos));
    if (!m) throw new LiteralSyntaxError(`expected key at ${this.pos}`);
    this.pos += m[0].length;
    return m[0];
  }

  value(): unknown {
    if (++this.depth > MAX_LITERAL_DEPTH) throw new LiteralSyntaxError("literal nested too deeply");
    try {
      return this.valueInner();
    } finally {
      this.depth--;
    }
  }

  private valueInner(): unknown {
    this.ws();
    const c = this.s[this.pos];
    if (c === '"') return this.string();
    if (c === "#") {
      const open = this.s[this.pos + 1];
      if (open === "[") {
        this.pos += 2;
        const out: unknown[] = [];
        while (!this.eat("]")) {
          out.push(this.value());
          if (!this.eat(",")) {
            this.expect("]");
            break;
          }
        }
        return out;
      }
      if (open === "{") {
        this.pos += 2;
        const out: Record<string, unknown> = {};
        while (!this.eat("}")) {
          const k = this.key();
          this.expect(":");
          setOwn(out, k, this.value());
          if (!this.eat(",")) {
            this.expect("}");
            break;
          }
        }
        return out;
      }
      throw new LiteralSyntaxError(`unexpected # at ${this.pos}`);
    }
    const rest = this.s.slice(this.pos);
    const word = /^(?:true|false|null)(?![\w])/.exec(rest);
    if (word) {
      this.pos += word[0].length;
      return word[0] === "null" ? null : word[0] === "true";
    }
    const num = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(rest);
    if (num) {
      this.pos += num[0].length;
      return Number(num[0]);
    }
    throw new LiteralSyntaxError(`unexpected token at ${this.pos}`);
  }
}

/** Strict inverse of {@link typeSpecValueLiteral}: `{ok:false}` when `raw` is not exactly one literal. */
export function tryParseTypeSpecValueLiteral(raw: string): { ok: true; value: unknown } | { ok: false } {
  try {
    const r = new LiteralReader(raw);
    const value = r.value();
    return r.atEnd() ? { ok: true, value } : { ok: false };
  } catch (e) {
    if (e instanceof LiteralSyntaxError) return { ok: false };
    throw e;
  }
}

/** Inverse of {@link typeSpecValueLiteral}. Text that is not a valid literal comes back as the trimmed raw string. */
export function parseTypeSpecValueLiteral(raw: string): unknown {
  const r = tryParseTypeSpecValueLiteral(raw);
  return r.ok ? r.value : raw.trim();
}

/**
 * The inside of `@...extension(<key>, <value>)` → `{key, value}`. Splits at the first top-level comma by
 * reading the key as a string literal and the value as a full literal (so commas, parens and quotes inside
 * the value are safe). Undefined for anything that is not exactly `"key", literal` (e.g. a partial line).
 */
export function parseExtensionArguments(inner: string): { key: string; value: unknown } | undefined {
  try {
    const r = new LiteralReader(inner);
    const key = r.string();
    r.expect(",");
    const value = r.value();
    return r.atEnd() ? { key, value } : undefined;
  } catch (e) {
    if (e instanceof LiteralSyntaxError) return undefined;
    throw e;
  }
}

/** Keys with their own dedicated decorator path; never emitted as generic extensions. */
const RESERVED_EXTENSION_KEYS: readonly string[] = [TAGS_EXTENSION_KEY, CLASSIFICATION_EXTENSION_KEY];

/** Extensions that pass through generically (everything but the keys with their own path). */
export function genericExtensionEntries(extensions: Record<string, unknown> | undefined): [string, unknown][] {
  if (!extensions || typeof extensions !== "object") return [];
  return Object.entries(extensions).filter(([k, v]) => v !== undefined && !RESERVED_EXTENSION_KEYS.includes(k));
}

/**
 * Decorator lines for generic vendor extensions: per key one `@TypeSpec.JsonSchema.extension` and one
 * `@TypeSpec.OpenAPI.extension` (fully qualified, never a bare `@extension`), so both official emitters
 * re-emit it. Skips `x-tags` / `x-classification` and any key in `exclude`.
 */
export function genericExtensionDecorators(
  extensions: Record<string, unknown> | undefined,
  exclude: readonly string[] = []
): string[] {
  const lines: string[] = [];
  for (const [key, value] of genericExtensionEntries(extensions)) {
    if (exclude.includes(key)) continue;
    const literal = tryTypeSpecValueLiteral(value);
    if (literal === undefined) continue; // nested past MAX_LITERAL_DEPTH: omit the key rather than truncate
    const args = `"${escapeTypeSpecString(key)}", ${literal}`;
    lines.push(`@TypeSpec.JsonSchema.extension(${args})`, `@TypeSpec.OpenAPI.extension(${args})`);
  }
  return lines;
}

export const JSON_SCHEMA_LIBRARY_IMPORT = 'import "@typespec/json-schema";';

/**
 * Enterprise member → app level. Accepts the bare member (`PII`, what the governance accessor returns) or a
 * reference to it (`DataClassification.PII`, `Enterprise.DataClassification.PII`).
 */
export function classificationFromEnterpriseMember(ref: string | undefined): string | undefined {
  if (!ref) return undefined;
  const member = ref.split(".").pop() ?? "";
  return Object.prototype.hasOwnProperty.call(ENTERPRISE_TO_APP, member) ? ENTERPRISE_TO_APP[member] : undefined;
}

/** Legacy `@tag("classification:<LEVEL>")` argument → level (sources stored before Story 16.6). */
export function classificationFromLegacyTag(tag: string | undefined): string | undefined {
  return tag?.match(LEGACY_CLASSIFICATION_TAG)?.[1];
}

/** Classification from parsed decorators: the new decorators first, then the legacy `@tag` form. */
export function classificationFromDecorators(decorators: { classification?: unknown; tag?: unknown }): string | undefined {
  if (typeof decorators.classification === "string" && decorators.classification) return decorators.classification;
  return classificationFromLegacyTag(typeof decorators.tag === "string" ? decorators.tag : undefined);
}

/** `#["a", "b"]` (a TypeSpec value tuple of string literals) → `["a", "b"]`; undefined if it is not one. */
export function parseStringTuple(text: string): string[] | undefined {
  const m = text.trim().match(/^#\[\s*((?:"(?:[^"\\]|\\.)*"\s*,?\s*)*)\]$/);
  if (!m) return undefined;
  return [...m[1].matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((s) => unescapeTypeSpecString(s[1]));
}

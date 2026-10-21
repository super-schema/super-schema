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

const TYPESPEC_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * A JSON value as a TypeSpec value literal: string `"..."`, array `#[a, b]` (same convention as
 * {@link tagsDecorator}), plain object `#{key: value}` (keys that are not identifiers are backtick-quoted),
 * number / boolean bare, `null` as `null`. Nested values recurse. Anything else (undefined, functions)
 * renders as `null`; an `undefined` object member is omitted.
 */
export function typeSpecValueLiteral(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return `"${escapeTypeSpecString(value)}"`;
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "null";
  if (typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `#[${value.map(typeSpecValueLiteral).join(", ")}]`;
  if (typeof value === "object") {
    const members = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${TYPESPEC_IDENTIFIER.test(k) ? k : `\`${k}\``}: ${typeSpecValueLiteral(v)}`);
    return `#{${members.join(", ")}}`;
  }
  return "null";
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
    const args = `"${escapeTypeSpecString(key)}", ${typeSpecValueLiteral(value)}`;
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

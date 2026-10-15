import { ok, err, type Result } from "@/types/result";

export type StatementKind = "import" | "using" | "namespace" | "declaration" | "other";
export interface TypeSpecStatement {
  kind: StatementKind;
  /** Raw text incl. leading comments / decorators (imports and usings: just the statement). */
  text: string;
  keyword?: string;
  name?: string;
}
export interface SourcePart {
  label: string;
  source: string;
}
export interface CombinedSource {
  imports: string[];
  usings: string[];
  body: string;
  warnings: string[];
}

const DECLARATION_HEAD = /^(?:(?:extern|internal)\s+)*(model|enum|scalar|union|alias|op|interface)\s+([A-Za-z_][A-Za-z0-9_]*)/;
const parseError = (message: string) => err({ code: "TYPESPEC_PARSE_ERROR", message });

/** Index just past a string literal at `i` ("…" or """…"""), or -1 when unterminated. */
function skipString(src: string, i: number): number {
  if (src.startsWith('"""', i)) {
    const end = src.indexOf('"""', i + 3);
    return end < 0 ? -1 : end + 3;
  }
  let j = i + 1;
  while (j < src.length && src[j] !== '"') {
    if (src[j] === "\n") return -1;
    j += src[j] === "\\" ? 2 : 1;
  }
  return j < src.length ? j + 1 : -1;
}

/** A depth-0 `}` ends a statement only if the rest of its line is blank, `;` or a comment (so `Array<{…}>;` does not split). */
function blockStatementEnd(src: string, i: number): number {
  let j = i + 1;
  while (j < src.length && (src[j] === " " || src[j] === "\t")) j++;
  if (src[j] === ";") return j + 1;
  if (j >= src.length || src[j] === "\n" || src[j] === "\r" || src.startsWith("//", j) || src.startsWith("/*", j)) return i + 1;
  return -1;
}

/** Code with string contents and comments blanked, so decorator arguments and docs cannot fake keywords. */
function codeOnly(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"') {
      const end = skipString(text, i);
      out += '""';
      i = end < 0 ? text.length : end;
    } else if (c === "/" && text[i + 1] === "/") {
      const nl = text.indexOf("\n", i);
      out += " ";
      i = nl < 0 ? text.length : nl;
    } else if (c === "/" && text[i + 1] === "*") {
      const close = text.indexOf("*/", i + 2);
      out += " ";
      i = close < 0 ? text.length : close + 2;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

function stripLeadingDecorators(code: string): string {
  let s = code.trimStart();
  while (s.startsWith("@")) {
    const name = /^@[A-Za-z_][\w.]*/.exec(s);
    if (!name) break;
    let j = name[0].length;
    if (s[j] === "(") {
      let depth = 0;
      for (; j < s.length; j++) {
        if (s[j] === "(") depth++;
        else if (s[j] === ")" && --depth === 0) {
          j++;
          break;
        }
      }
    }
    s = s.slice(j).trimStart();
  }
  return s;
}

function classify(text: string): TypeSpecStatement {
  const head = stripLeadingDecorators(codeOnly(text)).trim();
  if (/^import\s/.test(head)) return { kind: "import", text: (/import\s+"[^"]*"\s*;/.exec(text)?.[0] ?? text).trim() };
  if (/^using\s/.test(head)) return { kind: "using", text: (/using\s+[^;]+;/.exec(text)?.[0] ?? text).trim() };
  if (/^namespace\s+[\w.`]+\s*;$/.test(head)) return { kind: "namespace", text };
  const m = DECLARATION_HEAD.exec(head);
  if (m) return { kind: "declaration", text, keyword: m[1], name: m[2] };
  return { kind: "other", text };
}

export function splitTypeSpecStatements(source: string): Result<TypeSpecStatement[]> {
  const out: TypeSpecStatement[] = [];
  let depth = 0;
  let start = 0;
  let i = 0;
  const push = (end: number) => {
    const text = source.slice(start, end).trim();
    if (text) out.push(classify(text));
    start = end;
  };
  while (i < source.length) {
    const c = source[i];
    if (c === '"') {
      const end = skipString(source, i);
      if (end < 0) return parseError("Unterminated string literal");
      i = end;
      continue;
    }
    if (c === "/" && source[i + 1] === "/") {
      const nl = source.indexOf("\n", i);
      i = nl < 0 ? source.length : nl;
      continue;
    }
    if (c === "/" && source[i + 1] === "*") {
      const close = source.indexOf("*/", i + 2);
      if (close < 0) return parseError("Unterminated block comment");
      i = close + 2;
      continue;
    }
    if (c === "{" || c === "(" || c === "[") depth++;
    else if (c === "}" || c === ")" || c === "]") {
      depth--;
      if (depth < 0) return parseError(`Unbalanced "${c}"`);
      if (depth === 0 && c === "}") {
        const end = blockStatementEnd(source, i);
        if (end >= 0) {
          push(end);
          i = end;
          continue;
        }
      }
    } else if (c === ";" && depth === 0) {
      push(i + 1);
      i += 1;
      continue;
    }
    i++;
  }
  if (depth !== 0) return parseError("Unbalanced braces");
  push(source.length);
  return ok(out);
}

/**
 * D9: one TypeSpec program from several sources (pinned root version first, then its closure).
 * Imports / usings are hoisted and de-duplicated, file-level `namespace X;` statements are dropped
 * (the caller wraps the program in one level-derived namespace), and a declaration name seen twice
 * keeps its first copy — with a warning when the copies differ.
 */
export function combineTypeSpecSources(parts: SourcePart[]): Result<CombinedSource> {
  const imports = new Set<string>();
  const usings = new Set<string>();
  const body: string[] = [];
  const seen = new Map<string, { label: string; normalized: string }>();
  const warnings: string[] = [];

  for (const part of parts) {
    const statements = splitTypeSpecStatements(part.source);
    if (!statements.success) return err({ ...statements.error, message: `${part.label}: ${statements.error.message}` });
    for (const s of statements.data) {
      if (s.kind === "import") imports.add(s.text);
      else if (s.kind === "using") usings.add(s.text);
      else if (s.kind === "namespace") continue;
      else if (s.kind === "declaration" && s.name) {
        const normalized = s.text.replace(/\s+/g, " ").trim();
        const prior = seen.get(s.name);
        if (prior) {
          if (prior.normalized !== normalized) warnings.push(`"${s.name}" from ${part.label} differs from the copy in ${prior.label}; the ${prior.label} copy is used`);
          continue;
        }
        seen.set(s.name, { label: part.label, normalized });
        body.push(s.text.trim());
      } else body.push(s.text.trim());
    }
  }
  return ok({ imports: [...imports], usings: [...usings], body: body.join("\n\n"), warnings });
}

/** The overlay decorators `generateTypeSpec()` emits (governance-decorators.ts): each is fully qualified and alone on its line. */
const GOVERNANCE_DECORATOR_LINE =
  /^[ \t]*@(?:Enterprise\.dataClassification\(.*\)|TypeSpec\.OpenAPI\.extension\("(?:x-tags|x-classification)",.*\))[ \t]*(?:\r?\n|$)/gm;
const ENTERPRISE_IMPORT_LINE = /^[ \t]*import\s+"@superschema\/typespec-enterprise"\s*;[ \t]*(?:\r?\n|$)/gm;
const OPENAPI_IMPORT_LINE = /^[ \t]*import\s+"@typespec\/openapi"\s*;[ \t]*(?:\r?\n|$)/gm;

/**
 * Story 16.6 overlay → render projection. Frozen `resolvedSource` text carries the governance overlay
 * (`@Enterprise.dataClassification(...)`, `@TypeSpec.OpenAPI.extension("x-tags" | "x-classification", ...)` and
 * the imports they need). No payload emitter reads it, and importing `@superschema/typespec-enterprise` makes the
 * JSON Schema emitter (`emitAllModels`) write the library's enums (`DataClassification`, `AvroLogicalType`, …)
 * into the payload's `$defs`. So the renderer compiles the source WITHOUT the overlay — the same explicit
 * projection the Schemas-tab emission path applies via `generateTypeSpec(model, { governance: false })`.
 *
 * Removes the overlay decorator lines, then each library import that nothing else in the source refers to
 * (`Enterprise` / `OpenAPI` identifiers outside strings and comments). A source without overlay lines is
 * returned unchanged. Pure.
 */
export function stripGovernanceOverlay(source: string): string {
  let removed = 0;
  let out = source.replace(GOVERNANCE_DECORATOR_LINE, () => {
    removed++;
    return "";
  });
  if (removed === 0) return source;
  const code = codeOnly(out);
  if (!/\bEnterprise\b/.test(code)) out = out.replace(ENTERPRISE_IMPORT_LINE, "");
  if (!/\bOpenAPI\b/.test(code)) out = out.replace(OPENAPI_IMPORT_LINE, "");
  return out;
}

function pascalSegment(slug: string): string {
  const pascal = slug
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join("");
  return pascal === "" || /^[0-9]/.test(pascal) ? `N${pascal}` : pascal;
}

/** Spec §4.4: `Acme.Payments.Checkout` (tenant-level items: `Acme`). */
export function levelNamespace(slugs: { tenantSlug: string; domainSlug: string | null; productSlug: string | null }): string {
  return [slugs.tenantSlug, slugs.domainSlug, slugs.productSlug]
    .filter((s): s is string => !!s)
    .map(pascalSegment)
    .join(".");
}

export function findRootModelName(source: string, entityName: string): string | null {
  const statements = splitTypeSpecStatements(source);
  if (!statements.success) return null;
  const models = statements.data.filter((s) => s.kind === "declaration" && s.keyword === "model");
  const safe = entityName.replace(/[^A-Za-z0-9_]/g, "_");
  return models.find((s) => s.name === safe || s.name === entityName)?.name ?? models[0]?.name ?? null;
}

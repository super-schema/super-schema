import { ok, err, type Result } from "@/types/result";
import { importNotAllowedError, isAllowedTypeSpecImport, scanTypeSpecImports } from "@/lib/typespec/import-guard";

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
  if (/^import\b/.test(head)) return { kind: "import", text: (/import\s*"[^"]*"\s*;/.exec(text)?.[0] ?? text).trim() };
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

/** Source text with `//` and block comments removed; string literals are kept verbatim. */
function stripComments(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"') {
      const end = skipString(text, i);
      const stop = end < 0 ? text.length : end;
      out += text.slice(i, stop);
      i = stop;
    } else if (c === "/" && text[i + 1] === "/") {
      const nl = text.indexOf("\n", i);
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

const normalizeDeclaration = (text: string): string => stripComments(text).replace(/\s+/g, " ").trim();

/** `text` with each range replaced by spaces (newlines kept), so offsets and line structure are unchanged. */
function blankRanges(text: string, ranges: ReadonlyArray<{ pos: number; end: number }>): string {
  let out = text;
  for (const { pos, end } of ranges) out = out.slice(0, pos) + out.slice(pos, end).replace(/[^\r\n]/g, " ") + out.slice(end);
  return out;
}

/**
 * D9: one TypeSpec program from several sources (pinned root version first, then its closure).
 * - Imports are found by the TypeSpec parser (`@/lib/typespec/import-guard`), never by this file's statement
 *   splitter, so `import"x";` and an import trailing a `}` on the same line are seen like any other. They are
 *   hoisted and de-duplicated, but only `@typespec/*` and `@superschema/typespec-enterprise` specifiers are
 *   allowed (`TYPESPEC_IMPORT_NOT_ALLOWED`: the program is compiled by a real `tsp` process and an import of a
 *   path would run code from the host); usings are hoisted and de-duplicated.
 * - File-level `namespace X;` statements are dropped (the caller wraps the program in one level-derived namespace).
 * - A declaration name seen twice keeps its first copy only when both copies have the same keyword and the same
 *   body (whitespace and comments ignored). Any other duplicate — a different keyword (`model X` vs `enum X`) or a
 *   divergent body (an edited shared enum between two pinned versions) — is `TYPESPEC_DECLARATION_CONFLICT`:
 *   silently picking a copy would render a payload that differs from what one of the pinned versions published.
 */
export function combineTypeSpecSources(parts: SourcePart[]): Result<CombinedSource> {
  const imports = new Set<string>();
  const usings = new Set<string>();
  const body: string[] = [];
  const seen = new Map<string, { label: string; keyword: string | undefined; normalized: string }>();
  const warnings: string[] = [];

  for (const part of parts) {
    const scanned = scanTypeSpecImports(part.source);
    if (!scanned.success) return err({ ...scanned.error, message: `${part.label}: ${scanned.error.message}` });
    const offender = scanned.data.imports.find((i) => !isAllowedTypeSpecImport(i.specifier));
    if (offender) return err(importNotAllowedError(offender.specifier, part.label));
    const hoisted = scanned.data.imports.filter((i) => i.topLevel);
    for (const i of hoisted) imports.add(`import "${i.specifier}";`);
    // The splitter never sees the hoisted statements, so it cannot misplace or misclassify them.
    const statements = splitTypeSpecStatements(blankRanges(scanned.data.text, hoisted));
    if (!statements.success) return err({ ...statements.error, message: `${part.label}: ${statements.error.message}` });
    for (const s of statements.data) {
      if (s.kind === "import") {
        // The parser found no import here yet the splitter reads one: refuse rather than guess which is right.
        return err(importNotAllowedError(s.text, part.label));
      } else if (s.kind === "using") usings.add(s.text);
      else if (s.kind === "namespace") continue;
      else if (s.kind === "declaration" && s.name) {
        const normalized = normalizeDeclaration(s.text);
        const prior = seen.get(s.name);
        if (prior) {
          if (prior.keyword === s.keyword && prior.normalized === normalized) continue;
          const what = prior.keyword !== s.keyword ? `as ${prior.keyword} in ${prior.label} and as ${s.keyword} in ${part.label}` : `differently in ${prior.label} and ${part.label}`;
          return err({
            code: "TYPESPEC_DECLARATION_CONFLICT",
            message: `"${s.name}" is declared ${what}; one schema cannot contain two different declarations of the same name`,
            suggestedFix: "Re-publish the referencing entities so they pin versions that agree on the shared declaration.",
            details: { name: s.name, first: { label: prior.label, keyword: prior.keyword }, second: { label: part.label, keyword: s.keyword } },
          });
        }
        seen.set(s.name, { label: part.label, keyword: s.keyword, normalized });
        body.push(s.text.trim());
      } else body.push(s.text.trim());
    }
  }
  return ok({ imports: [...imports], usings: [...usings], body: body.join("\n\n"), warnings });
}

const ENTERPRISE_IMPORT_LINE = /^[ \t]*import\s+"@superschema\/typespec-enterprise"\s*;[ \t]*(?:\r?\n|$)/gm;
const OPENAPI_IMPORT_LINE = /^[ \t]*import\s+"@typespec\/openapi"\s*;[ \t]*(?:\r?\n|$)/gm;
const OVERLAY_DECORATOR_HEAD = /^[ \t]*@(Enterprise\.dataClassification|TypeSpec\.OpenAPI\.extension)\(/;
const OVERLAY_EXTENSION_KEY = /^\s*"(?:x-tags|x-classification)"\s*,/;

/** Indexes of the lines whose first character sits inside a block comment or a triple-quoted string. */
function linesStartingInsideLiteral(source: string): Set<number> {
  const inside = new Set<number>();
  let line = 0;
  let i = 0;
  const advanceThrough = (end: number) => {
    for (; i < end; i++) {
      if (source[i] === "\n") {
        line++;
        inside.add(line);
      }
    }
  };
  while (i < source.length) {
    const c = source[i];
    if (c === "\n") {
      line++;
      i++;
    } else if (source.startsWith('"""', i)) {
      const close = source.indexOf('"""', i + 3);
      advanceThrough(close < 0 ? source.length : close + 3);
    } else if (c === '"') {
      const end = skipString(source, i);
      i = end < 0 ? source.indexOf("\n", i) : end;
      if (i < 0) i = source.length;
    } else if (c === "/" && source[i + 1] === "/") {
      const nl = source.indexOf("\n", i);
      i = nl < 0 ? source.length : nl;
    } else if (c === "/" && source[i + 1] === "*") {
      const close = source.indexOf("*/", i + 2);
      advanceThrough(close < 0 ? source.length : close + 2);
    } else i++;
  }
  return inside;
}

/**
 * True when `line` is nothing but one overlay decorator: `@Enterprise.dataClassification(...)` or
 * `@TypeSpec.OpenAPI.extension("x-tags" | "x-classification", ...)` with balanced parentheses (string literals
 * skipped) that close at the end of the line. Anything after the closing parenthesis — another decorator, a
 * property, a comment — makes it a mixed line, which is never touched.
 */
function isOverlayDecoratorLine(line: string): boolean {
  const head = OVERLAY_DECORATOR_HEAD.exec(line);
  if (!head) return false;
  const open = head[0].length - 1;
  if (head[1] === "TypeSpec.OpenAPI.extension" && !OVERLAY_EXTENSION_KEY.test(line.slice(open + 1))) return false;
  let depth = 0;
  for (let j = open; j < line.length; j++) {
    const c = line[j];
    if (c === '"') {
      const end = skipString(line, j);
      if (end < 0) return false;
      j = end - 1;
    } else if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return line.slice(j + 1).trim() === "";
  }
  return false;
}

/**
 * Story 16.6 overlay → render projection. Frozen `resolvedSource` text carries the governance overlay
 * (`@Enterprise.dataClassification(...)`, `@TypeSpec.OpenAPI.extension("x-tags" | "x-classification", ...)` and
 * the imports they need). No payload emitter reads it, and importing `@superschema/typespec-enterprise` makes the
 * JSON Schema emitter (`emitAllModels`) write the library's enums (`DataClassification`, `AvroLogicalType`, …)
 * into the payload's `$defs`. So the renderer compiles the source WITHOUT the overlay — the same explicit
 * projection the Schemas-tab emission path applies via `generateTypeSpec(model, { governance: false })`.
 *
 * Only a line that consists solely of an overlay decorator is removed (the generator puts each on its own line);
 * a decorator sharing its line with anything else, and anything inside a string or a block comment, is left alone
 * (the library import then stays, so the line still compiles). Each library import that nothing else in the source
 * refers to (`Enterprise` / `OpenAPI` identifiers outside strings and comments) is then removed. A source without
 * removable overlay lines is returned unchanged. Pure.
 */
export function stripGovernanceOverlay(source: string): string {
  const lines = source.split("\n");
  const insideLiteral = linesStartingInsideLiteral(source);
  let removed = 0;
  const kept = lines.filter((line, index) => {
    if (insideLiteral.has(index) || !isOverlayDecoratorLine(line.replace(/\r$/, ""))) return true;
    removed++;
    return false;
  });
  if (removed === 0) return source;
  let out = kept.join("\n");
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

/**
 * The model the entity's payload is rooted at: the model named after the entity; otherwise the only model of
 * the source. `ok(null)` when the source declares no model; `ROOT_MODEL_NOT_FOUND` when it declares several and
 * none is named after the entity (guessing the first would silently render the wrong payload).
 */
export function findRootModelName(source: string, entityName: string): Result<string | null> {
  const statements = splitTypeSpecStatements(source);
  if (!statements.success) return statements;
  const models = statements.data.filter((s) => s.kind === "declaration" && s.keyword === "model");
  const safe = entityName.replace(/[^A-Za-z0-9_]/g, "_");
  const named = models.find((s) => s.name === safe || s.name === entityName);
  if (named?.name) return ok(named.name);
  if (models.length > 1) {
    return err({
      code: "ROOT_MODEL_NOT_FOUND",
      message: `${entityName}: no model named "${safe}" among ${models.map((m) => m.name).join(", ")}`,
      suggestedFix: `Name the entity's root model "${safe}".`,
      details: { entityName, models: models.map((m) => m.name) },
    });
  }
  return ok(models[0]?.name ?? null);
}

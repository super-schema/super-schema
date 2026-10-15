import "server-only";

import { parse, SyntaxKind, visitChildren, type ImportStatementNode, type Node, type TypeSpecScriptNode } from "@typespec/compiler/ast";
import { ok, err, type Result } from "@/types/result";

/**
 * The ONE import guard for every place that hands TypeSpec text to the TypeSpec compiler (in-process `compile`
 * and the `tsp` CLI).
 *
 * Why it exists: the compiler LOADS what an `import` statement names, and loading a `.js` / `.mjs` file EXECUTES
 * it. Entity sources are user-authored, so an `import "/abs/x.mjs";` (or a relative path, a directory, a URL)
 * inside a source is host code execution for whoever can save a source. Finding C-C1 showed that deciding what is
 * an import with a hand-written scanner is bypassable (`import"/x.mjs";` without a space, an import after a `}`
 * on the same line), so this module asks TypeSpec's OWN parser: the compiler loads exactly the `ImportStatement`
 * nodes that `parse` returns for the file, so the set checked here is the set that would be loaded. Strings,
 * comments, doc comments and decorator arguments that merely contain the word "import" are not import nodes and
 * are never false positives.
 *
 * Allowed: `@typespec/<package>` libraries and the governance library `@superschema/typespec-enterprise`
 * (resolved by package name from `node_modules`, never from a path). Everything else is rejected, including
 * relative and absolute paths, `.tsp` / `.js` / `.mjs` files, directories, URLs and `@typespec/<pkg>/<subpath>`.
 *
 * Pure: no filesystem, no database, no network.
 */

export const TYPESPEC_IMPORT_NOT_ALLOWED = "TYPESPEC_IMPORT_NOT_ALLOWED";
export const TYPESPEC_PARSE_ERROR = "TYPESPEC_PARSE_ERROR";

const ALLOWED_IMPORT = /^(?:@typespec\/[A-Za-z0-9][A-Za-z0-9_-]*|@superschema\/typespec-enterprise)$/;

/** True when `specifier` names an importable library (never a path). */
export function isAllowedTypeSpecImport(specifier: string): boolean {
  return ALLOWED_IMPORT.test(specifier);
}

/** One `import "…";` statement as the TypeSpec parser sees it. */
export interface TypeSpecImport {
  /** The string literal's VALUE (escape sequences resolved by the parser). */
  specifier: string;
  /** Offsets into `ScannedTypeSpecSource.text` covering the whole statement. */
  pos: number;
  end: number;
  /** A direct child of the file (the only position the compiler loads from); anything else is a compile error. */
  topLevel: boolean;
}

export interface ScannedTypeSpecSource {
  /** The source as the compiler will read it back from disk (see `asReadFromDisk`); `imports` offsets index into it. */
  text: string;
  imports: TypeSpecImport[];
  /** Parser diagnostics of severity `error`; the import list is still complete (the parser recovers). */
  parseErrors: number;
}

/**
 * The compiler reads a source back from a file we wrote as UTF-8: lone surrogates become U+FFFD and one leading
 * byte-order mark is dropped (`NodeSystemHost.readFile`). Parsing that exact text keeps the guard and the
 * compiler from ever disagreeing about where a token starts.
 */
function asReadFromDisk(source: string): string {
  const text = Buffer.from(source, "utf8").toString("utf8");
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * Every import statement of `source`, in source order, at any depth. Never throws: a parser failure (for
 * example stack exhaustion on pathological nesting) is `TYPESPEC_PARSE_ERROR` and the caller must treat the
 * source as rejected.
 */
export function scanTypeSpecImports(source: string): Result<ScannedTypeSpecSource> {
  const text = asReadFromDisk(source);
  try {
    const script: TypeSpecScriptNode = parse(text);
    const topLevel = new Set<Node>(script.statements);
    const imports: TypeSpecImport[] = [];
    const visit = (node: Node): void => {
      if (node.kind === SyntaxKind.ImportStatement) {
        imports.push({ specifier: (node as ImportStatementNode).path.value, pos: node.pos, end: node.end, topLevel: topLevel.has(node) });
      }
      // The callback must return nothing: a truthy return stops the walk.
      visitChildren(node, visit);
    };
    visit(script);
    const parseErrors = script.parseDiagnostics.filter((d) => d.severity === "error").length;
    return ok({ text, imports, parseErrors });
  } catch {
    return err({ code: TYPESPEC_PARSE_ERROR, message: "The TypeSpec source could not be parsed" });
  }
}

/** A specifier is user text: printed JSON-escaped (no raw newlines / control characters) and bounded. */
function printSpecifier(specifier: string): string {
  const shown = specifier.length > 120 ? `${specifier.slice(0, 120)}…` : specifier;
  return JSON.stringify(shown).slice(1, -1);
}

export function importNotAllowedError(specifier: string, label?: string) {
  return {
    code: TYPESPEC_IMPORT_NOT_ALLOWED,
    message: `${label ? `${label}: ` : ""}import "${printSpecifier(specifier)}" is not allowed; only @typespec/* libraries and @superschema/typespec-enterprise can be imported`,
    details: { ...(label !== undefined && { label }), specifier },
  };
}

export interface CheckImportsOptions {
  /** Prefixed to the error message and carried in `details` (e.g. the pinned version a source belongs to). */
  label?: string;
  /** Also reject a source the TypeSpec parser reports errors for (default: no; the compiler reports those itself). */
  rejectParseErrors?: boolean;
}

/**
 * Accepts `source` only when every import statement in it is an allowed library import. `ok` carries the scan
 * (so a caller can hoist the imports); an error is `TYPESPEC_IMPORT_NOT_ALLOWED` or `TYPESPEC_PARSE_ERROR`.
 */
export function checkTypeSpecImports(source: string, options: CheckImportsOptions = {}): Result<ScannedTypeSpecSource> {
  const scanned = scanTypeSpecImports(source);
  if (!scanned.success) return options.label ? err({ ...scanned.error, message: `${options.label}: ${scanned.error.message}` }) : scanned;
  const offender = scanned.data.imports.find((i) => !isAllowedTypeSpecImport(i.specifier));
  if (offender) return err(importNotAllowedError(offender.specifier, options.label));
  if (options.rejectParseErrors && scanned.data.parseErrors > 0) {
    return err({ code: TYPESPEC_PARSE_ERROR, message: `${options.label ? `${options.label}: ` : ""}The TypeSpec source has ${scanned.data.parseErrors} syntax error(s)` });
  }
  return scanned;
}

/** Thrown by compile paths that cannot return a Result (`compileSource`); carries the guard's error. */
export class TypeSpecImportGuardError extends Error {
  readonly code: string;
  readonly details?: object;
  constructor(error: { code: string; message: string; details?: object }) {
    super(error.message);
    this.name = "TypeSpecImportGuardError";
    this.code = error.code;
    this.details = error.details;
  }
}

/** `checkTypeSpecImports` for paths that throw: returns the scan, or throws `TypeSpecImportGuardError`. */
export function assertTypeSpecImportsAllowed(source: string, options?: CheckImportsOptions): ScannedTypeSpecSource {
  const checked = checkTypeSpecImports(source, options);
  if (!checked.success) throw new TypeSpecImportGuardError(checked.error);
  return checked.data;
}

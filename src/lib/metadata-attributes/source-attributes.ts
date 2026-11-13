/**
 * Metadata attributes in TypeSpec TEXT (a stored or frozen source, which the event payload renderer compiles as is): strip the extension
 * decorators of given keys, and read the model-level extension values of one model.
 *
 * A real scan, not a line regex: decorators are found only in code (never inside a string, a triple-quoted string, a backticked identifier or a
 * comment), their argument list is closed by bracket depth with the same literal skipping, so a value literal may span lines or hold `)`
 * inside a string. The arguments are read with `parseExtensionArguments` (the importer's literal reader). Pure.
 */

import { parseExtensionArguments } from "@/lib/compiler/governance-decorators";

interface Decorator {
  /** Index of the `@`. */
  start: number;
  /** Index just past the decorator (past `)` when it has arguments). */
  end: number;
  name: string;
  /** The text between the parentheses, when it has them. */
  args?: string;
  /** An augment decorator (`@@name(Target, ...)`, a statement): its `end` includes the closing `;`. */
  augment?: boolean;
}

/** The internal metadata attributes of a source could not be removed safely: the source must not be compiled for a target output. */
export class MetadataStripError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MetadataStripError";
  }
}

/** Index just past the string / backticked identifier / comment that starts at `i`; `i` when none does. -1 when it never closes. */
function skipNonCode(src: string, i: number): number {
  if (src.startsWith('"""', i)) {
    // An escape (`\"`, `\\`) is two characters wherever it sits, so `\"""` does not close the string early.
    for (let j = i + 3; j < src.length; j++) {
      if (src[j] === "\\") j++;
      else if (src.startsWith('"""', j)) return j + 3;
    }
    return -1;
  }
  const c = src[i];
  if (c === '"' || c === "`") {
    for (let j = i + 1; j < src.length; j++) {
      if (src[j] === "\\") j++;
      else if (src[j] === c) return j + 1;
      else if (src[j] === "\n" && c === '"') return -1;
    }
    return -1;
  }
  if (c === "/" && src[i + 1] === "/") {
    const nl = src.indexOf("\n", i);
    return nl < 0 ? src.length : nl;
  }
  if (c === "/" && src[i + 1] === "*") {
    const close = src.indexOf("*/", i + 2);
    return close < 0 ? -1 : close + 2;
  }
  return i;
}

/** Index of the `)` closing the `(` at `open` (strings and comments skipped); -1 when unbalanced. */
function closingParen(src: string, open: number): number {
  let depth = 0;
  for (let i = open; i < src.length; ) {
    const skipped = skipNonCode(src, i);
    if (skipped < 0) return -1;
    if (skipped !== i) {
      i = skipped;
      continue;
    }
    if (src[i] === "(") depth++;
    else if (src[i] === ")" && --depth === 0) return i;
    i++;
  }
  return -1;
}

const DECORATOR_NAME = /@[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*/y;

/** Every decorator in code, in source order, augment decorators included. `undefined` when the text cannot be scanned. */
function scanDecorators(src: string): Decorator[] | undefined {
  const out: Decorator[] = [];
  for (let i = 0; i < src.length; ) {
    const skipped = skipNonCode(src, i);
    if (skipped < 0) return undefined;
    if (skipped !== i) {
      i = skipped;
      continue;
    }
    if (src[i] === "@") {
      const augment = src[i + 1] === "@";
      DECORATOR_NAME.lastIndex = augment ? i + 1 : i;
      const m = DECORATOR_NAME.exec(src);
      if (m) {
        let end = DECORATOR_NAME.lastIndex;
        let j = end;
        while (j < src.length && /[ \t]/.test(src[j])) j++;
        let args: string | undefined;
        if (src[j] === "(") {
          const close = closingParen(src, j);
          if (close < 0) return undefined;
          args = src.slice(j + 1, close);
          end = close + 1;
        }
        if (augment) {
          let k = end;
          while (k < src.length && /\s/.test(src[k])) k++;
          if (src[k] === ";") end = k + 1;
        }
        out.push({ start: i, end, name: m[0].slice(1), ...(args !== undefined ? { args } : {}), ...(augment ? { augment: true } : {}) });
        i = end;
        continue;
      }
    }
    i++;
  }
  return out;
}

const EXTENSION_DECORATORS = new Set(["extension", "JsonSchema.extension", "OpenAPI.extension", "TypeSpec.JsonSchema.extension", "TypeSpec.OpenAPI.extension"]);

const LEADING_KEY = /^\s*"((?:[^"\\\n]|\\.)*)"\s*,/;

/** Index of the first comma of `args` outside every bracket, string and comment; -1 when there is none. */
function topLevelComma(args: string): number {
  let depth = 0;
  for (let i = 0; i < args.length; ) {
    const skipped = skipNonCode(args, i);
    if (skipped < 0) return -1;
    if (skipped !== i) {
      i = skipped;
      continue;
    }
    const c = args[i];
    if ("([{<".includes(c)) depth++;
    else if (")]}>".includes(c)) depth--;
    else if (c === "," && depth === 0) return i;
    i++;
  }
  return -1;
}

/** The arguments of an extension decorator after its target (an augment decorator names the target first). */
function keyAndValueArgs(d: Decorator): string | undefined {
  if (d.args === undefined) return undefined;
  if (!d.augment) return d.args;
  const comma = topLevelComma(d.args);
  return comma < 0 ? undefined : d.args.slice(comma + 1);
}

/** The key of an extension decorator's arguments: the full parse, else (a value the literal reader does not know) the leading string. */
function extensionKey(args: string): string | undefined {
  const parsed = parseExtensionArguments(args);
  if (parsed) return parsed.key;
  const m = LEADING_KEY.exec(args);
  return m ? JSON.parse(`"${m[1]}"`) : undefined;
}

const keyOf = (d: Decorator): string | undefined => {
  if (!EXTENSION_DECORATORS.has(d.name)) return undefined;
  const args = keyAndValueArgs(d);
  return args === undefined ? undefined : extensionKey(args);
};

/** An `…extension` decorator whose key cannot be read but whose arguments hold one of `keys` as a string literal: a form the strip does not know. */
const mentionsKey = (d: Decorator, keys: readonly string[]): boolean =>
  /(^|\.)extension$/.test(d.name) && keyOf(d) === undefined && d.args !== undefined && keys.some((k) => d.args?.includes(JSON.stringify(k)));

/**
 * `source` without every extension decorator whose key is in `keys`: `@…extension("<key>", …)` and the augment form
 * `@@…extension(Target, "<key>", …);`, JSON Schema and OpenAPI, qualified or not. A decorator alone on its line takes the line with it. The
 * same string when the source mentions none of the keys.
 *
 * Fails CLOSED: when the source mentions a key and cannot be scanned (an unterminated string or comment), or a decorator still carries a key
 * after the strip (a form it does not know), it throws {@link MetadataStripError} rather than return a source that would emit the value.
 */
export function stripExtensionDecorators(source: string, keys: readonly string[]): string {
  if (keys.length === 0 || !keys.some((k) => source.includes(k))) return source;
  const decorators = scanDecorators(source);
  if (!decorators) throw new MetadataStripError(`The source mentions the internal metadata attribute(s) ${keys.filter((k) => source.includes(k)).join(", ")} but could not be read safely (an unterminated string or comment), so it is not emitted.`);
  const doomed = decorators.filter((d) => keys.includes(keyOf(d) ?? ""));
  const left = decorators.filter((d) => !doomed.includes(d) && mentionsKey(d, keys));
  if (left.length > 0) {
    throw new MetadataStripError(`The decorator @${left[0].name} carries an internal metadata attribute in a form that cannot be removed, so the source is not emitted.`);
  }
  if (doomed.length === 0) return source;
  let out = source;
  for (const d of [...doomed].reverse()) {
    const lineStart = out.lastIndexOf("\n", d.start - 1) + 1;
    const nl = out.indexOf("\n", d.end);
    const lineEnd = nl < 0 ? out.length : nl;
    if (out.slice(lineStart, d.start).trim() === "" && out.slice(d.end, lineEnd).trim() === "") {
      out = out.slice(0, lineStart) + out.slice(nl < 0 ? lineEnd : lineEnd + 1);
    } else {
      let end = d.end;
      while (end < out.length && /[ \t]/.test(out[end])) end++;
      out = out.slice(0, d.start) + out.slice(end);
    }
  }
  return out;
}

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** `source` with every string, backticked identifier and comment blanked (same length, newlines kept). */
function codeMask(src: string): string | undefined {
  let out = "";
  for (let i = 0; i < src.length; ) {
    const skipped = skipNonCode(src, i);
    if (skipped < 0) return undefined;
    if (skipped !== i) {
      out += src.slice(i, skipped).replace(/[^\n]/g, " ");
      i = skipped;
      continue;
    }
    out += src[i++];
  }
  return out;
}

/** The extension values written on `model <modelName>` itself (its own decorators, not its properties'), by key; the first of a pair wins. */
export function modelExtensionsInSource(source: string, modelName: string): Record<string, unknown> {
  const decorators = scanDecorators(source);
  const mask = codeMask(source);
  if (!decorators || mask === undefined) return {};
  const names = [modelName, `\`${modelName}\``].map(escapeRegExp).join("|");
  const header = new RegExp(`(^|[^\\w.$])model\\s+(?:${names})(?![\\w$])`, "m").exec(mask);
  if (!header) return {};
  let cursor = header.index + header[1].length;
  const attached: Decorator[] = [];
  for (const d of [...decorators].reverse()) {
    if (d.end > cursor) continue;
    if (mask.slice(d.end, cursor).trim() !== "") break;
    attached.unshift(d);
    cursor = d.start;
  }
  const out: Record<string, unknown> = {};
  for (const d of attached) {
    if (!EXTENSION_DECORATORS.has(d.name) || d.args === undefined) continue;
    const parsed = parseExtensionArguments(d.args);
    if (parsed && !(parsed.key in out)) out[parsed.key] = parsed.value;
  }
  return out;
}

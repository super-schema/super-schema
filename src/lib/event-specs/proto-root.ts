import { ok, err, type Result } from "@/types/result";

/**
 * Spec §7.3 / Story 16.3 pure core: make the payload's root message the FIRST
 * top-level definition (Confluent message index 0) and annotate it with
 * `// @RootNode` (AsyncAPI protobuf-schema-parser). Stale `@RootNode` lines on
 * other top-level definitions are removed. Idempotent.
 *
 * Everything before the first top-level definition (syntax, package, imports,
 * options, header comments) is kept verbatim; top-level definitions keep their
 * text and leading comments and are re-joined with one blank line.
 */

export const ROOT_NODE_ANNOTATION = "// @RootNode";

const DEFINITION_KEYWORDS = new Set(["message", "enum", "service", "extend"]);
const ROOT_NODE_LINE = /^[ \t]*\/\/[ \t]*@RootNode\b.*$/;

type TopLevelChunk = {
  keyword: string;
  name?: string;
  /** Start of the chunk's leading comments (or of the keyword's line when none). */
  start: number;
  /** Start of the line holding the keyword. */
  lineStart: number;
  /** Exclusive end (after `}` / `;` and any same-line trailing comment). */
  end: number;
};

function lineStartOf(src: string, index: number): number {
  return src.lastIndexOf("\n", index - 1) + 1;
}

function skipString(src: string, i: number): number {
  const quote = src[i];
  let j = i + 1;
  while (j < src.length && src[j] !== quote) j += src[j] === "\\" ? 2 : 1;
  return j + 1;
}

function skipLineComment(src: string, i: number): number {
  const nl = src.indexOf("\n", i);
  return nl < 0 ? src.length : nl;
}

function skipBlockComment(src: string, i: number): number {
  const close = src.indexOf("*/", i + 2);
  return close < 0 ? -1 : close + 2;
}

/** Index after the token that ends the chunk (`;` at depth 0, or the `}` closing depth 1). */
function scanToEnd(src: string, from: number, isDefinition: boolean): number {
  let depth = 0;
  let i = from;
  while (i < src.length) {
    const c = src[i];
    if (c === '"' || c === "'") {
      i = skipString(src, i);
      continue;
    }
    if (src.startsWith("//", i)) {
      i = skipLineComment(src, i);
      continue;
    }
    if (src.startsWith("/*", i)) {
      const next = skipBlockComment(src, i);
      if (next < 0) return -1;
      i = next;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth < 0) return -1;
      if (isDefinition && depth === 0) return i + 1;
    } else if (c === ";" && depth === 0 && !isDefinition) return i + 1;
    i++;
  }
  return -1;
}

function extendThroughTrailingComment(src: string, end: number): number {
  const m = /^[ \t]*(\/\/[^\n]*)/.exec(src.slice(end));
  return m ? end + m[0].length : end;
}

function scanTopLevel(src: string): TopLevelChunk[] | null {
  const chunks: TopLevelChunk[] = [];
  let i = 0;
  let prevEnd = 0;
  let triviaStart = -1;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (src.startsWith("//", i)) {
      if (triviaStart < 0) triviaStart = lineStartOf(src, i);
      i = skipLineComment(src, i);
      continue;
    }
    if (src.startsWith("/*", i)) {
      if (triviaStart < 0) triviaStart = lineStartOf(src, i);
      const next = skipBlockComment(src, i);
      if (next < 0) return null;
      i = next;
      continue;
    }
    const word = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i));
    if (!word) return null;
    const keyword = word[0];
    const isDefinition = DEFINITION_KEYWORDS.has(keyword);
    const name = isDefinition ? /^\s+([A-Za-z_][A-Za-z0-9_.]*)/.exec(src.slice(i + keyword.length))?.[1] : undefined;
    const end = scanToEnd(src, i, isDefinition);
    if (end < 0) return null;
    const lineStart = Math.max(prevEnd, lineStartOf(src, i));
    chunks.push({
      keyword,
      name,
      start: Math.max(prevEnd, triviaStart >= 0 ? Math.min(triviaStart, lineStart) : lineStart),
      lineStart,
      end: extendThroughTrailingComment(src, end),
    });
    i = prevEnd = chunks[chunks.length - 1].end;
    triviaStart = -1;
  }
  return chunks;
}

function stripRootNodeLines(leading: string): string {
  return leading
    .split("\n")
    .filter((line) => !ROOT_NODE_LINE.test(line))
    .join("\n");
}

export function placeRootMessageFirst(proto: string, rootMessage: string): Result<string> {
  const chunks = scanTopLevel(proto);
  if (!chunks) {
    return err({ code: "PROTO_PARSE_ERROR", message: "Unbalanced braces, quotes or comments in .proto source" });
  }
  const firstDefIndex = chunks.findIndex((c) => DEFINITION_KEYWORDS.has(c.keyword));
  const root = chunks.find((c) => c.keyword === "message" && c.name === rootMessage);
  if (firstDefIndex < 0 || !root) {
    return err({
      code: "ROOT_MESSAGE_NOT_FOUND",
      message: `Top-level message "${rootMessage}" not found in .proto source`,
    });
  }

  const render = (c: TopLevelChunk): string => {
    const leading = stripRootNodeLines(proto.slice(c.start, c.lineStart));
    const body = proto.slice(c.lineStart, c.end);
    if (c !== root) return leading + body;
    const indent = /^[ \t]*/.exec(body)?.[0] ?? "";
    return `${leading}${indent}${ROOT_NODE_ANNOTATION}\n${body}`;
  };

  const tail = chunks.slice(firstDefIndex).filter((c) => c !== root);
  const head = proto.slice(0, chunks[firstDefIndex].start).trimEnd();
  const trailing = proto.slice(chunks[chunks.length - 1].end).trim();
  const body = [root, ...tail].map(render).join("\n\n");
  return ok(`${head ? `${head}\n\n` : ""}${body}${trailing ? `\n\n${trailing}` : ""}\n`);
}
